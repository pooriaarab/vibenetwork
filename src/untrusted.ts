/**
 * input-safety — anything arriving from a peer is UNTRUSTED DISPLAY DATA.
 *
 * Incoming chat text (and wire handles) are never executed, never passed to a
 * shell, never fed to an agent — the only thing we ever do with them is SHOW
 * them. Before that they pass through {@link sanitizePeerText}: control bytes
 * (ESC/CSI terminal-sequence injection, CR line-overwrite, C1 controls),
 * bidi-override/isolate spoofing characters, and BOM are stripped, and the
 * result is length-capped. Newlines and tabs survive (multi-line chat is
 * fine — they carry no terminal control), as do emoji/ZWJ sequences and all
 * ordinary Unicode.
 */
import { MAX_TEXT_LEN } from './frame.js';

/** Default display cap — mirrors the wire cap in frame.ts. */
export const MAX_DISPLAY_TEXT_LEN = MAX_TEXT_LEN;

/**
 * Matches exactly the dangerous characters, nothing else:
 *   \u0000-\u0008 \u000B-\u001F   C0 controls except \t (09) and \n (0A)
 *                                  — kills ESC/CSI sequences, CR, NUL, …
 *   \u007F-\u009F                  DEL + C1 controls
 *   \u200E \u200F                  LRM / RLM (direction marks — text spoofing)
 *   \u202A-\u202E                  bidi embeddings + overrides (Trojan Source)
 *   \u2066-\u2069                  bidi isolates (same class)
 *   \uFEFF                          BOM / zero-width no-break space
 * Kept on purpose: \t \n, ZWSP/ZWJ (emoji sequences), all ordinary Unicode.
 */
const UNSAFE_DISPLAY_CHARS =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Sanitize untrusted peer text for display. Pure; never throws.
 * See the module docstring for what is stripped and why.
 */
export function sanitizePeerText(
  text: string,
  maxLen: number = MAX_DISPLAY_TEXT_LEN,
): string {
  const cleaned = text.replace(UNSAFE_DISPLAY_CHARS, '');
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}
