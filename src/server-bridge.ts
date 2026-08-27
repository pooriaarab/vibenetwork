import { createFeedStore } from './feed.js';
import type { FeedStore } from './feed.js';
import { postToFrame } from './feed.js';
import { isFollowed } from './follow.js';
import type { PostFrame } from './frame.js';
import type { PeerLink } from './link.js';
import { defaultStateDir, normalizeHandle, sameHandle } from './state.js';
import { sanitizePeerText } from '@pooriaarab/vibe-core/untrusted';
import { recordDm } from './dm.js';

export interface NetPeerInfo {
  readonly handle: string;
  readonly league: string;
  readonly harness: string;
  readonly verified?: boolean;
  readonly identityVerified?: boolean;
  readonly followed: boolean;
}

export interface NetMessage {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

export interface NetBridge {
  readonly peers: readonly NetPeerInfo[];
  addLink(link: PeerLink): void;
  isOnline(handle: string): boolean;
  sendMessage(handle: string, text: string): boolean;
  pollMessage(handle: string, timeoutMs: number): Promise<NetMessage | null>;
  broadcastPost(frame: PostFrame): number;
}

interface PeerMailbox {
  readonly link: PeerLink;
  readonly messages: NetMessage[];
}

const MAX_QUEUED_MESSAGES = 200;

export interface CreateNetBridgeOptions {
  readonly dir?: string;
  readonly feed?: FeedStore;
}

function normalizeKey(handle: string): string {
  return normalizeHandle(handle) ?? handle;
}

function lookupBox(handle: string, boxes: Map<string, PeerMailbox>): PeerMailbox | undefined {
  const direct = boxes.get(normalizeKey(handle));
  if (direct !== undefined) return direct;
  for (const [k, mb] of boxes) {
    if (sameHandle(k, handle) || sameHandle(mb.link.hello.handle, handle)) return mb;
  }
  return undefined;
}

function buildPeerInfo(m: PeerMailbox, dir: string): NetPeerInfo {
  const h = m.link.hello;
  const handle = normalizeKey(h.handle);
  return {
    handle,
    league: h.league,
    harness: h.harness,
    ...(h.verified !== undefined ? { verified: h.verified } : {}),
    ...(h.identityVerified !== undefined ? { identityVerified: h.identityVerified } : {}),
    followed: isFollowed(handle, dir),
  };
}

function createPeersGetter(boxes: Map<string, PeerMailbox>, dir: string): () => readonly NetPeerInfo[] {
  return () =>
    [...boxes.values()]
      .map((m) => buildPeerInfo(m, dir))
      .sort((a, b) => a.handle.localeCompare(b.handle));
}

function createAddLink(
  boxes: Map<string, PeerMailbox>,
  feed: FeedStore,
  dir: string,
): (link: PeerLink) => void {
  return (link) => {
    const handle = normalizeKey(link.hello.handle);
    boxes.set(handle, { link, messages: [] });
    for (const p of feed.recent()) link.sendPost(postToFrame(p));
    link.onPost((frame) => feed.addFrame(frame));
    link.onMessage((m) => {
      const mb = boxes.get(handle);
      if (mb === undefined) return;
      const text = sanitizePeerText(m.text);
      mb.messages.push({ id: m.id, text, at: m.at });
      recordDm(handle, { direction: 'in', text, at: m.at }, dir);
      if (mb.messages.length > MAX_QUEUED_MESSAGES) {
        mb.messages.splice(0, mb.messages.length - MAX_QUEUED_MESSAGES);
      }
    });
    link.onClose(() => {
      const cur = boxes.get(handle);
      if (cur !== undefined && cur.link === link) boxes.delete(handle);
    });
  };
}

function createPollMessage(
  boxes: Map<string, PeerMailbox>,
): (handle: string, timeoutMs: number) => Promise<NetMessage | null> {
  return async (handle, timeoutMs) => {
    const key = normalizeKey(handle);
    const mb = lookupBox(handle, boxes);
    if (mb === undefined) return null;
    if (mb.messages.length > 0) return mb.messages.shift() ?? null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const cur = boxes.get(key) ?? lookupBox(handle, boxes);
      if (cur === undefined) return null;
      if (cur.messages.length > 0) return cur.messages.shift() ?? null;
    }
    return null;
  };
}

export function createNetBridge(opts: CreateNetBridgeOptions = {}): NetBridge {
  const dir = opts.dir ?? defaultStateDir();
  const feed = opts.feed ?? createFeedStore(dir);
  const boxes = new Map<string, PeerMailbox>();
  const peersGetter = createPeersGetter(boxes, dir);
  const addLink = createAddLink(boxes, feed, dir);
  const pollMessage = createPollMessage(boxes);

  return {
    get peers(): readonly NetPeerInfo[] { return peersGetter(); },
    addLink,
    isOnline(handle) { return lookupBox(handle, boxes) !== undefined; },
    sendMessage(handle, text) {
      const mb = lookupBox(handle, boxes);
      if (mb === undefined) return false;
      mb.link.send(text);
      recordDm(normalizeKey(handle), { direction: 'out', text }, dir);
      return true;
    },
    pollMessage,
    broadcastPost(frame) {
      let n = 0;
      for (const mb of boxes.values()) { mb.link.sendPost(frame); n++; }
      return n;
    },
  };
}
