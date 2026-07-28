/**
 * Local state plumbing — state dir, consent ledger, handle, blocklist.
 *
 * The profile itself lives in profile.ts; this module owns everything ELSE
 * persisted under `~/.vibenetwork`: the live-discovery consent grant, the
 * persistent handle, and the blocklist. Raw token usage is never stored here
 * and never shared; only the derived league bucket + verified flag travel.
 *
 * Consent for live P2P discovery is modeled with vibe-core's
 * `createConsentLedger` (scope {@link LIVE_CONSENT_SCOPE}); it is granted on
 * `connect` (creating a profile IS joining the network) and backed by a tiny
 * JSON file so it survives restarts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConsentLedger } from '@pooriaarab/vibe-core';
import type { ConsentGrant, ConsentLedger, ConsentStore } from '@pooriaarab/vibe-core';

/**
 * Consent scope covering live P2P discovery: joining the public DHT on the
 * global `vibenet:all` topic and exchanging { handle, league, harness,
 * verified flag, identity pubkey } with peers, plus signed posts and DMs.
 * Raw usage is never in scope. Granted by `vibenetwork connect`.
 */
export const LIVE_CONSENT_SCOPE = 'share:live';

/** Default directory for vibenetwork's local state: `~/.vibenetwork`. */
export function defaultStateDir(): string {
  return path.join(os.homedir(), '.vibenetwork');
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

/** Grant (idempotently) consent for live P2P discovery — the connect-time opt-in. */
export function grantLiveConsent(dir: string = defaultStateDir()): void {
  createLedger(dir).grant(
    LIVE_CONSENT_SCOPE,
    'connect: share handle+league+harness+verified flag+identity pubkey + signed posts (never raw usage) with peers on the public DHT',
  );
}

/** Whether the user has opted in to live P2P discovery (via `connect`). */
export function canShareLive(dir: string = defaultStateDir()): boolean {
  return createLedger(dir).allows(LIVE_CONSENT_SCOPE);
}

/* -------------------------------------------------------------------------- */
/* Persistent handle                                                          */
/* -------------------------------------------------------------------------- */

/** File under the state dir holding the chosen handle, independent of the
 *  profile so the handle can be set before `connect`. */
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
 * Validate + persist a handle to `<dir>/handle.json`. Returns the canonical
 * handle; throws on invalid input. (profile.ts mirrors it onto an existing
 * profile — kept out of here to avoid a circular import.)
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
  return canonical;
}

/**
 * Resolve the effective handle for THIS invocation: an env override
 * (`VIBENETWORK_HANDLE`) wins as a ONE-OFF (it is never persisted), then the
 * persisted handle, then {@link DEFAULT_HANDLE}. An invalid env value is
 * ignored (falls through to the persisted/default handle).
 */
export function resolveHandle(dir: string = defaultStateDir()): string {
  const env = process.env['VIBENETWORK_HANDLE'];
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
