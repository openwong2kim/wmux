import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MERGE_EFFECT_MAX_ATTEMPTS } from '../../../shared/moaDecision';
import { MoaEffectStore, reconcileMergeEffect } from '../moaEffectStore';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-moa-effects-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const D_ID = 'moa-d-0b8a6c1e-2f3d-4a5b-9c8d-7e6f5a4b3c2d';
const HEAD = '995e9d9a3124628f51c0a3989bf2eced7ea2f97c';
const SQUASH = '6d286bee3eaa2c21d8b3ba54dd5a56f9526fa8b5';
const INPUT = { decisionId: D_ID, repoKey: 'github.com/openwong2kim/wmux', repoPath: '/repo', prNumber: 1858, expectHead: HEAD, approvedBy: 'moa-auto' as const };

describe('reconcileMergeEffect (crash reconcile from a fresh read)', () => {
  const effect = { expectHead: HEAD, attempt: 1 };
  it('MERGED with the expected head is done; the squash commit is evidence only', () => {
    expect(reconcileMergeEffect(effect, { state: 'MERGED', headRefOid: HEAD, mergeCommitOid: SQUASH })).toEqual({ status: 'done', mergeCommitOid: SQUASH });
  });
  it('MERGED with another head is not ours, even when the merge commit equals expectHead', () => {
    expect(reconcileMergeEffect(effect, { state: 'MERGED', headRefOid: 'a'.repeat(40), mergeCommitOid: HEAD })).toEqual({ status: 'refused', reason: 'merged-other-head' });
  });
  it('OPEN on the same head goes back to pending (predicates re-run), unless out of attempts', () => {
    expect(reconcileMergeEffect(effect, { state: 'OPEN', headRefOid: HEAD, mergeCommitOid: null })).toEqual({ status: 'pending' });
    expect(reconcileMergeEffect({ ...effect, attempt: MERGE_EFFECT_MAX_ATTEMPTS }, { state: 'OPEN', headRefOid: HEAD, mergeCommitOid: null })).toEqual({ status: 'refused', reason: 'attempts-exhausted' });
  });
  it('a moved head, a closed PR, a failed read', () => {
    expect(reconcileMergeEffect(effect, { state: 'OPEN', headRefOid: 'a'.repeat(40), mergeCommitOid: null })).toEqual({ status: 'refused', reason: 'head-moved' });
    expect(reconcileMergeEffect(effect, { state: 'CLOSED', headRefOid: HEAD, mergeCommitOid: null })).toEqual({ status: 'refused', reason: 'closed' });
    expect(reconcileMergeEffect(effect, null)).toEqual({ status: 'uncertain', reason: 'read-failed' });
  });
});

describe('MoaEffectStore', () => {
  it('enqueue is idempotent per decision', async () => {
    const store = new MoaEffectStore(dir);
    const a = await store.enqueue(INPUT);
    expect(a).toMatchObject({ id: `effect:${D_ID}:pr.merge`, kind: 'pr.merge', status: 'pending', attempt: 0 });
    expect(await store.enqueue({ ...INPUT, expectHead: 'c'.repeat(40) })).toEqual(a);
    await expect(store.enqueue({ ...INPUT, decisionId: 'not-an-id' })).rejects.toThrow('invalid merge effect');
  });

  it('an attempt is journaled inFlight before it runs, and an inFlight row reloads as uncertain', async () => {
    const store = new MoaEffectStore(dir);
    const e = await store.enqueue(INPUT);
    const claimed = await store.claim(e.id);
    expect(claimed).toMatchObject({ status: 'inFlight', attempt: 1 });
    expect(await store.claim(e.id)).toBeNull();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'moa-delegate', 'effects.json'), 'utf8'));
    expect(onDisk.effects[0]).toMatchObject({ status: 'inFlight', attempt: 1 });
    const reloaded = new MoaEffectStore(dir);
    expect(reloaded.get(e.id)).toMatchObject({ status: 'uncertain', reason: 'restart-mid-merge' });
    // An uncertain row is never claimed directly: reconcile first.
    expect(await reloaded.claim(e.id)).toBeNull();
    expect(await reloaded.reconcile(e.id, { state: 'MERGED', headRefOid: HEAD, mergeCommitOid: SQUASH })).toMatchObject({ status: 'done', mergeCommitOid: SQUASH });
  });

  it('a reconciled OPEN row can be claimed again, up to the attempt cap', async () => {
    const store = new MoaEffectStore(dir);
    const e = await store.enqueue(INPUT);
    for (let i = 1; i <= MERGE_EFFECT_MAX_ATTEMPTS; i++) {
      expect(await store.claim(e.id)).toMatchObject({ attempt: i });
      await store.finish(e.id, 'uncertain', 'gh-timeout');
      await store.reconcile(e.id, { state: 'OPEN', headRefOid: HEAD, mergeCommitOid: null });
    }
    expect(store.get(e.id)).toMatchObject({ status: 'refused', reason: 'attempts-exhausted' });
  });

  it('finish applies to an inFlight row only', async () => {
    const store = new MoaEffectStore(dir);
    const e = await store.enqueue(INPUT);
    expect(await store.finish(e.id, 'done')).toBeNull();
    await store.claim(e.id);
    expect(await store.finish(e.id, 'refused', 'head-moved')).toMatchObject({ status: 'refused', reason: 'head-moved' });
  });

  it('a malformed file refuses to load', () => {
    fs.mkdirSync(path.join(dir, 'moa-delegate'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'moa-delegate', 'effects.json'), JSON.stringify({ version: 1, effects: [{ ...INPUT, id: 'x', kind: 'approval.press' }] }));
    expect(() => new MoaEffectStore(dir)).toThrow('Invalid moa effect entry');
  });
});
