import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  leagueTopic,
  loadPeers,
  parseHandshake,
  recordPeer,
  recordPeerMessage,
  serializeHandshake,
  TOPIC_PREFIX,
  type PeerHello,
} from './p2p.js';

const alice: PeerHello = { handle: '@alice', league: '10M', harness: 'claude-code' };

describe('leagueTopic()', () => {
  it('is sha256("vibedate:" + league) — 32 bytes, spec formula', () => {
    const expected = createHash('sha256').update(`${TOPIC_PREFIX}100M`, 'utf8').digest();
    expect(leagueTopic('100M').equals(expected)).toBe(true);
    expect(leagueTopic('100M')).toHaveLength(32);
  });

  it('same league → same topic (deterministic, that IS the discovery mechanism)', () => {
    expect(leagueTopic('10M').equals(leagueTopic('10M'))).toBe(true);
  });

  it('different league → different topic', () => {
    const topics = ['1M', '5M', '10M', '100M', '1B+', 'below-1M'].map((l) => leagueTopic(l).toString('hex'));
    expect(new Set(topics).size).toBe(topics.length);
  });
});

describe('serializeHandshake() / parseHandshake()', () => {
  it('round-trips a valid hello', () => {
    expect(parseHandshake(serializeHandshake(alice))).toEqual(alice);
  });

  it('accepts a Buffer (wire format)', () => {
    expect(parseHandshake(Buffer.from(serializeHandshake(alice) + '\n').subarray(0, -1))).toEqual(alice);
  });

  it('emits exactly the three allowed keys — even if the object carries extra props', () => {
    const sneaky = { ...alice, totalTokens: 23_400_000, usage: { today: 1 } } as PeerHello;
    const wire = JSON.parse(serializeHandshake(sneaky)) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(['handle', 'harness', 'league']);
  });

  it('ignores raw-usage fields sent by a peer (never retained)', () => {
    const hostile = JSON.stringify({
      handle: '@bob',
      league: '10M',
      harness: 'codex',
      totalTokens: 999_000_000,
      tokens: 999_000_000,
      usage: { window: 'all' },
      rawUsage: 'definitely-not-allowed',
    });
    const parsed = parseHandshake(hostile);
    expect(parsed).toEqual({ handle: '@bob', league: '10M', harness: 'codex' });
    expect(JSON.stringify(parsed)).not.toMatch(/totalTokens|tokens|usage|rawUsage/i);
  });

  it('rejects malformed input', () => {
    expect(parseHandshake('not json')).toBeNull();
    expect(parseHandshake('[1,2,3]')).toBeNull();
    expect(parseHandshake('null')).toBeNull();
    expect(parseHandshake('"@alice"')).toBeNull();
    expect(parseHandshake('{}')).toBeNull();
    expect(parseHandshake(JSON.stringify({ league: '10M' }))).toBeNull(); // no handle
    expect(parseHandshake(JSON.stringify({ handle: '@a' }))).toBeNull(); // no league
    expect(parseHandshake(JSON.stringify({ handle: '', league: '10M' }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ handle: 42, league: '10M' }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ handle: '@a', league: '10M' }) + 'x')).toBeNull();
    expect(parseHandshake('x'.repeat(5000))).toBeNull(); // oversized
  });

  it('defaults a missing/invalid harness to "unknown"', () => {
    expect(parseHandshake(JSON.stringify({ handle: '@a', league: '10M' }))?.harness).toBe('unknown');
    expect(parseHandshake(JSON.stringify({ handle: '@a', league: '10M', harness: 7 }))?.harness).toBe(
      'unknown',
    );
  });
});

describe('handshake — verified flag', () => {
  it('round-trips a hello carrying verified', () => {
    const v: PeerHello = { ...alice, verified: true };
    expect(parseHandshake(serializeHandshake(v))).toEqual(v);
  });

  it('emits no verified key when the hello has none (legacy wire shape)', () => {
    const wire = JSON.parse(serializeHandshake(alice)) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(['handle', 'harness', 'league']);
  });

  it('accepts a peer-sent verified flag, rejects a non-boolean one', () => {
    expect(
      parseHandshake(JSON.stringify({ handle: '@a', league: '10M', verified: false })),
    ).toEqual({ handle: '@a', league: '10M', harness: 'unknown', verified: false });
    expect(
      parseHandshake(JSON.stringify({ handle: '@a', league: '10M', verified: 'true' })),
    ).toBeNull();
  });

  it('recordPeer persists verified when present, and drops it when a re-sighting omits it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-peers-verified-'));
    try {
      recordPeer({ ...alice, verified: true }, dir);
      expect(loadPeers(dir)[0]).toMatchObject({ handle: '@alice', verified: true });
      recordPeer(alice, dir); // same handle, no verified this time
      const peer = loadPeers(dir)[0]!;
      expect(peer).not.toHaveProperty('verified');
      expect(Object.keys(peer).sort()).toEqual([
        'firstSeenAt',
        'handle',
        'harness',
        'lastSeenAt',
        'league',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recordPeer() / loadPeers()', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-peers-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no peers.json → empty list', () => {
    expect(loadPeers(dir)).toEqual([]);
  });

  it('first sighting is new; re-sighting the same handle is not', () => {
    expect(recordPeer(alice, dir, new Date('2026-07-27T00:00:00Z')).isNew).toBe(true);
    expect(recordPeer(alice, dir, new Date('2026-07-27T01:00:00Z')).isNew).toBe(false);
    const peers = loadPeers(dir);
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({
      handle: '@alice',
      league: '10M',
      firstSeenAt: '2026-07-27T00:00:00.000Z',
      lastSeenAt: '2026-07-27T01:00:00.000Z',
    });
  });

  it('persists multiple peers across loads', () => {
    recordPeer(alice, dir);
    recordPeer({ handle: '@bob', league: '10M', harness: 'codex' }, dir);
    expect(loadPeers(dir).map((p) => p.handle)).toEqual(['@alice', '@bob']);
  });

  it('stores nothing but the allowlisted fields', () => {
    recordPeer(alice, dir);
    const peer = loadPeers(dir)[0]!;
    expect(Object.keys(peer).sort()).toEqual([
      'firstSeenAt',
      'handle',
      'harness',
      'lastSeenAt',
      'league',
    ]);
  });
});

describe('handshake — identity proof fields', () => {
  const pubkey = 'a'.repeat(64);
  const nonce = 'b'.repeat(32);
  const sig = 'c'.repeat(128);
  const signed: PeerHello = { ...alice, verified: true, pubkey, nonce, sig };

  it('round-trips a hello carrying the full identity proof', () => {
    expect(parseHandshake(serializeHandshake(signed))).toEqual(signed);
  });

  it('never serializes the local-derived identityVerified flag', () => {
    const local: PeerHello = { ...alice, pubkey, identityVerified: true };
    const wire = JSON.parse(serializeHandshake(local)) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(['handle', 'harness', 'league', 'pubkey']);
    expect(wire).not.toHaveProperty('identityVerified');
  });

  it('rejects malformed proof fields (same rigor as the frame parser)', () => {
    expect(parseHandshake(JSON.stringify({ handle: '@a', league: '10M', pubkey: 'a'.repeat(63) }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ handle: '@a', league: '10M', sig: 'c'.repeat(127) }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ handle: '@a', league: '10M', nonce: 'b'.repeat(65) }))).toBeNull();
    expect(parseHandshake(JSON.stringify({ handle: '@a', league: '10M', pubkey: 7 }))).toBeNull();
  });

  it('a hello with no pubkey parses as legacy (no identity keys added)', () => {
    const parsed = parseHandshake(serializeHandshake(alice));
    expect(parsed).toEqual(alice);
    expect(parsed).not.toHaveProperty('pubkey');
  });
});

describe('recordPeer() — identity + lastMessageAt persistence', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-peers-id-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists pubkey + identityVerified for an identity-verified peer', () => {
    const pubkey = 'a'.repeat(64);
    recordPeer({ ...alice, verified: true, pubkey, identityVerified: true }, dir);
    const peer = loadPeers(dir)[0]!;
    expect(peer).toMatchObject({ handle: '@alice', verified: true, pubkey, identityVerified: true });
    expect(peer).not.toHaveProperty('sig');
    expect(peer).not.toHaveProperty('nonce');
  });

  it('drops identity fields when a re-sighting no longer carries them', () => {
    const pubkey = 'a'.repeat(64);
    recordPeer({ ...alice, pubkey, identityVerified: true }, dir);
    recordPeer(alice, dir); // legacy re-sighting
    const peer = loadPeers(dir)[0]!;
    expect(peer).not.toHaveProperty('pubkey');
    expect(peer).not.toHaveProperty('identityVerified');
  });

  it('recordPeerMessage stamps lastMessageAt; a later hello preserves it', () => {
    expect(recordPeerMessage('@nobody', dir)).toBe(false); // unknown handle
    recordPeer(alice, dir, new Date('2026-07-27T00:00:00Z'));
    expect(recordPeerMessage('@alice', dir, new Date('2026-07-27T02:00:00Z'))).toBe(true);
    expect(loadPeers(dir)[0]).toMatchObject({ lastMessageAt: '2026-07-27T02:00:00.000Z' });
    // A re-sighting (hello) must NOT reset local message metadata.
    recordPeer({ ...alice, verified: true }, dir, new Date('2026-07-27T03:00:00Z'));
    const peer = loadPeers(dir)[0]!;
    expect(peer).toMatchObject({
      verified: true,
      lastSeenAt: '2026-07-27T03:00:00.000Z',
      lastMessageAt: '2026-07-27T02:00:00.000Z',
    });
  });
});
