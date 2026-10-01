// @vitest-environment jsdom
//
// #1680 — only the NEW-task branch of a2a.task.send asks main for the pane's
// fresh-context step; a reply, a status update, a broadcast and the operator's
// own delivery never do. A pane with other open tasks pinned to it keeps its
// conversation (owner decision: skipped_busy, reason open_a2a_task).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';
import { paneAddressOfPty, paneHasOtherOpenA2aTask } from '../a2aFreshContext';

const PTY = 'pty-fresh-target';
const BODY = 'implement the parser';

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

function workspace(id: string, name: string, ptyId: string): Workspace {
  return { id, name, rootPane: leaf(`pane-${id}`, ptyId), activePaneId: `pane-${id}` } as Workspace;
}

const SENDER = workspace('ws-fresh-sender', 'Sender', 'pty-fresh-sender');
const TARGET = workspace('ws-fresh-target', 'Target', PTY);

let gate: ReturnType<typeof vi.fn>;
let gateAnswer: Record<string, unknown>;

type Result = { ok?: boolean; taskId?: string; delivery?: Record<string, unknown> };

const send = async (params: Record<string, unknown>): Promise<Result> =>
  (await handleRpcMethod('a2a.task.send', { workspaceId: SENDER.id, to: TARGET.id, message: BODY, ...params })) as Result;

/** What a new-task delivery asks main for: the step, the task, and where the
 *  pane sits (main checks the daemon's open tasks for it). */
const NEW_TASK = {
  newTask: true,
  taskId: expect.stringMatching(/^task-/),
  pane: { workspaceId: TARGET.id, paneId: `pane-${TARGET.id}`, surfaceId: `surf-pane-${TARGET.id}` },
};

/** The options main was asked for on each gated submit to the target. */
const gateOptions = (): unknown[] => gate.mock.calls.filter(([pty]) => pty === PTY).map((c) => c[3]);

beforeEach(() => {
  vi.useFakeTimers();
  gateAnswer = { ok: true };
  gate = vi.fn(async () => gateAnswer);
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { write: vi.fn() }, rpc: { gatedSubmit: gate } };
  const s = useStore.getState();
  s.setSurfaceAgent(PTY, 'Claude Code', 'waiting', 'claude');
  s.hydrateAgentAlive({});
  s.hydrateCommandRunning({});
  useStore.setState({ workspaces: [SENDER, TARGET], paneGate: 'ready', a2aTasks: {} });
});

afterEach(() => {
  useStore.getState().clearSurfaceAgent(PTY);
  vi.useRealTimers();
});

describe('a2a fresh context (#1680)', () => {
  it('a new task asks main for the fresh-context step and reports what it did', async () => {
    gateAnswer = { ok: true, freshContext: 'applied', freshContextCommand: '/clear', freshContextSignal: 'session_start' };
    const result = await send({ silent: false });
    expect(gateOptions()).toEqual([NEW_TASK]);
    expect(result.delivery).toMatchObject({
      notified: true,
      freshContext: 'applied',
      freshContextCommand: '/clear',
      freshContextSignal: 'session_start',
    });
  });

  it('the one-line nudge to a live agent is a new task too', async () => {
    useStore.getState().hydrateAgentAlive({ [PTY]: true });
    await send({});
    expect(gateOptions()).toEqual([NEW_TASK]);
  });

  it('a role that never asked adds nothing to the receipt (not_bound)', async () => {
    gateAnswer = { ok: true, freshContext: 'not_bound', freshContextReason: 'role_not_opted_in: …' };
    const result = await send({ silent: false });
    expect(result.delivery).not.toHaveProperty('freshContext');
  });

  it('a command that never finished: not delivered, stored, with its own hint', async () => {
    gateAnswer = { ok: false, reason: 'fresh_context_timeout', detail: 'delivery: typed /clear and saw no SessionStart hook' };
    const result = await send({ silent: false });
    expect(result.ok).toBe(true);
    expect(result.delivery).toMatchObject({ stored: true, notified: false, reason: 'fresh_context_timeout' });
    expect(String(result.delivery?.hint)).toMatch(/NOT pasted/);
    expect(useStore.getState().getTask(result.taskId!)).toBeDefined();
  });

  it('a reply, a status update and a broadcast never ask for it', async () => {
    const created = await send({ paneId: `pane-${TARGET.id}`, silent: true });
    gate.mockClear();
    await send({ taskId: created.taskId, silent: false });
    await handleRpcMethod('a2a.task.update', { taskId: created.taskId, workspaceId: SENDER.id, message: 'progress' });
    await handleRpcMethod('a2a.broadcast', { workspaceId: SENDER.id, message: 'all hands' });
    expect(gate.mock.calls.length).toBeGreaterThan(0);
    for (const call of gate.mock.calls) expect(call[3]).toBeUndefined();
  });

  it("the operator's own delivery is excluded", async () => {
    await send({ silent: false, operatorOrigin: true });
    expect(gate).not.toHaveBeenCalled();
  });

  it('a pane with another open task pinned to it keeps its conversation', async () => {
    // An earlier task, still open, addressed to the same pane.
    const earlier = await send({ paneId: `pane-${TARGET.id}`, silent: true });
    expect(earlier.taskId).toBeDefined();
    gate.mockClear();
    await send({ silent: false });
    expect(gateOptions()).toEqual([{ ...NEW_TASK, keepContext: 'open_a2a_task' }]);
  });

  it('an ended task does not hold the pane', async () => {
    const earlier = await send({ paneId: `pane-${TARGET.id}`, silent: true });
    useStore.setState((s) => ({
      a2aTasks: {
        ...s.a2aTasks,
        [earlier.taskId!]: {
          ...s.a2aTasks[earlier.taskId!]!,
          status: { state: 'completed', timestamp: new Date().toISOString() },
        },
      },
    }));
    gate.mockClear();
    await send({ silent: false });
    expect(gateOptions()).toEqual([NEW_TASK]);
  });
});

describe('paneAddressOfPty', () => {
  it('places a pty in its workspace, pane and surface', () => {
    expect(paneAddressOfPty([SENDER, TARGET], PTY)).toEqual({
      workspaceId: TARGET.id,
      paneId: `pane-${TARGET.id}`,
      surfaceId: `surf-pane-${TARGET.id}`,
    });
    expect(paneAddressOfPty([SENDER, TARGET], 'pty-nowhere')).toBeUndefined();
  });
});

describe('paneHasOtherOpenA2aTask', () => {
  const task = (id: string, state: string, to: Record<string, unknown>, from: Record<string, unknown> = { workspaceId: SENDER.id, name: 'Sender' }) =>
    ({
      kind: 'task',
      id,
      status: { state, timestamp: '' },
      history: [],
      artifacts: [],
      metadata: { title: id, to: { name: 'T', ...to }, from, createdAt: '', updatedAt: '' },
    }) as never;

  it('counts the receiver side and the sender side, never the task being delivered', () => {
    const pinnedTo = task('a', 'working', { workspaceId: TARGET.id, paneId: `pane-${TARGET.id}` });
    const pinnedFrom = task('b', 'submitted', { workspaceId: SENDER.id }, { workspaceId: TARGET.id, name: 'Target', surfaceId: `surf-pane-${TARGET.id}` });
    const wsOnly = task('c', 'working', { workspaceId: TARGET.id });
    const ws = [SENDER, TARGET];
    expect(paneHasOtherOpenA2aTask([pinnedTo], ws, PTY, 'new')).toBe(true);
    expect(paneHasOtherOpenA2aTask([pinnedFrom], ws, PTY, 'new')).toBe(true);
    expect(paneHasOtherOpenA2aTask([wsOnly], ws, PTY, 'new')).toBe(false);
    expect(paneHasOtherOpenA2aTask([pinnedTo], ws, PTY, 'a')).toBe(false);
    expect(paneHasOtherOpenA2aTask([task('d', 'canceled', { workspaceId: TARGET.id, paneId: `pane-${TARGET.id}` })], ws, PTY, 'new')).toBe(false);
  });
});
