/**
 * PeerLink — one live peer connection, framed.
 *
 * Wraps the hyperswarm `socket` (a Duplex) behind a tiny chat surface:
 *   - {@link PeerLink.send} writes a `msg` frame,
 *   - {@link PeerLink.onMessage} receives every `msg` frame the peer sends,
 *   - {@link PeerLink.onClose} fires when the peer hangs up (a `bye` frame,
 *     or the socket ending),
 *   - {@link PeerLink.close} is the omegle "next": writes `bye`, then ends.
 *   - {@link PeerLink.sendMedia} / {@link PeerLink.onMedia} move chunked files,
 *   - {@link PeerLink.sendSignal} / {@link PeerLink.onSignal} relay the three
 *     `rtc-*` WebRTC signaling frames (offer / answer / ice). Live A/V itself
 *     runs in the browser; these only ferry signaling over the P2P socket.
 *
 * Everything on the wire goes through {@link parseFrame}'s allowlist, so a peer
 * can never smuggle extra fields onto a `msg` (and thus never a raw-usage field).
 * The same allowlist guards every `media-*` frame, so the file-transfer path
 * inherits the exact same invariant.
 *
 * The hello handshake has already happened by the time a link exists —
 * `hello` is the validated peer identity, captured at construction. The
 * connection handler may hand any leftover bytes (after the hello line) in
 * `initialBuffer` so frames sent immediately after hello are not lost.
 */
import { newId } from '@pooriaarab/vibe-core/ids';
import type { Duplex } from 'node:stream';
import {
  parseFrame,
  serializeFrame,
  type Frame,
  type MediaFrame,
  type PostFrame,
  type RtcFrame,
} from './frame.js';
import {
  MediaReceiver,
  type ReceivedMedia,
  sendMediaFile,
} from './media.js';
import type { PeerHello } from './p2p.js';
import { createPeerLink as coreCreatePeerLink } from '@pooriaarab/vibe-core/link';

/** Options for {@link createPeerLink}. */
export interface CreatePeerLinkOptions {
  /** Directory to write reassembled media files into (defaults to os.tmpdir()). */
  readonly mediaTmpDir?: string;
}

export interface PeerLink {
  /** The validated identity of the remote peer (from the hello handshake). */
  readonly hello: PeerHello;
  /** Send a line of text as a `msg` frame. */
  send(text: string): void;
  /** Send a signed feed post as a `post` frame (see feed.ts for the scheme). */
  sendPost(post: PostFrame): void;
  /** Read a file from disk and send it as a chunked media transfer. */
  sendMedia(
    filePath: string,
    opts?: { mime?: string; name?: string },
  ): Promise<{ id: string; size: number }>;
  /** Relay one `rtc-*` signaling frame (offer / answer / ice) to the peer.
   *  Live media never touches this socket — only SDP / ICE strings do. */
  sendSignal(frame: RtcFrame): void;
  /** Register a callback for each incoming `msg` frame. */
  onMessage(cb: (m: { id: string; text: string; at: number }) => void): void;
  /** Register a callback for each incoming `post` frame (shape-parsed only —
   *  the receiver MUST still verify the signature before retaining it). */
  onPost(cb: (p: PostFrame) => void): void;
  /** Register a callback fired for each fully-reassembled incoming media file. */
  onMedia(cb: (m: ReceivedMedia) => void): void;
  /** Register a callback fired for each incoming `rtc-*` signaling frame. */
  onSignal(cb: (f: RtcFrame) => void): void;
  /** Register a callback fired once when the peer closes the link. */
  onClose(cb: () => void): void;
  /** Omegle "next": write a `bye` frame, then end the socket. */
  close(): void;
}

/**
 * Build a {@link PeerLink} over `socket`. `initialBuffer` carries any bytes the
 * caller already buffered after the hello line (so frames sent right after the
 * hello are not dropped). Pure-ish: attaches listeners to `socket`.
 */
export function createPeerLink(
  socket: Duplex,
  hello: PeerHello,
  initialBuffer: string | Buffer = '',
  linkOpts: CreatePeerLinkOptions = {},
): PeerLink {
  const messageCbs = new Set<(m: { id: string; text: string; at: number }) => void>();
  const postCbs = new Set<(p: PostFrame) => void>();
  const mediaCbs = new Set<(m: ReceivedMedia) => void>();
  const signalCbs = new Set<(f: RtcFrame) => void>();

  let mediaReceiver: MediaReceiver | undefined;
  const ensureMediaReceiver = (): MediaReceiver => {
    if (!mediaReceiver) {
      mediaReceiver = new MediaReceiver(
        (m) => {
          for (const cb of mediaCbs) cb(m);
        },
        { tmpDir: linkOpts.mediaTmpDir },
      );
    }
    return mediaReceiver;
  };

  const coreLink = coreCreatePeerLink<Frame, PeerHello>(socket, {
    codec: { parse: parseFrame, serialize: serializeFrame },
    hello,
    initialBuffer,
    byeFrame: { t: 'bye' },
  });

  coreLink.onFrame((frame) => {
    const f = frame as Frame;
    switch (f.t) {
      case 'msg': {
        const m = { id: f.id, text: f.text, at: f.at };
        for (const cb of messageCbs) cb(m);
        break;
      }
      case 'post': {
        for (const cb of postCbs) cb(f as PostFrame);
        break;
      }
      case 'media-start':
      case 'media-chunk':
      case 'media-end': {
        if (f.t === 'media-chunk' && !('b64' in f)) return;
        mediaReceiver?.handle(f as MediaFrame);
        break;
      }
      case 'rtc-offer':
      case 'rtc-answer':
      case 'rtc-ice': {
        for (const cb of signalCbs) cb(f as RtcFrame);
        break;
      }
      default:
        break;
    }
  });

  return {
    hello,
    send(text) {
      if (coreLink.closed) return;
      coreLink.sendFrame({ t: 'msg', id: newId(), text, at: Date.now() });
    },
    sendPost(post) {
      if (coreLink.closed) return;
      coreLink.sendFrame({
        t: 'post',
        id: post.id,
        author: post.author,
        text: post.text,
        at: post.at,
        sig: post.sig,
      });
    },
    async sendMedia(filePath, opts = {}) {
      if (coreLink.closed) return { id: '', size: 0 };
      return sendMediaFile({ socket, path: filePath, mime: opts.mime, name: opts.name });
    },
    sendSignal(frame) {
      if (coreLink.closed) return;
      coreLink.sendFrame(frame);
    },
    onMessage(cb) {
      messageCbs.add(cb);
    },
    onPost(cb) {
      postCbs.add(cb);
    },
    onMedia(cb) {
      ensureMediaReceiver();
      mediaCbs.add(cb);
    },
    onSignal(cb) {
      signalCbs.add(cb);
    },
    onClose(cb) {
      coreLink.onClose(cb);
    },
    close() {
      coreLink.close();
    },
  };
}
