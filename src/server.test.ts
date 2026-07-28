import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFeedStore, createPost } from './feed.js';
import type { PostFrame } from './frame.js';
import { POST_TEXT_MAX } from './frame.js';
import { loadOrCreateIdentity } from './identity.js';
import type { PeerLink } from './link.js';
import type { PeerHello } from './p2p.js';
import type { Harness } from '@pooriaarab/vibe-core';
import type { LocalUsageSnapshot } from './profile.js';
import {
  createNetBridge,
  startServer,
  type NetBridge,
  type NetMessage,
  type NetPeerInfo,
  type StartedServer,
} from './server.js';

/** Deterministic usage reader — never touches real harness logs. */
function fakeUsage(totalTokens = 12_000_000) {
  return async (harness: Harness): Promise<LocalUsageSnapshot> => ({
    harness,
    totalTokens,
    verified: true,
    source: 'real',
    windowStart: '2026-01-01T00:00:00.000Z',
    windowEnd: '2026-01-31T00:00:00.000Z',
  });
}

let dir: string;
let srv: StartedServer;
beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vibenetwork-server-'));
  srv = await startServer({ dir, usageReader: fakeUsage() });
});
afterEach(async () => {
  await new Promise<void>((resolve) => srv.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const get = async (path_: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${srv.url}${path_}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const post = async (
  path_: string,
  data: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${srv.url}${path_}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('local web app server', () => {
  it('serves the HTML shell at /', async () => {
    const res = await fetch(`${srv.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    const html = await res.text();
    expect(html).toContain('vibenetwork');
    expect(html).toContain('/api/profile');
    expect(html).toContain('/api/feed');
    expect(html).toContain('/api/who');
    expect(html).toContain('/api/dm');
  });

  it('starts disconnected; /api/post + /api/profile refuse before connect', async () => {
    expect((await get('/api/state')).body.connected).toBe(false);
    expect((await get('/api/profile')).body.connected).toBe(false);
    expect((await post('/api/post', { text: 'hi' })).status).toBe(409);
    expect((await post('/api/profile', { bio: 'x' })).status).toBe(409);
  });

  it('connect creates a profile (memetic handle when unset) without raw usage', async () => {
    const r = await post('/api/connect', {});
    expect(r.status).toBe(200);
    expect(r.body.connected).toBe(true);
    expect(r.body.handle).toMatch(/^@[a-z0-9_]+$/);
    expect(JSON.stringify(r.body)).not.toMatch(/totalTokens/i);
    // Explicit handle respected on a fresh dir.
    const dir2 = mkdtempSync(path.join(os.tmpdir(), 'vibenetwork-server2-'));
    const srv2 = await startServer({ dir: dir2, usageReader: fakeUsage() });
    try {
      const r2 = await fetch(`${srv2.url}/api/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: 'alice' }),
      });
      const body = (await r2.json()) as { handle: string };
      expect(body.handle).toBe('@alice');
    } finally {
      await new Promise<void>((resolve) => srv2.server.close(() => resolve()));
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('POST /api/post re-validates through the frame allowlist (400 on junk)', async () => {
    await post('/api/connect', { handle: '@alice' });
    // Oversized text is rejected by the SAME parseFrame gate the wire uses.
    expect((await post('/api/post', { text: 'x'.repeat(POST_TEXT_MAX + 1) })).status).toBe(400);
    expect((await post('/api/post', { text: '' })).status).toBe(400);
    expect((await post('/api/post', { text: 42 })).status).toBe(400);
    expect((await post('/api/post', 'garbage')).status).toBe(400);
    const ok = await post('/api/post', { text: 'shipping v0' });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.delivered).toBe(0); // no bridge attached in tests
  });

  it('feed shows own posts by default; firehose via ?all=1', async () => {
    await post('/api/connect', { handle: '@alice' });
    await post('/api/post', { text: 'first post' });
    const mine = await get('/api/feed');
    const posts = mine.body.posts as Array<Record<string, unknown>>;
    expect(posts).toHaveLength(1);
    expect(posts[0]?.author).toBe('@alice');
    expect(posts[0]?.mine).toBe(true);
    expect(posts[0]?.text).toBe('first post');
    const all = await get('/api/feed?all=1');
    expect(all.body.posts).toHaveLength(1);
    expect(all.body.all).toBe(true);
  });

  it('follow/unfollow round-trip with validation', async () => {
    await post('/api/connect', { handle: '@alice' });
    expect((await post('/api/follow', { target: 'bad handle' })).status).toBe(400);
    expect((await post('/api/follow', {})).status).toBe(400);
    const f = await post('/api/follow', { target: '@bob' });
    expect(f.body.changed).toBe(true);
    expect((await get('/api/follows')).body.follows).toHaveLength(1);
    expect((await get('/api/follow')).body.follows).toHaveLength(1);
    expect((await post('/api/unfollow', { target: '@bob' })).body.changed).toBe(true);
    expect((await get('/api/follows')).body.follows).toHaveLength(0);
  });

  it('dm routes validate input; offline peer → 409', async () => {
    await post('/api/connect', { handle: '@alice' });
    expect((await get('/api/dm')).status).toBe(400);
    expect((await post('/api/dm', { handle: '@bob', text: 'hi' })).status).toBe(409);
    const thread = await get('/api/dm?handle=@bob');
    expect(thread.status).toBe(200);
    expect(thread.body.messages).toEqual([]);
    expect(thread.body.online).toBe(false);
  });

  it('profile edit caps bio + links server-side', async () => {
    await post('/api/connect', { handle: '@alice' });
    const r = await post('/api/profile', { bio: 'y'.repeat(300), links: ['https://a.dev'] });
    expect(r.status).toBe(200);
    expect((r.body.bio as string)).toHaveLength(160);
    expect(r.body.links).toEqual(['https://a.dev']);
    expect((await post('/api/profile', { bio: 7 })).status).toBe(400);
  });

  it('404s an unknown path', async () => {
    expect((await get('/nope')).status).toBe(404);
  });
});

describe('GET /api/who + DM bridge with NetBridge', () => {
  function fakeBridge(seedPeers: readonly NetPeerInfo[] = []): NetBridge & {
    sentMessages: Array<{ handle: string; text: string }>;
    msgQueue: Map<string, NetMessage[]>;
    broadcast: PostFrame[];
  } {
    const sentMessages: Array<{ handle: string; text: string }> = [];
    const msgQueue = new Map<string, NetMessage[]>();
    const broadcast: PostFrame[] = [];
    const peers: NetPeerInfo[] = [...seedPeers];
    return {
      peers,
      addLink() {},
      isOnline(handle) {
        return peers.some((p) => p.handle === handle);
      },
      sendMessage(handle, text) {
        if (!peers.some((p) => p.handle === handle)) return false;
        sentMessages.push({ handle, text });
        return true;
      },
      async pollMessage(handle) {
        const q = msgQueue.get(handle) ?? [];
        if (q.length > 0) return q.shift() ?? null;
        return null;
      },
      broadcastPost(frame) {
        broadcast.push(frame);
        return peers.length;
      },
      sentMessages,
      msgQueue,
      broadcast,
    };
  }

  it('reflects the bridge peer snapshot on /api/who', async () => {
    const bridge = fakeBridge([
      {
        handle: '@bob',
        league: '10M',
        harness: 'codex',
        verified: true,
        identityVerified: true,
        followed: false,
      },
    ]);
    const s = await startServer({ dir, bridge, usageReader: fakeUsage() });
    try {
      const res = await fetch(`${s.url}/api/who`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { peers: NetPeerInfo[] };
      expect(json.peers).toHaveLength(1);
      expect(json.peers[0]?.handle).toBe('@bob');
      expect(json.peers[0]?.identityVerified).toBe(true);
    } finally {
      await new Promise<void>((resolve) => s.server.close(() => resolve()));
    }
  });

  it('relays a valid DM and re-validates bad payloads', async () => {
    const bridge = fakeBridge([
      { handle: '@bob', league: '10M', harness: 'codex', followed: false },
    ]);
    // Use a fresh dir so beforeEach's server doesn't collide; attach bridge.
    await new Promise<void>((resolve) => srv.server.close(() => resolve()));
    srv = await startServer({ dir, bridge, usageReader: fakeUsage() });

    const ok = await post('/api/dm', { handle: 'bob', text: 'hello bob' });
    expect(ok.status).toBe(200);
    expect(bridge.sentMessages).toEqual([{ handle: '@bob', text: 'hello bob' }]);

    expect((await post('/api/dm', { text: 'hi' })).status).toBe(400);
    expect((await post('/api/dm', { handle: 'not a handle!!!', text: 'hi' })).status).toBe(400);
    expect((await post('/api/dm', { handle: '@bob' })).status).toBe(400);
    expect((await post('/api/dm', { handle: '@bob', text: '' })).status).toBe(400);
    expect((await post('/api/dm', { handle: '@bob', text: 'x'.repeat(4001) })).status).toBe(400);
    expect((await post('/api/dm', { handle: '@bob', text: 99 })).status).toBe(400);
    expect((await post('/api/dm', 'nope')).status).toBe(400);
    expect((await post('/api/dm', { handle: '@nobody', text: 'hi' })).status).toBe(409);

    bridge.msgQueue.set('@bob', [{ id: 'm1', text: 'yo back', at: 123 }]);
    const polled = await get('/api/dm?wait=1&handle=@bob');
    expect(polled.status).toBe(200);
    expect(polled.body.message).toEqual({ id: 'm1', text: 'yo back', at: 123 });
  });

  it('broadcasts a published post through the attached bridge', async () => {
    await new Promise<void>((resolve) => srv.server.close(() => resolve()));
    const bridge = fakeBridge([
      { handle: '@bob', league: '10M', harness: 'codex', followed: false },
    ]);
    srv = await startServer({ dir, bridge, usageReader: fakeUsage() });
    await post('/api/connect', { handle: '@alice' });
    const res = await post('/api/post', { text: 'broadcast me' });
    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(1);
    expect(bridge.broadcast).toHaveLength(1);
    expect(bridge.broadcast[0]?.text).toBe('broadcast me');
  });
});

describe('createNetBridge()', () => {
  function fakeLink(hello: PeerHello): PeerLink & {
    posts: PostFrame[];
    sent: string[];
    fireMessage: (m: { id: string; text: string; at: number }) => void;
    fireClose: () => void;
  } {
    const messageCbs = new Set<(m: { id: string; text: string; at: number }) => void>();
    const closeCbs = new Set<() => void>();
    const posts: PostFrame[] = [];
    const sent: string[] = [];
    return {
      hello,
      posts,
      sent,
      send(text) {
        sent.push(text);
      },
      sendPost(p) {
        posts.push(p);
      },
      async sendMedia() {
        return { id: 'x', size: 0 };
      },
      sendSignal() {},
      onMessage(cb) {
        messageCbs.add(cb);
      },
      onPost() {},
      onMedia() {},
      onSignal() {},
      onClose(cb) {
        closeCbs.add(cb);
      },
      close() {
        for (const cb of closeCbs) cb();
      },
      fireMessage(m) {
        for (const cb of messageCbs) cb(m);
      },
      fireClose() {
        for (const cb of closeCbs) cb();
      },
    };
  }

  it('tracks peers, queues inbound DMs, and broadcasts posts', async () => {
    const feed = createFeedStore(dir);
    const me = loadOrCreateIdentity(dir);
    feed.add(createPost(me, 'seed', 1_700_000_000_000));

    const bridge = createNetBridge({ dir, feed });
    const link = fakeLink({
      handle: '@peer',
      league: '10M',
      harness: 'claude-code',
      verified: true,
      identityVerified: true,
    });
    bridge.addLink(link);

    expect(link.posts.some((p) => p.text === 'seed')).toBe(true);
    expect(bridge.peers).toEqual([
      {
        handle: '@peer',
        league: '10M',
        harness: 'claude-code',
        verified: true,
        identityVerified: true,
        followed: false,
      },
    ]);
    expect(bridge.isOnline('@peer')).toBe(true);

    link.fireMessage({ id: 'a', text: 'hi\u0000there', at: 42 });
    const got = await bridge.pollMessage('@peer', 50);
    expect(got).toEqual({ id: 'a', text: 'hithere', at: 42 });

    expect(bridge.sendMessage('@peer', 'pong')).toBe(true);
    expect(link.sent).toContain('pong');
    expect(bridge.sendMessage('@missing', 'x')).toBe(false);

    const frame = {
      t: 'post' as const,
      id: 'a'.repeat(64),
      author: 'b'.repeat(64),
      text: 'yo',
      at: 1,
      sig: 'c'.repeat(128),
    };
    expect(bridge.broadcastPost(frame)).toBe(1);
    expect(link.posts[link.posts.length - 1]).toEqual(frame);

    link.fireClose();
    expect(bridge.peers).toEqual([]);
    expect(bridge.isOnline('@peer')).toBe(false);
  });
});
