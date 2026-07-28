/**
 * Integration test: THREE real vibenetwork nodes in one process, on an isolated
 * in-process DHT (hyperdht's createTestnet — the public DHT is never touched).
 *
 * Each node runs the real stack: persistent ed25519 identity + profile (fake
 * usage reader — no logs touched), a bounded feed store, and a presence
 * session on the shared `vibenet:all` topic with feed sync + DM recording
 * wired onto every PeerLink — exactly what the CLI wires.
 *
 * Covered end to end:
 *   1. signed posts propagate via feed sync (pre-existing + live broadcast),
 *   2. a TAMPERED post frame (bad signature) is dropped by every receiver,
 *   3. DMs arrive only at the intended peer and persist in the local thread,
 *   4. the follow graph filters the feed view (not the topic).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Harness } from '@pooriaarab/vibe-core';
import { recordDm } from './dm.js';
import { createFeedStore, createPost, postToFrame, type FeedStore } from './feed.js';
import { follow, resolveFollowedPubkeys } from './follow.js';
import { loadOrCreateIdentity, signHelloClaims } from './identity.js';
import type { PeerLink } from './link.js';
import { globalTopic } from './presence.js';
import { startDiscovery, type DiscoverySession, type PeerHello } from './p2p.js';
import { createProfile, type LocalUsageSnapshot } from './profile.js';

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fake usage reader: deterministic league, no disk/logs touched. */
function fakeUsage(totalTokens: number) {
  return async (harness: Harness): Promise<LocalUsageSnapshot> => ({
    harness,
    totalTokens,
    verified: true,
    source: 'real',
    windowStart: '2026-01-01T00:00:00.000Z',
    windowEnd: '2026-01-31T00:00:00.000Z',
  });
}

interface TestNode {
  readonly handle: string;
  readonly dir: string;
  readonly pubkey: string;
  readonly store: FeedStore;
  readonly links: PeerLink[];
  readonly session: DiscoverySession;
}

describe('vibenetwork v0 (in-process DHT, no public network)', () => {
  let testnet: Awaited<ReturnType<typeof createTestnet>>;
  let nodes: TestNode[];
  let dirs: string[];

  beforeEach(async () => {
    testnet = await createTestnet(3);
    nodes = [];
    dirs = [];
  }, 30_000);

  afterEach(async () => {
    for (const n of nodes) await n.session.close();
    await testnet.destroy();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }, 30_000);

  function tmpDir(): string {
    const d = mkdtempSync(path.join(os.tmpdir(), 'vibenetwork-it-'));
    dirs.push(d);
    return d;
  }

  /**
   * Bring up a full node: identity + profile + feed store + presence session
   * on vibenet:all (accept every league), with the CLI's exact link wiring:
   * feed sync both ways + inbound DMs recorded to the local thread.
   */
  async function spawn(handle: string, totalTokens: number): Promise<TestNode> {
    const dir = tmpDir();
    const profile = await createProfile({ handle, dir, usageReader: fakeUsage(totalTokens) });
    const identity = loadOrCreateIdentity(dir);
    const store = createFeedStore(dir);
    const claims = {
      handle: profile.handle,
      league: profile.league,
      harness: 'claude-code',
      verified: profile.verified,
    };
    const hello: PeerHello = { ...claims, ...signHelloClaims(identity, claims) };
    const links: PeerLink[] = [];
    const session = await startDiscovery({
      hello,
      topics: [globalTopic()],
      acceptLeague: () => true, // the global topic: every league is welcome
      bootstrap: testnet.bootstrap,
      stateDir: dir,
      onLink: (link) => {
        links.push(link);
        // Feed sync (what the CLI's wireFeedSync does).
        for (const p of store.recent()) link.sendPost(postToFrame(p));
        link.onPost((frame) => store.addFrame(frame));
        // DM ingress (what the CLI/web bridge does).
        link.onMessage((m) => {
          recordDm(link.hello.handle, { direction: 'in', text: m.text, at: m.at }, dir);
        });
        link.onClose(() => {
          const i = links.indexOf(link);
          if (i >= 0) links.splice(i, 1);
        });
      },
    });
    const node: TestNode = { handle: profile.handle, dir, pubkey: identity.publicKeyHex, store, links, session };
    nodes.push(node);
    return node;
  }

  /** Wait until `node` holds an open link to `handle`; returns it. */
  async function waitLink(node: TestNode, handle: string, timeoutMs = 30_000): Promise<PeerLink> {
    const ok = await waitFor(() => node.links.some((l) => l.hello.handle === handle), timeoutMs);
    expect(ok).toBe(true);
    return node.links.find((l) => l.hello.handle === handle)!;
  }

  it('signed posts propagate to every connected node via feed sync', async () => {
    // ALICE authors a post BEFORE anyone connects — sync-on-connect must carry it.
    const alice = await spawn('@alice', 23_400_000);
    const post = createPost(loadOrCreateIdentity(alice.dir), 'shipping v0 — signed, sealed, delivered');
    expect(alice.store.add(post).added).toBe(true);

    const bob = await spawn('@bob', 5_000_000);
    const carol = await spawn('@carol', 120_000_000);
    await Promise.all([alice.session.ready, bob.session.ready, carol.session.ready]);

    const synced = await waitFor(
      () =>
        bob.store.list().some((p) => p.id === post.id) &&
        carol.store.list().some((p) => p.id === post.id),
      40_000,
    );
    expect(synced).toBe(true);
    // Received posts verify + carry the author's pubkey (not the relayer's).
    expect(bob.store.list().find((p) => p.id === post.id)?.authorPubkey).toBe(alice.pubkey);

    // A LIVE broadcast (post minted after links are up) reaches open links too.
    const live = createPost(loadOrCreateIdentity(alice.dir), 'second post, live push');
    alice.store.add(live);
    for (const l of alice.links) l.sendPost(postToFrame(live));
    const liveSynced = await waitFor(
      () => bob.store.list().some((p) => p.id === live.id) && carol.store.list().some((p) => p.id === live.id),
      20_000,
    );
    expect(liveSynced).toBe(true);
  }, 90_000);

  it('drops a TAMPERED post frame at every receiver (never retained)', async () => {
    const alice = await spawn('@alice', 23_400_000);
    const bob = await spawn('@bob', 5_000_000);
    await Promise.all([alice.session.ready, bob.session.ready]);
    await waitLink(alice, '@bob');

    const before = bob.store.size;

    // MALLORY: a raw swarm (no vibenetwork stack) pushing a forged post frame
    // — well-formed hex, but the signature was never made by the claimed author.
    const { default: Hyperswarm } = await import('hyperswarm');
    const mallory = new Hyperswarm({ bootstrap: testnet.bootstrap });
    await mallory.dht.fullyBootstrapped();
    const forged = {
      t: 'post' as const,
      id: 'a'.repeat(64),
      author: alice.pubkey, // claims to be alice
      text: 'forged by mallory',
      at: Date.now(),
      sig: 'ef'.repeat(64), // never signed by alice's key
    };
    let aliceSawMallory = false;
    mallory.on('connection', (socket) => {
      // Frame #1 must be a hello (legacy shape: no pubkey) so the receiver's
      // handshake accepts the connection; frame #2 is the forged post.
      socket.write(
        JSON.stringify({ t: 'hello', handle: '@mallory', league: '10M', harness: 'codex' }) + '\n',
      );
      socket.write(JSON.stringify(forged) + '\n');
      socket.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('@alice')) aliceSawMallory = true;
      });
      socket.on('error', () => {});
    });
    const discovery = mallory.join(globalTopic(), { server: true, client: true });
    const retry = setInterval(() => {
      void discovery.refresh({ server: true, client: true }).catch(() => {});
    }, 1000);

    try {
      const connected = await waitFor(() => aliceSawMallory, 30_000);
      expect(connected).toBe(true);
      await sleep(1_000); // let any (non-)processing settle
      // BOB never met mallory directly here — but ALICE did, and if ALICE had
      // retained the forgery her next sync would spread it. Both must be clean.
      const all = [...alice.store.list(), ...bob.store.list()];
      expect(all.some((p) => p.text === 'forged by mallory')).toBe(false);
      expect(bob.store.size).toBe(before);
    } finally {
      clearInterval(retry);
      await mallory.destroy();
    }
  }, 90_000);

  it('DMs reach only the intended peer and persist; the follow graph filters the feed view', async () => {
    const alice = await spawn('@alice', 23_400_000);
    const bob = await spawn('@bob', 5_000_000);
    const carol = await spawn('@carol', 120_000_000);
    await Promise.all([alice.session.ready, bob.session.ready, carol.session.ready]);

    // Everyone authors one post (before links settle, sync carries them).
    const postA = createPost(loadOrCreateIdentity(alice.dir), 'alice was here');
    const postC = createPost(loadOrCreateIdentity(carol.dir), 'carol says hi');
    alice.store.add(postA);
    carol.store.add(postC);
    for (const l of alice.links) l.sendPost(postToFrame(postA));
    for (const l of carol.links) l.sendPost(postToFrame(postC));

    const aliceToBob = await waitLink(alice, '@bob');
    await waitLink(bob, '@alice');

    // DM alice → bob. Carol must NOT receive it.
    aliceToBob.send('hey bob — e2e over the swarm');
    const { loadThread } = await import('./dm.js');
    const dmArrived = await waitFor(
      () => loadThread('@alice', bob.dir).some((m) => m.text === 'hey bob — e2e over the swarm'),
      20_000,
    );
    expect(dmArrived).toBe(true);
    expect(loadThread('@alice', carol.dir)).toEqual([]);
    expect(loadThread('@bob', carol.dir)).toEqual([]);

    // Both posts synced to BOB (firehose sees everyone)…
    const firehose = await waitFor(
      () =>
        bob.store.list().some((p) => p.id === postA.id) &&
        bob.store.list().some((p) => p.id === postC.id),
      30_000,
    );
    expect(firehose).toBe(true);

    // …but BOB follows only ALICE: the follow-filtered view hides CAROL.
    // (@alice resolves to her pubkey via BOB's peer book, written at handshake.)
    follow('@alice', bob.dir);
    const followed = resolveFollowedPubkeys(bob.dir);
    expect(followed.has(alice.pubkey)).toBe(true);
    const view = bob.store
      .list()
      .filter((p) => p.authorPubkey === bob.pubkey || followed.has(p.authorPubkey));
    expect(view.some((p) => p.id === postA.id)).toBe(true);
    expect(view.some((p) => p.id === postC.id)).toBe(false);
  }, 90_000);
});
