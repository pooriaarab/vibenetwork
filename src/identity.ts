import { defaultStateDir } from './state.js';
import {
  type Identity,
  type IdentityProof,
  type IdentityVerdict,
  loadOrCreateIdentity as coreLoadOrCreateIdentity,
  signClaimFields,
  verifyClaimFields,
  classifyIdentityProof,
  joinClaims
} from '@pooriaarab/vibe-core/identity';

export type { Identity, IdentityProof, IdentityVerdict };

export interface HelloClaims {
  readonly handle: string;
  readonly league: string;
  readonly harness: string;
  readonly verified?: boolean;
}

export function loadOrCreateIdentity(dir: string = defaultStateDir()): Identity {
  return coreLoadOrCreateIdentity(dir);
}

export function canonicalHelloClaims(claims: HelloClaims & { nonce: string }): string {
  return joinClaims([claims.handle, claims.league, claims.harness, claims.verified === true, claims.nonce]);
}

export function signHelloClaims(identity: Identity, claims: HelloClaims): IdentityProof {
  return signClaimFields(identity, [claims.handle, claims.league, claims.harness, claims.verified === true]);
}

export function verifyHelloClaims(claims: HelloClaims, proof: IdentityProof): boolean {
  return verifyClaimFields([claims.handle, claims.league, claims.harness, claims.verified === true], proof);
}

export function classifyHelloIdentity(hello: HelloClaims & Partial<IdentityProof>): IdentityVerdict {
  return classifyIdentityProof(hello, (proof) => verifyHelloClaims(hello, proof));
}
