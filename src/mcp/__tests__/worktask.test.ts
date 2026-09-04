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

const NAMES = ['task_gate_run', 'task_gate_cancel', 'task_adopt', 'task_close', 'task_pr'] as const;

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({ ok: true });
  resolveCalls = 0;
});

describe('tool surface', () => {
  it('registers the contracted names and nothing else', () => {
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
    ['task_gate_cancel', 'task.gate.cancel'],
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

  it('passes an optional adopt commit flag and omits it otherwise', async () => {
    await tools.get('task_adopt')?.({ task_id: 'wtask-1', commit: true });
    expect(mockSendRpc).toHaveBeenLastCalledWith('task.adopt', {
      taskId: 'wtask-1',
      commit: true,
      senderPtyId: 'pty-mine',
    });
    await tools.get('task_adopt')?.({ task_id: 'wtask-1' });
    expect(mockSendRpc).toHaveBeenLastCalledWith('task.adopt', { taskId: 'wtask-1', senderPtyId: 'pty-mine' });
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

/** The envelope is always the LAST content block, untouched and parseable —
 *  a refusal header rides in its own block ahead of it. */
function envelope(res?: { content: { type: 'text'; text: string }[] }): Record<string, unknown> {
  const blocks = res?.content ?? [];
  return JSON.parse(blocks[blocks.length - 1]?.text ?? '{}') as Record<string, unknown>;
}

/** The refusal header block, or '' when the answer carries none. */
function header(res?: { content: { type: 'text'; text: string }[] }): string {
  const blocks = res?.content ?? [];
  return blocks.length > 1 ? blocks[0].text : '';
}

describe('the answer', () => {
  it('keeps the refusal envelope whole and flags it as an error', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, taskId: 'wtask-1', reason: 'unpushed', aheadCount: 2 });
    const res = await tools.get('task_close')?.({ task_id: 'wtask-1' });
    expect(res?.isError).toBe(true);
    const parsed = envelope(res);
    expect(parsed['reason']).toBe('unpushed');
    expect(parsed['aheadCount']).toBe(2);
    // The JSON block itself is untouched — a caller that JSON.parses it works.
    expect(() => JSON.parse(res?.content[res.content.length - 1]?.text ?? '')).not.toThrow();
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

// Wave 3, finding 13 — the brain reported "adopt finished (ff51d7e)" after two
// refusals. The envelope was right; a JSON blob is just skimmable past. A
// refusal now LEADS with the verdict.
describe('a refusal cannot be read as a success', () => {
  it('a refused adopt leads with REFUSED in its OWN block, is isError, and names the next step', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, taskId: 'wtask-1', reason: 'dirty-target', error: 'target has uncommitted changes' });
    const res = await tools.get('task_adopt')?.({ task_id: 'wtask-1' });
    expect(res?.isError).toBe(true);
    expect(res?.content).toHaveLength(2);
    expect(header(res).startsWith('REFUSED (dirty-target): target has uncommitted changes')).toBe(true);
    expect(header(res)).toContain('Nothing was adopted. Next step: commit or stash');
    // The envelope block stays pure JSON.
    expect(envelope(res)['reason']).toBe('dirty-target');
  });

  it('spells out the commit-failed recovery (the applied paths were restored)', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, reason: 'commit-failed', error: 'hook refused', files: ['a.ts'] });
    const res = await tools.get('task_adopt')?.({ task_id: 'wtask-1' });
    expect(header(res).startsWith('REFUSED (commit-failed): hook refused')).toBe(true);
    expect(header(res)).toContain('the applied paths were restored; inspect the target with git_status and retry');
  });

  // The RPC GATE refuses before any service runs, and its shape has no `reason`
  // at all: { ok: false, error: { code, message } }. Keying only on `reason`
  // printed "REFUSED (unknown): the server refused the call (no message)" over
  // the one fact that mattered — the human declined the approval.
  it('falls back to the gate error code and message when there is no reason', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_AUTHORIZED', message: 'the approval was declined' },
    });
    const res = await tools.get('task_close')?.({ task_id: 'wtask-1' });
    expect(res?.isError).toBe(true);
    expect(header(res).startsWith('REFUSED (NOT_AUTHORIZED): the approval was declined')).toBe(true);
    expect(header(res)).toContain('the approval was declined or expired, or the task is not yours');
    expect(envelope(res)['ok']).toBe(false);
  });

  it('names the precondition recovery for a task with no worktree', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'FAILED_PRECONDITION', message: 'task has no worktree' },
    });
    const res = await tools.get('task_pr')?.({ task_id: 'wtask-1' });
    expect(header(res).startsWith('REFUSED (FAILED_PRECONDITION): task has no worktree')).toBe(true);
    expect(header(res)).toContain('check it with ledger_list / git_status first');
  });

  it('falls back to a generic next step for a reason it does not know', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, reason: 'no-repo' });
    const res = await tools.get('task_adopt')?.({ task_id: 'wtask-1' });
    expect(header(res).startsWith('REFUSED (no-repo): the server refused the call (no message)')).toBe(true);
    expect(header(res)).toContain('then call task_adopt again');
  });

  it('close and pr share the shape with their own wording', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, reason: 'unpushed', error: '2 commits ahead' });
    const closed = await tools.get('task_close')?.({ task_id: 'wtask-1' });
    expect(header(closed).startsWith('REFUSED (unpushed): 2 commits ahead')).toBe(true);
    expect(header(closed)).toContain('Nothing was closed; the worktree is intact.');

    mockSendRpc.mockResolvedValue({ ok: false, reason: 'gh-missing', error: 'gh not found' });
    const pr = await tools.get('task_pr')?.({ task_id: 'wtask-1' });
    expect(header(pr).startsWith('REFUSED (gh-missing): gh not found')).toBe(true);
    expect(header(pr)).toContain('No pull request was opened.');
  });

  it('leaves a SUCCESS untouched — one block, plain JSON', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, commit: 'ff51d7e' });
    const res = await tools.get('task_adopt')?.({ task_id: 'wtask-1' });
    expect(res?.isError).toBeUndefined();
    expect(res?.content).toHaveLength(1);
    expect(envelope(res)['commit']).toBe('ff51d7e');
    expect(res?.content[0]?.text).not.toContain('REFUSED');
  });

  it('a refused GATE tool keeps the plain envelope (no refusal copy)', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, error: { code: 'NOT_AUTHORIZED', message: 'no' } });
    const res = await tools.get('task_gate_run')?.({ task_id: 'wtask-1' });
    expect(res?.isError).toBe(true);
    expect(res?.content).toHaveLength(1);
  });
});
