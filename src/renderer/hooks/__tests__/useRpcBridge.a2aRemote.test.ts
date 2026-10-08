// @vitest-environment jsdom
//
// Cross-host A2A: main's RemoteA2aBridge hands a task another host sent to the
// renderer with `remoteMarker` / `remoteFrom`. It must land on exactly the
// link's pane, through the gated delivery, and HOLD (never re-route) when that
// pane is gone or another pty holds it now.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneBranch, PaneLeaf, Surface, Task, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const RT = `rt-${'a'.repeat(32)}`;
const PINNED_PTY = 'pty-pinned';
const SIBLING_PTY = 'pty-sibling';
const BODY = 'please review the diff';

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

function target(pinnedPty = PINNED_PTY, withPinned = true): Workspace {
  const children = [leaf('pane-sibling', SIBLING_PTY), ...(withPinned ? [leaf('pane-pinned', pinnedPty)] : [])];
  return {
    id: 'ws-target',
    name: 'Target',
    rootPane: { id: 'branch', type: 'branch', direction: 'horizontal', children } as PaneBranch,
    activePaneId: 'pane-sibling',
  } as Workspace;
}

const MARKER = { v: 1, linkId: LINK, hostId: HOST, messageId: 'msg-1', direction: 'inbound', delivered: false };

function remoteParams(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: 'ws-target',
    to: 'ws-target',
    paneId: 'pane-pinned',
    message: BODY,
    title: 'review',
    presetTaskId: RT,
    remoteFrom: { workspaceId: `remote:${LINK}`, name: 'pc-a/ws-a/claude' },
    remoteMarker: MARKER,
    gatedDelivery: true,
    execute: false,
    ...o,
  };
}

type Result = { ok?: boolean; delivered?: boolean; held?: string; reason?: string; duplicate?: boolean; error?: string; taskId?: string; ptyId?: string; note?: string };

const send = async (o: Record<string, unknown> = {}): Promise<Result> =>
  (await handleRpcMethod('a2a.task.send', remoteParams(o))) as Result;

let gate: ReturnType<typeof vi.fn>;
let refusal: Record<string, unknown> | null;
let written: string[];
let onGate: (() => void) | null;

beforeEach(() => {
  vi.useFakeTimers();
  refusal = null;
  written = [];
  onGate = null;
  gate = vi.fn(async (ptyId: string) => {
    onGate?.();
    if (refusal) return refusal;
    written.push(ptyId);
    return { ok: true };
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { write: vi.fn() }, rpc: { gatedSubmit: gate } };
  const s = useStore.getState();
  // Both panes run a detected agent: a sibling fallback would have somewhere to go.
  for (const p of [PINNED_PTY, SIBLING_PTY, 'pty-new']) s.setSurfaceAgent(p, 'Claude Code', 'waiting', 'claude');
  s.hydrateAgentAlive({});
  s.hydrateCommandRunning({});
  useStore.setState({ workspaces: [target()], a2aTasks: {}, paneGate: 'ready' });
});

afterEach(() => {
  for (const p of [PINNED_PTY, SIBLING_PTY, 'pty-new']) useStore.getState().clearSurfaceAgent(p);
  vi.useRealTimers();
});

describe('remote task delivery', () => {
  it('lands on the pinned pane through the gated delivery and records the snapshot', async () => {
    const r = await send();
    expect(r).toEqual({ ok: true, delivered: true, ptyId: PINNED_PTY });
    expect(written).toEqual([PINNED_PTY]);
    // A live agent gets the one-line pointer naming the task, never a sibling pane.
    expect(gate).toHaveBeenCalledWith(PINNED_PTY, expect.stringContaining(RT), 'Claude Code', expect.objectContaining({ waitQuiet: true, newTask: true, taskId: RT, expectAgent: 'Claude Code' }));
    const task = useStore.getState().getTask(RT)!;
    expect(task.metadata.from).toEqual({ workspaceId: `remote:${LINK}`, name: 'pc-a/ws-a/claude' });
    expect(task.metadata.to).toMatchObject({ workspaceId: 'ws-target', paneId: 'pane-pinned', ptyId: PINNED_PTY });
    expect(task.metadata.remote).toMatchObject({ linkId: LINK, delivered: true });
    expect(task.history[0]).toMatchObject({ messageId: 'msg-1', role: 'user' });
  });

  it('a second trigger for a delivered task writes nothing', async () => {
    await send();
    expect(await send()).toEqual({ ok: true, delivered: true, duplicate: true });
    expect(written).toEqual([PINNED_PTY]);
  });

  it('a missing pane is held, stores nothing, and never falls back to the sibling agent', async () => {
    useStore.setState({ workspaces: [target(PINNED_PTY, false)] });
    expect(await send()).toEqual({ ok: true, delivered: false, held: 'pane-missing' });
    expect(gate).not.toHaveBeenCalled();
    expect(useStore.getState().getTask(RT)).toBeUndefined();
  });

  it('a retry after the pane got a new pty is held as occupant-changed', async () => {
    refusal = { ok: false, reason: 'approval_pending', detail: 'approval' };
    expect(await send()).toEqual({ ok: true, delivered: false, reason: 'approval_pending' });
    useStore.setState({ workspaces: [target('pty-new')] });
    refusal = null;
    expect(await send()).toEqual({ ok: true, delivered: false, held: 'occupant-changed' });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
  });

  it('an occupant change during the quiet wait is held as occupant-changed', async () => {
    refusal = { ok: false, reason: 'write_failed', detail: 'pty gone' };
    onGate = () => useStore.setState({ workspaces: [target('pty-new')] });
    expect(await send()).toEqual({ ok: true, delivered: false, held: 'occupant-changed' });
    expect(written).toEqual([]);
  });

  it('a retry after a transient refusal delivers to the snapshotted pty', async () => {
    refusal = { ok: false, reason: 'user_typing', detail: 'typing' };
    await send();
    refusal = null;
    expect(await send()).toEqual({ ok: true, delivered: true, ptyId: PINNED_PTY });
    expect(written).toEqual([PINNED_PTY]);
  });

  it('a paste left in the composer counts as delivered and is not pasted again', async () => {
    refusal = { ok: false, reason: 'approval_pending', detail: 'x', pasted: true, cleared: false };
    expect(await send()).toEqual({ ok: true, delivered: true, ptyId: PINNED_PTY, note: 'pasted-not-submitted' });
    refusal = null;
    expect(await send()).toEqual({ ok: true, delivered: true, duplicate: true });
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('a person-approved retry snapshots the new occupant and delivers to it', async () => {
    refusal = { ok: false, reason: 'approval_pending', detail: 'approval' };
    await send();
    useStore.setState({ workspaces: [target('pty-new')] });
    refusal = null;
    expect(await send()).toEqual({ ok: true, delivered: false, held: 'occupant-changed' });
    expect(await send({ resnapshot: true })).toEqual({ ok: true, delivered: true, ptyId: 'pty-new' });
    expect(written).toEqual(['pty-new']);
    expect(useStore.getState().getTask(RT)!.metadata.to.ptyId).toBe('pty-new');
  });

  it('refuses a sender that is not the link remote workspace, and an id without rt- shape', async () => {
    expect((await send({ remoteFrom: { workspaceId: 'ws-target', name: 'x' } })).error).toBeDefined();
    expect((await send({ remoteFrom: { workspaceId: 'remote:other', name: 'x' } })).error).toBeDefined();
    expect((await send({ presetTaskId: 'task-123' })).error).toBeDefined();
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('local sends keep their behaviour', () => {
  it('an rt- presetTaskId without a remote marker is not used as the task id', async () => {
    useStore.setState({
      workspaces: [target(), { id: 'ws-sender', name: 'Sender', rootPane: leaf('pane-s', 'pty-s'), activePaneId: 'pane-s' } as Workspace],
    });
    const r = (await handleRpcMethod('a2a.task.send', {
      workspaceId: 'ws-sender',
      to: 'ws-target',
      paneId: 'pane-pinned',
      message: BODY,
      presetTaskId: RT,
      operatorOrigin: true,
    })) as Result;
    expect(r.ok).toBe(true);
    expect(r.taskId).not.toBe(RT);
    expect(r.taskId).toMatch(/^task-/);
  });
});

// A reply / state the peer sent into a remote task (main's bridge, a2a.remote.notify).
describe('remote reply and state delivery', () => {
  /** Our outbound task: we are `from` (the pinned pane), the peer is `to`. */
  function outboundTask(o: { fromPty?: string; inbox?: unknown[]; state?: string } = {}): Task {
    return {
      kind: 'task',
      id: RT,
      status: { state: (o.state ?? 'working') as Task['status']['state'], timestamp: '2026-10-07T00:00:01.000Z' },
      history: [
        { kind: 'message', messageId: 'm0', role: 'user', parts: [{ kind: 'text', text: 'please' }] },
        { kind: 'message', messageId: 'r1', role: 'agent', parts: [{ kind: 'text', text: 'here is the answer' }] },
      ],
      artifacts: [],
      metadata: {
        title: 't',
        from: { workspaceId: 'ws-target', name: 'Target', paneId: 'pane-pinned', ptyId: o.fromPty ?? PINNED_PTY },
        to: { workspaceId: `remote:${LINK}`, name: 'pc-b/ws-b/codex' },
        createdAt: '2026-10-07T00:00:00.000Z',
        updatedAt: '2026-10-07T00:00:01.000Z',
        remote: { v: 1, linkId: LINK, hostId: HOST, messageId: 'm0', direction: 'outbound', inbox: o.inbox ?? [{ messageId: 'r1', kind: 'reply', delivered: false }] },
      },
    };
  }
  const notify = async (task: Task, messageId: string, extra: Record<string, unknown> = {}): Promise<Result> =>
    (await handleRpcMethod('a2a.remote.notify', { task, messageId, ...extra })) as Result;

  it('writes the reply to the sending pane, as a local reply would', async () => {
    useStore.getState().hydrateAgentAlive({});
    useStore.getState().setSurfaceAgent(PINNED_PTY, 'Claude Code', 'complete', 'claude');
    expect(await notify(outboundTask(), 'r1')).toEqual({ ok: true, delivered: true, ptyId: PINNED_PTY });
    expect(written).toEqual([PINNED_PTY]);
    // Not a live agent: the body itself, named as from the remote pane.
    expect(gate.mock.calls[0][0]).toBe(PINNED_PTY);
    expect(gate.mock.calls[0][1]).toContain('here is the answer');
    expect(gate.mock.calls[0][1]).toContain('From: pc-b/ws-b/codex');
  });

  it('filters peer text again right before the pane write (escapes, OSC 52, paste end, CR)', async () => {
    useStore.getState().hydrateAgentAlive({});
    useStore.getState().setSurfaceAgent(PINNED_PTY, 'Claude Code', 'complete', 'claude');
    const task = outboundTask();
    task.history[1] = { kind: 'message', messageId: 'r1', role: 'agent', parts: [{ kind: 'text', text: 'ans\x1b]52;c;eA==\x07wer\x1b[201~\rx' }] };
    task.metadata.to = { ...task.metadata.to, name: 'pc-b\x1b[31m/ws/codex' };
    expect(await notify(task, 'r1')).toMatchObject({ ok: true, delivered: true });
    const pasted = gate.mock.calls[0][1] as string;
    expect(pasted).toContain('From: pc-b/ws/codex');
    expect(pasted).toMatch(/answer.x/);
    expect(pasted).not.toMatch(/\x1b|\r|\x07/);
  });

  it('a live agent gets the one-line reply pointer', async () => {
    expect(await notify(outboundTask(), 'r1')).toMatchObject({ delivered: true });
    expect(gate.mock.calls[0][1]).toMatch(/reply on A2A task/);
  });

  it('holds when the sending pane is gone or holds another pty, never a sibling', async () => {
    useStore.setState({ workspaces: [target(PINNED_PTY, false)] });
    expect(await notify(outboundTask(), 'r1')).toEqual({ ok: true, delivered: false, held: 'pane-missing' });
    useStore.setState({ workspaces: [target('pty-new')] });
    expect(await notify(outboundTask(), 'r1')).toEqual({ ok: true, delivered: false, held: 'occupant-changed' });
    expect(gate).not.toHaveBeenCalled();
    expect(await notify(outboundTask(), 'r1', { resnapshot: true })).toEqual({ ok: true, delivered: true, ptyId: 'pty-new' });
    expect(written).toEqual(['pty-new']);
  });

  it('a state change writes nothing to the pane and tees the event pointer', async () => {
    const task = outboundTask({ state: 'completed', inbox: [{ messageId: 's1', kind: 'state', delivered: false }] });
    expect(await notify(task, 's1')).toEqual({ ok: true, delivered: true });
    expect(gate).not.toHaveBeenCalled();
    expect(useStore.getState().getTask(RT)!.status.state).toBe('completed');
  });

  it('refuses an item the task does not owe', async () => {
    expect((await notify(outboundTask(), 'nope')).error).toBeDefined();
    expect((await notify({ ...outboundTask(), id: 'task-1' }, 'r1')).error).toBeDefined();
  });
});
