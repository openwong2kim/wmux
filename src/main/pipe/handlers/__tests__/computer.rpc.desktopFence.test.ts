// The desktop action rides computer.getAppState, so it gets exactly the
// rules that method gets at the pipe: a fenced bot worker may observe with it
// as with getAppState, computer.act stays refused to that worker, and a
// protected browser pane gets neither. (The fence's agent-side settings and
// hook refuse the whole `computer` MCP tool on top of this; see
// WORKER_FENCE_REFUSED_WMUX_TOOLS.)

import { describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import type { RpcContext } from '../../../../shared/rpc';
import { parseComputerErrorMessage } from '../../../../shared/computer/errors';
import { WORKER_FENCE_REFUSED_RPC, WORKER_FENCE_REFUSED_WMUX_TOOLS } from '../../../../shared/botWorkerGuard';
import { ComputerService, type DesktopDeps, type HelperLike } from '../../../computer/ComputerService';
import { registerComputerRpc } from '../computer.rpc';

const FENCED = 'pty-fenced';
const PROTECTED = 'pty-protected';

function setup() {
  const desktop = vi.fn(async () => ({ command: 'snapshot', data: { snapshot_id: 's1' } }));
  const control = vi.fn(async () => ({ method: 'synthetic', verification: 'unverified' }));
  const desktopAct = vi.fn(async () => ({ method: 'accessibility', verification: 'unverified', delivery: 'background' }));
  const router = new RpcRouter();
  router.setFencedWorkerPty((pty) => pty === FENCED);
  registerComputerRpc(
    router,
    () => ({ desktop, control, desktopAct }) as unknown as ComputerService,
    async () => 'ws-a',
    () => undefined,
    async (_method: string, ctx: RpcContext | undefined) => (ctx?.callerPtyId === PROTECTED ? 'the pane is protected' : null),
  );
  const call = (method: string, pty: string, params: Record<string, unknown>) =>
    router.dispatch(
      { id: method, method: method as never, params: { ...params, senderPtyId: pty }, clientName: 'claude-code', callerPtyId: pty },
      { externalWire: true },
    );
  return { desktop, control, desktopAct, call };
}

const DESKTOP = { app: 'TextEdit', desktop: { command: 'snapshot', args: {} } };

describe('desktop at the pipe, for fenced workers and protected panes', () => {
  it('lets a fenced worker observe with desktop, as with getAppState', async () => {
    expect(WORKER_FENCE_REFUSED_RPC.has('computer.getAppState')).toBe(false);
    const { call, desktop } = setup();
    const res = await call('computer.getAppState', FENCED, DESKTOP);
    expect(res.ok).toBe(true);
    expect(desktop).toHaveBeenCalledTimes(1);
  });

  it('keeps computer.act refused to a fenced worker', async () => {
    const { call, control } = setup();
    const res = await call('computer.act', FENCED, { action: 'click', snapshotId: 's1', index: 1 });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe('computer.act: not available inside the worker fence');
    expect(control).not.toHaveBeenCalled();
  });

  it('keeps a desktop ref action refused to a fenced worker', async () => {
    const { call, desktopAct } = setup();
    const res = await call('computer.act', FENCED, { desktop: { command: 'click', args: { ref: '@s1:e1' } } });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe('computer.act: not available inside the worker fence');
    expect(desktopAct).not.toHaveBeenCalled();
  });

  it('sends a desktop ref action alone: any other control field rides with it is refused', async () => {
    const { call, desktopAct } = setup();
    for (const extra of [{ action: 'click' }, { snapshotId: 's1', index: 1 }, { app: 'TextEdit' }]) {
      const res = await call('computer.act', 'pty-other', { desktop: { command: 'click', args: { ref: '@s1:e1' } }, ...extra });
      expect(res.ok).toBe(false);
      expect(parseComputerErrorMessage((res as { error: string }).error)).toMatchObject({ code: 'invalid_argument', disposition: 'not_delivered' });
    }
    expect(desktopAct).not.toHaveBeenCalled();
    const ok = await call('computer.act', 'pty-other', { desktop: { command: 'click', args: { ref: '@s1:e1' } } });
    expect(ok.ok).toBe(true);
    expect(desktopAct).toHaveBeenCalledWith(expect.anything(), { command: 'click', args: { ref: '@s1:e1' } });
  });

  it('an action sent on the read path never reaches the runner, from a fenced worker or anyone else', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '' }));
    const helper: HelperLike = { request: vi.fn() as unknown as HelperLike['request'], abort: vi.fn(), dispose: vi.fn() };
    const desktopDeps: DesktopDeps = { run, readRefmap: vi.fn(async () => ''), abort: vi.fn(), dispose: vi.fn() };
    const service = new ComputerService({
      isEnabled: () => true,
      askPerApp: () => true,
      createHelper: () => helper,
      requestConsent: async () => 'approved',
      stopKey: { arm: () => true, release: () => undefined },
      blockContext: () => ({}),
      platform: 'darwin',
      desktop: desktopDeps,
    });
    const router = new RpcRouter();
    router.setFencedWorkerPty((pty) => pty === FENCED);
    registerComputerRpc(router, () => service, async () => 'ws-a');
    for (const pty of [FENCED, 'pty-other']) {
      for (const command of ['click', 'toggle', 'scroll']) {
        const res = await router.dispatch(
          { id: 'x', method: 'computer.getAppState' as never, params: { app: 'TextEdit', desktop: { command, args: { ref: '@s1:e1' } }, senderPtyId: pty }, clientName: 'claude-code', callerPtyId: pty },
          { externalWire: true },
        );
        expect(res.ok).toBe(false);
        expect(parseComputerErrorMessage((res as { error: string }).error).code).toBe('invalid_argument');
      }
    }
    expect(run).not.toHaveBeenCalled();
    expect(helper.request).not.toHaveBeenCalled();
  });

  it('refuses desktop to a protected browser pane', async () => {
    const { call, desktop } = setup();
    const res = await call('computer.getAppState', PROTECTED, DESKTOP);
    expect(res.ok).toBe(false);
    expect(parseComputerErrorMessage((res as { error: string }).error).code).toBe('policy_denied');
    expect(desktop).not.toHaveBeenCalled();
  });

  it('is still refused as a whole tool by the fence on the agent side', () => {
    expect(WORKER_FENCE_REFUSED_WMUX_TOOLS).toContain('mcp__wmux__computer');
  });
});
