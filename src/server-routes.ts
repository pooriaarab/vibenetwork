import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Harness } from '@pooriaarab/vibe-core';
import { loadThread } from './dm.js';
import { postToFrame } from './feed.js';
import { validateProfilePostBody, validatePostText, createPostFromText, validatePostFrame, parseDmHandle, validateDmPostBody } from './server-route-helpers.js';
import type { FeedStore } from './feed.js';
import { follow, listFollows, resolveFollowedPubkeys, unfollow } from './follow.js';
import { MAX_TEXT_LEN, POST_TEXT_MAX, parseFrame } from './frame.js';
import { ensureHandle } from './handlegen.js';
import { loadOrCreateIdentity } from './identity.js';
import type { Post, Profile } from './index.js';
import { loadPeers } from './p2p.js';
import { createProfile, loadProfile, readUsage, updateProfile, type LocalUsageSnapshot } from './profile.js';
import { normalizeHandle } from './state.js';
import { sanitizePeerText } from '@pooriaarab/vibe-core/untrusted';
import { webAppHtml } from './web-app-html.js';
import type { NetBridge } from './server-bridge.js';

export interface HandleOpts {
  readonly dir: string;
  readonly feed: FeedStore;
  readonly bridge?: NetBridge;
  readonly usageReader?: (harness: Harness) => Promise<LocalUsageSnapshot>;
}

interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly pathname: string;
  readonly opts: HandleOpts;
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

async function readJson(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  const text = await readBody(req);
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, error: 'invalid JSON body' };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid JSON body' };
  }
}

function profilePayload(p: Profile | null): Record<string, unknown> {
  if (p === null) return { connected: false };
  return { connected: true, handle: p.handle, pubkey: p.pubkey, bio: p.bio, league: p.league, verified: p.verified, links: p.links, connectedAt: p.connectedAt };
}

function postPayload(post: Post, authorHandle: string | undefined, mine: boolean): Record<string, unknown> {
  return {
    id: post.id, text: sanitizePeerText(post.text), at: post.at, authorPubkey: post.authorPubkey,
    author: mine ? (authorHandle ?? '@you') : authorHandle !== undefined ? sanitizePeerText(authorHandle) : `@${post.authorPubkey.slice(0, 8)}…`,
    mine,
  };
}

async function handleRoot(ctx: RouteContext): Promise<boolean> {
  if (ctx.req.method !== 'GET' || ctx.pathname !== '/') return false;
  send(ctx.res, 200, 'text/html; charset=utf-8', webAppHtml);
  return true;
}

async function handleState(ctx: RouteContext): Promise<boolean> {
  const { req, pathname, res, opts } = ctx;
  if (req.method !== 'GET') return false;
  if (pathname !== '/api/state' && pathname !== '/api/profile') return false;
  sendJson(res, 200, profilePayload(loadProfile(opts.dir)));
  return true;
}

async function handleProfilePost(ctx: RouteContext): Promise<boolean> {
  if (ctx.req.method !== 'POST' || ctx.pathname !== '/api/profile') return false;
  if (loadProfile(ctx.opts.dir) === null) { sendJson(ctx.res, 409, { error: 'not connected' }); return true; }
  const body = await readJson(ctx.req);
  if (!body.ok) { sendJson(ctx.res, 400, { error: body.error }); return true; }
  const validated = validateProfilePostBody(body.value);
  if (!validated.ok) { sendJson(ctx.res, 400, { error: validated.error }); return true; }
  try {
    const updated = updateProfile({ ...(typeof body.value['bio'] === 'string' ? { bio: body.value['bio'] } : {}), ...(validated.links !== undefined ? { links: validated.links } : {}) }, ctx.opts.dir);
    sendJson(ctx.res, 200, profilePayload(updated));
  } catch (err) {
    sendJson(ctx.res, 400, { error: err instanceof Error ? err.message : 'invalid profile update' });
  }
  return true;
}

async function handleConnect(ctx: RouteContext): Promise<boolean> {
  if (ctx.req.method !== 'POST' || ctx.pathname !== '/api/connect') return false;
  const body = await readJson(ctx.req);
  if (!body.ok) { sendJson(ctx.res, 400, { error: body.error }); return true; }
  const harness = resolveHarness(body.value['harness']);
  const handleResult = resolveConnectHandle(body.value['handle'], ctx.opts.dir);
  if (handleResult.error !== null) { sendJson(ctx.res, 400, { error: handleResult.error }); return true; }
  const reader = ctx.opts.usageReader ?? ((h: Harness) => readUsage(h));
  const snapshot = await reader(harness);
  const profile = await createProfile({ handle: handleResult.handle, harness, dir: ctx.opts.dir, usageReader: async () => snapshot, ...(typeof body.value['bio'] === 'string' ? { bio: body.value['bio'] } : {}) });
  sendJson(ctx.res, 200, profilePayload(profile));
  return true;
}

function resolveHarness(raw: unknown): Harness {
  if (typeof raw === 'string' && raw.trim() !== '') return raw as Harness;
  return (process.env['VIBENETWORK_HARNESS'] as Harness | undefined) ?? 'claude-code';
}

function resolveConnectHandle(raw: unknown, dir: string): { handle: string; error: null } | { handle: string; error: string } {
  if (typeof raw === 'string' && raw.trim() !== '') {
    const canonical = normalizeHandle(raw);
    if (canonical === null) return { handle: '', error: 'invalid handle' };
    return { handle: canonical, error: null };
  }
  return { handle: ensureHandle(dir).handle, error: null };
}

async function handleFeed(ctx: RouteContext): Promise<boolean> {
  if (ctx.req.method !== 'GET' || ctx.pathname !== '/api/feed') return false;
  const profile = loadProfile(ctx.opts.dir);
  const all = ctx.url.searchParams.get('all') === '1' || ctx.url.searchParams.get('all') === 'true';
  const followed = resolveFollowedPubkeys(ctx.opts.dir);
  const posts = all ? ctx.opts.feed.list() : ctx.opts.feed.list().filter((p) => (profile !== null && p.authorPubkey === profile.pubkey) || followed.has(p.authorPubkey));
  const byPubkey = buildByPubkey(ctx.opts.dir, profile);
  sendJson(ctx.res, 200, { posts: posts.slice(0, 100).map((p) => postPayload(p, byPubkey.get(p.authorPubkey.toLowerCase()), profile !== null && p.authorPubkey === profile.pubkey)), all });
  return true;
}

function buildByPubkey(dir: string, profile: Profile | null): Map<string, string> {
  const m = new Map(loadPeers(dir).filter((p) => p.pubkey !== undefined).map((p) => {
    const pk = p.pubkey;
    if (pk === undefined) throw new Error('peer missing pubkey after filter');
    return [pk.toLowerCase(), p.handle] as const;
  }));
  if (profile !== null) m.set(profile.pubkey.toLowerCase(), profile.handle);
  return m;
}

async function handleWho(ctx: RouteContext): Promise<boolean> {
  if (ctx.req.method !== 'GET' || ctx.pathname !== '/api/who') return false;
  sendJson(ctx.res, 200, { peers: ctx.opts.bridge ? ctx.opts.bridge.peers : [] });
  return true;
}

async function handleFollowGet(ctx: RouteContext): Promise<boolean> {
  if (ctx.req.method !== 'GET') return false;
  if (ctx.pathname !== '/api/follow' && ctx.pathname !== '/api/follows') return false;
  sendJson(ctx.res, 200, { follows: listFollows(ctx.opts.dir) });
  return true;
}

function extractFollowTarget(body: Record<string, unknown>): string {
  if (typeof body['target'] === 'string') return body['target'];
  if (typeof body['handle'] === 'string') return body['handle'];
  if (typeof body['pubkey'] === 'string') return body['pubkey'];
  return '';
}

async function handleFollowPost(ctx: RouteContext): Promise<boolean> {
  if (ctx.req.method !== 'POST' || ctx.pathname !== '/api/follow') return false;
  const body = await readJson(ctx.req);
  if (!body.ok) { sendJson(ctx.res, 400, { error: body.error }); return true; }
  const targetRaw = extractFollowTarget(body.value);
  if (targetRaw.trim() === '') { sendJson(ctx.res, 400, { error: 'missing target' }); return true; }
  const doUnfollow = body.value['unfollow'] === true || body.value['op'] === 'unfollow';
  try {
    const result = doUnfollow ? unfollow(targetRaw, ctx.opts.dir) : follow(targetRaw, ctx.opts.dir);
    sendJson(ctx.res, 200, { follows: result.follows, changed: result.changed, unfollow: doUnfollow });
  } catch (err) {
    sendJson(ctx.res, 400, { error: err instanceof Error ? err.message : 'invalid target' });
  }
  return true;
}

async function handleUnfollow(ctx: RouteContext): Promise<boolean> {
  if (ctx.req.method !== 'POST' || ctx.pathname !== '/api/unfollow') return false;
  const body = await readJson(ctx.req);
  if (!body.ok) { sendJson(ctx.res, 400, { error: body.error }); return true; }
  const targetRaw = extractFollowTarget(body.value);
  if (targetRaw.trim() === '') { sendJson(ctx.res, 400, { error: 'missing target' }); return true; }
  try {
    const result = unfollow(targetRaw, ctx.opts.dir);
    sendJson(ctx.res, 200, { follows: result.follows, changed: result.changed, unfollow: true });
  } catch (err) {
    sendJson(ctx.res, 400, { error: err instanceof Error ? err.message : 'invalid target' });
  }
  return true;
}

async function handlePost(ctx: RouteContext): Promise<boolean> {
  if (ctx.req.method !== 'POST' || ctx.pathname !== '/api/post') return false;
  const profile = loadProfile(ctx.opts.dir);
  if (profile === null) { sendJson(ctx.res, 409, { error: 'not connected' }); return true; }
  const body = await readJson(ctx.req);
  if (!body.ok) { sendJson(ctx.res, 400, { error: body.error }); return true; }
  const textVal = validatePostText(body.value['text']);
  if (!textVal.ok) { sendJson(ctx.res, 400, { error: textVal.error }); return true; }
  const text = body.value['text'] as string;
  const created = createPostFromText(text, ctx.opts.dir);
  if ('error' in created) { sendJson(ctx.res, 400, { error: created.error }); return true; }
  const post = created.post;
  const frame = postToFrame(post);
  if (!validatePostFrame(frame)) { sendJson(ctx.res, 400, { error: 'invalid post' }); return true; }
  ctx.opts.feed.add(post);
  const postFrame = parseFrame(JSON.stringify(frame)) as import('./frame.js').PostFrame;
  const delivered = ctx.opts.bridge?.broadcastPost(postFrame) ?? 0;
  sendJson(ctx.res, 200, { ok: true, post: postPayload(post, profile.handle, true), delivered });
  return true;
}

async function handleDmGetWait(ctx: RouteContext, handle: string, bridge: import('./server-bridge.js').NetBridge | undefined): Promise<boolean> {
  if (bridge === undefined) { sendJson(ctx.res, 200, { message: null, reason: 'bridge-not-attached' }); return true; }
  const message = await bridge.pollMessage(handle, 25_000);
  if (ctx.req.destroyed || ctx.res.writableEnded) return true;
  sendJson(ctx.res, 200, { message: message ? { id: message.id, text: sanitizePeerText(message.text), at: message.at } : null });
  return true;
}

async function handleDmGet(ctx: RouteContext): Promise<boolean> {
  if (ctx.req.method !== 'GET' || ctx.pathname !== '/api/dm') return false;
  const parsed = parseDmHandle(ctx.url.searchParams.get('handle'));
  if ('error' in parsed) { sendJson(ctx.res, 400, { error: parsed.error }); return true; }
  const handle = parsed.handle;
  const wait = ctx.url.searchParams.get('wait') === '1' || ctx.url.searchParams.get('wait') === 'true';
  const bridge = ctx.opts.bridge;
  if (wait) return handleDmGetWait(ctx, handle, bridge);
  const online = bridge?.isOnline(handle) === true;
  const messages = loadThread(handle, ctx.opts.dir).map((m) => ({ id: m.id, direction: m.direction, text: sanitizePeerText(m.text), at: m.at }));
  sendJson(ctx.res, 200, { messages, online, handle });
  return true;
}

async function handleDmPost(ctx: RouteContext): Promise<boolean> {
  if (ctx.req.method !== 'POST' || ctx.pathname !== '/api/dm') return false;
  const body = await readJson(ctx.req);
  if (!body.ok) { sendJson(ctx.res, 400, { error: body.error }); return true; }
  const validated = validateDmPostBody(body.value);
  if ('error' in validated) { sendJson(ctx.res, 400, { error: validated.error }); return true; }
  const bridge = ctx.opts.bridge;
  if (bridge === undefined) { sendJson(ctx.res, 409, { error: 'peer not connected' }); return true; }
  const sent = bridge.sendMessage(validated.handle, validated.text);
  if (!sent) { sendJson(ctx.res, 409, { error: 'peer not connected' }); return true; }
  sendJson(ctx.res, 200, { ok: true });
  return true;
}

export interface Route {
  readonly handle: (ctx: RouteContext) => Promise<boolean>;
}

export const routes: readonly Route[] = [
  { handle: handleRoot },
  { handle: handleState },
  { handle: handleProfilePost },
  { handle: handleConnect },
  { handle: handleFeed },
  { handle: handleWho },
  { handle: handleFollowGet },
  { handle: handleFollowPost },
  { handle: handleUnfollow },
  { handle: handlePost },
  { handle: handleDmGet },
  { handle: handleDmPost },
];

export async function dispatch(req: IncomingMessage, res: ServerResponse, opts: HandleOpts): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const ctx: RouteContext = { req, res, url, pathname: url.pathname, opts };
  for (const route of routes) {
    if (await route.handle(ctx)) return;
  }
  sendJson(res, 404, { error: 'not found' });
}
