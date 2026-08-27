export type Command =
  | 'connect'
  | 'profile'
  | 'handle'
  | 'who'
  | 'follow'
  | 'unfollow'
  | 'feed'
  | 'post'
  | 'dm'
  | 'open'
  | 'mcp'
  | 'help'
  | 'version'
  | null;

export interface ParsedArgs {
  readonly command: Command;
  /** Port for `open --port`; undefined means "let the OS pick". */
  readonly port: number | undefined;
  /** `feed --all`: the unfiltered firehose (default: followed + own posts). */
  readonly all: boolean;
  /** `profile --bio "..."`. */
  readonly bio: string | undefined;
  /** `profile --link URL` (repeatable; replaces the links list). */
  readonly links: readonly string[];
  /** Positional argument (handle for follow/unfollow/dm/handle, text for post). */
  readonly arg: string | undefined;
}

function parsePort(raw: string): number | undefined {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

/**
 * Parse argv (the slice AFTER the program name) into a command + options.
 * Pure: no IO, no process access — trivially unit-testable.
 */
type MutableParsedArgs = {
  command: Command;
  port: number | undefined;
  all: boolean;
  bio: string | undefined;
  links: string[];
  arg: string | undefined;
};

function makeEmptyParsed(): MutableParsedArgs {
  return { command: null, port: undefined, all: false, bio: undefined, links: [], arg: undefined };
}

function handleVersionFlag(a: string): ParsedArgs | null {
  if (a === '--version' || a === '-v') return { command: 'version', port: undefined, all: false, bio: undefined, links: [], arg: undefined };
  return null;
}

function handleHelpFlag(a: string): ParsedArgs | null {
  if (a === '--help' || a === '-h') return { command: 'help', port: undefined, all: false, bio: undefined, links: [], arg: undefined };
  return null;
}

interface FlagResult { readonly handled: boolean; readonly consumed: number; }

function tryHandleAll(a: string, out: MutableParsedArgs): FlagResult {
  if (a !== '--all') return { handled: false, consumed: 0 };
  out.all = true;
  return { handled: true, consumed: 0 };
}

function tryHandleBio(a: string, next: string | undefined, out: MutableParsedArgs): FlagResult {
  if (a === '--bio') {
    if (next !== undefined) out.bio = next;
    return { handled: true, consumed: next !== undefined ? 1 : 0 };
  }
  if (a.startsWith('--bio=')) {
    out.bio = a.slice('--bio='.length);
    return { handled: true, consumed: 0 };
  }
  return { handled: false, consumed: 0 };
}

function tryHandleLink(a: string, next: string | undefined, out: MutableParsedArgs): FlagResult {
  if (a === '--link') {
    if (next !== undefined) out.links.push(next);
    return { handled: true, consumed: next !== undefined ? 1 : 0 };
  }
  if (a.startsWith('--link=')) {
    out.links.push(a.slice('--link='.length));
    return { handled: true, consumed: 0 };
  }
  return { handled: false, consumed: 0 };
}

function tryHandlePort(a: string, next: string | undefined, out: MutableParsedArgs): FlagResult {
  if (a === '--port') {
    if (next !== undefined) {
      const p = parsePort(next);
      if (p !== undefined) out.port = p;
    }
    return { handled: true, consumed: next !== undefined ? 1 : 0 };
  }
  if (a.startsWith('--port=')) {
    const p = parsePort(a.slice('--port='.length));
    if (p !== undefined) out.port = p;
    return { handled: true, consumed: 0 };
  }
  return { handled: false, consumed: 0 };
}

function tryHandleFlags(a: string, next: string | undefined, out: MutableParsedArgs): FlagResult {
  let r = tryHandleAll(a, out);
  if (r.handled) return r;
  r = tryHandleBio(a, next, out);
  if (r.handled) return r;
  r = tryHandleLink(a, next, out);
  if (r.handled) return r;
  r = tryHandlePort(a, next, out);
  if (r.handled) return r;
  return { handled: false, consumed: 0 };
}

const KNOWN_COMMANDS = new Set<string>(['connect', 'profile', 'handle', 'who', 'follow', 'unfollow', 'feed', 'post', 'dm', 'open', 'mcp', 'help']);

function parseKnownCommand(a: string): Command {
  if (KNOWN_COMMANDS.has(a)) return a as Command;
  return null;
}

function handleCommandOrArg(a: string, out: MutableParsedArgs): void {
  const known = parseKnownCommand(a);
  if (known !== null && out.command === null) {
    out.command = known;
    return;
  }
  if (out.arg === undefined) {
    out.arg = a;
    return;
  }
  if (out.command === 'post') {
    out.arg = `${out.arg} ${a}`;
  }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out = makeEmptyParsed();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) throw new Error('missing argv element');
    const v = handleVersionFlag(a);
    if (v !== null) return v;
    const h = handleHelpFlag(a);
    if (h !== null) return h;
    const next = argv[i + 1];
    const flag = tryHandleFlags(a, next, out);
    if (flag.handled) { i += flag.consumed; continue; }
    if (a.startsWith('-')) continue;
    handleCommandOrArg(a, out);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Compact relative time for local lists: an ISO timestamp or ms epoch →
 * "just now" / "5m ago" / "3h ago" / "2d ago". Unparseable input → "unknown".
 */
