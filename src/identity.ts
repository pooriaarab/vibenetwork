/**
 * Persistent ed25519 identity — binds a handle to a keypair so a peer cannot
 * impersonate it.
 *
 * The keypair lives at `~/.vibedating/identity.json` (mode 0600), generated on
 * first use and reused across runs. A hello that carries a `pubkey` must also
 * carry a valid `sig` over the canonical claims string
 * `handle|league|harness|verified|nonce`; anything else claiming a key is an
 * impersonation attempt and the peer is DROPPED. A hello with no `pubkey` at
 * all is a legacy peer — accepted, but never identity-verified.
 *
 * node:crypto only — no new dependency. The private key never leaves the file;
 * only the raw public key (64 hex) and signatures (128 hex) travel on hellos.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultStateDir } from './state.js';

/** A loaded identity: the raw public key (wire form) plus both key objects. */
export interface Identity {
  /** Raw 32-byte ed25519 public key, hex (64 chars) — the wire form. */
  readonly publicKeyHex: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  /** ISO timestamp of key generation (first connect). */
  readonly createdAt: string;
}

/** The hello fields a signature commits to (a PeerHello minus its proof). */
export interface HelloClaims {
  readonly handle: string;
  readonly league: string;
  readonly harness: string;
  readonly verified?: boolean;
}

/** The wire proof attached to a hello: pubkey + nonce + signature, all hex. */
export interface IdentityProof {
  readonly pubkey: string;
  readonly nonce: string;
  readonly sig: string;
}

/** The file under the state dir holding the persistent keypair (JWK, mode 0600). */
const IDENTITY_FILE = 'identity.json';

function identityPath(dir: string): string {
  return path.join(dir, IDENTITY_FILE);
}

interface Ed25519Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  d?: string;
}

function isStoredIdentity(data: unknown): data is { x: string; d: string; createdAt: string } {
  if (typeof data !== 'object' || data === null) return false;
  const r = data as Record<string, unknown>;
  return (
    r['kty'] === 'OKP' &&
    r['crv'] === 'Ed25519' &&
    typeof r['x'] === 'string' &&
    typeof r['d'] === 'string' &&
    typeof r['createdAt'] === 'string'
  );
}

function fromJwk(x: string, d: string, createdAt: string): Identity {
  const privateKey = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x, d }, format: 'jwk' });
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  const publicKeyHex = Buffer.from(x, 'base64url').toString('hex');
  if (publicKeyHex.length !== 64) throw new Error('corrupt identity: bad public key length');
  return { publicKeyHex, publicKey, privateKey, createdAt };
}

/**
 * Load the persistent keypair, generating + storing it (mode 0600) on first
 * use. A missing or corrupt file is (re)generated — never throws on disk
 * content. Idempotent across runs: same file → same key → same pubkey.
 */
export function loadOrCreateIdentity(dir: string = defaultStateDir()): Identity {
  try {
    const raw = readFileSync(identityPath(dir), 'utf8');
    const data: unknown = JSON.parse(raw);
    if (isStoredIdentity(data)) {
      // The file holds a private key — keep it 0600 even if a restore/backup
      // loosened the mode. Best-effort; never blocks the load.
      try {
        chmodSync(identityPath(dir), 0o600);
      } catch {
        /* ignore */
      }
      return fromJwk(data.x, data.d, data.createdAt);
    }
  } catch {
    /* missing or corrupt — fall through and (re)generate */
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as Ed25519Jwk;
  if (typeof jwk.x !== 'string' || typeof jwk.d !== 'string') {
    throw new Error('could not export ed25519 keypair as JWK');
  }
  const createdAt = new Date().toISOString();
  const identity = fromJwk(jwk.x, jwk.d, createdAt);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    identityPath(dir),
    JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d, createdAt }, null, 2) + '\n',
    { encoding: 'utf8', mode: 0o600 },
  );
  // mode on write applies only to new files — force it for a pre-existing one.
  try {
    chmodSync(identityPath(dir), 0o600);
  } catch {
    /* best-effort hardening; the file content is still valid */
  }
  return identity;
}

/**
 * The canonical string an identity signature commits to:
 * `handle|league|harness|verified|nonce` — verified rendered as `true`/`false`.
 * Pure; both sides compute it byte-identically or the signature cannot verify.
 */
export function canonicalHelloClaims(claims: HelloClaims & { nonce: string }): string {
  return [claims.handle, claims.league, claims.harness, String(claims.verified === true), claims.nonce].join(
    '|',
  );
}

/**
 * Sign hello claims with the persistent identity. A fresh random 16-byte nonce
 * per call, so two hellos never share a signature. Returns only the wire proof
 * fields — the private key stays put.
 */
export function signHelloClaims(identity: Identity, claims: HelloClaims): IdentityProof {
  const nonce = randomBytes(16).toString('hex');
  const payload = canonicalHelloClaims({ ...claims, nonce });
  const sig = sign(null, Buffer.from(payload, 'utf8'), identity.privateKey).toString('hex');
  return { pubkey: identity.publicKeyHex, nonce, sig };
}

/**
 * Verify a claimed proof against hello claims. NEVER throws — any anomaly
 * (bad hex, bad key, bad signature) is simply `false`.
 */
export function verifyHelloClaims(claims: HelloClaims, proof: IdentityProof): boolean {
  try {
    if (!/^[0-9a-f]{64}$/i.test(proof.pubkey)) return false;
    if (!/^[0-9a-f]{1,64}$/i.test(proof.nonce)) return false;
    if (!/^[0-9a-f]{128}$/i.test(proof.sig)) return false;
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(proof.pubkey, 'hex').toString('base64url') },
      format: 'jwk',
    });
    const payload = canonicalHelloClaims({ ...claims, nonce: proof.nonce });
    return verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(proof.sig, 'hex'));
  } catch {
    return false;
  }
}

/** What an incoming hello's identity material amounts to. */
export type IdentityVerdict =
  | 'verified' // pubkey present and the signature checks out — mark 🔑
  | 'legacy' // no pubkey at all — accepted, unverified (older peers)
  | 'drop'; // pubkey present but signature missing/invalid — impersonation attempt

/**
 * Classify an incoming hello's identity claim. Pure decision, no IO — the
 * caller (discovery) turns 'drop' into "never recorded, never paired".
 */
export function classifyHelloIdentity(hello: HelloClaims & Partial<IdentityProof>): IdentityVerdict {
  if (hello.pubkey === undefined) return 'legacy';
  if (hello.nonce === undefined || hello.sig === undefined) return 'drop';
  return verifyHelloClaims(hello, { pubkey: hello.pubkey, nonce: hello.nonce, sig: hello.sig })
    ? 'verified'
    : 'drop';
}
