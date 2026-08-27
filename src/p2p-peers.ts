import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PeerHello } from './p2p-handshake.js';
import { defaultStateDir } from './state.js';

export interface StoredPeer extends PeerHello {
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastMessageAt?: string;
}

function peersPath(dir: string): string {
  return path.join(dir, 'peers.json');
}

export function loadPeers(dir: string = defaultStateDir()): StoredPeer[] {
  try {
    const raw = readFileSync(peersPath(dir), 'utf8');
    const data = JSON.parse(raw) as { peers?: StoredPeer[] };
    return Array.isArray(data.peers) ? data.peers : [];
  } catch {
    return [];
  }
}

export function recordPeer(hello: PeerHello, dir: string = defaultStateDir(), now: Date = new Date()): { peer: StoredPeer; isNew: boolean } {
  const peers = loadPeers(dir);
  const at = now.toISOString();
  const clean: PeerHello = {
    handle: hello.handle, league: hello.league, harness: hello.harness,
    ...(hello.verified !== undefined ? { verified: hello.verified } : {}),
    ...(hello.pubkey !== undefined ? { pubkey: hello.pubkey } : {}),
    ...(hello.identityVerified !== undefined ? { identityVerified: hello.identityVerified } : {}),
  };
  const existing = peers.findIndex((p) => p.handle === clean.handle);
  let isNew: boolean;
  let peer: StoredPeer;
  if (existing >= 0) {
    isNew = false;
    const prev = peers[existing];
    if (prev === undefined) throw new Error('peer not found at expected index');
    peer = { ...clean, firstSeenAt: prev.firstSeenAt, lastSeenAt: at, ...(prev.lastMessageAt !== undefined ? { lastMessageAt: prev.lastMessageAt } : {}) };
    peers[existing] = peer;
  } else {
    isNew = true;
    peer = { ...clean, firstSeenAt: at, lastSeenAt: at };
    peers.push(peer);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(peersPath(dir), JSON.stringify({ peers }, null, 2) + '\n', 'utf8');
  return { peer, isNew };
}

export function recordPeerMessage(handle: string, dir: string = defaultStateDir(), now: Date = new Date()): boolean {
  try {
    const peers = loadPeers(dir);
    const idx = peers.findIndex((p) => p.handle === handle);
    if (idx < 0) return false;
    const existingEntry = peers[idx];
    if (existingEntry === undefined) throw new Error('peer not found at index');
    peers[idx] = { ...existingEntry, lastMessageAt: now.toISOString() };
    mkdirSync(dir, { recursive: true });
    writeFileSync(peersPath(dir), JSON.stringify({ peers }, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}
