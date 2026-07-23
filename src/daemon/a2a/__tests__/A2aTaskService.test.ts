import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aTaskService, type TransitionInput } from '../A2aTaskService';
import type { A2aTaskTransitionPayload } from '../../../shared/a2aEventlog';
import type { CompletionEvidence } from '../../../shared/types';
import type { EventEnvelope } from '../../../shared/eventlog';
import { panePrincipalId } from '../../../shared/principals';

let dir: string;
const syncOk = (): void => {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a2a-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newLog(): AppendOnlyLog {
  const log = new AppendOnlyLog({ dir, fsync: syncOk });
  log.open();
  return log;
}

function newService(log: AppendOnlyLog): A2aTaskService {
  return new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 } });
}

async function seedWorkingTask(svc: A2aTaskService, id = 'task-1'): Promise<string> {
  const created = await svc.createTask({
    id,
    title: 'T',
    from: { workspaceId: 'ws-sender', name: 'Sender' },
    to: { workspaceId: 'ws-receiver', name: 'Receiver' },
  });
  expect(created.ok).toBe(true);
  const working = await svc.transition({ taskId: id, to: 'working', callerWorkspaceId: 'ws-receiver' });
  expect(working.ok).toBe(true);
  return id;
}

function transitionRecords(log: AppendOnlyLog, taskId: string): A2aTaskTransitionPayload[] {
  return log
    .readAllRecords()
    .filter((r) => r.domain === 'a2a')
    .map((r) => r.payload as { kind?: string })
    .filter((p): p is A2aTaskTransitionPayload => p.kind === 'task.transition' && (p as A2aTaskTransitionPayload).taskId === taskId);
}

/** Find a domain:'a2a' envelope (with authContext) by payload.kind (for §7 asserts). */
function a2aEnvelope(log: AppendOnlyLog, kind: string): EventEnvelope | undefined {
  return log
    .readAllRecords()
    .filter((r) => r.domain === 'a2a')
    .find((r) => (r.payload as { kind?: string }).kind === kind);
}

// ── T-A2A transition gate: daemon-side VALID_TRANSITIONS enforcement ────────────────────

describe('T-A2A VALID_TRANSITIONS daemon force', () => {
  it('submitted→completed Direct refusal', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-1',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const r = await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(false);
    // Rejected transitions are not appended to the log (canonical state stays clean).
    expect(transitionRecords(log, 'task-1')).toHaveLength(0);
    // Projection also stays submitted.
    expect(svc.getTask('task-1')?.status.state).toBe('submitted');
  });

  it('working→completed allowance', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    // With completion-evidence gate (PR-B) active, completed requires structured evidence — attach minimal compliant evidence.
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'done', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] },
    });
    expect(r.ok).toBe(true);
    expect(svc.getTask('task-1')?.status.state).toBe('completed');
  });

  it('Reject transit from non-receiver callers', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-sender' });
    expect(r.ok).toBe(false);
  });
});

// ── T-A2A: transitions reach daemon log (C12) + evidence payload carried ──────────

describe('T-A2A log reach + evidence reception', () => {
  it('completed metastasis domain:a2a envelopeAppend and store the evidence as verbatim', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);

    const evidence: CompletionEvidence = {
      summary: 'built and tested',
      items: [
        { kind: 'command', status: 'passed', summary: 'unit tests', command: 'npm test' },
        { kind: 'inspection', status: 'unverified', summary: 'eyeballed output' },
      ],
    };
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence,
    });
    expect(r.ok).toBe(true);
    // Verification grade (audit): only 1 command/passed item is verified → 1 (not a gate).
    expect(r.ok && r.verifiedItemCount).toBe(1);

    const recs = transitionRecords(log, 'task-1');
    const completed = recs.find((p) => p.to === 'completed');
    expect(completed).toBeDefined();
    expect(completed?.evidence?.summary).toBe('built and tested');
    expect(completed?.evidence?.items).toHaveLength(2);
    expect(completed?.verifiedItemCount).toBe(1);
    // Envelope contract: committed under domain:'a2a'.
    const a2aRecs = log.readAllRecords().filter((rec) => rec.domain === 'a2a');
    expect(a2aRecs.length).toBeGreaterThan(0);
    // Evidence is also reflected in projection.
    expect(svc.getTask('task-1')?.status.evidence?.summary).toBe('built and tested');
  });

  it('non-terminal transition(working→input-required)passes without evidence — the gate is only for terminal transitions', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc); // submitted→working itself succeeds without evidence (gate not applicable)
    const r = await svc.transition({ taskId: 'task-1', to: 'input-required', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(true); // Gate not invoked unless completed/failed
    expect(r.ok && r.verifiedItemCount).toBeUndefined();
  });

  it('malformed evidenceis rejected as isomorphic with the renderer wire guard.(Hygiene — Not a proof-of-completion gate)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { items: [{ kind: 'bogus' }] }, // no summary + unknown kind
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_malformed');
    // Rejected transition leaves log and projection clean.
    expect(transitionRecords(log, 'task-1').find((p) => p.to === 'completed')).toBeUndefined();
    expect(svc.getTask('task-1')?.status.state).toBe('working');
  });

  it('S-C2: Pain Pin Task + The caller claimed Payne's identity. soft-defer(Fallback to renderer gate)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-pin',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-7' }, // pane pin
    });
    const deferred = await svc.transition({
      taskId: 'task-pin',
      to: 'working',
      callerWorkspaceId: 'ws-receiver',
      callerHasPaneIdentity: true, // claims senderPtyId — interpretation owned by renderer
    });
    expect(deferred.ok).toBe(false);
    expect(!deferred.ok && deferred.error).toContain('pane-authz deferred');
    // Headless (no pane identity — ClaudeWorker) passes via ws-authz (worker transition invariant).
    const headless = await svc.transition({
      taskId: 'task-pin',
      to: 'working',
      callerWorkspaceId: 'ws-receiver',
    });
    expect(headless.ok).toBe(true);
  });
});

// ── T-A2A authContext server-derived (§7 PR5) ────────────────────────────────

describe('T-A2A authContext server guidance(§7)', () => {
  it('pane-Pin task transition → principalId = panePrincipalId(to.ws, to.paneId), trustTier=semi-trusted', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-pin',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-7' },
    });
    const r = await svc.transition({ taskId: 'task-pin', to: 'working', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(true);
    const env = a2aEnvelope(log, 'task.transition');
    expect(env?.authContext.principalId).toBe(panePrincipalId('ws-receiver', 'pane-7'));
    expect(env?.authContext.verifiedWorkspaceId).toBe('ws-receiver'); // server-pin authz anchor
    expect(env?.authContext.trustTier).toBe('semi-trusted');
  });

  it('ws-level task(pane mipin) transition → principalId = verifiedWorkspaceId fallback', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc); // to={ws-receiver}(no paneId) — working transition appended
    const env = a2aEnvelope(log, 'task.transition');
    expect(env?.authContext.principalId).toBe('ws-receiver'); // ws fallback
    expect(env?.authContext.verifiedWorkspaceId).toBe('ws-receiver');
  });

  it('The sender principalId/trustTierIgnored even if asserted — server-derived value takes precedence', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-spoof',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-9' },
    });
    // PR5 removed TransitionInput principalId/trustTier override fields —
    // even arbitrary runtime fields (spoof simulation) get server-derived values stamped only.
    const spoofed = {
      taskId: 'task-spoof',
      to: 'working',
      callerWorkspaceId: 'ws-receiver',
      principalId: 'pane:evil/spoof',
      trustTier: 'trusted',
    } as unknown as TransitionInput;
    const r = await svc.transition(spoofed);
    expect(r.ok).toBe(true);
    const env = a2aEnvelope(log, 'task.transition');
    expect(env?.authContext.principalId).toBe(panePrincipalId('ws-receiver', 'pane-9')); // not 'pane:evil/spoof'
    expect(env?.authContext.trustTier).toBe('semi-trusted'); // not 'trusted'
  });

  it('cancel(sender) → principalId = sender(caller) Side pane coordinates(Not receiving pane)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-c',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S', paneId: 'pane-s' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-r' },
    });
    const cancel = await svc.cancelTask({ taskId: 'task-c', callerWorkspaceId: 'ws-sender' });
    expect(cancel.ok).toBe(true);
    const env = a2aEnvelope(log, 'task.cancel');
    // cancel actor = sender → from-side pane coords (derivePrincipalId picks caller side).
    expect(env?.authContext.principalId).toBe(panePrincipalId('ws-sender', 'pane-s'));
    expect(env?.authContext.verifiedWorkspaceId).toBe('ws-sender');
  });

  it('create → principalId = sender(from) pane coordinate(create agent=sender)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-cr',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S', paneId: 'pane-s' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-r' },
    });
    const env = a2aEnvelope(log, 'task.create');
    expect(env?.authContext.principalId).toBe(panePrincipalId('ws-sender', 'pane-s'));
    expect(env?.authContext.verifiedWorkspaceId).toBe('ws-sender');
    expect(env?.authContext.trustTier).toBe('semi-trusted');
  });

  // 3-model review consensus (Codex·GLM·Claude): for self-address task (from.ws===to.ws)
  // actor role cannot be inferred from workspaceId match — must specify via role parameter.
  it('self-address create → sender(from) pane coordinate (When roles are not differentiated, to comes first. Regression guard)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-self-cr',
      title: 'T',
      from: { workspaceId: 'ws-x', name: 'S', paneId: 'pane-from' },
      to: { workspaceId: 'ws-x', name: 'R', paneId: 'pane-to' },
    });
    const env = a2aEnvelope(log, 'task.create');
    // create actor = sender → from pane. to-first bug would mis-stamp pane-to.
    expect(env?.authContext.principalId).toBe(panePrincipalId('ws-x', 'pane-from'));
  });

  it('self-address cancel(sender) → sender(from) pane coordinate (Not receiving pane)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-self-cx',
      title: 'T',
      from: { workspaceId: 'ws-x', name: 'S', paneId: 'pane-from' },
      to: { workspaceId: 'ws-x', name: 'R', paneId: 'pane-to' },
    });
    const cancel = await svc.cancelTask({ taskId: 'task-self-cx', callerWorkspaceId: 'ws-x' });
    expect(cancel.ok).toBe(true);
    const env = a2aEnvelope(log, 'task.cancel');
    // isSender and isReceiver both true → sender wins (cancel is usually sender act) → from pane.
    expect(env?.authContext.principalId).toBe(panePrincipalId('ws-x', 'pane-from'));
  });
});

// ── T-A2A idempotency: same-key retry → one log record ──────────────────────────────

describe('T-A2A idempotent', () => {
  it('Retry with same idempotencyKey results in original result without append(1 log)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-1',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const first = await svc.transition({ taskId: 'task-1', to: 'working', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'k1' });
    const second = await svc.transition({ taskId: 'task-1', to: 'working', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'k1' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // exactly one working transition record.
    const workingRecs = transitionRecords(log, 'task-1').filter((p) => p.to === 'working');
    expect(workingRecs).toHaveLength(1);
  });
});

// ── T-A2A cross-restart: projection restore ───────────────────────────────

describe('T-A2A cross-restart', () => {
  it('After restart, restoreFromLog restores tasks to their final state', async () => {
    const log1 = newLog();
    const svc1 = newService(log1);
    await seedWorkingTask(svc1);
    await svc1.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'done', items: [{ kind: 'inspection', status: 'verified', summary: 'ok' }] },
    });
    log1.close();

    // restart: new log (disk replay) + new service + restoreFromLog.
    const log2 = newLog();
    const svc2 = newService(log2);
    expect(svc2.taskCount).toBe(0); // empty before restore
    svc2.restoreFromLog();
    const task = svc2.getTask('task-1');
    expect(task).toBeDefined();
    expect(task?.status.state).toBe('completed');
    expect(task?.status.evidence?.summary).toBe('done');
    expect(task?.metadata.to.workspaceId).toBe('ws-receiver');
    log2.close();
  });
});

// ── T-A2A cancel + query ─────────────────────────────────────────────────

describe('A2aTaskService cancel + query', () => {
  it('senderCancellable, Queries filter by participating workspace', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-1',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const cancel = await svc.cancelTask({ taskId: 'task-1', callerWorkspaceId: 'ws-sender' });
    expect(cancel.ok).toBe(true);
    expect(svc.getTask('task-1')?.status.state).toBe('canceled');

    expect(svc.queryTasks('ws-sender')).toHaveLength(1);
    expect(svc.queryTasks('ws-receiver')).toHaveLength(1);
    expect(svc.queryTasks('ws-other')).toHaveLength(0);
    expect(svc.queryTasks('ws-sender', { role: 'agent' })).toHaveLength(0); // sender is user role
  });
});

// ── panel fixes: GC(A) · teardown force-fail(B) · idempotent reseed(E) · idempotent cancel(G) ──

function newServiceAt(log: AppendOnlyLog, now: () => number): A2aTaskService {
  return new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 }, now });
}

describe('A(panel) projection GC', () => {
  it('30Terminal tasks that elapse in minutes are removed by gcTerminalTasks, Incomplete and non-terminal status are maintained.', async () => {
    const t0 = 1_700_000_000_000;
    let clock = t0;
    const log = newLog();
    const svc = newServiceAt(log, () => clock);
    await svc.createTask({ id: 'done-1', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    await svc.transition({ taskId: 'done-1', to: 'working', callerWorkspaceId: 'ws-r' });
    await svc.transition({ taskId: 'done-1', to: 'completed', callerWorkspaceId: 'ws-r', evidence: { summary: 'ok', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] } });
    await svc.createTask({ id: 'live-1', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    await svc.transition({ taskId: 'live-1', to: 'working', callerWorkspaceId: 'ws-r' });

    clock = t0 + 31 * 60 * 1000; // 31 minutes elapsed
    svc.gcTerminalTasks();
    expect(svc.getTask('done-1')).toBeUndefined(); // terminal + elapsed → removed
    expect(svc.getTask('live-1')?.status.state).toBe('working'); // non-terminal → kept
    log.close();
  });

  it('restoreFromLogApply GC immediately after boot — do not resurrect old terminal tasks', async () => {
    const t0 = 1_700_000_000_000;
    const log1 = newLog();
    const svc1 = newServiceAt(log1, () => t0);
    await svc1.createTask({ id: 'old-done', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    await svc1.transition({ taskId: 'old-done', to: 'working', callerWorkspaceId: 'ws-r' });
    await svc1.transition({ taskId: 'old-done', to: 'completed', callerWorkspaceId: 'ws-r', evidence: { summary: 'ok', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] } });
    log1.close();

    // restart 31 min later: log is durable but boot GC immediately prunes old terminal tasks.
    const log2 = newLog();
    const svc2 = newServiceAt(log2, () => t0 + 31 * 60 * 1000);
    svc2.restoreFromLog();
    expect(svc2.getTask('old-done')).toBeUndefined(); // no resurrection
    expect(svc2.taskCount).toBe(0);
    log2.close();
  });
});

describe('B(panel) teardown force-fail entry point', () => {
  it('workspace When removing, commit a non-terminal receiving task as failed with a forced marker. + restart survival', async () => {
    const log = newLog();
    const svc = newService(log);
    // submitted + working toward ws-gone, plus unrelated ws-keep task.
    await svc.createTask({ id: 'sub', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-gone', name: 'G' } });
    await svc.createTask({ id: 'wrk', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-gone', name: 'G' } });
    await svc.transition({ taskId: 'wrk', to: 'working', callerWorkspaceId: 'ws-gone' });
    await svc.createTask({ id: 'keep', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-keep', name: 'K' } });

    const n = await svc.failTasksForWorkspaceRemoved('ws-gone', 'gone');
    expect(n).toBe(2); // both submitted + working (graph bypass)
    expect(svc.getTask('sub')?.status.state).toBe('failed');
    expect(svc.getTask('wrk')?.status.state).toBe('failed');
    expect(svc.getTask('keep')?.status.state).toBe('submitted'); // unrelated ws untouched

    // log gets forced marker + synthetic evidence.
    const subRec = transitionRecords(log, 'sub').find((p) => p.to === 'failed');
    expect(subRec?.forced).toBe('workspace_removed');
    expect(subRec?.evidence?.summary).toBe('gone');

    // restart: canonical restores to failed (no resurrection — teardown reached canonical).
    log.close();
    const log2 = newLog();
    const svc2 = newService(log2);
    svc2.restoreFromLog();
    expect(svc2.getTask('sub')?.status.state).toBe('failed');
    expect(svc2.getTask('wrk')?.status.state).toBe('failed');
    log2.close();
  });

  it('Normal transition API still rejects submitted→failed(Entry point is not graph relaxation)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({ id: 'sub', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    const r = await svc.transition({ taskId: 'sub', to: 'failed', callerWorkspaceId: 'ws-r' });
    expect(r.ok).toBe(false);
    log.close();
  });

  it('force-failis idempotent — tasks that terminate while waiting for a lock are not recommitted.(recall no-op)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({ id: 'sub', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-gone', name: 'G' } });
    expect(await svc.failTasksForWorkspaceRemoved('ws-gone', 'gone')).toBe(1);
    expect(await svc.failTasksForWorkspaceRemoved('ws-gone', 'gone')).toBe(0); // already terminal → 0
    log.close();
  });
});

describe('E(panel) Cross-restart idempotent reseeding', () => {
  it('Retry same key after restart → original result(invalid transition Not), log no increase', async () => {
    const log1 = newLog();
    const svc1 = newService(log1);
    await seedWorkingTask(svc1); // submitted→working (no key)
    // commit completed with idempotency key.
    await svc1.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'kc', evidence: { summary: 'ok', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] } });
    log1.close();

    const log2 = newLog();
    const svc2 = newService(log2);
    svc2.restoreFromLog();
    const recBefore = log2.readAllRecords().length;
    // same-key retry — without reseed, completed→completed becomes invalid transition.
    const retry = await svc2.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'kc' });
    expect(retry.ok).toBe(true); // idempotent absorb
    expect(log2.readAllRecords().length).toBe(recBefore); // no append
    log2.close();
  });
});

describe('G(panel) idempotent cancel', () => {
  it('Already terminated(completed)Cancellation of in-task is no-op success(log no increase)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver', evidence: { summary: 'ok', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] } });
    const recBefore = log.readAllRecords().length;
    const cancel = await svc.cancelTask({ taskId: 'task-1', callerWorkspaceId: 'ws-sender' });
    expect(cancel.ok).toBe(true); // not reject (regression guard)
    expect(svc.getTask('task-1')?.status.state).toBe('completed'); // state unchanged
    expect(log.readAllRecords().length).toBe(recBefore); // no append
    log.close();
  });
});

describe('A delta: Hardcap evicts only the endpoints — active tasks are not lost from the source', () => {
  it('cap(500) If all excesses are non-terminal, evict them. 0(everyone survives)', async () => {
    const log = newLog();
    const svc = newService(log);
    for (let i = 0; i < 502; i++) {
      // eslint-disable-next-line no-await-in-loop
      await svc.createTask({ id: `t-${i}`, title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    }
    expect(svc.taskCount).toBe(502);
    svc.gcTerminalTasks(); // zero terminal candidates → hard cap must not delete active
    expect(svc.taskCount).toBe(502); // canonical integrity (active preserved)
    log.close();
  });
});

// ── §6.M PR-B: completion-evidence gate active (gate=structure, verified=grade) ──────────────

describe('PR-B Completion Proof Gate', () => {
  it('T-gate-missing ★Acceptance criteria: evidence completed without → completion_evidence_missing rejected, Status/log immutable', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const recBefore = log.readAllRecords().length;
    const r = await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_missing');
    // projection stays working (transition not applied).
    expect(svc.getTask('task-1')?.status.state).toBe('working');
    // no completed transition record appended (canonical unpolluted).
    expect(transitionRecords(log, 'task-1').find((p) => p.to === 'completed')).toBeUndefined();
    expect(log.readAllRecords().length).toBe(recBefore);
  });

  it('completed + well-formed(command/passed include) → ok + verifiedItemCount + status.evidence save', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: {
        summary: 'built + tested',
        items: [
          { kind: 'command', status: 'passed', summary: 'unit', command: 'npm test' },
          { kind: 'inspection', status: 'unverified', summary: 'eyeballed' },
        ],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.verifiedItemCount).toBe(1); // only command/passed verified (grade)
    expect(svc.getTask('task-1')?.status.evidence?.summary).toBe('built + tested');
  });

  it('completed + unverified-only item → ok + verifiedItemCount=0 (E9 Rating - Not Washable)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'done', items: [{ kind: 'inspection', status: 'unverified', summary: 'self-reported' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.verifiedItemCount).toBe(0); // honest label: completed but unverified
  });

  it('completed + empty items → completion_evidence_no_items rejected', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'x', items: [] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_no_items');
    expect(svc.getTask('task-1')?.status.state).toBe('working');
  });

  it('completed + Empty summary → completion_evidence_empty_summary rejected', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: '   ', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_empty_summary');
  });

  it('completed + shapeis correct, but the command item is empty → completion_evidence_invalid_item (Gate is noisy)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    // command item shape (kind/status/command:string) passes normalize but
    // empty command string is not well-formed → gate rejects as invalid_item.
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'x', items: [{ kind: 'command', status: 'passed', summary: 'ok', command: '' }] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_invalid_item');
  });

  it('failed + evidence None → failure_reason_missing rejected', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({ taskId: 'task-1', to: 'failed', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('failure_reason_missing');
    expect(svc.getTask('task-1')?.status.state).toBe('working');
  });

  it('failed + Reason summary only(items doesn't exist) → ok (asymmetry E3)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'failed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'build broke', items: [] },
    });
    expect(r.ok).toBe(true);
    expect(svc.getTask('task-1')?.status.state).toBe('failed');
    expect(r.ok && r.verifiedItemCount).toBe(0);
  });

  it('failed + malformed item(unknown kind) → completion_evidence_malformed (normalize death in stages)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    // unknown kind rejected first by normalizeCompletionEvidenceWire (X8 shape hygiene) —
    // dies as malformed before gate's completion_evidence_invalid_item.
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'failed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'reason', items: [{ kind: 'bogus', status: 'passed', summary: 'x' }] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_malformed');
    expect(svc.getTask('task-1')?.status.state).toBe('working');
  });

  it('Gate rejections are not recorded in the idempotent cache — retry with the same key as evidence → success', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    // completed without evidence (same key) → gate reject (no idempotency record pre-append).
    const rejected = await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'kX' });
    expect(rejected.ok).toBe(false);
    expect(svc.getTask('task-1')?.status.state).toBe('working'); // state unchanged
    // retry same key with compliant evidence → cache miss → normal accept → success (roadmap migration path).
    const ok = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      idempotencyKey: 'kX',
      evidence: { summary: 'done', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] },
    });
    expect(ok.ok).toBe(true);
    expect(svc.getTask('task-1')?.status.state).toBe('completed');
  });

  it('teardown force-failbypasses the completion proof gate — items:[] Commit submitted→failed with synthetic evidence', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({ id: 'sub', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-gone', name: 'G' } });
    // submitted→failed impossible on graph and gate separate, but force-fail bypasses both.
    const n = await svc.failTasksForWorkspaceRemoved('ws-gone', 'workspace removed');
    expect(n).toBe(1);
    expect(svc.getTask('sub')?.status.state).toBe('failed');
    const rec = transitionRecords(log, 'sub').find((p) => p.to === 'failed');
    expect(rec?.forced).toBe('workspace_removed');
    expect(rec?.evidence?.items).toHaveLength(0); // gate bypassed (synthetic evidence as-is)
  });

  it('Fixed order(review GLM): pane-authz Rejection comes before the gate — sibling pane + evidence Absence is a pane error', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-p',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-B' },
    });
    const working = await svc.transition({ taskId: 'task-p', to: 'working', callerWorkspaceId: 'ws-receiver' });
    expect(working.ok).toBe(true);
    // deliberately no evidence — if gate regresses before authz, completion_evidence_missing appears first.
    const r = await svc.transition({
      taskId: 'task-p',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      callerAddr: { paneId: 'pane-A' },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('caller pane is not the addressed receiver pane');
    expect(!r.ok && r.error).not.toContain('completion_evidence');
  });

  it('non-terminal transition + evidence(review GLM): Gate non-target or acceptance + verifiedItemCount output is maintained', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-w',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const r = await svc.transition({
      taskId: 'task-w',
      to: 'working',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'progress', items: [{ kind: 'command', status: 'passed', summary: 'lint', command: 'npm run lint' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.verifiedItemCount).toBe(1); // else-if branch (non-terminal count) regression guard
    expect(svc.getTask('task-w')?.status.evidence?.summary).toBe('progress');
  });

  it('Fixed order(review codex delta): soft-deferbefore gate — threadpipe path(callerHasPaneIdentity, callerAddr uninterpreted)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-sd',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-B' },
    });
    const working = await svc.transition({ taskId: 'task-sd', to: 'working', callerWorkspaceId: 'ws-receiver' });
    expect(working.ok).toBe(true);
    // daemon pipe handler never resolves callerAddr (senderPtyId → callerHasPaneIdentity only).
    // without evidence — if gate regresses before soft-defer, completion_evidence_missing appears and
    // dogfood (renderer fallback pane-authz expectation) breaks. This test locks order at unit level.
    const r = await svc.transition({
      taskId: 'task-sd',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      callerHasPaneIdentity: true,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('pane-authz deferred');
    expect(!r.ok && r.error).not.toContain('completion_evidence');
  });

  it('Idempotent hit is after authz(review codex delta): Non-participants who know the key cannot replay commit snapshots.', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const ok = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      idempotencyKey: 'kR',
      evidence: { summary: 'done', items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }] },
    });
    expect(ok.ok).toBe(true);
    // third workspace knowing (taskId, key) gets authz reject instead of cache replay.
    const intruder = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-intruder',
      idempotencyKey: 'kR',
    });
    expect(intruder.ok).toBe(false);
    expect(!intruder.ok && intruder.error).toContain('is not the receiver');
  });

  it('Idempotent op namespace(review codex delta): cancel Transition results cannot be reproduced with keys', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-x',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const canceled = await svc.cancelTask({ taskId: 'task-x', callerWorkspaceId: 'ws-sender', idempotencyKey: 'kC' });
    expect(canceled.ok).toBe(true);
    // transition with same key does not mis-return CancelOk; honest verdict (canceled is terminal).
    const r = await svc.transition({
      taskId: 'task-x',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      idempotencyKey: 'kC',
      evidence: { summary: 'x', items: [{ kind: 'inspection', status: 'unverified', summary: 'y' }] },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('invalid transition');
  });
});
