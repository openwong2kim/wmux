// The merge executor on a real outbox (tmp dir): journal first, fresh read,
// lane, merge(), and how each GitHub answer settles the row.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PrLaneFacts, PrWriteResult } from '../../../shared/prReview';
import { MoaEffectStore } from '../moaEffectStore';
import { MoaMergeExecutor } from '../moaMergeExecutor';

const HEAD = 'a'.repeat(40);
const FACTS: PrLaneFacts = {
  number: 7, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefOid: HEAD, headRefName: 'feat/x', baseRefName: 'main',
  author: 'owner', mergedAt: null, mergeCommitOid: null, labels: [], labelsTruncated: false, files: ['src/a.ts'], filesTruncated: false,
  checksHeadOid: HEAD, checks: [{ name: 'validate', workflow: 'CI', bucket: 'pass', link: '', isRequired: true }], checksTruncated: false,
};

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-moa-exec-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

async function setup(mergeResult: PrWriteResult, approvedBy: 'owner' | 'moa-auto' = 'moa-auto', facts: PrLaneFacts = FACTS) {
  const effects = new MoaEffectStore(dir);
  const e = await effects.enqueue({
    decisionId: 'moa-d-00000000-0000-4000-8000-000000000001', repoKey: 'github.com/o/r', repoPath: '/r', prNumber: 7, expectHead: HEAD, approvedBy,
  });
  const state = { facts };
  const merge = vi.fn(async () => mergeResult);
  const exec = new MoaMergeExecutor({
    effects,
    facts: { readFresh: async () => state.facts },
    merge,
    laneContext: async () => ({ trustedAuthors: ['owner'], askerBranches: ['feat/x'] }),
    authorize: () => null,
  });
  return { effects, e, exec, merge, state };
}

describe('MoaMergeExecutor', () => {
  it('a gh error after the claim is uncertain; reconcile reads it again and the retry re-runs the lane', async () => {
    const { effects, e, exec, merge } = await setup({ ok: false, code: 'error', message: 'network' });
    expect(await exec.run(e.id)).toMatchObject({ status: 'uncertain', reason: 'merge-error', attempt: 1 });
    merge.mockResolvedValueOnce({ ok: true });
    await exec.reconcileAll();
    expect(effects.get(e.id)).toMatchObject({ status: 'done', attempt: 2 });
    expect(merge).toHaveBeenCalledTimes(2);
  });

  it('blocked and moved are refusals, never retried', async () => {
    const blocked = await setup({ ok: false, code: 'blocked', reason: 'draft', message: 'draft' } as PrWriteResult);
    expect(await blocked.exec.run(blocked.e.id)).toMatchObject({ status: 'refused', reason: 'blocked-draft' });
    await blocked.exec.reconcileAll();
    expect(blocked.merge).toHaveBeenCalledTimes(1);
  });

  it('a moa-auto effect re-runs every predicate on the fresh read; an owner one only head-unchanged', async () => {
    const outside = { ...FACTS, author: 'outsider' };
    const auto = await setup({ ok: true }, 'moa-auto', outside);
    expect(await auto.exec.run(auto.e.id)).toMatchObject({ status: 'refused', reason: 'author-trusted:external-author' });
    expect(auto.merge).not.toHaveBeenCalled();
    fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
    const owner = await setup({ ok: true }, 'owner', outside);
    expect(await owner.exec.run(owner.e.id)).toMatchObject({ status: 'done' });
  });

  it('the journal row is on disk (inFlight) before merge() runs', async () => {
    const { e, exec, merge } = await setup({ ok: true });
    merge.mockImplementationOnce(async () => {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'moa-delegate', 'effects.json'), 'utf8')) as { effects: Array<{ status: string }> };
      expect(saved.effects[0]?.status).toBe('inFlight');
      return { ok: true };
    });
    expect(await exec.run(e.id)).toMatchObject({ status: 'done' });
  });

  it('an already-merged PR at the expected head settles done without merging', async () => {
    const { e, exec, merge } = await setup({ ok: true }, 'moa-auto', { ...FACTS, state: 'MERGED', mergeCommitOid: 'b'.repeat(40) });
    expect(await exec.run(e.id)).toMatchObject({ status: 'done', mergeCommitOid: 'b'.repeat(40) });
    expect(merge).not.toHaveBeenCalled();
  });
});
