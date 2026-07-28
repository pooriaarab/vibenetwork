/**
 * Live P2P matching over the hyperswarm DHT — no central server.
 *
 * Discovery: the league bucket computed by `connect` is hashed into a 32-byte
 * topic (`sha256('vibedate:' + league)`). Peers in the same league join the
 * same topic and find each other on the public DHT (NAT hole-punching and
 * connection encryption come from hyperswarm/hyperdht).
 *
 * Handshake: on each encrypted peer connection both sides immediately send a
 * single JSON line with ONLY the allowlisted fields { handle, league, harness,
 * verified, pubkey, nonce, sig }. Raw token usage is never sent, and the parser
 * builds its result from an allowlist of keys, so anything a peer adds beyond
 * those fields is dropped on receipt. pubkey/sig bind the hello to a persistent
 * ed25519 identity (see identity.ts): an invalid signature drops the peer.
 *
 * Consent: this module never decides policy — callers (the CLI) gate
 * {@link startDiscovery} behind the `share:live` consent grant (see state.ts).
 * The {@link LIVE_NOTICE} line is what the CLI prints before joining.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Harness, VibeEvent } from '@pooriaarab/vibe-core';
import { makeEvent, notify as vibeCoreNotify } from '@pooriaarab/vibe-core';
import { parseFrame, serializeFrame } from './frame.js';
import { classifyHelloIdentity } from './identity.js';
import { createPeerLink, type PeerLink } from './link.js';
import { defaultStateDir } from './state.js';

/* -------------------------------------------------------------------------- */
/* Topic derivation                                                           */
/* -------------------------------------------------------------------------- */

/** Namespace prefix so vibedating topics never collide with other DHT traffic. */
export const TOPIC_PREFIX = 'vibedate:';

/**
 * Derive the 32-byte DHT topic for a league bucket. Deterministic: everyone in
 * the same league anywhere in the world hashes to the same topic, which is the
 * entire discovery mechanism. Pure.
 */
export function leagueTopic(leagueName: string): Buffer {
  return createHash('sha256').update(`${TOPIC_PREFIX}${leagueName}`, 'utf8').digest();
}

/* -------------------------------------------------------------------------- */
/* Handshake                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The fields that ever leave the machine over a peer connection: handle, league,
 * harness, and (optionally) the self-asserted usage-verification flag plus the
 * identity proof (pubkey/nonce/sig). NEVER raw usage — no token totals, no logs.
 * `verified`/`pubkey` are undefined for legacy peers that predate them; both
 * `undefined` and `false` display as unverified (~).
 */
export interface PeerHello {
  readonly handle: string;
  readonly league: string;
  readonly harness: string;
  /**
   * Self-asserted: the sender's usage came from real local logs (see readUsage).
   * Bound to the sender's key by the identity signature when `pubkey` is present.
   */
  readonly verified?: boolean;
  /** Raw ed25519 public key (64 hex) — the persistent identity this hello signs. */
  readonly pubkey?: string;
  /** Random per-hello nonce (hex) covered by the signature. */
  readonly nonce?: string;
  /** ed25519 signature (128 hex) over `handle|league|harness|verified|nonce`. */
  readonly sig?: string;
  /**
   * LOCAL-DERIVED, never on the wire: true when this hello's signature verified
   * against its pubkey (see classifyHelloIdentity). Marked 🔑 in the UI.
   */
  readonly identityVerified?: boolean;
}

/** One-line privacy notice printed before joining the swarm. */
export const LIVE_NOTICE =
  'live discovery: sharing only your handle + league + harness + verified flag + identity pubkey (never raw usage) with same-league peers on the public DHT';

/* Defensive caps so a malicious or buggy peer can't make us retain junk. */
const MAX_HANDLE_LEN = 64;
const MAX_LEAGUE_LEN = 32;
const MAX_HARNESS_LEN = 64;
const MAX_HANDSHAKE_LEN = 4096;

/** How often a discovery session re-runs an announce/lookup round. */
const REFRESH_INTERVAL_MS = 5_000;

/**
 * Serialize a hello to the single JSON line sent on connect. Built key-by-key
 * from the allowlist — even if a caller sneaks extra properties onto the
 * object, they cannot leak into the wire format.
 */
export function serializeHandshake(hello: PeerHello): string {
  return JSON.stringify({
    handle: hello.handle,
    league: hello.league,
    harness: hello.harness,
    ...(hello.verified !== undefined ? { verified: hello.verified } : {}),
    ...(hello.pubkey !== undefined ? { pubkey: hello.pubkey } : {}),
    ...(hello.nonce !== undefined ? { nonce: hello.nonce } : {}),
    ...(hello.sig !== undefined ? { sig: hello.sig } : {}),
    // identityVerified is LOCAL-derived and deliberately never serialized.
  });
}

/**
 * Parse one incoming handshake line. Returns `null` for anything malformed
 * (bad JSON, non-object, missing/oversized handle or league). The result is
 * constructed from an allowlist of keys, so any extra fields a peer sends —
 * in particular any raw-usage field — are ignored and never retained.
 */
export function parseHandshake(raw: string | Buffer): PeerHello | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length > MAX_HANDSHAKE_LEN) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  const handle = rec['handle'];
  const league = rec['league'];
  if (typeof handle !== 'string' || handle.length === 0 || handle.length > MAX_HANDLE_LEN) {
    return null;
  }
  if (typeof league !== 'string' || league.length === 0 || league.length > MAX_LEAGUE_LEN) {
    return null;
  }
  const harness = rec['harness'];
  const verified = rec['verified'];
  if (verified !== undefined && typeof verified !== 'boolean') return null;
  // Identity proof: optional (legacy peers), but exactly-shaped hex when present
  // — same discipline as the hello frame. Verification happens one layer up.
  const pubkey = rec['pubkey'];
  if (pubkey !== undefined && (typeof pubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(pubkey))) {
    return null;
  }
  const nonce = rec['nonce'];
  if (nonce !== undefined && (typeof nonce !== 'string' || !/^[0-9a-fA-F]{1,64}$/.test(nonce))) {
    return null;
  }
  const sig = rec['sig'];
  if (sig !== undefined && (typeof sig !== 'string' || !/^[0-9a-fA-F]{128}$/.test(sig))) {
    return null;
  }
  return {
    handle,
    league,
    harness:
      typeof harness === 'string' && harness.length > 0 && harness.length <= MAX_HARNESS_LEN
        ? harness
        : 'unknown',
    ...(typeof verified === 'boolean' ? { verified } : {}),
    ...(typeof pubkey === 'string' ? { pubkey } : {}),
    ...(typeof nonce === 'string' ? { nonce } : {}),
    ...(typeof sig === 'string' ? { sig } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Peer persistence (~/.vibedating/peers.json)                                 */
/* -------------------------------------------------------------------------- */

/** A peer we've shaken hands with, persisted locally. */
export interface StoredPeer extends PeerHello {
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** LOCAL metadata: when the last `msg` from this peer arrived (never on the wire). */
  readonly lastMessageAt?: string;
}

function peersPath(dir: string): string {
  return path.join(dir, 'peers.json');
}

/** Load persisted live peers, or `[]` if none/corrupt. Local-only data. */
export function loadPeers(dir: string = defaultStateDir()): StoredPeer[] {
  try {
    const raw = readFileSync(peersPath(dir), 'utf8');
    const data = JSON.parse(raw) as { peers?: StoredPeer[] };
    return Array.isArray(data.peers) ? data.peers : [];
  } catch {
    return [];
  }
}

/**
 * Record a successfully handshaken peer, keyed by handle (a peer may reconnect
 * from a different key). Returns whether this handle is NEW (first time seen).
 */
export function recordPeer(
  hello: PeerHello,
  dir: string = defaultStateDir(),
  now: Date = new Date(),
): { peer: StoredPeer; isNew: boolean } {
  const peers = loadPeers(dir);
  const at = now.toISOString();
  // Built key-by-key from the allowlist — nothing beyond the PeerHello fields is
  // ever persisted, regardless of what the caller's object carries. Optional
  // fields are taken ONLY from this hello, so a stale value from an earlier
  // sighting can never linger after a peer stops sending it.
  const clean: PeerHello = {
    handle: hello.handle,
    league: hello.league,
    harness: hello.harness,
    ...(hello.verified !== undefined ? { verified: hello.verified } : {}),
    ...(hello.pubkey !== undefined ? { pubkey: hello.pubkey } : {}),
    ...(hello.identityVerified !== undefined ? { identityVerified: hello.identityVerified } : {}),
  };
  const existing = peers.findIndex((p) => p.handle === clean.handle);
  let isNew: boolean;
  let peer: StoredPeer;
  if (existing >= 0) {
    isNew = false;
    const prev = peers[existing]!;
    peer = {
      ...clean,
      firstSeenAt: prev.firstSeenAt,
      lastSeenAt: at,
      // lastMessageAt is local metadata — carried over, never reset by a hello.
      ...(prev.lastMessageAt !== undefined ? { lastMessageAt: prev.lastMessageAt } : {}),
    };
    peers[existing] = peer;
  } else {
    isNew = true;
    peer = { ...clean, firstSeenAt: at, lastSeenAt: at };
    peers.push(peer);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(peersPath(dir), JSON.stringify({ peers }, null, 2) + '\n', 'utf8');
  return { peer, isNew };
}

/**
 * Stamp `lastMessageAt` on a stored peer (a `msg` just arrived from them).
 * Local metadata only; never on the wire. Returns false when the handle isn't
 * a known peer. Never throws — best-effort bookkeeping.
 */
export function recordPeerMessage(
  handle: string,
  dir: string = defaultStateDir(),
  now: Date = new Date(),
): boolean {
  try {
    const peers = loadPeers(dir);
    const idx = peers.findIndex((p) => p.handle === handle);
    if (idx < 0) return false;
    peers[idx] = { ...peers[idx]!, lastMessageAt: now.toISOString() };
    mkdirSync(dir, { recursive: true });
    writeFileSync(peersPath(dir), JSON.stringify({ peers }, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Discovery session                                                          */
/* -------------------------------------------------------------------------- */

/** Injection point for the match notification (defaults to vibe-core notify). */
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
   * The CLI passes one backed by the persisted blocklist (~/.vibedating).
   */
  readonly isBlocked?: (handle: string) => boolean;
  /** DHT bootstrap nodes; omit for the public DHT. Tests pass a local testnet. */
  readonly bootstrap?: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  /** Where peers.json lives. Defaults to ~/.vibedating. */
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
export async function startDiscovery(opts: DiscoveryOptions): Promise<DiscoverySession> {
  const { hello, stateDir = defaultStateDir(), onPeer, onLink, notify = vibeCoreNotify } = opts;
  const isBlocked = opts.isBlocked;
  // Topics: explicit list (preferred) > single legacy `topic` > own-league default.
  const topics: Buffer[] = opts.topics
    ? [...opts.topics]
    : opts.topic !== undefined
      ? [opts.topic]
      : [leagueTopic(hello.league)];
  // League-accept predicate: default = EXACT own-league match, so the legacy
  // privacy invariant (only same-league peers are retained) is unchanged
  // unless a caller widens it (e.g. CLI default ±1, or `--any`).
  const acceptLeague: (peerLeague: string) => boolean =
    opts.acceptLeague ?? ((l) => l === hello.league);

  // Imported lazily so non-live commands (`matches`, `mcp`, `--help`) never pay
  // for hyperswarm's native stack (udx/sodium) — it loads on first live use.
  const { default: Hyperswarm } = await import('hyperswarm');
  const swarm = new Hyperswarm(opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap });

  // Join only after the DHT node has routes: an announce/lookup issued against
  // an un-bootstrapped node completes instantly against an empty routing table,
  // and the next refresh is ~10 minutes out — the topic would be invisible.
  await swarm.dht.fullyBootstrapped();

  const peers = new Map<string, PeerHello>();

  swarm.on('connection', (socket, info) => {
    const remoteKey = info.publicKey.toString('hex');

    // Send our hello as the FIRST frame on the connection. The live protocol
    // unifies the old ad-hoc handshake line into a typed frame so the whole
    // stream (hello + chat) shares one newline-JSON frame channel. The payload
    // is still ONLY the allowlisted PeerHello fields — raw usage is never on it.
    socket.write(
      serializeFrame({
        t: 'hello',
        handle: hello.handle,
        league: hello.league,
        harness: hello.harness,
        ...(hello.verified !== undefined ? { verified: hello.verified } : {}),
        ...(hello.pubkey !== undefined ? { pubkey: hello.pubkey } : {}),
        ...(hello.nonce !== undefined ? { nonce: hello.nonce } : {}),
        ...(hello.sig !== undefined ? { sig: hello.sig } : {}),
      }) + '\n',
    );

    // The hello handshake: buffer until the first line, parse it as a frame,
    // enforce the league allowlist + the parseFrame field allowlist, then hand
    // the socket to a PeerLink for all subsequent frames.
    let buf = '';
    let handedOff = false;
    const onData = (chunk: Buffer): void => {
      if (handedOff) return; // PeerLink owns the socket now
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        const frame = parseFrame(line);
        if (frame === null) continue; // malformed/unknown — drop, never crash
        if (frame.t !== 'hello') continue; // frame #1 must be the hello
        // Identity check BEFORE anything is retained: a hello claiming a pubkey
        // whose signature doesn't verify is an impersonation attempt — the peer
        // is DROPPED entirely (never recorded, never notified, never paired),
        // exactly like a wrong-league or blocked peer. No pubkey → legacy peer,
        // accepted but never identity-verified.
        const verdict = classifyHelloIdentity(frame);
        if (verdict === 'drop') continue;
        // Build the PeerHello from the allowlisted fields only — anything else
        // a peer stuffed onto the frame was dropped by parseFrame. nonce/sig are
        // one-time proof material: verified above, then discarded, never retained.
        const peer: PeerHello = {
          handle: frame.handle,
          league: frame.league,
          harness: frame.harness,
          ...(frame.verified !== undefined ? { verified: frame.verified } : {}),
          ...(verdict === 'verified' && frame.pubkey !== undefined
            ? { pubkey: frame.pubkey, identityVerified: true }
            : {}),
        };
        // Self-filter: you can't match yourself. Drop a peer presenting your own
        // identity pubkey (e.g. two of your own instances on one topic), or —
        // when neither side has a pubkey (legacy peers) — your own handle.
        if (
          (peer.pubkey !== undefined && peer.pubkey === hello.pubkey) ||
          (peer.pubkey === undefined && hello.pubkey === undefined && peer.handle === hello.handle)
        ) {
          continue;
        }
        // The joined topic(s) scope which peers can reach us, but a peer could
        // still arrive on a shared topic advertising a league we don't accept
        // — drop it. `acceptLeague` defaults to EXACT own-league match, so the
        // legacy privacy invariant is unchanged unless a caller widens it.
        if (!acceptLeague(peer.league)) continue;
        // A blocked peer is dropped exactly like a wrong-league one: never
        // recorded to peers.json, never notified, never handed to onLink. The
        // CLI injects a predicate backed by the persisted blocklist.
        if (isBlocked !== undefined && isBlocked(peer.handle)) continue;
        peers.set(remoteKey, peer);
        const { isNew } = recordPeer(peer, stateDir);
        if (isNew) {
          // New mutual same-league peer → one best-effort vibenotify event.
          try {
            notify(
              makeEvent('match', hello.harness as Harness, process.cwd(), {
                summary: `matched with ${peer.handle} - LIVE SAME LEAGUE`,
                handle: peer.handle,
                league: peer.league,
                harness: peer.harness,
              }),
            );
          } catch {
            /* notify is best-effort; never let it break discovery */
          }
        }
        onPeer?.(peer, isNew);

        // Hello consumed — frame #1 done. Hand the socket (and any leftover
        // bytes after the hello line) to a PeerLink so subsequent msg/typing/bye
        // frames flow to the caller's onLink. Discovery behavior above is
        // identical whether or not a link is requested.
        handedOff = true;
        socket.off('data', onData);
        if (onLink !== undefined) {
          const link = createPeerLink(socket, peer, buf);
          // Local metadata: every incoming msg stamps lastMessageAt on the
          // persisted peer. Best-effort; never affects the link.
          link.onMessage(() => {
            recordPeerMessage(peer.handle, stateDir);
          });
          onLink(link);
        }
        buf = '';
        return;
      }
    };
    socket.on('data', onData);
    socket.on('error', () => {
      /* peer vanished mid-handshake — fine, the swarm retries */
    });
  });

  // Join EVERY topic on the one swarm (e.g. your league + adjacent leagues).
  // Each join returns its own discovery handle; refresh + leave them all below.
  const discoveries = topics.map((t) => swarm.join(t, { server: true, client: true }));

  // Await the first announce/lookup round on EVERY topic before returning:
  // once they complete, our records are stored on the DHT, so a peer joining
  // AFTER us finds us in its first round. A failed first round is retried by
  // the refresher below.
  const ready: Promise<unknown> = Promise.all(
    discoveries.map((d) => d.flushed().catch(() => undefined)),
  );
  await ready;

  // hyperswarm re-refreshes a topic only every ~10 minutes — fine for a
  // long-lived daemon, wrong for a `discover` session: peers who join while
  // we're online should be noticed within seconds, and a first round that
  // missed or errored (the swarm swallows round errors) must not cost the
  // whole session. Re-run rounds on a short cadence until close().
  const refresher = setInterval(() => {
    for (const d of discoveries) void d.refresh({ server: true, client: true }).catch(() => {});
  }, REFRESH_INTERVAL_MS);
  refresher.unref();

  let closed = false;
  return {
    topic: topics[0]!, // primary (first) — kept for back-compat / display
    topics, // every joined topic (primary first)
    hello,
    peers,
    ready,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(refresher);
      for (const t of topics) {
        try {
          await swarm.leave(t);
        } catch {
          /* network already gone */
        }
      }
      await swarm.destroy();
    },
  };
}

/** Random 32-byte topic for tests/local experiments — never collides with a real league topic. */
export function randomTopic(): Buffer {
  return randomBytes(32);
}
