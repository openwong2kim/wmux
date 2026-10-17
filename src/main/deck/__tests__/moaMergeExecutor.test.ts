// The merge executor on a real outbox (tmp dir): journal first, fresh read,
// lane, merge(), and how each GitHub answer settles the row.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PrLaneFacts, PrWriteResult } from '../../../shared/prReview';
import { MoaEffectStore } from '../moaEffectStore';
import { MoaMergeExecutor, laneAuthorize, ruleAuthorize, PREDICATES_BY_APPROVER, type LaneAuthorizeInputs, type MoaMergeExecutorPorts } from '../moaMergeExecutor';
import type { MergeEffect } from '../../../shared/moaDecision';
import type { LaneEvidenceRow } from '../moaMergeLane';
import { PrVerdictStore } from '../../github/prVerdictStore';
import type { PrVerdictRecord } from '../../../shared/prVerdict';

const HEAD = 'a'.repeat(40);
const FACTS: PrLaneFacts = {
  number: 7, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefOid: HEAD, headRefName: 'feat/x', baseRefName: 'main',
  author: 'owner', mergedAt: null, mergeCommitOid: null, labels: [], labelsTruncated: false, files: ['src/a.ts'], filesTruncated: false,
  checksHeadOid: HEAD, checks: [{ name: 'validate', workflow: 'CI', bucket: 'pass', link: '', isRequired: true }], checksTruncated: false,
};

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-moa-exec-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const VERDICT = (verdict: 'pass' | 'fail', workspaceId = 'ws-verifier'): PrVerdictRecord => ({
  version: 1, repoKey: 'github.com/o/r', prNumber: 7, headSha: HEAD, verdict,
  principal: { workspaceId, ptyId: 'pty-v', agent: 'claude' }, summary: 'checked', at: Date.now(),
});

async function setup(mergeResult: PrWriteResult, approvedBy: 'owner' | 'moa-auto' = 'moa-auto', facts: PrLaneFacts = FACTS) {
  const verdicts = new PrVerdictStore(dir);
  await verdicts.record(VERDICT('pass'));
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
    laneContext: async (eff) => ({
      trustedAuthors: ['owner'], askerBranches: ['feat/x'],
      verdicts: await verdicts.list(eff.repoKey, eff.prNumber).catch(() => null), authorWorkspaces: ['ws-author'],
    }),
    authorize: () => null,
  });
  return { effects, e, exec, merge, state, verdicts };
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

  it('a retry reads the verdict store again: a FAIL recorded after the first try stops it', async () => {
    const { effects, e, exec, merge, verdicts } = await setup({ ok: false, code: 'error', message: 'network' });
    expect(await exec.run(e.id)).toMatchObject({ status: 'uncertain', reason: 'merge-error' });
    await verdicts.record(VERDICT('fail', 'ws-other'));
    merge.mockResolvedValueOnce({ ok: true });
    await exec.reconcileAll();
    expect(effects.get(e.id)).toMatchObject({ status: 'refused', reason: 'verifier-pass-at-head:verdict-fail', attempt: 2 });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('an unreadable verdict store refuses an auto merge', async () => {
    const { e, exec, merge } = await setup({ ok: true });
    fs.writeFileSync(path.join(dir, 'pr-verdicts.json'), '{not json');
    expect(await exec.run(e.id)).toMatchObject({ status: 'refused', reason: 'verifier-pass-at-head:verdicts-unreadable' });
    expect(merge).not.toHaveBeenCalled();
  });

  it('reconcileAll: an executor without a lane port leaves lane rows alone, one with it leaves decision rows alone', async () => {
    const { effects, e, exec, merge } = await setup({ ok: true });
    const lane = await effects.enqueueLane({ repoKey: 'github.com/o/r', repoPath: '/r', prNumber: 7, expectHead: HEAD });
    await exec.reconcileAll();
    expect(effects.get(e.id)?.status).toBe('done');
    expect(effects.get(lane.id)?.status).toBe('pending');
    expect(merge).toHaveBeenCalledTimes(1);
    const own = await effects.enqueue({
      decisionId: 'moa-d-00000000-0000-4000-8000-000000000002', repoKey: 'github.com/o/r', repoPath: '/r', prNumber: 7, expectHead: HEAD, approvedBy: 'owner',
    });
    const laneMerge = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
    const laneExec = new MoaMergeExecutor({
      effects, facts: { readFresh: async () => FACTS }, merge: laneMerge,
      laneContext: async () => { throw new Error('not for lane rows'); }, authorize: () => 'not-lane',
      lane: { inputs: () => ({ factoryEnabled: false, killSwitch: false, dailyCap: 5 }), laneContext: async () => { throw new Error('unused'); } },
    });
    await laneExec.reconcileAll();
    expect(effects.get(lane.id)).toMatchObject({ status: 'refused', reason: 'factory-disabled' });
    expect(effects.get(own.id)?.status).toBe('pending');
    expect(laneMerge).not.toHaveBeenCalled();
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

describe('approver → predicates (R1)', () => {
  it('owner re-runs head-unchanged only; moa-auto and lane run every lane predicate', () => {
    expect(PREDICATES_BY_APPROVER.owner).toEqual(['head-unchanged']);
    expect(PREDICATES_BY_APPROVER['moa-auto']).toContain('verifier-pass-at-head');
    expect(PREDICATES_BY_APPROVER.lane).toEqual(PREDICATES_BY_APPROVER['moa-auto']);
  });

  it('an approver outside the table is refused, never treated as the owner', async () => {
    const { effects, e, merge } = await setup({ ok: true }, 'owner');
    const authorize = vi.fn(() => null);
    for (const approvedBy of ['admin', 'constructor', undefined]) {
      const rows = new Map<string, MergeEffect>([[e.id, { ...e, status: 'pending' }]]);
      const fake = {
        claim: async (id: string) => ({ ...rows.get(id), status: 'inFlight', attempt: 1, approvedBy }),
        finish: async (id: string, status: string, reason?: string) => ({ ...rows.get(id), status, reason }),
        get: (id: string) => rows.get(id) ?? null,
        list: () => [...rows.values()],
      } as unknown as typeof effects;
      const exec = new MoaMergeExecutor({
        effects: fake, facts: { readFresh: async () => FACTS }, merge,
        laneContext: async () => ({ trustedAuthors: ['owner'], askerBranches: ['feat/x'], verdicts: [], authorWorkspaces: [] }),
        authorize,
      });
      expect(await exec.run(e.id)).toMatchObject({ status: 'refused', reason: 'unknown-approver' });
    }
    expect(authorize).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });
});

describe('laneAuthorize', () => {
  const on: LaneAuthorizeInputs = { factoryEnabled: true, killSwitch: false, dailyCap: 3 };
  it('allows only with the factory on, the kill switch off and room under the daily cap', () => {
    expect(laneAuthorize(on, 0)).toBeNull();
    expect(laneAuthorize(on, 2)).toBeNull();
    expect(laneAuthorize(on, 3)).toBe('lane-daily-cap');
    expect(laneAuthorize({ ...on, dailyCap: 0 }, 0)).toBe('lane-daily-cap');
    expect(laneAuthorize({ ...on, dailyCap: Number.NaN }, 0)).toBe('lane-daily-cap');
    expect(laneAuthorize({ ...on, factoryEnabled: false }, 0)).toBe('factory-disabled');
    expect(laneAuthorize({ ...on, killSwitch: true }, 0)).toBe('lane-paused');
    expect(laneAuthorize(null, 0)).toBe('lane-inputs-unreadable');
  });

  it('a rule\'s gate is the lane\'s without the auto-merge switch: factory on, room under the cap', () => {
    expect(ruleAuthorize({ ...on, killSwitch: true }, 0)).toBeNull();
    expect(ruleAuthorize({ ...on, killSwitch: true }, 3)).toBe('lane-daily-cap');
    expect(ruleAuthorize({ ...on, killSwitch: true, factoryEnabled: false }, 0)).toBe('factory-disabled');
    expect(ruleAuthorize(null, 0)).toBe('lane-inputs-unreadable');
  });
});

describe('lane effects', () => {
  const ROW: LaneEvidenceRow = {
    taskId: 'task-1', origin: { kind: 'bot', botId: 'bot-v' }, preset: 'verify', checkout: { sha: HEAD, detached: true },
    gate: { exitCode: 0, tail: '', at: 1, command: 'bash scripts/verify.sh', recordedBy: 'system', headSha: HEAD },
  };
  const BOT_PASS: PrVerdictRecord = {
    version: 2, repoKey: 'github.com/o/r', prNumber: 7, headSha: HEAD, verdict: 'pass',
    principal: { workspaceId: 'ws-verifier', botId: 'bot-v', agent: 'claude' }, evidence: { taskId: 'task-1', gateHeadSha: HEAD },
    summary: 'checked', at: Date.now(),
  };
  const LANE_FACTS: PrLaneFacts = { ...FACTS, headRefName: 'wtask/fix-x-abc123' };

  async function laneSetup(opts: {
    facts?: PrLaneFacts;
    verdicts?: PrVerdictRecord[];
    inputs?: LaneAuthorizeInputs | null;
    wired?: boolean;
    updateBranch?: MoaMergeExecutorPorts['updateBranch'];
  } = {}) {
    const effects = new MoaEffectStore(dir);
    const state = { facts: opts.facts ?? LANE_FACTS };
    const merge = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
    const authorize = vi.fn(() => null);
    const exec = new MoaMergeExecutor({
      effects,
      facts: { readFresh: async () => state.facts },
      merge,
      laneContext: async () => { throw new Error('the Moa lane context is never used for a lane effect'); },
      authorize,
      ...(opts.wired === false ? {} : {
        lane: {
          inputs: () => (opts.inputs === undefined ? { factoryEnabled: true, killSwitch: false, dailyCap: 5 } : opts.inputs),
          laneContext: async () => ({
            trustedAuthors: ['owner'], askerBranches: [state.facts.headRefName], verdicts: opts.verdicts ?? [BOT_PASS],
            authorWorkspaces: ['ws-author'], botVerdictsOnly: true, evidenceRows: new Map([[ROW.taskId, ROW]]),
          }),
        },
      }),
      ...(opts.updateBranch ? { updateBranch: opts.updateBranch } : {}),
    });
    return { effects, exec, merge, authorize, state };
  }
  const enqueue = (effects: MoaEffectStore, prNumber = 7, repoKey = 'github.com/o/r') =>
    effects.enqueueLane({ repoKey, repoPath: '/r', prNumber, expectHead: HEAD });

  it('the same head twice is one effect', async () => {
    const { effects } = await laneSetup();
    const [a, b] = await Promise.all([enqueue(effects), enqueue(effects)]);
    const c = await enqueue(effects);
    expect(a.id).toBe(`lane:github.com/o/r#7:${HEAD}`);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(effects.list()).toHaveLength(1);
    expect(a).toMatchObject({ approvedBy: 'lane', status: 'pending' });
    expect(a.decisionId).toBeUndefined();
  });

  it('merges with a bot PASS backed by evidence, through the lane authorize (never the Moa one)', async () => {
    const { effects, exec, merge, authorize } = await laneSetup();
    const e = await enqueue(effects);
    expect(await exec.run(e.id)).toMatchObject({ status: 'done' });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('without a verifier PASS it is refused', async () => {
    const { effects, exec, merge } = await laneSetup({ verdicts: [] });
    const e = await enqueue(effects);
    expect(await exec.run(e.id)).toMatchObject({ status: 'refused', reason: 'verifier-pass-at-head:no-verdict' });
    expect(merge).not.toHaveBeenCalled();
  });

  it('a pane PASS without evidence is refused', async () => {
    const pane: PrVerdictRecord = { ...BOT_PASS, version: 1, principal: { workspaceId: 'ws-verifier', ptyId: 'pty-v', agent: 'claude' }, evidence: undefined };
    const { effects, exec, merge } = await laneSetup({ verdicts: [pane] });
    const e = await enqueue(effects);
    expect(await exec.run(e.id)).toMatchObject({ status: 'refused', reason: 'verifier-pass-at-head:verdict-no-evidence' });
    expect(merge).not.toHaveBeenCalled();
  });

  it('unwired, the factory off, the kill switch on, or the cap reached: refused before any read', async () => {
    const cases: Array<[Parameters<typeof laneSetup>[0], string]> = [
      [{ wired: false }, 'lane-not-wired'],
      [{ inputs: null }, 'lane-inputs-unreadable'],
      [{ inputs: { factoryEnabled: false, killSwitch: false, dailyCap: 5 } }, 'factory-disabled'],
      [{ inputs: { factoryEnabled: true, killSwitch: true, dailyCap: 5 } }, 'lane-paused'],
      [{ inputs: { factoryEnabled: true, killSwitch: false, dailyCap: 0 } }, 'lane-daily-cap'],
    ];
    for (const [opts, reason] of cases) {
      fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
      const { effects, exec, merge } = await laneSetup(opts);
      const e = await enqueue(effects);
      expect(await exec.run(e.id), reason).toMatchObject({ status: 'refused', reason });
      expect(merge).not.toHaveBeenCalled();
    }
  });

  it('the daily cap holds for lane effects run concurrently', async () => {
    const verdicts = [7, 8, 9].map((prNumber) => ({ ...BOT_PASS, prNumber }));
    const { effects, exec, merge } = await laneSetup({ inputs: { factoryEnabled: true, killSwitch: false, dailyCap: 1 }, verdicts });
    (exec as unknown as { ports: MoaMergeExecutorPorts }).ports.facts = { readFresh: async (_p, _k, n) => ({ ...LANE_FACTS, number: n }) };
    const ids = await Promise.all([7, 8, 9].map(async (n) => (await enqueue(effects, n)).id));
    const out = await Promise.all(ids.map((id) => exec.run(id)));
    expect(out.map((r) => r?.status).sort()).toEqual(['done', 'refused', 'refused']);
    expect(out.filter((r) => r?.status === 'refused').every((r) => r?.reason === 'lane-daily-cap')).toBe(true);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it('an uncertain lane merge counts against the cap', async () => {
    const { effects, exec, merge } = await laneSetup({ inputs: { factoryEnabled: true, killSwitch: false, dailyCap: 1 } });
    merge.mockResolvedValueOnce({ ok: false, code: 'error', message: 'network' });
    const first = await enqueue(effects, 7);
    expect(await exec.run(first.id)).toMatchObject({ status: 'uncertain' });
    const second = await enqueue(effects, 8);
    expect(await exec.run(second.id)).toMatchObject({ status: 'refused', reason: 'lane-daily-cap' });
  });

  it('the daily cap counts lane merges done today', async () => {
    const { effects, exec, merge } = await laneSetup({ inputs: { factoryEnabled: true, killSwitch: false, dailyCap: 1 } });
    const first = await enqueue(effects, 7);
    expect(await exec.run(first.id)).toMatchObject({ status: 'done' });
    const second = await enqueue(effects, 8);
    expect(await exec.run(second.id)).toMatchObject({ status: 'refused', reason: 'lane-daily-cap' });
    expect(merge).toHaveBeenCalledTimes(1);
  });

  describe('update-branch (R9)', () => {
    const BEHIND: PrLaneFacts = { ...LANE_FACTS, mergeStateStatus: 'BEHIND' };

    it('a BEHIND same-repo wtask/* branch is updated, not merged, and the try ends behind-updated', async () => {
      const updateBranch = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
      const { effects, exec, merge } = await laneSetup({ facts: BEHIND, updateBranch });
      const e = await enqueue(effects);
      expect(await exec.run(e.id)).toMatchObject({ status: 'refused', reason: 'behind-updated' });
      expect(updateBranch).toHaveBeenCalledWith(expect.objectContaining({ id: e.id }));
      expect(merge).not.toHaveBeenCalled();
    });

    it('a failed update ends refused with its reason', async () => {
      const updateBranch = vi.fn(async (): Promise<PrWriteResult> => ({ ok: false, code: 'moved', message: 'moved' }));
      const { effects, exec } = await laneSetup({ facts: BEHIND, updateBranch });
      expect(await exec.run((await enqueue(effects)).id)).toMatchObject({ status: 'refused', reason: 'head-moved' });
      fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
      const throws = await laneSetup({ facts: BEHIND, updateBranch: async () => { throw new Error('boom'); } });
      expect(await throws.exec.run((await enqueue(throws.effects)).id)).toMatchObject({ status: 'refused', reason: 'behind-update-error' });
    });

    it('never for a fork or a branch fan-out did not make', async () => {
      for (const facts of [{ ...BEHIND, isCrossRepository: true }, { ...BEHIND, headRefName: 'feat/x' }]) {
        fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
        const updateBranch = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
        const { effects, exec, merge } = await laneSetup({ facts, updateBranch });
        await exec.run((await enqueue(effects)).id);
        expect(updateBranch).not.toHaveBeenCalled();
        expect(merge).toHaveBeenCalledTimes(facts.isCrossRepository ? 0 : 1);
      }
    });

    it('never when the lane predicates fail', async () => {
      const updateBranch = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
      const { effects, exec } = await laneSetup({ facts: BEHIND, verdicts: [], updateBranch });
      expect(await exec.run((await enqueue(effects)).id)).toMatchObject({ status: 'refused', reason: 'verifier-pass-at-head:no-verdict' });
      expect(updateBranch).not.toHaveBeenCalled();
    });

    it('never for owner or moa-auto effects', async () => {
      for (const approvedBy of ['owner', 'moa-auto'] as const) {
        fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
        const { e, exec, merge } = await setup({ ok: false, code: 'blocked', reason: 'behind', message: 'behind' } as PrWriteResult, approvedBy, { ...FACTS, headRefName: 'wtask/x', mergeStateStatus: 'BEHIND' });
        const updateBranch = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
        const ports = (exec as unknown as { ports: MoaMergeExecutorPorts }).ports;
        const base = ports.laneContext;
        ports.updateBranch = updateBranch;
        ports.laneContext = async (eff, f) => ({ ...(await base(eff, f)), askerBranches: ['wtask/x'] });
        expect(await exec.run(e.id)).toMatchObject({ status: 'refused', reason: 'blocked-behind' });
        expect(updateBranch).not.toHaveBeenCalled();
        expect(merge).toHaveBeenCalledTimes(1);
      }
    });

    it('one update at a time: lane runs are serialized, per repo and overall', async () => {
      let live = 0;
      let peak = 0;
      const releases: Array<() => void> = [];
      const updateBranch = vi.fn(async (): Promise<PrWriteResult> => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise<void>((r) => releases.push(r));
        live -= 1;
        return { ok: true };
      });
      const verdicts = [7, 8, 9].map((prNumber) => ({ ...BOT_PASS, prNumber }));
      const { effects, exec } = await laneSetup({ facts: BEHIND, updateBranch, verdicts });
      const a = await enqueue(effects, 7);
      const b = await enqueue(effects, 8);
      const c = await enqueue(effects, 9, 'github.com/o/other');
      // Each PR reads as its own number.
      (exec as unknown as { ports: MoaMergeExecutorPorts }).ports.facts = { readFresh: async (_p, _k, n) => ({ ...BEHIND, number: n }) };
      const runs = [a, b, c].map((e) => exec.run(e.id));
      await vi.waitFor(() => expect(updateBranch).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      while (updateBranch.mock.calls.length < 3 || releases.length > 0) {
        releases.shift()?.();
        await new Promise((r) => setTimeout(r, 5));
      }
      const done = await Promise.all(runs);
      expect(peak).toBe(1);
      expect(done.map((r) => r?.reason)).toEqual(['behind-updated', 'behind-updated', 'behind-updated']);
      const repos = updateBranch.mock.calls.map((call) => (call as unknown as [MergeEffect])[0].repoKey);
      expect(repos.filter((k) => k === 'github.com/o/r')).toHaveLength(2);
    });
  });
});

describe('approval effects (owner and rule)', () => {
  const REQ = 'apr-req0000000001';
  const LANE_FACTS: PrLaneFacts = { ...FACTS, headRefName: 'wtask/fix-x-abc123' };
  const ROW: LaneEvidenceRow = {
    taskId: 'task-1', origin: { kind: 'bot', botId: 'bot-v' }, preset: 'verify', checkout: { sha: HEAD, detached: true },
    gate: { exitCode: 0, tail: '', at: 1, command: 'bash scripts/verify.sh', recordedBy: 'system', headSha: HEAD },
  };
  const BOT_PASS: PrVerdictRecord = {
    version: 2, repoKey: 'github.com/o/r', prNumber: 7, headSha: HEAD, verdict: 'pass',
    principal: { workspaceId: 'ws-verifier', botId: 'bot-v', agent: 'claude' }, evidence: { taskId: 'task-1', gateHeadSha: HEAD },
    summary: 'checked', at: Date.now(),
  };

  async function approvalSetup(approvedBy: 'owner' | 'rule', opts: {
    facts?: PrLaneFacts; authorize?: string | null; identity?: string | null; refusal?: string | null;
    inputs?: LaneAuthorizeInputs | null; verdicts?: PrVerdictRecord[]; wired?: boolean; lane?: boolean; requestId?: string;
  } = {}) {
    const effects = new MoaEffectStore(dir);
    const e = await effects.enqueueApproval({ requestId: opts.requestId ?? REQ, approvedBy, repoKey: 'github.com/o/r', repoPath: '/r', prNumber: 7, expectHead: HEAD });
    const merge = vi.fn(async (): Promise<PrWriteResult> => ({ ok: true }));
    const moaAuthorize = vi.fn(() => null);
    const authorize = vi.fn(() => opts.authorize ?? null);
    const identity = vi.fn(async () => opts.identity ?? null);
    const laneIdentity = vi.fn(async () => 'lane-identity-must-not-be-asked');
    const exec = new MoaMergeExecutor({
      effects, facts: { readFresh: async () => opts.facts ?? LANE_FACTS }, merge,
      laneContext: async () => { throw new Error('the Moa context is never read for a request'); },
      authorize: moaAuthorize,
      identity: laneIdentity,
      ...(opts.lane === false ? {} : {
        lane: { inputs: () => (opts.inputs === undefined ? { factoryEnabled: true, killSwitch: false, dailyCap: 5 } : opts.inputs), laneContext: async () => { throw new Error('lane only'); } },
      }),
      ...(opts.wired === false ? {} : {
        approval: {
          authorize,
          identity,
          refusal: async () => opts.refusal ?? null,
          laneContext: async () => ({
            trustedAuthors: ['owner'], askerBranches: [LANE_FACTS.headRefName], verdicts: opts.verdicts ?? [BOT_PASS],
            authorWorkspaces: ['ws-lead'], authorBots: ['bot-lead'], botVerdictsOnly: true, evidenceRows: new Map([['task-1', ROW]]),
          }),
        },
      }),
    });
    return { effects, e, exec, merge, moaAuthorize, authorize, identity, laneIdentity };
  }

  it('an owner approval merges on head-unchanged, through the approval port only', async () => {
    const s = await approvalSetup('owner', { facts: { ...LANE_FACTS, author: 'outsider', headRefName: 'feature/outside' } });
    expect(await s.exec.run(s.e.id)).toMatchObject({ status: 'done' });
    // Asked at the claim and again right before the merge.
    expect(s.authorize).toHaveBeenCalledTimes(2);
    expect(s.identity).toHaveBeenCalledTimes(1);
    expect(s.moaAuthorize).not.toHaveBeenCalled();
    expect(s.laneIdentity).not.toHaveBeenCalled();
  });

  it('a request no longer approved, or a changed gh login, merges nothing', async () => {
    const a = await approvalSetup('owner', { authorize: 'approval-not-approved' });
    expect(await a.exec.run(a.e.id)).toMatchObject({ status: 'refused', reason: 'approval-not-approved' });
    expect(a.merge).not.toHaveBeenCalled();
    fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
    const b = await approvalSetup('owner', { identity: 'identity-changed' });
    expect(await b.exec.run(b.e.id)).toMatchObject({ status: 'refused', reason: 'identity-changed' });
    expect(b.merge).not.toHaveBeenCalled();
  });

  it('a revocation that lands during the merge\'s own reads stops it before the write', async () => {
    const s = await approvalSetup('owner');
    let wrote = false;
    s.merge.mockImplementationOnce(async (...args: unknown[]) => {
      // The merge's own reads (checks, the head) run; the request is undone meanwhile.
      s.authorize.mockReturnValue('approval-not-approved' as never);
      const authorize = args[1] as () => string | null;
      if (authorize()) return { ok: false, code: 'invalid', message: 'not authorized' };
      wrote = true;
      return { ok: true };
    });
    expect(await s.exec.run(s.e.id)).toMatchObject({ status: 'refused', reason: 'approval-not-approved' });
    expect(wrote).toBe(false);
  });

  it('a moved head is refused head-moved, before any merge', async () => {
    const s = await approvalSetup('owner', { facts: { ...LANE_FACTS, headRefOid: 'c'.repeat(40) } });
    expect(await s.exec.run(s.e.id)).toMatchObject({ status: 'refused', reason: 'head-moved' });
    expect(s.merge).not.toHaveBeenCalled();
  });

  it('unwired, a request effect is refused', async () => {
    const s = await approvalSetup('owner', { wired: false });
    expect(await s.exec.run(s.e.id)).toMatchObject({ status: 'refused', reason: 'approval-not-wired' });
    expect(s.moaAuthorize).not.toHaveBeenCalled();
  });

  it('a rule approval runs every lane predicate and the rule gate (not the auto-merge switch)', async () => {
    const ok = await approvalSetup('rule');
    expect(await ok.exec.run(ok.e.id)).toMatchObject({ status: 'done' });
    fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
    const noPass = await approvalSetup('rule', { verdicts: [] });
    expect(await noPass.exec.run(noPass.e.id)).toMatchObject({ status: 'refused', reason: 'verifier-pass-at-head:no-verdict' });
    fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
    // Lane auto-merge off: the owner's rule still merges.
    const autoOff = await approvalSetup('rule', { inputs: { factoryEnabled: true, killSwitch: true, dailyCap: 5 } });
    expect(await autoOff.exec.run(autoOff.e.id)).toMatchObject({ status: 'done' });
    fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
    const factoryOff = await approvalSetup('rule', { inputs: { factoryEnabled: false, killSwitch: true, dailyCap: 5 } });
    expect(await factoryOff.exec.run(factoryOff.e.id)).toMatchObject({ status: 'refused', reason: 'factory-disabled' });
    fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
    const noLane = await approvalSetup('rule', { lane: false });
    expect(await noLane.exec.run(noLane.e.id)).toMatchObject({ status: 'refused', reason: 'lane-not-wired' });
    for (const s of [noPass, factoryOff, noLane]) expect(s.merge).not.toHaveBeenCalled();
  });

  it('a rule approval is refused on a run-time refusal (outside text behind the head)', async () => {
    const s = await approvalSetup('rule', { refusal: 'tainted-origin' });
    expect(await s.exec.run(s.e.id)).toMatchObject({ status: 'refused', reason: 'tainted-origin' });
    expect(s.merge).not.toHaveBeenCalled();
  });

  it('rule merges share the lane daily cap', async () => {
    const s = await approvalSetup('rule', { inputs: { factoryEnabled: true, killSwitch: false, dailyCap: 1 } });
    const lane = await s.effects.enqueueLane({ repoKey: 'github.com/o/r', repoPath: '/r', prNumber: 8, expectHead: HEAD });
    await s.effects.claim(lane.id);
    await s.effects.finish(lane.id, 'done');
    expect(await s.exec.run(s.e.id)).toMatchObject({ status: 'refused', reason: 'lane-daily-cap' });
  });

  it('reconcileAll: the lane executor runs request rows, an executor without a lane port leaves them', async () => {
    const s = await approvalSetup('owner', { lane: false });
    await s.exec.reconcileAll();
    expect(s.effects.get(s.e.id)?.status).toBe('pending');
    const withLane = await approvalSetup('owner', { requestId: 'apr-req0000000002' });
    await withLane.exec.reconcileAll();
    expect(withLane.effects.get(withLane.e.id)?.status).toBe('done');
  });

  it('rule is in the predicate table with every lane predicate', () => {
    expect(PREDICATES_BY_APPROVER.rule).toEqual(PREDICATES_BY_APPROVER.lane);
  });
});
