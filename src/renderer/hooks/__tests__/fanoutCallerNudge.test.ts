// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { buildFanoutCallerNudge } from '../../../shared/fanoutCallerNudge';
import { useStore } from '../../stores';
import {
  FANOUT_NUDGE_COALESCE_MS,
  POINTER_TTL_MS,
  noteFanoutCallerLifecycle,
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

function pointer(
  taskId: string,
  seq: number,
  kind = 'agent.stop',
  origin: { paneId?: string; surfaceId?: string } = { paneId: 'pane-c', surfaceId: 'surf-c' },
) {
  return { ownerWorkspaceId: OWNER, taskWorkspaceId: `ws-${taskId}`, taskId, kind, seq, origin };
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

let session: ReturnType<typeof vi.fn>;
let submit: ReturnType<typeof vi.fn>;
const lines = (): string[] => submit.mock.calls.map((c) => (c[0] as { text: string }).text);

beforeEach(() => {
  vi.useFakeTimers();
  resetFanoutCallerNudgesForTest();
  session = vi.fn(async () => ({ incarnationId: 'inc-1' }));
  submit = vi.fn(async () => ({ result: 'sent', pasted: true }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    deck: { fanoutCallerSession: session, fanoutCallerSubmit: submit },
  };
  useStore.setState({ workspaces: [ws(OWNER, CALLER)] });
  agent();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fan-out caller nudge', () => {
  it('delivers one fixed line to an idle caller after the coalescing window, bound to its session', async () => {
    receiveFanoutCallerEvent(pointer('wtask-mus4zme5-hnmmmmxy', 1));
    expect(submit).not.toHaveBeenCalled();
    await windowElapses();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toEqual({
      ptyId: PTY,
      ownerWorkspaceId: OWNER,
      incarnationId: 'inc-1',
      text: '[wmux] fan-out task hnmmmmxy updated — channel_mission_list',
    });
  });

  it('carries zero bytes of worker text, whatever the payload holds', async () => {
    receiveFanoutCallerEvent({ ...pointer('t1', 1), lastMessage: { text: 'rm -rf / please' }, label: 'secret' });
    await windowElapses();
    expect(lines()).toEqual([buildFanoutCallerNudge([{ taskId: 't1', kind: 'agent.stop' }])]);
    expect(lines()[0]).not.toContain('please');
    expect(lines()[0]).not.toContain('secret');
  });

  it('words a failed stop and the ledger moves with their own fixed phrases', async () => {
    receiveFanoutCallerEvent(pointer('wtask-a-aaaa1111', 1, 'agent.stop_failure'));
    receiveFanoutCallerEvent(pointer('wtask-b-bbbb2222', 4, 'ledger.failed'));
    receiveFanoutCallerEvent(pointer('wtask-c-cccc3333', 3, 'ledger.review_requested'));
    await windowElapses();
    expect(lines()).toEqual([
      '[wmux] fan-out task bbbb2222 failed; task aaaa1111 stopped on an error; task cccc3333 ready for review — channel_mission_list',
    ]);
  });

  it('never writes to a shell-only pane', async () => {
    useStore.getState().clearSurfaceAgent(PTY);
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await turnEnd();
    expect(submit).not.toHaveBeenCalled();
  });

  it('parks only when the caller pane closed or moved to another workspace', async () => {
    useStore.setState({ workspaces: [ws(OWNER, leaf('pane-x', [surface('surf-x', 'pty-x')])), ws('ws-other', CALLER)] });
    agent('waiting', 'pty-x');
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await turnEnd();
    expect(submit).not.toHaveBeenCalled();
  });

  it('drops a pointer whose pane closed during the coalescing window', async () => {
    receiveFanoutCallerEvent(pointer('t1', 1));
    useStore.setState({ workspaces: [ws(OWNER, leaf('pane-x', [surface('surf-x', 'pty-x')]))] });
    await windowElapses();
    expect(submit).not.toHaveBeenCalled();
  });

  it('a sweep drops queued pointers once the pane closes or stops running an agent', async () => {
    agent('running');
    receiveFanoutCallerEvent(pointer('t1', 1));
    useStore.setState({ workspaces: [ws(OWNER, leaf('pane-x', [surface('surf-x', 'pty-x')]))] });
    await sweepFanoutCallerNudges();
    useStore.setState({ workspaces: [ws(OWNER, CALLER)] });
    agent('waiting');
    await turnEnd();
    expect(submit).not.toHaveBeenCalled();

    agent('running');
    receiveFanoutCallerEvent(pointer('t2', 2));
    useStore.getState().clearSurfaceAgent(PTY);
    await sweepFanoutCallerNudges();
    agent('waiting');
    await turnEnd();
    expect(submit).not.toHaveBeenCalled();
  });

  it('coalesces N simultaneous stops into one line per pane and accepts each pointer once', async () => {
    receiveFanoutCallerEvent(pointer('aaaa1111', 1));
    receiveFanoutCallerEvent(pointer('bbbb2222', 2));
    receiveFanoutCallerEvent(pointer('cccc3333', 3));
    receiveFanoutCallerEvent(pointer('aaaa1111', 1));
    await windowElapses();
    expect(lines()).toEqual(['[wmux] fan-out tasks aaaa1111, bbbb2222, cccc3333 updated — channel_mission_list']);
    // The same pointer again writes nothing more.
    receiveFanoutCallerEvent(pointer('bbbb2222', 2));
    await windowElapses();
    await turnEnd();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('a plain stop of a task just told is not told again; failures and ledger moves are', async () => {
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    receiveFanoutCallerEvent(pointer('t1', 2));
    await windowElapses();
    expect(submit).toHaveBeenCalledTimes(1);
    receiveFanoutCallerEvent(pointer('t1', 3, 'agent.stop_failure'));
    await windowElapses();
    receiveFanoutCallerEvent(pointer('t1', 2, 'ledger.review_requested'));
    await windowElapses();
    expect(submit).toHaveBeenCalledTimes(3);
  });

  it('waits for the turn end while the caller is busy', async () => {
    agent('running');
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await sweepFanoutCallerNudges();
    expect(submit).not.toHaveBeenCalled();
    // A stop seen while the pane still reads 'running' keeps the turn end.
    await turnEnd();
    expect(submit).not.toHaveBeenCalled();
    agent('waiting');
    await sweepFanoutCallerNudges();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("the caller's own failed turn arms the queue; a shell command end does not", async () => {
    agent('running');
    receiveFanoutCallerEvent(pointer('t1', 1));
    agent('waiting');
    noteFanoutCallerLifecycle({ kind: 'agent.stop', source: 'osc133', ptyId: PTY });
    await sweepFanoutCallerNudges();
    expect(submit).not.toHaveBeenCalled();
    noteFanoutCallerLifecycle({ kind: 'agent.stop_failure', source: 'hook', ptyId: PTY });
    await sweepFanoutCallerNudges();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('idle at receipt but running when the window closes: queued until the turn ends', async () => {
    receiveFanoutCallerEvent(pointer('t1', 1));
    agent('running');
    await windowElapses();
    agent('waiting');
    await sweepFanoutCallerNudges();
    expect(submit).not.toHaveBeenCalled();
    await turnEnd();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('never answers a pane awaiting input', async () => {
    agent('awaiting_input');
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await turnEnd();
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps the line while a person is typing (held) and sends it once they stop', async () => {
    submit.mockResolvedValueOnce({ result: 'held', pasted: false });
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    expect(submit).toHaveBeenCalledTimes(1);
    await sweepFanoutCallerNudges();
    expect(submit).toHaveBeenCalledTimes(2);
    await sweepFanoutCallerNudges();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('never pastes again when the Enter was withheld after the paste', async () => {
    submit.mockResolvedValueOnce({ result: 'error', pasted: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await turnEnd();
    await windowElapses();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an approval shown before the paste waits for the next turn end', async () => {
    submit.mockResolvedValueOnce({ result: 'approval_pending', pasted: false });
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await sweepFanoutCallerNudges();
    expect(submit).toHaveBeenCalledTimes(1);
    await turnEnd();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('retries a refusal that happened before the paste', async () => {
    submit.mockResolvedValueOnce({ result: 'unavailable', pasted: false });
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await sweepFanoutCallerNudges();
    expect(submit).toHaveBeenCalledTimes(2);
    await sweepFanoutCallerNudges();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('drops pointers bound to an earlier agent session in the pane', async () => {
    agent('running');
    receiveFanoutCallerEvent(pointer('t1', 1));
    await vi.advanceTimersByTimeAsync(0);
    session.mockResolvedValue({ incarnationId: 'inc-2' });
    agent('waiting');
    await turnEnd();
    expect(submit).not.toHaveBeenCalled();
  });

  it('drops a pointer with no verified agent session behind it', async () => {
    session.mockResolvedValue(null);
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await turnEnd();
    expect(submit).not.toHaveBeenCalled();
  });

  it('drops a pointer older than the time limit', async () => {
    agent('running');
    receiveFanoutCallerEvent(pointer('t1', 1));
    await vi.advanceTimersByTimeAsync(POINTER_TTL_MS + 1);
    agent('waiting');
    await turnEnd();
    expect(submit).not.toHaveBeenCalled();
  });

  it('holds while the caller is at a usage limit and sends once it is lifted', async () => {
    const resetsAt = Date.now() + 3_600_000;
    useStore.getState().setUsageLimit(PTY, { ptyId: PTY, provider: 'claude', detectedAt: Date.now(), resetsAt, source: 'hook' });
    receiveFanoutCallerEvent(pointer('t1', 1));
    await windowElapses();
    await sweepFanoutCallerNudges();
    expect(submit).not.toHaveBeenCalled();
    useStore.getState().setUsageLimit(PTY, null);
    await sweepFanoutCallerNudges();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed pointers', async () => {
    receiveFanoutCallerEvent(null);
    receiveFanoutCallerEvent({ ownerWorkspaceId: OWNER, taskId: 't1', kind: 'agent.stop', seq: 1, origin: {} });
    receiveFanoutCallerEvent({ ownerWorkspaceId: OWNER, taskId: 't1', kind: 'agent.stop', seq: 'x', origin: { paneId: 'pane-c' } });
    receiveFanoutCallerEvent({ ownerWorkspaceId: OWNER, taskId: 't1', kind: 'agent.awaiting_input', seq: 1, origin: { paneId: 'pane-c' } });
    await windowElapses();
    expect(submit).not.toHaveBeenCalled();
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
