import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../wmux-client', () => ({
  sendRpc: vi.fn(),
  setClientIdentity: vi.fn(),
  clearClientIdentity: vi.fn(),
}));

import { sendRpc } from '../wmux-client';
import { registerRemoteAnswerTool, registerRemoteSpawnTools } from '../remoteSpawn';

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

  it('a refusal is an error result, with its reason', async () => {
    mockSendRpc.mockResolvedValueOnce({ ok: false, error: { code: 'NOT_AUTHORIZED', message: 'run it from the pane that sent the task' } });
    const res = await answer({ task_id: 'rt-1', picker_id: '0123456789abcdef', option: 1 });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('NOT_AUTHORIZED');
  });
});
