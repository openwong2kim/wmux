// @vitest-environment jsdom
//
// A2A deliveries are pasted and submitted with Enter by the renderer. An Enter
// into a pane that shows an approval selects its highlighted option, so every
// A2A write first asks main (the same guard `input.send` applies) and writes
// nothing when main refuses. These drive the real handler and read the bytes
// that reach `pty.write`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';

const PTY = 'pty-gate-target';
const BODY = 'please continue';
const REFUSAL = 'input.send: pane has an approval in front of it';

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

function workspace(id: string, name: string, ptyId: string): Workspace {
  return { id, name, rootPane: leaf(`pane-${id}`, ptyId), activePaneId: `pane-${id}` } as Workspace;
}

const SENDER = workspace('ws-gate-sender', 'Sender', 'pty-gate-sender');
const TARGET = workspace('ws-gate-target', 'Target', PTY);

let write: ReturnType<typeof vi.fn>;
let gate: ReturnType<typeof vi.fn>;

/** Everything written to the target pty, the delayed Enter included. */
function writesToTarget(): string[] {
  vi.runAllTimers();
  return write.mock.calls.filter(([ptyId]) => ptyId === PTY).map(([, data]) => data as string);
}

type Result = { ok?: boolean; taskId?: string; delivery?: Record<string, unknown>; sent?: number; withheld?: unknown[] };

async function send(params: Record<string, unknown>): Promise<Result> {
  return (await handleRpcMethod('a2a.task.send', {
    workspaceId: SENDER.id,
    to: TARGET.id,
    message: BODY,
    ...params,
  })) as Result;
}

beforeEach(() => {
  vi.useFakeTimers();
  write = vi.fn();
  gate = vi.fn(async () => REFUSAL);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write },
    rpc: { a2aDeliveryGate: gate },
  };
  const s = useStore.getState();
  // A detected agent that is not live: the loud full-body paste path.
  s.setSurfaceAgent(PTY, 'Claude Code', 'waiting', 'claude');
  s.hydrateAgentAlive({});
  s.hydrateCommandRunning({});
  useStore.setState({ workspaces: [SENDER, TARGET], paneGate: 'ready' });
});

afterEach(() => {
  useStore.getState().clearSurfaceAgent(PTY);
  vi.useRealTimers();
});

describe('A2A delivery approval gate', () => {
  it('a new task to a pane behind an approval writes nothing, stays stored, and says why', async () => {
    const result = await send({ silent: false });
    expect(writesToTarget()).toEqual([]);
    expect(gate).toHaveBeenCalledWith(PTY);
    expect(result.ok).toBe(true);
    expect(result.delivery).toMatchObject({ stored: true, notified: false, reason: 'approval_pending' });
    expect(useStore.getState().getTask(result.taskId!)).toBeDefined();
  });

  it('the one-line nudge to a live agent is withheld the same way', async () => {
    useStore.getState().hydrateAgentAlive({ [PTY]: true });
    const result = await send({});
    expect(writesToTarget()).toEqual([]);
    expect(result.delivery).toMatchObject({ notified: false, reason: 'approval_pending' });
  });

  it('a reply is withheld and reported', async () => {
    const created = await send({ silent: true });
    const reply = await send({ taskId: created.taskId, silent: false });
    expect(writesToTarget()).toEqual([]);
    expect(reply.delivery).toMatchObject({ notified: false, reason: 'approval_pending' });
  });

  it('a status-update message is withheld and reported', async () => {
    const created = await send({ paneId: `pane-${TARGET.id}`, silent: true });
    const update = (await handleRpcMethod('a2a.task.update', {
      taskId: created.taskId,
      workspaceId: SENDER.id,
      message: 'progress note',
    })) as Result;
    expect(writesToTarget()).toEqual([]);
    expect(update.delivery).toMatchObject({ notified: false, reason: 'approval_pending' });
  });

  it('a broadcast withholds the gated pane and reports it', async () => {
    const result = (await handleRpcMethod('a2a.broadcast', { workspaceId: SENDER.id, message: BODY })) as Result;
    expect(writesToTarget()).toEqual([]);
    expect(result.sent).toBe(0);
    expect(result.withheld).toHaveLength(1);
  });

  it('once the gate clears, the same send is delivered', async () => {
    gate.mockResolvedValue(null);
    const result = await send({ silent: false });
    expect(result.delivery).toMatchObject({ notified: true });
    expect(writesToTarget().join('')).toContain(BODY);
  });

  it('a gate that cannot answer refuses (fail closed)', async () => {
    gate.mockRejectedValue(new Error('ipc down'));
    const result = await send({ silent: false });
    expect(writesToTarget()).toEqual([]);
    expect(result.delivery).toMatchObject({ reason: 'approval_pending' });
  });

  it('a delivery main stamped as operator-originated is not gated', async () => {
    const result = await send({ silent: false, operatorOrigin: true });
    expect(gate).not.toHaveBeenCalled();
    expect(result.delivery).toMatchObject({ notified: true });
    expect(writesToTarget().join('')).toContain(BODY);
  });
});
