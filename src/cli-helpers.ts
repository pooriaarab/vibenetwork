import type { Harness } from '@pooriaarab/vibe-core';
import { loadOrCreateIdentity, signHelloClaims } from './identity.js';
import { createFeedStore, postToFrame } from './feed.js';
import type { PeerLink } from './link.js';
import { loadProfile } from './profile.js';
import type { LocalUsageSnapshot } from './profile.js';
import type { Profile } from './index.js';
import { defaultStateDir, resolveHandle } from './state.js';
import type { PeerHello } from './p2p.js';

export const VERSION = '0.1.1';
export const MARKS_LEGEND = 'marks: \u2713 usage verified (real local logs) \u00b7 ~ unverified \u00b7 \ud83d\udd11 identity-verified (signed hello)';

export function formatAgo(at: string | number, now: Date = new Date()): string {
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (Number.isNaN(t)) return 'unknown';
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatTokens(n: number): string {
  const trim = (v: number): string => String(Math.round(v * 10) / 10);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}k`;
  return String(n);
}

export function verificationText(snapshot: LocalUsageSnapshot): string {
  if (snapshot.source === 'real') {
    return `verified: real usage — ${formatTokens(snapshot.totalTokens)} tokens from ${snapshot.harness} logs`;
  }
  if (snapshot.source === 'self-report') return 'self-reported (unverified)';
  return 'demo (unverified)';
}

export function usageMark(peer: { verified?: boolean }): string {
  return peer.verified === true ? '✓' : '~';
}

export function idMark(peer: { identityVerified?: boolean }): string {
  return peer.identityVerified === true ? ' 🔑' : '';
}

export function buildHello(profile: Profile): PeerHello {
  const claims = {
    handle: resolveHandle(),
    league: profile.league,
    harness: (process.env['VIBENETWORK_HARNESS'] as Harness | undefined) ?? 'claude-code',
    verified: profile.verified,
  };
  return { ...claims, ...signHelloClaims(loadOrCreateIdentity(), claims) };
}

export function requireProfile(): Profile | null {
  return loadProfile();
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function wireFeedSync(link: PeerLink, store: ReturnType<typeof createFeedStore>): void {
  for (const p of store.recent()) link.sendPost(postToFrame(p));
  link.onPost((frame) => store.addFrame(frame));
}
