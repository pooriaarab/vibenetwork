/**
 * The local profile: create / load / persist under `~/.vibenetwork`.
 *
 * A profile binds three things:
 *   - the persistent ed25519 identity (identity.ts — `pubkey` IS the profile),
 *   - a display handle + bio + links (local, user-editable),
 *   - the usage LEAGUE derived from vibe-core's `readHarnessUsage` — raw token
 *     counts are read locally, bucketed, and then discarded; only the league
 *     name + the verified flag (true iff source === 'real') are kept. Raw
 *     usage is never persisted and never goes on the wire.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readHarnessUsage } from '@pooriaarab/vibe-core';
import type {
  Harness,
  HarnessUsageOptions,
  UsageSnapshot,
  UsageSource,
} from '@pooriaarab/vibe-core';
import { loadOrCreateIdentity } from './identity.js';
import type { Profile } from './index.js';
import { defaultStateDir, grantLiveConsent, normalizeHandle, saveHandle } from './state.js';

/* -------------------------------------------------------------------------- */
/* Leagues (usage volume buckets)                                             */
/* -------------------------------------------------------------------------- */

/**
 * A usage league (volume bucket). `max` is inclusive; the top tier is open-ended
 * (Number.POSITIVE_INFINITY).
 */
export interface League {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

/** The five real leagues, in ascending order. */
export const LEAGUES: readonly League[] = [
  { name: '1M', min: 1_000_000, max: 4_999_999 },
  { name: '5M', min: 5_000_000, max: 9_999_999 },
  { name: '10M', min: 10_000_000, max: 99_999_999 },
  { name: '100M', min: 100_000_000, max: 999_999_999 },
  { name: '1B+', min: 1_000_000_000, max: Number.POSITIVE_INFINITY },
];

/** League name for accounts that haven't crossed the first threshold yet. */
export const BELOW_LEAGUE = 'below-1M';

/**
 * Bucket a lifetime token count into a league. Pure: same input → same output.
 * Returns `{ name, min }`; counts below 1M land in {@link BELOW_LEAGUE} with
 * `min: 0`. Negatives clamp to 0; non-integers are floored.
 */
export function league(totalTokens: number): { name: string; min: number } {
  const n = Math.max(0, Math.floor(totalTokens));
  for (const l of LEAGUES) {
    if (n >= l.min && n <= l.max) {
      return { name: l.name, min: l.min };
    }
  }
  return { name: BELOW_LEAGUE, min: 0 };
}

/* -------------------------------------------------------------------------- */
/* Usage reading (local only — raw totals never leave the machine)            */
/* -------------------------------------------------------------------------- */

/** Env var that holds a self-reported total token count (e.g. `23400000`). */
export const TOKENS_ENV = 'VIBENETWORK_TOKENS';

/** Demo total used when there is no real read and no env value (10M league). */
export const DEMO_TOTAL_TOKENS = 23_400_000;

const MS_PER_DAY = 86_400_000;

/**
 * A usage snapshot with honest provenance. `source` says where `totalTokens`
 * came from; `verified` is true ONLY for `source === 'real'` (measured from
 * the harness's own local session logs). The token total is the one thing that
 * must never leave the machine; everything downstream consumes only the league
 * bucket plus the verified flag.
 */
export interface LocalUsageSnapshot extends UsageSnapshot {
  /** Where the total came from: measured locally, self-reported, or demo. */
  readonly source: UsageSource;
  /** Short human-facing provenance note from the reader (local display only). */
  readonly detail?: string;
}

/**
 * Usage reader, backed by vibe-core's {@link readHarnessUsage}. Resolution order:
 *
 *   1. a self-reported value — explicit `opts.selfReportTokens`, or the
 *      {@link TOKENS_ENV} env var (suffix-friendly: `12M`, `1.2B`), or vibe-core's
 *      own `VIBE_TOKENS` env → `source: 'self-report'` → `verified: false`.
 *   2. the harness's REAL local session logs (claude-code / codex / gemini / pi /
 *      kimi), read from disk by vibe-core → `source: 'real'` → `verified: true`.
 *   3. the demo value {@link DEMO_TOTAL_TOKENS} → `source: 'demo'` →
 *      `verified: false`.
 */
export async function readUsage(
  harness: Harness = 'claude-code',
  opts: HarnessUsageOptions = {},
): Promise<LocalUsageSnapshot> {
  const merged: HarnessUsageOptions = { ...opts };
  if (merged.selfReportTokens === undefined) {
    const injected = parseTokensEnv(process.env[TOKENS_ENV]);
    if (injected !== undefined) merged.selfReportTokens = injected;
  }
  const result = await readHarnessUsage(harness, merged);
  const now = new Date();
  return {
    harness,
    totalTokens: result.source === 'demo' ? DEMO_TOTAL_TOKENS : result.totalTokens,
    verified: result.source === 'real',
    source: result.source,
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
    windowStart: new Date(now.getTime() - 30 * MS_PER_DAY).toISOString(),
    windowEnd: now.toISOString(),
  };
}

const TOKEN_MULT: Record<string, number> = {
  '': 1,
  k: 1e3,
  K: 1e3,
  m: 1e6,
  M: 1e6,
  b: 1e9,
  B: 1e9,
};

/**
 * Parse a self-reported token count: a plain integer (`23400000`), or a suffixed
 * value (`12M`, `1.2B`, `500k`, `500K`). Returns `undefined` for anything that is
 * not a non-negative finite number, so callers can fall through to a default.
 */
export function parseTokensEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const match = /^([0-9]*\.?[0-9]+)\s*([kKmMbB]?)$/.exec(trimmed);
  if (!match) return undefined;
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num < 0) return undefined;
  const mult = TOKEN_MULT[match[2] ?? ''] ?? 1;
  return Math.floor(num * mult);
}

/* -------------------------------------------------------------------------- */
/* Profile persistence (~/.vibenetwork/profile.json)                          */
/* -------------------------------------------------------------------------- */

/** Bio cap (chars), enforced on create/update. */
export const MAX_BIO_LEN = 160;
/** Max number of links on a profile. */
export const MAX_LINKS = 8;
/** Per-link cap (chars). */
export const MAX_LINK_LEN = 200;

const PROFILE_FILE = 'profile.json';

function profilePath(dir: string): string {
  return path.join(dir, PROFILE_FILE);
}

/** Strip C0/C1 control chars (a bio is display data everywhere it appears). */
function stripControls(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/** Clean a bio to its storable shape: controls stripped, single line-ish, capped. */
export function cleanBio(bio: string): string {
  return stripControls(bio).replace(/\s*\n\s*/g, ' ').trim().slice(0, MAX_BIO_LEN);
}

/** Clean a links array: strings only, trimmed, control-free, capped per link + count. */
export function cleanLinks(links: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const l of links) {
    if (typeof l !== 'string') continue;
    const cleaned = stripControls(l).trim().slice(0, MAX_LINK_LEN);
    if (cleaned === '' || /\s/.test(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** Options for {@link createProfile}. */
export interface CreateProfileOptions {
  /** Canonical or bare handle ('alice' → '@alice'). Must be valid. */
  readonly handle: string;
  readonly bio?: string;
  readonly links?: readonly string[];
  /** Harness to read usage from (default 'claude-code'). */
  readonly harness?: Harness;
  /** State dir override (tests). Defaults to ~/.vibenetwork. */
  readonly dir?: string;
  /** Injected usage reader (tests). Defaults to {@link readUsage}. */
  readonly usageReader?: (harness: Harness) => Promise<LocalUsageSnapshot>;
}

/**
 * Create + persist the profile: ensure the ed25519 identity, read usage →
 * league bucket, grant live consent, write profile.json. Idempotent in the
 * identity (reused across runs); re-connecting refreshes the league. The raw
 * token total is used for the bucket and then discarded — never persisted.
 */
export async function createProfile(opts: CreateProfileOptions): Promise<Profile> {
  const dir = opts.dir ?? defaultStateDir();
  const handle = normalizeHandle(opts.handle);
  if (handle === null) throw new Error(`invalid handle: ${opts.handle}`);
  const harness = opts.harness ?? 'claude-code';
  const reader = opts.usageReader ?? ((h: Harness) => readUsage(h));
  const snapshot = await reader(harness);
  const identity = loadOrCreateIdentity(dir);
  const lg = league(snapshot.totalTokens);
  const profile: Profile = {
    handle,
    pubkey: identity.publicKeyHex,
    bio: cleanBio(opts.bio ?? ''),
    league: lg.name,
    verified: snapshot.verified,
    links: cleanLinks(opts.links ?? []),
    connectedAt: new Date().toISOString(),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(profilePath(dir), JSON.stringify(profile, null, 2) + '\n', 'utf8');
  // Connecting IS joining the network: persist the handle + the live consent
  // (handle+league+harness+verified flag+pubkey on the wire — never raw usage).
  saveHandle(handle, dir);
  grantLiveConsent(dir);
  return profile;
}

/** Shape-guard for a persisted profile (lenient: fills sane defaults). */
function toProfile(data: unknown): Profile | null {
  if (typeof data !== 'object' || data === null) return null;
  const r = data as Record<string, unknown>;
  const handle = typeof r['handle'] === 'string' ? normalizeHandle(r['handle']) : null;
  const pubkey = r['pubkey'];
  if (handle === null) return null;
  if (typeof pubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(pubkey)) return null;
  return {
    handle,
    pubkey: pubkey.toLowerCase(),
    bio: typeof r['bio'] === 'string' ? cleanBio(r['bio']) : '',
    league: typeof r['league'] === 'string' && r['league'].length > 0 ? r['league'] : BELOW_LEAGUE,
    verified: r['verified'] === true,
    links: Array.isArray(r['links']) ? cleanLinks(r['links']) : [],
    connectedAt:
      typeof r['connectedAt'] === 'string' ? r['connectedAt'] : new Date(0).toISOString(),
  };
}

/** Load the persisted profile, or `null` if never connected / corrupt. */
export function loadProfile(dir: string = defaultStateDir()): Profile | null {
  try {
    const raw = readFileSync(profilePath(dir), 'utf8');
    return toProfile(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Update editable profile fields (bio / links / handle) and persist. The
 * identity fields (pubkey, league, verified) are NOT editable here — league
 * refreshes happen via {@link createProfile}. Returns the updated profile, or
 * `null` when no profile exists yet.
 */
export function updateProfile(
  patch: { bio?: string; links?: readonly string[]; handle?: string },
  dir: string = defaultStateDir(),
): Profile | null {
  const existing = loadProfile(dir);
  if (existing === null) return null;
  let handle = existing.handle;
  if (patch.handle !== undefined) {
    const canonical = normalizeHandle(patch.handle);
    if (canonical === null) throw new Error(`invalid handle: ${patch.handle}`);
    handle = canonical;
    saveHandle(canonical, dir);
  }
  const next: Profile = {
    ...existing,
    handle,
    ...(patch.bio !== undefined ? { bio: cleanBio(patch.bio) } : {}),
    ...(patch.links !== undefined ? { links: cleanLinks(patch.links) } : {}),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(profilePath(dir), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}
