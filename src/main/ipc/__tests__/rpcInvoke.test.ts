// `rpc:invoke` answers only the main window's top frame: a subframe of the
// main window, another window, a destroyed or missing window, or an event
// with no frame is refused and nothing is dispatched.
import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { createRpcInvokeHandler, RPC_INVOKE_NOT_MAIN_WINDOW } from '../rpcInvoke';

function setup(opts: { destroyed?: boolean; noWindow?: boolean; wired?: boolean } = {}) {
  const mainFrame = { name: 'top' };
  const webContents = { id: 1, mainFrame };
  const win = { isDestroyed: () => opts.destroyed === true, webContents } as unknown as BrowserWindow;
  const run = vi.fn(async (method: string, params: Record<string, unknown>) => ({ ok: true, method, params }));
  const handler = createRpcInvokeHandler(() => (opts.noWindow ? null : win), () => (opts.wired === false ? undefined : run));
  return { handler, run, webContents, mainFrame };
}

describe('rpc:invoke', () => {
  it('dispatches for the main window\'s top frame, with object params only', async () => {
    const { handler, run, webContents, mainFrame } = setup();
    expect(await handler({ sender: webContents, senderFrame: mainFrame }, 'events.poll', { a: 1 }))
      .toEqual({ ok: true, method: 'events.poll', params: { a: 1 } });
    await handler({ sender: webContents, senderFrame: mainFrame }, 'events.poll', 'not-an-object');
    expect(run).toHaveBeenLastCalledWith('events.poll', {});
  });

  it('refuses a subframe, another window, a missing frame, or no main window, and dispatches nothing', async () => {
    const { handler, run, webContents, mainFrame } = setup();
    const otherContents = { id: 2, mainFrame: { name: 'other-top' } };
    for (const event of [
      { sender: webContents, senderFrame: { name: 'plugin-iframe' } },
      { sender: otherContents, senderFrame: otherContents.mainFrame },
      { sender: otherContents, senderFrame: mainFrame },
      { sender: webContents },
      {},
    ]) {
      expect(await handler(event, 'workspace.list', {})).toEqual(RPC_INVOKE_NOT_MAIN_WINDOW);
    }
    expect(await setup({ noWindow: true }).handler({ sender: webContents, senderFrame: mainFrame }, 'workspace.list', {}))
      .toEqual(RPC_INVOKE_NOT_MAIN_WINDOW);
    const destroyed = setup({ destroyed: true });
    expect(await destroyed.handler({ sender: destroyed.webContents, senderFrame: destroyed.mainFrame }, 'workspace.list', {}))
      .toEqual(RPC_INVOKE_NOT_MAIN_WINDOW);
    expect(destroyed.run).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('still refuses a missing method and an unwired bridge', async () => {
    const { handler, webContents, mainFrame } = setup();
    expect(await handler({ sender: webContents, senderFrame: mainFrame }, '', {})).toMatchObject({ ok: false, error: /missing method/ });
    const unwired = setup({ wired: false });
    expect(await unwired.handler({ sender: unwired.webContents, senderFrame: unwired.mainFrame }, 'events.poll', {})).toMatchObject({ ok: false, error: /not wired/ });
  });

  it('refuses a method the window does not call, dispatches nothing, and logs each name once', async () => {
    const { handler, run, webContents, mainFrame } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const event = { sender: webContents, senderFrame: mainFrame };
      expect(await handler(event, 'workspace.list', {})).toEqual({ ok: false, error: 'rpc:invoke: method not allowed: workspace.list' });
      expect(await handler(event, 'workspace.list', {})).toMatchObject({ ok: false, error: /not allowed/ });
      expect(await handler(event, 'no.such.method', {})).toMatchObject({ ok: false, error: /not allowed/ });
      expect(run).not.toHaveBeenCalled();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('workspace.list'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a non-string or overlong method name before any lookup, and logs nothing for it', async () => {
    const { handler, run, webContents, mainFrame } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const event = { sender: webContents, senderFrame: mainFrame };
      for (const bad of [42, null, undefined, { m: 'events.poll' }, ['events.poll']]) {
        expect(await handler(event, bad, {})).toMatchObject({ ok: false, error: /missing method/ });
      }
      const long = 'x'.repeat(121);
      expect(await handler(event, long, {})).toEqual({ ok: false, error: 'rpc:invoke: method name too long' });
      expect(await handler(event, `events.poll${' '.repeat(200)}`, {})).toEqual({ ok: false, error: 'rpc:invoke: method name too long' });
      expect(run).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('remembers at most 256 refused names for its once-only log', async () => {
    const { handler, webContents, mainFrame } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const event = { sender: webContents, senderFrame: mainFrame };
      for (let i = 0; i < 400; i++) await handler(event, `bounded.case.${i}`, {});
      for (let i = 0; i < 400; i++) await handler(event, `bounded.case.${i}`, {});
      const logged = warn.mock.calls.filter((c) => String(c[0]).includes('bounded.case.')).length;
      expect(logged).toBeLessThanOrEqual(256);
      expect(logged).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });

  // Each of these acts with lasting effect and has its own IPC channel
  // (keys and logins: BOT_SECRET_IPC; connectors: CONNECTOR_IPC; bot
  // approvals: BOT_APPROVAL_IPC; browser policy: BROWSER_POLICY_IPC; folder
  // trust: PROJECT_CONFIG_SET_TRUST; fan-out: the fan-out IPC handlers).
  // None is reachable through rpc:invoke.
  it.each([
    'botSecret.request',
    'botSecret.list',
    'botLogin.request',
    'approval.press',
    'task.fanout.start',
    'input.send',
    'input.sendKey',
    'browser.consent.release',
    'browser.consent.request',
    'browser.open',
    'bot.create',
    'bot.setJob',
    'routine.set',
    'routine.pause',
    'fact.emit',
    'daemon.shutdown',
    'task.mission.close',
    'a2a.channel.post',
  ])('refuses %s', async (method) => {
    const { handler, run, webContents, mainFrame } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await handler({ sender: webContents, senderFrame: mainFrame }, method, {})).toMatchObject({ ok: false, error: /not allowed/ });
      expect(run).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
