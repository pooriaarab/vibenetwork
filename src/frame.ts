/** Live-session wire frames. Newline-JSON over the hyperswarm socket.
 *  Same allowlist discipline as p2p.parseHandshake: build results key-by-key,
 *  cap sizes, drop unknown frame types — a peer can never leak extra fields. */
import {
  defineFrames,
  str,
  optStr,
  num,
  optBool,
  MAX_B64_CHUNK_LEN,
  MAX_MEDIA_SIZE,
  MAX_MIME_LEN,
  MAX_NAME_LEN,
  HELLO_PUBKEY_HEX_LEN,
  HELLO_SIG_HEX_LEN,
  MAX_HELLO_NONCE_HEX_LEN,
  MAX_ID_LEN,
  type FieldSpec,
  type FieldDecodeResult
} from '@pooriaarab/vibe-core/frame';

export {
  MAX_B64_CHUNK_LEN,
  MAX_MEDIA_SIZE,
  MAX_MIME_LEN,
  MAX_NAME_LEN,
  HELLO_PUBKEY_HEX_LEN,
  HELLO_SIG_HEX_LEN,
  MAX_HELLO_NONCE_HEX_LEN
};

export const MAX_TEXT_LEN = 4000;
/** Largest sdp string accepted on an rtc-offer / rtc-answer frame. */
export const MAX_SDP_LEN = 64 * 1024; // 64 KiB
/** Largest candidate string accepted on an rtc-ice frame. */
export const MAX_CANDIDATE_LEN = 4 * 1024; // 4 KiB
const MAX_FRAME_LEN = Math.max(MAX_B64_CHUNK_LEN, 2 * MAX_SDP_LEN) + 2048;

export const POST_TEXT_MAX = 500;
export const POST_ID_HEX_LEN = 64;
export const POST_AUTHOR_HEX_LEN = 64;
export const POST_SIG_HEX_LEN = 128;

export type Frame =
  | {
      t: 'hello';
      handle: string;
      league: string;
      harness: string;
      verified?: boolean;
      pubkey?: string;
      nonce?: string;
      sig?: string;
    }
  | { t: 'msg'; id: string; text: string; at: number }
  | { t: 'post'; id: string; author: string; text: string; at: number; sig: string }
  | { t: 'typing' }
  | { t: 'bye' }
  | { t: 'media-start'; id: string; mime: string; size: number; name: string }
  | { t: 'media-chunk'; id: string; seq: number; b64: string }
  | { t: 'media-end'; id: string }
  | { t: 'rtc-offer'; sdp: string }
  | { t: 'rtc-answer'; sdp: string }
  | { t: 'rtc-ice'; candidate: string };

/** Convenience union of the three media-transfer frame types. */
export type MediaFrame = Extract<Frame, { t: `media-${string}` }>;

/** The signed feed-post frame (see feed.ts for the sign/verify scheme). */
export type PostFrame = Extract<Frame, { t: 'post' }>;

/** Convenience union of the three WebRTC signaling frame types (offer / answer
 *  / ice). Live A/V runs in the BROWSER via a native RTCPeerConnection; these
 *  frames only RELAY signaling over the P2P socket — no media bytes, no native
 *  WebRTC dependency in the CLI. */
export type RtcFrame = Extract<Frame, { t: `rtc-${string}` }>;

const legacyHarnessSpec: FieldSpec<string> = {
  optional: false,
  decode: (raw: Record<string, unknown>): FieldDecodeResult<string> => {
    const v = raw['harness'];
    return { ok: true, value: typeof v === 'string' ? v : 'unknown' };
  }
};

const codec = defineFrames(
  [
    {
      t: 'hello',
      fields: {
        handle: str('handle'),
        league: str('league'),
        harness: legacyHarnessSpec,
        verified: optBool('verified'),
        pubkey: optStr('pubkey', { minLen: HELLO_PUBKEY_HEX_LEN, maxLen: HELLO_PUBKEY_HEX_LEN, pattern: /^[0-9a-fA-F]{64}$/ }),
        nonce: optStr('nonce', { minLen: 1, maxLen: MAX_HELLO_NONCE_HEX_LEN, pattern: /^[0-9a-fA-F]{1,64}$/ }),
        sig: optStr('sig', { minLen: HELLO_SIG_HEX_LEN, maxLen: HELLO_SIG_HEX_LEN, pattern: /^[0-9a-fA-F]{128}$/ }),
      },
    },
    {
      t: 'msg',
      fields: {
        id: str('id', { minLen: 1, maxLen: MAX_ID_LEN }),
        text: str('text', { minLen: 1, maxLen: MAX_TEXT_LEN }),
        at: num('at'),
      },
    },
    {
      t: 'post',
      fields: {
        id: str('id', { minLen: POST_ID_HEX_LEN, maxLen: POST_ID_HEX_LEN, pattern: /^[0-9a-fA-F]{64}$/ }),
        author: str('author', { minLen: POST_AUTHOR_HEX_LEN, maxLen: POST_AUTHOR_HEX_LEN, pattern: /^[0-9a-fA-F]{64}$/ }),
        text: str('text', { minLen: 1, maxLen: POST_TEXT_MAX }),
        at: num('at', { min: 0 }),
        sig: str('sig', { minLen: POST_SIG_HEX_LEN, maxLen: POST_SIG_HEX_LEN, pattern: /^[0-9a-fA-F]{128}$/ }),
      },
    },
    { t: 'typing', fields: {} },
    { t: 'bye', fields: {} },
    {
      t: 'media-start',
      fields: {
        id: str('id', { minLen: 1, maxLen: MAX_ID_LEN }),
        mime: str('mime', { maxLen: MAX_MIME_LEN }),
        size: num('size', { min: 0, max: MAX_MEDIA_SIZE, integer: true }),
        name: str('name', { maxLen: MAX_NAME_LEN }),
      },
    },
    {
      t: 'media-chunk',
      fields: {
        id: str('id', { minLen: 1, maxLen: MAX_ID_LEN }),
        seq: num('seq', { min: 0, integer: true }),
        b64: str('b64', { minLen: 1, maxLen: MAX_B64_CHUNK_LEN }),
      },
    },
    {
      t: 'media-end',
      fields: {
        id: str('id', { minLen: 1, maxLen: MAX_ID_LEN }),
      },
    },
    {
      t: 'rtc-offer',
      fields: {
        sdp: str('sdp', { minLen: 1, maxLen: MAX_SDP_LEN }),
      },
    },
    {
      t: 'rtc-answer',
      fields: {
        sdp: str('sdp', { minLen: 1, maxLen: MAX_SDP_LEN }),
      },
    },
    {
      t: 'rtc-ice',
      fields: {
        candidate: str('candidate', { maxLen: MAX_CANDIDATE_LEN }),
      },
    },
  ] as const,
  { maxFrameLen: MAX_FRAME_LEN }
);

export function serializeFrame(f: Frame): string {
  return codec.serialize(f as unknown as Parameters<typeof codec.serialize>[0]);
}

export function parseFrame(raw: string | Buffer): Frame | null {
  return codec.parse(raw) as Frame | null;
}
