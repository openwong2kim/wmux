import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

import {
  ACCOUNT_VAULT_PER_ACCOUNT_MAX,
  AccountVault,
  mergeVaultSecretEnv,
  vaultEligibleCreate,
} from '../accountVault';
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

  it('reloads and decrypts what it wrote, and drops entries of removed accounts', () => {
    const a = vault();
    a.load();
    a.set('acc-1', 'GITHUB_TOKEN', TOKEN);
    a.set('gone', 'HF_TOKEN', 'hf_example_value_0123');
    const b = vault();
    b.load(new Set(['acc-1']));
    expect(b.envFor(['acc-1', 'gone'])).toEqual({ GITHUB_TOKEN: TOKEN });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('"gone"');
  });

  it('injects only entries marked inject, first bound account winning a shared name', () => {
    const v = vault();
    v.load();
    v.set('claude-acc', 'GITHUB_TOKEN', TOKEN);
    v.set('codex-acc', 'GITHUB_TOKEN', 'ghp_other_value_987654321');
    v.set('codex-acc', 'HF_TOKEN', 'hf_example_value_0123', { inject: false });
    expect(v.envFor(['claude-acc', 'codex-acc'])).toEqual({ GITHUB_TOKEN: TOKEN });
    expect(v.setInject('codex-acc', 'HF_TOKEN', true)).toBe(true);
    expect(v.envFor(['codex-acc'])).toEqual({ GITHUB_TOKEN: 'ghp_other_value_987654321', HF_TOKEN: 'hf_example_value_0123' });
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
    expect(v.envFor(['acc-2'])).toEqual({});
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
});

describe('the pty create wiring', () => {
  const src = readSourceText(path.join(__dirname, '..', '..', 'ipc', 'handlers', 'pty.handler.ts'));

  it('checks the grant folder on the bot grant alone, then adds the vault, and sends the merged env', () => {
    const refusal = src.indexOf('secretCreateCwdRefusal(grantedCwd, cwdResolution)');
    const vaultJoin = src.indexOf('withAccountVaultEnv(sessionId, options, botWorker, secretEnv)');
    expect(refusal).toBeGreaterThan(-1);
    expect(vaultJoin).toBeGreaterThan(refusal);
    // The folder check stays keyed on the grant's env: a person's pane with
    // vault values must not be refused for having no grant folder.
    expect(src.slice(refusal - 120, refusal)).toMatch(/if \(secretEnv\) \{/);
    expect(src).toContain('...(createSecretEnv ? { secretEnv: createSecretEnv } : {}),');
    expect(src).not.toContain('...(secretEnv ? { secretEnv } : {}),');
  });
});
