/**
 * ACCOUNT_ADD_WITH_TOKEN creates a Claude account from the token on the
 * clipboard, all or nothing: a clipboard without a token creates nothing, and
 * a failed vault save removes the account and the folder it provisioned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clipboard, ipcMain } from 'electron';
import { IPC } from '../../../../shared/constants';
import { AccountStore } from '../../../account/accountStore';
import type { AccountVaultEntry, AccountVaultSetResult } from '../../../account/accountVault';
import { registerAccountHandlers } from '../account.handler';

const TOKEN = `sk-ant-oat01-${'x'.repeat(40)}`;

const h = vi.hoisted(() => ({
  clip: '',
  wmuxDir: '',
  sourceDir: '',
  store: null as unknown as AccountStore,
  vaultSet: null as unknown as (accountId: string, name: unknown, value: unknown, opts?: { inject?: boolean }) => AccountVaultSetResult,
  setInjectCalls: 0,
  saved: [] as AccountVaultEntry[],
}));

vi.mock('electron', () => ({
  clipboard: {
    readText: vi.fn(async () => h.clip),
    clear: vi.fn(async () => { h.clip = ''; }),
  },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
}));
vi.mock('../../mainWindowSender', () => ({ isMainWindowSender: () => true }));
vi.mock('../../../../daemon/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../daemon/config')>()),
  getWmuxDir: () => h.wmuxDir,
}));
vi.mock('../../../account/accountStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../account/accountStore')>()),
  getAccountStore: () => h.store,
}));
vi.mock('../../../account/accountVault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../account/accountVault')>()),
  appAccountVault: () => ({
    set: (accountId: string, name: unknown, value: unknown, opts?: { inject?: boolean }) => h.vaultSet(accountId, name, value, opts),
    setInject: () => { h.setInjectCalls += 1; return true; },
    list: (accountId: string) => h.saved.filter((e) => e.accountId === accountId),
    deleteAccount: () => true,
  }),
}));
vi.mock('../../../account/claudeOnboardingFlag', () => ({
  markClaudeOnboardingDone: vi.fn(() => ({ ok: true, changed: true })),
}));
vi.mock('../hooksBridge.handler', () => ({ installHooksIntoNewAccount: async () => null }));
vi.mock('../../../hooks/claudeConfigDirProbe', () => ({ claudeConfigDirEnv: async () => undefined }));
// Share from a temp "default" folder, never the real ~/.claude.
vi.mock('../../../../shared/claudeConfigTargets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../shared/claudeConfigTargets')>()),
  envClaudeConfigDir: () => ({ dir: h.sourceDir }),
}));

let tmp: string;

function addWithToken(args: Record<string, unknown>): Promise<unknown> {
  registerAccountHandlers();
  const call = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === IPC.ACCOUNT_ADD_WITH_TOKEN);
  if (!call) throw new Error('no ACCOUNT_ADD_WITH_TOKEN handler');
  return (call[1] as (e: unknown, a: unknown) => Promise<unknown>)({}, args);
}

function saveFromClipboard(args: Record<string, unknown>): Promise<unknown> {
  registerAccountHandlers();
  const call = vi.mocked(ipcMain.handle).mock.calls.find((c) => c[0] === IPC.ACCOUNT_VAULT_SAVE_CLIPBOARD);
  if (!call) throw new Error('no ACCOUNT_VAULT_SAVE_CLIPBOARD handler');
  return (call[1] as (e: unknown, a: unknown) => Promise<unknown>)({}, args);
}

const accountFolders = (): string[] => {
  const root = path.join(h.wmuxDir, 'accounts');
  return fs.existsSync(root) ? fs.readdirSync(root) : [];
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-acct-token-'));
  h.wmuxDir = path.join(tmp, 'wmux');
  h.sourceDir = path.join(tmp, 'claude-home');
  fs.mkdirSync(path.join(h.sourceDir, 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(h.sourceDir, 'skills', 'mine', 'SKILL.md'), 'shared\n');
  fs.writeFileSync(path.join(h.sourceDir, 'settings.json'), '{}\n');
  h.store = new AccountStore(path.join(tmp, 'data'));
  h.saved = [];
  h.setInjectCalls = 0;
  h.vaultSet = (accountId, name, value) => {
    const entry = { accountId, name, createdAt: 1, updatedAt: 1, inject: true, usable: true } as unknown as AccountVaultEntry;
    expect(value).toBe(TOKEN);
    h.saved.push(entry);
    return { ok: true, entry };
  };
  vi.mocked(ipcMain.handle).mockClear();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ACCOUNT_ADD_WITH_TOKEN', () => {
  it('creates nothing when the clipboard holds no setup-token token', async () => {
    h.clip = 'some other text';
    const res = await addWithToken({ name: 'Work' });
    expect(res).toMatchObject({ ok: false, code: 'prefix_mismatch' });
    expect(h.store.listAccounts()).toEqual([]);
    expect(accountFolders()).toEqual([]);
    expect(h.clip).toBe('some other text');
  });

  it('adds the account, saves the token, clears the clipboard and sets the group', async () => {
    h.clip = `  ${TOKEN}\n`;
    const res = await addWithToken({ name: 'Work', group: 'Team' }) as { ok: true; account: { id: string; vendor: string; configDir: string; group?: string }; clipboardCleared: boolean };
    expect(res.ok).toBe(true);
    expect(res.account.vendor).toBe('claude');
    expect(res.account.group).toBe('Team');
    expect(res.clipboardCleared).toBe(true);
    expect(h.clip).toBe('');
    expect(h.saved.map((e) => e.name)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
    expect(h.store.listAccounts().map((a) => a.id)).toEqual([res.account.id]);
    expect(fs.existsSync(path.join(res.account.configDir, 'settings.json'))).toBe(true);
    expect(fs.lstatSync(path.join(res.account.configDir, 'skills')).isSymbolicLink()).toBe(true);
    // The token never comes back to the renderer.
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it('removes the account and its folder when the vault save fails, leaving shared folders intact', async () => {
    h.clip = TOKEN;
    h.vaultSet = () => ({ ok: false, code: 'encryption_unavailable', message: 'no encrypted storage' });
    const res = await addWithToken({ name: 'Work' });
    expect(res).toMatchObject({ ok: false, code: 'encryption_unavailable' });
    expect(h.store.listAccounts()).toEqual([]);
    expect(accountFolders()).toEqual([]);
    // The folder held a directory link to the shared skills folder: the link
    // was removed, the shared folder and the file in it were not.
    expect(fs.readFileSync(path.join(h.sourceDir, 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('shared\n');
    expect(fs.existsSync(path.join(h.sourceDir, 'settings.json'))).toBe(true);
    // Nothing was saved, so the clipboard is left as it was.
    expect(h.clip).toBe(TOKEN);
  });

  it('keeps the folder, never emptying it, when it holds a real non-empty subdirectory', async () => {
    h.clip = TOKEN;
    let configDir = '';
    h.vaultSet = (accountId) => {
      configDir = h.store.getAccount(accountId)?.configDir ?? '';
      fs.mkdirSync(path.join(configDir, 'projects'));
      fs.writeFileSync(path.join(configDir, 'projects', 'keep.txt'), 'keep\n');
      return { ok: false, code: 'write_failed', message: 'write failed' };
    };
    const res = await addWithToken({ name: 'Work' });
    expect(res).toMatchObject({ ok: false, code: 'write_failed' });
    expect(h.store.listAccounts()).toEqual([]);
    expect(fs.readFileSync(path.join(configDir, 'projects', 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(fs.existsSync(path.join(configDir, 'skills'))).toBe(false);
    expect(fs.readFileSync(path.join(h.sourceDir, 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('shared\n');
  });

  it('touches nothing when the folder was replaced by a link before the rollback', async () => {
    h.clip = TOKEN;
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'mine\n');
    let configDir = '';
    h.vaultSet = (accountId) => {
      configDir = h.store.getAccount(accountId)?.configDir ?? '';
      fs.renameSync(configDir, `${configDir}.moved`);
      fs.symlinkSync(outside, configDir, 'dir');
      return { ok: false, code: 'write_failed', message: 'write failed' };
    };
    const res = await addWithToken({ name: 'Work' });
    expect(res).toMatchObject({ ok: false, code: 'write_failed' });
    expect(h.store.listAccounts()).toEqual([]);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('mine\n');
    expect(fs.lstatSync(configDir).isSymbolicLink()).toBe(true);
  });

  it('keeps the account when clearing the clipboard fails after the token is saved', async () => {
    h.clip = TOKEN;
    vi.mocked(clipboard.readText).mockResolvedValueOnce(TOKEN).mockRejectedValueOnce(new Error('clipboard busy'));
    const res = await addWithToken({ name: 'Work' }) as { ok: boolean; account: { id: string }; clipboardCleared: boolean; clipboardCleanupFailed?: true };
    expect(res).toMatchObject({ ok: true, clipboardCleared: false, clipboardCleanupFailed: true });
    expect(h.store.listAccounts().map((a) => a.id)).toEqual([res.account.id]);
    expect(h.saved.map((e) => e.name)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
  });
});

describe('ACCOUNT_VAULT_SAVE_CLIPBOARD', () => {
  const VALUE = 'hf_example_value_0123456789';

  it('saves inject: false with the value in one write, with no follow-up setInject', async () => {
    const account = await h.store.addAccount({ name: 'Codex', vendor: 'codex', configDir: h.sourceDir });
    const calls: Array<{ inject?: boolean } | undefined> = [];
    h.vaultSet = (accountId, name, value, opts) => {
      calls.push(opts);
      const entry = { accountId, name, createdAt: 1, updatedAt: 1, inject: opts?.inject ?? true, usable: true } as unknown as AccountVaultEntry;
      return { ok: true, entry };
    };
    h.clip = VALUE;
    const res = await saveFromClipboard({ accountId: account.id, name: 'HF_TOKEN', inject: false });
    expect(res).toMatchObject({ ok: true, entry: { name: 'HF_TOKEN', inject: false }, clipboardCleared: true });
    expect(calls).toEqual([{ inject: false }]);
    expect(h.setInjectCalls).toBe(0);
  });

  it('tells a prefix mismatch apart from an invalid value', async () => {
    const account = await h.store.addAccount({ name: 'Codex', vendor: 'codex', configDir: h.sourceDir });
    h.vaultSet = () => { throw new Error('nothing is saved on a prefix mismatch'); };
    h.clip = VALUE;
    const res = await saveFromClipboard({ accountId: account.id, name: 'HF_TOKEN', expectPrefix: 'ghp_' });
    expect(res).toMatchObject({ ok: false, code: 'prefix_mismatch' });
    expect(h.clip).toBe(VALUE);
  });
});
