// Agent factory bot mode of the two brain adapters: the MCP child is spawned
// as `<execPath> <bundle> --bot=<role> --bot-token-file=<file>` with no token
// in its environment, the token file holds a live bot token bound to the
// bot, the session runs in the bot's own folder, and (Claude SDK) no
// built-in tool exists in the session — except, for a bot with a repository,
// Read / Grep / Glob, every call decided by main inside that repository, and,
// where the OS sandbox runs, the command tools (ClaudeSdkAdapter.botExec.os.test.ts).
// The bots here get no sandbox probe, so they hold no command tool.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' } }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
vi.mock('../commanderMemory', () => ({
  loadCommanderMemory: vi.fn(() => 'MEMORY'),
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

import { ClaudeSdkAdapter, type SdkQueryHandle } from '../ClaudeSdkAdapter';
import { AcpBrainAdapter } from '../AcpBrainAdapter';
import { botTokenBinding, isCommanderToken } from '../commanderTrust';
import { botArgValue, botTokenFileArgValue, type BotBinding } from '../../../shared/bot';
import type { BrainEvent } from '../BrainAdapter';
import { botRepoReadDenyRules } from '../../factory/botRepoRead';
import { WakeTaint, setWakeTaint } from '../../factory/wakeTaint';
import type { WakeItem } from '../../../shared/wake';

const BINDING: BotBinding = { workspaceId: 'ws-1', botId: 'bot-0a1b2c3d', role: 'verifier' };
let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-adapters-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('ClaudeSdkAdapter bot mode', () => {
  it('spawns the MCP child with bot args and a token file, never a token env, and no built-in tools', async () => {
    const seen: Array<{ options: Record<string, unknown>; tokenAtSpawn: string | null }> = [];
    const cwd = path.join(dir, 'factory', 'bots', BINDING.botId);
    fs.mkdirSync(cwd, { recursive: true });
    const adapter = new ClaudeSdkAdapter({
      bot: { binding: BINDING, cwd, wmuxDir: dir },
      allowedTools: ['mcp__wmux__pr_read', 'mcp__wmux__room_post'],
      workspaceId: BINDING.workspaceId,
      mcpBundlePath: '/app/dist/mcp-bundle/index.js',
      queryFn: ({ options = {} }) => {
        const server = (options.mcpServers as Record<string, { args: string[] }>).wmux;
        const file = botTokenFileArgValue(server.args) ?? '';
        seen.push({ options, tokenAtSpawn: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null });
        const handle: SdkQueryHandle = {
          async *[Symbol.asyncIterator]() {
            yield { type: 'result', subtype: 'success', session_id: 'sess-bot' };
          },
        };
        return handle;
      },
    });
    adapter.start({ systemPrompt: 'BOT' });
    const events = await collect(adapter.send('wake'));
    expect(events.at(-1)?.type).toBe('turn-end');

    const { options, tokenAtSpawn } = seen[0];
    const server = (options.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>).wmux;
    expect(server.command).toBe(process.execPath);
    expect(server.args[0]).toBe('/app/dist/mcp-bundle/index.js');
    expect(botArgValue(server.args)).toBe('verifier');
    expect(server.args).not.toContain('--commander');
    expect(Object.keys(server.env).filter((k) => k !== 'WMUX_DATA_SUFFIX')).toEqual(['ELECTRON_RUN_AS_NODE']);
    expect(JSON.stringify(server.env)).not.toMatch(/TOKEN/);
    // The file held a live token bound to exactly this bot, and was removed after the turn.
    expect(tokenAtSpawn && botTokenBinding(tokenAtSpawn)).toEqual(BINDING);
    expect(fs.existsSync(botTokenFileArgValue(server.args) ?? '')).toBe(false);

    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual(['mcp__wmux__pr_read', 'mcp__wmux__room_post']);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Read', 'Edit', 'Agent']));
    expect(options.settingSources).toEqual([]);
    expect(options.cwd).toBe(cwd);
    const deny = await (options.canUseTool as (n: string, i: unknown) => Promise<{ behavior: string }>)('Write', { file_path: '/x' });
    expect(deny.behavior).toBe('deny');

    adapter.dispose();
    expect(isCommanderToken(tokenAtSpawn)).toBe(false);
  });

  it('a fresh hand-off file per turn, and no memory in the first prompt', async () => {
    const files: string[] = [];
    const prompts: string[] = [];
    const adapter = new ClaudeSdkAdapter({
      bot: { binding: BINDING, cwd: dir, wmuxDir: dir },
      workspaceId: BINDING.workspaceId,
      mcpBundlePath: '/b.js',
      queryFn: ({ prompt, options = {} }) => {
        prompts.push(prompt as string);
        files.push(botTokenFileArgValue((options.mcpServers as Record<string, { args: string[] }>).wmux.args) ?? '');
        return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', session_id: 's' }; } };
      },
    });
    adapter.start({ systemPrompt: 'BOT' });
    await collect(adapter.send('one'));
    await collect(adapter.send('two'));
    expect(new Set(files).size).toBe(2);
    expect(prompts[0]).toBe('one');
    adapter.dispose();
  });

  it('its own notes and the owner\'s profile open the first prompt only, fenced as data', async () => {
    const mem = path.join(dir, 'factory', 'bot-memory');
    fs.mkdirSync(mem, { recursive: true });
    fs.writeFileSync(path.join(mem, `${BINDING.botId}.txt`), 'Gate is npm run verify\n');
    fs.writeFileSync(path.join(mem, 'owner.txt'), 'The owner is Kim\n');
    const prompts: string[] = [];
    const adapter = new ClaudeSdkAdapter({
      bot: { binding: BINDING, cwd: dir, wmuxDir: dir },
      workspaceId: BINDING.workspaceId,
      mcpBundlePath: '/b.js',
      queryFn: ({ prompt }) => {
        prompts.push(prompt as string);
        return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', session_id: 's' }; } };
      },
    });
    adapter.start({ systemPrompt: 'BOT' });
    await collect(adapter.send('one'));
    await collect(adapter.send('two'));
    expect(prompts[0]).toMatch(/^\[memory\] /);
    expect(prompts[0]).toContain('```memory\nGate is npm run verify\n```');
    expect(prompts[0]).toContain('```owner-profile\nThe owner is Kim\n```');
    expect(prompts[0].endsWith('\n\n---\n\none')).toBe(true);
    expect(prompts[1]).toBe('two');
    adapter.dispose();
  });

  // The 4.5.0 researcher incident: its session held every mcp__wmux__ tool,
  // but the model called them by the bare names the prompts use, each call
  // failed with "No such tool available", and the turn settled as done.
  const TOOLS = ['Read', 'Grep', 'Glob', 'mcp__wmux__room_post', 'mcp__wmux__handoff_send', 'mcp__wmux__fanout_start'];
  const init = (status = 'connected', tools = TOOLS) => ({
    type: 'system', subtype: 'init', session_id: 'sess', tools, mcp_servers: [{ name: 'wmux', status }],
  });
  const call = (id: string, name: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
  const result = (id: string, isError: boolean) => ({
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
  });
  function turnOf(frames: unknown[], seen: Array<Record<string, unknown>> = []): { adapter: ClaudeSdkAdapter; interrupted: () => number } {
    let interrupts = 0;
    const adapter = new ClaudeSdkAdapter({
      bot: { binding: { ...BINDING, role: 'lead' }, cwd: dir, wmuxDir: dir },
      allowedTools: ['mcp__wmux__room_post', 'mcp__wmux__handoff_send', 'mcp__wmux__fanout_start'],
      workspaceId: BINDING.workspaceId,
      mcpBundlePath: '/b.js',
      queryFn: ({ options = {} }) => {
        seen.push(options);
        return {
          async *[Symbol.asyncIterator]() {
            for (const f of frames) yield f as never;
          },
          interrupt: () => { interrupts += 1; },
        };
      },
    });
    adapter.start({ systemPrompt: 'BOT' });
    return { adapter, interrupted: () => interrupts };
  }

  it('tells the brain the exact names of its wmux tools in the system prompt', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { adapter } = turnOf([{ type: 'result', subtype: 'success', session_id: 's' }], seen);
    await collect(adapter.send('wake'));
    const prompt = seen[0].systemPrompt as string;
    expect(prompt.startsWith('BOT\n\n')).toBe(true);
    expect(prompt).toContain('mcp__wmux__room_post, mcp__wmux__handoff_send, mcp__wmux__fanout_start');
    expect(prompt).toContain('"room_post" means the tool mcp__wmux__room_post');
    adapter.dispose();
  });

  it('a turn that called its tools only by bare names ends in an error, not a turn-end', async () => {
    const { adapter } = turnOf([
      init(),
      call('t1', 'Grep'), result('t1', false),
      call('t2', 'fanout_start'), result('t2', true),
      call('t3', 'room_post'), result('t3', true),
      call('t4', 'handoff_send'), result('t4', true),
      { type: 'result', subtype: 'success', session_id: 'sess' },
    ]);
    const events = await collect(adapter.send('wake'));
    expect(events.some((e) => e.type === 'turn-end')).toBe(false);
    const last = events.at(-1);
    expect(last?.type).toBe('error');
    expect(last && 'message' in last ? last.message : '').toMatch(/fanout_start, room_post, handoff_send.*mcp__wmux__<name>/);
    // Marked, so the bot runtime starts the retry in a fresh conversation
    // instead of resuming this one full of failed calls.
    expect(last?.type === 'error' && last.botTools).toBe('unreached');
    expect(adapter.sessionId).toBe('sess');
    adapter.dispose();
  });

  it('a bare-name slip followed by the real tool still ends the turn normally', async () => {
    const { adapter } = turnOf([
      init(),
      call('t1', 'handoff_send'), result('t1', true),
      call('t2', 'mcp__wmux__handoff_send'), result('t2', false),
      { type: 'result', subtype: 'success', session_id: 'sess' },
    ]);
    const events = await collect(adapter.send('wake'));
    expect(events.at(-1)?.type).toBe('turn-end');
    adapter.dispose();
  });

  it('a session whose wmux MCP server failed stops at once with an error', async () => {
    const { adapter, interrupted } = turnOf([
      init('failed', []),
      call('t1', 'Grep'), result('t1', false),
      { type: 'result', subtype: 'success', session_id: 'sess' },
    ]);
    const events = await collect(adapter.send('wake'));
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(events[0].type === 'error' && events[0].message).toMatch(/wmux tools did not load.*failed/);
    expect(events[0].type === 'error' && events[0].botTools).toBe('missing');
    expect(interrupted()).toBe(1);
    adapter.dispose();
  });

  it('a connected wmux server that lists no tools is the same error', async () => {
    const { adapter } = turnOf([init('connected', ['Read']), { type: 'result', subtype: 'success', session_id: 'sess' }]);
    const events = await collect(adapter.send('wake'));
    expect(events.map((e) => e.type)).toEqual(['error']);
    adapter.dispose();
  });
});

describe('ClaudeSdkAdapter bot mode with a repository', () => {
  type Hook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  async function optionsFor(repoRoot: string | undefined): Promise<Record<string, unknown>> {
    let seen: Record<string, unknown> = {};
    const adapter = new ClaudeSdkAdapter({
      bot: { binding: { ...BINDING, role: 'lead' }, cwd: path.join(dir, 'bot'), wmuxDir: dir, repoRoot },
      workspaceId: BINDING.workspaceId,
      mcpBundlePath: '/b.js',
      queryFn: ({ options = {} }) => {
        seen = options;
        return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', session_id: 's' }; } };
      },
    });
    adapter.start({ systemPrompt: 'BOT' });
    await collect(adapter.send('wake'));
    adapter.dispose();
    return seen;
  }
  // The repository read decision is the last PreToolUse hook; the guest gate runs first.
  const preHook = (o: Record<string, unknown>) => (o.hooks as { PreToolUse: Array<{ hooks: Hook[] }> }).PreToolUse.at(-1)!.hooks[0];
  const guestHook = (o: Record<string, unknown>) => (o.hooks as { PreToolUse: Array<{ hooks: Hook[] }> }).PreToolUse[0].hooks[0];
  const postHook = (o: Record<string, unknown>) => (o.hooks as { PostToolUse: Array<{ hooks: Hook[] }> }).PostToolUse[0].hooks[0];
  const canUse = (o: Record<string, unknown>) => o.canUseTool as (n: string, i: Record<string, unknown>) => Promise<Record<string, unknown>>;

  let repo = '';
  beforeEach(() => {
    // The native realpath, as the product resolves (it expands Windows 8.3 short names).
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reporead-adapter-')));
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=dummy\n');
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('holds Read, Grep and Glob only, none auto-allowed, with protected files denied by rule', async () => {
    const o = await optionsFor(repo);
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(o.allowedTools).toEqual(expect.not.arrayContaining(['Read', 'Grep', 'Glob']));
    expect((o.allowedTools as string[]).every((t) => t.startsWith('mcp__wmux__'))).toBe(true);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent']));
    expect(o.disallowedTools).toEqual(expect.not.arrayContaining(['Read', 'Grep', 'Glob']));
    expect((o.settings as { permissions: { deny: string[] } }).permissions.deny).toEqual(botRepoReadDenyRules(repo));
    expect(o.settingSources).toEqual([]);
    // The session folder stays the bot's own; main points the reads at the repository.
    expect(o.cwd).toBe(path.join(dir, 'bot'));
  });

  it('the PreToolUse hook allows reads inside the repository and refuses the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pre = preHook(await optionsFor(repo));
    expect(await pre({ tool_name: 'Grep', tool_input: { pattern: 'a' } })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { pattern: 'a', path: repo } },
    });
    expect(await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { file_path: path.join(repo, 'src', 'a.ts') } },
    });
    for (const [tool_name, tool_input] of [
      ['Read', { file_path: path.join(repo, '.env') }],
      ['Read', { file_path: os.homedir() }],
      ['Glob', { pattern: '/etc/*' }],
      ['Bash', { command: 'cat .env' }],
      ['Write', { file_path: path.join(repo, 'src', 'a.ts'), content: '' }],
    ] as const) {
      expect({ tool_name, out: await pre({ tool_name, tool_input }) }).toMatchObject({ tool_name, out: { hookSpecificOutput: { permissionDecision: 'deny' } } });
    }
    // The bot's wmux tools keep their own gates.
    expect(await pre({ tool_name: 'mcp__wmux__room_post', tool_input: {} })).toEqual({});
    expect(warn.mock.calls.some((c) => String(c[0]).includes('bot repository read denied') && String(c[1]).includes('.env'))).toBe(true);
    warn.mockRestore();
  });

  it('a wake not known clean is refused every built-in tool, judged on each call; a clean wake has them again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let running: WakeItem | null = { id: 'w-1', botId: BINDING.botId, workspaceId: BINDING.workspaceId, reason: { kind: 'guest', guestId: '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b', guestName: 'G', cardId: 'c', text: 'hi' }, priority: 1, enqueuedAt: 1, attempts: 1, state: 'running' };
    const runningWake = () => (running ? { item: running, startedAt: 1 } : null);
    setWakeTaint(new WakeTaint({ facts: () => [], handoff: () => null, taskRow: () => null, runningWake }), runningWake);
    try {
      for (const root of [repo, undefined]) {
        running = { ...running!, reason: { kind: 'guest', guestId: '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b', guestName: 'G', cardId: 'c', text: 'hi' } };
        const o = await optionsFor(root);
        const exposed = (o.tools as string[]) ?? [];
        const names = [...new Set([...exposed, 'Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite', 'SomeToolAddedLater'])];
        for (const name of names) {
          expect(await canUse(o)(name, { file_path: 'src/a.ts', pattern: 'a', command: 'ls' }), `${name} (canUseTool)`).toMatchObject({ behavior: 'deny', message: expect.stringContaining('external guest') });
          expect(await guestHook(o)({ tool_name: name, tool_input: {} }), `${name} (hook)`).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
        }
        // The wmux tools pass this gate (RpcRouter keeps theirs).
        expect(await guestHook(o)({ tool_name: 'mcp__wmux__room_post', tool_input: {} })).toEqual({});
        // No running wake: not known clean either.
        running = null;
        expect(await canUse(o)('Read', { file_path: 'src/a.ts' })).toMatchObject({ behavior: 'deny' });
        running = { id: 'w-2', botId: BINDING.botId, workspaceId: BINDING.workspaceId, reason: { kind: 'human', text: 'hi', source: 'desktop' }, priority: 0, enqueuedAt: 1, attempts: 1, state: 'running' };
        for (const name of names) expect(await guestHook(o)({ tool_name: name, tool_input: {} }), name).toEqual({});
        if (root) {
          expect(await canUse(o)('Read', { file_path: 'src/a.ts' })).toMatchObject({ behavior: 'allow' });
          expect(await canUse(o)('Bash', { command: 'ls' })).toMatchObject({ behavior: 'deny' });
        } else {
          // Without a repository the session's own lock still refuses them.
          expect(await canUse(o)('Read', { file_path: 'src/a.ts' })).toMatchObject({ behavior: 'deny', message: 'bots act only through their wmux tools' });
        }
      }
    } finally {
      setWakeTaint(null);
      vi.restoreAllMocks();
    }
  });

  it('canUseTool makes the same decision', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const can = canUse(await optionsFor(repo));
    expect(await can('Glob', { pattern: '**/*.ts' })).toEqual({ behavior: 'allow', updatedInput: { pattern: '**/*.ts', path: repo } });
    expect(await can('Read', { file_path: '.env' })).toMatchObject({ behavior: 'deny' });
    expect(await can('Edit', { file_path: 'src/a.ts' })).toMatchObject({ behavior: 'deny' });
    vi.restoreAllMocks();
  });

  it('a Grep result naming a protected file is withheld; others pass untouched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const post = postHook(await optionsFor(repo));
    const leaked = await post({ tool_name: 'Grep', tool_response: { mode: 'content', filenames: [], content: `${path.join(repo, '.env')}:1:TOKEN=dummy` } });
    expect(leaked).toMatchObject({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { content: expect.stringMatching(/withheld/) } } });
    expect(JSON.stringify(leaked)).not.toContain('dummy');
    expect(await post({ tool_name: 'Grep', tool_response: { mode: 'content', filenames: [], content: `${path.join(repo, 'src', 'a.ts')}:1:export` } })).toEqual({});
    expect(await post({ tool_name: 'Read', tool_response: { file: {} } })).toEqual({});
    vi.restoreAllMocks();
  });

  it('a stored bot secret in a Read or Grep result reaches the model as its marker', async () => {
    const { setRedactedSecrets, __resetRedactedSecretsForTesting } = await import('../../factory/secretRedaction');
    setRedactedSecrets([{ name: 'NPM_TOKEN', value: 'npm_AbCdEf123456789xyz' }]);
    try {
      const post = postHook(await optionsFor(repo));
      const read = await post({ tool_name: 'Read', tool_response: { type: 'text', file: { filePath: path.join(repo, 'config.json'), content: '{"token":"npm_AbCdEf123456789xyz"}' } } });
      expect(read).toMatchObject({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { file: { content: '{"token":"[secret:NPM_TOKEN]"}' } } } });
      const grep = await post({ tool_name: 'Grep', tool_response: { mode: 'content', filenames: [], content: `${path.join(repo, 'src', 'a.ts')}:1:npm_AbCdEf123456789xyz` } });
      expect(JSON.stringify(grep)).not.toContain('npm_AbCdEf123456789xyz');
      expect(JSON.stringify(grep)).toContain('[secret:NPM_TOKEN]');
      // Nothing stored in it: the result passes untouched.
      expect(await post({ tool_name: 'Read', tool_response: { file: { content: 'plain' } } })).toEqual({});
    } finally {
      __resetRedactedSecretsForTesting();
    }
  });

  it('without a repository the bot keeps no built-in tools and only the guest gate hook', async () => {
    const o = await optionsFor(undefined);
    expect(o.tools).toEqual([]);
    expect((o.hooks as { PreToolUse: unknown[]; PostToolUse?: unknown }).PreToolUse).toHaveLength(1);
    expect((o.hooks as { PostToolUse?: unknown }).PostToolUse).toBeUndefined();
    expect(o.settings).toBeUndefined();
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']));
  });
});

// ── ACP ─────────────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  sessionParams: Array<Record<string, unknown>> = [];
  stdin = {
    write: (line: string) => {
      const msg = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
      queueMicrotask(() => {
        if (msg.method === 'session/new') {
          const servers = msg.params.mcpServers as Array<{ args: string[] }>;
          const file = botTokenFileArgValue(servers[0].args) ?? '';
          this.sessionParams.push({ ...msg.params, tokenAtSpawn: fs.readFileSync(file, 'utf8') });
          this.emitLine({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-bot' } });
        } else if (msg.method === 'initialize') {
          this.emitLine({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
        } else if (msg.method === 'session/prompt') {
          this.emitLine({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      });
      return true;
    },
  };
  emitLine(obj: Record<string, unknown>): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
  }
  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.emit('exit', 0);
    return true;
  }
}

describe('AcpBrainAdapter bot mode', () => {
  it('passes the bot args and token file per session, no token env, cwd = the bot folder', async () => {
    const child = new FakeChild();
    const adapter = new AcpBrainAdapter({
      spawnSpec: { command: 'hermes', args: ['acp'] },
      newSessionSettleMs: 0,
      mcpBundlePath: '/app/dist/mcp-bundle/index.js',
      bot: { binding: BINDING, cwd: dir, wmuxDir: dir },
      spawnFn: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    adapter.start({ systemPrompt: 'BOT' });
    const events = await collect(adapter.send('wake'));
    expect(events.at(-1)?.type).toBe('turn-end');
    const params = child.sessionParams[0];
    expect(params.cwd).toBe(dir);
    const server = (params.mcpServers as Array<{ command: string; args: string[]; env: Array<{ name: string }> }>)[0];
    expect(server.command).toBe(process.execPath);
    expect(botArgValue(server.args)).toBe('verifier');
    expect(server.env.map((e) => e.name).filter((n) => n !== 'WMUX_DATA_SUFFIX')).toEqual(['ELECTRON_RUN_AS_NODE']);
    expect(botTokenBinding(params.tokenAtSpawn)).toEqual(BINDING);
    adapter.dispose();
    expect(isCommanderToken(params.tokenAtSpawn)).toBe(false);
  });
});
