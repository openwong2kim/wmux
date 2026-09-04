// deck.completeWork — the final-response barrier for a direct human request.
//
// The commander must not be able to close a request by asserting it is done.
// This handler re-checks the live worker snapshot and RE-QUERIES every A2A task
// projected into the durable work record before deleting it, and it compares the
// work id at delete time so a request that arrived mid-check is never closed by
// the older verdict. The summary/verification text is auditable prose, never
// treated as proof.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RpcRouter } from '../../RpcRouter';
import {
  mintCommanderToken,
  __resetCommanderTrustForTesting,
} from '../../../deck/commanderTrust';
import type { FleetSnapshot, FleetSnapshotPane } from '../../../../shared/workspaceMirror';

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

// The gate consults the renderer-derived fleet snapshot for local workers.
const { snapshotRef } = vi.hoisted(() => ({ snapshotRef: { current: null as FleetSnapshot | null } }));
vi.mock('../../../workspace/WorkspaceMirror', () => ({
  getWorkspaceMirror: () => ({ getFleetSnapshot: () => snapshotRef.current }),
}));

// Route the file-backed work store at a temp dir for the whole suite.
const { workDirRef } = vi.hoisted(() => ({ workDirRef: { current: '' } }));
vi.mock('../../../deck/deckWorkStore', async (orig) => {
  const actual = await orig<typeof import('../../../deck/deckWorkStore')>();
  return {
    ...actual,
    loadActiveDeckWork: (ws: string) => actual.loadActiveDeckWork(ws, workDirRef.current),
    completeActiveDeckWork: (ws: string, expected: Parameters<typeof actual.completeActiveDeckWork>[1]) =>
      actual.completeActiveDeckWork(ws, expected, workDirRef.current),
  };
});

import { registerDeckRpc } from '../deck.rpc';
import {
  beginOrContinueDeckWork,
  recordDeckWorkA2aTask,
  loadActiveDeckWork,
  clearActiveDeckWork,
} from '../../../deck/deckWorkStore';

const fakeWindow = {} as BrowserWindow;
const WS = 'ws-1';
const GOOD = { summary: 'shipped the roster PR', verification: 'ran vitest: 161 passed' };

function pane(over: Partial<FleetSnapshotPane> = {}): FleetSnapshotPane {
  return { ptyId: 'pane-1', agentName: 'Claude Code', agentStatus: 'idle', isActivePane: false, ...over };
}

let router: RpcRouter;
let token: string;
/** a2a.task.query replies, registered per test. */
let taskQuery: (() => unknown) | null;

function setup(): void {
  router = new RpcRouter();
  registerDeckRpc(router, () => fakeWindow);
  // Stand in for the real a2a handler so the canonical re-query is observable.
  router.register('a2a.task.query' as never, async () => {
    if (!taskQuery) throw new Error('a2a unavailable');
    return taskQuery();
  });
}

async function complete(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await router.dispatch({
    id: 'c1',
    method: 'deck.completeWork',
    params: { token, ...GOOD, ...params },
  });
  if (!res.ok) return { __dispatchFailed: true, error: res.error };
  return res.result as Record<string, unknown>;
}

beforeEach(() => {
  __resetCommanderTrustForTesting();
  workDirRef.current = mkdtempSync(path.join(tmpdir(), 'wmux-completework-'));
  snapshotRef.current = { workspaceId: WS, ts: Date.now(), panes: [pane()] };
  taskQuery = () => ({ tasks: [] });
  token = mintCommanderToken(WS);
  setup();
});

afterEach(() => {
  rmSync(workDirRef.current, { recursive: true, force: true });
});

describe('deck.completeWork — authorization', () => {
  it('refuses a caller that is not a live commander session', async () => {
    beginOrContinueDeckWork(WS, 'objective', workDirRef.current);
    const res = await router.dispatch({
      id: 'c1',
      method: 'deck.completeWork',
      params: { token: 'not-a-token', ...GOOD },
    });
    expect(res.ok).toBe(false);
    // The work must survive an unauthorized attempt.
    expect(loadActiveDeckWork(WS, workDirRef.current)).not.toBeNull();
  });

  it('reports no_active_work rather than inventing a completion', async () => {
    expect(await complete()).toEqual({ ok: false, error: 'no_active_work' });
  });
});

describe('deck.completeWork — text requirements', () => {
  beforeEach(() => {
    beginOrContinueDeckWork(WS, 'objective', workDirRef.current);
  });

  it('rejects an insubstantial summary', async () => {
    expect(await complete({ summary: 'done' })).toEqual({ ok: false, error: 'summary_too_short' });
  });

  it('requires a verification statement', async () => {
    expect(await complete({ verification: '' })).toEqual({ ok: false, error: 'verification_required' });
    expect(await complete({ verification: 'looks ok' })).toEqual({ ok: false, error: 'verification_required' });
  });

  it('leaves the work OPEN when the text is refused', async () => {
    await complete({ summary: 'no' });
    expect(loadActiveDeckWork(WS, workDirRef.current)).not.toBeNull();
  });

  it('accepts substantive text and closes the record', async () => {
    const res = await complete();
    expect(res).toMatchObject({ ok: true, summary: GOOD.summary, verification: GOOD.verification });
    expect(loadActiveDeckWork(WS, workDirRef.current)).toBeNull();
  });
});

describe('deck.completeWork — local workers', () => {
  beforeEach(() => {
    beginOrContinueDeckWork(WS, 'objective', workDirRef.current);
  });

  it.each(['running', 'awaiting_input'] as const)('refuses while a pane is %s', async (agentStatus) => {
    snapshotRef.current = { workspaceId: WS, ts: Date.now(), panes: [pane({ agentStatus })] };
    const res = await complete();
    expect(res).toMatchObject({ ok: false, error: 'workers_outstanding' });
    expect(res['panes']).toEqual([{ ptyId: 'pane-1', agent: 'Claude Code', status: agentStatus }]);
    expect(loadActiveDeckWork(WS, workDirRef.current)).not.toBeNull();
  });

  it('allows when every pane is quiescent', async () => {
    snapshotRef.current = {
      workspaceId: WS,
      ts: Date.now(),
      panes: [pane({ agentStatus: 'complete' }), pane({ ptyId: 'p2', agentStatus: 'idle' })],
    };
    expect(await complete()).toMatchObject({ ok: true });
  });

  // Finding 11 (dogfood 2026-09): the operator's own zsh promotes to `running`
  // off byte activity alone, and the gate counted it as a worker — refusing a
  // completion nobody could ever clear (the shell belongs to the human).
  it('does not count a running SHELL pane as an outstanding worker', async () => {
    snapshotRef.current = {
      workspaceId: WS,
      ts: Date.now(),
      panes: [pane({ ptyId: 'daemon-5dac0302', agentName: null, agentStatus: 'running', isAgent: false })],
    };
    expect(await complete()).toMatchObject({ ok: true });
  });

  it('still refuses for a running AGENT pane, and names only it', async () => {
    snapshotRef.current = {
      workspaceId: WS,
      ts: Date.now(),
      panes: [
        pane({ ptyId: 'daemon-5dac0302', agentName: null, agentStatus: 'running', isAgent: false }),
        pane({ ptyId: 'worker-1', agentStatus: 'running', isAgent: true }),
      ],
    };
    const res = await complete();
    expect(res).toMatchObject({ ok: false, error: 'workers_outstanding' });
    expect(res['panes']).toEqual([{ ptyId: 'worker-1', agent: 'Claude Code', status: 'running' }]);
  });

  // An older renderer omits `isAgent` entirely; unknown identity must keep the
  // shipped behaviour (hold) rather than silently disarm the gate.
  it('treats a pane with no isAgent field as an agent', async () => {
    snapshotRef.current = {
      workspaceId: WS,
      ts: Date.now(),
      panes: [pane({ agentStatus: 'running' })],
    };
    expect(await complete()).toMatchObject({ ok: false, error: 'workers_outstanding' });
  });

  it('does NOT wedge on a stale snapshot — it cannot prove work outstanding', async () => {
    snapshotRef.current = {
      workspaceId: WS,
      ts: Date.now() - 60_000,
      panes: [pane({ agentStatus: 'running' })],
    };
    expect(await complete()).toMatchObject({ ok: true });
  });

  it('does not wedge when the renderer has no snapshot at all', async () => {
    snapshotRef.current = null;
    expect(await complete()).toMatchObject({ ok: true });
  });
});

describe('deck.completeWork — A2A canonical re-query', () => {
  beforeEach(() => {
    beginOrContinueDeckWork(WS, 'objective', workDirRef.current, 1_000);
  });

  function track(taskId: string, state: 'submitted' | 'completed' = 'submitted'): void {
    recordDeckWorkA2aTask(WS, { taskId, to: 'ws-worker', state, ts: 2_000 }, workDirRef.current);
  }

  it('skips the query entirely when nothing was delegated', async () => {
    taskQuery = () => {
      throw new Error('must not be queried');
    };
    expect(await complete()).toMatchObject({ ok: true });
  });

  it('refuses when a tracked task is not canonically completed', async () => {
    track('task-1');
    taskQuery = () => ({ tasks: [{ id: 'task-1', status: { state: 'working' } }] });
    const res = await complete();
    expect(res).toMatchObject({ ok: false, error: 'a2a_tasks_outstanding' });
    expect(res['tasks']).toEqual([{ taskId: 'task-1', state: 'working' }]);
  });

  it('does not trust the projected state — a locally "completed" task is re-checked', async () => {
    // The projection said completed; the canonical service disagrees. The
    // canonical answer wins, which is the whole point of the re-query.
    track('task-1', 'completed');
    taskQuery = () => ({ tasks: [{ id: 'task-1', status: { state: 'failed' } }] });
    expect(await complete()).toMatchObject({ ok: false, error: 'a2a_tasks_outstanding' });
  });

  it('refuses when a tracked task is missing from the canonical listing', async () => {
    track('task-1');
    taskQuery = () => ({ tasks: [] });
    const res = await complete();
    expect(res).toMatchObject({ ok: false, error: 'a2a_tasks_outstanding' });
    expect(res['tasks']).toEqual([{ taskId: 'task-1', state: null }]);
  });

  it('refuses when the canonical state is unavailable (fail closed, not open)', async () => {
    track('task-1');
    taskQuery = () => ({ notTasks: true });
    expect(await complete()).toMatchObject({ ok: false, error: 'a2a_state_unavailable' });
  });

  it('refuses when the query itself fails', async () => {
    track('task-1');
    taskQuery = null; // handler throws
    expect(await complete()).toMatchObject({ ok: false, error: 'a2a_query_failed' });
  });

  it('allows once every tracked task is canonically completed', async () => {
    track('task-1');
    track('task-2');
    taskQuery = () => ({
      tasks: [
        { id: 'task-1', status: { state: 'completed' } },
        { id: 'task-2', status: { state: 'completed' } },
        { id: 'task-other', status: { state: 'working' } }, // not ours — ignored
      ],
    });
    expect(await complete()).toMatchObject({ ok: true });
    expect(loadActiveDeckWork(WS, workDirRef.current)).toBeNull();
  });

  it('leaves the work OPEN on every refusal path', async () => {
    track('task-1');
    taskQuery = () => ({ tasks: [{ id: 'task-1', status: { state: 'working' } }] });
    await complete();
    expect(loadActiveDeckWork(WS, workDirRef.current)).not.toBeNull();
  });
});

describe('deck.completeWork — compare-and-delete', () => {
  it('refuses to close a NEWER request that arrived while the check was in flight', async () => {
    beginOrContinueDeckWork(WS, 'first request', workDirRef.current, 1_000);
    recordDeckWorkA2aTask(
      WS,
      { taskId: 'task-1', to: 'ws-worker', state: 'submitted', ts: 2_000 },
      workDirRef.current,
    );
    const firstId = loadActiveDeckWork(WS, workDirRef.current)!.id;

    // Simulate the race precisely: during the async canonical query, the human
    // clears and starts a brand-new request.
    taskQuery = () => {
      clearActiveDeckWork(WS, workDirRef.current);
      beginOrContinueDeckWork(WS, 'second request', workDirRef.current, 9_000);
      return { tasks: [{ id: 'task-1', status: { state: 'completed' } }] };
    };

    expect(await complete()).toMatchObject({ ok: false, error: 'active_work_changed' });
    const surviving = loadActiveDeckWork(WS, workDirRef.current)!;
    expect(surviving.objective).toBe('second request');
    expect(surviving.id).not.toBe(firstId);
  });
});
