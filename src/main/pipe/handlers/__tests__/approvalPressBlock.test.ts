// The terminal_send block and its deadlock guard (orchestrator wave 2).
//
// Dispatched through the REAL RpcRouter with a REAL commander token, because
// the whole behaviour hangs on `ctx.commanderWorkspace` — a unit test that
// hand-built the context would not prove the brain's own calls are the ones
// that get blocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import {
  clearPressBlockLifts,
  liftPressBlock,
  pressBlockLift,
  registerApprovalsRpc,
  PRESS_BLOCK_LIFT_MS,
  PRESS_DEADLOCK_REASONS,
} from '../approvals.rpc';
import { mintCommanderToken, revokeCommanderToken } from '../../../deck/commanderTrust';
import type { BrowserWindow } from 'electron';
import type { PTYManager } from '../../../pty/PTYManager';

vi.mock('../_bridge', () => ({ sendToRenderer: vi.fn() }));

const fakeWindow = {} as BrowserWindow;

interface Wiring {
  router: RpcRouter;
  token: string;
  writes: Array<{ ptyId: string; data: string }>;
}

/** A daemon holding `pending` approval records, whose resolve answers `reply`. */
function wire(options: {
  pending?: Array<{ id: string; sessionId: string; toolName?: string }>;
  reply?: unknown;
} = {}): Wiring {
  const writes: Array<{ ptyId: string; data: string }> = [];
  const dc = {
    isConnected: true,
    rpc: async (method: string) => {
      if (method === 'daemon.approvals.list') return { pending: options.pending ?? [] };
      return options.reply ?? { ok: true, durable: true };
    },
    writeToSession: (ptyId: string, data: string) => {
      writes.push({ ptyId, data });
      return true;
    },
  };
  const router = new RpcRouter();
  // No local pty, so writes fall through to the daemon client above.
  registerInputRpc(router, { get: () => undefined } as unknown as PTYManager, () => fakeWindow, () => dc as never);
  registerApprovalsRpc(router, () => dc as never);
  return { router, token: mintCommanderToken('ws-brain'), writes };
}

let w: Wiring;

beforeEach(() => {
  clearPressBlockLifts();
  w = wire();
});
afterEach(() => {
  revokeCommanderToken(w.token);
  clearPressBlockLifts();
});

/** The refusal shape, narrowed — `dispatch` returns a union on `ok`. */
type Answer = { ok: boolean; error?: string; result?: unknown };

const asBrain = (method: string, params: Record<string, unknown>): Promise<Answer> =>
  w.router.dispatch({ id: '1', method, params, commanderToken: w.token } as never) as Promise<Answer>;

const asHuman = (method: string, params: Record<string, unknown>): Promise<Answer> =>
  w.router.dispatch({ id: '1', method, params } as never) as Promise<Answer>;

describe('terminal_send at a pane holding an approval', () => {
  it('refuses the brain, and names approval_press with the pane id', async () => {
    w = wire({ pending: [{ id: 'ap-1', sessionId: 'pty-w', toolName: 'Bash' }] });

    const res = await asBrain('input.send', { ptyId: 'pty-w', text: '1', submit: true });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('approval_press({ ptyId: "pty-w"');
    expect(res.error).toContain('Bash');
    expect(w.writes).toHaveLength(0);
  });

  it('refuses a KEY too — Down/Enter selects an option as surely as "2" does', async () => {
    w = wire({ pending: [{ id: 'ap-1', sessionId: 'pty-w' }] });

    const res = await asBrain('input.sendKey', { ptyId: 'pty-w', key: 'enter' });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('approval_press');
    expect(w.writes).toHaveLength(0);
  });

  it('does not touch the human operator — only a commander is blocked', async () => {
    w = wire({ pending: [{ id: 'ap-1', sessionId: 'pty-w' }] });

    const res = await asHuman('input.send', { ptyId: 'pty-w', text: '1' });

    expect(res.ok).toBe(true);
    expect(w.writes).toEqual([{ ptyId: 'pty-w', data: '1' }]);
  });

  it('lets the brain type when no record exists — a worker without wmux hooks', async () => {
    w = wire({ pending: [{ id: 'ap-1', sessionId: 'some-other-pane' }] });

    const res = await asBrain('input.send', { ptyId: 'pty-w', text: 'go on' });

    expect(res.ok).toBe(true);
    expect(w.writes).toEqual([{ ptyId: 'pty-w', data: 'go on' }]);
  });
});

describe('the deadlock guard', () => {
  it('lifts the block for a pane whose press POLICY refused, and says so', async () => {
    w = wire({
      pending: [{ id: 'ap-1', sessionId: 'pty-w' }],
      reply: { ok: false, reason: 'press-capability-off' },
    });

    // Blocked first: without a refused press there is no lift.
    expect((await asBrain('input.send', { ptyId: 'pty-w', text: '1' })).ok).toBe(false);

    const press = (await asBrain('approval.press', { ptyId: 'pty-w' })) as {
      ok: boolean;
      result?: { reason: string; typedFallback?: string };
    };
    expect(press.ok).toBe(true);
    expect(press.result).toMatchObject({ reason: 'press-capability-off' });
    expect(press.result?.typedFallback).toContain('lifted');

    // …and now the typed path is open, so the brain is not stuck with no move.
    const after = await asBrain('input.send', { ptyId: 'pty-w', text: '1' });
    expect(after.ok).toBe(true);
    expect(w.writes).toEqual([{ ptyId: 'pty-w', data: '1' }]);
  });

  it('does NOT lift on a transient refusal — a vanished prompt is what the block is for', async () => {
    w = wire({
      pending: [{ id: 'ap-1', sessionId: 'pty-w' }],
      reply: { ok: false, reason: 'prompt-gone' },
    });

    await asBrain('approval.press', { ptyId: 'pty-w' });

    expect(PRESS_DEADLOCK_REASONS.has('prompt-gone')).toBe(false);
    expect((await asBrain('input.send', { ptyId: 'pty-w', text: '1' })).ok).toBe(false);
  });

  it('expires, so a pane is protected again on the next task', () => {
    const t0 = 1_000_000;
    liftPressBlock('pty-w', 'autonomy-off', t0);
    expect(pressBlockLift('pty-w', t0 + 1)).toMatchObject({ reason: 'autonomy-off' });
    expect(pressBlockLift('pty-w', t0 + PRESS_BLOCK_LIFT_MS)).toBeNull();
  });
});
