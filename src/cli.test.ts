import { describe, expect, it } from 'vitest';
import { formatAgo, parseArgs } from './cli.js';

describe('parseArgs()', () => {
  it('parses each command + its positional argument', () => {
    expect(parseArgs(['connect']).command).toBe('connect');
    expect(parseArgs(['who']).command).toBe('who');
    expect(parseArgs(['feed']).command).toBe('feed');
    expect(parseArgs(['open']).command).toBe('open');
    expect(parseArgs(['mcp']).command).toBe('mcp');
    expect(parseArgs(['follow', '@alice'])).toMatchObject({ command: 'follow', arg: '@alice' });
    expect(parseArgs(['unfollow', 'a'.repeat(64)])).toMatchObject({
      command: 'unfollow',
      arg: 'a'.repeat(64),
    });
    expect(parseArgs(['dm', '@bob'])).toMatchObject({ command: 'dm', arg: '@bob' });
    expect(parseArgs(['handle', '@x'])).toMatchObject({ command: 'handle', arg: '@x' });
  });

  it('parses post text (rejoining split positionals), flags, and options', () => {
    expect(parseArgs(['post', 'hello world'])).toMatchObject({ command: 'post', arg: 'hello world' });
    expect(parseArgs(['post', 'hello', 'world'])).toMatchObject({ command: 'post', arg: 'hello world' });
    expect(parseArgs(['feed', '--all'])).toMatchObject({ command: 'feed', all: true });
    expect(parseArgs(['profile', '--bio', 'ships code'])).toMatchObject({
      command: 'profile',
      bio: 'ships code',
    });
    expect(parseArgs(['profile', '--bio=x'])).toMatchObject({ command: 'profile', bio: 'x' });
    expect(parseArgs(['profile', '--link', 'https://a.dev', '--link=https://b.dev'])).toMatchObject({
      command: 'profile',
      links: ['https://a.dev', 'https://b.dev'],
    });
    expect(parseArgs(['open', '--port', '8080'])).toMatchObject({ command: 'open', port: 8080 });
    expect(parseArgs(['open', '--port=9090'])).toMatchObject({ command: 'open', port: 9090 });
    expect(parseArgs(['open', '--port', 'nope']).port).toBeUndefined();
  });

  it('handles --version/--help/empty and ignores unknown flags', () => {
    expect(parseArgs(['--version']).command).toBe('version');
    expect(parseArgs(['-v']).command).toBe('version');
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['-h']).command).toBe('help');
    expect(parseArgs([]).command).toBeNull();
    expect(parseArgs(['--wat', 'feed']).command).toBe('feed');
  });
});

describe('formatAgo()', () => {
  const now = new Date('2026-07-28T12:00:00Z');
  it('renders compact relative times for ISO strings and ms epochs', () => {
    expect(formatAgo('2026-07-28T11:59:40Z', now)).toBe('just now');
    expect(formatAgo('2026-07-28T11:55:00Z', now)).toBe('5m ago');
    expect(formatAgo('2026-07-28T09:00:00Z', now)).toBe('3h ago');
    expect(formatAgo('2026-07-26T12:00:00Z', now)).toBe('2d ago');
    expect(formatAgo(now.getTime() - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAgo('garbage', now)).toBe('unknown');
  });
});
