/** Live-session wire frames. Newline-JSON over the hyperswarm socket.
 *  Same allowlist discipline as p2p.parseHandshake: build results key-by-key,
 *  cap sizes, drop unknown frame types — a peer can never leak extra fields. */
export const MAX_TEXT_LEN = 4000;
const MAX_ID_LEN = 64;
/** Largest base64 payload permitted in a single `media-chunk` frame. */
export const MAX_B64_CHUNK_LEN = 16 * 1024; // 16 KiB
/** Largest total media transfer permitted (`media-start.size`, and reassembly). */
export const MAX_MEDIA_SIZE = 25 * 1024 * 1024; // 25 MiB
/** Largest `media-start.mime` string accepted. */
export const MAX_MIME_LEN = 128;
/** Largest `media-start.name` string accepted. */
export const MAX_NAME_LEN = 256;
/** Largest `sdp` string accepted on an `rtc-offer` / `rtc-answer` frame.
 *  Browser SDP blobs are typically 1-4 KiB; 64 KiB is a generous ceiling that
 *  still keeps a single signaling line cheap to buffer and parse. */
export const MAX_SDP_LEN = 64 * 1024; // 64 KiB
/** Largest `candidate` string accepted on an `rtc-ice` frame. ICE candidate
 *  lines are tiny (<1 KiB); 4 KiB is a generous ceiling. */
export const MAX_CANDIDATE_LEN = 4 * 1024; // 4 KiB
/**
 * Per-line cap sized to admit the LARGEST legal frame AFTER JSON escaping:
 *  - a max `rtc-offer` / `rtc-answer` carries a MAX_SDP_LEN-char sdp, which
 *    JSON.stringify can AT MOST double (every char escaped, e.g. CR/LF → \r\n),
 *    so its worst-case wire form is ~2*MAX_SDP_LEN bytes plus the wrapper;
 *  - a max `media-chunk` is ~MAX_B64_CHUNK_LEN chars of base64 (no escaping —
 *    base64 contains no quotes / backslashes / control bytes).
 * The ceiling is therefore the doubled SDP plus generous wrapper/overhead
 * slack. Raised from `MAX_B64_CHUNK_LEN + 1024` specifically so a full 64 KiB
 * sdp offer or answer (the live A/V signaling payload) is always admissible on
 * the wire — without that, an sdp full of CRLF line endings would be rejected
 * at the line-length gate before parseFrame ever saw it.
 */
const MAX_FRAME_LEN = Math.max(MAX_B64_CHUNK_LEN, 2 * MAX_SDP_LEN) + 2048;

/** Exact hex length of an ed25519 raw public key on a `hello` frame. */
export const HELLO_PUBKEY_HEX_LEN = 64;
/** Exact hex length of an ed25519 signature on a `hello` frame. */
export const HELLO_SIG_HEX_LEN = 128;
/** Largest hex nonce accepted on a `hello` frame (16 random bytes = 32). */
export const MAX_HELLO_NONCE_HEX_LEN = 64;

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

/** Convenience union of the three WebRTC signaling frame types (offer / answer
 *  / ice). Live A/V runs in the BROWSER via a native RTCPeerConnection; these
 *  frames only RELAY signaling over the P2P socket — no media bytes, no native
 *  WebRTC dependency in the CLI. */
export type RtcFrame = Extract<Frame, { t: `rtc-${string}` }>;

export function serializeFrame(f: Frame): string {
  return JSON.stringify(f);
}

export function parseFrame(raw: string | Buffer): Frame | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length > MAX_FRAME_LEN) return null;
  let d: unknown;
  try { d = JSON.parse(text); } catch { return null; }
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
  const r = d as Record<string, unknown>;
  switch (r['t']) {
    case 'bye': return { t: 'bye' };
    case 'typing': return { t: 'typing' };
    case 'hello': {
      const { handle, league, harness } = r;
      if (typeof handle !== 'string' || typeof league !== 'string') return null;
      // `verified` is optional (legacy peers omit it) but strictly boolean when
      // present — it is the self-asserted usage-verification flag, carried so
      // same-league peers can show an honest ✓ / ~ mark.
      const verified = r['verified'];
      if (verified !== undefined && typeof verified !== 'boolean') return null;
      // Identity proof is optional too (legacy peers), but when any of it is
      // present it must be exactly-shaped hex: a malformed claim is a broken or
      // hostile peer, and the whole frame is dropped. Whether a well-formed
      // claim actually VERIFIES is decided one layer up (identity.ts).
      const pubkey = r['pubkey'];
      if (
        pubkey !== undefined &&
        (typeof pubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(pubkey))
      )
        return null;
      const nonce = r['nonce'];
      if (
        nonce !== undefined &&
        (typeof nonce !== 'string' || !/^[0-9a-fA-F]{1,64}$/.test(nonce))
      )
        return null;
      const sig = r['sig'];
      if (
        sig !== undefined &&
        (typeof sig !== 'string' || !/^[0-9a-fA-F]{128}$/.test(sig))
      )
        return null;
      return {
        t: 'hello',
        handle,
        league,
        harness: typeof harness === 'string' ? harness : 'unknown',
        ...(typeof verified === 'boolean' ? { verified } : {}),
        ...(typeof pubkey === 'string' ? { pubkey } : {}),
        ...(typeof nonce === 'string' ? { nonce } : {}),
        ...(typeof sig === 'string' ? { sig } : {}),
      };
    }
    case 'msg': {
      const id = r['id']; const txt = r['text']; const at = r['at'];
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return null;
      if (typeof txt !== 'string' || txt.length === 0 || txt.length > MAX_TEXT_LEN) return null;
      if (typeof at !== 'number' || !Number.isFinite(at)) return null;
      return { t: 'msg', id, text: txt, at };
    }
    case 'media-start': {
      const id = r['id']; const mime = r['mime']; const size = r['size']; const name = r['name'];
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return null;
      if (typeof mime !== 'string' || mime.length > MAX_MIME_LEN) return null;
      if (typeof name !== 'string' || name.length > MAX_NAME_LEN) return null;
      // size is a byte count: finite, a non-negative integer, within the cap.
      if (
        typeof size !== 'number' ||
        !Number.isFinite(size) ||
        !Number.isInteger(size) ||
        size < 0 ||
        size > MAX_MEDIA_SIZE
      )
        return null;
      return { t: 'media-start', id, mime, size, name };
    }
    case 'media-chunk': {
      const id = r['id']; const seq = r['seq']; const b64 = r['b64'];
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return null;
      // seq is an index: finite, a non-negative integer.
      if (typeof seq !== 'number' || !Number.isFinite(seq) || !Number.isInteger(seq) || seq < 0)
        return null;
      if (typeof b64 !== 'string' || b64.length === 0 || b64.length > MAX_B64_CHUNK_LEN) return null;
      return { t: 'media-chunk', id, seq, b64 };
    }
    case 'media-end': {
      const id = r['id'];
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return null;
      return { t: 'media-end', id };
    }
    case 'rtc-offer': {
      const sdp = r['sdp'];
      if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP_LEN) return null;
      return { t: 'rtc-offer', sdp };
    }
    case 'rtc-answer': {
      const sdp = r['sdp'];
      if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > MAX_SDP_LEN) return null;
      return { t: 'rtc-answer', sdp };
    }
    case 'rtc-ice': {
      const candidate = r['candidate'];
      // An empty candidate string is a legal trickle-ICE "end of gathering"
      // marker, so only the upper bound is enforced here (no minimum length).
      if (typeof candidate !== 'string' || candidate.length > MAX_CANDIDATE_LEN) return null;
      return { t: 'rtc-ice', candidate };
    }
    default: return null;
  }
}
