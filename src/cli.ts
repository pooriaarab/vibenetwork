#!/usr/bin/env node
/**
 * vibenetwork CLI — a decentralized social network for AI coders (local-first).
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { parseArgs } from './cli-parse.js';
import type { Command, ParsedArgs } from './cli-parse.js';
import { formatAgo } from './cli-helpers.js';
import { cmdConnect, cmdProfile, cmdHandle, cmdWho, cmdFollow, cmdUnfollow } from './cli-cmd-core.js';
import { cmdFeed, cmdPost, cmdDm, cmdOpen } from './cli-cmd-extra.js';
import { runMcp } from './mcp.js';
import { MARKS_LEGEND } from './cli-helpers.js';

const VERSION = '0.1.1';

export type { Command, ParsedArgs };
export { parseArgs, formatAgo };

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

type CommandHandler = (parsed: ParsedArgs) => Promise<number> | number;
interface CommandRoute { readonly command: Command; readonly handler: CommandHandler; }

function handleVersion(): number {
  process.stdout.write(`vibenetwork ${VERSION}\n`);
  return 0;
}

function handleHelp(): number {
  process.stdout.write(HELP);
  return 0;
}

const commandRoutes: readonly CommandRoute[] = [
  { command: 'connect', handler: () => cmdConnect() },
  { command: 'profile', handler: (p) => cmdProfile(p.bio, p.links) },
  { command: 'handle', handler: (p) => cmdHandle(p.arg) },
  { command: 'who', handler: () => cmdWho() },
  { command: 'follow', handler: (p) => cmdFollow(p.arg) },
  { command: 'unfollow', handler: (p) => cmdUnfollow(p.arg) },
  { command: 'feed', handler: (p) => cmdFeed(p.all) },
  { command: 'post', handler: (p) => cmdPost(p.arg) },
  { command: 'dm', handler: (p) => cmdDm(p.arg) },
  { command: 'open', handler: (p) => cmdOpen(p.port) },
  { command: 'mcp', handler: async () => { await runMcp(); return 0; } },
];

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === 'version') return handleVersion();
  if (parsed.command === 'help' || parsed.command === null) return handleHelp();
  const route = commandRoutes.find((r) => r.command === parsed.command);
  if (route !== undefined) return route.handler(parsed);
  return handleHelp();
}

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
      (code) => { if (code !== 0) process.exit(code); },
      (err) => { process.stderr.write(err instanceof Error ? `${err.stack ?? err.message}\n` : `${String(err)}\n`); process.exit(1); },
    );
  }
}
