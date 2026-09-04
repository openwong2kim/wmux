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
//  3. It exposes no repository input either — main derives the repo from the
//     caller's own workspace and REJECTS a supplied repoPath, so a schema field
//     would only produce calls that fail.
//  4. It maps snake_case tool args onto the wire's camelCase params without
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

function collectTools(
  getSenderPtyId: () => string,
  resolveWorkspaceId?: () => Promise<string>,
): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, schema: Record<string, unknown>, handler: ToolHandler) => {
      tools.set(name, handler);
      shapes.set(name, schema);
    },
  };
  registerFanOutTools(server as never, { getSenderPtyId, ...(resolveWorkspaceId && { resolveWorkspaceId }) });
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

  it('exposes no workspace, repository or member input (all server-derived)', () => {
    const shape = shapes.get('fanout_start') ?? {};
    for (const key of Object.keys(shape)) {
      expect(key).not.toMatch(/workspace|repo|member/i);
    }
  });

  it('exposes exactly the five inputs a caller may choose', () => {
    expect(Object.keys(shapes.get('fanout_start') ?? {}).sort()).toEqual([
      'idempotency_key',
      'prompt',
      'roles',
      'task_prompts',
      'titles',
    ]);
  });

  it('lets a caller pick a role but never an executable', () => {
    // `roles` is the one input that influences WHAT each task runs, so it is
    // the one that must not be free text: the agent command is interpolated
    // unquoted into a shell line downstream. A closed enum keeps "choose the
    // reviewer's agent" available while keeping "choose any command" out.
    const roles = (shapes.get('fanout_start') ?? {})['roles'] as
      | { safeParse: (v: unknown) => { success: boolean } }
      | undefined;
    expect(roles).toBeDefined();
    expect(roles?.safeParse(['Reviewer']).success).toBe(true);
    expect(roles?.safeParse(['claude --dangerously-skip-permissions']).success).toBe(false);
    expect(roles?.safeParse(['Builder; rm -rf /']).success).toBe(false);
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
    });
    expect(mockSendRpc).toHaveBeenCalledWith('task.fanout.start', {
      idempotencyKey: 'k1',
      titles: ['a', 'b'],
      prompt: 'shared',
      taskPrompts: ['pa', 'pb'],
      senderPtyId: 'pty-mine',
    });
  });

  it('omits optional params it was not given (rather than sending empties)', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, status: 'accepted', taskCount: 1 });
    await fanoutStart({ idempotency_key: 'k2', titles: ['only'] });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params).toEqual({ idempotencyKey: 'k2', titles: ['only'], senderPtyId: 'pty-mine' });
  });

  it('never forwards an agent command or a repo path, however they are passed', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, status: 'accepted', taskCount: 1 });
    await fanoutStart({
      idempotency_key: 'k3',
      titles: ['t'],
      agent_cmd: 'rm -rf /',
      agentCmd: 'rm -rf /',
      repo_path: '/elsewhere',
      repoPath: '/elsewhere',
    });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.agentCmd).toBeUndefined();
    expect(params.agent_cmd).toBeUndefined();
    expect(params.repoPath).toBeUndefined();
    expect(params.repo_path).toBeUndefined();
  });

  it('sends no senderPtyId when the walk missed (main then fails the call closed)', async () => {
    const missTools = collectTools(() => '');
    mockSendRpc.mockResolvedValue({ ok: false, error: { code: 'NOT_AUTHORIZED', message: 'no ptyId' } });
    const res = await missTools.get('fanout_start')!({ idempotency_key: 'k4', titles: ['t'] });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.senderPtyId).toBeUndefined();
    expect(res.isError).toBe(true);
  });

  // The walked ptyId is a side effect of the workspace lookup — nothing sets it
  // until something asks who the caller is. Every channel tool asks; this one
  // did not, so as the FIRST tool called on a fresh server it sent no
  // senderPtyId and main refused it as NOT_AUTHORIZED. Working only after some
  // unrelated tool happened to run first is not a property to ship.
  it('resolves identity BEFORE reading the ptyId, so a cold first call still carries one', async () => {
    let walked = false;
    const coldTools = collectTools(
      () => (walked ? 'pty-warm' : ''),
      async () => {
        walked = true;
        return 'ws-mine';
      },
    );
    mockSendRpc.mockResolvedValue({ ok: true, status: 'accepted' });
    await coldTools.get('fanout_start')!({ idempotency_key: 'k5', titles: ['t'] });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.senderPtyId).toBe('pty-warm');
    // The resolved workspace is NOT forwarded: main derives the owner from the
    // ptyId and rejects a caller-stated one.
    expect(params.workspaceId).toBeUndefined();
    expect(params.verifiedWorkspaceId).toBeUndefined();
  });

  it('still calls through when identity resolution throws, so main owns the refusal', async () => {
    const throwTools = collectTools(
      () => '',
      async () => {
        throw new Error('Workspace identity unknown');
      },
    );
    mockSendRpc.mockResolvedValue({ ok: false, error: { code: 'NOT_AUTHORIZED', message: 'no ptyId' } });
    const res = await throwTools.get('fanout_start')!({ idempotency_key: 'k6', titles: ['t'] });
    expect((mockSendRpc.mock.calls[0][1] as Record<string, unknown>).senderPtyId).toBeUndefined();
    expect(res.isError).toBe(true);
  });
});

describe('fanout_start: result envelope', () => {
  it('surfaces a typed rejection as isError with the code', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_AUTHORIZED', message: 'fan-out was not approved' },
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

  it('surfaces a terminal denial as isError so the caller stops polling', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      status: 'denied',
      reason: 'timeout',
      error: { code: 'NOT_AUTHORIZED', message: 'the fan-out approval prompt expired with no answer' },
    });
    const res = await fanoutStart({ idempotency_key: 'k8', titles: ['t'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('expired');
  });

  it('keeps status, reason and key on a denial instead of collapsing it to a message', async () => {
    // The whole point of the async contract is that an unattended caller can
    // tell WHY nothing ran. `Error [code]: message` dropped `status`, `reason`
    // and `idempotencyKey`, so "the user declined", "nobody was at the
    // keyboard" and "this key already ran" all read the same.
    for (const reason of ['declined', 'timeout', 'unavailable', 'repo-moved'] as const) {
      mockSendRpc.mockResolvedValue({
        ok: false,
        status: 'denied',
        reason,
        idempotencyKey: 'k8b',
        error: { code: 'NOT_AUTHORIZED', message: 'fan-out was not approved' },
      });
      const res = await fanoutStart({ idempotency_key: 'k8b', titles: ['t'] });
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text)).toMatchObject({
        status: 'denied',
        reason,
        idempotencyKey: 'k8b',
        error: { code: 'NOT_AUTHORIZED' },
      });
    }
  });

  it('distinguishes an aged-out key from a denial', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      status: 'expired',
      idempotencyKey: 'k8c',
      error: { code: 'NOT_FOUND', message: 'this fan-out already ran' },
    });
    const res = await fanoutStart({ idempotency_key: 'k8c', titles: ['t'] });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).status).toBe('expired');
  });

  it('hands back a completed poll whole, including partly-failed tasks', async () => {
    // A completed fan-out can be ok:false at the RESULT level while still
    // carrying the branches and worktree paths of the tasks that did spawn —
    // exactly what the caller needs to recover. The envelope stays ok:true.
    const result = {
      ok: false,
      tasks: [
        { index: 0, title: 'a', ok: true, branch: 'wtask/a', worktreePath: '/wt/a' },
        { index: 1, title: 'b', ok: false, error: 'worktree create failed' },
      ],
    };
    mockSendRpc.mockResolvedValue({ ok: true, status: 'completed', idempotencyKey: 'k9', result });
    const res = await fanoutStart({ idempotency_key: 'k9', titles: ['a', 'b'] });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text).result).toEqual(result);
  });

  it('reports a transport failure as isError rather than throwing', async () => {
    mockSendRpc.mockRejectedValue(new Error('RPC timeout'));
    const res = await fanoutStart({ idempotency_key: 'k7', titles: ['t'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('RPC timeout');
  });
});

// Wave 3, finding 12 — a fan-out from a workspace with an unanswered decision
// runs fine and reports to nobody. The accept carries `warnings`; a JSON key is
// skippable, so it also leads the content as its own WARNING block.
describe('fanout_start: accept warnings', () => {
  it('leads with a WARNING block and keeps the envelope as the last block, parseable', async () => {
    mockSendRpc.mockResolvedValue({
      ok: true,
      status: 'accepted',
      taskCount: 1,
      warnings: ['owner workspace ws-1 has a pending decision dec-9; worker events will not wake the brain until it is answered'],
    });
    const res = await fanoutStart({ idempotency_key: 'kw1', titles: ['t'] });
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(2);
    expect(res.content[0].text.startsWith('WARNING: owner workspace ws-1 has a pending decision dec-9')).toBe(true);
    expect(JSON.parse(res.content[res.content.length - 1].text)).toMatchObject({ status: 'accepted' });
  });

  it('adds no block when there are no warnings, or when the field is malformed', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, status: 'accepted' });
    expect((await fanoutStart({ idempotency_key: 'kw2', titles: ['t'] })).content).toHaveLength(1);

    mockSendRpc.mockResolvedValue({ ok: true, status: 'accepted', warnings: 'nope' });
    expect((await fanoutStart({ idempotency_key: 'kw3', titles: ['t'] })).content).toHaveLength(1);

    mockSendRpc.mockResolvedValue({ ok: true, status: 'accepted', warnings: ['', '  ', 7] });
    expect((await fanoutStart({ idempotency_key: 'kw4', titles: ['t'] })).content).toHaveLength(1);
  });
});
