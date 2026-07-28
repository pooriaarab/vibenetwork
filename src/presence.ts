/**
 * Presence — the roster of online coders.
 *
 * Everyone joins ONE global hyperswarm topic (`vibenet:all`) — the same swarm
 * that carries signed posts. Discovery is {@link startDiscovery} with the
 * league filter wide open (`acceptLeague: () => true`): the follow graph
 * filters what you SEE in your feed, never which peers may appear in your
 * roster. Every roster entry carries the two trust marks from the handshake:
 *
 *   ✓  usage-verified (self-asserted: league from REAL local logs)
 *   🔑 identity-verified (LOCALLY derived: the hello signature checked out
 *      against the peer's ed25519 key — an unverifiable claim is dropped
 *      before it ever reaches the roster)
 */
import { isFollowed } from './follow.js';
import { leagueTopic, startDiscovery } from './p2p.js';
import type { DiscoverySession, NotifySink, PeerHello } from './p2p.js';
import type { PeerLink } from './link.js';
import { defaultStateDir, isBlocked } from './state.js';

/** The bucket name hashed into the global topic: sha256('vibenet:all'). */
export const GLOBAL_TOPIC_NAME = 'all';

/** The 32-byte global topic every vibenetwork peer joins. Pure. */
export function globalTopic(): Buffer {
  return leagueTopic(GLOBAL_TOPIC_NAME);
}

/** One roster row: the allowlisted hello fields + local follow state. */
export interface RosterEntry {
  readonly handle: string;
  readonly league: string;
  readonly harness: string;
  /** Self-asserted usage-verification flag from the peer's hello (✓). */
  readonly verified?: boolean;
  /** LOCAL-derived: the peer's hello signature verified against its key (🔑). */
  readonly identityVerified?: boolean;
  /** LOCAL: whether you follow this peer. */
  readonly followed: boolean;
}

/** Options for {@link startPresence} (a narrowed {@link DiscoveryOptions}). */
export interface PresenceOptions {
  /** What we broadcast (profile fields + signed identity proof). */
  readonly hello: PeerHello;
  /** DHT bootstrap nodes; omit for the public DHT. Tests pass a local testnet. */
  readonly bootstrap?: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  /** Where peers.json / follows.json live. Defaults to ~/.vibenetwork. */
  readonly stateDir?: string;
  /** Called after each accepted handshake; `isNew` = first time this handle is seen. */
  readonly onPeer?: (peer: PeerHello, isNew: boolean) => void;
  /** Called once per connection with a live PeerLink (feed sync + DMs ride it). */
  readonly onLink?: (link: PeerLink) => void;
  /** Match-notification sink (tests capture with a fake). Best-effort. */
  readonly notify?: NotifySink;
}

/**
 * Join the global `vibenet:all` swarm. The returned session is a plain
 * {@link DiscoverySession}; its live `peers` map + {@link rosterFromPeers}
 * give the roster. Consent gate lives with the caller (`connect` grants it).
 */
export function startPresence(opts: PresenceOptions): Promise<DiscoverySession> {
  const stateDir = opts.stateDir ?? defaultStateDir();
  return startDiscovery({
    hello: opts.hello,
    topics: [globalTopic()],
    // The GLOBAL topic accepts every league — seeing a coder is not gated on
    // their usage bucket. Raw usage still never appears in any hello.
    acceptLeague: () => true,
    isBlocked: (handle) => isBlocked(handle, stateDir),
    stateDir,
    ...(opts.bootstrap !== undefined ? { bootstrap: opts.bootstrap } : {}),
    ...(opts.onPeer !== undefined ? { onPeer: opts.onPeer } : {}),
    ...(opts.onLink !== undefined ? { onLink: opts.onLink } : {}),
    ...(opts.notify !== undefined ? { notify: opts.notify } : {}),
  });
}

/**
 * Snapshot the roster from a live session's peer set (or any PeerHello list),
 * marking local follow state. Sorted by handle for stable display.
 */
export function rosterFromPeers(
  peers: Iterable<PeerHello>,
  dir: string = defaultStateDir(),
): RosterEntry[] {
  return [...peers]
    .map((p) => ({
      handle: p.handle,
      league: p.league,
      harness: p.harness,
      ...(p.verified !== undefined ? { verified: p.verified } : {}),
      ...(p.identityVerified !== undefined ? { identityVerified: p.identityVerified } : {}),
      followed: isFollowed(p.handle, dir),
    }))
    .sort((a, b) => a.handle.localeCompare(b.handle));
}
