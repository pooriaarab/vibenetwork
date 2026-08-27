import { randomBytes } from 'node:crypto';
import type { Harness, VibeEvent } from '@pooriaarab/vibe-core';
import { makeEvent, notify as vibeCoreNotify } from '@pooriaarab/vibe-core';
import { parseFrame, serializeFrame } from './frame.js';
import { classifyHelloIdentity } from './identity.js';
import { createPeerLink, type PeerLink } from './link.js';
import { defaultStateDir } from './state.js';
import { leagueTopic } from './p2p-handshake.js';
import type { PeerHello } from './p2p-handshake.js';
import { recordPeer, recordPeerMessage } from './p2p-peers.js';

const REFRESH_INTERVAL_MS = 5_000;

export type NotifySink = (event: VibeEvent) => void;

export interface DiscoveryOptions {
  /** What we broadcast. Must already be consent-gated by the caller. */
  readonly hello: PeerHello;
  /**
   * Override the joined topic (tests pass a random one on an isolated DHT).
   * Defaults to {@link leagueTopic}`(hello.league)`. Ignored when {@link topics}
   * is set.
   */
  readonly topic?: Buffer;
  /**
   * ALL topics to join on the one swarm (e.g. your league + adjacent leagues),
   * so thin pools and cross-league friends still connect. Every topic is
   * joined, refreshed, and left on close. Defaults to `[topic]` — i.e. a single
   * own-league topic (the legacy behavior).
   */
  readonly topics?: readonly Buffer[];
  /**
   * Predicate over an incoming peer's advertised league. Defaults to EXACT
   * match against `hello.league` — the same privacy invariant as before. Widen
   * it (e.g. ±1 adjacency via {@link leaguesWithin}) to accept cross-league
   * peers that arrive on a shared topic.
   */
  readonly acceptLeague?: (peerLeague: string) => boolean;
  /**
   * Predicate over an incoming peer's advertised handle. A blocked peer's hello
   * is DROPPED exactly like a wrong-league one — never recorded to peers.json,
   * never notified, never handed to `onLink`/pairing. Default: nothing blocked.
   * The CLI passes one backed by the persisted blocklist (~/.vibenetwork).
   */
  readonly isBlocked?: (handle: string) => boolean;
  /** DHT bootstrap nodes; omit for the public DHT. Tests pass a local testnet. */
  readonly bootstrap?: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  /** Where peers.json lives. Defaults to ~/.vibenetwork. */
  readonly stateDir?: string;
  /** Called after each accepted handshake; `isNew` = first time this handle is seen. */
  readonly onPeer?: (peer: PeerHello, isNew: boolean) => void;
  /**
   * Called once per connection with a live {@link PeerLink} over the same socket
   * (the hello was frame #1; subsequent frames flow to the link). Omit for the
   * plain `discover` behavior (no live chat). Existing discovery behavior is
   * unchanged when this is absent.
   */
  readonly onLink?: (link: PeerLink) => void;
  /** Match-notification sink (tests capture with a fake). Best-effort. */
  readonly notify?: NotifySink;
}

export interface DiscoverySession {
  /** The primary (first) joined topic. See {@link topics} for the full set. */
  readonly topic: Buffer;
  /** Every topic this session joined (primary first). */
  readonly topics: readonly Buffer[];
  /** What we broadcast on every connection. */
  readonly hello: PeerHello;
  /** Live peer set, keyed by the remote's public key (hex). */
  readonly peers: ReadonlyMap<string, PeerHello>;
  /** Resolves when the first DHT announce/lookup round for every topic completes. */
  readonly ready: Promise<unknown>;
  /** Leave every topic and destroy the node. Idempotent. */
  close(): Promise<void>;
}

/**
 * Join the swarm on the league topic and handshake with every peer that
 * connects. CONSENT GATE LIVES WITH THE CALLER — never call this without the
 * `share:live` grant (or an explicit `--live` opt-in in the same breath).
 */
interface DiscoveryContext {
  readonly hello: PeerHello;
  readonly stateDir: string;
  readonly onPeer: DiscoveryOptions['onPeer'];
  readonly onLink: DiscoveryOptions['onLink'];
  readonly notify: NotifySink;
  readonly isBlocked: DiscoveryOptions['isBlocked'];
  readonly acceptLeague: (peerLeague: string) => boolean;
  readonly peers: Map<string, PeerHello>;
}

function buildTopics(opts: DiscoveryOptions, hello: PeerHello): Buffer[] {
  if (opts.topics !== undefined) return [...opts.topics];
  if (opts.topic !== undefined) return [opts.topic];
  return [leagueTopic(hello.league)];
}

function buildAcceptLeague(opts: DiscoveryOptions, hello: PeerHello): (peerLeague: string) => boolean {
  return opts.acceptLeague ?? ((l) => l === hello.league);
}

function sendHello(socket: { write(s: string): void }, hello: PeerHello): void {
  socket.write(serializeFrame({
    t: 'hello', handle: hello.handle, league: hello.league, harness: hello.harness,
    ...(hello.verified !== undefined ? { verified: hello.verified } : {}),
    ...(hello.pubkey !== undefined ? { pubkey: hello.pubkey } : {}),
    ...(hello.nonce !== undefined ? { nonce: hello.nonce } : {}),
    ...(hello.sig !== undefined ? { sig: hello.sig } : {}),
  }) + '\n');
}

function isSelfPeer(peer: PeerHello, hello: PeerHello): boolean {
  if (peer.pubkey !== undefined && peer.pubkey === hello.pubkey) return true;
  if (peer.pubkey === undefined && hello.pubkey === undefined && peer.handle === hello.handle) return true;
  return false;
}

function buildPeerFromFrame(frame: Extract<import('./frame.js').Frame, { t: 'hello' }>, verdict: string): PeerHello {
  return {
    handle: frame.handle, league: frame.league, harness: frame.harness,
    ...(frame.verified !== undefined ? { verified: frame.verified } : {}),
    ...(verdict === 'verified' && frame.pubkey !== undefined ? { pubkey: frame.pubkey, identityVerified: true } : {}),
  };
}

function handleAcceptedPeer(peer: PeerHello, remoteKey: string, ctx: DiscoveryContext): void {
  ctx.peers.set(remoteKey, peer);
  const { isNew } = recordPeer(peer, ctx.stateDir);
  if (isNew) {
    try {
      ctx.notify(makeEvent('match', ctx.hello.harness as Harness, process.cwd(), {
        summary: `matched with ${peer.handle} - LIVE SAME LEAGUE`,
        handle: peer.handle, league: peer.league, harness: peer.harness,
      }));
    } catch { /* best-effort */ }
  }
  ctx.onPeer?.(peer, isNew);
}

function processHelloFrame(line: string, remoteKey: string, ctx: DiscoveryContext): PeerHello | null {
  if (line.trim() === '') return null;
  const frame = parseFrame(line);
  if (frame === null || frame.t !== 'hello') return null;
  const verdict = classifyHelloIdentity(frame);
  if (verdict === 'drop') return null;
  const peer = buildPeerFromFrame(frame, verdict);
  if (isSelfPeer(peer, ctx.hello)) return null;
  if (!ctx.acceptLeague(peer.league)) return null;
  if (ctx.isBlocked !== undefined && ctx.isBlocked(peer.handle)) return null;
  handleAcceptedPeer(peer, remoteKey, ctx);
  return peer;
}

function createConnectionHandler(ctx: DiscoveryContext) {
  return (socket: import('node:stream').Duplex, info: { publicKey: Buffer }): void => {
    const remoteKey = info.publicKey.toString('hex');
    sendHello(socket as unknown as { write(s: string): void }, ctx.hello);
    let buf = '';
    let handedOff = false;
    const onData = (chunk: Buffer): void => {
      if (handedOff) return;
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const peer = processHelloFrame(line, remoteKey, ctx);
        if (peer === null) continue;
        handedOff = true;
        (socket as unknown as { off(e: string, cb: unknown): void }).off('data', onData);
        if (ctx.onLink !== undefined) {
          const link = createPeerLink(socket, peer, buf);
          link.onMessage(() => { recordPeerMessage(peer.handle, ctx.stateDir); });
          ctx.onLink(link);
        }
        buf = '';
        return;
      }
    };
    socket.on('data', onData);
    socket.on('error', () => { /* peer vanished — fine */ });
  };
}

interface SwarmLike {
  readonly dht: { fullyBootstrapped(): Promise<unknown> };
  on(event: 'connection', handler: (socket: import('node:stream').Duplex, info: { publicKey: Buffer }) => void): void;
  join(topic: Buffer, opts: { server: boolean; client: boolean }): { flushed(): Promise<unknown>; refresh(opts: { server: boolean; client: boolean }): Promise<unknown> };
  leave(topic: Buffer): Promise<void>;
  destroy(): Promise<void>;
}

async function setupSwarm(opts: DiscoveryOptions, ctx: DiscoveryContext): Promise<{ swarm: SwarmLike; topics: Buffer[]; peers: Map<string, PeerHello> }> {
  const { default: Hyperswarm } = await import('hyperswarm');
  const swarm = new Hyperswarm(opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap });
  await swarm.dht.fullyBootstrapped();
  const topics = buildTopics(opts, ctx.hello);
  swarm.on('connection', createConnectionHandler(ctx));
  return { swarm, topics, peers: ctx.peers };
}

export async function startDiscovery(opts: DiscoveryOptions): Promise<DiscoverySession> {
  const ctx: DiscoveryContext = {
    hello: opts.hello,
    stateDir: opts.stateDir ?? defaultStateDir(),
    onPeer: opts.onPeer,
    onLink: opts.onLink,
    notify: opts.notify ?? vibeCoreNotify,
    isBlocked: opts.isBlocked,
    acceptLeague: buildAcceptLeague(opts, opts.hello),
    peers: new Map<string, PeerHello>(),
  };
  const { swarm, topics } = await setupSwarm(opts, ctx);
  const discoveries = topics.map((t) => swarm.join(t, { server: true, client: true }));
  const ready: Promise<unknown> = Promise.all(discoveries.map((d) => d.flushed().catch(() => undefined)));
  await ready;
  const refresher = setInterval(() => {
    for (const d of discoveries) void d.refresh({ server: true, client: true }).catch(() => {});
  }, REFRESH_INTERVAL_MS);
  refresher.unref();
  let closed = false;
  const primaryTopic = (() => {
    const p = topics[0];
    if (p === undefined) throw new Error('no topic joined');
    return p;
  })();
  return {
    topic: primaryTopic,
    topics,
    hello: ctx.hello,
    peers: ctx.peers,
    ready,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(refresher);
      for (const t of topics) { try { await swarm.leave(t); } catch { /* gone */ } }
      await swarm.destroy();
    },
  };
}

/** Random 32-byte topic for tests/local experiments — never collides with a real league topic. */
export function randomTopic(): Buffer {
  return randomBytes(32);
}
