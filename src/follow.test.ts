import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  follow,
  isFollowed,
  listFollows,
  parseFollowTarget,
  resolveFollowedPubkeys,
  unfollow,
} from './follow.js';
import { recordPeer } from './p2p.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'vibenetwork-follow-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PUB_A = 'a'.repeat(64);
const PUB_B = 'b'.repeat(64);

describe('parseFollowTarget()', () => {
  it('detects pubkeys vs handles; rejects junk', () => {
    expect(parseFollowTarget(PUB_A)).toEqual({ pubkey: PUB_A });
    expect(parseFollowTarget(PUB_A.toUpperCase())).toEqual({ pubkey: PUB_A });
    expect(parseFollowTarget('alice')).toEqual({ handle: '@alice' });
    expect(parseFollowTarget('@alice')).toEqual({ handle: '@alice' });
    expect(() => parseFollowTarget('@')).toThrow(/invalid follow target/);
    expect(() => parseFollowTarget('has space')).toThrow(/invalid follow target/);
  });
});

describe('follow() / unfollow() / isFollowed()', () => {
  it('follows by handle, persists, and unfollows (idempotent both ways)', () => {
    expect(follow('@alice', dir, new Date('2026-07-28T00:00:00Z'))).toEqual({
      follows: [{ handle: '@alice', at: '2026-07-28T00:00:00.000Z' }],
      changed: true,
    });
    // Re-follow: no dup, leading-@ optional.
    expect(follow('alice', dir).changed).toBe(false);
    expect(isFollowed('@alice', dir)).toBe(true);

    const reload = listFollows(dir);
    expect(reload).toEqual([{ handle: '@alice', at: '2026-07-28T00:00:00.000Z' }]);

    expect(unfollow('@alice', dir).changed).toBe(true);
    expect(unfollow('@alice', dir).changed).toBe(false);
    expect(isFollowed('@alice', dir)).toBe(false);
    expect(listFollows(dir)).toEqual([]);
  });

  it('follows by pubkey independently of handle edges', () => {
    follow('@alice', dir);
    follow(PUB_A, dir);
    const follows = listFollows(dir);
    expect(follows).toHaveLength(2);
    expect(isFollowed(PUB_A, dir)).toBe(true);
    expect(isFollowed(PUB_B, dir)).toBe(false);
    // Unfollowing the handle leaves the pubkey edge.
    unfollow('@alice', dir);
    expect(isFollowed(PUB_A, dir)).toBe(true);
  });

  it('throws on invalid targets; isFollowed never throws', () => {
    expect(() => follow('bad handle', dir)).toThrow(/invalid follow target/);
    expect(() => unfollow('@', dir)).toThrow(/invalid follow target/);
    expect(isFollowed('bad handle', dir)).toBe(false);
  });
});

describe('resolveFollowedPubkeys()', () => {
  it('passes pubkey edges through and resolves handle edges via the peer book', () => {
    follow(PUB_A, dir);
    follow('@bob', dir); // bob's pubkey unknown → unresolved for now
    follow('@carol', dir);
    // Carol shows up live: an identity-verified hello lands in peers.json.
    recordPeer({ handle: '@carol', league: '10M', harness: 'codex', pubkey: PUB_B }, dir);

    const resolved = resolveFollowedPubkeys(dir);
    expect(resolved.has(PUB_A)).toBe(true);
    expect(resolved.has(PUB_B)).toBe(true); // @carol → PUB_B via the peer book
    expect(resolved.size).toBe(2); // @bob stays unresolved
  });

  it('is empty when nothing is followed', () => {
    expect(resolveFollowedPubkeys(dir).size).toBe(0);
  });
});
