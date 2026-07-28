/**
 * Zero-friction handle assignment — first `connect` mints a memetic dev-flavored
 * username so nobody ever ships as the bare default `@you`.
 *
 * Everything here is LOCAL: curated word lists + a random pick (CSPRNG by
 * default, injectable for tests). No network call, no AI call. Generated
 * handles always satisfy {@link normalizeHandle} (lowercase `[a-z0-9_]`, well
 * under {@link MAX_HANDLE_LEN}) and are persisted via {@link saveHandle} — the
 * user can change it anytime with `vibenetwork handle @name`.
 */
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_HANDLE,
  MAX_HANDLE_LEN,
  defaultStateDir,
  loadHandle,
  normalizeHandle,
  saveHandle,
} from './state.js';

/** First word — dev-flavored nouns/adjectives (lowercase, [a-z0-9] only). */
const FIRST: readonly string[] = [
  'segfault', 'yak', 'vibe', 'null', 'async', 'await', 'heap', 'stack',
  'sudo', 'regex', 'token', 'prompt', 'context', 'merge', 'rebase', 'hotfix',
  'flaky', 'cursed', 'based', 'quantum', 'turbo', 'neural', 'agentic', 'kernel',
  'docker', 'kube', 'lambda', 'pointer', 'buffer', 'packet', 'syscall', 'runtime',
  'monad', 'borrow', 'cache', 'deadlock', 'localhost', 'darkmode', 'wasm', 'diff',
];

/** Second word — the persona (lowercase, [a-z0-9] only). */
const SECOND: readonly string[] = [
  'sommelier', 'shaver', 'goblin', 'nomad', 'gremlin', 'wizard', 'bard', 'pirate',
  'ninja', 'monk', 'prophet', 'oracle', 'smith', 'farmer', 'whisperer', 'tamer',
  'connoisseur', 'maximalist', 'enjoyer', 'dealer', 'herder', 'wrangler', 'juggler',
  'mechanic', 'surgeon', 'detective', 'librarian', 'alchemist', 'overlord',
  'apprentice', 'sensei', 'chef', 'dj', 'ranger', 'paladin', 'barbarian',
  'summoner', 'cartographer', 'archivist', 'plumber',
];

/** Optional trailing flourish, appended ~half the time when it fits. */
const SUFFIX: readonly string[] = [
  'prime', '9000', '3000', 'max', 'ultra', 'xl', 'mk2', '777', '404', '1337',
  '2077', 'xd',
];

/** Default randomness: local CSPRNG — deterministic-looking, never a network/AI call. */
function cryptoRand(): number {
  return randomBytes(4).readUInt32BE(0) / 2 ** 32;
}

function pick<T>(list: readonly T[], rand: () => number): T {
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))]!;
}

/**
 * Mint a candidate handle (`@first_second`, ~50% with a `_suffix`). Guaranteed
 * to pass {@link normalizeHandle}: the word lists are `[a-z0-9]`-only and the
 * canonical form is capped at {@link MAX_HANDLE_LEN} (the suffix is dropped
 * rather than overflowing). `rand` is injectable so tests are deterministic.
 */
export function generateHandle(rand: () => number = cryptoRand): string {
  const first = pick(FIRST, rand);
  const second = pick(SECOND, rand);
  let body = `${first}_${second}`;
  if (rand() < 0.5) {
    const withSuffix = `${body}_${pick(SUFFIX, rand)}`;
    if (withSuffix.length + 1 <= MAX_HANDLE_LEN) body = withSuffix;
  }
  const canonical = normalizeHandle(body);
  // Unreachable given the curated lists + length guard above — but a generator
  // must never emit something the validator would reject, so fail loudly if
  // the lists are ever edited into an invalid shape.
  if (canonical === null) throw new Error(`handle generator produced an invalid handle: ${body}`);
  return canonical;
}

/** Outcome of {@link ensureHandle}: the effective handle + whether it was just minted. */
export interface EnsuredHandle {
  readonly handle: string;
  /** True when a new handle was generated and persisted by this call. */
  readonly generated: boolean;
}

/**
 * Resolve the handle for a first-run flow, auto-assigning when unset:
 *   1. a valid `VIBENETWORK_HANDLE` env wins as a ONE-OFF (never persisted);
 *   2. a persisted (non-default) handle is reused;
 *   3. otherwise a memetic handle is generated and PERSISTED — the bare
 *      default `@you` is never silently kept.
 */
export function ensureHandle(dir: string = defaultStateDir()): EnsuredHandle {
  const env = process.env['VIBENETWORK_HANDLE'];
  if (env !== undefined && env.trim() !== '') {
    const canonical = normalizeHandle(env);
    if (canonical !== null) return { handle: canonical, generated: false };
  }
  const persisted = loadHandle(dir);
  if (persisted !== DEFAULT_HANDLE) return { handle: persisted, generated: false };
  const generated = generateHandle();
  return { handle: saveHandle(generated, dir), generated: true };
}
