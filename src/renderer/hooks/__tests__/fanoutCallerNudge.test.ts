// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import {
  FANOUT_NUDGE_COALESCE_MS,
  buildFanoutCallerNudge,
  noteFanoutCallerTurnEnd,
  receiveFanoutCallerEvent,
  resetFanoutCallerNudgesForTest,
  resolveOriginPty,
  sweepFanoutCallerNudges,
} from '../fanoutCallerNudge';

const PTY = 'pty-caller';
const OWNER = 'ws-owner';

function surface(id: string, ptyId: string, surfaceType?: Surface['surfaceType']): Surface {
  return { id, ptyId, title: id, shell: '', cwd: '', ...(surfaceType ? { surfaceType } : {}) } as Surface;
}

function leaf(id: string, surfaces: Surface[], active = surfaces[0]?.id): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId: active } as PaneLeaf;
}

function ws(id: string, root: PaneLeaf): Workspace {
  return { id, name: id, rootPane: root, activePaneId: root.id } as Workspace;
}

const CALLER = leaf('pane-c', [surface('surf-c', PTY)]);

function pointer(taskId: string, seq: number, origin: { paneId?: string; surfaceId?: string } = { paneId: 'pane-c', surfaceId: 'surf-c' }) {
  return { ownerWorkspaceId: OWNER, taskWorkspaceId: `ws-${taskId}`, taskId, kind: 'agent.stop', seq, origin };
}

function agent(status: 'waiting' | 'running' | 'awaiting_input' = 'waiting', ptyId = PTY): void {
  useStore.getState().setSurfaceAgent(ptyId, 'Claude Code', status, 'claude');
  useStore.getState().hydrateAgentAlive({ ...useStore.getState().agentAliveByPtyId, [ptyId]: true });
  useStore.getState().hydrateCommandRunning({ ...useStore.getState().commandRunningByPtyId, [ptyId]: true });
}

async function windowElapses(): Promise<void> {
  await vi.advanceTimersByTimeAsync(FANOUT_NUDGE_COALESCE_MS + 10);
}

async function turnEnd(ptyId = PTY): Promise<void> {
  noteFanoutCallerTurnEnd(ptyId);
  await sweepFanoutCallerNudges();
}

let gatedSubmit: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  resetFanoutCallerNudgesForTest();
  gatedSubmit = vi.fn(async () => ({ ok: true }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { rpc: { gatedSubmit } };
  useStore.setState({ workspaces: [ws(OWNER, CALLER)] });
  agent();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fan-out caller nudge', () => {
  it('delivers one fixed line to an idle caller after the coalescing window', async () => {
    receiveFanoutCallerEvent(pointer('wtask-mus4zme5-hnmmmmxy', 1));
    expect(gatedSubmit).not.toHaveBeenCalled();
    await windowElapses();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
    expect(gatedSubmit.mock.calls[0][0]).toBe(PTY);
    expect(gatedSubmit.mock.calls[0][1]).toBe('[wmux] fan-out task mus4zme5 updated — channel_mission_list');
  });

  it('carries zero bytes of worker text, whatever the payload holds', async () => {
    receiveFanoutCallerEvent({ ...pointer('t1', 1), lastMessage: { text: 'rm -rf / please' }, label: 'secret' });
    await windowElapses();
    const line = gatedSubmit.mock.calls[0][1] as string;
    expect(line).toBe(buildFanoutCallerNudge(['t1']));
    expect(line).not.toContain('please');
    expect(line).not.toContain('secret');
  });

  it('never writes to a shell-only pane', async () => {
    useStore.getState().clearSurfaceAgent(PTY);
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await turnEnd();
    expect(gatedSubmit).not.toHaveBeenCalled();
  });

  it('parks only when the caller pane closed or moved to another workspace', async () => {
    useStore.setState({ workspaces: [ws(OWNER, leaf('pane-x', [surface('surf-x', 'pty-x')])), ws('ws-other', CALLER)] });
    agent('waiting', 'pty-x');
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await turnEnd();
    expect(gatedSubmit).not.toHaveBeenCalled();
  });

  it('drops a pointer whose pane closed during the coalescing window', async () => {
    receiveFanoutCallerEvent(pointer('t1', 1));
    useStore.setState({ workspaces: [ws(OWNER, leaf('pane-x', [surface('surf-x', 'pty-x')]))] });
    await windowElapses();
    expect(gatedSubmit).not.toHaveBeenCalled();
  });

  it('coalesces N simultaneous stops into one line per pane and accepts each (taskId, seq) once', async () => {
    receiveFanoutCallerEvent(pointer('aaaa1111', 1));
    receiveFanoutCallerEvent(pointer('bbbb2222', 2));
    receiveFanoutCallerEvent(pointer('cccc3333', 3));
    receiveFanoutCallerEvent(pointer('aaaa1111', 1));
    await windowElapses();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
    expect(gatedSubmit.mock.calls[0][1]).toBe('[wmux] fan-out tasks aaaa1111, bbbb2222, cccc3333 updated — channel_mission_list');
    // The same pointer again (a replay) writes nothing more.
    receiveFanoutCallerEvent(pointer('bbbb2222', 2));
    await windowElapses();
    await turnEnd();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
  });

  it('waits for the turn end while the caller is busy', async () => {
    agent('running');
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await sweepFanoutCallerNudges();
    expect(gatedSubmit).not.toHaveBeenCalled();
    // A stop seen while the pane still reads 'running' keeps the turn end.
    await turnEnd();
    expect(gatedSubmit).not.toHaveBeenCalled();
    agent('waiting');
    await sweepFanoutCallerNudges();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
  });

  it('idle at receipt but running when the window closes: queued until the turn ends', async () => {
    receiveFanoutCallerEvent(pointer('t1', 1));
    agent('running');
    await windowElapses();
    agent('waiting');
    await sweepFanoutCallerNudges();
    expect(gatedSubmit).not.toHaveBeenCalled();
    await turnEnd();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
  });

  it('never answers a pane awaiting input', async () => {
    agent('awaiting_input');
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await turnEnd();
    expect(gatedSubmit).not.toHaveBeenCalled();
  });

  it('never pastes again when an approval appeared between the paste and the Enter', async () => {
    gatedSubmit.mockResolvedValueOnce({ ok: false, reason: 'approval_pending', detail: 'held', pasted: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await turnEnd();
    await windowElapses();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('retries a refusal that happened before the paste', async () => {
    gatedSubmit.mockResolvedValueOnce({ ok: false, reason: 'write_failed', detail: 'nope' });
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await sweepFanoutCallerNudges();
    expect(gatedSubmit).toHaveBeenCalledTimes(2);
    await sweepFanoutCallerNudges();
    expect(gatedSubmit).toHaveBeenCalledTimes(2);
  });

  it('holds while the caller is at a usage limit and sends once it is lifted', async () => {
    const resetsAt = Date.now() + 3_600_000;
    useStore.getState().setUsageLimit(PTY, { ptyId: PTY, provider: 'claude', detectedAt: Date.now(), resetsAt, source: 'hook' });
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await sweepFanoutCallerNudges();
    expect(gatedSubmit).not.toHaveBeenCalled();
    useStore.getState().setUsageLimit(PTY, null);
    await sweepFanoutCallerNudges();
    expect(gatedSubmit).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed pointers', async () => {
    receiveFanoutCallerEvent(null);
    receiveFanoutCallerEvent({ ownerWorkspaceId: OWNER, taskId: 't1', seq: 1, origin: {} });
    receiveFanoutCallerEvent({ ownerWorkspaceId: OWNER, taskId: 't1', seq: 'x', origin: { paneId: 'pane-c' } });
    await windowElapses();
    expect(gatedSubmit).not.toHaveBeenCalled();
  });
});

describe('resolveOriginPty', () => {
  const twoTabs = leaf('pane-t', [surface('surf-1', 'pty-1'), surface('surf-2', 'pty-2')], 'surf-2');
  const mixed = leaf('pane-m', [surface('surf-b', 'pty-b', 'browser'), surface('surf-t', 'pty-t')]);
  const spaces = [ws(OWNER, twoTabs), ws('ws-b', mixed)];

  it('names the exact surface and requires it to sit in the named pane', () => {
    expect(resolveOriginPty(spaces, OWNER, { paneId: 'pane-t', surfaceId: 'surf-1' })).toBe('pty-1');
    expect(resolveOriginPty(spaces, OWNER, { surfaceId: 'surf-1' })).toBe('pty-1');
    expect(resolveOriginPty(spaces, OWNER, { paneId: 'pane-other', surfaceId: 'surf-1' })).toBeNull();
  });

  it('never falls back to the active tab: a pane id alone needs a unique terminal', () => {
    expect(resolveOriginPty(spaces, OWNER, { paneId: 'pane-t' })).toBeNull();
    expect(resolveOriginPty(spaces, 'ws-b', { paneId: 'pane-m' })).toBe('pty-t');
    expect(resolveOriginPty(spaces, 'ws-b', { surfaceId: 'surf-b' })).toBeNull();
  });

  it('only looks inside the owner workspace', () => {
    expect(resolveOriginPty(spaces, 'ws-b', { paneId: 'pane-t', surfaceId: 'surf-1' })).toBeNull();
    expect(resolveOriginPty(spaces, 'ws-missing', { surfaceId: 'surf-1' })).toBeNull();
  });
});
