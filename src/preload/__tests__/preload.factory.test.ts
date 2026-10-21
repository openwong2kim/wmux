// @vitest-environment jsdom
//
// The factory bridge the room dock and Settings › Factory read
// (renderer/components/Room/factoryPorts.ts): bot lists and settings over
// their IPC channels, bot actions through the operator's pipe router with
// the envelope and the handler's refusal flattened.
import { describe, expect, it, vi } from 'vitest';

const exposed: Record<string, unknown> = {};
const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true }));
const on = vi.fn();
const removeListener = vi.fn();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { exposed[key] = api; } },
  ipcRenderer: { invoke, on, once: vi.fn(), off: vi.fn(), removeListener, removeAllListeners: vi.fn(), send: vi.fn(), sendSync: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
  webFrame: { setZoomFactor: vi.fn(), getZoomFactor: vi.fn(() => 1) },
}));

type Factory = {
  listBots: (req?: { workspaceId?: string }) => Promise<unknown>;
  onBotEvent: (cb: () => void) => () => void;
  botAction: (action: string, botId: string) => Promise<{ ok: boolean; message?: string; code?: string }>;
  updateBot: (botId: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; message?: string; code?: string }>;
  getSettings: () => Promise<unknown>;
  setSettings: (patch: Record<string, unknown>) => Promise<unknown>;
};

describe('preload factory bridge', () => {
  it('maps every port to its channel', async () => {
    await import('../preload');
    const f = (exposed.electronAPI as { factory: Factory }).factory;
    await f.listBots({ workspaceId: 'ws-1' });
    expect(invoke).toHaveBeenLastCalledWith('factory:bot:list', { workspaceId: 'ws-1' });
    await f.getSettings();
    expect(invoke).toHaveBeenLastCalledWith('factory:settings:get');
    await f.setSettings({ enabled: true });
    expect(invoke).toHaveBeenLastCalledWith('factory:settings:set', { enabled: true });

    invoke.mockResolvedValueOnce({ id: 'x', ok: true, result: { ok: true, wake: {} } });
    expect(await f.botAction('wake', 'bot-0000000a')).toEqual({ ok: true });
    expect(invoke).toHaveBeenLastCalledWith('rpc:invoke', 'bot.wake', { botId: 'bot-0000000a' });
    invoke.mockResolvedValueOnce({ id: 'x', ok: true, result: { ok: false, code: 'not_running', message: 'not running a turn' } });
    expect(await f.botAction('interrupt', 'bot-0000000a')).toEqual({ ok: false, message: 'not running a turn', code: 'not_running' });
    // A repository refusal keeps its code, so the renderer can tell them apart.
    invoke.mockResolvedValueOnce({ id: 'x', ok: true, result: { ok: false, code: 'repo_mismatch', message: 'another repository' } });
    expect(await f.updateBot('bot-0000000a', { repo: '/r' })).toEqual({ ok: false, message: 'another repository', code: 'repo_mismatch' });
    invoke.mockResolvedValueOnce({ id: 'x', ok: true, result: { ok: false, message: 'no code' } });
    expect(await f.updateBot('bot-0000000a', { repo: '/r' })).toEqual({ ok: false, message: 'no code' });
    invoke.mockResolvedValueOnce({ id: 'x', ok: false, error: 'denied' });
    expect(await f.updateBot('bot-0000000a', { name: 'V' })).toEqual({ ok: false, message: 'denied' });
    expect(invoke).toHaveBeenLastCalledWith('rpc:invoke', 'bot.update', { botId: 'bot-0000000a', patch: { name: 'V' } });

    const cb = vi.fn();
    const off = f.onBotEvent(cb);
    const [channel, listener] = on.mock.calls.at(-1) as [string, () => void];
    expect(channel).toBe('bot.event');
    listener();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(removeListener).toHaveBeenCalledWith('bot.event', listener);
  });

  it('fans one bot.event listener out to every subscriber', async () => {
    await import('../preload');
    const f = (exposed.electronAPI as { factory: Factory }).factory;
    on.mockClear();
    removeListener.mockClear();
    const views = Array.from({ length: 12 }, () => vi.fn());
    const offs = views.map((cb) => f.onBotEvent(cb));
    // Twelve views, one channel listener: under Node's eleven-listener warning.
    expect(on.mock.calls.filter(([c]) => c === 'bot.event')).toHaveLength(1);
    const listener = on.mock.calls[0][1] as () => void;
    // One failing view does not stop the rest.
    views[0].mockImplementation(() => { throw new Error('view failed'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    listener();
    for (const cb of views) expect(cb).toHaveBeenCalledTimes(1);
    err.mockRestore();
    offs[0]();
    offs[0]();
    expect(removeListener).not.toHaveBeenCalled();
    for (const off of offs.slice(1)) off();
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith('bot.event', listener);
  });
});
