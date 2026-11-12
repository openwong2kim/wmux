import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

import {
  ACCOUNT_VAULT_PER_ACCOUNT_MAX,
  AccountVault,
  createAccountOverride,
  mergeVaultSecretEnv,
  noteVaultSignInPane,
  paneHasVaultSignIn,
  vaultAccountsForCreate,
  withAccountFolderEnv,
  vaultEligibleCreate,
  vaultOnlyClaudeAccount,
  type AccountVaultEntry,
} from '../accountVault';
import type { Account } from '../accountStore';
import type { SecretCrypto, SecretCryptoState } from '../../factory/secretStore';
import {
  __resetRedactedSecretsForTesting,
  redactStoredSecrets,
  setRedactedSecrets,
} from '../../factory/secretRedaction';
import { BOT_SECRET_LIMITS } from '../../../shared/botSecret';
import { readSourceText } from '../../../test-utils/sourceText';

function fakeCrypto(state: SecretCryptoState = 'ok'): SecretCrypto {
  return {
    state: () => state,
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').reverse().toString('hex')}`),
    decrypt: (cipher) => {
      const text = cipher.toString();
      if (!text.startsWith('enc:')) throw new Error('bad cipher');
      return Buffer.from(text.slice(4), 'hex').reverse().toString('utf8');
    },
  };
}

const TOKEN = 'ghp_example_value_0123456789';
let dir = '';
let file = '';
const vault = (state: SecretCryptoState = 'ok') => new AccountVault({ file, crypto: fakeCrypto(state), log: () => undefined });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-vault-'));
  file = path.join(dir, 'accounts', 'vault.json');
  __resetRedactedSecretsForTesting();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  __resetRedactedSecretsForTesting();
});

describe('AccountVault', () => {
  it('stores ciphertext only and lists metadata, never a value', () => {
    const v = vault();
    v.load();
    const r = v.set('acc-1', 'GITHUB_TOKEN', TOKEN);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(TOKEN);
    const listed = v.list('acc-1');
    expect(listed).toEqual([expect.objectContaining({ accountId: 'acc-1', name: 'GITHUB_TOKEN', inject: true, length: TOKEN.length, usable: true })]);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    expect(v.list('acc-2')).toEqual([]);
  });

  it('saves inject: false with the value in one write, and an explicit choice wins over a replaced entry', () => {
    const v = vault();
    v.load();
    const writes = vi.spyOn(fs, 'writeFileSync');
    try {
      expect(v.set('acc-1', 'GITHUB_TOKEN', TOKEN, { inject: false }).ok).toBe(true);
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      writes.mockRestore();
    }
    expect(v.list('acc-1')).toEqual([expect.objectContaining({ name: 'GITHUB_TOKEN', inject: false })]);
    expect(v.envFor([{ id: 'acc-1', vendor: 'claude' }])).toEqual({});
    // A replace without a choice keeps the setting; one with a choice saves it.
    v.set('acc-1', 'GITHUB_TOKEN', `${TOKEN}_2`);
    expect(v.list('acc-1')[0].inject).toBe(false);
    v.set('acc-1', 'GITHUB_TOKEN', `${TOKEN}_3`, { inject: true });
    expect(v.list('acc-1')[0].inject).toBe(true);
  });

  it('reloads and decrypts what it wrote, and drops entries of removed accounts', () => {
    const a = vault();
    a.load();
    a.set('acc-1', 'GITHUB_TOKEN', TOKEN);
    a.set('gone', 'HF_TOKEN', 'hf_example_value_0123');
    const b = vault();
    b.load(new Set(['acc-1']));
    expect(b.envFor([{ id: 'acc-1', vendor: 'claude' }, { id: 'gone', vendor: 'codex' }])).toEqual({ GITHUB_TOKEN: TOKEN });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('"gone"');
  });

  it('injects only entries marked inject, first bound account winning a shared name', () => {
    const v = vault();
    v.load();
    v.set('claude-acc', 'GITHUB_TOKEN', TOKEN);
    v.set('codex-acc', 'GITHUB_TOKEN', 'ghp_other_value_987654321');
    v.set('codex-acc', 'HF_TOKEN', 'hf_example_value_0123', { inject: false });
    expect(v.envFor([{ id: 'claude-acc', vendor: 'claude' }, { id: 'codex-acc', vendor: 'codex' }])).toEqual({ GITHUB_TOKEN: TOKEN });
    expect(v.setInject('codex-acc', 'HF_TOKEN', true)).toBe(true);
    expect(v.envFor([{ id: 'codex-acc', vendor: 'codex' }])).toEqual({ GITHUB_TOKEN: 'ghp_other_value_987654321', HF_TOKEN: 'hf_example_value_0123' });
  });

  it('takes a vendor\'s sign-in variables only from an account of that vendor', () => {
    const v = vault();
    v.load();
    v.set('codex-acc', 'ANTHROPIC_API_KEY', 'sk-ant-example-value-01');
    v.set('codex-acc', 'OPENAI_API_KEY', 'sk-openai-example-value');
    v.set('claude-acc', 'CLAUDE_CODE_OAUTH_TOKEN', 'oauth-example-value-01');
    expect(v.envFor([{ id: 'claude-acc', vendor: 'claude' }, { id: 'codex-acc', vendor: 'codex' }])).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-example-value-01',
      OPENAI_API_KEY: 'sk-openai-example-value',
    });
  });

  it('refuses names that are not credential env vars, short or multi-line values, and too many entries', () => {
    const v = vault();
    v.load();
    expect(v.set('acc-1', 'PATH', TOKEN)).toMatchObject({ ok: false, code: 'invalid_name' });
    expect(v.set('acc-1', 'WMUX_TOKEN', TOKEN)).toMatchObject({ ok: false, code: 'invalid_name' });
    expect(v.set('acc-1', 'GITHUB_TOKEN', 'short')).toMatchObject({ ok: false, code: 'invalid_value' });
    expect(v.set('acc-1', 'GITHUB_TOKEN', `${TOKEN}\nmore`)).toMatchObject({ ok: false, code: 'invalid_value' });
    for (let i = 0; i < ACCOUNT_VAULT_PER_ACCOUNT_MAX; i++) {
      expect(v.set('acc-1', `SERVICE${i}_TOKEN`, `${TOKEN}${i}`).ok).toBe(true);
    }
    expect(v.set('acc-1', 'ONE_MORE_TOKEN', TOKEN)).toMatchObject({ ok: false, code: 'too_many' });
  });

  it('saves nothing without real encryption', () => {
    const v = vault('basic_text');
    v.load();
    expect(v.set('acc-1', 'GITHUB_TOKEN', TOKEN)).toMatchObject({ ok: false, code: 'basic_text' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('never writes over a file it cannot read', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json');
    const v = vault();
    v.load();
    expect(v.set('acc-1', 'GITHUB_TOKEN', TOKEN)).toMatchObject({ ok: false, code: 'store_unreadable' });
    expect(fs.readFileSync(file, 'utf8')).toBe('not json');
  });

  it('removes an account\'s entries with the account', () => {
    const v = vault();
    v.load();
    v.set('acc-1', 'GITHUB_TOKEN', TOKEN);
    v.set('acc-2', 'HF_TOKEN', 'hf_example_value_0123');
    v.deleteAccount('acc-1');
    expect(v.list('acc-1')).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('acc-1');
    expect(v.delete('acc-2', 'HF_TOKEN')).toBe(true);
    expect(v.envFor([{ id: 'acc-2', vendor: 'claude' }])).toEqual({});
  });

  it('redacts vault values without dropping the bot store\'s', () => {
    setRedactedSecrets([{ name: 'BOT_KEY', value: 'bot_secret_value_123' }]);
    const v = vault();
    v.load();
    v.set('acc-1', 'GITHUB_TOKEN', TOKEN);
    const out = redactStoredSecrets(`a ${TOKEN} b bot_secret_value_123`);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('bot_secret_value_123');
  });
});

describe('who gets the vault', () => {
  it('a pane created for a bound workspace, never a bot, fan-out task or another PC\'s pane', () => {
    expect(vaultEligibleCreate({ workspaceId: 'ws-1' }, null)).toBe(true);
    expect(vaultEligibleCreate({ workspaceId: 'ws-1' }, { botId: 'b' })).toBe(false);
    expect(vaultEligibleCreate({ workspaceId: 'ws-1', fanoutTaskOf: 'task' }, null)).toBe(false);
    expect(vaultEligibleCreate({ workspaceId: 'ws-1', remoteSpawnOf: 'pc' }, null)).toBe(false);
    expect(vaultEligibleCreate({ workspaceId: 'ws-1', ignoreAccountBinding: true }, null)).toBe(false);
    expect(vaultEligibleCreate(undefined, null)).toBe(false);
  });

  it('a bot grant wins a name clash, and names over the daemon limit are left out, not failed', () => {
    expect(mergeVaultSecretEnv({ GITHUB_TOKEN: 'grant_value_123' }, { GITHUB_TOKEN: TOKEN, HF_TOKEN: 'hf_example_value_0123' }))
      .toEqual({ env: { GITHUB_TOKEN: 'grant_value_123', HF_TOKEN: 'hf_example_value_0123' }, dropped: [] });
    const full = Object.fromEntries(Array.from({ length: BOT_SECRET_LIMITS.NAMES_PER_FANOUT }, (_, i) => [`G${i}_TOKEN`, `grant_value_${i}x`]));
    const merged = mergeVaultSecretEnv(full, { HF_TOKEN: 'hf_example_value_0123' });
    expect(Object.keys(merged.env ?? {})).toHaveLength(BOT_SECRET_LIMITS.NAMES_PER_FANOUT);
    expect(merged.dropped).toEqual(['HF_TOKEN']);
    expect(mergeVaultSecretEnv(undefined, {})).toEqual({ env: null, dropped: [] });
  });

  it('names a Claude account that signs in only from its vault, for a launch without the daemon', async () => {
    const entry = (accountId: string, name: string, over: Partial<AccountVaultEntry> = {}): AccountVaultEntry =>
      ({ accountId, name, inject: true, usable: true, length: 40, createdAt: 1, updatedAt: 1, fingerprint: null, ...over });
    const vaults: Record<string, AccountVaultEntry[]> = {
      tok: [entry('tok', 'CLAUDE_CODE_OAUTH_TOKEN')],
      both: [entry('both', 'CLAUDE_CODE_OAUTH_TOKEN')],
      off: [entry('off', 'CLAUDE_CODE_OAUTH_TOKEN', { inject: false })],
      gh: [entry('gh', 'GITHUB_TOKEN')],
    };
    const deps = {
      entries: (id: string) => vaults[id] ?? [],
      account: (id: string) => ({ name: `acct ${id}`, configDir: `/accounts/${id}` }),
      folderSignedIn: async (dir: string) => dir.endsWith('/both'),
    };
    expect(await vaultOnlyClaudeAccount([{ id: 'tok', vendor: 'claude' }], deps)).toBe('acct tok');
    // A folder with its own login, a value the pane would not get, or no sign-in name: no refusal.
    expect(await vaultOnlyClaudeAccount([{ id: 'both', vendor: 'claude' }], deps)).toBeNull();
    expect(await vaultOnlyClaudeAccount([{ id: 'off', vendor: 'claude' }], deps)).toBeNull();
    expect(await vaultOnlyClaudeAccount([{ id: 'gh', vendor: 'claude' }, { id: 'tok', vendor: 'codex' }], deps)).toBeNull();
    expect(await vaultOnlyClaudeAccount([], deps)).toBeNull();
  });
});

describe('the account a create names', () => {
  const tokenAccount: Account = { id: 'acc-token', name: 'Token', vendor: 'claude', configDir: '/acc/token', createdAt: 1 };
  const deps = { account: (id: string) => (id === tokenAccount.id ? tokenAccount : undefined), dirOk: () => true };

  it('resolves only a registered account whose folder exists; anything else refuses the create', () => {
    expect(createAccountOverride({}, deps)).toBeUndefined();
    expect(createAccountOverride(undefined, deps)).toBeUndefined();
    expect(createAccountOverride({ accountId: 'acc-token' }, deps)).toBe(tokenAccount);
    expect(() => createAccountOverride({ accountId: 'acc-unknown' }, deps)).toThrow(/unknown account/);
    expect(() => createAccountOverride({ accountId: '../x' }, deps)).toThrow(/invalid account id/);
    expect(() => createAccountOverride({ accountId: 42 }, deps)).toThrow(/invalid account id/);
    expect(() => createAccountOverride({ accountId: 'acc-token' }, { ...deps, dirOk: () => false })).toThrow(/folder is missing/);
    expect(() => createAccountOverride({ accountId: 'acc-token', ignoreAccountBinding: true }, deps)).toThrow(/takes no account/);
  });

  it('a rotated launch whose account folder went since the pick starts on the bound account instead of failing', () => {
    const gone = { ...deps, dirOk: () => false, missingFolder: 'skip' as const };
    expect(createAccountOverride({ accountId: 'acc-token' }, gone)).toBeUndefined();
    // Only the folder is forgiven: an unknown id still refuses.
    expect(() => createAccountOverride({ accountId: 'acc-unknown' }, gone)).toThrow(/unknown account/);
  });

  it('sets its folder in the pane env over a profile folder, in any case', () => {
    expect(withAccountFolderEnv({ CLAUDE_CONFIG_DIR: '/profile/dir', claude_config_dir: '/x', FOO: '1' }, tokenAccount))
      .toEqual({ CLAUDE_CONFIG_DIR: '/acc/token', FOO: '1' });
    expect(withAccountFolderEnv(undefined, { vendor: 'codex', configDir: '/acc/codex' })).toEqual({ CODEX_HOME: '/acc/codex' });
  });

  it('remembers a pane that spawned with a Claude sign-in name from a vault, and only that', () => {
    noteVaultSignInPane('daemon-sign', ['GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
    noteVaultSignInPane('daemon-other', ['GITHUB_TOKEN', 'OPENAI_API_KEY']);
    noteVaultSignInPane('daemon-key', ['ANTHROPIC_API_KEY']);
    expect(paneHasVaultSignIn('daemon-sign')).toBe(true);
    expect(paneHasVaultSignIn('daemon-key')).toBe(true);
    expect(paneHasVaultSignIn('daemon-other')).toBe(false);
    expect(paneHasVaultSignIn('daemon-never')).toBe(false);
  });

  it('stands in for the bound account of its vendor in the vault, and ineligible creates still get none', () => {
    const binding = (_ws: string, vendor: 'claude' | 'codex') => (vendor === 'claude' ? 'acc-bound' : 'acc-codex');
    expect(vaultAccountsForCreate({ workspaceId: 'ws-1' }, null, binding)).toEqual([
      { id: 'acc-bound', vendor: 'claude' }, { id: 'acc-codex', vendor: 'codex' },
    ]);
    expect(vaultAccountsForCreate({ workspaceId: 'ws-1' }, null, binding, tokenAccount)).toEqual([
      { id: 'acc-token', vendor: 'claude' }, { id: 'acc-codex', vendor: 'codex' },
    ]);
    // A workspace bound to nothing still gets the named account.
    expect(vaultAccountsForCreate({ workspaceId: 'ws-1' }, null, () => undefined, tokenAccount)).toEqual([{ id: 'acc-token', vendor: 'claude' }]);
    for (const [options, bot] of [
      [{ workspaceId: 'ws-1' }, { botId: 'b' }],
      [{ workspaceId: 'ws-1', fanoutTaskOf: 'task' }, null],
      [{ workspaceId: 'ws-1', remoteSpawnOf: 'pc' }, null],
      [{ workspaceId: 'ws-1', ignoreAccountBinding: true }, null],
      [{}, null],
    ] as const) {
      expect(vaultAccountsForCreate(options, bot, binding, tokenAccount)).toEqual([]);
    }
  });

  it('is resolved in the create, feeds both the pane env and the vault, and an exec unit gets no vault', () => {
    const src = readSourceText(path.join(__dirname, '..', '..', 'ipc', 'handlers', 'pty.handler.ts'));
    const resolved = src.indexOf("const accountOverride = closingLeases(() => createAccountOverride(options, { missingFolder: namedAccount === undefined ? 'skip' : 'refuse' }));");
    expect(resolved).toBeGreaterThan(src.indexOf('options = staged.options;'));
    // The caller's own id is read before staging, so only a rotated one is forgiven a missing folder.
    expect(src.indexOf('const namedAccount = options?.accountId;')).toBeLessThan(src.indexOf('staged = await stageCreate(options, botWorker, gateway?.launch);'));
    expect(src).toContain('if (accountOverride) options = { ...options, env: withAccountFolderEnv(options?.env, accountOverride) };');
    expect(src).toContain('execCommand !== undefined || supervisionPolicy !== undefined, accountOverride));');
    expect(src).toContain('noteVaultSignInPane(sessionId,');
    expect(src).toMatch(/if \(execUnit \|\| !options\?\.workspaceId\) return secretEnv;/);
  });
});

describe('the pty create wiring', () => {
  const src = readSourceText(path.join(__dirname, '..', '..', 'ipc', 'handlers', 'pty.handler.ts'));

  it('checks the grant folder on the bot grant alone, then adds the vault, and sends the merged env', () => {
    const refusal = src.indexOf('secretCreateCwdRefusal(grantedCwd, cwdResolution)');
    const vaultJoin = src.indexOf('const createSecretEnv = closingLeases(() => withAccountVaultEnv(');
    expect(refusal).toBeGreaterThan(-1);
    expect(vaultJoin).toBeGreaterThan(refusal);
    // Read after the session id exists (it is used in the join's log line).
    expect(vaultJoin).toBeGreaterThan(src.indexOf('const sessionId = `daemon-'));
    // The folder check stays keyed on the grant's env: a person's pane with
    // vault values must not be refused for having no grant folder.
    expect(src.slice(refusal - 120, refusal)).toMatch(/if \(secretEnv\) \{/);
    expect(src).toContain('...(createSecretEnv ? { secretEnv: createSecretEnv } : {}),');
    expect(src).not.toContain('...(secretEnv ? { secretEnv } : {}),');
  });
});
