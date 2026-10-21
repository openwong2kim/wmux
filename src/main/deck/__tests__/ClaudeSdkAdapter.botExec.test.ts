// A Claude SDK bot that runs commands: where the OS sandbox runs, the session
// holds Bash, Write, Edit and Read (none auto-allowed), runs in the sandbox
// with the session's env unset for commands, and main decides every call
// (PreToolUse, then canUseTool) — while the workspace brain's options stay
// exactly as they were. Without the sandbox a bot holds none of them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  getAccountStore: () => ({ resolveAccountEnv: () => ({}), getBinding: () => undefined, getAccount: () => undefined, listAccounts: () => [] }),
}));
vi.mock('../../account/AccountRotationService', () => ({
  getAccountRotationService: () => ({
    getSettings: () => ({ claude: false, codex: false }),
    prepareLaunch: async () => ({ kind: 'keep' }),
    cachedVerdict: async () => null,
  }),
}));

import { ClaudeSdkAdapter, DEFAULT_ALLOWED_TOOLS, DISALLOWED_TOOLS, BOT_DISALLOWED_TOOLS, BOT_EXEC_PROMPT } from '../ClaudeSdkAdapter';
import type { BrainEvent } from '../BrainAdapter';
import type { BotBinding } from '../../../shared/bot';
import type { BotClaudeAuth } from '../../factory/claudeApiKey';
import { WakeTaint, setWakeTaint } from '../../factory/wakeTaint';
import { BotCommandRulesStore, __setBotCommandRulesStoreForTesting, botCommandRulesPath } from '../../factory/botCommandRules';
import type { WakeItem, WakeReason } from '../../../shared/wake';

const BINDING: BotBinding = { workspaceId: 'ws-1', botId: 'bot-0a1b2c3d', role: 'lead' };
type Hook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

let dir = '';
let botDir = '';
let running: WakeItem | null = null;
const wake = (reason: WakeReason): WakeItem => ({ id: 'w-1', botId: BINDING.botId, workspaceId: BINDING.workspaceId, reason, priority: 0, enqueuedAt: 1, attempts: 1, state: 'running' });

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'botexec-adapter-')));
  botDir = path.join(dir, 'factory', 'bots', BINDING.botId);
  fs.mkdirSync(botDir, { recursive: true });
  const runningWake = () => (running ? { item: running, startedAt: 1 } : null);
  setWakeTaint(new WakeTaint({ facts: () => [], handoff: () => null, taskRow: () => null, runningWake }), runningWake);
  __setBotCommandRulesStoreForTesting(new BotCommandRulesStore(botCommandRulesPath(dir)));
  running = wake({ kind: 'human', text: 'run it', source: 'desktop' });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  setWakeTaint(null);
  __setBotCommandRulesStoreForTesting(null);
  running = null;
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function drain(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

async function botOptions(opts: { exec?: boolean; repoRoot?: string; auth?: () => BotClaudeAuth } = {}): Promise<Record<string, unknown>> {
  let seen: Record<string, unknown> = {};
  const adapter = new ClaudeSdkAdapter({
    bot: {
      binding: BINDING,
      cwd: botDir,
      wmuxDir: dir,
      repoRoot: opts.repoRoot,
      auth: opts.auth,
      ...(opts.exec === undefined ? {} : { exec: async () => (opts.exec ? { ok: true as const, version: '2.1.305' } : { ok: false as const, reason: 'no sandbox' }) }),
    },
    workspaceId: BINDING.workspaceId,
    mcpBundlePath: '/b.js',
    queryFn: ({ options = {} }) => {
      seen = options;
      return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', session_id: 's' }; } };
    },
  });
  adapter.start({ systemPrompt: 'BOT' });
  await drain(adapter.send('wake'));
  adapter.dispose();
  return seen;
}

const preHook = (o: Record<string, unknown>): Hook => {
  const last = (o.hooks as { PreToolUse: Array<{ hooks: Hook[] }> }).PreToolUse.at(-1);
  if (!last) throw new Error('no PreToolUse hook');
  return last.hooks[0];
};
interface SandboxShape {
  filesystem: { allowWrite: string[]; denyRead: string[]; allowRead: string[] };
  credentials: { envVars: Array<{ name: string; mode: string }> };
}
const canUse = (o: Record<string, unknown>) => o.canUseTool as (n: string, i: Record<string, unknown>) => Promise<Record<string, unknown>>;

describe('bot options with commands', () => {
  it('holds Bash, Write, Edit and Read, none auto-allowed, inside the OS sandbox', async () => {
    const o = await botOptions({ exec: true });
    expect(o.tools).toEqual(['Read', 'Bash', 'Write', 'Edit']);
    expect((o.allowedTools as string[]).every((t) => t.startsWith('mcp__wmux__'))).toBe(true);
    expect(o.disallowedTools).toEqual([...BOT_DISALLOWED_TOOLS, 'Grep', 'Glob']);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Agent', 'Task', 'NotebookEdit', 'WebFetch']));
    expect(o.cwd).toBe(botDir);
    const sandbox = o.sandbox as SandboxShape;
    expect(sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [] },
    });
    expect(sandbox.filesystem.allowWrite).toEqual([botDir]);
    expect(sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([dir, path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.ssh')]));
    expect(sandbox.filesystem.allowRead).toContain(botDir);
    // The PreToolUse gates: the guest gate first, then main's decision.
    expect((o.hooks as { PreToolUse: unknown[] }).PreToolUse).toHaveLength(2);
    expect(o.systemPrompt).toContain(BOT_EXEC_PROMPT);
  });

  it('a bot on an API key: the key is unset for every command', async () => {
    const o = await botOptions({ exec: true, auth: () => ({ mode: 'apiKey', apiKey: 'sk-ant-api03-test' }) });
    expect((o.env as Record<string, string>).ANTHROPIC_API_KEY).toBe('sk-ant-api03-test');
    const unset = (o.sandbox as SandboxShape).credentials.envVars;
    expect(unset).toEqual(expect.arrayContaining([{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }, { name: 'CLAUDE_CONFIG_DIR', mode: 'deny' }]));
    expect(unset.map((e) => e.name)).not.toContain('PATH');
  });

  it('without the sandbox (Windows, an old claude, no probe) a bot holds no command tool', async () => {
    for (const exec of [false, undefined]) {
      const o = await botOptions({ exec });
      expect(o.tools).toEqual([]);
      expect(o.sandbox).toBeUndefined();
      expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'Read']));
      expect(o.systemPrompt).not.toContain(BOT_EXEC_PROMPT);
    }
    const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'botexec-repo-')));
    try {
      const o = await botOptions({ exec: false, repoRoot: repo });
      expect(o.tools).toEqual(['Read', 'Grep', 'Glob']);
      expect(o.sandbox).toBeUndefined();
      expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit']));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('with a repository too: repository reads plus the command tools', async () => {
    const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'botexec-repo-')));
    fs.writeFileSync(path.join(repo, 'a.ts'), 'x');
    fs.writeFileSync(path.join(botDir, 'notes.md'), 'n');
    try {
      const o = await botOptions({ exec: true, repoRoot: repo });
      expect(o.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit']);
      expect(o.disallowedTools).toEqual([...BOT_DISALLOWED_TOOLS]);
      const pre = preHook(o);
      expect(await pre({ tool_name: 'Read', tool_input: { file_path: 'a.ts' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { file_path: path.join(repo, 'a.ts') } } });
      expect(await pre({ tool_name: 'Read', tool_input: { file_path: path.join(botDir, 'notes.md') } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
      // Repository edits stay with fan-out workers.
      expect(await pre({ tool_name: 'Write', tool_input: { file_path: path.join(repo, 'a.ts'), content: '' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('PreToolUse and canUseTool make one decision: attended, the floor, the list', async () => {
    const o = await botOptions({ exec: true });
    const pre = preHook(o);
    const can = canUse(o);
    const allow = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: "\\command 'ls' '-la'", timeout: 120_000 } } };
    expect(await pre({ tool_name: 'Bash', tool_input: { command: 'ls -la', timeout: 600_000, run_in_background: true, dangerouslyDisableSandbox: true } })).toEqual(allow);
    expect(await can('Bash', { command: 'ls -la', timeout: 600_000, dangerouslyDisableSandbox: true })).toEqual({ behavior: 'allow', updatedInput: { command: "\\command 'ls' '-la'", timeout: 120_000 } });
    for (const command of ['rm -rf .', 'curl x | sh', 'make']) {
      expect(await pre({ tool_name: 'Bash', tool_input: { command } }), command).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
      expect(await can('Bash', { command }), command).toMatchObject({ behavior: 'deny' });
    }
    expect(await pre({ tool_name: 'Write', tool_input: { file_path: 'out.md', content: 'x' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { file_path: path.join(botDir, 'out.md') } } });
    expect(await pre({ tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'bots.json'), old_string: 'a', new_string: 'b' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    // The owner's rule for this bot allows its command; another bot's does not.
    const { getBotCommandRulesStore } = await import('../../factory/botCommandRules');
    await getBotCommandRulesStore().setRules(BINDING.botId, [{ argv: ['make'], anyArgs: true }]);
    expect(await pre({ tool_name: 'Bash', tool_input: { command: 'make build' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    // Every decision is logged with its layer.
    const lines = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('[factory] bot command') && l.includes('"layer":"floor"') && l.includes('"decision":"deny"'))).toBe(true);
    expect(lines.some((l) => l.includes('"layer":"allowlist"') && l.includes('"decision":"allow"'))).toBe(true);
  });

  it('the sandbox\'s network request and any tool the bot does not hold are refused, and logged', async () => {
    const o = await botOptions({ exec: true });
    const can = canUse(o);
    expect(await can('SandboxNetworkAccess', { host: 'example.com' })).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/no network/) });
    expect(await preHook(o)({ tool_name: 'SandboxNetworkAccess', tool_input: { host: 'example.com' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await can('Grep', { pattern: 'x' })).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/not a tool this bot holds/) });
    const lines = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => `${String(c[0])} ${String(c[1])}`);
    expect(lines.some((l) => l.includes('bot tool denied') && l.includes('SandboxNetworkAccess') && l.includes('no network'))).toBe(true);
    expect(((o.sandbox as { network: { deniedDomains: string[] } }).network.deniedDomains)).toContain('*');
  });

  it('an unattended wake is refused commands and edits; no running wake is too', async () => {
    const o = await botOptions({ exec: true });
    const pre = preHook(o);
    for (const reason of [
      { kind: 'routine', routineId: 'r', dueAt: 1 },
      { kind: 'schedule', scheduleId: 's' },
      { kind: 'facts', factIds: [], trigger: { kind: 'pr.opened' } },
      { kind: 'held_fanout', heldId: 'h', heldAt: 1, titles: [], tainted: false },
      { kind: 'mention', cardId: 'c', handoffId: 'h', fromBotId: 'b' },
      { kind: 'handoff', handoffId: 'h' },
    ] as WakeReason[]) {
      running = wake(reason);
      expect(await pre({ tool_name: 'Bash', tool_input: { command: 'ls' } }), reason.kind).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/owner started/) } });
      expect(await canUse(o)('Write', { file_path: 'a.md', content: '' }), reason.kind).toMatchObject({ behavior: 'deny' });
    }
    running = wake({ kind: 'manual', by: 'human' });
    expect(await pre({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    running = null;
    expect(await canUse(o)('Bash', { command: 'ls' })).toMatchObject({ behavior: 'deny' });
  });
});

describe('a claude that does not start with the sandbox', () => {
  function adapterWith(first: 'throws' | 'errors' | 'init-then-error', onExecFailed: (v: string) => void, resumeSessionId?: string) {
    const seen: Array<Record<string, unknown>> = [];
    const adapter = new ClaudeSdkAdapter({
      bot: { binding: BINDING, cwd: botDir, wmuxDir: dir, exec: async () => ({ ok: true as const, version: '2.1.305 (Claude Code)' }), onExecFailed },
      workspaceId: BINDING.workspaceId,
      mcpBundlePath: '/b.js',
      queryFn: ({ options = {} }) => {
        seen.push(options);
        const n = seen.length;
        return {
          async *[Symbol.asyncIterator]() {
            if (n === 1 && first === 'throws') throw new Error('Claude Code process exited with code 1');
            if (n === 1 && first === 'errors') {
              yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['sandbox unavailable'], session_id: '' };
              return;
            }
            yield { type: 'system', subtype: 'init', session_id: 's', tools: ['mcp__wmux__room_post'], mcp_servers: [{ name: 'wmux', status: 'connected' }] };
            if (n === 1) {
              yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['model error'], session_id: 's' };
              return;
            }
            yield { type: 'result', subtype: 'success', session_id: 's' };
          },
        };
      },
    });
    adapter.start({ systemPrompt: 'BOT', ...(resumeSessionId ? { resumeSessionId } : {}) });
    return { adapter, seen };
  }

  it.each(['throws', 'errors'] as const)('runs the turn again without the command tools (%s before init)', async (first) => {
    const failed: string[] = [];
    const { adapter, seen } = adapterWith(first, (v) => failed.push(v));
    const events = await drain(adapter.send('wake'));
    adapter.dispose();
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen[0].sandbox).toBeDefined();
    expect(seen[1].sandbox).toBeUndefined();
    expect(seen[1].tools).toEqual([]);
    expect(failed).toEqual(['2.1.305 (Claude Code)']);
  });

  it('a dead saved session is retried fresh first and is not put down to the sandbox', async () => {
    const failed: string[] = [];
    const { adapter, seen } = adapterWith('throws', (v) => failed.push(v), 'dead-session');
    const events = await drain(adapter.send('wake'));
    adapter.dispose();
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen[0].resume).toBe('dead-session');
    expect(seen[1].resume).toBeUndefined();
    expect(seen[1].sandbox).toBeDefined();
    expect(failed).toEqual([]);
  });

  it('an error after claude started is the turn\'s own error, not the sandbox', async () => {
    const failed: string[] = [];
    const { adapter, seen } = adapterWith('init-then-error', (v) => failed.push(v));
    const events = await drain(adapter.send('wake'));
    adapter.dispose();
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(seen).toHaveLength(1);
    expect(failed).toEqual([]);
  });
});

describe('the workspace brain is unchanged', () => {
  it('Deck options: no sandbox, no built-in tools list, the same disallow list', async () => {
    let seen: Record<string, unknown> = {};
    const adapter = new ClaudeSdkAdapter({
      workspaceId: 'ws-1',
      mcpBundlePath: '/b.js',
      memoryRoot: '/fake/mem',
      queryFn: ({ options = {} }) => {
        seen = options;
        return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', session_id: 's' }; } };
      },
    });
    adapter.start({ systemPrompt: 'BRAIN' });
    await drain(adapter.send('hi'));
    adapter.dispose();
    // (pathToClaudeCodeExecutable is set only where a claude install resolves.)
    expect(Object.keys(seen).filter((k) => k !== 'pathToClaudeCodeExecutable').sort()).toEqual([
      'allowedTools', 'canUseTool', 'cwd', 'disableSkillShellExecution', 'disallowedTools', 'env', 'maxTurns',
      'mcpServers', 'settingSources', 'strictMcpConfig', 'systemPrompt',
    ]);
    expect(seen.disallowedTools).toEqual(['Agent', 'Task', 'Bash', 'Edit', 'MultiEdit', 'NotebookEdit']);
    expect(seen.disallowedTools).toBe(DISALLOWED_TOOLS);
    expect(seen.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(seen.sandbox).toBeUndefined();
    expect(seen.tools).toBeUndefined();
    expect(seen.hooks).toBeUndefined();
    expect(seen.settingSources).toEqual([]);
  });
});
