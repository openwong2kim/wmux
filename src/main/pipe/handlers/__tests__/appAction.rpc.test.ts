// `app.action` in main: who the caller is, whether the call is well formed,
// and the refusals main answers itself, before or instead of the renderer.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../../RpcRouter';
import { RpcRouter as RealRouter } from '../../RpcRouter';
import type { RpcContext } from '../../../../shared/rpc';
import { APP_ACTIONS } from '../../../../shared/appActions';
import { SHARED_SURFACE, botSurfaceRefusal } from '../../../../shared/botSurface';
import { COMMANDER_RPC_METHODS } from '../../../../shared/commanderSurface';
import { WORKER_FENCE_REFUSED_RPC } from '../../../../shared/botWorkerGuard';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

import { registerAppActionRpc } from '../appAction.rpc';

type Handler = (params: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>;

const OWNERS: Record<string, string> = { 'pty-a': 'ws-a', 'pty-b': 'ws-b' };

let win: { isDestroyed: () => boolean } | null;
let handlers: Map<string, Handler>;

function setup(deps: Parameters<typeof registerAppActionRpc>[2] = {}): void {
  handlers = new Map();
  const router = { register: (m: string, h: Handler) => handlers.set(m, h) } as unknown as RpcRouter;
  registerAppActionRpc(router, () => win as unknown as BrowserWindow, deps);
}

const run = (params: Record<string, unknown>, ctx?: RpcContext) => handlers.get('app.action')!(params, ctx);

/** A pane that claimed its workspace (the CLI's walk): main's own record. */
const claimed = (workspaceId = 'ws-a', ptyId = 'pty-a'): RpcContext => ({
  origin: 'local',
  externalWire: true,
  clientName: 'wmux-cli',
  workspaceClaim: { kind: 'bound', workspaceId, ptyId },
});

beforeEach(() => {
  win = { isDestroyed: () => false };
  sendToRendererMock.mockReset();
  sendToRendererMock.mockImplementation(async (_w: unknown, method: string, params: Record<string, unknown>) => {
    if (method === 'input.findOwnerWorkspace') return { workspaceId: OWNERS[params.ptyId as string] ?? null };
    return { ok: true, echoed: params };
  });
  setup();
});

const rendererCalls = () => sendToRendererMock.mock.calls.filter((c) => c[1] === 'app.action');

describe('app.action.list', () => {
  it('lists every action with its target kind and arguments', async () => {
    const res = (await handlers.get('app.action.list')!({}, { origin: 'local' })) as { ok: boolean; actions: { id: string }[] };
    expect(res.ok).toBe(true);
    expect(res.actions.map((a) => a.id)).toEqual(APP_ACTIONS.map((a) => a.id));
  });

  it('refuses another computer', async () => {
    expect(await handlers.get('app.action.list')!({}, { origin: 'remote' })).toMatchObject({ ok: false, code: 'remote_refused' });
  });
});

describe('app.action refusals main answers', () => {
  it('an unknown or missing id', async () => {
    expect(await run({ id: 'workspace.delete' }, claimed())).toMatchObject({ ok: false, code: 'unknown_action' });
    expect(await run({}, claimed())).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(rendererCalls()).toEqual([]);
  });

  it('arguments that break the schema', async () => {
    const bad: Record<string, unknown>[] = [
      { id: 'workspace.rename' },
      { id: 'workspace.rename', args: { name: '' } },
      { id: 'workspace.rename', args: { name: 42 } },
      { id: 'workspace.rename', args: { name: 'x'.repeat(65) } },
      { id: 'workspace.rename', args: { name: 'ok', color: 'red' } },
      { id: 'workspace.rename', args: ['name'] },
      { id: 'pane.move', args: { beside: '#w1-2', edge: 'middle' } },
      { id: 'settings.set', args: { key: 'approvals.mode', value: 'bypass' } },
      { id: 'settings.set', args: { key: 'theme' } },
      { id: 'settings.set', args: { key: 'terminal.fontSize', value: Number.POSITIVE_INFINITY } },
      { id: 'layout.balance', args: { all: 'yes' } },
    ];
    for (const params of bad) {
      expect(await run(params, claimed()), JSON.stringify(params)).toMatchObject({ ok: false, code: 'invalid_args' });
    }
    expect(rendererCalls()).toEqual([]);
  });

  it('a target on an app setting, or a target that is not a string', async () => {
    expect(await run({ id: 'settings.get', target: 'ws-a' }, claimed())).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(await run({ id: 'layout.balance', target: 7 }, claimed())).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(rendererCalls()).toEqual([]);
  });

  it('a call from another computer', async () => {
    expect(await run({ id: 'layout.balance' }, { ...claimed(), origin: 'remote' })).toMatchObject({ ok: false, code: 'remote_refused' });
  });

  it('a call from a fenced worker\'s pane', async () => {
    expect(await run({ id: 'layout.balance' }, { ...claimed(), fencedWorker: true })).toMatchObject({ ok: false, code: 'fenced' });
    expect(rendererCalls()).toEqual([]);
  });
});

describe('app.action identity', () => {
  it('no identity: nothing verifies the caller', async () => {
    const res = await run({ id: 'layout.balance' }, { origin: 'local', externalWire: true, clientName: 'wmux-cli' });
    expect(res).toMatchObject({ ok: false, code: 'no_identity' });
    expect(rendererCalls()).toEqual([]);
  });

  it('a stated workspace or sender pane is not an identity', async () => {
    const wire: RpcContext = { origin: 'local', externalWire: true, clientName: 'wmux-cli' };
    expect(await run({ id: 'layout.balance', workspaceId: 'ws-a', senderPtyId: 'pty-a' }, wire)).toMatchObject({ code: 'no_identity' });
    // With a claim, the claim decides: a stated other workspace does not move it.
    await run({ id: 'layout.balance', workspaceId: 'ws-b', senderPtyId: 'pty-b' }, claimed('ws-a'));
    expect(rendererCalls()[0][2]).toMatchObject({ callerWorkspaceId: 'ws-a', callerPtyId: 'pty-a' });
  });

  it('a stale claim is refused', async () => {
    const res = await run({ id: 'layout.balance' }, { origin: 'local', externalWire: true, workspaceClaim: { kind: 'stale' } });
    expect(res).toMatchObject({ ok: false, code: 'no_identity' });
    expect((res as { error: string }).error).toMatch(/claimed is gone/);
    expect(rendererCalls()).toEqual([]);
  });

  it('the operator lane has no workspace of its own and is refused', async () => {
    expect(await run({ id: 'layout.balance' }, { origin: 'local', operator: true, firstParty: true })).toMatchObject({ code: 'no_identity' });
  });

  it('a pty on the envelope with no claim is refused, even one a workspace owns', async () => {
    const res = await run({ id: 'layout.balance' }, { origin: 'local', externalWire: true, clientName: 'wmux-cli', callerPtyId: 'pty-a' });
    expect(res).toMatchObject({ ok: false, code: 'no_identity' });
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('a workspace claim without a pane is refused', async () => {
    const res = await run({ id: 'layout.balance' }, { origin: 'local', externalWire: true, workspaceClaim: { kind: 'bound', workspaceId: 'ws-a' } });
    expect(res).toMatchObject({ ok: false, code: 'no_identity' });
    expect(rendererCalls()).toEqual([]);
  });

  it('a commander binding alone is not a pane claim', async () => {
    expect(await run({ id: 'layout.balance' }, { origin: 'local', externalWire: true, commanderWorkspace: 'ws-a' })).toMatchObject({ code: 'no_identity' });
  });

  it('the claim\'s pane goes to the renderer, not the envelope\'s', async () => {
    await run({ id: 'tab.rename', args: { name: 'x' } }, { ...claimed('ws-a', 'pty-a'), callerPtyId: 'pty-b' });
    expect(rendererCalls()[0][2]).toMatchObject({ callerWorkspaceId: 'ws-a', callerPtyId: 'pty-a' });
  });

  it('hands the renderer the caller\'s workspace, the target and the checked args', async () => {
    const res = await run({ id: 'workspace.rename', target: ' #w1-1 ', args: { name: '  api  ' } }, claimed());
    expect(res).toMatchObject({ ok: true, id: 'workspace.rename' });
    expect(rendererCalls()).toHaveLength(1);
    expect(rendererCalls()[0][2]).toEqual({
      id: 'workspace.rename',
      args: { name: 'api' },
      target: '#w1-1',
      callerWorkspaceId: 'ws-a',
      callerPtyId: 'pty-a',
    });
  });
});

describe('app.action renderer outcomes', () => {
  it('passes the renderer\'s refusal code through', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: false, code: 'not_owned', error: 'workspace ws-b is not yours' });
    expect(await run({ id: 'layout.balance', target: 'ws-b' }, claimed())).toEqual({
      ok: false, code: 'not_owned', error: 'workspace ws-b is not yours',
    });
  });

  it('no window: refused before anything is sent', async () => {
    win = null;
    expect(await run({ id: 'layout.balance' }, claimed())).toMatchObject({ ok: false, code: 'no_window' });
    win = { isDestroyed: () => true };
    expect(await run({ id: 'layout.balance' }, claimed())).toMatchObject({ ok: false, code: 'no_window' });
    expect(rendererCalls()).toEqual([]);
  });

  it('a window that closes while the call is in flight', async () => {
    sendToRendererMock.mockRejectedValueOnce(new Error('BrowserWindow is not available'));
    expect(await run({ id: 'layout.balance' }, claimed())).toMatchObject({ ok: false, code: 'no_window' });
  });

  it('a renderer that does not answer in time', async () => {
    setup({ timeoutMs: 10 });
    sendToRendererMock.mockImplementationOnce(
      (_w: unknown, _m: string, _p: unknown, opts: { timeoutMs: number; timeoutError: Error }) => {
        expect(opts.timeoutMs).toBe(10);
        return Promise.reject(opts.timeoutError);
      },
    );
    expect(await run({ id: 'layout.balance' }, claimed())).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('an uncoded renderer refusal (still starting) is a window refusal', async () => {
    sendToRendererMock.mockResolvedValueOnce({ error: 'wmux is still starting (paneGate=pending)', retryable: true });
    expect(await run({ id: 'layout.balance' }, claimed())).toMatchObject({ ok: false, code: 'no_window' });
  });
});

describe('who can reach app.action', () => {
  it('a fenced worker pane is refused by the router before the handler', async () => {
    expect(WORKER_FENCE_REFUSED_RPC.has('app.action')).toBe(true);
    expect(WORKER_FENCE_REFUSED_RPC.has('app.action.list')).toBe(true);
    const router = new RealRouter();
    registerAppActionRpc(router, () => win as unknown as BrowserWindow);
    router.setFencedWorkerPty((pty) => pty === 'pty-fenced');
    const res = await router.dispatch(
      { id: '1', method: 'app.action', params: { id: 'layout.balance' }, clientName: 'wmux-cli', callerPtyId: 'pty-fenced' },
      { externalWire: true },
    );
    expect(res).toEqual({ id: '1', ok: false, error: 'app.action: not available inside the worker fence' });
    expect(rendererCalls()).toEqual([]);
  });

  it('is on no bot or commander surface', () => {
    for (const m of ['app.action', 'app.action.list']) {
      expect(SHARED_SURFACE.rpc.has(m)).toBe(false);
      expect(COMMANDER_RPC_METHODS.has(m)).toBe(false);
      expect(botSurfaceRefusal('lead', m)).toBe('surface');
    }
  });
});
