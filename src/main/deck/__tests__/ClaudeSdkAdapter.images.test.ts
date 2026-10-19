// A bot turn whose owner message carries photos, through the REAL Agent SDK
// `query()` and a stand-in claude CLI (fixtures/fakeClaudeCli.mjs) that logs
// every user message it is given: the photos arrive as image blocks before
// the text in one user message, for two photo turns in a row and a resumed
// text turn after them, after an interrupt, and on the retry that replaces a
// dead seeded session id (each attempt gets its own prompt iterable).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' } }));
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

import { ClaudeSdkAdapter, type SdkQueryFn } from '../ClaudeSdkAdapter';
import type { BrainEvent } from '../BrainAdapter';
import type { BotBinding } from '../../../shared/bot';

const FAKE_CLI = path.join(__dirname, 'fixtures', 'fakeClaudeCli.mjs');
const BINDING: BotBinding = { workspaceId: 'ws-1', botId: 'bot-0a1b2c3d', role: 'lead' };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]).toString('base64');

let dir = '';
let log = '';
const hold = { on: false };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-sdk-images-'));
  log = path.join(dir, 'cli.jsonl');
  hold.on = false;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function realQuery(): Promise<SdkQueryFn> {
  const mod = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as { query: SdkQueryFn };
  return (params) => mod.query({
    ...params,
    options: {
      ...params.options,
      pathToClaudeCodeExecutable: FAKE_CLI,
      executable: 'node',
      env: { ...process.env, ...(params.options?.env as Record<string, string> | undefined), FAKE_CLI_LOG: log, FAKE_CLI_HOLD: hold.on ? '1' : '0' },
    },
  });
}

function seen(): Array<{ args: string[]; dead?: true; message?: { content: Array<Record<string, unknown>> } }> {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

function adapterWith(queryFn: SdkQueryFn): ClaudeSdkAdapter {
  const cwd = path.join(dir, 'bot');
  fs.mkdirSync(cwd, { recursive: true });
  return new ClaudeSdkAdapter({ bot: { binding: BINDING, cwd, wmuxDir: dir }, workspaceId: BINDING.workspaceId, mcpBundlePath: null, queryFn });
}

describe('ClaudeSdkAdapter: a bot turn with photos, through the Agent SDK', () => {
  it('two photo turns in a row, then a resumed text turn', async () => {
    const adapter = adapterWith(await realQuery());
    adapter.start({ systemPrompt: 'BOT' });
    const first = await collect(adapter.send('look at this', { images: [{ mediaType: 'image/jpeg', data: JPEG }] }));
    expect(first.at(-1)).toMatchObject({ type: "turn-end" });
    const second = await collect(adapter.send('and these', { images: [{ mediaType: 'image/jpeg', data: JPEG }, { mediaType: 'image/png', data: PNG }] }));
    expect(second.at(-1)).toMatchObject({ type: 'turn-end' });
    const third = await collect(adapter.send('thanks'));
    expect(third.at(-1)).toMatchObject({ type: 'turn-end' });

    const rows = seen();
    expect(rows).toHaveLength(3);
    expect(rows[0].message?.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
      { type: 'text', text: 'look at this' },
    ]);
    expect(rows[1].message?.content.map((b) => b.type)).toEqual(['image', 'image', 'text']);
    expect((rows[1].message?.content[1] as { source: { media_type: string } }).source.media_type).toBe('image/png');
    // Later turns resume the conversation; a turn without photos is text only.
    const firstSession = rows[0].args.includes('--resume') ? null : 'fresh';
    expect(firstSession).toBe('fresh');
    expect(rows[1].args).toContain('--resume');
    expect(rows[2].args).toContain('--resume');
    expect(rows[2].message?.content).toEqual([{ type: 'text', text: 'thanks' }]);
    // The brain still has no built-in tool.
    expect(rows[0].args.join(' ')).toMatch(/--tools(?:=| )(?:""|$|\s)/);
    adapter.dispose();
  }, 30_000);

  it('a dead seeded session id: the fresh retry gets its own copy of the photos', async () => {
    const adapter = adapterWith(await realQuery());
    adapter.start({ systemPrompt: 'BOT', resumeSessionId: 'dead' });
    const events = await collect(adapter.send('broken screen', { images: [{ mediaType: 'image/jpeg', data: JPEG }] }));
    expect(events.at(-1)).toMatchObject({ type: 'turn-end' });
    const rows = seen();
    expect(rows[0]).toMatchObject({ dead: true });
    expect(rows[1].args).not.toContain('--resume');
    expect(rows[1].message?.content.map((b) => b.type)).toEqual(['image', 'text']);
    adapter.dispose();
  }, 30_000);

  it('an interrupted photo turn, then the next photo turn still carries its photo', async () => {
    const adapter = adapterWith(await realQuery());
    adapter.start({ systemPrompt: 'BOT' });
    hold.on = true;
    const turn = collect(adapter.send('wait', { images: [{ mediaType: 'image/jpeg', data: JPEG }] }));
    await vi.waitFor(() => expect(seen()).toHaveLength(1), { timeout: 10_000 });
    adapter.interrupt();
    await turn;
    hold.on = false;
    const next = await collect(adapter.send('again', { images: [{ mediaType: 'image/png', data: PNG }] }));
    expect(next.at(-1)).toMatchObject({ type: 'turn-end' });
    const rows = seen();
    expect(rows.at(-1)?.message?.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'text', text: 'again' },
    ]);
    adapter.dispose();
  }, 30_000);
});
