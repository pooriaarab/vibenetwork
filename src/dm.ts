/**
 * Direct messages — e2e over the per-peer hyperswarm connection.
 *
 * "E2e" in v0 rests on two proven layers, no new crypto:
 *   - TRANSPORT: every hyperswarm peer connection is already encrypted
 *     (noise, per-connection keys) — a DM rides `msg` frames on it and never
 *     touches a relay/server.
 *   - AUTHENTICITY: the hello handshake that precedes every PeerLink is
 *     ed25519-signed; a peer whose hello doesn't verify against its claimed
 *     pubkey is dropped before a link ever exists. So the handle on the other
 *     end of a DM thread IS the holder of that identity key.
 *
 * Threads persist locally (~/.vibenetwork/dms.json), bounded per thread.
 * DM text is UNTRUSTED display data (AEGIS): never executed, sanitized before
 * display by every surface that shows it (untrusted.ts).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_TEXT_LEN } from './frame.js';
import type { PeerLink } from './link.js';
import { defaultStateDir, normalizeHandle } from './state.js';

/** Max retained messages per thread (oldest drop first). */
export const MAX_DM_THREAD = 200;
/** Max retained threads (oldest-activity last; beyond it, oldest threads drop). */
export const MAX_DM_THREADS = 100;

/** One DM in a thread. `direction` is from OUR point of view. */
export interface DmMessage {
  readonly id: string;
  /** 'out' = we sent it, 'in' = the peer sent it. */
  readonly direction: 'in' | 'out';
  /** Message text (peer text is sanitized at display time, not on storage). */
  readonly text: string;
  /** ms epoch. */
  readonly at: number;
}

const DMS_FILE = 'dms.json';

function dmsPath(dir: string): string {
  return path.join(dir, DMS_FILE);
}

type Threads = Record<string, DmMessage[]>;

function loadThreads(dir: string): Threads {
  try {
    const raw = readFileSync(dmsPath(dir), 'utf8');
    const data = JSON.parse(raw) as { threads?: unknown };
    if (typeof data.threads !== 'object' || data.threads === null) return {};
    const out: Threads = {};
    for (const [handle, msgs] of Object.entries(data.threads as Record<string, unknown>)) {
      const canonical = normalizeHandle(handle);
      if (canonical === null || !Array.isArray(msgs)) continue;
      out[canonical] = msgs.filter(
        (m): m is DmMessage =>
          typeof m === 'object' &&
          m !== null &&
          typeof (m as Record<string, unknown>)['id'] === 'string' &&
          ((m as Record<string, unknown>)['direction'] === 'in' ||
            (m as Record<string, unknown>)['direction'] === 'out') &&
          typeof (m as Record<string, unknown>)['text'] === 'string' &&
          typeof (m as Record<string, unknown>)['at'] === 'number',
      );
    }
    return out;
  } catch {
    return {};
  }
}

function persist(threads: Threads, dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(dmsPath(dir), JSON.stringify({ threads }, null, 2) + '\n', 'utf8');
}

/**
 * Record one message in the thread with `peerHandle` (canonicalized).
 * Returns the stored message, or `null` for an invalid peer handle. Bounded:
 * a thread never exceeds {@link MAX_DM_THREAD}; the thread map never exceeds
 * {@link MAX_DM_THREADS} (least-recently-active thread drops first).
 */
export function recordDm(
  peerHandle: string,
  msg: { direction: 'in' | 'out'; text: string; at?: number },
  dir: string = defaultStateDir(),
): DmMessage | null {
  const canonical = normalizeHandle(peerHandle);
  if (canonical === null) return null;
  const threads = loadThreads(dir);
  const message: DmMessage = {
    id: randomUUID(),
    direction: msg.direction,
    text: msg.text.slice(0, MAX_TEXT_LEN),
    at: msg.at ?? Date.now(),
  };
  const thread = [...(threads[canonical] ?? []), message].slice(-MAX_DM_THREAD);
  // Refresh recency by re-inserting the key at the end.
  delete threads[canonical];
  threads[canonical] = thread;
  const keys = Object.keys(threads);
  if (keys.length > MAX_DM_THREADS) {
    for (const k of keys.slice(0, keys.length - MAX_DM_THREADS)) delete threads[k];
  }
  persist(threads, dir);
  return message;
}

/** Load the thread with `peerHandle` (oldest → newest), or `[]`. */
export function loadThread(peerHandle: string, dir: string = defaultStateDir()): DmMessage[] {
  const canonical = normalizeHandle(peerHandle);
  if (canonical === null) return [];
  return loadThreads(dir)[canonical] ?? [];
}

/** The handles you have threads with (most-recently-active last). */
export function threadPeers(dir: string = defaultStateDir()): string[] {
  return Object.keys(loadThreads(dir));
}

/**
 * Send a DM over an open {@link PeerLink} (a `msg` frame) AND record it in the
 * local thread as 'out'. Throws on empty/oversized text so junk never hits the
 * wire. Returns the stored message.
 */
export function sendDm(
  link: PeerLink,
  text: string,
  dir: string = defaultStateDir(),
): DmMessage {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LEN) {
    throw new Error(`dm text must be 1-${MAX_TEXT_LEN} chars`);
  }
  link.send(text);
  const stored = recordDm(link.hello.handle, { direction: 'out', text }, dir);
  if (stored === null) throw new Error(`invalid peer handle on link: ${link.hello.handle}`);
  return stored;
}
