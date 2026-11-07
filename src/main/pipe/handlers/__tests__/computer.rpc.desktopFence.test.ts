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
import type { ComputerService } from '../../../computer/ComputerService';
import { registerComputerRpc } from '../computer.rpc';

const FENCED = 'pty-fenced';
const PROTECTED = 'pty-protected';

function setup() {
  const desktop = vi.fn(async () => ({ command: 'snapshot', data: { snapshot_id: 's1' } }));
  const control = vi.fn(async () => ({ method: 'synthetic', verification: 'unverified' }));
  const router = new RpcRouter();
  router.setFencedWorkerPty((pty) => pty === FENCED);
  registerComputerRpc(
    router,
    () => ({ desktop, control }) as unknown as ComputerService,
    async () => 'ws-a',
    () => undefined,
    async (_method: string, ctx: RpcContext | undefined) => (ctx?.callerPtyId === PROTECTED ? 'the pane is protected' : null),
  );
  const call = (method: string, pty: string, params: Record<string, unknown>) =>
    router.dispatch(
      { id: method, method: method as never, params: { ...params, senderPtyId: pty }, clientName: 'claude-code', callerPtyId: pty },
      { externalWire: true },
    );
  return { desktop, control, call };
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
