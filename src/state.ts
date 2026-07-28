/**
 * Local profile state — the only thing persisted on disk.
 *
 * The league bucket is "shared" (with the local demo pool); the raw `totalTokens`
 * is stored only so the local web app can show it to the user behind an opt-in
 * toggle. It NEVER leaves this machine in v0 (no central directory).
 *
 * Consent for sharing the league is modeled with vibe-core's `createConsentLedger`
 * (scope {@link CONSENT_SCOPE}); it is granted on `connect` and revocable on
 * reset. Backed by a tiny JSON file next to the profile so it survives restarts.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConsentLedger } from '@pooriaarab/vibe-core';
import type { ConsentGrant, ConsentLedger, ConsentStore, UsageSnapshot } from '@pooriaarab/vibe-core';
import { league } from './index.js';

/** Consent scope covering "share my league bucket". Raw usage is never in scope. */
export const CONSENT_SCOPE = 'share:league';

/**
 * Consent scope covering live P2P discovery: joining the public DHT on your
 * league topic and exchanging { handle, league, harness, verified flag,
 * identity pubkey } with same-league peers. Raw usage is never in scope.
 * Opt-in only (default OFF) — granted by `vibedating discover --live`, never
 * implicitly.
 */
export const LIVE_CONSENT_SCOPE = 'share:live';

/** The persisted profile. `totalTokens` is LOCAL ONLY. */
export interface ProfileState {
  readonly handle: string;
  readonly harness: string;
  readonly league: string;
  readonly leagueMin: number;
  /** LOCAL ONLY — never shared off-machine. Kept so the local UI can show it. */
  readonly totalTokens: number;
  readonly verified: boolean;
  readonly connectedAt: string;
}

/** Default directory for vibedating's local state: `~/.vibedating`. */
export function defaultStateDir(): string {
  return path.join(os.homedir(), '.vibedating');
}

/** A file-backed {@link ConsentStore}; survives across CLI/server/MCP processes. */
class FileConsentStore implements ConsentStore {
  constructor(private readonly file: string) {}

  load(): ConsentGrant[] {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw) as { grants?: ConsentGrant[] };
      return data.grants ?? [];
    } catch {
      return [];
    }
  }

  save(grants: ConsentGrant[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ grants }, null, 2) + '\n', 'utf8');
  }
}

/** Build a consent ledger backed by `<dir>/consent.json`. */
export function createLedger(dir: string = defaultStateDir()): ConsentLedger {
  return createConsentLedger(new FileConsentStore(path.join(dir, 'consent.json')));
}

function profilePath(dir: string): string {
  return path.join(dir, 'state.json');
}

/**
 * Read usage → bucket into a league → grant share consent → persist the profile.
 * Returns the resulting {@link ProfileState}. Idempotent: re-connecting refreshes
 * the snapshot and re-grants consent.
 */
export function connectProfile(
  snapshot: UsageSnapshot,
  handle: string,
  dir: string = defaultStateDir(),
): ProfileState {
  const lg = league(snapshot.totalTokens);
  createLedger(dir).grant(CONSENT_SCOPE, 'connect: league bucket only; raw usage stays local');
  const state: ProfileState = {
    handle,
    harness: snapshot.harness,
    league: lg.name,
    leagueMin: lg.min,
    totalTokens: snapshot.totalTokens,
    verified: snapshot.verified,
    connectedAt: new Date().toISOString(),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(profilePath(dir), JSON.stringify(state, null, 2) + '\n', 'utf8');
  return state;
}

/** Load the persisted profile, or `null` if never connected. */
export function loadProfile(dir: string = defaultStateDir()): ProfileState | null {
  try {
    const raw = readFileSync(profilePath(dir), 'utf8');
    return JSON.parse(raw) as ProfileState;
  } catch {
    return null;
  }
}

/** Whether the user has consented to share their league bucket. */
export function canShareLeague(dir: string = defaultStateDir()): boolean {
  return createLedger(dir).allows(CONSENT_SCOPE);
}

/** Grant (idempotently) consent for live P2P discovery — the explicit opt-in. */
export function grantLiveConsent(dir: string = defaultStateDir()): void {
  createLedger(dir).grant(
    LIVE_CONSENT_SCOPE,
    'discover --live: share handle+league+harness+verified flag+identity pubkey (never raw usage) with same-league peers on the public DHT',
  );
}

/** Whether the user has opted in to live P2P discovery. Default OFF. */
export function canShareLive(dir: string = defaultStateDir()): boolean {
  return createLedger(dir).allows(LIVE_CONSENT_SCOPE);
}

/** Forget the profile, revoke all share consent, and drop the live peer book. */
export function resetProfile(dir: string = defaultStateDir()): void {
  const ledger = createLedger(dir);
  ledger.revoke(CONSENT_SCOPE);
  ledger.revoke(LIVE_CONSENT_SCOPE);
  try {
    rmSync(profilePath(dir), { force: true });
    rmSync(path.join(dir, 'peers.json'), { force: true });
  } catch {
    /* already gone */
  }
}

/* -------------------------------------------------------------------------- */
/* Persistent handle                                                          */
/* -------------------------------------------------------------------------- */

/** File under the state dir holding the chosen handle, independent of the
 *  profile so `vibedate handle @name` works before `connect`. */
const HANDLE_FILE = 'handle.json';

/** Default handle when none is persisted and no env override is set. */
export const DEFAULT_HANDLE = '@you';

/** Maximum length of a handle's canonical form (including its single '@'). */
export const MAX_HANDLE_LEN = 32;

function handleFilePath(dir: string): string {
  return path.join(dir, HANDLE_FILE);
}

/** A leading '@' is optional — `alice` and `@alice` are the same handle. */
function stripLeadingAt(handle: string): string {
  return handle.replace(/^@+/, '');
}
/** Two handles identify the same peer once leading '@'s are stripped. */
export function sameHandle(a: string, b: string): boolean {
  return stripLeadingAt(a) === stripLeadingAt(b);
}

/**
 * Normalize a handle to its canonical form: trimmed, exactly one leading '@'.
 * Returns `null` for anything invalid — empty after trim, a bare '@', longer
 * than {@link MAX_HANDLE_LEN} (canonical form), or containing whitespace / C0
 * control bytes in the body. Pure.
 *
 * A leading '@' is optional in the input: `alice` and `@alice` both canonicalize
 * to `@alice`, so {@link isBlocked} and `find` comparisons are robust to either
 * spelling a peer (or the user) uses.
 */
export function normalizeHandle(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const body = stripLeadingAt(trimmed);
  if (body.length === 0) return null; // a bare '@' (or '@@…') is not a handle
  if (/\s/.test(body) || /[\x00-\x1f\x7f]/.test(body)) return null;
  const canonical = '@' + body;
  if (canonical.length > MAX_HANDLE_LEN) return null;
  return canonical;
}

/** Load the persisted handle, or {@link DEFAULT_HANDLE} if none/corrupt. */
export function loadHandle(dir: string = defaultStateDir()): string {
  try {
    const raw = readFileSync(handleFilePath(dir), 'utf8');
    const data = JSON.parse(raw) as { handle?: unknown };
    if (typeof data['handle'] !== 'string') return DEFAULT_HANDLE;
    return normalizeHandle(data['handle']) ?? DEFAULT_HANDLE;
  } catch {
    return DEFAULT_HANDLE;
  }
}

/**
 * Validate + persist a handle to `<dir>/handle.json`, and (if a profile already
 * exists) mirror it onto the profile so `matches`/`discover`/`live` reflect it
 * without a reconnect. Returns the canonical handle; throws on invalid input.
 */
export function saveHandle(handle: string, dir: string = defaultStateDir()): string {
  const canonical = normalizeHandle(handle);
  if (canonical === null) {
    throw new Error(
      `invalid handle: use 1-${MAX_HANDLE_LEN} chars (optional leading '@'), no whitespace`,
    );
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(handleFilePath(dir), JSON.stringify({ handle: canonical }, null, 2) + '\n', 'utf8');
  // Mirror onto an existing profile so live commands see the new handle at once.
  const existing = loadProfile(dir);
  if (existing !== null) {
    writeFileSync(
      profilePath(dir),
      JSON.stringify({ ...existing, handle: canonical }, null, 2) + '\n',
      'utf8',
    );
  }
  return canonical;
}

/**
 * Resolve the effective handle for THIS invocation: an env override
 * (`VIBEDATING_HANDLE`) wins as a ONE-OFF (it is never persisted), then the
 * persisted handle, then {@link DEFAULT_HANDLE}. An invalid env value is
 * ignored (falls through to the persisted/default handle).
 */
export function resolveHandle(dir: string = defaultStateDir()): string {
  const env = process.env['VIBEDATING_HANDLE'];
  if (env !== undefined && env.trim() !== '') {
    const canonical = normalizeHandle(env);
    if (canonical !== null) return canonical;
  }
  return loadHandle(dir);
}

/* -------------------------------------------------------------------------- */
/* Blocklist                                                                  */
/* -------------------------------------------------------------------------- */

/** File under the state dir holding the blocklist (canonical '@'-prefixed). */
const BLOCKLIST_FILE = 'blocklist.json';

function blocklistPath(dir: string): string {
  return path.join(dir, BLOCKLIST_FILE);
}

function persistBlocklist(blocked: readonly string[], dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(blocklistPath(dir), JSON.stringify({ blocked }, null, 2) + '\n', 'utf8');
}

/** Load the persisted blocklist (canonical '@'-prefixed handles), or `[]`. */
export function loadBlocklist(dir: string = defaultStateDir()): string[] {
  try {
    const raw = readFileSync(blocklistPath(dir), 'utf8');
    const data = JSON.parse(raw) as { blocked?: unknown };
    if (!Array.isArray(data['blocked'])) return [];
    return data['blocked'].filter((h): h is string => typeof h === 'string');
  } catch {
    return [];
  }
}

/**
 * Whether `handle` is on the blocklist. Lenient: never throws, and compares
 * with a leading '@' stripped on both sides so `@x` and `x` match. An empty
 * handle is never blocked. Backed by {@link loadBlocklist}.
 */
export function isBlocked(handle: string, dir: string = defaultStateDir()): boolean {
  const want = stripLeadingAt(handle);
  if (want === '') return false;
  return loadBlocklist(dir).some((entry) => stripLeadingAt(entry) === want);
}

/** Result of {@link addBlock} / {@link removeBlock}: the new list + a flag. */
export interface BlocklistChange {
  readonly blocked: string[];
  /** `true` when this call actually changed the list (not already present/absent). */
  readonly changed: boolean;
}

/**
 * Validate + add a handle to the blocklist (idempotent). Returns the new list
 * and whether this call actually added it. Throws on an invalid handle.
 */
export function addBlock(
  handle: string,
  dir: string = defaultStateDir(),
): BlocklistChange {
  const canonical = normalizeHandle(handle);
  if (canonical === null) {
    throw new Error(
      `invalid handle: use 1-${MAX_HANDLE_LEN} chars (optional leading '@'), no whitespace`,
    );
  }
  const list = loadBlocklist(dir);
  if (list.some((e) => sameHandle(e, canonical))) return { blocked: list, changed: false };
  const blocked = [...list, canonical];
  persistBlocklist(blocked, dir);
  return { blocked, changed: true };
}

/**
 * Remove a handle from the blocklist (idempotent). Returns the new list and
 * whether this call actually removed it. Throws on an invalid handle.
 */
export function removeBlock(
  handle: string,
  dir: string = defaultStateDir(),
): BlocklistChange {
  const canonical = normalizeHandle(handle);
  if (canonical === null) {
    throw new Error(
      `invalid handle: use 1-${MAX_HANDLE_LEN} chars (optional leading '@'), no whitespace`,
    );
  }
  const list = loadBlocklist(dir);
  const blocked = list.filter((e) => !sameHandle(e, canonical));
  if (blocked.length === list.length) return { blocked: list, changed: false };
  persistBlocklist(blocked, dir);
  return { blocked, changed: true };
}
