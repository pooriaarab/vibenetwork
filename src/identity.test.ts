/**
 * Identity — persistent ed25519 keypair + signed hellos.
 *
 * The contract under test: a hello carrying a pubkey must carry a signature
 * that verifies against it over the canonical claims string
 * `handle|league|harness|verified|nonce`; a valid round-trip marks the peer
 * identity-verified, any tampering drops it, and a hello with no pubkey at all
 * stays accepted as a legacy (unverified) peer.
 */
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalHelloClaims,
  classifyHelloIdentity,
  loadOrCreateIdentity,
  signHelloClaims,
  verifyHelloClaims,
  type HelloClaims,
} from './identity.js';

const CLAIMS: HelloClaims = {
  handle: '@alice',
  league: '10M',
  harness: 'claude-code',
  verified: true,
};

describe('loadOrCreateIdentity', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-identity-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates on first use, persists, and reloads the SAME key', () => {
    const first = loadOrCreateIdentity(dir);
    expect(first.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    const second = loadOrCreateIdentity(dir);
    expect(second.publicKeyHex).toBe(first.publicKeyHex);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('stores identity.json with mode 0600', () => {
    loadOrCreateIdentity(dir);
    const mode = statSync(path.join(dir, 'identity.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('hardens the mode of a pre-existing loose file back to 0600 on load', () => {
    loadOrCreateIdentity(dir);
    const file = path.join(dir, 'identity.json');
    chmodSync(file, 0o644);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    const id = loadOrCreateIdentity(dir);
    expect(id.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('regenerates when the file is corrupt', () => {
    const first = loadOrCreateIdentity(dir);
    writeFileSync(path.join(dir, 'identity.json'), 'not json at all');
    const second = loadOrCreateIdentity(dir);
    expect(second.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(second.publicKeyHex).not.toBe(first.publicKeyHex);
  });
});

describe('canonicalHelloClaims', () => {
  it('is exactly handle|league|harness|verified|nonce', () => {
    expect(canonicalHelloClaims({ ...CLAIMS, nonce: 'ab12' })).toBe(
      '@alice|10M|claude-code|true|ab12',
    );
  });
  it('renders a missing/false verified flag as false', () => {
    expect(canonicalHelloClaims({ handle: '@a', league: '1M', harness: 'codex', nonce: 'n' })).toBe(
      '@a|1M|codex|false|n',
    );
  });
});

describe('signHelloClaims / verifyHelloClaims — round-trip + tamper', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-identity-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a freshly signed hello verifies (valid round-trip)', () => {
    const id = loadOrCreateIdentity(dir);
    const proof = signHelloClaims(id, CLAIMS);
    expect(proof.pubkey).toBe(id.publicKeyHex);
    expect(proof.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyHelloClaims(CLAIMS, proof)).toBe(true);
  });

  it('two signatures over the same claims differ (fresh nonce each time)', () => {
    const id = loadOrCreateIdentity(dir);
    const a = signHelloClaims(id, CLAIMS);
    const b = signHelloClaims(id, CLAIMS);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.sig).not.toBe(b.sig);
    expect(verifyHelloClaims(CLAIMS, a)).toBe(true);
    expect(verifyHelloClaims(CLAIMS, b)).toBe(true);
  });

  it('tampering with any signed field fails verification', () => {
    const id = loadOrCreateIdentity(dir);
    const proof = signHelloClaims(id, CLAIMS);
    expect(verifyHelloClaims({ ...CLAIMS, handle: '@mallory' }, proof)).toBe(false);
    expect(verifyHelloClaims({ ...CLAIMS, league: '1B+' }, proof)).toBe(false);
    expect(verifyHelloClaims({ ...CLAIMS, harness: 'codex' }, proof)).toBe(false);
    expect(verifyHelloClaims({ ...CLAIMS, verified: false }, proof)).toBe(false);
    expect(verifyHelloClaims(CLAIMS, { ...proof, nonce: '00'.repeat(16) })).toBe(false);
  });

  it('a signature from a DIFFERENT key fails (cannot forge another identity)', () => {
    const alice = loadOrCreateIdentity(dir);
    const malloryDir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-identity-m-'));
    try {
      const mallory = loadOrCreateIdentity(malloryDir);
      const forged = signHelloClaims(mallory, CLAIMS);
      // Well-formed, but not alice's key — and claiming alice's pubkey:
      expect(
        verifyHelloClaims(CLAIMS, { ...forged, pubkey: alice.publicKeyHex }),
      ).toBe(false);
    } finally {
      rmSync(malloryDir, { recursive: true, force: true });
    }
  });

  it('never throws on garbage input — just false', () => {
    expect(verifyHelloClaims(CLAIMS, { pubkey: 'zz', nonce: 'ab', sig: 'cd' })).toBe(false);
    expect(verifyHelloClaims(CLAIMS, { pubkey: 'a'.repeat(64), nonce: '', sig: 'b'.repeat(128) })).toBe(false);
    expect(verifyHelloClaims(CLAIMS, { pubkey: 'a'.repeat(64), nonce: 'ab', sig: 'not-hex'.repeat(18) })).toBe(false);
  });
});

describe('classifyHelloIdentity', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'vibedating-identity-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no pubkey → legacy (accepted as unverified, backward compatible)', () => {
    expect(classifyHelloIdentity({ handle: '@old', league: '10M', harness: 'codex' })).toBe('legacy');
  });

  it('pubkey + valid sig → verified', () => {
    const id = loadOrCreateIdentity(dir);
    const proof = signHelloClaims(id, CLAIMS);
    expect(classifyHelloIdentity({ ...CLAIMS, ...proof })).toBe('verified');
  });

  it('pubkey with missing sig or nonce → drop', () => {
    const id = loadOrCreateIdentity(dir);
    const proof = signHelloClaims(id, CLAIMS);
    expect(classifyHelloIdentity({ ...CLAIMS, pubkey: proof.pubkey, nonce: proof.nonce })).toBe('drop');
    expect(classifyHelloIdentity({ ...CLAIMS, pubkey: proof.pubkey, sig: proof.sig })).toBe('drop');
    expect(classifyHelloIdentity({ ...CLAIMS, pubkey: proof.pubkey })).toBe('drop');
  });

  it('pubkey + invalid sig → drop (impersonation attempt)', () => {
    const id = loadOrCreateIdentity(dir);
    const proof = signHelloClaims(id, CLAIMS);
    expect(
      classifyHelloIdentity({ ...CLAIMS, ...proof, sig: 'f'.repeat(128) }),
    ).toBe('drop');
    // Sig valid but over different claims (handle swapped after signing):
    expect(
      classifyHelloIdentity({ ...CLAIMS, handle: '@mallory', ...proof }),
    ).toBe('drop');
  });
});
