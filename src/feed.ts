/**
 * The signed-post feed.
 *
 * Sign/verify scheme (both sides compute it byte-identically or it cannot verify):
 *
 *   canonical = `vibenet:post|<authorPubkey>|<at>|<text>`
 *   id        = sha256(canonical) as 64 hex         (dedupe + tamper-evidence)
 *   sig       = ed25519 sign(canonical) with the author's identity key (128 hex)
 *
 * `at` is a non-negative integer ms epoch (author-minted); `authorPubkey` is
 * fixed-shape hex, so no field-boundary ambiguity is possible in `canonical`.
 *
 * Trust rules:
 *   - {@link verifyPost} NEVER throws: any anomaly (bad shape, id mismatch,
 *     bad signature) is simply `false`, and the store DROPS such posts
 *     (tamper-drop) — they are never persisted, never displayed.
 *   - Post text is UNTRUSTED display data (AEGIS): never executed, sanitized
 *     before display (untrusted.ts) by every surface that shows it.
 *   - The store is bounded ({@link MAX_FEED_POSTS}); a flood cannot grow it
 *     without limit, and duplicates (same id) are absorbed.
 *
 * Propagation: peers exchange their recent posts on connect (feed sync) over
 * the shared `vibenet:all` topic; a freshly-minted post is pushed to every
 * open link. The follow graph filters what you SEE, not which topic you join.
 */
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { POST_TEXT_MAX } from './frame.js';
import type { PostFrame } from './frame.js';
import type { Identity } from './identity.js';
import type { Post } from './index.js';
import { defaultStateDir } from './state.js';

/** Hard bound on retained posts (newest by `at` win). */
export const MAX_FEED_POSTS = 500;
/** How many recent posts each side sends on feed sync (on connect). */
export const FEED_SYNC_COUNT = 50;

const FEED_FILE = 'feed.json';

/* -------------------------------------------------------------------------- */
/* Sign / verify                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The canonical string a post signature commits to:
 * `vibenet:post|<authorPubkey>|<at>|<text>`. Pure; both sides compute it
 * byte-identically or the signature cannot verify.
 */
export function canonicalPostPayload(post: {
  authorPubkey: string;
  at: number;
  text: string;
}): string {
  return `vibenet:post|${post.authorPubkey}|${post.at}|${post.text}`;
}

/** The post id: sha256 of the canonical payload (64 hex). Pure. */
export function postId(post: { authorPubkey: string; at: number; text: string }): string {
  return createHash('sha256').update(canonicalPostPayload(post), 'utf8').digest('hex');
}

/**
 * Mint a signed post with the local identity. Throws on empty/oversized text
 * (over {@link POST_TEXT_MAX}) — better to fail locally than broadcast junk.
 * `at` defaults to now (ms); injectable for tests.
 */
export function createPost(identity: Identity, text: string, at: number = Date.now()): Post {
  if (typeof text !== 'string' || text.length === 0 || text.length > POST_TEXT_MAX) {
    throw new Error(`post text must be 1-${POST_TEXT_MAX} chars`);
  }
  if (!Number.isFinite(at) || at < 0) throw new Error('post timestamp must be non-negative');
  const unsigned = { authorPubkey: identity.publicKeyHex, at, text };
  const sig = sign(null, Buffer.from(canonicalPostPayload(unsigned), 'utf8'), identity.privateKey);
  return { id: postId(unsigned), authorPubkey: unsigned.authorPubkey, text, at, sig: sig.toString('hex') };
}

/**
 * Verify a claimed post. NEVER throws — any anomaly (bad hex, wrong id,
 * oversized text, bad signature) is simply `false`. This is the tamper-drop
 * gate every received post passes through before it is retained or shown.
 */
export function verifyPost(post: unknown): post is Post {
  try {
    if (typeof post !== 'object' || post === null) return false;
    const p = post as Record<string, unknown>;
    const id = p['id'];
    const authorPubkey = p['authorPubkey'];
    const text = p['text'];
    const at = p['at'];
    const sig = p['sig'];
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/i.test(id)) return false;
    if (typeof authorPubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(authorPubkey)) return false;
    if (typeof text !== 'string' || text.length === 0 || text.length > POST_TEXT_MAX) return false;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return false;
    if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/i.test(sig)) return false;
    const unsigned = { authorPubkey: authorPubkey.toLowerCase(), at, text };
    // The id must be the sha256 of the exact signed payload — a recomputed
    // mismatch means the envelope was tampered with even before the sig check.
    if (postId(unsigned) !== id.toLowerCase()) return false;
    const publicKey = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(authorPubkey, 'hex').toString('base64url'),
      },
      format: 'jwk',
    });
    return verify(
      null,
      Buffer.from(canonicalPostPayload(unsigned), 'utf8'),
      publicKey,
      Buffer.from(sig, 'hex'),
    );
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Wire mapping (post frame <-> Post)                                         */
/* -------------------------------------------------------------------------- */

/** Map a stored/local Post to its wire frame shape. Built key-by-key. */
export function postToFrame(post: Post): PostFrame {
  return {
    t: 'post',
    id: post.id,
    author: post.authorPubkey,
    text: post.text,
    at: post.at,
    sig: post.sig,
  };
}

/** Map a parsed `post` frame back to a Post (verification happens separately). */
export function postFromFrame(frame: PostFrame): Post {
  return {
    id: frame.id,
    authorPubkey: frame.author,
    text: frame.text,
    at: frame.at,
    sig: frame.sig,
  };
}

/* -------------------------------------------------------------------------- */
/* Bounded persistent feed store (~/.vibenetwork/feed.json)                   */
/* -------------------------------------------------------------------------- */

/** Outcome of adding one post to the store. */
export type AddResult =
  | { readonly added: true }
  | { readonly added: false; readonly reason: 'invalid' | 'duplicate' | 'evicted' };

export interface FeedStore {
  /** Number of retained posts. */
  readonly size: number;
  /**
   * Verify + retain a post. TAMPER-DROP: anything {@link verifyPost} rejects
   * is refused ('invalid'); a known id is a no-op ('duplicate'); when the
   * store is full the oldest posts are evicted — including the incoming one
   * if it is older than everything retained ('evicted').
   */
  add(post: unknown): AddResult;
  /** Verify + retain a parsed `post` frame (convenience over {@link add}). */
  addFrame(frame: PostFrame): AddResult;
  /** Retained posts, newest first (`at` desc, id tiebreak). */
  list(): Post[];
  /** The `n` newest posts (defaults to {@link FEED_SYNC_COUNT}) — the sync set. */
  recent(n?: number): Post[];
}

function feedPath(dir: string): string {
  return path.join(dir, FEED_FILE);
}

function byNewest(a: Post, b: Post): number {
  if (b.at !== a.at) return b.at - a.at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Open (or create) the bounded feed store at `<dir>/feed.json`. Corrupt or
 * unverifiable entries on disk are dropped on load — the tamper-drop rule
 * applies to our own disk too, not just the wire.
 */
export function createFeedStore(dir: string = defaultStateDir()): FeedStore {
  let posts: Post[] = [];
  try {
    const raw = readFileSync(feedPath(dir), 'utf8');
    const data = JSON.parse(raw) as { posts?: unknown };
    if (Array.isArray(data.posts)) {
      posts = data.posts.filter((p): p is Post => verifyPost(p)).sort(byNewest).slice(0, MAX_FEED_POSTS);
    }
  } catch {
    posts = [];
  }

  const persist = (): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(feedPath(dir), JSON.stringify({ posts }, null, 2) + '\n', 'utf8');
  };

  const add = (post: unknown): AddResult => {
    if (!verifyPost(post)) return { added: false, reason: 'invalid' };
    if (posts.some((p) => p.id === post.id)) return { added: false, reason: 'duplicate' };
    posts.push(post);
    posts.sort(byNewest);
    if (posts.length > MAX_FEED_POSTS) {
      const overflow = posts.length - MAX_FEED_POSTS;
      const evicted = posts.splice(posts.length - overflow, overflow);
      if (evicted.some((p) => p.id === post.id)) {
        persist();
        return { added: false, reason: 'evicted' };
      }
    }
    persist();
    return { added: true };
  };

  return {
    get size(): number {
      return posts.length;
    },
    add,
    addFrame(frame: PostFrame): AddResult {
      return add(postFromFrame(frame));
    },
    list(): Post[] {
      return [...posts];
    },
    recent(n: number = FEED_SYNC_COUNT): Post[] {
      return posts.slice(0, Math.max(0, n));
    },
  };
}
