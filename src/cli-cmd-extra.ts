import readline from 'node:readline';
import process from 'node:process';
import { loadOrCreateIdentity } from './identity.js';
import { recordDm, sendDm } from './dm.js';
import { createFeedStore, createPost, postToFrame } from './feed.js';
import { resolveFollowedPubkeys, isFollowed } from './follow.js';
import { loadPeers, LIVE_NOTICE } from './p2p.js';
import { loadProfile } from './profile.js';
import { defaultStateDir, normalizeHandle, sameHandle } from './state.js';
import { sanitizePeerText } from '@pooriaarab/vibe-core/untrusted';
import { startPresence } from './presence.js';
import { createNetBridge, startServer } from './server.js';
import type { NetBridge } from './server.js';
import type { PeerLink } from './link.js';
import type { Profile } from './index.js';
import { buildHello, formatAgo, usageMark, idMark, requireProfile, sleep, wireFeedSync, MARKS_LEGEND } from './cli-helpers.js';
export async function cmdFeed(all: boolean): Promise<number> {
  const profile = requireProfile();
  if (!profile) {
    process.stderr.write('Not connected yet. Run `vibenetwork connect` first.\n');
    return 1;
  }
  const dir = defaultStateDir();
  const store = createFeedStore(dir);
  const followedPubkeys = resolveFollowedPubkeys(dir);
  const posts = all
    ? store.list()
    : store
        .list()
        .filter((p) => p.authorPubkey === profile.pubkey || followedPubkeys.has(p.authorPubkey));
  // Resolve author handles from the peer book (pubkey → handle). A post's
  // authorship is cryptographic; the handle is only a display hint.
  const byPubkey = new Map(loadPeers(dir).map((p) => [p.pubkey?.toLowerCase() ?? '', p]));
  process.stdout.write('\n');
  process.stdout.write(
    all ? '  feed — firehose (all verified posts)\n' : '  feed — followed coders + you (use --all for the firehose)\n',
  );
  process.stdout.write(`  ${MARKS_LEGEND}\n\n`);
  if (posts.length === 0) {
    process.stdout.write('  (nothing yet — post something, or follow coders you see in `who`)\n\n');
    return 0;
  }
  for (const p of posts.slice(0, 50)) {
    const peer = byPubkey.get(p.authorPubkey.toLowerCase());
    const mine = p.authorPubkey === profile.pubkey;
    // input-safety: handle + text are untrusted — sanitized before display.
    const author = mine
      ? profile.handle
      : peer !== undefined
        ? sanitizePeerText(peer.handle)
        : `@${p.authorPubkey.slice(0, 8)}…`;
    const marks = mine || peer === undefined ? '' : ` ${usageMark(peer)}${idMark(peer)}`;
    process.stdout.write(`  ${author}${marks} · ${formatAgo(p.at)}\n`);
    process.stdout.write(`  ${sanitizePeerText(p.text)}\n\n`);
  }
  return 0;
}

export function validatePostInput(text: string | undefined, profile: Profile | null): number | null {
  if (profile === null) {
    process.stderr.write('Not connected yet. Run `vibenetwork connect` first.\n');
    return 1;
  }
  if (text === undefined || text.trim() === '') {
    process.stderr.write('usage: vibenetwork post "<text>" (1-500 chars)\n');
    return 1;
  }
  return null;
}

export function createValidatedPost(text: string, dir: string): ReturnType<typeof createPost> | null {
  const identity = loadOrCreateIdentity(dir);
  try {
    return createPost(identity, text);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

export async function broadcastPostWithSync(
  post: ReturnType<typeof createPost>,
  profile: Profile,
  store: ReturnType<typeof createFeedStore>,
): Promise<{ delivered: number; offline: boolean }> {
  const links = new Set<PeerLink>();
  const hello = buildHello(profile);
  const session = await startPresence({
    hello,
    onLink: (link) => {
      links.add(link);
      wireFeedSync(link, store);
      link.sendPost(postToFrame(post));
      link.onClose(() => links.delete(link));
    },
  }).catch(() => null);
  if (session === null) return { delivered: 0, offline: true };
  const deadline = Date.now() + 8_000;
  while (links.size === 0 && Date.now() < deadline) await sleep(200);
  await sleep(1_000);
  const delivered = links.size;
  await session.close();
  return { delivered, offline: false };
}

export async function cmdPost(text: string | undefined): Promise<number> {
  const profile = requireProfile();
  const pre = validatePostInput(text, profile);
  if (pre !== null) return pre;
  const dir = defaultStateDir();
  const post = createValidatedPost(text as string, dir);
  if (post === null) return 1;
  const store = createFeedStore(dir);
  store.add(post);
  const { delivered, offline } = await broadcastPostWithSync(post, profile as Profile, store);
  if (offline) {
    process.stdout.write('  offline — post stored locally; it syncs on your next session\n');
    return 0;
  }
  process.stdout.write(
    delivered > 0
      ? `  posted ✓ (id ${post.id.slice(0, 8)}…) · delivered to ${delivered} peer${delivered === 1 ? '' : 's'}\n`
      : '  posted ✓ — no peers online right now; stored locally, syncs when someone connects\n',
  );
  return 0;
}

/**
 * `vibenetwork dm <@handle>` — e2e chat with ONE peer. Joins the global swarm
 * and waits for that handle's link (the handshake already proved their
 * identity); other peers still feed-sync in the background. Readline loop;
 * /quit or Ctrl+C/Ctrl+D to leave.
 */
export function validateDmInput(arg: string | undefined, profile: Profile | null): { target: string } | number {
  if (profile === null) {
    process.stderr.write('Not connected yet. Run `vibenetwork connect` first.\n');
    return 1;
  }
  if (arg === undefined || arg.trim() === '') {
    process.stderr.write('usage: vibenetwork dm <@handle>\n');
    return 1;
  }
  const target = normalizeHandle(arg);
  if (target === null) {
    process.stderr.write(`invalid handle: ${arg}\n`);
    return 1;
  }
  return { target };
}

export function createDmLinkHandler(ctx: { target: string; store: ReturnType<typeof createFeedStore>; dir: string; current: { link: PeerLink | undefined } }): (link: PeerLink) => void {
  return (link) => {
    wireFeedSync(link, ctx.store);
    if (!sameHandle(link.hello.handle, ctx.target)) return;
    ctx.current.link = link;
    link.onMessage((m) => {
      recordDm(ctx.target, { direction: 'in', text: m.text, at: m.at }, ctx.dir);
      process.stdout.write(`  <${sanitizePeerText(link.hello.handle)}> ${sanitizePeerText(m.text)}\n`);
    });
    link.onClose(() => {
      if (ctx.current.link === link) {
        ctx.current.link = undefined;
        process.stdout.write('  · peer left — waiting for them to return…\n');
      }
    });
    process.stdout.write(`  · connected to ${sanitizePeerText(link.hello.handle)} ${usageMark(link.hello)}${idMark(link.hello)} — type to chat, /quit to leave\n`);
  };
}

export async function handleDmInputLoop(ctx: { target: string; dir: string; current: { link: PeerLink | undefined } }): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const stop = (): void => rl.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  for await (const line of rl) {
    const text = line.trim();
    if (text === '/quit') break;
    if (text === '') continue;
    if (ctx.current.link === undefined) {
      process.stdout.write(`  · ${ctx.target} is not online yet — still waiting…\n`);
      continue;
    }
    try {
      sendDm(ctx.current.link, text, ctx.dir);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}

export async function cmdDm(arg: string | undefined): Promise<number> {
  const profile = requireProfile();
  const validated = validateDmInput(arg, profile);
  if (typeof validated === 'number') return validated;
  const { target } = validated;
  const dir = defaultStateDir();
  const store = createFeedStore(dir);
  const hello = buildHello(profile as Profile);
  process.stdout.write('\n');
  process.stdout.write(`  ${LIVE_NOTICE}\n`);
  process.stdout.write(`  looking for ${target} on vibenet:all… (Ctrl+C to give up)\n\n`);
  const current: { link: PeerLink | undefined } = { link: undefined };
  const handler = createDmLinkHandler({ target, store, dir, current });
  const session = await startPresence({ hello, onLink: handler });
  await handleDmInputLoop({ target, dir, current });
  process.stdout.write('\n  leaving the swarm…\n');
  await session.close();
  process.stdout.write('\n');
  return 0;
}

export async function cmdOpen(port: number | undefined): Promise<number> {
  // Attach the net bridge when a profile exists so the web app can reach real
  // peers; without one the app still serves (profile/connect pane works).
  const profile = loadProfile();
  const dir = defaultStateDir();
  let bridge: NetBridge | undefined;
  if (profile) {
    bridge = createNetBridge({ dir });
  }
  // Serve FIRST (instant, offline-capable); join the swarm in the BACKGROUND.
  const started = await startServer({ ...(port !== undefined ? { port } : {}), dir, ...(bridge !== undefined ? { bridge } : {}) });
  if (profile && bridge) {
    process.stdout.write(`\n  ${LIVE_NOTICE}\n`);
    const hello = buildHello(profile);
    void startPresence({
      hello,
      onLink: (link) => {
        if (bridge === undefined) throw new Error('bridge not initialized');
        bridge.addLink(link);
      },
    })
      .then((session) => {
        process.once('SIGINT', () => void session.close());
        process.once('SIGTERM', () => void session.close());
      })
      .catch(() => {
        /* offline / DHT unreachable — the local app still works */
      });
  }
  process.stdout.write(`\n  vibenetwork local web app → ${started.url}\n`);
  process.stdout.write(
    profile
      ? '  • feed + presence + DMs live for connected peers\n'
      : '  • connect first (`vibenetwork connect`) to join the network\n',
  );
  process.stdout.write('  (Ctrl+C to stop)\n\n');
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  process.stdout.write('\n  shutting down…\n');
  await new Promise<void>((resolve) => started.server.close(() => resolve()));
  return 0;
}

