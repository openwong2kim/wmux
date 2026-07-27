// Tests for the `fanout_start` MCP tool.
//
// The tool is a thin pass-through over `task.fanout.start` — the trust boundary
// itself lives main-side (src/main/pipe/handlers/fanout.rpc.ts, tested in
// fanout.rpc.test.ts). What matters HERE is the tool's shape:
//
//  1. It exposes no agent-command input. A schema field would invite callers to
//     send a value that main ignores — and would read as if choosing the agent
//     were supported.
//  2. It attaches the server's verified senderPtyId, which is the entire
//     identity basis main uses to pick the owning workspace AND the repository.
//  3. It maps snake_case tool args onto the wire's camelCase params without
//     inventing any.

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../wmux-client', () => ({
  sendRpc: vi.fn(),
  setClientIdentity: vi.fn(),
  clearClientIdentity: vi.fn(),
}));

import { sendRpc } from '../wmux-client';
import { registerFanOutTools } from '../fanout';
import { FIRST_PARTY_METHODS } from '../../main/mcp/firstParty';

const mockSendRpc = sendRpc as unknown as ReturnType<typeof vi.fn>;

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const shapes = new Map<string, Record<string, unknown>>();

function collectTools(getSenderPtyId: () => string): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, schema: Record<string, unknown>, handler: ToolHandler) => {
      tools.set(name, handler);
      shapes.set(name, schema);
    },
  };
  registerFanOutTools(server as never, { getSenderPtyId });
  return tools;
}

const tools = collectTools(() => 'pty-mine');
const fanoutStart = tools.get('fanout_start');
if (!fanoutStart) throw new Error('fanout_start failed to register');

beforeEach(() => {
  mockSendRpc.mockReset();
});

describe('fanout_start: tool surface', () => {
  it('registers', () => {
    expect(fanoutStart).toBeDefined();
  });

  it('exposes NO agent-command input', () => {
    const shape = shapes.get('fanout_start') ?? {};
    for (const key of Object.keys(shape)) {
      expect(key).not.toMatch(/agent|cmd|command/i);
    }
  });

  it('exposes no workspace input either (identity is server-derived)', () => {
    const shape = shapes.get('fanout_start') ?? {};
    for (const key of Object.keys(shape)) {
      expect(key).not.toMatch(/workspace/i);
    }
  });

  it('is on the first-party allowlist (or it deadlocks under enforce mode)', () => {
    expect(FIRST_PARTY_METHODS.has('task.fanout.start')).toBe(true);
  });
});

describe('fanout_start: request mapping', () => {
  it('maps snake_case args onto the wire params and attaches the verified ptyId', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, status: 'accepted', taskCount: 2 });
    await fanoutStart({
      idempotency_key: 'k1',
      titles: ['a', 'b'],
      prompt: 'shared',
      task_prompts: ['pa', 'pb'],
      repo_path: '/repo',
    });
    expect(mockSendRpc).toHaveBeenCalledWith('task.fanout.start', {
      idempotencyKey: 'k1',
      titles: ['a', 'b'],
      prompt: 'shared',
      taskPrompts: ['pa', 'pb'],
      repoPath: '/repo',
      senderPtyId: 'pty-mine',
    });
  });

  it('omits optional params it was not given (rather than sending empties)', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, status: 'accepted', taskCount: 1 });
    await fanoutStart({ idempotency_key: 'k2', titles: ['only'] });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params).toEqual({ idempotencyKey: 'k2', titles: ['only'], senderPtyId: 'pty-mine' });
  });

  it('never forwards an agent command even if one is somehow passed through', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, status: 'accepted', taskCount: 1 });
    await fanoutStart({ idempotency_key: 'k3', titles: ['t'], agent_cmd: 'rm -rf /', agentCmd: 'rm -rf /' });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.agentCmd).toBeUndefined();
    expect(params.agent_cmd).toBeUndefined();
  });

  it('sends no senderPtyId when the walk missed (main then fails the call closed)', async () => {
    const missTools = collectTools(() => '');
    mockSendRpc.mockResolvedValue({ ok: false, error: { code: 'NOT_AUTHORIZED', message: 'no ptyId' } });
    const res = await missTools.get('fanout_start')!({ idempotency_key: 'k4', titles: ['t'] });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.senderPtyId).toBeUndefined();
    expect(res.isError).toBe(true);
  });
});

describe('fanout_start: result envelope', () => {
  it('surfaces a typed rejection as isError with the code', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_AUTHORIZED', message: 'repoPath must resolve to your own repository' },
    });
    const res = await fanoutStart({ idempotency_key: 'k5', titles: ['t'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('NOT_AUTHORIZED');
  });

  it('returns the accepted envelope verbatim on success', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, status: 'accepted', idempotencyKey: 'k6', taskCount: 3 });
    const res = await fanoutStart({ idempotency_key: 'k6', titles: ['a', 'b', 'c'] });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toMatchObject({ status: 'accepted', taskCount: 3 });
  });

  it('reports a transport failure as isError rather than throwing', async () => {
    mockSendRpc.mockRejectedValue(new Error('RPC timeout'));
    const res = await fanoutStart({ idempotency_key: 'k7', titles: ['t'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('RPC timeout');
  });
});
