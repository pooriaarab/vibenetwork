/**
 * The local web app, as a single self-contained HTML string.
 * Split into sections for lint compliance — the emitted string is byte-identical.
 */
import { sectionHead, sectionBody, sectionScript, sectionTail } from './web-app-html-parts.js';

export const webAppHtml = sectionHead + sectionBody + sectionScript + sectionTail;
