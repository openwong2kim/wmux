// @vitest-environment jsdom
//
// #1573 — a pane_id-addressed send between two agent panes of ONE workspace
// looked like it nudged the sender's pane too. The send writes only to the
// addressed pane; the line in the sender's pane was the receiver's reply,
// which used the same "new A2A task <id> from <workspace>" text — and in a
// same-workspace task both parties share the workspace name. These tests drive
// the real handler and read the bytes that reach each pty. A reply also must
// not type into a sender pane that is back at its shell (#1489 gate).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pane, PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { buildA2aNudge, handleRpcMethod, nudgeTitlePreview } from '../useRpcBridge';
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

async function sendAtoB(title?: string): Promise<Result> {
  return (await handleRpcMethod('a2a.task.send', {
    workspaceId: WS.id,
    to: WS.id,
    paneId: 'pane-1573-b',
    senderPtyId: PTY_A,
    message: 'please review',
    ...(title !== undefined && { title }),
  })) as Result;
}

describe('same-workspace pane-to-pane A2A nudges (#1573)', () => {
  it('a pane_id-addressed send nudges only the addressed pane', async () => {
    const sent = await sendAtoB('review the login fix');
    expect(sent.delivery).toMatchObject({ notified: true, mode: 'nudge' });
    expect(writesTo(PTY_B)).toContain(`[wmux] new A2A task ${sent.taskId!.slice(5, 13)} from Shared — title: "review the login fix" — a2a_task_query task_id:${sent.taskId}`);
    expect(writesTo(PTY_B)).not.toContain('please review');
    expect(writesTo(PTY_A)).toBe('');
  });

  it('an untitled task nudges with the id and sender only — the body is never a stand-in title', async () => {
    const sent = await sendAtoB();
    expect(sent.delivery).toMatchObject({ notified: true, mode: 'nudge' });
    const line = writesTo(PTY_B);
    expect(line).toContain(`[wmux] new A2A task ${sent.taskId!.slice(5, 13)} from Shared — a2a_task_query task_id:${sent.taskId}`);
    expect(line).not.toContain('please review');
    expect(line).not.toContain('title:');
  });

  it('a new-task nudge carries an allowlisted title and the full task id, never the body', () => {
    const line = buildA2aNudge('task-12345678-rest', 'Ops', 'new', 'Fix login; printf INJECTION_REACHED; # @src/x');
    expect(line).toBe(
      '[wmux] new A2A task 12345678 from Ops — title: "Fix login printf INJECTION_REACHED src/x" — a2a_task_query task_id:task-12345678-rest',
    );
    // Shell metacharacters, quotes, @, C0/C1 controls, bidi and zero-width marks all become spaces.
    expect(nudgeTitlePreview('a$(b)`c`|d&e<f>g"h\'i\\j@k\u0000l\u0085m\u202en\u200bo')).toBe('a b c d e f g h i j k l m n o');
    // Letters of any script survive; the cut is by code point, never inside a surrogate pair.
    expect(nudgeTitlePreview('한글 제목')).toBe('한글 제목');
    const astral = nudgeTitlePreview('\u{20000}'.repeat(100));
    expect(Array.from(astral.replace(/\.\.\.$/, ''))).toHaveLength(60);
    expect(astral).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('a new-task nudge omits the title when the target agent has exited', async () => {
    useStore.getState().hydrateAgentAlive({ [PTY_A]: true, [PTY_B]: false });
    await sendAtoB('review the login fix');
    expect(writesTo(PTY_B)).not.toContain('review the login fix');
    expect(writesTo(PTY_B)).not.toContain('please review');
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

  it('a reply to a sender pane that is back at its shell writes nothing there', async () => {
    const sent = await sendAtoB();
    // A's agent exited: the pane is a plain shell, where a typed line runs.
    useStore.getState().clearSurfaceAgent(PTY_A);
    useStore.getState().hydrateAgentAlive({ [PTY_B]: true });

    write.mockClear();
    await handleRpcMethod('a2a.task.update', {
      workspaceId: WS.id, taskId: sent.taskId, status: 'working', message: 'on it', senderPtyId: PTY_B,
    });
    expect(writesTo(PTY_A)).toBe('');

    const reply = (await handleRpcMethod('a2a.task.send', {
      workspaceId: WS.id, taskId: sent.taskId, message: 'done', senderPtyId: PTY_B,
    })) as Result;
    expect(reply.delivery).toMatchObject({ stored: true, notified: false, reason: 'no_agent_pane' });
    expect(writesTo(PTY_A)).toBe('');
  });
});
