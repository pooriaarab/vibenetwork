/**
 * The local follow graph (~/.vibenetwork/follows.json).
 *
 * Following is a LOCAL-ONLY signal: it is never broadcast. It filters what
 * your feed SHOWS (see feed.ts / the CLI + web app), not which topic you join
 * — everyone shares the one global `vibenet:all` topic regardless.
 *
 * A follow target is a handle (`@alice`) or an identity pubkey (64-hex).
 * Pubkeys are the stable identity; handles resolve to pubkeys lazily via the
 * peer book (peers.json — populated by discovery after a verified handshake).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FollowEntry } from './index.js';
import { loadPeers } from './p2p.js';
import { defaultStateDir, normalizeHandle, sameHandle } from './state.js';

const FOLLOWS_FILE = 'follows.json';

function followsPath(dir: string): string {
  return path.join(dir, FOLLOWS_FILE);
}

/** A parsed follow target: exactly one of handle / pubkey. */
export type FollowTarget = { readonly handle: string } | { readonly pubkey: string };

/**
 * Parse a follow target: a 64-hex string is an identity pubkey; anything else
 * must be a valid handle. Throws on neither. Pure.
 */
export function parseFollowTarget(input: string): FollowTarget {
  const trimmed = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return { pubkey: trimmed.toLowerCase() };
  const handle = normalizeHandle(trimmed);
  if (handle !== null) return { handle };
  throw new Error(`invalid follow target: use a @handle or a 64-hex pubkey`);
}

function matchesTarget(entry: FollowEntry, target: FollowTarget): boolean {
  if ('handle' in target) {
    return entry.handle !== undefined && sameHandle(entry.handle, target.handle);
  }
  return entry.pubkey !== undefined && entry.pubkey.toLowerCase() === target.pubkey;
}

/** Load the follow graph, or `[]` if none/corrupt. Local-only data. */
export function listFollows(dir: string = defaultStateDir()): FollowEntry[] {
  try {
    const raw = readFileSync(followsPath(dir), 'utf8');
    const data = JSON.parse(raw) as { follows?: unknown };
    if (!Array.isArray(data.follows)) return [];
    // Keep only well-shaped entries (at least one of handle/pubkey).
    return data.follows.filter((e): e is FollowEntry => {
      if (typeof e !== 'object' || e === null) return false;
      const r = e as Record<string, unknown>;
      const hasHandle = typeof r['handle'] === 'string' && normalizeHandle(r['handle']) !== null;
      const hasPubkey = typeof r['pubkey'] === 'string' && /^[0-9a-fA-F]{64}$/.test(r['pubkey']);
      return (hasHandle || hasPubkey) && typeof r['at'] === 'string';
    });
  } catch {
    return [];
  }
}

function persist(follows: readonly FollowEntry[], dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(followsPath(dir), JSON.stringify({ follows }, null, 2) + '\n', 'utf8');
}

/** Result of {@link follow} / {@link unfollow}: the new graph + a flag. */
export interface FollowChange {
  readonly follows: FollowEntry[];
  /** `true` when this call actually changed the graph. */
  readonly changed: boolean;
}

/**
 * Follow a handle or pubkey (idempotent).
 * ponytail: v0 stores handle edges and pubkey edges as separate entries; a
 * handle edge and a pubkey edge for the same underlying person merge only at
 * read time (see {@link resolveFollowedPubkeys}), not in the file.
 */
export function follow(
  input: string,
  dir: string = defaultStateDir(),
  now: Date = new Date(),
): FollowChange {
  const target = parseFollowTarget(input);
  const follows = listFollows(dir);
  if (follows.some((e) => matchesTarget(e, target))) return { follows, changed: false };
  const entry: FollowEntry = {
    ...('handle' in target ? { handle: target.handle } : { pubkey: target.pubkey }),
    at: now.toISOString(),
  };
  const next = [...follows, entry];
  persist(next, dir);
  return { follows: next, changed: true };
}

/** Unfollow a handle or pubkey (idempotent). */
export function unfollow(input: string, dir: string = defaultStateDir()): FollowChange {
  const target = parseFollowTarget(input);
  const follows = listFollows(dir);
  const next = follows.filter((e) => !matchesTarget(e, target));
  if (next.length === follows.length) return { follows, changed: false };
  persist(next, dir);
  return { follows: next, changed: true };
}

/** Whether the target is currently followed. Never throws. */
export function isFollowed(input: string, dir: string = defaultStateDir()): boolean {
  try {
    const target = parseFollowTarget(input);
    return listFollows(dir).some((e) => matchesTarget(e, target));
  } catch {
    return false;
  }
}

/**
 * Resolve the follow graph to a set of identity pubkeys (lowercase hex), for
 * feed filtering: pubkey edges pass through directly; handle edges resolve via
 * the peer book (a peer's pubkey is known after an identity-verified hello).
 * Unresolvable handle edges simply contribute nothing yet.
 */
export function resolveFollowedPubkeys(dir: string = defaultStateDir()): Set<string> {
  const out = new Set<string>();
  const follows = listFollows(dir);
  for (const e of follows) {
    if (e.pubkey !== undefined) out.add(e.pubkey.toLowerCase());
  }
  const handleEdges = follows.filter((e) => e.handle !== undefined);
  if (handleEdges.length > 0) {
    for (const peer of loadPeers(dir)) {
      if (peer.pubkey === undefined) continue;
      if (handleEdges.some((e) => sameHandle(e.handle!, peer.handle))) {
        out.add(peer.pubkey.toLowerCase());
      }
    }
  }
  return out;
}
