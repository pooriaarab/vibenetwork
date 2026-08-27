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
import http, { type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import type { Harness } from '@pooriaarab/vibe-core';
import { createFeedStore } from './feed.js';
import type { FeedStore } from './feed.js';
import { defaultStateDir } from './state.js';
import { dispatch } from './server-routes.js';
import type { HandleOpts } from './server-routes.js';
import { createNetBridge as bridgeFactory } from './server-bridge.js';
import type { NetBridge, NetPeerInfo, NetMessage, CreateNetBridgeOptions } from './server-bridge.js';

export type { NetPeerInfo, NetMessage, NetBridge, CreateNetBridgeOptions };
export { bridgeFactory as createNetBridge };

export interface StartServerOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly dir?: string;
  readonly bridge?: NetBridge;
  readonly feed?: FeedStore;
  readonly usageReader?: (harness: Harness) => Promise<import('./profile.js').LocalUsageSnapshot>;
}

export interface StartedServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(data));
}

export function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const hostname = opts.hostname ?? '127.0.0.1';
  const dir = opts.dir ?? defaultStateDir();
  const feed = opts.feed ?? createFeedStore(dir);
  const handleOpts: HandleOpts = { dir, feed, ...(opts.bridge !== undefined ? { bridge: opts.bridge } : {}), ...(opts.usageReader !== undefined ? { usageReader: opts.usageReader } : {}) };

  const server = http.createServer((req, res) =>
    dispatch(req, res, handleOpts).catch((err) => {
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
