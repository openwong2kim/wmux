import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../wmux-client', () => ({
  sendRpc: vi.fn(),
  setClientIdentity: vi.fn(),
  clearClientIdentity: vi.fn(),
}));

import { sendRpc } from '../wmux-client';
import { z } from 'zod';
import { registerRemoteAnswerTool, registerRemoteApproveTool, registerRemoteSpawnTools } from '../remoteSpawn';
import { FIRST_PARTY_METHODS } from '../../main/mcp/firstParty';

const mockSendRpc = sendRpc as unknown as ReturnType<typeof vi.fn>;

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;

let pty = '';
const warmed = vi.fn(async () => {
  // The walk that finds the caller fills the ptyId as a side effect.
  pty = 'pty-mine';
  return 'ws-a';
});
let tool: ToolHandler;
registerRemoteSpawnTools(
  { tool: (_n: string, _d: string, _s: unknown, h: ToolHandler) => { tool = h; } } as never,
  { getSenderPtyId: () => pty, resolveWorkspaceId: warmed },
);

beforeEach(() => {
  mockSendRpc.mockReset();
  pty = '';
});

describe('remote_spawn', () => {
  it('asks with the verified ptyId, found before the call', async () => {
    mockSendRpc.mockResolvedValueOnce({ ok: true, spawn: { spawnId: 'sp-1' }, online: false });
    const res = await tool({ pc: 'DESK', agent: 'claude', root: 'web', prompt: 'fix it', expires_in_hours: 4 });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.remote.spawn', {
      pc: 'DESK', agent: 'claude', root: 'web', prompt: 'fix it', expiresInHours: 4, senderPtyId: 'pty-mine',
    });
    expect(res.isError).toBeUndefined();
  });

  it('without pc it reads requests; a refusal is an error result with the refusal kept', async () => {
    mockSendRpc.mockResolvedValueOnce({ requests: [], places: [] });
    await tool({ spawn_id: 'sp-1' });
    expect(mockSendRpc).toHaveBeenLastCalledWith('a2a.remote.spawnStatus', { spawnId: 'sp-1' });
    // spawn_id reads even with pc given: a read never sends a request.
    mockSendRpc.mockResolvedValueOnce({ requests: [], places: [] });
    await tool({ pc: 'DESK', agent: 'claude', root: 'web', prompt: 'x', spawn_id: 'sp-2' });
    expect(mockSendRpc).toHaveBeenLastCalledWith('a2a.remote.spawnStatus', { spawnId: 'sp-2' });
    mockSendRpc.mockResolvedValueOnce({ ok: false, error: 'rate-limited', message: 'at most 3' });
    const res = await tool({ pc: 'DESK', agent: 'claude', root: 'web', prompt: 'again' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: false, error: 'rate-limited', message: 'at most 3' });
  });
});

describe('remote_answer', () => {
  let answer: ToolHandler;
  registerRemoteAnswerTool(
    { tool: (_n: string, _d: string, _s: unknown, h: ToolHandler) => { answer = h; } } as never,
    { getSenderPtyId: () => pty, resolveWorkspaceId: warmed },
  );

  it('answers through main with the verified ptyId, found before the call', async () => {
    mockSendRpc.mockResolvedValueOnce({ ok: true, taskId: 'rt-1', messageId: 'an-1' });
    const res = await answer({ task_id: 'rt-1', picker_id: '0123456789abcdef', option: 2 });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.remote.answer', { taskId: 'rt-1', pickerId: '0123456789abcdef', option: 2, senderPtyId: 'pty-mine' });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text)).toEqual({ ok: true, taskId: 'rt-1', messageId: 'an-1' });
  });

  it('its pipe method is first-party, so the bundled server is not held as unconfirmed', () => {
    expect(FIRST_PARTY_METHODS.has('a2a.remote.answer')).toBe(true);
  });

  it('a refusal is an error result, with its reason', async () => {
    mockSendRpc.mockResolvedValueOnce({ ok: false, error: { code: 'NOT_AUTHORIZED', message: 'run it from the pane that sent the task' } });
    const res = await answer({ task_id: 'rt-1', picker_id: '0123456789abcdef', option: 1 });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('NOT_AUTHORIZED');
  });
});

describe('remote_approve', () => {
  let approve: ToolHandler;
  let shape: Record<string, z.ZodTypeAny> = {};
  registerRemoteApproveTool(
    { tool: (_n: string, _d: string, s: Record<string, z.ZodTypeAny>, h: ToolHandler) => { shape = s; approve = h; } } as never,
    { getSenderPtyId: () => pty, resolveWorkspaceId: warmed },
  );

  it('takes a task id, a 16-hex prompt id and allow or deny; nothing else passes its schema', () => {
    const schema = z.object(shape).strict();
    expect(schema.safeParse({ task_id: 'rt-1', prompt_id: '0123456789abcdef', decision: 'allow' }).success).toBe(true);
    for (const bad of [
      { task_id: 'rt-1', prompt_id: '0123456789abcdef', decision: 'approve' },
      { task_id: 'rt-1', prompt_id: '0123456789ABCDEF', decision: 'deny' },
      { task_id: 'rt-1', prompt_id: 'p-1', decision: 'deny' },
      { task_id: 'rt-1', decision: 'deny' },
      { task_id: 'rt-1', prompt_id: '0123456789abcdef', decision: 'deny', option: 1 },
    ]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  });

  it('sends through main with the verified ptyId, found before the call, and a wait longer than the daemon\'s', async () => {
    mockSendRpc.mockResolvedValueOnce({ ok: true, taskId: 'rt-1', messageId: 'ap-1', outcome: { messageId: 'ap-1', outcome: 'done' } });
    const res = await approve({ task_id: 'rt-1', prompt_id: '0123456789abcdef', decision: 'deny' });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.remote.approve', { taskId: 'rt-1', promptId: '0123456789abcdef', decision: 'deny', senderPtyId: 'pty-mine' }, expect.any(Number));
    expect(mockSendRpc.mock.calls[0]![2]).toBeGreaterThan(10_000);
    expect(res.isError).toBeUndefined();
  });

  it('its pipe method is first-party; a refusal (deny-only) is an error result, with its reason', async () => {
    expect(FIRST_PARTY_METHODS.has('a2a.remote.approve')).toBe(true);
    mockSendRpc.mockResolvedValueOnce({ ok: false, error: 'deny-only', message: 'that PC takes only deny for this prompt; nothing was sent' });
    const res = await approve({ task_id: 'rt-1', prompt_id: '0123456789abcdef', decision: 'allow' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('deny-only');
  });
});
