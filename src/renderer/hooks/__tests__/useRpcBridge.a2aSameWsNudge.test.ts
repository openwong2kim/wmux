// @vitest-environment jsdom
//
// #1573 — a pane_id-addressed send between two agent panes of ONE workspace
// looked like it nudged the sender's pane too. The send writes only to the
// addressed pane; the line in the sender's pane was the receiver's reply,
// which used the same "new A2A task <id> from <workspace>" text — and in a
// same-workspace task both parties share the workspace name. These tests drive
// the real handler and read the bytes that reach each pty.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pane, PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';
import { formatBracketedPastePayload } from '../../../shared/ptyMessageDelivery';

const PTY_A = 'pty-1573-a';
const PTY_B = 'pty-1573-b';

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

const WS = {
  id: 'ws-1573',
  name: 'Shared',
  rootPane: {
    id: 'split-1573',
    type: 'branch',
    direction: 'horizontal',
    children: [leaf('pane-1573-a', PTY_A), leaf('pane-1573-b', PTY_B)],
    sizes: [50, 50],
  } as unknown as Pane,
  activePaneId: 'pane-1573-a',
} as Workspace;

let write: ReturnType<typeof vi.fn<(ptyId: string, data: string) => void>>;

/** Everything written to `ptyId` since the last clear, the delayed Enter included. */
function writesTo(ptyId: string): string {
  vi.runAllTimers();
  return write.mock.calls.filter(([p]) => p === ptyId).map(([, data]) => data).join('');
}

type Result = { ok?: boolean; taskId?: string; delivery?: Record<string, unknown>; error?: string };

beforeEach(() => {
  vi.useFakeTimers();
  write = vi.fn<(ptyId: string, data: string) => void>();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write },
    rpc: {
      gatedSubmit: async (ptyId: string, text: string) => {
        write(ptyId, formatBracketedPastePayload(text));
        write(ptyId, '\r');
        return { ok: true };
      },
    },
  };
  const s = useStore.getState();
  for (const pty of [PTY_A, PTY_B]) s.setSurfaceAgent(pty, 'Claude Code', 'waiting', 'claude');
  s.hydrateAgentAlive({ [PTY_A]: true, [PTY_B]: true });
  s.hydrateCommandRunning({});
  useStore.setState({ workspaces: [WS], paneGate: 'ready' });
});

afterEach(() => {
  vi.useRealTimers();
});

async function sendAtoB(): Promise<Result> {
  return (await handleRpcMethod('a2a.task.send', {
    workspaceId: WS.id,
    to: WS.id,
    paneId: 'pane-1573-b',
    senderPtyId: PTY_A,
    message: 'please review',
  })) as Result;
}

describe('same-workspace pane-to-pane A2A nudges (#1573)', () => {
  it('a pane_id-addressed send nudges only the addressed pane', async () => {
    const sent = await sendAtoB();
    expect(sent.delivery).toMatchObject({ notified: true, mode: 'nudge' });
    expect(writesTo(PTY_B)).toContain(`[wmux] new A2A task ${sent.taskId!.slice(5, 13)} from Shared`);
    expect(writesTo(PTY_A)).toBe('');
  });

  it("the receiver's reply reaches the sender labeled as a reply, not a new task", async () => {
    const sent = await sendAtoB();
    const id8 = sent.taskId!.slice(5, 13);

    write.mockClear();
    await handleRpcMethod('a2a.task.update', {
      workspaceId: WS.id, taskId: sent.taskId, status: 'working', message: 'on it', senderPtyId: PTY_B,
    });
    const afterUpdate = writesTo(PTY_A);
    expect(afterUpdate).toContain(`[wmux] reply on A2A task ${id8} from Shared — a2a_task_query`);
    expect(afterUpdate).not.toContain('new A2A task');
    expect(writesTo(PTY_B)).toBe('');

    write.mockClear();
    await handleRpcMethod('a2a.task.send', {
      workspaceId: WS.id, taskId: sent.taskId, message: 'done', senderPtyId: PTY_B,
    });
    const afterReply = writesTo(PTY_A);
    expect(afterReply).toContain(`[wmux] reply on A2A task ${id8} from Shared — a2a_task_query`);
    expect(afterReply).not.toContain('new A2A task');
    expect(writesTo(PTY_B)).toBe('');
  });
});
