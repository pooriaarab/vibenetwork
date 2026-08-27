import { newId } from '@pooriaarab/vibe-core/ids';
import { MAX_TEXT_LEN, POST_TEXT_MAX, parseFrame } from './frame.js';
import { loadOrCreateIdentity } from './identity.js';
import { createPost } from './feed.js';
import type { Post } from './index.js';
import { normalizeHandle } from './state.js';

export function validateProfilePostBody(body: Record<string, unknown>): { ok: true; links: string[] | undefined } | { ok: false; error: string } {
  if (body['bio'] !== undefined && typeof body['bio'] !== 'string') return { ok: false, error: 'bio must be a string' };
  if (body['links'] !== undefined && !Array.isArray(body['links'])) return { ok: false, error: 'links must be an array of strings' };
  const links = Array.isArray(body['links']) ? body['links'].filter((l): l is string => typeof l === 'string') : undefined;
  return { ok: true, links };
}

export function validatePostText(text: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof text !== 'string') return { ok: false, error: 'missing text' };
  if (text.length === 0 || text.length > POST_TEXT_MAX) return { ok: false, error: `post text must be 1-${POST_TEXT_MAX} chars` };
  return { ok: true };
}

export function createPostFromText(text: string, dir: string): { post: Post } | { error: string } {
  const identity = loadOrCreateIdentity(dir);
  try {
    const post = createPost(identity, text);
    return { post };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid text' };
  }
}

export function validatePostFrame(frame: unknown): boolean {
  const reParsed = parseFrame(JSON.stringify(frame));
  return reParsed !== null && reParsed.t === 'post';
}

export function parseDmHandle(raw: string | null): { handle: string } | { error: string } {
  if (raw === null || raw.trim() === '') return { error: 'missing or invalid handle' };
  const h = normalizeHandle(raw);
  if (h === null) return { error: 'missing or invalid handle' };
  return { handle: h };
}

export function validateDmPostBody(body: Record<string, unknown>): { handle: string; text: string } | { error: string } {
  const handleRaw = typeof body['handle'] === 'string' ? body['handle'] : '';
  const dmHandle = normalizeHandle(handleRaw);
  if (dmHandle === null) return { error: 'missing or invalid handle' };
  const text = body['text'];
  if (typeof text !== 'string') return { error: 'missing text' };
  const reParsed = parseFrame(JSON.stringify({ t: 'msg', id: newId(), text, at: Date.now() }));
  if (reParsed === null || reParsed.t !== 'msg') return { error: 'invalid message text' };
  if (reParsed.text.length === 0 || reParsed.text.length > MAX_TEXT_LEN) return { error: 'invalid message text' };
  return { handle: dmHandle, text: reParsed.text };
}
