// A2A task calls take the caller's workspace from the server side
// (a2aCaller.ts): each lane that reaches main's task handlers passes when it
// names its own workspace and is refused when it names another.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../../RpcRouter';
import type { RpcContext } from '../../../../shared/rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';
import { registerA2aRpc } from '../a2a.rpc';
import { a2aCallerWorkspace } from '../a2aCaller';

/** Which workspace owns each pty, as the renderer answers it. */
const OWNERS: Record<string, string> = { 'pty-a': 'ws-a', 'pty-b': 'ws-b' };

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));

const win = () => ({}) as BrowserWindow;
/** The MCP server's lane: a pipe call, no provenance marker. */
const wire: RpcContext = { origin: 'local' };

// The words the MCP server re-resolves a stale cached workspace on (src/mcp/index.ts isStaleIdentityResult).
const STALE_IDENTITY = /no workspace found|not owned by workspace|the workspace you claimed is gone/i;

beforeEach(() => {
  sendToRendererMock.mockReset();
  sendToRendererMock.mockImplementation(async (_win: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'input.findOwnerWorkspace') return { workspaceId: OWNERS[params.ptyId as string] ?? null };
    if (method === 'pane.list') return [];
    return { ok: true, taskId: 'task-1', tasks: [] };
  });
});

describe('a2aCallerWorkspace', () => {
  const caller = (params: Record<string, unknown>, ctx: RpcContext | undefined) =>
    a2aCallerWorkspace(win, 'a2a.task.cancel', params, ctx);

  it('a pane agent: its own workspace from its pty, another refused', async () => {
    expect(await caller({ workspaceId: 'ws-a', senderPtyId: 'pty-a' }, wire)).toEqual({ ok: true, trusted: false, workspaceId: 'ws-a' });
    const spoofed = await caller({ workspaceId: 'ws-b', senderPtyId: 'pty-a' }, wire);
    expect(spoofed).toMatchObject({ ok: false });
    expect((spoofed as { error: string }).error).toMatch(STALE_IDENTITY);
  });

  it('a query from the MCP tool: the pty on the envelope', async () => {
    expect(await caller({ workspaceId: 'ws-a' }, { ...wire, callerPtyId: 'pty-a' })).toMatchObject({ ok: true, workspaceId: 'ws-a' });
    expect(await caller({ workspaceId: 'ws-b' }, { ...wire, callerPtyId: 'pty-a' })).toMatchObject({ ok: false });
  });

  it('refuses a caller nothing identifies, or whose pty no workspace owns', async () => {
    for (const params of [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-a', senderPtyId: 'pty-gone' }]) {
      const result = await caller(params, wire);
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toMatch(STALE_IDENTITY);
    }
    expect(await caller({ workspaceId: 'ws-a', senderPtyId: 'pty-a' }, undefined)).toMatchObject({ ok: true, workspaceId: 'ws-a' });
  });

  it('a workspace claim main issued wins over the named one', async () => {
    const claimed: RpcContext = { ...wire, workspaceClaim: { kind: 'bound', workspaceId: 'ws-a' } };
    expect(await caller({ workspaceId: 'ws-a' }, claimed)).toMatchObject({ ok: true, workspaceId: 'ws-a' });
    expect(await caller({ workspaceId: 'ws-b', senderPtyId: 'pty-b' }, claimed)).toMatchObject({ ok: false });
    const stale = await caller({ workspaceId: 'ws-a', senderPtyId: 'pty-a' }, { ...wire, workspaceClaim: { kind: 'stale' } });
    expect((stale as { error: string }).error).toMatch(STALE_IDENTITY);
  });

  it('a commander (deck brain): its token workspace, even with a pty no workspace owns', async () => {
    const brain: RpcContext = { ...wire, commanderWorkspace: 'ws-a' };
    expect(await caller({ workspaceId: 'ws-a', senderPtyId: 'pty-brain' }, brain)).toMatchObject({ ok: true, workspaceId: 'ws-a' });
    expect(await caller({}, brain)).toMatchObject({ ok: true, workspaceId: 'ws-a' });
    expect(await caller({ workspaceId: 'ws-b', senderPtyId: 'pty-b' }, brain)).toMatchObject({ ok: false });
  });

  it('a plugin host call: its bound workspace, and none when it has no binding', async () => {
    const hosted: RpcContext = { ...wire, firstParty: true, hostedWorkspace: 'ws-a' };
    expect(await caller({ workspaceId: 'ws-a' }, hosted)).toMatchObject({ ok: true, workspaceId: 'ws-a' });
    expect(await caller({ workspaceId: 'ws-b', senderPtyId: 'pty-b' }, hosted)).toMatchObject({ ok: false });
    expect(await caller({ workspaceId: 'ws-a', senderPtyId: 'pty-a' }, { ...wire, firstParty: true, hostedWorkspace: null })).toMatchObject({ ok: false });
  });

  it('a plugin host call is held to its binding even with a commander workspace', async () => {
    const both = (hostedWorkspace: string | null): RpcContext => ({ ...wire, firstParty: true, hostedWorkspace, commanderWorkspace: 'ws-b' });
    expect(await caller({ workspaceId: 'ws-b' }, both(null))).toMatchObject({ ok: false });
    expect(await caller({ workspaceId: 'ws-b' }, both('ws-a'))).toMatchObject({ ok: false });
    expect(await caller({ workspaceId: 'ws-a' }, both('ws-a'))).toMatchObject({ ok: true, workspaceId: 'ws-a' });
  });

  it('main itself still names the workspace: the operator lane and in-process first party', async () => {
    expect(await caller({ workspaceId: 'ws-human' }, { ...wire, operator: true, firstParty: true })).toEqual({ ok: true, trusted: true });
    expect(await caller({ workspaceId: 'ws-b' }, { ...wire, firstParty: true })).toEqual({ ok: true, trusted: true });
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });
});

describe('the task handlers', () => {
  type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;
  const daemonCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const handlers = new Map<string, Handler>();
  const daemon = {
    rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      daemonCalls.push({ method, params });
      return { ok: true, tasks: [], task: { id: 'task-1', status: { state: 'canceled' } } };
    }),
  } as unknown as DaemonClient;
  registerA2aRpc(
    { register: (method: string, fn: Handler) => handlers.set(method, fn) } as unknown as RpcRouter,
    win,
    { execute: vi.fn(), cancel: vi.fn(), isFull: false, stop: vi.fn() } as unknown as ClaudeWorker,
    { getDaemonClient: () => daemon },
  );
  const call = (method: string, params: Record<string, unknown>, ctx: RpcContext = wire) => (handlers.get(method) ?? (() => { throw new Error(`${method} is not registered`); }))(params, ctx);

  beforeEach(() => { daemonCalls.length = 0; });

  it.each([
    ['a2a.task.cancel', { taskId: 'task-1' }],
    ['a2a.task.update', { taskId: 'task-1', status: 'completed' }],
    ['a2a.task.query', {}],
  ])('%s acts as the pane\'s own workspace and refuses another', async (method, extra) => {
    await call(method, { ...extra, workspaceId: 'ws-a', senderPtyId: 'pty-a' });
    expect(daemonCalls.find((c) => c.method === method)?.params.workspaceId).toBe('ws-a');

    daemonCalls.length = 0;
    const refused = await call(method, { ...extra, workspaceId: 'ws-b', senderPtyId: 'pty-a' });
    expect(refused).toMatchObject({ error: expect.stringMatching(STALE_IDENTITY) });
    expect(daemonCalls).toEqual([]);
  });

  it('a2a.task.send sends as the pane\'s own workspace and refuses another', async () => {
    const refused = await call('a2a.task.send', { workspaceId: 'ws-b', senderPtyId: 'pty-a', to: 'ws-a', message: 'hi' });
    expect(refused).toMatchObject({ error: expect.stringMatching(STALE_IDENTITY) });
    expect(sendToRendererMock.mock.calls.some((c) => c[1] === 'a2a.task.send')).toBe(false);

    await call('a2a.task.send', { workspaceId: 'ws-a', senderPtyId: 'pty-a', to: 'ws-b', message: 'hi' });
    const sent = sendToRendererMock.mock.calls.find((c) => c[1] === 'a2a.task.send');
    expect(sent?.[2]).toMatchObject({ workspaceId: 'ws-a' });
  });

  it('a commander that names no workspace acts as its token\'s', async () => {
    await call('a2a.task.cancel', { taskId: 'task-1' }, { ...wire, commanderWorkspace: 'ws-a' });
    expect(daemonCalls.find((c) => c.method === 'a2a.task.cancel')?.params.workspaceId).toBe('ws-a');
  });

  it('a2a.broadcast goes out under the pane\'s own workspace and refuses another', async () => {
    const refused = await call('a2a.broadcast', { workspaceId: 'ws-b', message: 'hi' }, { ...wire, callerPtyId: 'pty-a' });
    expect(refused).toMatchObject({ error: expect.stringMatching(STALE_IDENTITY) });
    expect(sendToRendererMock.mock.calls.some((c) => c[1] === 'a2a.broadcast')).toBe(false);

    await call('a2a.broadcast', { workspaceId: 'ws-a', message: 'hi' }, { ...wire, callerPtyId: 'pty-a' });
    expect(sendToRendererMock.mock.calls.find((c) => c[1] === 'a2a.broadcast')?.[2]).toMatchObject({ workspaceId: 'ws-a' });
  });

  it('the operator lane still acts as the workspace it names', async () => {
    await call('a2a.task.cancel', { taskId: 'task-1', workspaceId: 'ws-human' }, { ...wire, operator: true, firstParty: true });
    expect(daemonCalls.find((c) => c.method === 'a2a.task.cancel')?.params.workspaceId).toBe('ws-human');
  });
});

describe('every A2A method that acts as a workspace is registered through the caller check', () => {
  const dir = path.join(__dirname, '..');
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')] as const);

  it('no a2a.task.* method or a2a.broadcast is registered around it', () => {
    for (const [file, text] of sources) {
      expect(text.match(/\.register\(\s*'a2a\.(?:task\.[a-z]+|broadcast)'/g) ?? [], file).toEqual([]);
    }
  });

  it('the guarded methods are the task log\'s and the broadcast', () => {
    const text = sources.find(([f]) => f === 'a2a.rpc.ts')?.[1] ?? '';
    const guarded = [...text.matchAll(/registerAsCaller\(\s*'([^']+)'/g)].map((m) => m[1]).sort();
    expect(guarded).toEqual(['a2a.broadcast', 'a2a.task.cancel', 'a2a.task.query', 'a2a.task.send', 'a2a.task.update']);
  });
});
