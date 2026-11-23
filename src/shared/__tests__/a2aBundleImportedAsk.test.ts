// The `imported` bundle ask: the asking PC's word that a bundle's commits are in one of its repositories.
import { describe, expect, it } from 'vitest';
import { parseBundleAsk } from '../a2aBundle';

const base = { v: 1, askId: 'ba-11111111-2222-4333-8444-555555555555', op: 'imported', spawnId: 'sp-0123abcd-4567-89ab-cdef-0123456789ab' };

describe('parseBundleAsk imported', () => {
  it('takes a spawn id and a commit id (sha-1 or sha-256), and nothing else', () => {
    expect(parseBundleAsk({ ...base, head: 'a'.repeat(40) })).toEqual({ ...base, head: 'a'.repeat(40) });
    expect(parseBundleAsk({ ...base, head: 'b'.repeat(64) })).toEqual({ ...base, head: 'b'.repeat(64) });
    for (const head of ['a'.repeat(39), 'A'.repeat(40), 'a'.repeat(50), 'HEAD', 1]) expect(parseBundleAsk({ ...base, head })).toBeNull();
    expect(parseBundleAsk({ ...base, head: 'a'.repeat(40), bundleId: 'bd-x' })).toBeNull();
    expect(parseBundleAsk({ ...base, spawnId: 'sp-1', head: 'a'.repeat(40) })).toBeNull();
  });
});
