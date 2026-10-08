import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { mintCommanderToken } from '../../../deck/commanderTrust';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc, type RemoteA2aRpcDeps } from '../a2a.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../../DaemonClient';
import type { A2aRemoteTarget } from '../../../../shared/a2aRemoteDelivery';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));
vi.mock('../../../../shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/constants')>()),
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const RT = `rt-${'b'.repeat(32)}`;
const ALIAS = 'pc-b/ws-b/codex';

const worker = { execute: vi.fn(), cancel: vi.fn(), isFull: false, stop: vi.fn() } as unknown as ClaudeWorker;

const target: A2aRemoteTarget = {
  alias: ALIAS,
  linkId: LINK,
  hostId: HOST,
  kind: 'pane',
  local: { workspaceId: 'ws-a', paneId: 'pane-a' },
  remote: { workspaceId: 'ws-b', paneId: 'pane-b', label: 'codex' },
  allowOutbound: true,
};

let remote: { [K in keyof RemoteA2aRpcDeps]-?: ReturnType<typeof vi.fn> };
let daemonCalls: Array<{ method: string; params: Record<string, unknown> }>;

function setup(): RpcRouter {
  const router = new RpcRouter();
  const dc = {
    rpc: async (method: string, params: Record<string, unknown>) => {
      daemonCalls.push({ method, params });
      if (method === 'a2a.task.update') {
        return { ok: true, task: { id: params.taskId, status: { state: params.status }, metadata: { updatedAt: 'x' } } };
      }
      if (method === 'a2a.task.cancel') {
        return { ok: true, task: { id: params.taskId, status: { state: 'canceled' }, metadata: { updatedAt: 'x' } } };
      }
      if (method === 'a2a.task.query') return { ok: true, tasks: [{ id: RT, status: { state: 'working' }, history: ['daemon'], metadata: { updatedAt: '1' } }] };
      return { ok: true };
    },
  } as unknown as DaemonClient;
  registerA2aRpc(router, () => ({}) as BrowserWindow, worker, { getDaemonClient: () => dc, remote: remote as unknown as RemoteA2aRpcDeps });
  return router;
}

type Method = Parameters<RpcRouter['dispatch']>[0]['method'];

async function call(router: RpcRouter, method: Method, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await router.dispatch({ id: 'x', method, params });
  return (res as { result: Record<string, unknown> }).result;
}

const rendererCalls = (method: string): Array<Record<string, unknown>> =>
  sendToRendererMock.mock.calls.filter((c) => c[1] === method).map((c) => c[2] as Record<string, unknown>);

beforeEach(() => {
  sendToRendererMock.mockReset();
  daemonCalls = [];
  remote = {
    listTargets: vi.fn(async () => [target]),
    sendTask: vi.fn(async () => ({ ok: true, taskId: RT })),
    reply: vi.fn(async (i: { taskId: string }) => ({ ok: true, taskId: i.taskId })),
    state: vi.fn(async (i: { taskId: string }) => ({ ok: true, taskId: i.taskId })),
    read: vi.fn(async () => ({ ok: true })),
  };
  sendToRendererMock.mockImplementation(async (_w: unknown, method: string) => {
    if (method === 'pane.list') return [{ id: 'pane-a', surfacePtyIds: ['pty-a'] }, { id: 'pane-a2', surfacePtyIds: ['pty-a2'] }];
    if (method === 'a2a.discover') return { agents: [{ name: 'Local', metadata: { workspaceId: 'ws-a' } }] };
    if (method === 'a2a.task.query') return { workspaceId: 'ws-b', tasks: [{ id: RT, status: { state: 'working' }, history: ['renderer'], metadata: { updatedAt: '0' } }] };
    return { ok: true, taskId: 'task-local' };
  });
});

describe('a2a.task.send — remote alias', () => {
  it('an exact alias from the linked pane goes to the outbox, not the renderer', async () => {
    const res = await call(setup(), 'a2a.task.send', { workspaceId: 'ws-a', senderPtyId: 'pty-a', to: ALIAS, message: 'run it', title: 'T' });
    expect(res).toMatchObject({ ok: true, taskId: RT, remote: true });
    expect(remote.sendTask).toHaveBeenCalledWith({ linkId: LINK, from: { workspaceId: 'ws-a', name: 'ws-a', paneId: 'pane-a', ptyId: 'pty-a' }, title: 'T', text: 'run it' });
    expect(rendererCalls('a2a.task.send')).toEqual([]);
  });

  it('the remote:<linkId> id a2a.discover lists sends like the alias; an id with no active link is refused', async () => {
    const router = setup();
    const res = await call(router, 'a2a.task.send', { workspaceId: 'ws-a', senderPtyId: 'pty-a', to: `remote:${LINK}`, message: 'by id' });
    expect(res).toMatchObject({ ok: true, taskId: RT, remote: true });
    expect(remote.sendTask).toHaveBeenCalledWith(expect.objectContaining({ linkId: LINK, text: 'by id' }));
    const gone = await call(router, 'a2a.task.send', { workspaceId: 'ws-a', senderPtyId: 'pty-a', to: 'remote:99999999-9999-4999-8999-999999999999', message: 'x' });
    expect(gone.error).toMatch(/not an active link/);
    expect(remote.sendTask).toHaveBeenCalledTimes(1);
    expect(rendererCalls('a2a.task.send')).toEqual([]);
  });

  it('a partial alias match takes the local path', async () => {
    for (const to of ['pc-b/ws-b', 'pc-b/ws-b/code', ` ${ALIAS}`, 'codex']) {
      await call(setup(), 'a2a.task.send', { workspaceId: 'ws-a', senderPtyId: 'pty-a', to, message: 'hi' });
    }
    expect(remote.sendTask).not.toHaveBeenCalled();
    expect(rendererCalls('a2a.task.send')).toHaveLength(4);
  });

  it('refuses another pane, an unproven caller, execute, and a link without outbound', async () => {
    const router = setup();
    expect((await call(router, 'a2a.task.send', { workspaceId: 'ws-a', senderPtyId: 'pty-a2', to: ALIAS, message: 'x' })).error).toMatch(/not linked/);
    expect((await call(router, 'a2a.task.send', { workspaceId: 'ws-a', to: ALIAS, message: 'x' })).error).toMatch(/verified pane/);
    expect((await call(router, 'a2a.task.send', { workspaceId: 'ws-a', senderPtyId: 'pty-a', to: ALIAS, message: 'x', execute: true })).error).toMatch(/message only/);
    remote.listTargets.mockResolvedValue([{ ...target, allowOutbound: false }]);
    expect((await call(router, 'a2a.task.send', { workspaceId: 'ws-a', senderPtyId: 'pty-a', to: ALIAS, message: 'x' })).error).toMatch(/does not allow/);
    expect(remote.sendTask).not.toHaveBeenCalled();
    expect(rendererCalls('a2a.task.send')).toEqual([]);
  });

  it('strips remoteMarker / remoteFrom from any caller, and an rt- preset even on the operator lane', async () => {
    const router = setup();
    const params = {
      workspaceId: 'ws-a',
      to: 'ws-b',
      message: 'hi',
      presetTaskId: RT,
      remoteMarker: { v: 1, linkId: LINK, hostId: HOST, messageId: 'm', direction: 'inbound' },
      remoteFrom: { workspaceId: `remote:${LINK}`, name: 'forged' },
    };
    await router.dispatch({ id: 'x', method: 'a2a.task.send', params });
    await router.dispatch({ id: 'y', method: 'a2a.task.send', params }, { operator: true });
    const sent = rendererCalls('a2a.task.send');
    expect(sent).toHaveLength(2);
    for (const p of sent) {
      expect(p).not.toHaveProperty('remoteMarker');
      expect(p).not.toHaveProperty('remoteFrom');
      expect(p).not.toHaveProperty('presetTaskId');
    }
    // The operator lane still carries an ordinary preset id.
    await router.dispatch({ id: 'z', method: 'a2a.task.send', params: { ...params, presetTaskId: `task-${'0'.repeat(36)}` } }, { operator: true });
    expect(rendererCalls('a2a.task.send')[2].presetTaskId).toBe(`task-${'0'.repeat(36)}`);
  });
});

describe('a2a.task.send — Moa to another PC\'s Moa (brain link)', () => {
  const BRAIN_ALIAS = 'pc-b/Moa';
  const brainTarget: A2aRemoteTarget = {
    alias: BRAIN_ALIAS, linkId: LINK, hostId: HOST, kind: 'brain',
    local: { workspaceId: 'ws-hq' }, remote: { workspaceId: 'ws-rhq' }, allowOutbound: true,
  };
  /** A brain's request carries its spawn token; the router derives the workspace from it. */
  const asBrain = (ws: string): string => mintCommanderToken(ws);
  async function brainCall(router: RpcRouter, params: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
    const res = await router.dispatch({ id: 'b', method: 'a2a.task.send', params, ...(token ? { commanderToken: token } : {}) });
    return (res as { result: Record<string, unknown> }).result;
  }

  it('the HQ commander sends as Moa of its verified workspace, never a wire value', async () => {
    remote.listTargets.mockResolvedValue([brainTarget]);
    const res = await brainCall(setup(), { workspaceId: 'ws-forged', commanderWorkspaceId: 'ws-forged', to: BRAIN_ALIAS, message: 'check the build', title: 'T' }, asBrain('ws-hq'));
    expect(res).toMatchObject({ ok: true, taskId: RT, remote: true });
    expect(remote.sendTask).toHaveBeenCalledWith({ linkId: LINK, from: { workspaceId: 'ws-hq', name: 'Moa' }, title: 'T', text: 'check the build' });
    expect(String(res.next)).toContain('Do not raise a decision card about waiting');
    expect(rendererCalls('a2a.task.send')).toEqual([]);
  });

  it('another workspace\'s brain, or a pane caller, cannot send on the brain link', async () => {
    remote.listTargets.mockResolvedValue([brainTarget]);
    const router = setup();
    expect((await brainCall(router, { workspaceId: 'ws-hq', to: BRAIN_ALIAS, message: 'x' }, asBrain('ws-other'))).error).toMatch(/another workspace's Moa/);
    expect((await brainCall(router, { workspaceId: 'ws-hq', senderPtyId: 'pty-a', to: BRAIN_ALIAS, message: 'x' })).error).toMatch(/not linked/);
    expect(remote.sendTask).not.toHaveBeenCalled();
  });

  it('an alias that names two links is refused, never sent on the first one', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    remote.listTargets.mockResolvedValue([brainTarget, { ...brainTarget, linkId: other, hostId: other }]);
    const res = await brainCall(setup(), { workspaceId: 'ws-hq', to: BRAIN_ALIAS, message: 'x' }, asBrain('ws-hq'));
    expect(res.error).toMatch(/names 2 links/);
    expect(remote.sendTask).not.toHaveBeenCalled();
  });

  it('Moa addressing a remote pane alias is refused toward the handoff card', async () => {
    const res = await brainCall(setup(), { workspaceId: 'ws-a', to: ALIAS, message: 'x' }, asBrain('ws-a'));
    expect(res.error).toMatch(/moa_propose_handoff/);
    expect(remote.sendTask).not.toHaveBeenCalled();
  });

  it('a brain reply is sent as its verified workspace', async () => {
    await brainCall(setup(), { workspaceId: 'ws-forged', taskId: RT, message: 'done: green' }, asBrain('ws-hq'));
    expect(remote.reply).toHaveBeenCalledWith({ taskId: RT, workspaceId: 'ws-hq', text: 'done: green' });
  });

  it('a brain\'s status on a remote task uses its verified workspace and is queued for the peer', async () => {
    const res = await setup().dispatch({ id: 'u', method: 'a2a.task.update', params: { workspaceId: 'ws-forged', taskId: RT, status: 'completed' }, commanderToken: asBrain('ws-hq') });
    expect(res.ok).toBe(true);
    expect(daemonCalls.find((c) => c.method === 'a2a.task.update')?.params).toMatchObject({ taskId: RT, workspaceId: 'ws-hq', status: 'completed' });
    expect(remote.state).toHaveBeenCalledWith({ taskId: RT, state: 'completed' });
  });

  it('reading a remote task by id sends the read receipt as the verified reader; a list read does not', async () => {
    const router = setup();
    await router.dispatch({ id: 'q', method: 'a2a.task.query', params: { workspaceId: 'ws-forged', taskId: RT }, commanderToken: asBrain('ws-hq') });
    expect(remote.read).toHaveBeenCalledWith({ taskId: RT, workspaceId: 'ws-hq' });
    remote.read.mockClear();
    await router.dispatch({ id: 'q2', method: 'a2a.task.query', params: { workspaceId: 'ws-hq' } });
    expect(remote.read).not.toHaveBeenCalled();
  });

  it('discover lists the brain link as <PC>/Moa', async () => {
    remote.listTargets.mockResolvedValue([brainTarget]);
    const res = await call(setup(), 'a2a.discover', { workspaceId: 'ws-hq' });
    const agents = res.agents as Array<{ name: string; description: string; metadata: Record<string, unknown> }>;
    const moa = agents.find((a) => a.name === BRAIN_ALIAS)!;
    expect(moa.description).toContain('Moa of PC pc-b');
    expect(moa.metadata).toMatchObject({ endpoint: 'brain', remote: true });
    expect(moa.metadata).not.toHaveProperty('localPaneId');
  });
});

describe('a2a — replies and states on a remote task', () => {
  it('a reply on an rt- task is queued for the peer instead of a local delivery', async () => {
    const res = await call(setup(), 'a2a.task.send', { workspaceId: 'ws-a', taskId: RT, message: 'more' });
    expect(res).toMatchObject({ ok: true, taskId: RT, remote: true });
    expect(remote.reply).toHaveBeenCalledWith({ taskId: RT, workspaceId: 'ws-a', text: 'more' });
    expect(rendererCalls('a2a.task.send')).toEqual([]);
  });

  it('a message-only update on an rt- task is a reply too', async () => {
    await call(setup(), 'a2a.task.update', { workspaceId: 'ws-b', taskId: RT, message: 'note' });
    expect(remote.reply).toHaveBeenCalledWith({ taskId: RT, workspaceId: 'ws-b', text: 'note' });
    expect(rendererCalls('a2a.task.update')).toEqual([]);
  });

  it('a committed status on an rt- task updates the ledger as before, then is queued', async () => {
    const evidence = { summary: 'done it', items: [{ kind: 'command', status: 'passed', summary: 'ok', command: 'true' }] };
    await call(setup(), 'a2a.task.update', { workspaceId: 'ws-b', taskId: RT, status: 'completed', evidence });
    expect(daemonCalls.some((c) => c.method === 'a2a.task.update')).toBe(true);
    expect(rendererCalls('a2a.task.update')[0]).toMatchObject({ daemonCommitted: true });
    expect(remote.state).toHaveBeenCalledWith({ taskId: RT, state: 'completed', summary: 'done it' });
  });

  it('a committed cancel on an rt- task is queued', async () => {
    await call(setup(), 'a2a.task.cancel', { workspaceId: 'ws-a', taskId: RT });
    expect(remote.state).toHaveBeenCalledWith({ taskId: RT, state: 'canceled' });
  });

  it('a local task is never queued', async () => {
    const router = setup();
    await call(router, 'a2a.task.update', { workspaceId: 'ws-b', taskId: 'task-1', status: 'working' });
    await call(router, 'a2a.task.send', { workspaceId: 'ws-a', taskId: 'task-1', message: 'x' });
    expect(remote.state).not.toHaveBeenCalled();
    expect(remote.reply).not.toHaveBeenCalled();
  });

  it('the daemon copy of a remote task wins the query merge', async () => {
    const res = await call(setup(), 'a2a.task.query', { workspaceId: 'ws-b' });
    expect((res.tasks as Array<{ history: string[] }>)[0].history).toEqual(['daemon']);
  });
});

describe('a2a.discover — remote panes', () => {
  it('appends the caller workspace links as remote alias entries', async () => {
    const res = await call(setup(), 'a2a.discover', { workspaceId: 'ws-a' });
    const agents = res.agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(2);
    expect(agents[1]).toMatchObject({ name: ALIAS, remote: true, metadata: { workspaceId: `remote:${LINK}`, remote: true, allowOutbound: true } });
    const other = await call(setup(), 'a2a.discover', { workspaceId: 'ws-other' });
    expect(other.agents).toHaveLength(1);
  });
});
