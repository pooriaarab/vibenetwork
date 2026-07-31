/**
 * The local web app server. Node's built-in `http` only — no new deps.
 *
 * Routes (all localhost, all local data):
 *   GET  /                 -> the network UI (see ./web-app-html.ts)
 *   GET  /api/state        -> { connected, ...profile fields } (no raw usage)
 *   GET  /api/profile      -> same as /api/state
 *   POST /api/profile      -> edit bio / links (re-validated, capped)
 *   POST /api/connect      -> mint identity + profile from local usage
 *   GET  /api/feed         -> signed posts (followed + own; ?all=1 = firehose)
 *   GET  /api/who          -> presence roster from the attached NetBridge
 *   GET  /api/follow[s]    -> the local follow graph
 *   POST /api/follow       -> follow a @handle / pubkey
 *   POST /api/unfollow     -> unfollow
 *   POST /api/post         -> sign + store a post; push to live peers if bridged
 *   GET  /api/dm           -> thread snapshot {messages, online}, or long-poll
 *                           with ?wait=1 (mirrors vibedating /live/message)
 *   POST /api/dm           -> send an e2e DM over the peer's PeerLink
 *
 * Every browser-supplied payload is re-validated through the same allowlists
 * the wire uses (parseFrame / createPost / normalizeHandle / parseFollowTarget)
 * so the page can NEVER smuggle oversized text, extra keys, or unbound handles
 * onto the P2P connection or into local stores.
 */
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Harness } from '@pooriaarab/vibe-core';
import { loadThread, recordDm } from './dm.js';
import { createFeedStore, createPost, postToFrame } from './feed.js';
import type { FeedStore } from './feed.js';
import { follow, isFollowed, listFollows, resolveFollowedPubkeys, unfollow } from './follow.js';
import type { PostFrame } from './frame.js';
import { MAX_TEXT_LEN, POST_TEXT_MAX, parseFrame } from './frame.js';
import { ensureHandle } from './handlegen.js';
import { loadOrCreateIdentity } from './identity.js';
import type { Post, Profile } from './index.js';
import type { PeerLink } from './link.js';
import { loadPeers } from './p2p.js';
import {
  createProfile,
  loadProfile,
  readUsage,
  updateProfile,
  type LocalUsageSnapshot,
} from './profile.js';
import { defaultStateDir, normalizeHandle, sameHandle } from './state.js';
import { sanitizePeerText } from '@pooriaarab/vibe-core/untrusted';
import { webAppHtml } from './web-app-html.js';

/* -------------------------------------------------------------------------- */
/* Net bridge (browser <-> local server <-> PeerLink)                           */
/* -------------------------------------------------------------------------- */

/** A connected peer, as the web app needs to see it. */
export interface NetPeerInfo {
  readonly handle: string;
  readonly league: string;
  readonly harness: string;
  /** Self-asserted usage-verification flag from the peer's hello (✓). */
  readonly verified?: boolean;
  /** LOCAL-derived: the peer's hello signature verified against its key (🔑). */
  readonly identityVerified?: boolean;
  /** LOCAL: whether you follow this peer. */
  readonly followed: boolean;
}

/**
 * One text chat message relayed to/from a peer — the payload of a `msg` frame.
 * `id`/`at` are minted by the SENDER, never by the browser: the browser posts
 * only {handle, text} (see POST /api/dm).
 */
export interface NetMessage {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

/**
 * Bridge between the browser and live {@link PeerLink}s.
 *
 * The browser talks to the local server over HTTP (POST to send, long-poll to
 * receive); the server relays each DM to/from the matching peer's PeerLink and
 * push-broadcasts newly minted posts. MEDIA never touches the server.
 */
export interface NetBridge {
  /** Snapshot of currently-connected peers (with follow marks). */
  readonly peers: readonly NetPeerInfo[];
  /** Attach a freshly-handshaken PeerLink (from a presence session's onLink). */
  addLink(link: PeerLink): void;
  /** True when a live link is open for `handle`. */
  isOnline(handle: string): boolean;
  /** Send one text message (`msg` frame) to the peer identified by `handle`. */
  sendMessage(handle: string, text: string): boolean;
  /** Long-poll for the next incoming text message from `handle`. */
  pollMessage(handle: string, timeoutMs: number): Promise<NetMessage | null>;
  /** Push a signed post frame to every currently-connected peer. */
  broadcastPost(frame: PostFrame): number;
}

interface PeerMailbox {
  readonly link: PeerLink;
  /** Incoming text messages from this peer, drained by the browser long-poll. */
  readonly messages: NetMessage[];
}

/**
 * Cap on queued incoming messages per peer — beyond it the OLDEST are dropped.
 * A chatty peer can't grow memory without bound when the browser never polls.
 * (parseFrame already caps each text at MAX_TEXT_LEN.)
 */
const MAX_QUEUED_MESSAGES = 200;

export interface CreateNetBridgeOptions {
  /** State dir for the feed store + follow lookups. Defaults to ~/.vibenetwork. */
  readonly dir?: string;
  /** Injected feed store (tests). Defaults to createFeedStore(dir). */
  readonly feed?: FeedStore;
}

/**
 * Build a {@link NetBridge}. Holds no network of its own; callers attach
 * PeerLinks from a presence session via {@link NetBridge.addLink}.
 */
export function createNetBridge(opts: CreateNetBridgeOptions = {}): NetBridge {
  const dir = opts.dir ?? defaultStateDir();
  const feed = opts.feed ?? createFeedStore(dir);
  /** Keyed by canonical '@handle' when normalizable, else the raw hello handle. */
  const boxes = new Map<string, PeerMailbox>();

  const keyFor = (handle: string): string => normalizeHandle(handle) ?? handle;

  const lookup = (handle: string): PeerMailbox | undefined => {
    const direct = boxes.get(keyFor(handle));
    if (direct) return direct;
    // Fallback: sameHandle scan (hellos may or may not carry a leading '@').
    for (const [k, mb] of boxes) {
      if (sameHandle(k, handle) || sameHandle(mb.link.hello.handle, handle)) return mb;
    }
    return undefined;
  };

  const bridge: NetBridge = {
    get peers(): readonly NetPeerInfo[] {
      // Built field-by-field from the hello — the browser gets exactly the
      // display shape, never identity proof material or anything else the link holds.
      return [...boxes.values()]
        .map((m) => {
          const h = m.link.hello;
          const handle = keyFor(h.handle);
          return {
            handle,
            league: h.league,
            harness: h.harness,
            ...(h.verified !== undefined ? { verified: h.verified } : {}),
            ...(h.identityVerified !== undefined ? { identityVerified: h.identityVerified } : {}),
            followed: isFollowed(handle, dir),
          };
        })
        .sort((a, b) => a.handle.localeCompare(b.handle));
    },
    addLink(link) {
      const handle = keyFor(link.hello.handle);
      boxes.set(handle, { link, messages: [] });
      // Feed sync both ways on connect (bounded by FEED_SYNC_COUNT).
      for (const p of feed.recent()) link.sendPost(postToFrame(p));
      link.onPost((frame) => feed.addFrame(frame));
      // Text messages → mailbox, capped (see MAX_QUEUED_MESSAGES).
      link.onMessage((m) => {
        const mb = boxes.get(handle);
        if (!mb) return;
        // input-safety: peer text is UNTRUSTED display data — sanitized at ingress
        // (the web app renders via textContent too — defense in depth).
        const text = sanitizePeerText(m.text);
        mb.messages.push({ id: m.id, text, at: m.at });
        // Persist the inbound DM thread locally.
        recordDm(handle, { direction: 'in', text, at: m.at }, dir);
        if (mb.messages.length > MAX_QUEUED_MESSAGES) {
          mb.messages.splice(0, mb.messages.length - MAX_QUEUED_MESSAGES);
        }
      });
      link.onClose(() => {
        // Only drop the entry if THIS link is still the current one for the
        // handle (a reconnect may have already replaced it).
        const cur = boxes.get(handle);
        if (cur && cur.link === link) boxes.delete(handle);
      });
    },
    isOnline(handle) {
      return lookup(handle) !== undefined;
    },
    sendMessage(handle, text) {
      const mb = lookup(handle);
      if (!mb) return false;
      mb.link.send(text);
      // Record outbound in the local DM thread.
      recordDm(keyFor(handle), { direction: 'out', text }, dir);
      return true;
    },
    async pollMessage(handle, timeoutMs) {
      const key = keyFor(handle);
      const mb = lookup(handle);
      if (!mb) return null;
      if (mb.messages.length > 0) return mb.messages.shift() ?? null;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const cur = boxes.get(key) ?? lookup(handle);
        if (!cur) return null; // peer vanished mid-poll
        if (cur.messages.length > 0) return cur.messages.shift() ?? null;
      }
      return null;
    },
    broadcastPost(frame) {
      let n = 0;
      for (const mb of boxes.values()) {
        mb.link.sendPost(frame);
        n++;
      }
      return n;
    },
  };
  return bridge;
}

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

export interface StartServerOptions {
  /** Port to bind; 0 (default) lets the OS pick a free one. */
  readonly port?: number;
  /** Hostname; defaults to 127.0.0.1 (loopback only). */
  readonly hostname?: string;
  /** Override the state directory (tests). Defaults to ~/.vibenetwork. */
  readonly dir?: string;
  /** Optional live-peers bridge. When set, /api/who + /api/dm are live. */
  readonly bridge?: NetBridge;
  /** Injected feed store (tests). Defaults to createFeedStore(dir). */
  readonly feed?: FeedStore;
  /** Injected usage reader (tests). Defaults to {@link readUsage}. */
  readonly usageReader?: (harness: Harness) => Promise<LocalUsageSnapshot>;
}

export interface StartedServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(
  req: IncomingMessage,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  const text = await readBody(req);
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'invalid JSON body' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid JSON body' };
  }
}

/** JSON shape of a profile response — never includes raw usage. */
function profilePayload(p: Profile | null): Record<string, unknown> {
  if (p === null) return { connected: false };
  return {
    connected: true,
    handle: p.handle,
    pubkey: p.pubkey,
    bio: p.bio,
    league: p.league,
    verified: p.verified,
    links: p.links,
    connectedAt: p.connectedAt,
  };
}

/** Display shape of a post for the web app (handle resolved when possible). */
function postPayload(
  post: Post,
  authorHandle: string | undefined,
  mine: boolean,
): Record<string, unknown> {
  return {
    id: post.id,
    text: sanitizePeerText(post.text),
    at: post.at,
    authorPubkey: post.authorPubkey,
    author: mine
      ? (authorHandle ?? '@you')
      : authorHandle !== undefined
        ? sanitizePeerText(authorHandle)
        : `@${post.authorPubkey.slice(0, 8)}…`,
    mine,
  };
}

/**
 * Start the local server. Resolves once listening; the returned `server` keeps
 * the process alive until `server.close()` is called.
 */
export function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const hostname = opts.hostname ?? '127.0.0.1';
  const dir = opts.dir ?? defaultStateDir();
  // One shared feed store for this server lifetime so POSTs are visible to GET
  // /api/feed and to the bridge without re-reading disk every request.
  const feed = opts.feed ?? createFeedStore(dir);

  const server = http.createServer((req, res) =>
    handle(req, res, { ...opts, dir, feed }).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
    }),
  );

  return new Promise<StartedServer>((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port ?? 0, hostname, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
      resolve({ server, port, url: `http://${hostname}:${port}` });
    });
  });
}

interface HandleOpts extends StartServerOptions {
  readonly dir: string;
  readonly feed: FeedStore;
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: HandleOpts): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const dir = opts.dir;
  const feed = opts.feed;

  if (req.method === 'GET' && pathname === '/') {
    send(res, 200, 'text/html; charset=utf-8', webAppHtml);
    return;
  }

  /* ---- state / profile ---------------------------------------------------- */
  if (req.method === 'GET' && (pathname === '/api/state' || pathname === '/api/profile')) {
    sendJson(res, 200, profilePayload(loadProfile(dir)));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/profile') {
    const existing = loadProfile(dir);
    if (!existing) {
      sendJson(res, 409, { error: 'not connected' });
      return;
    }
    const body = await readJson(req);
    if (!body.ok) {
      sendJson(res, 400, { error: body.error });
      return;
    }
    // Only bio / links are editable here. Types re-checked before updateProfile
    // (which also cleanBio/cleanLinks).
    if (body.value['bio'] !== undefined && typeof body.value['bio'] !== 'string') {
      sendJson(res, 400, { error: 'bio must be a string' });
      return;
    }
    if (body.value['links'] !== undefined && !Array.isArray(body.value['links'])) {
      sendJson(res, 400, { error: 'links must be an array of strings' });
      return;
    }
    const links = Array.isArray(body.value['links'])
      ? body.value['links'].filter((l): l is string => typeof l === 'string')
      : undefined;
    try {
      const updated = updateProfile(
        {
          ...(typeof body.value['bio'] === 'string' ? { bio: body.value['bio'] } : {}),
          ...(links !== undefined ? { links } : {}),
        },
        dir,
      );
      sendJson(res, 200, profilePayload(updated));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid profile update' });
    }
    return;
  }

  /* ---- connect ------------------------------------------------------------ */
  if (req.method === 'POST' && pathname === '/api/connect') {
    const body = await readJson(req);
    if (!body.ok) {
      sendJson(res, 400, { error: body.error });
      return;
    }
    const harnessRaw = body.value['harness'];
    const harness: Harness =
      typeof harnessRaw === 'string' && harnessRaw.trim() !== ''
        ? (harnessRaw as Harness)
        : ((process.env['VIBENETWORK_HARNESS'] as Harness | undefined) ?? 'claude-code');

    // Explicit handle in the body wins; otherwise ensureHandle mints a memetic
    // one on first run (never silently ship as @you).
    let handle: string;
    if (typeof body.value['handle'] === 'string' && body.value['handle'].trim() !== '') {
      const canonical = normalizeHandle(body.value['handle']);
      if (canonical === null) {
        sendJson(res, 400, { error: 'invalid handle' });
        return;
      }
      handle = canonical;
    } else {
      handle = ensureHandle(dir).handle;
    }

    // Usage is read LOCALLY; only the league bucket + verified flag persist.
    // Injectable reader keeps tests hermetic (no real harness log scans).
    const reader = opts.usageReader ?? ((h: Harness) => readUsage(h));
    const snapshot = await reader(harness);
    const profile = await createProfile({
      handle,
      harness,
      dir,
      usageReader: async () => snapshot,
      ...(typeof body.value['bio'] === 'string' ? { bio: body.value['bio'] } : {}),
    });
    sendJson(res, 200, profilePayload(profile));
    return;
  }

  /* ---- feed --------------------------------------------------------------- */
  if (req.method === 'GET' && pathname === '/api/feed') {
    const profile = loadProfile(dir);
    const all = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true';
    const followed = resolveFollowedPubkeys(dir);
    const posts = all
      ? feed.list()
      : feed
          .list()
          .filter(
            (p) =>
              (profile !== null && p.authorPubkey === profile.pubkey) ||
              followed.has(p.authorPubkey),
          );
    const byPubkey = new Map(
      loadPeers(dir)
        .filter((p) => p.pubkey !== undefined)
        .map((p) => [p.pubkey!.toLowerCase(), p.handle]),
    );
    if (profile) byPubkey.set(profile.pubkey.toLowerCase(), profile.handle);
    sendJson(res, 200, {
      posts: posts.slice(0, 100).map((p) =>
        postPayload(
          p,
          byPubkey.get(p.authorPubkey.toLowerCase()),
          profile !== null && p.authorPubkey === profile.pubkey,
        ),
      ),
      all,
    });
    return;
  }

  /* ---- who (presence roster) --------------------------------------------- */
  if (req.method === 'GET' && pathname === '/api/who') {
    const bridge = opts.bridge;
    sendJson(res, 200, { peers: bridge ? bridge.peers : [] });
    return;
  }

  /* ---- follow graph ------------------------------------------------------- */
  if (req.method === 'GET' && (pathname === '/api/follow' || pathname === '/api/follows')) {
    sendJson(res, 200, { follows: listFollows(dir) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/follow') {
    const body = await readJson(req);
    if (!body.ok) {
      sendJson(res, 400, { error: body.error });
      return;
    }
    // Accept `target` or `handle` (or `pubkey`) from the browser; re-validate
    // through follow()/unfollow() which run parseFollowTarget.
    const targetRaw =
      typeof body.value['target'] === 'string'
        ? body.value['target']
        : typeof body.value['handle'] === 'string'
          ? body.value['handle']
          : typeof body.value['pubkey'] === 'string'
            ? body.value['pubkey']
            : '';
    if (targetRaw.trim() === '') {
      sendJson(res, 400, { error: 'missing target' });
      return;
    }
    const doUnfollow = body.value['unfollow'] === true || body.value['op'] === 'unfollow';
    try {
      const result = doUnfollow ? unfollow(targetRaw, dir) : follow(targetRaw, dir);
      sendJson(res, 200, {
        follows: result.follows,
        changed: result.changed,
        unfollow: doUnfollow,
      });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid target' });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/unfollow') {
    const body = await readJson(req);
    if (!body.ok) {
      sendJson(res, 400, { error: body.error });
      return;
    }
    const targetRaw =
      typeof body.value['target'] === 'string'
        ? body.value['target']
        : typeof body.value['handle'] === 'string'
          ? body.value['handle']
          : typeof body.value['pubkey'] === 'string'
            ? body.value['pubkey']
            : '';
    if (targetRaw.trim() === '') {
      sendJson(res, 400, { error: 'missing target' });
      return;
    }
    try {
      const result = unfollow(targetRaw, dir);
      sendJson(res, 200, { follows: result.follows, changed: result.changed, unfollow: true });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid target' });
    }
    return;
  }

  /* ---- publish a signed post --------------------------------------------- */
  if (req.method === 'POST' && pathname === '/api/post') {
    const profile = loadProfile(dir);
    if (!profile) {
      sendJson(res, 409, { error: 'not connected' });
      return;
    }
    const body = await readJson(req);
    if (!body.ok) {
      sendJson(res, 400, { error: body.error });
      return;
    }
    const text = body.value['text'];
    if (typeof text !== 'string') {
      sendJson(res, 400, { error: 'missing text' });
      return;
    }
    // Re-validate through createPost (length + type) AND the wire allowlist:
    // build the frame, then re-parse it so only allowlisted fields ever leave.
    // Extra keys on the browser body cannot leak into the signed post.
    if (text.length === 0 || text.length > POST_TEXT_MAX) {
      sendJson(res, 400, { error: `post text must be 1-${POST_TEXT_MAX} chars` });
      return;
    }
    const identity = loadOrCreateIdentity(dir);
    let post: Post;
    try {
      post = createPost(identity, text);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid text' });
      return;
    }
    const frame = postToFrame(post);
    const reParsed = parseFrame(JSON.stringify(frame));
    if (reParsed === null || reParsed.t !== 'post') {
      sendJson(res, 400, { error: 'invalid post' });
      return;
    }
    feed.add(post);
    const delivered = opts.bridge?.broadcastPost(reParsed) ?? 0;
    sendJson(res, 200, {
      ok: true,
      post: postPayload(post, profile.handle, true),
      delivered,
    });
    return;
  }

  /* ---- DM bridge ---------------------------------------------------------- */
  // GET /api/dm?handle=<peer>
  //   - default: thread snapshot { messages, online }
  //   - ?wait=1: long-poll for the next inbound message { message }
  if (req.method === 'GET' && pathname === '/api/dm') {
    const handleRaw = url.searchParams.get('handle') ?? '';
    if (handleRaw.trim() === '') {
      sendJson(res, 400, { error: 'missing or invalid handle' });
      return;
    }
    const handle = normalizeHandle(handleRaw);
    if (handle === null) {
      sendJson(res, 400, { error: 'missing or invalid handle' });
      return;
    }
    const wait =
      url.searchParams.get('wait') === '1' || url.searchParams.get('wait') === 'true';
    const bridge = opts.bridge;
    const online = bridge?.isOnline(handle) === true;

    if (wait) {
      if (!bridge) {
        sendJson(res, 200, { message: null, reason: 'bridge-not-attached' });
        return;
      }
      const message = await bridge.pollMessage(handle, 25_000);
      // The client may have hung up while we were long-polling — don't write
      // to a dead socket.
      if (req.destroyed || res.writableEnded) return;
      sendJson(res, 200, {
        message: message
          ? { id: message.id, text: sanitizePeerText(message.text), at: message.at }
          : null,
      });
      return;
    }

    // Thread snapshot (local history + online flag). Sanitized for display.
    const messages = loadThread(handle, dir).map((m) => ({
      id: m.id,
      direction: m.direction,
      text: sanitizePeerText(m.text),
      at: m.at,
    }));
    sendJson(res, 200, { messages, online, handle });
    return;
  }

  // POST /api/dm  {handle, text} — relay one text message from the browser to
  // the peer's PeerLink. The text is round-tripped through parseFrame's
  // allowlist as a real `msg` frame BEFORE it reaches the wire.
  if (req.method === 'POST' && pathname === '/api/dm') {
    const body = await readJson(req);
    if (!body.ok) {
      sendJson(res, 400, { error: body.error });
      return;
    }
    const handleRaw = typeof body.value['handle'] === 'string' ? body.value['handle'] : '';
    const handle = normalizeHandle(handleRaw);
    if (handle === null) {
      sendJson(res, 400, { error: 'missing or invalid handle' });
      return;
    }
    const text = body.value['text'];
    if (typeof text !== 'string') {
      sendJson(res, 400, { error: 'missing text' });
      return;
    }
    // Build the exact frame this text would ride on and re-parse it through
    // the allowlist — empty / oversized / non-string never reaches the PeerLink.
    // id + at are minted HERE; the browser supplies text only.
    const reParsed = parseFrame(
      JSON.stringify({ t: 'msg', id: randomUUID(), text, at: Date.now() }),
    );
    if (reParsed === null || reParsed.t !== 'msg') {
      sendJson(res, 400, { error: 'invalid message text' });
      return;
    }
    if (reParsed.text.length === 0 || reParsed.text.length > MAX_TEXT_LEN) {
      sendJson(res, 400, { error: 'invalid message text' });
      return;
    }
    const bridge = opts.bridge;
    if (!bridge) {
      sendJson(res, 409, { error: 'peer not connected' });
      return;
    }
    const sent = bridge.sendMessage(handle, reParsed.text);
    if (!sent) {
      sendJson(res, 409, { error: 'peer not connected' });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
