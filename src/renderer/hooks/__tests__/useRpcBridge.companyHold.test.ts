// @vitest-environment jsdom
// @wmux-lane unit
//
// Company mode: a task held on its blockers. Main's CompanyReleaseBridge asks
// the renderer to write a released task to its seat (creating the store entry
// after an app restart, answering `duplicate` for one already written) and to
// tell the CEO pane about a held task; main's send path drops a task whose
// hold the daemon did not keep. The CEO lines are new nudge kinds; the
// existing kinds stay byte for byte.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneBranch, PaneLeaf, Surface, Task, Workspace } from '../../../shared/types';
import { COMPANY_HOLD_KEY, COMPANY_HOLD_REASON_TEXT, companyBlockerEndedLine, companyHoldWithholds, type CompanyHoldMarker } from '../../../shared/companyHold';
import { useStore } from '../../stores';
import { buildA2aNudge, handleRpcMethod } from '../useRpcBridge';

const { publishA2aTaskMock } = vi.hoisted(() => ({ publishA2aTaskMock: vi.fn() }));
vi.mock('../../events/publisher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/publisher')>()),
  publishA2aTask: publishA2aTaskMock,
}));
const createdEvents = (taskId: string) => publishA2aTaskMock.mock.calls.filter((c) => c[2] === taskId && c[4] === 'created');

const WS = 'ws-co';
const CEO_PTY = 'pty-ceo';
const DEV_PTY = 'pty-dev';

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

function company(opts: { coordinator?: string | null; withDev?: boolean } = {}): Workspace {
  const children = [leaf('pane-ceo', CEO_PTY), ...(opts.withDev === false ? [] : [leaf('pane-dev', DEV_PTY)])];
  return {
    id: WS,
    name: 'Co',
    rootPane: { id: 'branch', type: 'branch', direction: 'horizontal', children } as PaneBranch,
    activePaneId: 'pane-ceo',
    company: { v: 1, id: 'co-1', coordinatorPaneId: opts.coordinator === undefined ? 'pane-ceo' : opts.coordinator },
  } as Workspace;
}

const BRIEF = { kind: 'wmux.company.brief', v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r', blockedBy: ['task-a'] };

function heldTask(id: string, marker: Partial<CompanyHoldMarker> = {}, brief: unknown = BRIEF): Task {
  return {
    kind: 'task',
    id,
    status: { state: 'submitted', timestamp: '2026-11-01T00:00:00.000Z' },
    history: [{ kind: 'message', messageId: `m-${id}`, role: 'user', parts: [{ kind: 'text', text: 'build the thing' }, ...(brief ? [{ kind: 'data' as const, data: brief as Record<string, unknown> }] : [])] }],
    artifacts: [],
    metadata: {
      title: 'Build it',
      from: { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' },
      to: { workspaceId: WS, name: 'Co', paneId: 'pane-dev' },
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      [COMPANY_HOLD_KEY]: { blockedBy: ['task-a'], waitingOn: [], releasedAt: 'r', attempted: true, ...marker },
    },
  };
}

type Result = { ok?: boolean; delivered?: boolean; held?: string; reason?: string; duplicate?: boolean; error?: string; ptyId?: string; note?: string };
const deliver = async (task: Task, extra: Record<string, unknown> = {}): Promise<Result> =>
  (await handleRpcMethod('a2a.company.deliver', { task, deliveryDeadlineAt: Date.now() + 60_000, ...extra })) as Result;
const ceoLine = async (params: Record<string, unknown>): Promise<Result> =>
  (await handleRpcMethod('a2a.company.ceoLine', params)) as Result;

let gate: ReturnType<typeof vi.fn>;
let refusal: Record<string, unknown> | null;
let written: Array<{ pty: string; text: string }>;

beforeEach(() => {
  publishA2aTaskMock.mockReset();
  refusal = null;
  written = [];
  gate = vi.fn(async (ptyId: string, text: string) => {
    if (refusal) return refusal;
    written.push({ pty: ptyId, text });
    return { ok: true };
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { write: vi.fn() }, rpc: { gatedSubmit: gate } };
  const s = useStore.getState();
  for (const p of [CEO_PTY, DEV_PTY]) s.setSurfaceAgent(p, 'Claude Code', 'waiting', 'claude');
  s.hydrateAgentAlive({});
  s.hydrateCommandRunning({});
  useStore.setState({ workspaces: [company()], a2aTasks: {}, paneGate: 'ready' });
});

afterEach(() => {
  for (const p of [CEO_PTY, DEV_PTY]) useStore.getState().clearSurfaceAgent(p);
});

describe('buildA2aNudge — the existing kinds stay byte for byte', () => {
  const ID = 'task-1234abcd5678';
  it('new, reply, completed, failed and reported', () => {
    expect(buildA2aNudge(ID, 'Co', 'new', 'Fix it')).toBe('[wmux] new A2A task 1234abcd from Co — title: "Fix it" — a2a_task_query task_id:task-1234abcd5678');
    expect(buildA2aNudge(ID, 'Co', 'new')).toBe('[wmux] new A2A task 1234abcd from Co — a2a_task_query task_id:task-1234abcd5678');
    expect(buildA2aNudge(ID, 'Co', 'reply')).toBe('[wmux] reply on A2A task 1234abcd from Co — a2a_task_query task_id:task-1234abcd5678');
    expect(buildA2aNudge(ID, 'Co', 'completed')).toBe('[wmux] A2A task completed: 1234abcd from Co — a2a_task_query task_id:task-1234abcd5678');
    expect(buildA2aNudge(ID, 'Co', 'failed')).toBe('[wmux] A2A task failed: 1234abcd from Co — a2a_task_query task_id:task-1234abcd5678');
    expect(buildA2aNudge(ID, 'pc-b', 'reported')).toBe(
      '[wmux] pc-b reported A2A task 1234abcd done on its PC: check the report, then mark it done (a2a_task_update completed) — a2a_task_query task_id:task-1234abcd5678',
    );
  });

  it('the CEO lines name the held task and its blocker in full, on one line', () => {
    const ended = buildA2aNudge('task-c', '', 'blocker-ended', undefined, { blocker: { id: 'task-a', state: 'failed' } });
    expect(ended).toBe(`[wmux] ${companyBlockerEndedLine('task-c', { id: 'task-a', state: 'failed' })} — a2a_task_query task_id:task-c`);
    const held = buildA2aNudge('task-c', '', 'held', undefined, { held: 'no-agent' });
    expect(held).toBe(`[wmux] A2A task task-c is held: ${COMPANY_HOLD_REASON_TEXT['no-agent']} — a2a_task_query task_id:task-c`);
    // A blocker id is typed into the CEO's prompt: only id characters survive.
    expect(buildA2aNudge('task-c', '', 'blocker-ended', undefined, { blocker: { id: 'task-a;rm -rf\n', state: 'canceled' } })).not.toMatch(/[;\n ]rm/);
    for (const line of [ended, held]) expect(line).not.toMatch(/[\r\n]/);
  });
});

describe('a2a.company.deliver — a released task goes to its seat once', () => {
  it('creates the store entry when absent and writes the one-line nudge to the pinned seat, gated', async () => {
    const r = await deliver(heldTask('task-c1'));
    expect(r).toEqual({ ok: true, delivered: true, ptyId: DEV_PTY });
    expect(written).toEqual([{ pty: DEV_PTY, text: expect.stringContaining('a2a_task_query task_id:task-c1') }]);
    expect(gate).toHaveBeenCalledWith(DEV_PTY, expect.any(String), 'Claude Code', expect.objectContaining({ newTask: true, taskId: 'task-c1', waitQuiet: true, expectAgent: 'Claude Code' }));
    const stored = useStore.getState().getTask('task-c1')!;
    expect(stored.metadata.to).toMatchObject({ workspaceId: WS, paneId: 'pane-dev' });
    expect(stored.history[0].parts).toHaveLength(2);
    // Announced once it is the seat's: written to its pane.
    expect(createdEvents('task-c1')).toHaveLength(1);
  });

  it('announces the task only when a write lands, and only once', async () => {
    refusal = { ok: false, reason: 'user_typing', detail: 'typing' };
    await deliver(heldTask('task-c9'));
    expect(createdEvents('task-c9')).toHaveLength(0);
    refusal = null;
    await deliver(heldTask('task-c9'));
    await deliver(heldTask('task-c9'));
    expect(createdEvents('task-c9')).toHaveLength(1);
  });

  it('answers duplicate for a task it already wrote, or one the daemon shows delivered', async () => {
    await deliver(heldTask('task-c2'));
    expect(await deliver(heldTask('task-c2'))).toEqual({ ok: true, delivered: true, duplicate: true });
    expect(await deliver(heldTask('task-c3', { delivered: true }))).toEqual({ ok: true, delivered: true, duplicate: true });
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('keeps an existing store entry as it is', async () => {
    useStore.getState().createA2aTask({ id: 'task-c4', title: 'Mine', from: { workspaceId: WS, name: 'Co' }, to: { workspaceId: WS, name: 'Co', paneId: 'pane-dev' }, history: heldTask('task-c4').history, artifacts: [] });
    await deliver(heldTask('task-c4'));
    expect(useStore.getState().getTask('task-c4')!.metadata.title).toBe('Mine');
  });

  it('holds it when the seat pane is gone, storing nothing and never re-routing', async () => {
    useStore.setState({ workspaces: [company({ withDev: false })] });
    expect(await deliver(heldTask('task-c5'))).toEqual({ ok: true, delivered: false, held: 'pane-missing' });
    expect(gate).not.toHaveBeenCalled();
    expect(useStore.getState().getTask('task-c5')).toBeUndefined();
  });

  it('says no agent when the seat pane has none, and what the gate refused', async () => {
    useStore.getState().clearSurfaceAgent(DEV_PTY);
    expect(await deliver(heldTask('task-c6'))).toEqual({ ok: true, delivered: false, reason: 'no_agent_pane' });
    useStore.getState().setSurfaceAgent(DEV_PTY, 'Claude Code', 'waiting', 'claude');
    refusal = { ok: false, reason: 'user_typing', detail: 'typing' };
    expect(await deliver(heldTask('task-c6'))).toEqual({ ok: true, delivered: false, reason: 'user_typing' });
    refusal = null;
    expect(await deliver(heldTask('task-c6'))).toEqual({ ok: true, delivered: true, ptyId: DEV_PTY });
  });

  it('counts a paste left in the composer as delivered', async () => {
    refusal = { ok: false, reason: 'approval_pending', detail: 'x', pasted: true, cleared: false };
    expect(await deliver(heldTask('task-c7'))).toEqual({ ok: true, delivered: true, ptyId: DEV_PTY, note: 'pasted-not-submitted' });
    refusal = null;
    expect(await deliver(heldTask('task-c7'))).toEqual({ ok: true, delivered: true, duplicate: true });
  });

  it('refuses a task that carries no brief', async () => {
    expect((await deliver(heldTask('task-c8', {}, null))).error).toBeDefined();
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('a2a.company.ceoLine — one line to the company\'s CEO pane', () => {
  it('writes the line to the coordinator pane', async () => {
    const r = await ceoLine({ task: heldTask('task-d1', { held: 'no-agent' }), kind: 'held', held: 'no-agent' });
    expect(r).toEqual({ ok: true, delivered: true, ptyId: CEO_PTY });
    expect(written).toEqual([{ pty: CEO_PTY, text: `[wmux] A2A task task-d1 is held: ${COMPANY_HOLD_REASON_TEXT['no-agent']} — a2a_task_query task_id:task-d1` }]);
    // A plain write: no new-task delivery, so no fresh context for the CEO.
    expect(gate.mock.calls[0]).toHaveLength(3);
  });

  it('falls back to the pane that sent the task when the company has no coordinator', async () => {
    useStore.setState({ workspaces: [company({ coordinator: null })] });
    const r = await ceoLine({ task: heldTask('task-d2'), kind: 'blocker-ended', blocker: { id: 'task-a', state: 'canceled' } });
    expect(r).toMatchObject({ delivered: true, ptyId: CEO_PTY });
    expect(written[0].text).toContain('its blocker task-a was canceled');
  });

  it('writes nothing to a CEO pane with no agent', async () => {
    useStore.getState().clearSurfaceAgent(CEO_PTY);
    expect(await ceoLine({ task: heldTask('task-d3'), kind: 'held', held: 'pane-missing' })).toEqual({ ok: true, delivered: false, reason: 'no_agent_pane' });
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('a2a.company.discard — a hold the daemon did not keep', () => {
  it('drops the company task, and refuses any other', async () => {
    useStore.getState().createA2aTask({ id: 'task-e1', title: 'x', from: { workspaceId: WS, name: 'Co' }, to: { workspaceId: WS, name: 'Co' }, history: heldTask('task-e1').history, artifacts: [] });
    useStore.getState().createA2aTask({ id: 'task-e2', title: 'x', from: { workspaceId: WS, name: 'Co' }, to: { workspaceId: WS, name: 'Co' }, history: heldTask('task-e2', {}, null).history, artifacts: [] });
    expect(await handleRpcMethod('a2a.company.discard', { taskId: 'task-e1' })).toEqual({ ok: true });
    expect(useStore.getState().getTask('task-e1')).toBeUndefined();
    expect(await handleRpcMethod('a2a.company.discard', { taskId: 'task-e2' })).toMatchObject({ ok: false });
    expect(useStore.getState().getTask('task-e2')).toBeDefined();
  });
});

describe('a2a.task.send — a send held for its blockers is not announced', () => {
  const send = (extra: Record<string, unknown>) => handleRpcMethod('a2a.task.send', {
    workspaceId: WS,
    to: WS,
    paneId: 'pane-dev',
    senderPtyId: CEO_PTY,
    message: 'build it',
    title: 'Build it',
    data: BRIEF,
    ...extra,
  }) as Promise<{ ok?: boolean; taskId?: string }>;

  it('stores it silently with no created event when main marks it held', async () => {
    const r = await send({ silent: true, heldForBlockers: true });
    expect(r.ok).toBe(true);
    expect(useStore.getState().getTask(r.taskId!)).toBeDefined();
    expect(gate).not.toHaveBeenCalled();
    expect(createdEvents(r.taskId!)).toHaveLength(0);
  });

  it('a plain silent send is announced as before, and the flag alone changes nothing', async () => {
    const silent = await send({ silent: true });
    expect(createdEvents(silent.taskId!)).toHaveLength(1);
    const flagOnly = await send({ heldForBlockers: true });
    expect(createdEvents(flagOnly.taskId!)).toHaveLength(1);
    expect(gate).toHaveBeenCalledTimes(1);
  });
});

describe('a held send\'s renderer copy, before and after its release delivery', () => {
  const heldSend = async (): Promise<string> => {
    const r = (await handleRpcMethod('a2a.task.send', {
      workspaceId: WS, to: WS, paneId: 'pane-dev', senderPtyId: CEO_PTY, message: 'build it', title: 'Build it', data: BRIEF,
      silent: true, heldForBlockers: true,
    })) as { taskId: string };
    return r.taskId;
  };
  const copy = (id: string): Task => useStore.getState().getTask(id)!;
  const receiver = { workspaceId: WS, paneId: 'pane-dev' };
  const reply = (taskId: string, extra: Record<string, unknown> = {}) =>
    handleRpcMethod('a2a.task.send', { workspaceId: WS, taskId, message: 'one more thing', senderPtyId: CEO_PTY, ...extra }) as Promise<{ ok?: boolean; delivery?: Record<string, unknown> }>;
  /** What the daemon holds for it once released: the bridge marked the attempt. */
  const releasedSnapshot = (id: string): Task => ({
    ...copy(id),
    metadata: { ...copy(id).metadata, [COMPANY_HOLD_KEY]: { blockedBy: ['task-a'], waitingOn: [], releasedAt: 'r', attempted: true } },
  });

  it('carries a provisional marker that keeps it from its receiver, until the release delivery writes it', async () => {
    const id = await heldSend();
    expect(copy(id).metadata[COMPANY_HOLD_KEY]).toEqual({ blockedBy: ['task-a'], waitingOn: ['task-a'] });
    // The daemon-away fallback hides it from the receiving side, not from its sender.
    expect(companyHoldWithholds(copy(id), receiver)).toBe(true);
    expect(companyHoldWithholds(copy(id), { workspaceId: WS, paneId: 'pane-ceo' })).toBe(false);
    expect(await deliver(releasedSnapshot(id))).toEqual({ ok: true, delivered: true, ptyId: DEV_PTY });
    expect(copy(id).metadata[COMPANY_HOLD_KEY]).toEqual({ blockedBy: ['task-a'], waitingOn: [], releasedAt: 'r', delivered: true, ptyId: DEV_PTY });
    expect(companyHoldWithholds(copy(id), receiver)).toBe(false);
    // The copy now says it was delivered: a repeat is a duplicate.
    expect(await deliver(releasedSnapshot(id))).toEqual({ ok: true, delivered: true, duplicate: true });
  });

  it('a message on it is kept on the task with no write and no event, then goes as usual once delivered', async () => {
    const id = await heldSend();
    const held = await reply(id);
    expect(held.delivery).toMatchObject({ stored: true, notified: false, reason: 'blocked' });
    expect(gate).not.toHaveBeenCalled();
    expect(copy(id).history).toHaveLength(2);
    expect(publishA2aTaskMock.mock.calls.filter((c) => c[2] === id)).toEqual([]);
    await deliver(releasedSnapshot(id));
    const after = await reply(id);
    expect(after.delivery).toMatchObject({ notified: true });
    expect(written.map((w) => w.pty)).toEqual([DEV_PTY, DEV_PTY]);
  });

  it('main\'s word that the task is its seat\'s writes the message even when this copy still waits', async () => {
    const id = await heldSend();
    expect((await reply(id, { heldForBlockers: false })).delivery).toMatchObject({ notified: true });
    expect(written.map((w) => w.pty)).toEqual([DEV_PTY]);
  });

  it('main\'s held flag on a reply keeps the message off the pane even when this copy has no marker', async () => {
    useStore.getState().createA2aTask({
      id: 'task-f1', title: 'x', from: { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' }, to: { workspaceId: WS, name: 'Co', paneId: 'pane-dev' },
      history: heldTask('task-f1').history, artifacts: [],
    });
    expect((await reply('task-f1', { silent: true, heldForBlockers: true })).delivery).toMatchObject({ reason: 'blocked' });
    expect(gate).not.toHaveBeenCalled();
    expect(publishA2aTaskMock.mock.calls.filter((c) => c[2] === 'task-f1')).toEqual([]);
  });
});
