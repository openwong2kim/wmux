// The owner's Hermes controls: only the main window moves a bot onto Hermes
// or opens the setup tab.
// @wmux-lane unit — 'win32' here is an injected platform value for My Hermes's
// refusal; nothing reaches the OS, so Windows cannot change the result.
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/tmp' }, dialog: {}, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, nativeImage: {} }));

import { factoryBotCreateHandler, factoryBotSetEngineHandler, factoryHermesReadinessHandler, factoryHermesSetupHandler, factoryMyHermesHandler } from '../factory.handler';
import { HERMES_BOT_ENGINE, type BotEngine, type BotProfile } from '../../../../shared/bot';

const BOT = 'bot-0000000a';
const win = { webContents: { id: 1, mainFrame: { url: 'app://x' } }, isDestroyed: () => false };
const main = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
const other = { sender: { id: 2, mainFrame: { url: 'app://x' } }, senderFrame: { url: 'app://x' } };

describe('factoryBotSetEngineHandler', () => {
  it('moves a bot to Hermes and back for the main window only; the next turn respawns', async () => {
    let engine: BotEngine = { kind: 'claude-sdk', model: 'opus' };
    const update = vi.fn((_id: string, patch: { engine: BotEngine }) => {
      engine = patch.engine;
      return { ok: true as const, bot: { id: BOT, engine } as BotProfile };
    });
    const store = { get: (id: string) => (id === BOT ? ({ id: BOT, engine } as BotProfile) : null), update };
    const profileChanged = vi.fn();
    const handler = factoryBotSetEngineHandler(() => win as never, { store: () => store as never, runtime: () => ({ profileChanged }) });

    expect(await handler(other, { botId: BOT, engine: 'hermes' })).toMatchObject({ ok: false, code: 'operator_only' });
    expect(await handler(main, { botId: BOT, engine: { kind: 'acp', command: 'sh', args: [] } })).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await handler(main, { botId: '../x', engine: 'hermes' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    // Already on Claude: the model stays.
    expect(await handler(main, { botId: BOT, engine: 'claude-sdk' })).toEqual({ ok: true });
    expect(update).not.toHaveBeenCalled();

    expect(await handler(main, { botId: BOT, engine: 'hermes' })).toEqual({ ok: true });
    expect(engine).toEqual(HERMES_BOT_ENGINE);
    expect(profileChanged).toHaveBeenLastCalledWith(BOT);
    expect(await handler(main, { botId: BOT, engine: 'claude-sdk' })).toEqual({ ok: true });
    expect(engine).toEqual({ kind: 'claude-sdk' });
    expect(profileChanged).toHaveBeenCalledTimes(2);
  });
});

describe('My Hermes: the engine verb, Add bot and the status', () => {
  const OWN = { kind: 'acp', command: 'hermes', args: ['acp'], preset: 'hermes', mode: 'own', profile: 'default' };
  function rig(opts: { holder?: string; inGroup?: boolean; platform?: NodeJS.Platform } = {}) {
    let engine: BotEngine = { kind: 'claude-sdk' };
    const update = vi.fn((_id: string, patch: { engine: BotEngine }) => {
      engine = patch.engine;
      return { ok: true as const, bot: { id: BOT, engine } as BotProfile };
    });
    const store = {
      get: (id: string) => (id === BOT ? ({ id: BOT, name: 'Alpha', engine } as BotProfile) : null),
      update,
      ownHermesHolder: (profile: string, except?: string) => (opts.holder && profile === 'default' && except !== 'bot-0000000b' ? ({ id: 'bot-0000000b', name: opts.holder } as BotProfile) : null),
    };
    const confirm = vi.fn(async () => true);
    const profileChanged = vi.fn();
    const handler = factoryBotSetEngineHandler(() => win as never, {
      store: () => store as never,
      runtime: () => ({ profileChanged }),
      confirm,
      platform: opts.platform ?? 'darwin',
      profiles: () => ['default', 'coder'],
      groups: () => (opts.inGroup ? [{ memberIds: [BOT, 'bot-0000000c'] }] : []),
    });
    return { handler, confirm, update, profileChanged, engine: () => engine };
  }

  it('refuses other senders, asks main\'s own confirm, and saves only a yes', async () => {
    const r = rig();
    expect(await r.handler(other, { botId: BOT, engine: 'my-hermes' })).toMatchObject({ ok: false, code: 'operator_only' });
    expect(r.confirm).not.toHaveBeenCalled();
    r.confirm.mockResolvedValueOnce(false);
    expect(await r.handler(main, { botId: BOT, engine: 'my-hermes' })).toMatchObject({ ok: false, code: 'cancelled' });
    expect(r.confirm).toHaveBeenCalledWith(win, 'Alpha', 'default', true);
    expect(r.update).not.toHaveBeenCalled();
    expect(await r.handler(main, { botId: BOT, engine: 'my-hermes', hermesProfile: 'coder' })).toEqual({ ok: true });
    expect(r.engine()).toEqual({ ...OWN, profile: 'coder' });
    expect(r.profileChanged).toHaveBeenCalledWith(BOT);
  });

  it('refuses a profile another bot uses, a bot in a group, a missing profile and Windows, before asking', async () => {
    expect(await rig({ holder: 'Beta' }).handler(main, { botId: BOT, engine: 'my-hermes' })).toMatchObject({ ok: false, message: expect.stringContaining('Beta already uses ~/.hermes') });
    expect(await rig({ inGroup: true }).handler(main, { botId: BOT, engine: 'my-hermes' })).toMatchObject({ ok: false, message: expect.stringContaining('one to one') });
    expect(await rig().handler(main, { botId: BOT, engine: 'my-hermes', hermesProfile: 'ghost' })).toMatchObject({ ok: false, message: expect.stringContaining('No Hermes profile ghost') });
    expect(await rig().handler(main, { botId: BOT, engine: 'my-hermes', hermesProfile: '../x' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    const win32 = rig({ platform: 'win32' });
    expect(await win32.handler(main, { botId: BOT, engine: 'my-hermes' })).toMatchObject({ ok: false, message: expect.stringContaining('macOS and Linux') });
    expect(win32.confirm).not.toHaveBeenCalled();
  });

  it('Add bot asks the same confirm before the bot is made; a no makes nothing', async () => {
    const create = vi.fn();
    const store = { ownHermesHolder: () => null, create };
    const confirm = vi.fn(async () => false);
    const handler = factoryBotCreateHandler(() => win as never, { store: () => store as never, confirm, platform: 'darwin', profiles: () => ['default'], greet: vi.fn() });
    expect(await handler(other, { workspaceId: 'ws-1', name: 'New', engine: 'my-hermes' })).toMatchObject({ ok: false, code: 'operator_only' });
    expect(await handler(main, { workspaceId: 'ws-1', name: 'New', engine: 'my-hermes' })).toMatchObject({ ok: false, code: 'cancelled' });
    expect(confirm).toHaveBeenCalledWith(win, 'New', 'default', false);
    expect(create).not.toHaveBeenCalled();
  });

  it('lists the profiles with the bot on each, for the main window only', async () => {
    const store = { ownHermesHolder: (p: string) => (p === 'coder' ? ({ id: BOT, name: 'Alpha' } as BotProfile) : null) };
    const readiness = vi.fn(async () => ({ ready: true, version: '0.22.5', notices: [] }));
    const handler = factoryMyHermesHandler(() => win as never, { store: () => store as never, platform: 'darwin', profiles: () => ['default', 'coder'], readiness });
    expect(await handler(other)).toEqual({ supported: false, profiles: [] });
    expect(await handler(main)).toEqual({ supported: true, profiles: [{ name: 'default', dir: '~/.hermes' }, { name: 'coder', dir: '~/.hermes/profiles/coder', usedBy: { botId: BOT, name: 'Alpha' } }] });
    expect(readiness).not.toHaveBeenCalled();
    expect((await handler(main, { profile: 'default', fresh: true })).readiness).toMatchObject({ ready: true });
    expect(readiness).toHaveBeenCalledWith('default', true);
    expect(await factoryMyHermesHandler(() => win as never, { store: () => store as never, platform: 'win32' })(main)).toEqual({ supported: false, profiles: [] });
  });
});

describe('factoryHermesSetupHandler', () => {
  it('opens a tab with the host\'s setup line; no line or no tab is an error', async () => {
    const openTab = vi.fn(async () => ({ ptyId: 'pty-1' }));
    let line: string | null = "env -i HERMES_HOME='/d/factory/hermes' '/bin/hermes' model";
    const handler = factoryHermesSetupHandler(() => win as never, { openTab, windowsShell: () => 'cmd.exe', platform: 'darwin', host: () => ({ setupLine: () => line }) });
    await expect(handler(other)).rejects.toThrow(/main window/);
    await handler(main);
    expect(openTab).toHaveBeenCalledWith(undefined, line);
    line = null;
    await expect(handler(main)).rejects.toThrow(/could not find Hermes/);
    line = 'x';
    openTab.mockResolvedValueOnce(null as never);
    await expect(handler(main)).rejects.toThrow(/could not open a terminal/);
  });
});

describe('factoryHermesReadinessHandler', () => {
  it('answers the main window only, afresh when asked', async () => {
    const readiness = vi.fn(async (fresh?: boolean) => ({ ready: true, version: fresh ? 'fresh' : 'cached' }));
    const handler = factoryHermesReadinessHandler(() => win as never, () => ({ readiness }) as never);
    expect(await handler(other)).toMatchObject({ ready: false, reason: 'unknown' });
    expect(await handler(main)).toMatchObject({ version: 'cached' });
    expect(await handler(main, { fresh: true })).toMatchObject({ version: 'fresh' });
    expect(readiness).toHaveBeenCalledTimes(2);
  });
});
