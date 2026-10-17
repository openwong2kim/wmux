// A bot's own model and effort (its claude-sdk engine, set in the Bots
// profile or by its template) reach the Agent SDK options of its turn,
// through the engine factory the runtime spawns bots with.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' } }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../../deck/commanderMemory', () => ({
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

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createDefaultBotEngineFactory } from '../botEngines';
import { DEFAULT_BOT_BUDGETS, type BotEngine, type BotProfile } from '../../../shared/bot';
import type { SdkQueryHandle } from '../../deck/ClaudeSdkAdapter';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-brain-model-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.mocked(query).mockReset();
});

/** The SDK options of one turn of a bot on `engine`. */
async function turnOptions(engine: BotEngine): Promise<Record<string, unknown>> {
  const seen: Record<string, unknown>[] = [];
  vi.mocked(query).mockImplementation((({ options = {} }: { options?: Record<string, unknown> }) => {
    seen.push(options);
    const handle: SdkQueryHandle = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', session_id: 'sess-bot' };
      },
    };
    return handle;
  }) as never);
  const profile: BotProfile = {
    version: 1, id: 'bot-0a1b2c3d', workspaceId: 'ws-1', role: 'moa', template: 'coordinator', name: 'Coordinator', engine,
    triggers: [], budget: DEFAULT_BOT_BUDGETS.moa, enabled: true, createdAt: 1, updatedAt: 1,
  };
  const spawn = createDefaultBotEngineFactory({ bundlePath: () => '/app/dist/mcp-bundle/index.js', claudeExecutable: () => '/usr/local/bin/claude' })({
    profile, binding: { workspaceId: 'ws-1', botId: profile.id, role: 'moa' }, cwd: dir, wmuxDir: dir,
  });
  if (!spawn.ok) throw new Error(spawn.message);
  spawn.adapter.start({ systemPrompt: 'BOT' });
  for await (const ev of spawn.adapter.send('wake')) void ev;
  spawn.adapter.dispose();
  expect(seen).toHaveLength(1);
  return seen[0];
}

describe('a bot\'s own model', () => {
  it('its engine\'s model and effort are the SDK options of its turn', async () => {
    const options = await turnOptions({ kind: 'claude-sdk', model: 'haiku', effort: 'low' });
    expect(options.model).toBe('haiku');
    expect(options.effort).toBe('low');
  });

  it('a bot with no model names no model and no effort, so the ANTHROPIC_MODEL a gateway or Bedrock set still applies (#2272)', async () => {
    const before = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = 'glm-5.3';
    try {
      for (const engine of [{ kind: 'claude-sdk' }, { kind: 'claude-sdk', model: 'default' }, { kind: 'claude-sdk', model: 'claude opus' }] as BotEngine[]) {
        const options = await turnOptions(engine);
        expect(options).not.toHaveProperty('model');
        expect(options).not.toHaveProperty('effort');
        expect(options.extraArgs ?? {}).not.toHaveProperty('model');
        // The env the SDK spawns claude with still carries the owner's model.
        expect((options.env as Record<string, string> | undefined)?.ANTHROPIC_MODEL).toBe('glm-5.3');
      }
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = before;
    }
  });

  it('a Bedrock ARN is passed through as the model', async () => {
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5-v1:0';
    expect((await turnOptions({ kind: 'claude-sdk', model: arn })).model).toBe(arn);
  });
});
