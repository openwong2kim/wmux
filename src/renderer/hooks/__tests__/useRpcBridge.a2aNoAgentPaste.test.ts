// @vitest-environment jsdom
//
// #1489 — `silent:false`, an explicit pane_id, or a task anchor pinned to a
// plain shell pane used to paste the whole A2A envelope into that shell and
// press Enter. The `␤` fold keeps the body on one line, but that line still
// runs as a command. Every A2A PTY path now writes only to a pane with a
// detected agent; these tests drive the real handler and read the bytes that
// reach `pty.write`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';

const PTY = 'pty-1489-target';
const TARGET_PANE = 'pane-ws-1489-target';
const BODY = 'hello; New-Item -Path proof.txt';

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

function workspace(id: string, name: string, ptyId: string): Workspace {
  return { id, name, rootPane: leaf(`pane-${id}`, ptyId), activePaneId: `pane-${id}` } as Workspace;
}

const SENDER = workspace('ws-1489-sender', 'Sender', 'pty-1489-sender');
const TARGET = workspace('ws-1489-target', 'Target', PTY);

let write: ReturnType<typeof vi.fn>;

/** Everything written to the target pty, the delayed Enter included. */
function writesToTarget(): string[] {
  vi.runAllTimers();
  return write.mock.calls.filter(([ptyId]) => ptyId === PTY).map(([, data]) => data as string);
}

function makeLiveAgent(): void {
  useStore.getState().setSurfaceAgent(PTY, 'Claude Code', 'waiting', 'claude');
  useStore.getState().hydrateAgentAlive({ [PTY]: true });
}

type SendResult = { ok?: boolean; taskId?: string; delivery?: Record<string, unknown>; error?: string };

async function send(params: Record<string, unknown>): Promise<SendResult> {
  return (await handleRpcMethod('a2a.task.send', {
    workspaceId: SENDER.id,
    to: TARGET.id,
    message: BODY,
    ...params,
  })) as SendResult;
}

const NO_AGENT = { stored: true, notified: false, reason: 'no_agent_pane' };

beforeEach(() => {
  vi.useFakeTimers();
  write = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { write } };
  const s = useStore.getState();
  s.clearSurfaceAgent(PTY);
  s.hydrateAgentAlive({});
  s.hydrateCommandRunning({});
  useStore.setState({ workspaces: [SENDER, TARGET], paneGate: 'ready' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a2a.task.send (new task)', () => {
  it('silent:false to a shell pane writes nothing and reports no_agent_pane', async () => {
    const result = await send({ silent: false });
    expect(result.ok).toBe(true);
    expect(result.delivery).toMatchObject(NO_AGENT);
    expect(writesToTarget()).toEqual([]);
  });

  it('an explicit pane_id naming a shell pane writes nothing (silent omitted)', async () => {
    const result = await send({ paneId: TARGET_PANE });
    expect(result.delivery).toMatchObject(NO_AGENT);
    expect(writesToTarget()).toEqual([]);
  });

  it('an explicit pane_id naming a shell pane writes nothing (silent:false)', async () => {
    const result = await send({ paneId: TARGET_PANE, silent: false });
    expect(result.delivery).toMatchObject(NO_AGENT);
    expect(writesToTarget()).toEqual([]);
  });

  it('silent:false to a live agent pane still pastes the full body', async () => {
    makeLiveAgent();
    const result = await send({ silent: false });
    expect(result.delivery).toMatchObject({ notified: true, mode: 'notification' });
    const writes = writesToTarget();
    expect(writes.join('')).toContain('New-Item -Path proof.txt');
    expect(writes.join('')).not.toContain('[wmux] new A2A task');
  });
});

describe('a2a.task.send (reply)', () => {
  it('silent:false reply to an unpinned shell target writes nothing', async () => {
    const created = await send({ silent: true });
    expect(writesToTarget()).toEqual([]);
    const reply = await send({ taskId: created.taskId, silent: false });
    expect(reply.delivery).toMatchObject(NO_AGENT);
    expect(writesToTarget()).toEqual([]);
  });

  it('a reply to a task pinned to a shell pane writes nothing (silent:false and omitted)', async () => {
    const created = await send({ paneId: TARGET_PANE, silent: true });
    for (const silent of [false, undefined]) {
      const reply = await send({ taskId: created.taskId, silent });
      expect(reply.delivery).toMatchObject(NO_AGENT);
    }
    expect(writesToTarget()).toEqual([]);
  });

  it('silent:false reply to a live agent pane still pastes the full body', async () => {
    makeLiveAgent();
    const created = await send({ silent: true });
    const reply = await send({ taskId: created.taskId, silent: false });
    expect(reply.delivery).toMatchObject({ notified: true, mode: 'notification' });
    expect(writesToTarget().join('')).toContain('New-Item -Path proof.txt');
  });
});

describe('a2a.task.update', () => {
  it('a message on a task pinned to a shell pane writes nothing', async () => {
    const created = await send({ paneId: TARGET_PANE, silent: true });
    const result = await handleRpcMethod('a2a.task.update', {
      taskId: created.taskId,
      workspaceId: SENDER.id,
      message: BODY,
    });
    expect(result).toMatchObject({ ok: true });
    expect(writesToTarget()).toEqual([]);
  });

  it('a message on a task pinned to a live agent pane is still delivered', async () => {
    makeLiveAgent();
    const created = await send({ paneId: TARGET_PANE, silent: true });
    await handleRpcMethod('a2a.task.update', { taskId: created.taskId, workspaceId: SENDER.id, message: BODY });
    expect(writesToTarget().length).toBeGreaterThan(0);
  });
});

describe('a2a.broadcast', () => {
  it('skips a workspace whose only pane is a shell', async () => {
    const result = await handleRpcMethod('a2a.broadcast', { workspaceId: SENDER.id, message: BODY });
    expect(result).toMatchObject({ ok: true, sent: 0, skipped: 1 });
    expect(writesToTarget()).toEqual([]);
  });
});
