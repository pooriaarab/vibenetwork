#!/usr/bin/env node
/**
 * vibenetwork CLI — a decentralized social network for AI coders (local-first).
 *
 *   vibenetwork connect           Create identity + profile (memetic handle if unset)
 *   vibenetwork profile [--bio ".."] [--link URL]  Show or edit your profile
 *   vibenetwork handle [@name]    Print or set your handle
 *   vibenetwork who               Live presence roster (global vibenet:all swarm)
 *   vibenetwork follow <@h|pubkey>    Follow a coder (local graph — filters your feed)
 *   vibenetwork unfollow <@h|pubkey>  Unfollow
 *   vibenetwork feed [--all]      Your feed (followed + own posts; --all = firehose)
 *   vibenetwork post "<text>"     Sign + broadcast a post (<=500 chars)
 *   vibenetwork dm <@h>           Open an e2e DM session with a peer
 *   vibenetwork open [--port N]   Serve the local web app
 *   vibenetwork mcp               Run the stdio MCP server
 *   vibenetwork --version / --help
 *
 * Privacy: raw token usage never leaves the machine — only the derived league
 * + verified flag ride the (signed) hello. Peer text is UNTRUSTED display
 * data: sanitized before it is ever shown. No new deps: a tiny hand-rolled
 * arg parser over process.argv.
 */
import { realpathSync } from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import type { Harness } from '@pooriaarab/vibe-core';
import { loadOrCreateIdentity, signHelloClaims } from './identity.js';
import { recordDm, sendDm } from './dm.js';
import { createFeedStore, createPost, postToFrame } from './feed.js';
import { follow, isFollowed, listFollows, resolveFollowedPubkeys, unfollow } from './follow.js';
import { ensureHandle } from './handlegen.js';
import type { PeerLink } from './link.js';
import { runMcp } from './mcp.js';
import { LIVE_NOTICE, loadPeers } from './p2p.js';
import type { PeerHello } from './p2p.js';
import { globalTopic, rosterFromPeers, startPresence } from './presence.js';
import { createProfile, loadProfile, readUsage, updateProfile } from './profile.js';
import type { LocalUsageSnapshot } from './profile.js';
import type { Profile } from './index.js';
import { createNetBridge, startServer, type NetBridge } from './server.js';
import {
  canShareLive,
  defaultStateDir,
  loadHandle,
  normalizeHandle,
  resolveHandle,
  sameHandle,
  saveHandle,
} from './state.js';
import { sanitizePeerText } from './untrusted.js';

/** Mirrors package.json version (kept here; package.json imports are brittle under bundling). */
const VERSION = '0.1.1';

/** Recognized top-level commands, plus the synthetic help/version. */
export type Command =
  | 'connect'
  | 'profile'
  | 'handle'
  | 'who'
  | 'follow'
  | 'unfollow'
  | 'feed'
  | 'post'
  | 'dm'
  | 'open'
  | 'mcp'
  | 'help'
  | 'version'
  | null;

export interface ParsedArgs {
  readonly command: Command;
  /** Port for `open --port`; undefined means "let the OS pick". */
  readonly port: number | undefined;
  /** `feed --all`: the unfiltered firehose (default: followed + own posts). */
  readonly all: boolean;
  /** `profile --bio "..."`. */
  readonly bio: string | undefined;
  /** `profile --link URL` (repeatable; replaces the links list). */
  readonly links: readonly string[];
  /** Positional argument (handle for follow/unfollow/dm/handle, text for post). */
  readonly arg: string | undefined;
}

function parsePort(raw: string): number | undefined {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

/**
 * Parse argv (the slice AFTER the program name) into a command + options.
 * Pure: no IO, no process access — trivially unit-testable.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let out: ParsedArgs = {
    command: null,
    port: undefined,
    all: false,
    bio: undefined,
    links: [],
    arg: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--version' || a === '-v') {
      return { command: 'version', port: undefined, all: false, bio: undefined, links: [], arg: undefined };
    }
    if (a === '--help' || a === '-h') {
      return { command: 'help', port: undefined, all: false, bio: undefined, links: [], arg: undefined };
    }
    if (a === '--all') {
      out = { ...out, all: true };
      continue;
    }
    if (a === '--bio') {
      const next = argv[i + 1];
      if (next !== undefined) {
        out = { ...out, bio: next };
        i++;
      }
      continue;
    }
    if (a.startsWith('--bio=')) {
      out = { ...out, bio: a.slice('--bio='.length) };
      continue;
    }
    if (a === '--link') {
      const next = argv[i + 1];
      if (next !== undefined) {
        out = { ...out, links: [...out.links, next] };
        i++;
      }
      continue;
    }
    if (a.startsWith('--link=')) {
      out = { ...out, links: [...out.links, a.slice('--link='.length)] };
      continue;
    }
    if (a === '--port') {
      const next = argv[i + 1];
      if (next !== undefined) {
        const p = parsePort(next);
        if (p !== undefined) out = { ...out, port: p };
        i++;
      }
      continue;
    }
    if (a.startsWith('--port=')) {
      const p = parsePort(a.slice('--port='.length));
      if (p !== undefined) out = { ...out, port: p };
      continue;
    }
    if (a.startsWith('-')) continue; // ignore unknown flags
    const known: Command =
      a === 'connect' ||
      a === 'profile' ||
      a === 'handle' ||
      a === 'who' ||
      a === 'follow' ||
      a === 'unfollow' ||
      a === 'feed' ||
      a === 'post' ||
      a === 'dm' ||
      a === 'open' ||
      a === 'mcp' ||
      a === 'help'
        ? a
        : null;
    if (known !== null && out.command === null) {
      out = { ...out, command: known };
    } else if (out.arg === undefined) {
      // First positional after the command → the command's argument.
      out = { ...out, arg: a };
    } else if (out.command === 'post') {
      // `post "some text"` may arrive split across positionals — rejoin.
      out = { ...out, arg: `${out.arg} ${a}` };
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Compact relative time for local lists: an ISO timestamp or ms epoch →
 * "just now" / "5m ago" / "3h ago" / "2d ago". Unparseable input → "unknown".
 */
export function formatAgo(at: string | number, now: Date = new Date()): string {
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (Number.isNaN(t)) return 'unknown';
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Compact token count for LOCAL display: 19_200_000_000 → "19.2B". */
function formatTokens(n: number): string {
  const trim = (v: number): string => String(Math.round(v * 10) / 10);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}k`;
  return String(n);
}

/**
 * Honest verification line for `connect` — where the usage number ACTUALLY came
 * from. Only `source === 'real'` is "verified". The token total is shown only
 * here, on the local machine — never on the wire.
 */
function verificationText(snapshot: LocalUsageSnapshot): string {
  if (snapshot.source === 'real') {
    return `verified: real usage — ${formatTokens(snapshot.totalTokens)} tokens from ${snapshot.harness} logs`;
  }
  if (snapshot.source === 'self-report') return 'self-reported (unverified)';
  return 'demo (unverified)';
}

/** Usage-verification mark: ✓ real local logs, ~ otherwise. */
function usageMark(peer: { verified?: boolean }): string {
  return peer.verified === true ? '✓' : '~';
}

/** Identity mark: 🔑 when the peer's hello signature verified against its key. */
function idMark(peer: { identityVerified?: boolean }): string {
  return peer.identityVerified === true ? ' 🔑' : '';
}

/** One-line legend printed wherever peer marks are shown. */
const MARKS_LEGEND =
  'marks: ✓ usage verified (real local logs) · ~ unverified · 🔑 identity-verified (signed hello)';

/**
 * The hello we broadcast: profile fields + the honest usage-verification flag,
 * signed with the persistent ed25519 identity so the handle can't be forged.
 * Never any raw usage.
 * ponytail: the harness isn't on the Profile type (v0 spec) — it comes from
 * VIBENETWORK_HARNESS or defaults to claude-code at broadcast time.
 */
function buildHello(profile: Profile): PeerHello {
  const claims = {
    handle: resolveHandle(),
    league: profile.league,
    harness: (process.env['VIBENETWORK_HARNESS'] as Harness | undefined) ?? 'claude-code',
    verified: profile.verified,
  };
  return { ...claims, ...signHelloClaims(loadOrCreateIdentity(), claims) };
}

/** Load the profile or fail with the standard hint. */
function requireProfile(): Profile | null {
  return loadProfile();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wire feed sync onto a fresh link: both sides immediately send their recent
 * posts to each other, and every incoming `post` frame is verified (tamper-
 * drop inside the store) and retained. This is the whole gossip protocol —
 * bounded by FEED_SYNC_COUNT in each direction per connection.
 */
function wireFeedSync(link: PeerLink, store: ReturnType<typeof createFeedStore>): void {
  for (const p of store.recent()) link.sendPost(postToFrame(p));
  link.onPost((frame) => store.addFrame(frame));
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

async function cmdConnect(): Promise<number> {
  const harness: Harness = (process.env['VIBENETWORK_HARNESS'] as Harness | undefined) ?? 'claude-code';
  // Zero-friction: first connect mints + persists a memetic handle when none is
  // set (env override still wins as a one-off) — never silently ship as @you.
  const ensured = ensureHandle();
  const snapshot = await readUsage(harness);
  const profile = await createProfile({ handle: ensured.handle, usageReader: async () => snapshot });
  const identity = loadOrCreateIdentity();
  process.stdout.write('\n');
  process.stdout.write(`  ${profile.league === 'below-1M' ? 'below 1M (not yet in a league)' : `${profile.league} League`}\n`);
  process.stdout.write(`  handle: ${profile.handle}\n`);
  if (ensured.generated) {
    process.stdout.write(`  assigned handle: ${profile.handle} — change it with: vibenetwork handle @name\n`);
  }
  process.stdout.write(`  verification: ${verificationText(snapshot)}\n`);
  process.stdout.write(`  identity: ed25519 ${identity.publicKeyHex.slice(0, 12)}… — signs your hello + posts (🔑)\n`);
  process.stdout.write('\n');
  process.stdout.write('  • raw usage stays local · only your league + verified flag are shared\n');
  process.stdout.write('  • next: vibenetwork who · vibenetwork post "<text>" · vibenetwork open\n');
  process.stdout.write('\n');
  return 0;
}

async function cmdProfile(bio: string | undefined, links: readonly string[]): Promise<number> {
  if (bio !== undefined || links.length > 0) {
    const updated = updateProfile({
      ...(bio !== undefined ? { bio } : {}),
      ...(links.length > 0 ? { links } : {}),
    });
    if (updated === null) {
      process.stderr.write('Not connected yet. Run `vibenetwork connect` first.\n');
      return 1;
    }
    process.stdout.write('  profile updated\n\n');
  }
  const profile = loadProfile();
  if (!profile) {
    process.stderr.write('Not connected yet. Run `vibenetwork connect` first.\n');
    return 1;
  }
  process.stdout.write('\n');
  process.stdout.write(`  ${profile.handle}  ·  ${profile.league} League ${profile.verified ? '✓' : '~'}\n`);
  process.stdout.write(`  bio: ${profile.bio === '' ? '(none — set with: vibenetwork profile --bio "...")' : profile.bio}\n`);
  for (const l of profile.links) process.stdout.write(`  link: ${l}\n`);
  process.stdout.write(`  pubkey: ${profile.pubkey}\n`);
  process.stdout.write(`  following: ${listFollows().length} · connected ${formatAgo(profile.connectedAt)}\n`);
  process.stdout.write('\n');
  return 0;
}

async function cmdHandle(arg: string | undefined): Promise<number> {
  if (arg === undefined || arg.trim() === '') {
    process.stdout.write(`${resolveHandle()}\n`);
    return 0;
  }
  try {
    const canonical = saveHandle(arg);
    updateProfile({ handle: canonical }); // mirror onto an existing profile
    process.stdout.write(`  handle set → ${canonical}  (saved to ~/.vibenetwork/handle.json)\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function cmdWho(): Promise<number> {
  const profile = requireProfile();
  if (!profile) {
    process.stderr.write('Not connected yet. Run `vibenetwork connect` first.\n');
    return 1;
  }
  if (!canShareLive()) {
    process.stderr.write('Live sharing is off — re-run `vibenetwork connect` to opt in.\n');
    return 1;
  }
  const dir = defaultStateDir();
  const store = createFeedStore(dir);
  const hello = buildHello(profile);
  process.stdout.write('\n');
  process.stdout.write(`  ${LIVE_NOTICE}\n`);
  process.stdout.write(`  ${MARKS_LEGEND}\n`);
  process.stdout.write(`  topic: vibenet:all → ${globalTopic().toString('hex').slice(0, 12)}…\n`);
  process.stdout.write('  online coders (live — Ctrl+C to stop):\n\n');

  const seen = new Set<string>();
  const session = await startPresence({
    hello,
    onLink: (link) => wireFeedSync(link, store),
    onPeer: (peer, isNew) => {
      if (seen.has(peer.handle)) return;
      seen.add(peer.handle);
      const mark = `${usageMark(peer)}${idMark(peer)}`;
      const followed = isFollowed(peer.handle, dir) ? ' · following' : '';
      // AEGIS: the handle is wire data — display-sanitized, never trusted.
      process.stdout.write(
        `  + ${sanitizePeerText(peer.handle)} (${peer.league} · ${peer.harness}) ${mark}${followed}${isNew ? '  ← new' : ''}\n`,
      );
    },
  });

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  process.stdout.write('\n  leaving the swarm…\n');
  await session.close();
  const roster = rosterFromPeers(session.peers.values(), dir);
  process.stdout.write(
    `  ${roster.length} peer${roster.length === 1 ? '' : 's'} seen this session · saved to ~/.vibenetwork/peers.json\n\n`,
  );
  return 0;
}

async function cmdFollow(arg: string | undefined): Promise<number> {
  if (arg === undefined || arg.trim() === '') {
    process.stderr.write('usage: vibenetwork follow <@handle|pubkey>\n');
    return 1;
  }
  try {
    const { changed } = follow(arg);
    process.stdout.write(changed ? `  following ${arg}\n` : `  already following ${arg}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function cmdUnfollow(arg: string | undefined): Promise<number> {
  if (arg === undefined || arg.trim() === '') {
    process.stderr.write('usage: vibenetwork unfollow <@handle|pubkey>\n');
    return 1;
  }
  try {
    const { changed } = unfollow(arg);
    process.stdout.write(changed ? `  unfollowed ${arg}\n` : `  ${arg} was not followed\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function cmdFeed(all: boolean): Promise<number> {
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
    // AEGIS: handle + text are untrusted — sanitized before display.
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

async function cmdPost(text: string | undefined): Promise<number> {
  const profile = requireProfile();
  if (!profile) {
    process.stderr.write('Not connected yet. Run `vibenetwork connect` first.\n');
    return 1;
  }
  if (text === undefined || text.trim() === '') {
    process.stderr.write('usage: vibenetwork post "<text>" (1-500 chars)\n');
    return 1;
  }
  const dir = defaultStateDir();
  const identity = loadOrCreateIdentity(dir);
  let post;
  try {
    post = createPost(identity, text);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const store = createFeedStore(dir);
  store.add(post);

  // Broadcast: join the global swarm, sync feeds on connect, push the new post
  // to every peer that shows up within a short window, then leave.
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
  if (session === null) {
    process.stdout.write('  offline — post stored locally; it syncs on your next session\n');
    return 0;
  }
  const deadline = Date.now() + 8_000;
  while (links.size === 0 && Date.now() < deadline) await sleep(200);
  await sleep(1_000); // let frames flush before leaving
  const delivered = links.size;
  await session.close();
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
async function cmdDm(arg: string | undefined): Promise<number> {
  const profile = requireProfile();
  if (!profile) {
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
  const dir = defaultStateDir();
  const store = createFeedStore(dir);
  const hello = buildHello(profile);
  process.stdout.write('\n');
  process.stdout.write(`  ${LIVE_NOTICE}\n`);
  process.stdout.write(`  looking for ${target} on vibenet:all… (Ctrl+C to give up)\n\n`);

  let current: PeerLink | undefined;
  const session = await startPresence({
    hello,
    onLink: (link) => {
      wireFeedSync(link, store);
      if (!sameHandle(link.hello.handle, target)) return; // not our target — sync only
      current = link;
      link.onMessage((m) => {
        recordDm(target, { direction: 'in', text: m.text, at: m.at }, dir);
        // AEGIS: DM text + handle are untrusted — sanitized before display.
        process.stdout.write(`  <${sanitizePeerText(link.hello.handle)}> ${sanitizePeerText(m.text)}\n`);
      });
      link.onClose(() => {
        if (current === link) {
          current = undefined;
          process.stdout.write('  · peer left — waiting for them to return…\n');
        }
      });
      process.stdout.write(
        `  · connected to ${sanitizePeerText(link.hello.handle)} ${usageMark(link.hello)}${idMark(link.hello)} — type to chat, /quit to leave\n`,
      );
    },
  });

  // Read stdin line by line until /quit / EOF / SIGINT.
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const stop = (): void => rl.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  for await (const line of rl) {
    const text = line.trim();
    if (text === '/quit') break;
    if (text === '') continue;
    if (current === undefined) {
      process.stdout.write(`  · ${target} is not online yet — still waiting…\n`);
      continue;
    }
    try {
      sendDm(current, text, dir);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  process.stdout.write('\n  leaving the swarm…\n');
  await session.close();
  process.stdout.write('\n');
  return 0;
}

async function cmdOpen(port: number | undefined): Promise<number> {
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
      onLink: (link) => bridge!.addLink(link),
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

const HELP = `vibenetwork ${VERSION} — a decentralized social network for AI coders (local-first)

Usage:
  vibenetwork connect           Create your identity + profile (auto-mints a memetic
                                handle if unset; league from local usage, verified
                                iff read from real harness logs)
  vibenetwork profile [--bio "..."] [--link URL]  Show or edit your profile
  vibenetwork handle [@name]    Print or set your handle (a leading '@' is optional)
  vibenetwork who               Live presence roster — online coders on vibenet:all
  vibenetwork follow <@h|pubkey>    Follow a coder (local graph; filters your feed)
  vibenetwork unfollow <@h|pubkey>  Unfollow
  vibenetwork feed [--all]      Your feed: followed coders + you (--all = firehose)
  vibenetwork post "<text>"     Sign + broadcast a post (1-500 chars)
  vibenetwork dm <@handle>      e2e-encrypted DM session with a peer (/quit to leave)
  vibenetwork open [--port N]   Serve the local web app (default: random port)
  vibenetwork mcp               Run the stdio MCP server
  vibenetwork --version
  vibenetwork --help

Trust model:
  Your identity is a persistent ed25519 key (~/.vibenetwork/identity.json, 0600).
  Every hello and every post is signed; receivers verify and DROP anything that
  doesn't check out. Raw token usage never leaves the machine — only the league
  bucket + verified flag. Everyone shares ONE global topic (vibenet:all); your
  follow graph filters what you SEE, not which topic you join.
  ${MARKS_LEGEND}

Env:
  VIBENETWORK_TOKENS=<n>   Self-report a token count (e.g. 23400000 or 12M)
  VIBENETWORK_HARNESS=<h>  Harness id (claude-code, codex, …)
  VIBENETWORK_HANDLE=<@id> Display handle (one-off override; not persisted)
`;

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  switch (parsed.command) {
    case 'version':
      process.stdout.write(`vibenetwork ${VERSION}\n`);
      return 0;
    case 'help':
    case null:
      process.stdout.write(HELP);
      return 0;
    case 'connect':
      return cmdConnect();
    case 'profile':
      return cmdProfile(parsed.bio, parsed.links);
    case 'handle':
      return cmdHandle(parsed.arg);
    case 'who':
      return cmdWho();
    case 'follow':
      return cmdFollow(parsed.arg);
    case 'unfollow':
      return cmdUnfollow(parsed.arg);
    case 'feed':
      return cmdFeed(parsed.all);
    case 'post':
      return cmdPost(parsed.arg);
    case 'dm':
      return cmdDm(parsed.arg);
    case 'open':
      return cmdOpen(parsed.port);
    case 'mcp':
      await runMcp();
      return 0;
  }
}

// Run only when invoked as the entry script (not when imported, e.g. by tests).
// Symlink-safe: the npm bin is a symlink to dist/cli.js, so resolve argv[1]
// through realpathSync before comparing against this module's URL.
const entryUrl = process.argv[1];
if (entryUrl !== undefined) {
  let isMain = false;
  try {
    isMain = import.meta.url === pathToFileURL(realpathSync(entryUrl)).href;
  } catch {
    isMain = false;
  }
  if (isMain) {
    void main(process.argv.slice(2)).then(
      (code) => {
        if (code !== 0) process.exit(code);
      },
      (err) => {
        process.stderr.write(err instanceof Error ? `${err.stack ?? err.message}\n` : `${String(err)}\n`);
        process.exit(1);
      },
    );
  }
}
