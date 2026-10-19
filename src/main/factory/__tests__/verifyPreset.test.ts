// The verify preset's main half: a bot verify task that reports
// review_requested is gated by main at its head with the base branch's gate,
// and its verifier is woken once the gate is recorded.
import { describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../../../shared/ledger';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../shared/bot';
import type { GateRunInput, GateRunResult } from '../../worktask/TaskGateRunner';
import { describeGateRun, installVerifyGate, isVerifyReport, originDefaultRef, taskFolderFromMissions, verifyGateFactId, worktreeFromMissions, type VerifyGatePorts } from '../verifyPreset';

const SHA = 'a'.repeat(40);
const BOT_ID = 'bot-0a1b2c3d';

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1, id: 'task-1', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-v', title: 'verify #7', status: 'review_requested',
    rev: 4, updatedAt: 1, updatedBy: { kind: 'worker' },
    dispatch: { origin: { kind: 'bot', botId: BOT_ID }, preset: 'verify', checkout: { sha: SHA, detached: true } },
    ...over,
  } as LedgerEntry;
}

const verifier: BotProfile = {
  version: 1, id: BOT_ID, workspaceId: 'ws-v', role: 'verifier', name: 'V', engine: { kind: 'claude-sdk' }, triggers: [],
  budget: { ...DEFAULT_BOT_BUDGETS.verifier }, repo: { repoKey: 'o/r', repoPath: '/repo' }, enabled: true, createdAt: 1, updatedAt: 1,
};

function rig(over: Partial<VerifyGatePorts> = {}, result: GateRunResult = {
  ok: true, status: 'completed', taskId: 'task-1', recorded: true,
  result: { exitCode: 0, tail: '', at: 2, command: 'npm run lint && npm test', recordedBy: 'system', headSha: SHA },
}) {
  let listener: ((t: { entry: LedgerEntry; from: string | null; to: string }) => void) | null = null;
  const runGate = vi.fn(async (input: GateRunInput) => ({ ...result, taskId: input.taskId }) as GateRunResult);
  const wake = vi.fn();
  const note = vi.fn();
  const off = installVerifyGate({
    onTransition: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    ledgerRow: () => entry({ rev: 5 }),
    bot: (id) => (id === BOT_ID ? verifier : null),
    worktreeOf: async () => '/wt/task-1',
    baseRef: async () => 'origin/main',
    runGate,
    wake,
    note,
    ...over,
  });
  const fire = async (e: LedgerEntry, to = 'review_requested') => {
    listener?.({ entry: e, from: 'working', to });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { fire, runGate, wake, note, off };
}

describe('verify gate', () => {
  it('gates the head with the base branch\'s gate, then wakes the verifier with the recorded rev', async () => {
    const r = rig();
    await r.fire(entry());
    expect(r.runGate).toHaveBeenCalledWith({
      taskId: 'task-1', worktreePath: '/wt/task-1', systemWorkspaceId: 'ws-daemon', projectRoot: '/repo', gateBaseRef: 'origin/main',
    });
    expect(r.wake).toHaveBeenCalledWith({
      botId: BOT_ID, workspaceId: 'ws-v', priority: 1, threadId: 'task:task-1',
      reason: { kind: 'facts', factIds: [verifyGateFactId('task-1', 5)], trigger: { kind: 'task.done' } },
    });
    expect(r.note.mock.calls[0][2]).toBe('Verify gate passed');
    expect(r.note.mock.calls[0][4]).toEqual({ code: 'verify.passed' });
  });

  it('only bot verify tasks on a detached checkout reporting review_requested', async () => {
    const r = rig();
    await r.fire(entry(), 'failed');
    await r.fire(entry({ dispatch: { origin: { kind: 'bot', botId: BOT_ID }, preset: 'repro' } }));
    await r.fire(entry({ dispatch: { origin: { kind: 'orchestrator' }, preset: 'verify', checkout: { sha: SHA, detached: true } } }));
    await r.fire(entry({ dispatch: { origin: { kind: 'bot', botId: BOT_ID }, preset: 'verify' } }));
    await r.fire(entry({ dispatch: undefined }));
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.wake).not.toHaveBeenCalled();
    expect(isVerifyReport(entry(), 'review_requested')).toBe(true);
  });

  it('no worktree or no base ref: nothing runs, a card says why, the verifier still hears', async () => {
    const r = rig({ worktreeOf: async () => null });
    await r.fire(entry());
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.note.mock.calls[0][2]).toBe('Verify gate not run');
    expect(r.note.mock.calls[0][4]).toEqual({ code: 'verify.notRunNoWorktree' });
    expect(r.wake).toHaveBeenCalledTimes(1);
    const b = rig({ baseRef: async () => null });
    await b.fire(entry());
    expect(b.runGate).not.toHaveBeenCalled();
    expect(b.note.mock.calls[0][3]).toMatch(/default branch/);
    expect(b.note.mock.calls[0][4]).toEqual({ code: 'verify.notRunNoBaseRef' });
  });

  it('a dispatching bot of any role tag is gated; one that is gone or has no repository runs nothing and wakes nobody', async () => {
    const lead = rig({ bot: () => ({ ...verifier, role: 'lead', template: 'developer' }) });
    await lead.fire(entry());
    expect(lead.runGate).toHaveBeenCalledTimes(1);
    const r = rig({ bot: () => ({ ...verifier, repo: undefined }) });
    await r.fire(entry());
    const gone = rig({ bot: () => null });
    await gone.fire(entry());
    expect(r.runGate).not.toHaveBeenCalled();
    expect(gone.runGate).not.toHaveBeenCalled();
    expect(r.wake).not.toHaveBeenCalled();
  });

  it('a busy runner wakes nobody (the running gate\'s result will)', async () => {
    const r = rig({}, { ok: false, status: 'busy', taskId: 'task-1' });
    await r.fire(entry());
    expect(r.wake).not.toHaveBeenCalled();
  });

  it('a task that left review_requested while its gate ran (cancelled, stopped) gets no card and wakes nobody', async () => {
    let ran = false;
    const r = rig({
      ledgerRow: () => (ran ? entry({ rev: 6, status: 'cancelled' }) : entry({ rev: 5 })),
      runGate: vi.fn(async (input: GateRunInput) => {
        ran = true;
        return { ok: true, status: 'completed', taskId: input.taskId, recorded: true, result: { exitCode: null, tail: '', at: 2, command: 'npm test', recordedBy: 'system' } } as GateRunResult;
      }),
    });
    await r.fire(entry());
    expect(ran).toBe(true);
    expect(r.note).not.toHaveBeenCalled();
    expect(r.wake).not.toHaveBeenCalled();
  });

  it('a task that left review_requested during the lookups gets no gate', async () => {
    const r = rig({ ledgerRow: () => entry({ rev: 6, status: 'cancelled' }) });
    await r.fire(entry());
    expect(r.runGate).not.toHaveBeenCalled();
    expect(r.wake).not.toHaveBeenCalled();
  });

  it('after a restart: an ungated verify report is gated, a gated one re-queues its verifier wake', async () => {
    const ungated = rig({ openRows: () => [entry(), entry({ id: 'task-2', status: 'working' })] });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(ungated.runGate).toHaveBeenCalledTimes(1);
    expect(ungated.runGate.mock.calls[0][0].taskId).toBe('task-1');
    const gated = rig({
      openRows: () => [entry({ rev: 7, gate: { exitCode: 0, tail: '', at: 1, command: 'npm test', recordedBy: 'system', headSha: SHA } })],
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(gated.runGate).not.toHaveBeenCalled();
    expect(gated.wake).toHaveBeenCalledWith(expect.objectContaining({ reason: { kind: 'facts', factIds: [verifyGateFactId('task-1', 7)], trigger: { kind: 'task.done' } } }));
  });

  it('describes skips, refusals and red gates for the thread', () => {
    expect(describeGateRun({ ok: true, status: 'skipped', taskId: 't', skipped: 'deps_missing', detail: 'node_modules is missing' }).title).toBe('Verify gate skipped (deps_missing)');
    expect(describeGateRun({ ok: false, status: 'refused', taskId: 't', error: 'base gate differs' }).body).toBe('base gate differs');
    expect(describeGateRun({ ok: true, status: 'completed', taskId: 't', recorded: true, result: { exitCode: 1, tail: '', at: 1, command: 'npm test', headSha: SHA } }).title).toBe('Verify gate failed (exit 1)');
  });

  it('each gate card carries its notice code', () => {
    const completed = (exitCode: number | null) => describeGateRun({ ok: true, status: 'completed', taskId: 't', recorded: true, result: { exitCode, tail: '', at: 1, command: 'npm test', headSha: SHA } }).notice;
    expect(completed(1)).toEqual({ code: 'verify.failed', args: { exit: 1 } });
    expect(completed(null)).toEqual({ code: 'verify.killed' });
    expect(describeGateRun({ ok: true, status: 'skipped', taskId: 't', skipped: 'deps_missing', detail: 'x' }).notice).toEqual({ code: 'verify.skipped', args: { reason: 'deps_missing' } });
    expect(describeGateRun({ ok: false, status: 'busy', taskId: 't' }).notice).toEqual({ code: 'verify.busy' });
    expect(describeGateRun({ ok: false, status: 'refused', taskId: 't', error: 'base gate differs' }).notice).toEqual({ code: 'verify.refused' });
  });

  it('default ports: the worktree from the owner\'s mission list, origin\'s default branch', async () => {
    const rpc = vi.fn(async () => ({ ok: true, tasks: [{ id: 'other', worktreePath: '/x' }, { id: 'task-1', worktreePath: '/wt/1' }] }));
    expect(await worktreeFromMissions(rpc, entry())).toBe('/wt/1');
    expect(rpc).toHaveBeenCalledWith('task.mission.list', { verifiedWorkspaceId: 'ws-v' });
    expect(await worktreeFromMissions(null, entry())).toBeNull();
    expect(await worktreeFromMissions(async () => ({ ok: false }), entry())).toBeNull();
    // A research task has no worktree: its worker is found (and reclaimed) in its output folder.
    const research = vi.fn(async () => ({ ok: true, tasks: [{ id: 'task-1', outputDir: '/bots/b/research/batch/1-claude-x' }] }));
    expect(await worktreeFromMissions(research, entry())).toBeNull();
    expect(await taskFolderFromMissions(research, entry())).toBe('/bots/b/research/batch/1-claude-x');
    expect(await taskFolderFromMissions(rpc, entry())).toBe('/wt/1');
    const git = async (args: string[]) => (args[0] === 'symbolic-ref' ? { stdout: 'refs/remotes/origin/trunk\n', code: 0 } : { stdout: '', code: 1 });
    expect(await originDefaultRef(git, '/r')).toBe('origin/trunk');
    const noHead = async (args: string[]) => (args[0] === 'symbolic-ref' ? { stdout: '', code: 1 } : args[3]?.includes('master') ? { stdout: SHA, code: 0 } : { stdout: '', code: 1 });
    expect(await originDefaultRef(noHead, '/r')).toBe('origin/master');
    expect(await originDefaultRef(async () => ({ stdout: '', code: 1 }), '/r')).toBeNull();
  });
});
