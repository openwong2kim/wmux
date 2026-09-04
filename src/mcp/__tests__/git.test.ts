// Tests for the read-only git/gh tools.
//
// The point of these tools is that nothing a caller types becomes part of a
// command line: it names a TASK, and main runs a fixed argv in the worktree it
// has already checked the caller owns. So what is asserted here is the absence
// of any path/ref/command input, the clamp on `limit`, and that a "no PR" answer
// survives as data.

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../wmux-client', () => ({
  sendRpc: vi.fn(),
  setClientIdentity: vi.fn(),
  clearClientIdentity: vi.fn(),
}));

import { z } from 'zod';
import { sendRpc } from '../wmux-client';
import { registerGitTools } from '../git';

const mockSendRpc = sendRpc as unknown as ReturnType<typeof vi.fn>;

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const shapes = new Map<string, Record<string, unknown>>();
const tools = new Map<string, ToolHandler>();

const server = {
  tool: (name: string, _desc: string, schema: Record<string, unknown>, handler: ToolHandler) => {
    tools.set(name, handler);
    shapes.set(name, schema);
  },
};
registerGitTools(server as never, { getSenderPtyId: () => 'pty-mine', resolveWorkspaceId: async () => 'ws-mine' });

const NAMES = ['git_status', 'git_log', 'gh_pr_view'] as const;

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({ ok: true });
});

describe('tool surface', () => {
  it('registers the three contracted names and nothing else', () => {
    expect([...tools.keys()].sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)('%s exposes no path, ref, revision or command input', (name) => {
    for (const key of Object.keys(shapes.get(name) ?? {})) {
      expect(key).not.toMatch(/path|repo|worktree|ref|rev|branch|cmd|command|args/i);
    }
  });

  it('caps git_log limit in the schema as well as on the server', () => {
    const limit = (shapes.get('git_log') ?? {})['limit'] as z.ZodTypeAny;
    expect(limit.safeParse(50).success).toBe(true);
    expect(limit.safeParse(51).success).toBe(false);
    expect(limit.safeParse(0).success).toBe(false);
    expect(limit.safeParse(1.5).success).toBe(false);
    // Optional: omitting it means the server default.
    expect(limit.safeParse(undefined).success).toBe(true);
  });
});

describe('the wire call', () => {
  it.each([
    ['git_status', 'task.git.status'],
    ['git_log', 'task.git.log'],
    ['gh_pr_view', 'task.gh.prView'],
  ])('%s sends %s with the verified ptyId', async (tool, method) => {
    await tools.get(tool)?.({ task_id: 'wtask-1' });
    expect(mockSendRpc).toHaveBeenCalledWith(method, { taskId: 'wtask-1', senderPtyId: 'pty-mine' });
  });

  it('omits taskId when no task is named, so main reads the caller\'s own repository', async () => {
    await tools.get('git_status')?.({});
    expect(mockSendRpc).toHaveBeenLastCalledWith('task.git.status', { senderPtyId: 'pty-mine' });
    await tools.get('git_log')?.({ limit: 5 });
    expect(mockSendRpc).toHaveBeenLastCalledWith('task.git.log', { limit: 5, senderPtyId: 'pty-mine' });
  });

  it('keeps task_id required on gh_pr_view — a PR belongs to a task branch', () => {
    const prTask = (shapes.get('gh_pr_view') ?? {})['task_id'] as z.ZodTypeAny;
    expect(prTask.safeParse(undefined).success).toBe(false);
    for (const name of ['git_status', 'git_log']) {
      const optional = (shapes.get(name) ?? {})['task_id'] as z.ZodTypeAny;
      expect(optional.safeParse(undefined).success).toBe(true);
      // Still a real id when given: '' would be a task nobody owns.
      expect(optional.safeParse('').success).toBe(false);
    }
  });

  it('omits limit entirely when the caller does not give one', async () => {
    await tools.get('git_log')?.({ task_id: 'wtask-1' });
    expect(mockSendRpc).toHaveBeenCalledWith('task.git.log', { taskId: 'wtask-1', senderPtyId: 'pty-mine' });
    await tools.get('git_log')?.({ task_id: 'wtask-1', limit: 5 });
    expect(mockSendRpc).toHaveBeenLastCalledWith('task.git.log', {
      taskId: 'wtask-1',
      limit: 5,
      senderPtyId: 'pty-mine',
    });
  });
});

describe('the answer', () => {
  it('hands back "no PR" as data the caller can read', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, taskId: 'wtask-1', reason: 'no-pr', error: 'no pull requests found' });
    const res = await tools.get('gh_pr_view')?.({ task_id: 'wtask-1' });
    const parsed = JSON.parse(res?.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(parsed['reason']).toBe('no-pr');
  });

  it('returns the parsed status object unchanged', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, clean: false, files: [{ status: ' M', path: 'a.ts' }] });
    const res = await tools.get('git_status')?.({ task_id: 'wtask-1' });
    const parsed = JSON.parse(res?.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(parsed['files']).toEqual([{ status: ' M', path: 'a.ts' }]);
  });
});
