/**
 * vibenetwork — a decentralized social network for AI coders.
 *
 * v0 library surface: the core types (Profile / Post / follow graph) plus
 * re-exports of the module APIs. The trust model in one paragraph:
 *
 *   - Identity is a persistent ed25519 keypair (~/.vibenetwork/identity.json).
 *   - Raw token usage NEVER leaves the machine — only the derived league
 *     bucket + a verified flag (true iff the usage source was real local logs).
 *   - Every post is ed25519-signed by its author; receivers verify and DROP
 *     anything that doesn't check out (tamper-drop).
 *   - Posts + presence share ONE global hyperswarm topic (`vibenet:all`); the
 *     local follow graph filters what you SEE, not which topic you join.
 *   - DMs ride per-peer encrypted connections (hyperswarm noise) whose hello
 *     handshake is bound to the peer's identity key.
 *   - input-safety: all peer text (posts, DMs, handles, bios) is UNTRUSTED display
 *     data — never executed, sanitized before display.
 */

/** A coder's public profile. Persisted locally at ~/.vibenetwork/profile.json. */
export interface Profile {
  /** Canonical handle ('@name'). */
  readonly handle: string;
  /** ed25519 identity public key (64 hex) — the stable identity behind the handle. */
  readonly pubkey: string;
  /** Free-text bio, capped at 160 chars (see profile.ts MAX_BIO_LEN). */
  readonly bio: string;
  /**
   * Usage league bucket derived from local harness logs (see profile.ts
   * `league`). Raw token counts are NEVER stored here or shared.
   */
  readonly league: string;
  /** True iff the league came from REAL local logs (usage source === 'real'). */
  readonly verified: boolean;
  /** Optional links (URLs etc.), capped in count + length by profile.ts. */
  readonly links: readonly string[];
  /** ISO timestamp of the first connect. */
  readonly connectedAt: string;
}

/**
 * A signed feed post — the wire shape (as a `post` frame, see frame.ts) and
 * the stored shape (feed.json) are the same object.
 */
export interface Post {
  /** 64-hex sha256 of the canonical signing payload (dedupe + tamper-evidence). */
  readonly id: string;
  /** Author's ed25519 identity pubkey (64 hex). Wire name: `author`. */
  readonly authorPubkey: string;
  /** Post body, 1..500 chars. UNTRUSTED display data once received. */
  readonly text: string;
  /** Author-minted ms epoch timestamp. */
  readonly at: number;
  /** ed25519 signature (128 hex) over the canonical payload (see feed.ts). */
  readonly sig: string;
}

/**
 * One edge of the LOCAL follow graph (follows.json). A follow target is a
 * handle OR a pubkey (at least one present); pubkey edges resolve handles
 * lazily via the peer book, handle edges resolve pubkeys the same way.
 */
export interface FollowEntry {
  /** Canonical '@name' when followed by handle. */
  readonly handle?: string;
  /** 64-hex ed25519 pubkey when followed by pubkey. */
  readonly pubkey?: string;
  /** ISO timestamp — when the edge was created. */
  readonly at: string;
}

/* -------------------------------------------------------------------------- */
/* Module re-exports (the library surface)                                    */
/* -------------------------------------------------------------------------- */

export {
  LEAGUES,
  BELOW_LEAGUE,
  MAX_BIO_LEN,
  MAX_LINKS,
  MAX_LINK_LEN,
  createProfile,
  league,
  loadProfile,
  parseTokensEnv,
  readUsage,
  updateProfile,
} from './profile.js';
export type { LocalUsageSnapshot } from './profile.js';

export {
  FEED_SYNC_COUNT,
  MAX_FEED_POSTS,
  canonicalPostPayload,
  createFeedStore,
  createPost,
  postFromFrame,
  postToFrame,
  verifyPost,
} from './feed.js';
export type { FeedStore } from './feed.js';

export {
  follow,
  isFollowed,
  listFollows,
  resolveFollowedPubkeys,
  unfollow,
} from './follow.js';
export type { FollowChange } from './follow.js';

export { GLOBAL_TOPIC_NAME, globalTopic, rosterFromPeers, startPresence } from './presence.js';
export type { PresenceOptions, RosterEntry } from './presence.js';

export { loadThread, recordDm, sendDm, threadPeers } from './dm.js';
export type { DmMessage } from './dm.js';

export { generateHandle, ensureHandle } from './handlegen.js';
export { sanitizePeerText } from './untrusted.js';

export {
  LIVE_NOTICE,
  TOPIC_PREFIX,
  leagueTopic,
  loadPeers,
  parseHandshake,
  randomTopic,
  recordPeer,
  recordPeerMessage,
  serializeHandshake,
  startDiscovery,
} from './p2p.js';
export type { DiscoveryOptions, DiscoverySession, PeerHello, StoredPeer } from './p2p.js';

export {
  canonicalHelloClaims,
  classifyHelloIdentity,
  loadOrCreateIdentity,
  signHelloClaims,
  verifyHelloClaims,
} from './identity.js';
export type { HelloClaims, Identity, IdentityProof, IdentityVerdict } from './identity.js';

export {
  addBlock,
  canShareLive,
  defaultStateDir,
  grantLiveConsent,
  isBlocked,
  loadBlocklist,
  loadHandle,
  normalizeHandle,
  removeBlock,
  resolveHandle,
  sameHandle,
  saveHandle,
} from './state.js';

export { createPeerLink } from './link.js';
export type { PeerLink } from './link.js';
export { parseFrame, serializeFrame, POST_TEXT_MAX } from './frame.js';
export type { Frame, PostFrame } from './frame.js';

/* Re-export the vibe-core primitives this product is built on, for convenience. */
export { createConsentLedger } from '@pooriaarab/vibe-core';
export type { Harness, UsageSnapshot, UsageSource } from '@pooriaarab/vibe-core';
