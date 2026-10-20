// How a bot's session signs in to Claude: the subscription drops any
// ANTHROPIC_API_KEY (as the workspace brain always does), the API key mode
// puts the saved key in the session's env only (not the MCP child's), a
// refused sign-in spawns nothing, and the sign-in the session reports is
// passed on. The SDK `query` is a fake: no subprocess, no model.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' } }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../commanderMemory', () => ({
  loadCommanderMemory: vi.fn(() => ''),
  loadGlobalMemory: vi.fn(() => ''),
  getMemoryRootDir: vi.fn(() => '/fake/mem'),
}));
vi.mock('../../account/accountStore', () => ({
  VENDOR_ENV_KEYS: { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' },
  isAccessibleDir: () => true,
  getAccountStore: () => ({ resolveAccountEnv: () => ({}), getBinding: () => undefined, getAccount: () => undefined }),
}));
vi.mock('../../account/AccountRotationService', () => ({
  getAccountRotationService: () => ({
    getSettings: () => ({ claude: false, codex: false }),
    prepareLaunch: async () => ({ kind: 'keep' }),
    cachedVerdict: async () => null,
  }),
}));

import { ClaudeSdkAdapter, type SdkQueryFn, type SdkQueryHandle } from '../ClaudeSdkAdapter';
import type { BrainEvent, RawSdkMessage } from '../BrainAdapter';
import type { BotBinding } from '../../../shared/bot';
import type { BotClaudeAuth } from '../../factory/claudeApiKey';

const BINDING: BotBinding = { workspaceId: 'ws-1', botId: 'bot-0a1b2c3d', role: 'lead' };
const KEY = 'sk-ant-api03-saved-key-for-bots-only';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-sdk-botauth-'));
  process.env.ANTHROPIC_API_KEY = 'sk-ambient-never-used';
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

type Call = { options: Record<string, unknown> };

function recorder(frames: RawSdkMessage[] = [{ type: 'result', subtype: 'success', session_id: 's-1' }]): { calls: Call[]; queryFn: SdkQueryFn } {
  const calls: Call[] = [];
  const queryFn: SdkQueryFn = (p) => {
    calls.push(p as unknown as Call);
    const handle: SdkQueryHandle = { async *[Symbol.asyncIterator]() { for (const f of frames) yield f; } };
    return handle;
  };
  return { calls, queryFn };
}

function botAdapter(queryFn: SdkQueryFn, auth?: () => BotClaudeAuth, onAuthSeen?: (s: string) => void): ClaudeSdkAdapter {
  const cwd = path.join(dir, 'bot');
  fs.mkdirSync(cwd, { recursive: true });
  const a = new ClaudeSdkAdapter({ bot: { binding: BINDING, cwd, wmuxDir: dir, ...(auth ? { auth } : {}), ...(onAuthSeen ? { onAuthSeen } : {}) }, workspaceId: BINDING.workspaceId, mcpBundlePath: '/fake/mcp.js', queryFn });
  a.start({ systemPrompt: 'BOT' });
  return a;
}

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const envOf = (c: Call) => c.options.env as Record<string, string | undefined>;
const mcpEnvOf = (c: Call) => (c.options.mcpServers as { wmux: { env: Record<string, string> } }).wmux.env;

describe('ClaudeSdkAdapter: a bot\'s Claude sign-in', () => {
  it('the workspace brain never carries an API key', async () => {
    const { calls, queryFn } = recorder();
    const deck = new ClaudeSdkAdapter({ queryFn, mcpBundlePath: '/fake/mcp.js', loadMemory: () => '' });
    deck.start({ systemPrompt: 'SYS' });
    await collect(deck.send('hi'));
    expect(envOf(calls[0]).ANTHROPIC_API_KEY).toBeUndefined();
    deck.dispose();
  });

  it('a bot on the subscription drops the ambient key', async () => {
    const { calls, queryFn } = recorder();
    const a = botAdapter(queryFn, () => ({ mode: 'subscription' }));
    await collect(a.send('hi'));
    expect(envOf(calls[0]).ANTHROPIC_API_KEY).toBeUndefined();
    expect(mcpEnvOf(calls[0]).ANTHROPIC_API_KEY).toBeUndefined();
    a.dispose();
  });

  it('a bot on the API key gets the saved key in its session only, read again every turn', async () => {
    const { calls, queryFn } = recorder();
    let auth: BotClaudeAuth = { mode: 'apiKey', apiKey: KEY };
    const a = botAdapter(queryFn, () => auth);
    await collect(a.send('first'));
    expect(envOf(calls[0]).ANTHROPIC_API_KEY).toBe(KEY);
    // The MCP child does not inherit it.
    expect(mcpEnvOf(calls[0]).ANTHROPIC_API_KEY).toBe('');
    auth = { mode: 'subscription' };
    await collect(a.send('second'));
    expect(envOf(calls[1]).ANTHROPIC_API_KEY).toBeUndefined();
    a.dispose();
  });

  it('a bot on the API key reaches Anthropic only: inherited endpoint, provider and credential overrides are dropped', async () => {
    const inherited = {
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_VERTEX_BASE_URL: 'https://vertex.example',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Leak: 1',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_HOST_CREDS_FILE: '/tmp/gateway-creds.json',
      ANTHROPIC_FOO: 'bar',
      AWS_BEARER_TOKEN_BEDROCK: 'bedrock-tok',
    };
    Object.assign(process.env, inherited);
    try {
      const { calls, queryFn } = recorder();
      const a = botAdapter(queryFn, () => ({ mode: 'apiKey', apiKey: KEY }));
      await collect(a.send('hi'));
      const env = envOf(calls[0]);
      expect(env.ANTHROPIC_API_KEY).toBe(KEY);
      for (const name of Object.keys(inherited)) expect(env[name]).toBeUndefined();
      a.dispose();
      // wmux's own launch values still apply after the clearing.
      const launched = recorder();
      const c = botAdapter(launched.queryFn, () => ({ mode: 'apiKey', apiKey: KEY }));
      const build = (c as unknown as { buildEnv(l: { kind: 'run'; env: Record<string, string>; accountId: string | null }): Record<string, string | undefined> });
      (c as unknown as { _turnAuth: BotClaudeAuth })._turnAuth = { mode: 'apiKey', apiKey: KEY };
      (c as unknown as { _turnConfigDir: string })._turnConfigDir = '/wmux/factory/claude-api-config';
      const own = build.buildEnv({ kind: 'run', env: { CLAUDE_CONFIG_DIR: '/accounts/work', CLAUDE_CODE_OWN: 'wmux' }, accountId: 'acc-1' });
      // wmux's own config folder replaces an account's.
      expect(own.CLAUDE_CONFIG_DIR).toBe('/wmux/factory/claude-api-config');
      expect(own.CLAUDE_CODE_OWN).toBe('wmux');
      expect(own.ANTHROPIC_API_KEY).toBe(KEY);
      expect(own.CLAUDE_CODE_HOST_CREDS_FILE).toBeUndefined();
      c.dispose();
      // The subscription and the workspace brain keep what they inherit.
      const sub = recorder();
      const b = botAdapter(sub.queryFn, () => ({ mode: 'subscription' }));
      await collect(b.send('hi'));
      expect(envOf(sub.calls[0]).ANTHROPIC_BASE_URL).toBe('https://gateway.example');
      b.dispose();
    } finally {
      for (const name of Object.keys(inherited)) delete process.env[name];
    }
  });

  it('a bot never takes an endpoint profile', async () => {
    const { calls, queryFn } = recorder();
    const cwd = path.join(dir, 'bot');
    fs.mkdirSync(cwd, { recursive: true });
    const a = new ClaudeSdkAdapter({
      bot: { binding: BINDING, cwd, wmuxDir: dir, auth: () => ({ mode: 'apiKey', apiKey: KEY }) },
      profile: { baseUrl: 'https://glm.example', authToken: 'glm-tok' },
      workspaceId: BINDING.workspaceId, mcpBundlePath: '/fake/mcp.js', queryFn,
    });
    a.start({ systemPrompt: 'BOT' });
    await collect(a.send('hi'));
    expect(envOf(calls[0]).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(envOf(calls[0]).ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(envOf(calls[0]).ANTHROPIC_API_KEY).toBe(KEY);
    a.dispose();
  });

  it('a bot on the API key runs on wmux\'s own 0700 config folder; the subscription and the workspace brain keep the owner\'s', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/owner/claude-config';
    try {
      const api = recorder();
      const a = botAdapter(api.queryFn, () => ({ mode: 'apiKey', apiKey: KEY }));
      await collect(a.send('hi'));
      const isolated = path.join(dir, 'factory', 'claude-api-config');
      expect(envOf(api.calls[0]).CLAUDE_CONFIG_DIR).toBe(isolated);
      expect(fs.statSync(isolated).isDirectory()).toBe(true);
      if (process.platform !== 'win32') expect(fs.statSync(isolated).mode & 0o777).toBe(0o700);
      // Nothing of the owner's is copied into it.
      expect(fs.readdirSync(isolated)).toEqual([]);
      a.dispose();

      const sub = recorder();
      const b = botAdapter(sub.queryFn, () => ({ mode: 'subscription' }));
      await collect(b.send('hi'));
      expect(envOf(sub.calls[0]).CLAUDE_CONFIG_DIR).toBe('/owner/claude-config');
      b.dispose();

      const deckCalls = recorder();
      const deck = new ClaudeSdkAdapter({ queryFn: deckCalls.queryFn, mcpBundlePath: '/fake/mcp.js', loadMemory: () => '' });
      deck.start({ systemPrompt: 'SYS' });
      await collect(deck.send('hi'));
      expect(envOf(deckCalls.calls[0]).CLAUDE_CONFIG_DIR).toBe('/owner/claude-config');
      deck.dispose();
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('a switch of sign-in starts a new conversation instead of resuming one claude cannot find', async () => {
    const { calls, queryFn } = recorder();
    let auth: BotClaudeAuth = { mode: 'subscription' };
    const a = botAdapter(queryFn, () => auth);
    await collect(a.send('first'));
    await collect(a.send('second'));
    expect(calls[1].options.resume).toBe('s-1');
    auth = { mode: 'apiKey', apiKey: KEY };
    await collect(a.send('third'));
    expect(calls[2].options.resume).toBeUndefined();
    await collect(a.send('fourth'));
    expect(calls[3].options.resume).toBe('s-1');
    a.dispose();
  });

  it('a refused sign-in ends the turn with its message and spawns nothing', async () => {
    const { calls, queryFn } = recorder();
    const a = botAdapter(queryFn, () => ({ mode: 'refused', message: 'no key saved' }));
    const events = await collect(a.send('hi'));
    expect(events).toEqual([{ type: 'error', message: 'no key saved' }]);
    expect(calls).toHaveLength(0);
    a.dispose();
  });

  it('passes on the sign-in the session reported', async () => {
    const seen: string[] = [];
    const { queryFn } = recorder([
      { type: 'system', subtype: 'init', session_id: 's-1', apiKeySource: 'user' },
      { type: 'result', subtype: 'success', session_id: 's-1' },
    ]);
    const a = botAdapter(queryFn, () => ({ mode: 'apiKey', apiKey: KEY }), (s) => seen.push(s));
    await collect(a.send('hi'));
    expect(seen).toEqual(['user']);
    a.dispose();
  });
});
