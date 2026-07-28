import { Duplex, PassThrough, type Duplex as DuplexType } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createPeerLink, type PeerLink } from './link.js';
import type { PeerHello } from './p2p.js';

const helloA: PeerHello = { handle: '@alice', league: '10M', harness: 'claude-code' };
const helloB: PeerHello = { handle: '@bob', league: '10M', harness: 'codex' };

/**
 * Build a Duplex that READS from `ingress` and WRITES to `egress` — the test
 * stand-in for a hyperswarm socket. Two of these cross-wired over a pair of
 * PassThrough streams make a faithful in-memory model of one peer connection.
 */
function bridge(ingress: PassThrough, egress: PassThrough): DuplexType {
  const d = new Duplex({
    // `_read` is a no-op: the readable side is fed externally via push() from
    // `ingress` below. (Omitting it makes Node throw ERR_METHOD_NOT_IMPLEMENTED
    // on the first read — the real hyperswarm socket implements it.)
    read() {},
    write(chunk, _enc, cb) {
      if (egress.write(chunk)) cb();
      else egress.once('drain', cb);
    },
    final(cb) {
      egress.end(cb);
    },
  });
  ingress.on('data', (chunk: Buffer) => d.push(chunk));
  ingress.on('end', () => d.push(null));
  return d;
}

/** A cross-wired pair of Duplex "sockets": whatever A writes, B reads, and vice-versa. */
function crossWire(): { a: DuplexType; b: DuplexType } {
  const aToB = new PassThrough(); // A writes, B reads
  const bToA = new PassThrough(); // B writes, A reads
  return { a: bridge(bToA, aToB), b: bridge(aToB, bToA) };
}

/** Give the streams a tick to flush buffered frames between assertions. */
const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

describe('PeerLink', () => {
  it('delivers a sent message to the remote onMessage', async () => {
    const { a, b } = crossWire();
    const linkA: PeerLink = createPeerLink(a, helloA);
    const linkB: PeerLink = createPeerLink(b, helloB);
    const onMessage = vi.fn();
    linkB.onMessage(onMessage);

    linkA.send('hey bob');
    await tick();

    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = onMessage.mock.calls[0]![0]!;
    expect(msg.text).toBe('hey bob');
    expect(typeof msg.id).toBe('string');
    expect(msg.id.length).toBeGreaterThan(0);
    expect(typeof msg.at).toBe('number');
  });

  it('exchanges text both ways over one pair', async () => {
    const { a, b } = crossWire();
    const linkA = createPeerLink(a, helloA);
    const linkB = createPeerLink(b, helloB);
    const gotA = vi.fn();
    const gotB = vi.fn();
    linkA.onMessage(gotA);
    linkB.onMessage(gotB);

    linkA.send('to B');
    linkB.send('to A');
    await tick();

    expect(gotB.mock.calls[0]![0]!.text).toBe('to B');
    expect(gotA.mock.calls[0]![0]!.text).toBe('to A');
  });

  it("fires the remote onClose when the peer calls close() (bye frame)", async () => {
    const { a, b } = crossWire();
    const linkA = createPeerLink(a, helloA);
    const linkB = createPeerLink(b, helloB);
    const onClose = vi.fn();
    linkB.onClose(onClose);

    linkA.close(); // omegle "next"
    await tick();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exposes the peer hello it was built with', () => {
    const { a } = crossWire();
    const linkA = createPeerLink(a, helloA);
    expect(linkA.hello).toEqual(helloA);
  });

  it('ignores malformed frames on the wire (parseFrame null)', async () => {
    const { a, b } = crossWire();
    const linkB = createPeerLink(b, helloB);
    const onMessage = vi.fn();
    const onClose = vi.fn();
    linkB.onMessage(onMessage);
    linkB.onClose(onClose);

    // Raw garbage that is not a valid frame must not crash or dispatch.
    a.write('definitely-not-a-frame\n');
    await tick();

    expect(onMessage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('supports multiple onMessage listeners', async () => {
    const { a, b } = crossWire();
    const linkA = createPeerLink(a, helloA);
    const linkB = createPeerLink(b, helloB);
    const sink1 = vi.fn();
    const sink2 = vi.fn();
    linkB.onMessage(sink1);
    linkB.onMessage(sink2);

    linkA.send('both');
    await tick();

    expect(sink1).toHaveBeenCalledTimes(1);
    expect(sink2).toHaveBeenCalledTimes(1);
  });

  it('delivers a sent rtc signal frame to the remote onSignal (allowlisted)', async () => {
    const { a, b } = crossWire();
    const linkA = createPeerLink(a, helloA);
    const linkB = createPeerLink(b, helloB);
    const onSignal = vi.fn();
    linkB.onSignal(onSignal);

    // A smears extra keys + a leak onto its offer; parseFrame on B's side must
    // strip them before onSignal ever fires.
    a.write(
      JSON.stringify({ t: 'rtc-offer', sdp: 'v=0\r\n', leak: 'raw-usage', impersonator: true }) +
        '\n',
    );
    await tick();

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]![0]).toEqual({ t: 'rtc-offer', sdp: 'v=0\r\n' });
  });

  it('relays rtc-offer / rtc-answer / rtc-ice both ways over one pair', async () => {
    const { a, b } = crossWire();
    const linkA = createPeerLink(a, helloA);
    const linkB = createPeerLink(b, helloB);
    const gotA = vi.fn();
    const gotB = vi.fn();
    linkA.onSignal(gotA);
    linkB.onSignal(gotB);

    linkA.sendSignal({ t: 'rtc-offer', sdp: 'OFFER' });
    linkB.sendSignal({ t: 'rtc-answer', sdp: 'ANSWER' });
    linkA.sendSignal({ t: 'rtc-ice', candidate: 'c1' });
    linkB.sendSignal({ t: 'rtc-ice', candidate: '' }); // end-of-gathering marker
    await tick();

    expect(gotB.mock.calls[0]![0]).toEqual({ t: 'rtc-offer', sdp: 'OFFER' });
    expect(gotB.mock.calls[1]![0]).toEqual({ t: 'rtc-ice', candidate: 'c1' });
    expect(gotA.mock.calls[0]![0]).toEqual({ t: 'rtc-answer', sdp: 'ANSWER' });
    expect(gotA.mock.calls[1]![0]).toEqual({ t: 'rtc-ice', candidate: '' });
  });
});
