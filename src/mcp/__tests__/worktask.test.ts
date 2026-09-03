// Tests for the task-lifecycle MCP tools.
//
// The trust boundary is main-side (worktask.rpc.test.ts). What is pinned HERE
// is the tool SHAPE: a schema that cannot express a call main rejects, the
// verified ptyId attached on every call, and the wire envelope handed back
// whole — collapsing it would hide the `reason` an unattended caller branches
// on ('dirty', 'unpushed', 'busy', 'deps_missing').

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../wmux-client', () => ({
  sendRpc: vi.fn(),
  setClientIdentity: vi.fn(),
  clearClientIdentity: vi.fn(),
}));

import { sendRpc } from '../wmux-client';
import { registerWorktaskTools } from '../worktask';

const mockSendRpc = sendRpc as unknown as ReturnType<typeof vi.fn>;

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const shapes = new Map<string, Record<string, unknown>>();
const tools = new Map<string, ToolHandler>();
let resolveCalls = 0;

const server = {
  tool: (name: string, _desc: string, schema: Record<string, unknown>, handler: ToolHandler) => {
    tools.set(name, handler);
    shapes.set(name, schema);
  },
};
registerWorktaskTools(server as never, {
  getSenderPtyId: () => 'pty-mine',
  resolveWorkspaceId: async () => {
    resolveCalls += 1;
    return 'ws-mine';
  },
});

const NAMES = ['task_gate_run', 'task_adopt', 'task_close', 'task_pr'] as const;

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({ ok: true });
  resolveCalls = 0;
});

describe('tool surface', () => {
  it('registers the four contracted names and nothing else', () => {
    expect([...tools.keys()].sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)('%s exposes no workspace, path, repo or command input', (name) => {
    for (const key of Object.keys(shapes.get(name) ?? {})) {
      expect(key).not.toMatch(/workspace|worktree|path|repo|cmd|command/i);
    }
  });

  it.each(NAMES)('%s takes a task id', (name) => {
    expect(Object.keys(shapes.get(name) ?? {})).toContain('task_id');
  });
});

describe('the wire call', () => {
  it.each([
    ['task_gate_run', 'task.gate.run'],
    ['task_adopt', 'task.adopt'],
    ['task_close', 'task.close'],
    ['task_pr', 'task.pr'],
  ])('%s sends %s with the verified ptyId and camelCase taskId', async (tool, method) => {
    await tools.get(tool)?.({ task_id: 'wtask-1' });
    expect(mockSendRpc).toHaveBeenCalledWith(method, { taskId: 'wtask-1', senderPtyId: 'pty-mine' });
  });

  it('resolves identity BEFORE reading the ptyId (a cold getter answers empty)', async () => {
    await tools.get('task_close')?.({ task_id: 'wtask-1' });
    expect(resolveCalls).toBe(1);
  });

  it('passes an optional PR body and omits it otherwise', async () => {
    await tools.get('task_pr')?.({ task_id: 'wtask-1', body: 'why' });
    expect(mockSendRpc).toHaveBeenLastCalledWith('task.pr', {
      taskId: 'wtask-1',
      body: 'why',
      senderPtyId: 'pty-mine',
    });
    await tools.get('task_pr')?.({ task_id: 'wtask-1' });
    expect(mockSendRpc).toHaveBeenLastCalledWith('task.pr', { taskId: 'wtask-1', senderPtyId: 'pty-mine' });
  });
});

describe('the answer', () => {
  it('keeps the refusal envelope whole and flags it as an error', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, taskId: 'wtask-1', reason: 'unpushed', aheadCount: 2 });
    const res = await tools.get('task_close')?.({ task_id: 'wtask-1' });
    expect(res?.isError).toBe(true);
    const parsed = JSON.parse(res?.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(parsed['reason']).toBe('unpushed');
    expect(parsed['aheadCount']).toBe(2);
  });

  it('does not flag a successful gate run, whatever the exit code says', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, status: 'completed', result: { exitCode: 1 } });
    const res = await tools.get('task_gate_run')?.({ task_id: 'wtask-1' });
    // The CALL succeeded; the gate failed. Those are different, and an isError
    // here would make a failing gate look like a broken tool.
    expect(res?.isError).toBeUndefined();
  });

  it('reports a transport failure as an error instead of throwing', async () => {
    mockSendRpc.mockRejectedValue(new Error('wmux is not running'));
    const res = await tools.get('task_adopt')?.({ task_id: 'wtask-1' });
    expect(res?.isError).toBe(true);
    expect(res?.content[0]?.text).toContain('wmux is not running');
  });
});
