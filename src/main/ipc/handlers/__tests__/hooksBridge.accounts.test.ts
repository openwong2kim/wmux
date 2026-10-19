/**
 * Account folders keep their own copy of Claude settings.json, made once when
 * the account was added. The hook-set check lists each copy that drifted from
 * what this build expects, and the same Update brings one up to date, by
 * account id only. Nothing writes without that call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../../../shared/constants';
import { installHooks, statusHooks, type SetupHooksPaths } from '../../../../cli/commands/setupHooks';
import type { Account } from '../../../account/accountStore';
import { accountHookDrift, registerHooksBridgeHandlers } from '../hooksBridge.handler';

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
}));

const accounts = vi.hoisted(() => ({ list: [] as Account[], base: null as SetupHooksPaths | null }));
vi.mock('../../../account/accountStore', () => ({
  getAccountStore: () => ({ listAccounts: () => accounts.list }),
}));
vi.mock('../../../../cli/commands/setupHooks', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../cli/commands/setupHooks')>();
  return { ...real, defaultPaths: () => accounts.base as SetupHooksPaths };
});

let tmp: string;
let base: SetupHooksPaths;

const account = (id: string, configDir: string, vendor: Account['vendor'] = 'claude'): Account =>
  ({ id, name: `acct ${id}`, vendor, configDir, createdAt: 0 });

/** An account folder provisioned from the default config, minus one hook. */
function staleCopy(dir: string, drop: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const settings = JSON.parse(fs.readFileSync(base.settingsPath, 'utf8')) as { hooks: Record<string, unknown> };
  delete settings.hooks[drop];
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings), 'utf8');
}

function handlerFor(channel: string): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  registerHooksBridgeHandlers();
  const call = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`no handler for ${channel}`);
  return call[1] as unknown as (event: unknown, ...args: unknown[]) => Promise<unknown>;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-acct-hooks-'));
  const bridgeSource = path.join(tmp, 'src-bridge.mjs');
  fs.writeFileSync(bridgeSource, 'BRIDGE\n', 'utf8');
  base = { settingsPath: path.join(tmp, '.claude', 'settings.json'), bridgeDest: path.join(tmp, '.wmux', 'hooks', 'wmux-bridge.mjs'), bridgeSource };
  expect(installHooks(base).ok).toBe(true);
  accounts.base = base;
  accounts.list = [];
  vi.mocked(ipcMain.handle).mockClear();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('account folders in the hook-set check', () => {
  it('lists a Claude account copy that lacks an expected hook, and nothing else', () => {
    const stale = path.join(tmp, 'acct-a');
    staleCopy(stale, 'StopFailure');
    const current = path.join(tmp, 'acct-b');
    fs.mkdirSync(current);
    fs.copyFileSync(base.settingsPath, path.join(current, 'settings.json'));
    const bare = path.join(tmp, 'acct-c'); // no wmux install at all: an install, not drift
    fs.mkdirSync(bare);
    fs.writeFileSync(path.join(bare, 'settings.json'), '{}', 'utf8');
    const list = [
      account('a', stale), account('b', current), account('c', bare),
      account('d', path.join(tmp, 'codex'), 'codex'),
      account('default', path.dirname(base.settingsPath)), // the card's own row covers it
    ];
    expect(accountHookDrift(list, base)).toEqual([{ accountId: 'a', name: 'acct a', stale: ['StopFailure'] }]);
  });

  it('skips a settings file that is the default one or another account\'s by another name, and UNC folders', () => {
    const real = path.join(tmp, 'acct-a');
    staleCopy(real, 'StopFailure');
    const alias = path.join(tmp, 'acct-alias');
    fs.symlinkSync(real, alias);
    const linkedToDefault = path.join(tmp, 'acct-l');
    fs.mkdirSync(linkedToDefault);
    fs.symlinkSync(base.settingsPath, path.join(linkedToDefault, 'settings.json'));
    const list = [account('a', real), account('alias', alias), account('l', linkedToDefault), account('w', '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude')];
    expect(accountHookDrift(list, base).map((d) => d.accountId)).toEqual(['a']);
  });

  it('reports drift through status, and Update writes only the account named by id', async () => {
    const dir = path.join(tmp, 'acct-a');
    staleCopy(dir, 'StopFailure');
    accounts.list = [account('a', dir)];
    const defaultBefore = fs.readFileSync(base.settingsPath, 'utf8');

    const status = await handlerFor(IPC.HOOKS_BRIDGE_STATUS)({}) as { accounts: unknown[] };
    expect(status.accounts).toEqual([{ accountId: 'a', name: 'acct a', stale: ['StopFailure'] }]);

    const update = handlerFor(IPC.HOOKS_BRIDGE_UPDATE_ACCOUNT);
    await expect(update({}, 'a')).resolves.toMatchObject({ ok: true, updated: ['StopFailure'] });
    expect(statusHooks({ ...base, settingsPath: path.join(dir, 'settings.json') }).updateAvailable).toBe(false);
    expect(fs.readFileSync(base.settingsPath, 'utf8')).toBe(defaultBefore);
  });

  it('refuses anything but a known Claude account id with a wmux install to update', async () => {
    const bare = path.join(tmp, 'acct-bare');
    fs.mkdirSync(bare);
    fs.writeFileSync(path.join(bare, 'settings.json'), '{}', 'utf8');
    accounts.list = [account('x', path.join(tmp, 'codex'), 'codex'), account('bare', bare)];
    const update = handlerFor(IPC.HOOKS_BRIDGE_UPDATE_ACCOUNT);
    await expect(update({}, 'bare')).rejects.toThrow();
    expect(fs.readFileSync(path.join(bare, 'settings.json'), 'utf8')).toBe('{}');
    await expect(update({}, path.join(tmp, 'acct-a'))).rejects.toThrow();
    await expect(update({}, 'x')).rejects.toThrow();
    await expect(update({}, 42)).rejects.toThrow();
  });

  it('refuses an account the status does not list: an alias of another account\'s settings, or one already current', async () => {
    const real = path.join(tmp, 'acct-a');
    staleCopy(real, 'StopFailure');
    const alias = path.join(tmp, 'acct-alias');
    fs.symlinkSync(real, alias);
    const current = path.join(tmp, 'acct-b');
    fs.mkdirSync(current);
    fs.copyFileSync(base.settingsPath, path.join(current, 'settings.json'));
    accounts.list = [account('a', real), account('alias', alias), account('b', current)];
    const before = fs.readFileSync(path.join(real, 'settings.json'), 'utf8');
    const update = handlerFor(IPC.HOOKS_BRIDGE_UPDATE_ACCOUNT);
    await expect(update({}, 'alias')).rejects.toThrow(/not listed/);
    await expect(update({}, 'b')).rejects.toThrow(/not listed/);
    expect(fs.readFileSync(path.join(real, 'settings.json'), 'utf8')).toBe(before);
  });
});
