import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Harness } from '@pooriaarab/vibe-core';
import { generateHandle } from './handlegen.js';
import {
  BELOW_LEAGUE,
  MAX_BIO_LEN,
  cleanBio,
  cleanLinks,
  createProfile,
  league,
  loadProfile,
  parseTokensEnv,
  updateProfile,
  type LocalUsageSnapshot,
} from './profile.js';
import { canShareLive, loadHandle, normalizeHandle } from './state.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vibenetwork-profile-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Fake usage reader: deterministic, no disk/logs touched. */
function fakeUsage(totalTokens: number, source: 'real' | 'self-report' | 'demo') {
  return async (harness: Harness): Promise<LocalUsageSnapshot> => ({
    harness,
    totalTokens,
    verified: source === 'real',
    source,
    windowStart: '2026-01-01T00:00:00.000Z',
    windowEnd: '2026-01-31T00:00:00.000Z',
  });
}

describe('league()', () => {
  it('buckets token counts into the five leagues + below-1M', () => {
    expect(league(0).name).toBe(BELOW_LEAGUE);
    expect(league(999_999).name).toBe(BELOW_LEAGUE);
    expect(league(1_000_000).name).toBe('1M');
    expect(league(4_999_999).name).toBe('1M');
    expect(league(5_000_000).name).toBe('5M');
    expect(league(10_000_000).name).toBe('10M');
    expect(league(100_000_000).name).toBe('100M');
    expect(league(1_000_000_000).name).toBe('1B+');
    expect(league(999_999_999_999).name).toBe('1B+');
  });

  it('clamps negatives and floors non-integers', () => {
    expect(league(-50).name).toBe(BELOW_LEAGUE);
    expect(league(999_999.9).name).toBe(BELOW_LEAGUE);
    expect(league(1_000_000.9).name).toBe('1M');
  });
});

describe('parseTokensEnv()', () => {
  it('parses plain + suffixed counts', () => {
    expect(parseTokensEnv('23400000')).toBe(23_400_000);
    expect(parseTokensEnv('12M')).toBe(12_000_000);
    expect(parseTokensEnv('1.2B')).toBe(1_200_000_000);
    expect(parseTokensEnv('500k')).toBe(500_000);
    expect(parseTokensEnv(undefined)).toBeUndefined();
    expect(parseTokensEnv('')).toBeUndefined();
    expect(parseTokensEnv('-5')).toBeUndefined();
    expect(parseTokensEnv('abc')).toBeUndefined();
  });
});

describe('cleanBio() / cleanLinks()', () => {
  it('caps the bio at 160 chars and strips control chars', () => {
    expect(cleanBio('x'.repeat(200))).toHaveLength(MAX_BIO_LEN);
    expect(cleanBio('hi\x07there')).toBe('hithere'); // control byte removed
    expect(cleanBio('  padded  ')).toBe('padded');
  });

  it('caps links in count and length, drops empties/whitespace', () => {
    const links = cleanLinks([
      'https://a.dev',
      '',
      '   ',
      'has space.dev',
      ...Array.from({ length: 10 }, (_, i) => `https://l${i}.dev`),
    ]);
    expect(links.length).toBeLessThanOrEqual(8);
    expect(links).toContain('https://a.dev');
    expect(links).not.toContain('has space.dev');
    expect(cleanLinks(['x'.repeat(300)])[0]).toHaveLength(200);
  });
});

describe('createProfile() / loadProfile() persistence', () => {
  it('creates, persists, and reloads an identical profile', async () => {
    const created = await createProfile({
      handle: 'alice',
      bio: 'ships code',
      links: ['https://a.dev'],
      dir,
      usageReader: fakeUsage(23_400_000, 'real'),
    });
    expect(created.handle).toBe('@alice');
    expect(created.league).toBe('10M');
    expect(created.verified).toBe(true);
    expect(created.pubkey).toMatch(/^[0-9a-f]{64}$/);

    const loaded = loadProfile(dir);
    expect(loaded).toEqual(created);
  });

  it('verified is true IFF the usage source is real', async () => {
    const real = await createProfile({ handle: '@a', dir, usageReader: fakeUsage(5e6, 'real') });
    expect(real.verified).toBe(true);
    const selfDir = mkdtempSync(path.join(os.tmpdir(), 'vibenetwork-profile-s-'));
    try {
      const self = await createProfile({
        handle: '@a',
        dir: selfDir,
        usageReader: fakeUsage(5e6, 'self-report'),
      });
      expect(self.verified).toBe(false);
      const demo = await createProfile({
        handle: '@a',
        dir: selfDir,
        usageReader: fakeUsage(5e6, 'demo'),
      });
      expect(demo.verified).toBe(false);
    } finally {
      rmSync(selfDir, { recursive: true, force: true });
    }
  });

  it('reuses the SAME ed25519 identity across connects (stable pubkey)', async () => {
    const first = await createProfile({ handle: '@a', dir, usageReader: fakeUsage(5e6, 'real') });
    const second = await createProfile({
      handle: '@a',
      dir,
      usageReader: fakeUsage(120e6, 'real'),
    });
    expect(second.pubkey).toBe(first.pubkey);
    expect(second.league).toBe('100M'); // refreshed bucket
  });

  it('persists the handle and grants live consent on connect', async () => {
    await createProfile({ handle: '@alice', dir, usageReader: fakeUsage(5e6, 'real') });
    expect(loadHandle(dir)).toBe('@alice');
    expect(canShareLive(dir)).toBe(true);
  });

  it('never persists a raw token total on the profile', async () => {
    await createProfile({ handle: '@a', dir, usageReader: fakeUsage(23_400_000, 'real') });
    const loaded = loadProfile(dir)!;
    expect(JSON.stringify(loaded)).not.toMatch(/23400000|totalTokens/i);
  });

  it('rejects an invalid handle and survives a corrupt profile.json', async () => {
    await expect(
      createProfile({ handle: '@', dir, usageReader: fakeUsage(5e6, 'real') }),
    ).rejects.toThrow(/invalid handle/);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dir, 'profile.json'), 'not json{{{');
    expect(loadProfile(dir)).toBeNull();
  });
});

describe('updateProfile()', () => {
  it('updates bio/links/handle, keeps identity fields immutable', async () => {
    const created = await createProfile({
      handle: '@a',
      dir,
      usageReader: fakeUsage(5e6, 'real'),
    });
    const updated = updateProfile({ bio: 'new bio', links: ['https://b.dev'], handle: 'b' }, dir)!;
    expect(updated.bio).toBe('new bio');
    expect(updated.links).toEqual(['https://b.dev']);
    expect(updated.handle).toBe('@b');
    expect(updated.pubkey).toBe(created.pubkey);
    expect(updated.league).toBe(created.league);
    expect(loadProfile(dir)).toEqual(updated);
    expect(loadHandle(dir)).toBe('@b');
  });

  it('returns null when no profile exists; throws on a bad handle', () => {
    expect(updateProfile({ bio: 'x' }, dir)).toBeNull();
  });
});

describe('generateHandle() (memetic auto-handle)', () => {
  it('always mints a valid canonical handle (deterministic rand injected)', () => {
    for (const r of [0, 0.1, 0.25, 0.499, 0.5, 0.75, 0.9, 0.999999]) {
      const h = generateHandle(() => r);
      expect(normalizeHandle(h)).toBe(h);
      expect(h.startsWith('@')).toBe(true);
      expect(h.length).toBeLessThanOrEqual(32);
    }
  });
});
