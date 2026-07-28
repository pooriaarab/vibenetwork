import { describe, expect, it } from 'vitest';
import {
  MAX_B64_CHUNK_LEN,
  MAX_CANDIDATE_LEN,
  MAX_MEDIA_SIZE,
  MAX_MIME_LEN,
  MAX_NAME_LEN,
  MAX_SDP_LEN,
  parseFrame,
  serializeFrame,
  type Frame,
} from './frame.js';

describe('frame protocol', () => {
  it('round-trips a msg frame', () => {
    const f: Frame = { t: 'msg', id: 'a1', text: 'hi', at: 1 };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });
  it('rejects unknown type', () => {
    expect(parseFrame(JSON.stringify({ t: 'evil', text: 'x' }))).toBeNull();
  });
  it('drops extra keys (allowlist)', () => {
    const raw = JSON.stringify({ t: 'msg', id: 'a', text: 'hi', at: 1, leak: 'raw-usage' });
    expect(parseFrame(raw)).toEqual({ t: 'msg', id: 'a', text: 'hi', at: 1 });
  });
  it('caps text length', () => {
    expect(parseFrame(JSON.stringify({ t: 'msg', id: 'a', text: 'x'.repeat(5000), at: 1 }))).toBeNull();
  });
  it('parses hello/typing/bye', () => {
    expect(parseFrame(JSON.stringify({ t: 'bye' }))).toEqual({ t: 'bye' });
    expect(parseFrame(JSON.stringify({ t: 'typing' }))).toEqual({ t: 'typing' });
  });
});

describe('frame protocol — hello verified flag', () => {
  it('round-trips a hello with verified: true', () => {
    const f: Frame = { t: 'hello', handle: '@a', league: '10M', harness: 'codex', verified: true };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });
  it('round-trips a hello with verified: false', () => {
    const f: Frame = { t: 'hello', handle: '@a', league: '10M', harness: 'codex', verified: false };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });
  it('legacy hello without verified parses with the key absent (backward compat)', () => {
    const parsed = parseFrame(JSON.stringify({ t: 'hello', handle: '@a', league: '10M' }));
    expect(parsed).toEqual({ t: 'hello', handle: '@a', league: '10M', harness: 'unknown' });
    expect(parsed).not.toHaveProperty('verified');
  });
  it('rejects a non-boolean verified (allowlist rigor)', () => {
    expect(
      parseFrame(JSON.stringify({ t: 'hello', handle: '@a', league: '10M', verified: 'yes' })),
    ).toBeNull();
    expect(
      parseFrame(JSON.stringify({ t: 'hello', handle: '@a', league: '10M', verified: 1 })),
    ).toBeNull();
  });
});

describe('frame protocol — hello identity proof', () => {
  const pubkey = 'a'.repeat(64);
  const nonce = 'b'.repeat(32);
  const sig = 'c'.repeat(128);
  const base = { t: 'hello', handle: '@a', league: '10M', harness: 'codex' } as const;

  it('round-trips a hello carrying pubkey + nonce + sig', () => {
    const f: Frame = { ...base, verified: true, pubkey, nonce, sig };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });

  it('legacy hello carries no identity keys (backward compat)', () => {
    const parsed = parseFrame(JSON.stringify(base));
    expect(parsed).toEqual({ ...base });
    expect(parsed).not.toHaveProperty('pubkey');
    expect(parsed).not.toHaveProperty('sig');
    expect(parsed).not.toHaveProperty('nonce');
  });

  it('rejects a malformed pubkey (not exactly 64 hex)', () => {
    expect(parseFrame(JSON.stringify({ ...base, pubkey: 'a'.repeat(63) }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, pubkey: 'a'.repeat(65) }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, pubkey: 'z'.repeat(64) }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, pubkey: 42 }))).toBeNull();
  });

  it('rejects a malformed sig (not exactly 128 hex)', () => {
    expect(parseFrame(JSON.stringify({ ...base, sig: 'c'.repeat(127) }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, sig: 'c'.repeat(129) }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, sig: 'x'.repeat(128) }))).toBeNull();
  });

  it('rejects an oversized / non-hex nonce', () => {
    expect(parseFrame(JSON.stringify({ ...base, nonce: 'b'.repeat(65) }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, nonce: 'zz' }))).toBeNull();
  });

  it('admits uppercase hex (case-insensitive, length still exact)', () => {
    const f: Frame = { ...base, pubkey: 'A'.repeat(64), nonce: 'B'.repeat(32), sig: 'C'.repeat(128) };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });
});

describe('frame protocol — media frames', () => {
  it('round-trips a media-start frame', () => {
    const f: Frame = { t: 'media-start', id: 'm1', mime: 'image/png', size: 1234, name: 'cat.png' };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });
  it('round-trips a media-chunk frame', () => {
    const f: Frame = { t: 'media-chunk', id: 'm1', seq: 0, b64: 'aGVsbG8=' };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });
  it('round-trips a media-end frame', () => {
    const f: Frame = { t: 'media-end', id: 'm1' };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });

  it('drops extra keys on a media-start frame (allowlist)', () => {
    const raw = JSON.stringify({
      t: 'media-start',
      id: 'm1',
      mime: 'image/png',
      size: 10,
      name: 'a.png',
      leak: 'raw-usage',
    });
    expect(parseFrame(raw)).toEqual({
      t: 'media-start',
      id: 'm1',
      mime: 'image/png',
      size: 10,
      name: 'a.png',
    });
  });
  it('drops extra keys on a media-chunk frame (allowlist)', () => {
    const raw = JSON.stringify({
      t: 'media-chunk',
      id: 'm1',
      seq: 2,
      b64: 'AAAA',
      leak: 'raw-usage',
    });
    expect(parseFrame(raw)).toEqual({ t: 'media-chunk', id: 'm1', seq: 2, b64: 'AAAA' });
  });

  it('rejects media-start with size over the 25 MiB cap', () => {
    expect(
      parseFrame(
        JSON.stringify({ t: 'media-start', id: 'm', mime: 'image/png', size: MAX_MEDIA_SIZE + 1, name: 'a.png' }),
      ),
    ).toBeNull();
  });
  it('rejects media-start with a negative / non-integer / non-finite size', () => {
    const base = { t: 'media-start', id: 'm', mime: 'image/png', name: 'a.png' } as const;
    expect(parseFrame(JSON.stringify({ ...base, size: -1 }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, size: 1.5 }))).toBeNull();
    // JSON.stringify(NaN) -> null, so spell the bad size via a raw string
    expect(parseFrame('{"t":"media-start","id":"m","mime":"image/png","size":NaN,"name":"a.png"}')).toBeNull();
  });
  it('rejects media-start with oversized mime / name', () => {
    const ok = { t: 'media-start', id: 'm', size: 1, name: 'a.png' } as const;
    expect(
      parseFrame(JSON.stringify({ ...ok, mime: 'x'.repeat(MAX_MIME_LEN + 1) })),
    ).toBeNull();
    const ok2 = { t: 'media-start', id: 'm', size: 1, mime: 'image/png' } as const;
    expect(
      parseFrame(JSON.stringify({ ...ok2, name: 'x'.repeat(MAX_NAME_LEN + 1) })),
    ).toBeNull();
  });

  it('rejects media-chunk with b64 over the 16 KiB cap', () => {
    expect(
      parseFrame(
        JSON.stringify({ t: 'media-chunk', id: 'm', seq: 0, b64: 'A'.repeat(MAX_B64_CHUNK_LEN + 1) }),
      ),
    ).toBeNull();
  });
  it('rejects media-chunk with a non-finite / non-integer / negative seq', () => {
    const base = { t: 'media-chunk', id: 'm', b64: 'AAAA' } as const;
    expect(parseFrame(JSON.stringify({ ...base, seq: '0' }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, seq: 1.5 }))).toBeNull();
    expect(parseFrame(JSON.stringify({ ...base, seq: -1 }))).toBeNull();
    expect(parseFrame('{"t":"media-chunk","id":"m","seq":NaN,"b64":"AAAA"}')).toBeNull();
  });

  it('rejects media frames missing required keys', () => {
    expect(parseFrame(JSON.stringify({ t: 'media-start', id: 'm', mime: 'x', name: 'y' }))).toBeNull(); // no size
    expect(parseFrame(JSON.stringify({ t: 'media-chunk', id: 'm', seq: 0 }))).toBeNull(); // no b64
    expect(parseFrame(JSON.stringify({ t: 'media-end' }))).toBeNull(); // no id
  });

  it('admits a maximum-size media-chunk (16 KiB b64) within the frame cap', () => {
    const f = { t: 'media-chunk', id: 'm', seq: 0, b64: 'A'.repeat(MAX_B64_CHUNK_LEN) };
    expect(parseFrame(serializeFrame(f as unknown as Frame))).toEqual(f);
  });
});

describe('frame protocol — rtc signaling frames', () => {
  it('round-trips an rtc-offer frame', () => {
    const f: Frame = { t: 'rtc-offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n' };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });
  it('round-trips an rtc-answer frame', () => {
    const f: Frame = { t: 'rtc-answer', sdp: 'v=0\r\no=- 2 1 IN IP4 127.0.0.1\r\n' };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });
  it('round-trips an rtc-ice frame', () => {
    const f: Frame = {
      t: 'rtc-ice',
      candidate: 'candidate:842163049 1 udp 1677729535 73.4.2.1 64737 typ srflx',
    };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });

  it('drops extra keys on an rtc-offer frame (allowlist)', () => {
    const raw = JSON.stringify({
      t: 'rtc-offer',
      sdp: 'v=0\r\n',
      leak: 'raw-usage',
      impersonator: true,
    });
    expect(parseFrame(raw)).toEqual({ t: 'rtc-offer', sdp: 'v=0\r\n' });
  });
  it('drops extra keys on an rtc-answer frame (allowlist)', () => {
    const raw = JSON.stringify({ t: 'rtc-answer', sdp: 'v=0\r\n', leak: 'raw-usage' });
    expect(parseFrame(raw)).toEqual({ t: 'rtc-answer', sdp: 'v=0\r\n' });
  });
  it('drops extra keys on an rtc-ice frame (allowlist)', () => {
    const raw = JSON.stringify({
      t: 'rtc-ice',
      candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host',
      leak: 'raw-usage',
    });
    expect(parseFrame(raw)).toEqual({
      t: 'rtc-ice',
      candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host',
    });
  });

  it('rejects rtc-offer with sdp over the 64 KiB cap', () => {
    expect(parseFrame(JSON.stringify({ t: 'rtc-offer', sdp: 'x'.repeat(MAX_SDP_LEN + 1) }))).toBeNull();
  });
  it('rejects rtc-answer with sdp over the 64 KiB cap', () => {
    expect(
      parseFrame(JSON.stringify({ t: 'rtc-answer', sdp: 'x'.repeat(MAX_SDP_LEN + 1) })),
    ).toBeNull();
  });
  it('rejects rtc-ice with candidate over the 4 KiB cap', () => {
    expect(
      parseFrame(JSON.stringify({ t: 'rtc-ice', candidate: 'x'.repeat(MAX_CANDIDATE_LEN + 1) })),
    ).toBeNull();
  });
  it('rejects rtc-offer / rtc-answer with an empty sdp', () => {
    expect(parseFrame(JSON.stringify({ t: 'rtc-offer', sdp: '' }))).toBeNull();
    expect(parseFrame(JSON.stringify({ t: 'rtc-answer', sdp: '' }))).toBeNull();
  });

  it('rejects rtc frames missing required keys', () => {
    expect(parseFrame(JSON.stringify({ t: 'rtc-offer' }))).toBeNull(); // no sdp
    expect(parseFrame(JSON.stringify({ t: 'rtc-answer' }))).toBeNull(); // no sdp
    expect(parseFrame(JSON.stringify({ t: 'rtc-ice' }))).toBeNull(); // no candidate
  });

  it('rejects rtc frames with wrong-typed payloads', () => {
    expect(parseFrame(JSON.stringify({ t: 'rtc-offer', sdp: 42 }))).toBeNull();
    expect(parseFrame(JSON.stringify({ t: 'rtc-ice', candidate: { x: 1 } }))).toBeNull();
  });

  it('admits a maximum-size rtc-offer sdp (64 KiB) within the raised frame cap', () => {
    // A 64 KiB sdp whose every byte is a control char is the WORST case for
    // JSON escaping (each byte doubles on the wire). The raised MAX_FRAME_LEN
    // must still admit it.
    const f = { t: 'rtc-offer', sdp: '\n'.repeat(MAX_SDP_LEN) };
    expect(parseFrame(serializeFrame(f as unknown as Frame))).toEqual(f);
  });

  it('admits an empty rtc-ice candidate (trickle end-of-gathering marker)', () => {
    const f: Frame = { t: 'rtc-ice', candidate: '' };
    expect(parseFrame(serializeFrame(f))).toEqual(f);
  });
});
