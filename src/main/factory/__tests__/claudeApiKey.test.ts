// The bots' Claude API key: the encrypted store (the renderer's status never
// holds the key), the per-turn sign-in choice, the spawn refusal without a
// key, the connection check's answers, and the setting's sanitising.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' }, safeStorage: {} }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import {
  CLAUDE_API_KEY_MISSING_MESSAGE,
  CLAUDE_API_MODELS_URL,
  ClaudeApiKeyStore,
  authOfApiKeySource,
  checkClaudeApiKey,
  claudeKeyCheckOfStatus,
  resolveBotClaudeAuth,
} from '../claudeApiKey';
import type { SecretCrypto, SecretCryptoState } from '../secretStore';
import { redactStoredSecrets, setRedactedClaudeApiKey } from '../secretRedaction';
import { createDefaultBotEngineFactory } from '../botEngines';
import { DEFAULT_FACTORY_SETTINGS, mergeFactorySettings } from '../factorySettings';
import { botClaudeAuthMode } from '../../../shared/factorySettings';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../shared/bot';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-WXYZ';

function fakeCrypto(state: SecretCryptoState = 'ok'): SecretCrypto {
  return {
    state: () => state,
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('hex')}`),
    decrypt: (cipher) => Buffer.from(cipher.toString().slice(4), 'hex').toString(),
  };
}

let dir = '';
let file = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-key-'));
  file = path.join(dir, 'factory', 'claude-api-key.json');
});
afterEach(() => {
  setRedactedClaudeApiKey([]);
  fs.rmSync(dir, { recursive: true, force: true });
});

function store(state: SecretCryptoState = 'ok'): ClaudeApiKeyStore {
  const s = new ClaudeApiKeyStore({ file, crypto: fakeCrypto(state), now: () => 1000, log: () => undefined });
  s.load();
  return s;
}

describe('ClaudeApiKeyStore', () => {
  it('saves the key encrypted; its status and file carry only the last four characters', () => {
    const s = store();
    const r = s.set(`  ${KEY}\n`);
    expect(r).toEqual({ ok: true, status: { set: true, last4: 'WXYZ', updatedAt: 1000 } });
    expect(JSON.stringify(s.status())).not.toContain(KEY);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(KEY);
    expect(s.key()).toBe(KEY);
    // Another run decrypts it on first use.
    expect(store().key()).toBe(KEY);
    // Redacted from what bots and stores see.
    expect(redactStoredSecrets(`echo ${KEY}`)).toBe('echo [secret:ANTHROPIC_API_KEY]');
  });

  it('refuses a malformed key and, like bot secrets, a system that cannot encrypt it', () => {
    expect(store().set('short')).toMatchObject({ ok: false, code: 'invalid_key' });
    expect(store().set(`${KEY} more`)).toMatchObject({ ok: false, code: 'invalid_key' });
    const basic = store('basic_text');
    expect(basic.set(KEY)).toMatchObject({ ok: false, code: 'basic_text' });
    expect(basic.status().cannotStore?.code).toBe('basic_text');
    expect(store('unavailable').set(KEY)).toMatchObject({ ok: false, code: 'encryption_unavailable' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('removes the key, which stays redacted for the rest of the run', () => {
    const s = store();
    s.set(KEY);
    expect(s.remove()).toBe(true);
    expect(s.status()).toEqual({ set: false });
    expect(s.key()).toBeNull();
    // A session started before may still hold it.
    expect(redactStoredSecrets(`env ${KEY}`)).toBe('env [secret:ANTHROPIC_API_KEY]');
    expect(fs.readFileSync(file, 'utf8')).not.toContain(KEY);
    expect(store().key()).toBeNull();
  });

  it('a replaced key stays redacted next to the new one', () => {
    const s = store();
    s.set(KEY);
    const next = 'sk-ant-api03-the-replacement-key-0123';
    expect(s.set(next)).toMatchObject({ ok: true, status: { last4: '0123' } });
    expect(s.key()).toBe(next);
    expect(redactStoredSecrets(`${KEY} ${next}`)).toBe('[secret:ANTHROPIC_API_KEY] [secret:ANTHROPIC_API_KEY]');
    expect(fs.readFileSync(file, 'utf8')).not.toContain(KEY);
  });

  it('records the sign-in a session reported', () => {
    expect(authOfApiKeySource('oauth')).toBe('subscription');
    expect(authOfApiKeySource('none')).toBe('subscription');
    expect(authOfApiKeySource('user')).toBe('apiKey');
    expect(authOfApiKeySource(undefined)).toBeNull();
    const s = store();
    s.recordSeen('user');
    expect(store().status().lastSeen).toEqual({ auth: 'apiKey', source: 'user', at: 1000 });
  });
});

describe('resolveBotClaudeAuth', () => {
  it('is the subscription unless bots are set to the API key', () => {
    const s = store();
    s.set(KEY);
    expect(resolveBotClaudeAuth(() => ({}), () => s)).toEqual({ mode: 'subscription' });
    expect(resolveBotClaudeAuth(() => ({ claudeAuth: 'subscription' }), () => s)).toEqual({ mode: 'subscription' });
    expect(resolveBotClaudeAuth(() => ({ claudeAuth: 'apiKey' }), () => s)).toEqual({ mode: 'apiKey', apiKey: KEY });
  });

  it('refuses the API key when none is saved', () => {
    expect(resolveBotClaudeAuth(() => ({ claudeAuth: 'apiKey' }), () => store())).toEqual({ mode: 'refused', message: CLAUDE_API_KEY_MISSING_MESSAGE });
  });

  it('a bot set to the API key with none saved is refused before it starts', () => {
    const profile: BotProfile = {
      version: 1, id: 'bot-0a1b2c3d', workspaceId: 'ws-1', role: 'lead', name: 'Lead', engine: { kind: 'claude-sdk' },
      triggers: [], budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1,
    };
    const spawn = createDefaultBotEngineFactory({
      bundlePath: () => '/app/dist/mcp-bundle/index.js',
      claudeExecutable: () => '/usr/local/bin/claude',
      claudeAuth: () => ({ mode: 'refused', message: CLAUDE_API_KEY_MISSING_MESSAGE }),
    });
    expect(spawn({ profile, binding: { workspaceId: 'ws-1', botId: profile.id, role: 'lead' }, cwd: '/tmp/bot', wmuxDir: '/tmp' }))
      .toEqual({ ok: false, code: 'engine_unavailable', message: CLAUDE_API_KEY_MISSING_MESSAGE });
  });
});

describe('checkClaudeApiKey', () => {
  it('maps the model list status', () => {
    expect(claudeKeyCheckOfStatus(200)).toEqual({ ok: true });
    expect(claudeKeyCheckOfStatus(401)).toEqual({ ok: false, code: 'invalid_key', status: 401 });
    expect(claudeKeyCheckOfStatus(403)).toEqual({ ok: false, code: 'invalid_key', status: 403 });
    expect(claudeKeyCheckOfStatus(529)).toEqual({ ok: false, code: 'error', status: 529 });
  });

  it('makes one authenticated GET of the model list', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await checkClaudeApiKey(KEY, fetchFn as unknown as typeof fetch)).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLAUDE_API_MODELS_URL);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01' });
  });

  it('reports a refused key, a network failure and no key, never with the key', async () => {
    const refused = await checkClaudeApiKey(KEY, (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch);
    expect(refused).toEqual({ ok: false, code: 'invalid_key', status: 401 });
    const down = await checkClaudeApiKey(KEY, (async () => { throw new TypeError(`fetch failed for ${KEY}`); }) as unknown as typeof fetch);
    expect(down).toEqual({ ok: false, code: 'network' });
    expect(JSON.stringify(down)).not.toContain(KEY);
    const fetchFn = vi.fn();
    expect(await checkClaudeApiKey(null, fetchFn as unknown as typeof fetch)).toEqual({ ok: false, code: 'no_key' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('factory settings claudeAuth', () => {
  it('keeps only the two modes, and a file without it runs on the subscription', () => {
    const base = mergeFactorySettings({ ...DEFAULT_FACTORY_SETTINGS, trustedAuthors: [], morning: { hour: 9, weekdays: [1] }, defaultEngine: { kind: 'claude-sdk' } }, {});
    expect(base.claudeAuth).toBeUndefined();
    expect(botClaudeAuthMode(base)).toBe('subscription');
    const api = mergeFactorySettings(base, { claudeAuth: 'apiKey' });
    expect(api.claudeAuth).toBe('apiKey');
    expect(botClaudeAuthMode(api)).toBe('apiKey');
    expect(mergeFactorySettings(api, { claudeAuth: 'bogus' }).claudeAuth).toBe('apiKey');
    expect(mergeFactorySettings(api, {}).claudeAuth).toBe('apiKey');
    expect(mergeFactorySettings(api, { claudeAuth: 'subscription' }).claudeAuth).toBeUndefined();
  });
});
