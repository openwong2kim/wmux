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
import { installHooks, statusHooks, removeHooks, type InstallOutcome, type SetupHooksPaths } from '../../../../cli/commands/setupHooks';
import type { Account } from '../../../account/accountStore';
import { accountHookDrift, installHooksIntoNewAccount, registerHooksBridgeHandlers } from '../hooksBridge.handler';

vi.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
}));
// No login-shell probe from a test. By default CLAUDE_CONFIG_DIR reads as
// unset, so the default folder is the one defaultPaths() names; a test can
// queue what the Install's read of the shell returns.
const probe = vi.hoisted(() => ({ reads: [] as Array<{ value: string | undefined; read: boolean }> }));
vi.mock('../../../hooks/claudeConfigDirProbe', () => ({
  INSTALL_PROBE_TIMEOUT_MS: 5000,
  claudeConfigDirEnv: async () => undefined,
  readClaudeConfigDirEnv: async () => probe.reads.shift() ?? { value: undefined, read: true },
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
  probe.reads = [];
  vi.mocked(ipcMain.handle).mockClear();
  // A packaged, unsuffixed instance: the only one these handlers write from.
  vi.stubEnv('WMUX_DATA_SUFFIX', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
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

describe('Install covers every Claude folder (CLAUDE_CONFIG_DIR unset)', () => {
  const hooksIn = (dir: string) => statusHooks({ ...base, settingsPath: path.join(dir, 'settings.json') }).installedEvents.length;

  it('writes the default folder and every Claude account folder; a Codex account is left alone', async () => {
    const a = path.join(tmp, 'acct-a');
    const b = path.join(tmp, 'acct-b');
    const codex = path.join(tmp, 'codex-c');
    for (const dir of [a, b, codex]) fs.mkdirSync(dir, { recursive: true });
    accounts.list = [account('a', a), account('b', b), account('c', codex, 'codex')];
    const out = await handlerFor(IPC.HOOKS_BRIDGE_INSTALL)({}) as InstallOutcome;
    expect(out.ok).toBe(true);
    expect(out.settingsPath).toBe(base.settingsPath);
    expect(hooksIn(a)).toBeGreaterThan(0);
    expect(hooksIn(b)).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(codex, 'settings.json'))).toBe(false);
  });

  it('one corrupt account file fails only itself: the others are written, the result names it', async () => {
    const a = path.join(tmp, 'acct-a');
    const bad = path.join(tmp, 'acct-bad');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'settings.json'), '{ not json', 'utf8');
    accounts.list = [account('a', a), account('bad', bad)];
    const out = await handlerFor(IPC.HOOKS_BRIDGE_INSTALL)({}) as InstallOutcome;
    expect(out.ok).toBe(false);
    expect(out.error).toContain('acct bad');
    expect(hooksIn(a)).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(bad, 'settings.json'), 'utf8')).toBe('{ not json');
  });

  it('a shell that never answered is said, not hidden; once it answers, the env folder is written', async () => {
    const envDir = path.join(tmp, 'cfg-env');
    fs.mkdirSync(envDir, { recursive: true });
    probe.reads = [{ value: undefined, read: false }, { value: envDir, read: true }];
    const install = handlerFor(IPC.HOOKS_BRIDGE_INSTALL);

    const first = await install({}) as InstallOutcome;
    expect(first.ok).toBe(true);
    expect(first.settingsPath).toBe(base.settingsPath);
    expect(first.warning).toContain('Could not read CLAUDE_CONFIG_DIR');
    expect(fs.existsSync(path.join(envDir, 'settings.json'))).toBe(false);

    const second = await install({}) as InstallOutcome;
    expect(second.ok).toBe(true);
    expect(second.settingsPath).toBe(path.join(envDir, 'settings.json'));
    expect(second.warning).toBeNull();
    expect(hooksIn(envDir)).toBeGreaterThan(0);
  });

  it('a new account folder gets the hooks when the default folder has them, and not otherwise', async () => {
    const fresh = path.join(tmp, 'acct-new');
    fs.mkdirSync(fresh, { recursive: true });
    const out = await installHooksIntoNewAccount(fresh);
    expect(out?.ok).toBe(true);
    expect(hooksIn(fresh)).toBeGreaterThan(0);

    removeHooks(base);
    const other = path.join(tmp, 'acct-new-2');
    fs.mkdirSync(other, { recursive: true });
    expect(await installHooksIntoNewAccount(other)).toBeNull();
    expect(fs.existsSync(path.join(other, 'settings.json'))).toBe(false);
  });
});
