import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FEED_SYNC_COUNT,
  MAX_FEED_POSTS,
  canonicalPostPayload,
  createFeedStore,
  createPost,
  postFromFrame,
  postToFrame,
  verifyPost,
} from './feed.js';
import { parseFrame, serializeFrame, POST_TEXT_MAX } from './frame.js';
import { loadOrCreateIdentity } from './identity.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vibenetwork-feed-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function identityIn(d: string) {
  return loadOrCreateIdentity(d);
}

describe('createPost() / verifyPost()', () => {
  it('round-trips: a freshly signed post verifies', () => {
    const id = identityIn(dir);
    const post = createPost(id, 'shipping v0', 1_700_000_000_000);
    expect(post.id).toMatch(/^[0-9a-f]{64}$/);
    expect(post.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(post.authorPubkey).toBe(id.publicKeyHex);
    expect(verifyPost(post)).toBe(true);
  });

  it('canonical payload + id are deterministic (same post → same id → dedupe)', () => {
    const id = identityIn(dir);
    const a = createPost(id, 'hello feed', 1_700_000_000_000);
    const b = createPost(id, 'hello feed', 1_700_000_000_000);
    expect(canonicalPostPayload(a)).toBe(
      `vibenet:post|${id.publicKeyHex}|1700000000000|hello feed`,
    );
    expect(a.id).toBe(b.id);
    expect(a.sig).toBe(b.sig); // ed25519 is deterministic
  });

  it('rejects empty and oversized text at creation', () => {
    const id = identityIn(dir);
    expect(() => createPost(id, '')).toThrow(/1-500/);
    expect(() => createPost(id, 'x'.repeat(POST_TEXT_MAX + 1))).toThrow(/1-500/);
    expect(createPost(id, 'x'.repeat(POST_TEXT_MAX))).toBeDefined();
  });
});

describe('verifyPost() — TAMPER-DROP', () => {
  it('drops a post whose text was modified after signing', () => {
    const id = identityIn(dir);
    const post = createPost(id, 'original', 1_700_000_000_000);
    expect(verifyPost({ ...post, text: 'forged' })).toBe(false);
  });

  it('drops a post whose timestamp was modified', () => {
    const id = identityIn(dir);
    const post = createPost(id, 'original', 1_700_000_000_000);
    expect(verifyPost({ ...post, at: 1_800_000_000_000 })).toBe(false);
  });

  it('drops a post re-attributed to another pubkey (impersonation)', () => {
    const alice = identityIn(dir);
    const malloryDir = mkdtempSync(path.join(os.tmpdir(), 'vibenetwork-feed-m-'));
    try {
      const mallory = identityIn(malloryDir);
      const post = createPost(alice, 'mine', 1_700_000_000_000);
      // Mallory re-signs alice's text with HIS key but keeps alice's pubkey.
      const forged = createPost(mallory, 'mine', 1_700_000_000_000);
      expect(verifyPost({ ...post, authorPubkey: mallory.publicKeyHex })).toBe(false);
      expect(verifyPost({ ...forged, authorPubkey: alice.publicKeyHex })).toBe(false);
    } finally {
      rmSync(malloryDir, { recursive: true, force: true });
    }
  });

  it('drops a post whose id was recomputed/substituted (envelope tamper)', () => {
    const id = identityIn(dir);
    const post = createPost(id, 'original', 1_700_000_000_000);
    expect(verifyPost({ ...post, id: 'f'.repeat(64) })).toBe(false);
  });

  it('drops malformed shapes (never throws)', () => {
    expect(verifyPost(null)).toBe(false);
    expect(verifyPost('a post')).toBe(false);
    expect(verifyPost({})).toBe(false);
    expect(verifyPost({ id: 'x'.repeat(64) })).toBe(false);
    const id = identityIn(dir);
    const post = createPost(id, 'ok', 1_700_000_000_000);
    expect(verifyPost({ ...post, sig: 'not-hex' })).toBe(false);
    expect(verifyPost({ ...post, at: -1 })).toBe(false);
    expect(verifyPost({ ...post, text: 'x'.repeat(POST_TEXT_MAX + 1) })).toBe(false);
  });
});

describe('wire mapping + frame round-trip', () => {
  it('postToFrame/postFromFrame are inverse; the frame survives parseFrame', () => {
    const id = identityIn(dir);
    const post = createPost(id, 'on the wire', 1_700_000_000_000);
    const frame = postToFrame(post);
    expect(postFromFrame(frame)).toEqual(post);
    const parsed = parseFrame(serializeFrame(frame));
    expect(parsed).not.toBeNull();
    expect(parsed!.t).toBe('post');
    expect(verifyPost(postFromFrame(parsed as Parameters<typeof postFromFrame>[0]))).toBe(true);
  });
});

describe('FeedStore (bounded + persistent)', () => {
  it('adds valid posts, drops invalid + duplicate ones', () => {
    const id = identityIn(dir);
    const store = createFeedStore(dir);
    const post = createPost(id, 'first', 1_700_000_000_000);
    expect(store.add(post)).toEqual({ added: true });
    expect(store.add(post)).toEqual({ added: false, reason: 'duplicate' });
    expect(store.add({ ...post, text: 'tampered', id: 'e'.repeat(64) })).toEqual({
      added: false,
      reason: 'invalid',
    });
    expect(store.size).toBe(1);
  });

  it('persists across store instances and reloads newest-first', () => {
    const id = identityIn(dir);
    const store = createFeedStore(dir);
    store.add(createPost(id, 'old', 1_700_000_000_000));
    store.add(createPost(id, 'new', 1_800_000_000_000));
    store.add(createPost(id, 'mid', 1_750_000_000_000));
    const reopened = createFeedStore(dir);
    expect(reopened.size).toBe(3);
    expect(reopened.list().map((p) => p.text)).toEqual(['new', 'mid', 'old']);
    expect(reopened.recent(2).map((p) => p.text)).toEqual(['new', 'mid']);
    expect(FEED_SYNC_COUNT).toBeLessThanOrEqual(MAX_FEED_POSTS);
  });

  it('evicts the oldest beyond MAX_FEED_POSTS', () => {
    const id = identityIn(dir);
    const store = createFeedStore(dir);
    for (let i = 0; i < MAX_FEED_POSTS + 10; i++) {
      store.add(createPost(id, `post ${i}`, 1_700_000_000_000 + i));
    }
    expect(store.size).toBe(MAX_FEED_POSTS);
    const texts = store.list().map((p) => p.text);
    expect(texts).toContain(`post ${MAX_FEED_POSTS + 9}`); // newest kept
    expect(texts).not.toContain('post 0'); // oldest evicted
  });

  it('refuses an incoming post older than everything retained when full', () => {
    const id = identityIn(dir);
    const store = createFeedStore(dir);
    for (let i = 0; i < MAX_FEED_POSTS; i++) {
      store.add(createPost(id, `post ${i}`, 1_700_000_000_000 + i));
    }
    expect(store.add(createPost(id, 'ancient', 1))).toEqual({ added: false, reason: 'evicted' });
    expect(store.size).toBe(MAX_FEED_POSTS);
  });

  it('drops unverifiable posts found on disk (tamper-drop applies to disk too)', () => {
    const id = identityIn(dir);
    const store = createFeedStore(dir);
    const good = createPost(id, 'good', 1_700_000_000_000);
    store.add(good);
    // Corrupt the file: one valid post + one tampered + one garbage entry.
    const file = path.join(dir, 'feed.json');
    const data = JSON.parse(readFileSync(file, 'utf8')) as { posts: unknown[] };
    data.posts.push({ ...good, id: 'f'.repeat(64), text: 'tampered' }, 'garbage');
    writeFileSync(file, JSON.stringify(data));
    const reopened = createFeedStore(dir);
    expect(reopened.size).toBe(1);
    expect(reopened.list()[0]).toEqual(good);
  });
});
