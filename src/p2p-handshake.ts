import { topicFor } from '@pooriaarab/vibe-core/ids';

export const TOPIC_PREFIX = 'vibenet:';

export function leagueTopic(leagueName: string): Buffer {
  return topicFor(TOPIC_PREFIX, leagueName);
}

export interface PeerHello {
  readonly handle: string;
  readonly league: string;
  readonly harness: string;
  readonly verified?: boolean;
  readonly pubkey?: string;
  readonly nonce?: string;
  readonly sig?: string;
  readonly identityVerified?: boolean;
}

export const LIVE_NOTICE =
  'live discovery: sharing only your handle + league + harness + verified flag + identity pubkey (never raw usage) with same-league peers on the public DHT';

const MAX_HANDLE_LEN = 64;
const MAX_LEAGUE_LEN = 32;
const MAX_HARNESS_LEN = 64;
const MAX_HANDSHAKE_LEN = 4096;

export function serializeHandshake(hello: PeerHello): string {
  return JSON.stringify({
    handle: hello.handle,
    league: hello.league,
    harness: hello.harness,
    ...(hello.verified !== undefined ? { verified: hello.verified } : {}),
    ...(hello.pubkey !== undefined ? { pubkey: hello.pubkey } : {}),
    ...(hello.nonce !== undefined ? { nonce: hello.nonce } : {}),
    ...(hello.sig !== undefined ? { sig: hello.sig } : {}),
  });
}

interface HandshakeFieldSpec {
  readonly field: string;
  readonly parse: (raw: unknown) => boolean;
  readonly optional: boolean;
}

function parseTextField(raw: string | Buffer): Record<string, unknown> | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length > MAX_HANDSHAKE_LEN) return null;
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

function isValidHandle(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_HANDLE_LEN;
}

function isValidLeague(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_LEAGUE_LEN;
}

const handshakeOptionalSpecs: readonly HandshakeFieldSpec[] = [
  { field: 'verified', optional: true, parse: (v) => v === undefined || typeof v === 'boolean' },
  { field: 'pubkey', optional: true, parse: (v) => v === undefined || (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v)) },
  { field: 'nonce', optional: true, parse: (v) => v === undefined || (typeof v === 'string' && /^[0-9a-fA-F]{1,64}$/.test(v)) },
  { field: 'sig', optional: true, parse: (v) => v === undefined || (typeof v === 'string' && /^[0-9a-fA-F]{128}$/.test(v)) },
];

function validateOptionalFields(rec: Record<string, unknown>): boolean {
  for (const spec of handshakeOptionalSpecs) {
    if (!spec.parse(rec[spec.field])) return false;
  }
  return true;
}

function buildHandshakeResult(rec: Record<string, unknown>, handle: string, league: string): PeerHello {
  const harness = rec['harness'];
  const verified = rec['verified'];
  const pubkey = rec['pubkey'];
  const nonce = rec['nonce'];
  const sig = rec['sig'];
  return {
    handle,
    league,
    harness: typeof harness === 'string' && harness.length > 0 && harness.length <= MAX_HARNESS_LEN ? harness : 'unknown',
    ...(typeof verified === 'boolean' ? { verified } : {}),
    ...(typeof pubkey === 'string' ? { pubkey } : {}),
    ...(typeof nonce === 'string' ? { nonce } : {}),
    ...(typeof sig === 'string' ? { sig } : {}),
  };
}

export function parseHandshake(raw: string | Buffer): PeerHello | null {
  const rec = parseTextField(raw);
  if (rec === null) return null;
  const handle = rec['handle'];
  const league = rec['league'];
  if (!isValidHandle(handle)) return null;
  if (!isValidLeague(league)) return null;
  if (!validateOptionalFields(rec)) return null;
  return buildHandshakeResult(rec, handle as string, league as string);
}
