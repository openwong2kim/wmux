/**
 * Claude Code's settings are shared with the installed wmux, so an isolated
 * instance (WMUX_DATA_SUFFIX set) or a development build never writes them
 * from the Settings handlers while its home is the account's real one: each
 * answers with a refusal that names `wmux setup-hooks`, and every file is
 * left as it was. With a sandbox home (a test harness) it writes there. A
 * packaged, unsuffixed instance writes as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../../../shared/constants';
import { installHooks, type SetupHooksPaths } from '../../../../cli/commands/setupHooks';
import type { Account } from '../../../account/accountStore';
import { claudeSettingsWriteRefusal, registerHooksBridgeHandlers } from '../hooksBridge.handler';

const state = vi.hoisted(() => ({ isPackaged: true, list: [] as Account[], base: null as SetupHooksPaths | null }));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
  },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
}));
vi.mock('../../../account/accountStore', () => ({
  getAccountStore: () => ({ listAccounts: () => state.list }),
}));
vi.mock('../../../../cli/commands/setupHooks', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../cli/commands/setupHooks')>();
  return { ...real, defaultPaths: () => state.base as SetupHooksPaths };
});

let tmp: string;

/** What the OS says the account's home is (os.userInfo().homedir). */
function accountHome(home: string): void {
  const real = os.userInfo();
  vi.spyOn(os, 'userInfo').mockReturnValue({ ...real, homedir: home } as never);
}

function handlerFor(channel: string): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  registerHooksBridgeHandlers();
  const call = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`no handler for ${channel}`);
  return call[1] as unknown as (event: unknown, ...args: unknown[]) => Promise<unknown>;
}

/** Every file under the temp HOME: its bytes and its mtime. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      out[path.relative(tmp, file)] = `${sha} ${fs.statSync(file).mtimeMs}`;
    }
  };
  walk(tmp);
  return out;
}

/** A settings file wmux installed into, minus one hook: an Update has work. */
function dropHook(settingsPath: string, event: string): void {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, unknown> };
  delete settings.hooks[event];
  fs.writeFileSync(settingsPath, JSON.stringify(settings), 'utf8');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hooks-isolation-'));
  const bridgeSource = path.join(tmp, 'src-bridge.mjs');
  fs.writeFileSync(bridgeSource, 'BRIDGE\n', 'utf8');
  const base: SetupHooksPaths = {
    settingsPath: path.join(tmp, '.claude', 'settings.json'),
    bridgeDest: path.join(tmp, '.wmux', 'hooks', 'wmux-bridge.mjs'),
    bridgeSource,
  };
  expect(installHooks(base).ok).toBe(true);
  // An account folder with its own copy of the settings, drifted.
  const accountDir = path.join(tmp, 'acct-a');
  fs.mkdirSync(accountDir);
  fs.copyFileSync(base.settingsPath, path.join(accountDir, 'settings.json'));
  dropHook(path.join(accountDir, 'settings.json'), 'StopFailure');
  dropHook(base.settingsPath, 'StopFailure');
  state.base = base;
  state.list = [{ id: 'a', name: 'acct a', vendor: 'claude', configDir: accountDir, createdAt: 0 } as Account];
  state.isPackaged = true;
  vi.stubEnv('WMUX_DATA_SUFFIX', '');
  vi.mocked(ipcMain.handle).mockClear();
  // The account's home is the one this process runs with: the real home.
  accountHome(os.homedir());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const HANDLERS: Array<{ name: string; channel: string; args: unknown[]; wrote: string }> = [
  { name: 'Install', channel: IPC.HOOKS_BRIDGE_INSTALL, args: [], wrote: path.join('.claude', 'settings.json') },
  { name: 'Update', channel: IPC.HOOKS_BRIDGE_UPDATE, args: [], wrote: path.join('.claude', 'settings.json') },
  { name: 'Update for an account', channel: IPC.HOOKS_BRIDGE_UPDATE_ACCOUNT, args: ['a'], wrote: path.join('acct-a', 'settings.json') },
  { name: 'Allow worker tools', channel: IPC.HOOKS_BRIDGE_ALLOW_WORKER_TOOLS, args: [], wrote: path.join('.claude', 'settings.json') },
];

describe.each(HANDLERS)('$name', ({ channel, args, wrote }) => {
  it('refuses from an isolated instance and writes nothing', async () => {
    vi.stubEnv('WMUX_DATA_SUFFIX', '-iso');
    const before = snapshot();
    const outcome = (await handlerFor(channel)({}, ...args)) as { ok: boolean; error: string | null };
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('isolated instance (WMUX_DATA_SUFFIX=-iso)');
    expect(outcome.error).toContain('wmux setup-hooks');
    expect(snapshot()).toEqual(before);
  });

  it('refuses from a development build and writes nothing', async () => {
    state.isPackaged = false;
    const before = snapshot();
    const outcome = (await handlerFor(channel)({}, ...args)) as { ok: boolean; error: string | null };
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('a development build');
    expect(outcome.error).toContain('wmux setup-hooks');
    expect(snapshot()).toEqual(before);
  });

  it('writes from a packaged, unsuffixed instance', async () => {
    const before = snapshot();
    const outcome = (await handlerFor(channel)({}, ...args)) as { ok: boolean; error: string | null };
    expect(outcome).toMatchObject({ ok: true, error: null });
    expect(snapshot()[wrote]).not.toBe(before[wrote]);
  });
});

describe('the guard asks whether the home is the account\'s real one', () => {
  it('lets an isolated instance write into a sandbox home', async () => {
    vi.stubEnv('WMUX_DATA_SUFFIX', '-e2e');
    accountHome(path.join(tmp, 'the-account-home'));
    expect(claudeSettingsWriteRefusal()).toBeNull();
    const outcome = (await handlerFor(IPC.HOOKS_BRIDGE_INSTALL)({})) as { ok: boolean; error: string | null };
    expect(outcome).toMatchObject({ ok: true, error: null });
  });

  it('lets a development build write into a sandbox home', () => {
    state.isPackaged = false;
    accountHome(path.join(tmp, 'the-account-home'));
    expect(claudeSettingsWriteRefusal()).toBeNull();
  });

  it('counts a home reached through a symlink as the real one', () => {
    vi.stubEnv('WMUX_DATA_SUFFIX', '-e2e');
    const link = path.join(tmp, 'home-link');
    fs.symlinkSync(os.homedir(), link);
    accountHome(link);
    expect(claudeSettingsWriteRefusal()).toContain('isolated instance');
  });

  it.skipIf(process.platform === 'linux')('counts a home that differs only by case as the real one, resolved or not', () => {
    vi.stubEnv('WMUX_DATA_SUFFIX', '-e2e');
    accountHome(os.homedir().toUpperCase());
    expect(claudeSettingsWriteRefusal()).toContain('isolated instance');
    // realpath gives the case on disk; where it cannot run, case still does not count.
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => { throw new Error('EACCES: injected'); });
    expect(claudeSettingsWriteRefusal()).toContain('isolated instance');
  });

  it('refuses when the account\'s home cannot be read', () => {
    vi.stubEnv('WMUX_DATA_SUFFIX', '-e2e');
    vi.spyOn(os, 'userInfo').mockImplementation(() => { throw new Error('ENOENT: no passwd entry'); });
    expect(claudeSettingsWriteRefusal()).toContain('isolated instance');
  });
});
