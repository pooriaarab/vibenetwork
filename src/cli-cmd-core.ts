import process from 'node:process';
import type { Harness } from '@pooriaarab/vibe-core';
import { loadOrCreateIdentity } from './identity.js';
import { createFeedStore } from './feed.js';
import { follow, isFollowed, unfollow, listFollows } from './follow.js';
import { ensureHandle } from './handlegen.js';
import { startPresence, globalTopic, rosterFromPeers } from './presence.js';
import { createProfile, loadProfile, readUsage, updateProfile } from './profile.js';
import { canShareLive, defaultStateDir, loadHandle, normalizeHandle, resolveHandle, sameHandle, saveHandle } from './state.js';
import { sanitizePeerText } from '@pooriaarab/vibe-core/untrusted';
import { LIVE_NOTICE, loadPeers } from './p2p.js';
import { buildHello, verificationText, formatAgo, usageMark, idMark, requireProfile, sleep, wireFeedSync, VERSION, MARKS_LEGEND } from './cli-helpers.js';
export async function cmdConnect(): Promise<number> {
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

export async function cmdProfile(bio: string | undefined, links: readonly string[]): Promise<number> {
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

export async function cmdHandle(arg: string | undefined): Promise<number> {
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

export async function cmdWho(): Promise<number> {
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
      // input-safety: the handle is wire data — display-sanitized, never trusted.
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

export async function cmdFollow(arg: string | undefined): Promise<number> {
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

export async function cmdUnfollow(arg: string | undefined): Promise<number> {
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

