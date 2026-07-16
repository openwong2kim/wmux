// Unit tests for ClaudeSdkAdapter (Command Deck P2b). The SDK `query` is
// injected as a fake async-iterable, so no subprocess spawns and no live model
// is hit; electron + the SDK module are mocked at import time.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/repo',
    getPath: () => '/home',
  },
}));

// The real SDK export is never called (queryFn is injected), but the top-level
// import must resolve — stub it.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

// Mock the memory module so the DEFAULT (omitted-loadMemory) path never reads
// the developer's real ~/.wmux store — the file's hermeticity rule. The spy
// echoes its workspaceId so tests can assert the wiring; every test that cares
// about memory content still injects its own loadMemory.
vi.mock('../commanderMemory', () => ({
  loadCommanderMemory: vi.fn((opts?: { workspaceId?: string }) => `MEM[${opts?.workspaceId ?? ''}]`),
  loadGlobalMemory: vi.fn(() => ''),
  // Defensive: the Write sandbox falls back to this only when no memoryRoot is
  // injected AND canUseTool fires. Tests that exercise canUseTool inject their
  // own memoryRoot, so this is a safety net, not a live path.
  getMemoryRootDir: vi.fn(() => '/fake/mem'),
}));

// Controllable account store (M3 launch-accountId attribution). Hoisted so the
// vi.mock factory can reference it. Only exercised by tests that pass a
// workspaceId; buildEnv's `if (this._workspaceId)` guard skips it otherwise, so
// the existing (workspaceId-less) tests are unaffected by this mock.
const acctMock = vi.hoisted(() => {
  const state: {
    binding: string | null;
    accounts: Record<string, { id: string; name: string; vendor: string; configDir: string }>;
  } = {
    binding: 'acc-1',
    accounts: { 'acc-1': { id: 'acc-1', name: 'Work Max', vendor: 'claude', configDir: 'C:/dirs/acc-1' } },
  };
  return { state };
});
vi.mock('../../account/accountStore', () => ({
  VENDOR_ENV_KEYS: { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' },
  getAccountStore: () => ({
    resolveAccountEnv: (_ws: string, _vendor: string) => {
      const id = acctMock.state.binding;
      const acc = id ? acctMock.state.accounts[id] : undefined;
      return acc ? { CLAUDE_CONFIG_DIR: acc.configDir } : {};
    },
    getBinding: () => acctMock.state.binding ?? undefined,
    getAccount: (id: string) => acctMock.state.accounts[id],
  }),
}));

import {
  ClaudeSdkAdapter,
  DEFAULT_ALLOWED_TOOLS,
  DISALLOWED_TOOLS,
  buildCommanderSystemPrompt,
  __resetLimitShapeLogForTests,
  type SdkQueryHandle,
} from '../ClaudeSdkAdapter';
import { loadCommanderMemory } from '../commanderMemory';
import type { RawSdkMessage } from '../BrainAdapter';
import type { BrainEvent } from '../BrainAdapter';

/** Build a fake query handle that yields the given frames and records interrupt. */
function fakeHandle(frames: RawSdkMessage[], onInterrupt?: () => void): SdkQueryHandle {
  return {
    async *[Symbol.asyncIterator]() {
      for (const f of frames) yield f;
    },
    interrupt: onInterrupt ? () => onInterrupt() : undefined,
  };
}

async function collect(it: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

describe('ClaudeSdkAdapter', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('streams normalized events for a turn and captures the session id', async () => {
    const frames: RawSdkMessage[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-A' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'result', subtype: 'success', session_id: 'sess-A' },
    ];
    const adapter = new ClaudeSdkAdapter({
      queryFn: () => fakeHandle(frames),
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ systemPrompt: 'SYS' });
    const events = await collect(adapter.send('do it'));
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'turn-end']);
    expect(adapter.sessionId).toBe('sess-A');
  });

  it('scrubs ANTHROPIC_API_KEY and passes resume on the second turn', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-be-dropped';
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { prompt: string; options: Record<string, unknown> });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 'sess-B' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
      // Hermetic: never read the developer's real ~/.wmux memory store here.
      loadMemory: () => '',
    });
    adapter.start({ systemPrompt: 'SYS', fleetContext: 'FLEET' });

    await collect(adapter.send('first'));
    const opts1 = calls[0].options;
    const env1 = opts1.env as Record<string, string | undefined>;
    expect('ANTHROPIC_API_KEY' in env1 && env1.ANTHROPIC_API_KEY !== undefined).toBe(false);
    // First turn has no resume; fleet context is prepended once.
    expect(opts1.resume).toBeUndefined();
    expect(calls[0].prompt).toContain('FLEET');
    expect(calls[0].prompt).toContain('first');
    // wmux MCP mounted + allow-list applied. The bundle is spawned with wmux's
    // OWN binary in Node mode (never a PATH `node` — end users may not have one),
    // and carries the per-spawn commander token (fleet-wide routing — codex P1).
    const mcpServers = opts1.mcpServers as {
      wmux: { type: string; command: string; args: string[]; env: Record<string, string> };
    };
    expect(mcpServers.wmux.type).toBe('stdio');
    expect(mcpServers.wmux.command).toBe(process.execPath);
    expect(mcpServers.wmux.args).toEqual(['/fake/mcp.js']);
    expect(mcpServers.wmux.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(mcpServers.wmux.env.WMUX_COMMANDER_TOKEN?.length).toBeGreaterThanOrEqual(64);
    expect(opts1.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);

    await collect(adapter.send('second'));
    expect(calls[1].options.resume).toBe('sess-B');
    // Fleet context injected once only.
    expect(calls[1].prompt).not.toContain('FLEET');
  });

  it('default allow-list omits the destructive close tools (P3 gate)', () => {
    expect(DEFAULT_ALLOWED_TOOLS).toContain('mcp__wmux__pane_split');
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('mcp__wmux__pane_close');
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('mcp__wmux__surface_close');
  });

  it('hard-disallows the built-in subagent/file/shell tools on every spawn', async () => {
    // Live-transcript finding: allowedTools only skips permission prompts, and
    // the built-in Agent/Task tools execute WITHOUT one — the brain used them
    // to fake "spawned an agent" instead of driving a real pane. They must be
    // removed at the tool level, not left to the permission system.
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 's' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
      loadMemory: () => '',
    });
    adapter.start({ systemPrompt: 'SYS' });
    await collect(adapter.send('go'));
    expect(calls[0].options.disallowedTools).toEqual(DISALLOWED_TOOLS);
    for (const t of ['Agent', 'Task', 'Bash', 'Edit']) {
      expect(DISALLOWED_TOOLS).toContain(t);
    }
    // M1b: Write is no longer hard-disallowed — it flows through the canUseTool
    // sandbox instead, and must stay out of BOTH lists (allowedTools would
    // bypass the sandbox; disallowedTools would remove it entirely).
    expect(DISALLOWED_TOOLS).not.toContain('Write');
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('Write');
    // The disallow list and the allow list must never overlap — a tool in both
    // would be ambiguous at the CLI layer.
    for (const t of DISALLOWED_TOOLS) {
      expect(DEFAULT_ALLOWED_TOOLS).not.toContain(t);
    }
  });

  it('loads NO filesystem settings (settingSources: []) — brain turns must not inherit user hooks', async () => {
    // RCA 2026-07-13 (stutter report): the SDK default is
    // ['user','project','local'], so every brain turn loaded the user's
    // ~/.claude settings INCLUDING the wmux plugin's PostToolUse/Stop hooks —
    // each brain tool call spawned a ~110ms node bridge process and the
    // brain's own Stop re-entered hooks.signal as a phantom agent event.
    // The brain's contract is fully explicit (systemPrompt / allowedTools /
    // canUseTool / strictMcpConfig); it must load nothing from disk.
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 's' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
      loadMemory: () => '',
    });
    adapter.start({ systemPrompt: 'SYS' });
    await collect(adapter.send('go'));
    expect(calls[0].options.settingSources).toEqual([]);
    // Raw mode keeps the plain string system prompt and the base allow-list.
    expect(calls[0].options.systemPrompt).toBe('SYS');
    expect(calls[0].options.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
  });

  it('full-power mode loads user+project settings, presets the system prompt, and allows Skill (BYOB A)', async () => {
    // The opt-in reverse of the raw-mode contract above: the user explicitly
    // accepts hooks-in-brain-turns to get their skill ecosystem. Everything
    // conservative stays: DISALLOWED_TOOLS, the canUseTool sandbox, and
    // strictMcpConfig are asserted unchanged so full power can never silently
    // widen the brain's hands beyond Skill invocation.
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 's' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
      loadMemory: () => '',
      fullPower: true,
    });
    adapter.start({ systemPrompt: 'SYS' });
    await collect(adapter.send('go'));
    const opts = calls[0].options;
    expect(opts.settingSources).toEqual(['user', 'project']);
    expect(opts.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'SYS' });
    expect(opts.allowedTools).toEqual([...DEFAULT_ALLOWED_TOOLS, 'Skill']);
    // v1-conservative invariants — the sandbox does NOT relax with the toggle.
    // Write is additionally HARD-disallowed under full power: the user's own
    // settings allow-rules are decided before canUseTool, so disallowedTools
    // is the one layer a personal Write(...) rule cannot shadow (review r1).
    expect(opts.disallowedTools).toEqual([...DISALLOWED_TOOLS, 'Write']);
    expect(opts.strictMcpConfig).toBe(true);
    // Skills' inline-shell syntax executes outside the tool gates — the SDK
    // placeholder switch must be on (Codex review r1).
    expect(opts.disableSkillShellExecution).toBe(true);
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('installs a canUseTool sandbox that allows own-memory Write and denies the rest', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    // Inject a hermetic memory root so the sandbox never touches ~/.wmux.
    const memoryRoot = path.join(os.tmpdir(), 'wmux-m1b-adapter-test');
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 's' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
      loadMemory: () => '',
      workspaceId: 'ws-1',
      memoryRoot,
    });
    adapter.start({ systemPrompt: 'SYS' });
    await collect(adapter.send('go'));

    const canUseTool = calls[0].options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
    ) => Promise<{ behavior: string; message?: string }>;
    expect(typeof canUseTool).toBe('function');

    // Allowed: a `.md` write into this workspace's own partition.
    const allowed = await canUseTool('Write', {
      file_path: path.join(memoryRoot, 'ws-1', 'note.md'),
    });
    expect(allowed.behavior).toBe('allow');

    // Denied: a write outside the memory sandbox entirely.
    const deniedPath = await canUseTool('Write', {
      file_path: path.join(os.tmpdir(), 'escape.md'),
    });
    expect(deniedPath.behavior).toBe('deny');

    // Denied: any other tool that reaches the callback.
    const deniedTool = await canUseTool('Bash', { command: 'rm -rf /' });
    expect(deniedTool.behavior).toBe('deny');
  });

  it('full-power mode keeps the exact same canUseTool sandbox matrix (GLM review)', async () => {
    // The toggle must not change what the callback DECIDES — only Skill moves
    // to the auto-allow list. Re-run the sandbox matrix with fullPower on so a
    // future default-allow fallback in the callback can't hide behind the
    // shape-only assertion in the full-power options test.
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const memoryRoot = path.join(os.tmpdir(), 'wmux-fullpower-sandbox-test');
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 's' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
      loadMemory: () => '',
      workspaceId: 'ws-1',
      memoryRoot,
      fullPower: true,
    });
    adapter.start({ systemPrompt: 'SYS' });
    await collect(adapter.send('go'));
    const canUseTool = calls[0].options.canUseTool as (
      toolName: string,
      input: Record<string, unknown>,
    ) => Promise<{ behavior: string }>;

    expect((await canUseTool('Write', {
      file_path: path.join(memoryRoot, 'ws-1', 'note.md'),
    })).behavior).toBe('allow');
    expect((await canUseTool('Write', {
      file_path: path.join(os.tmpdir(), 'escape.md'),
    })).behavior).toBe('deny');
    expect((await canUseTool('Bash', { command: 'rm -rf /' })).behavior).toBe('deny');
    // An MCP tool outside the allow-list reaching the callback stays denied.
    expect((await canUseTool('mcp__wmux__pane_close', { paneId: 'p1' })).behavior).toBe('deny');
  });

  it('grounds real-pane agent launches in the system prompt (no theater)', () => {
    const prompt = buildCommanderSystemPrompt();
    expect(prompt).toContain('LAUNCHING AN AGENT');
    expect(prompt).toContain('--dangerously-skip-permissions');
    expect(prompt).toContain('Agent/Task tools are disabled');
    expect(prompt).toContain('Never type a fake prompt');
  });

  it('GLM profile injects the compatible base-url / auth-token', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 's' }]);
      },
      mcpBundlePath: null,
      profile: { baseUrl: 'https://glm.example', authToken: 'glm-tok' },
    });
    adapter.start({});
    await collect(adapter.send('x'));
    const env = calls[0].options.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://glm.example');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('glm-tok');
    // No bundle → no MCP server mounted, no fleet tools.
    expect(calls[0].options.mcpServers).toBeUndefined();
    expect(adapter.hasFleetTools).toBe(false);
  });

  it('yields an error event when the query throws', async () => {
    const adapter = new ClaudeSdkAdapter({
      queryFn: () => {
        throw new Error('spawn failed');
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({});
    const events = await collect(adapter.send('x'));
    expect(events).toEqual([{ type: 'error', message: 'spawn failed' }]);
  });

  it('resumes on the FIRST turn from a persisted session id (P3a) and pins a stable cwd', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 'sess-live' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ systemPrompt: 'SYS', resumeSessionId: 'sess-disk' });
    const events = await collect(adapter.send('hello again'));
    expect(events.map((e) => e.type)).toEqual(['turn-end']);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.resume).toBe('sess-disk');
    // Session storage must not key on the (per-version) process cwd.
    expect(calls[0].options.cwd).toContain('.wmux');
    expect(adapter.sessionId).toBe('sess-live');
  });

  it('falls back to a fresh session when the seeded resume id is dead (error frame)', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return calls.length === 1
          ? fakeHandle([{ type: 'result', subtype: 'error_during_execution' }])
          : fakeHandle([
              { type: 'assistant', message: { content: [{ type: 'text', text: 'fresh' }] } },
              { type: 'result', subtype: 'success', session_id: 'sess-new' },
            ]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ resumeSessionId: 'sess-dead' });
    const events = await collect(adapter.send('go'));
    // The dead attempt's error is swallowed; only the fresh turn surfaces.
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'turn-end']);
    expect(calls).toHaveLength(2);
    expect(calls[0].options.resume).toBe('sess-dead');
    expect(calls[1].options.resume).toBeUndefined();
    expect(adapter.sessionId).toBe('sess-new');
  });

  it('falls back to a fresh session when the resumed spawn throws', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        if (calls.length === 1) throw new Error('no conversation with that id');
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 'sess-new' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ resumeSessionId: 'sess-dead' });
    const events = await collect(adapter.send('go'));
    expect(events.map((e) => e.type)).toEqual(['turn-end']);
    expect(calls).toHaveLength(2);
    expect(adapter.sessionId).toBe('sess-new');
  });

  it('does NOT retry when the error arrives after content already streamed', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return fakeHandle([
          { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
          { type: 'result', subtype: 'error_during_execution' },
        ]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ resumeSessionId: 'sess-disk' });
    const events = await collect(adapter.send('go'));
    // A mid-turn failure is a REAL turn failure, not a dead resume id.
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'error']);
    expect(calls).toHaveLength(1);
  });

  it('validates the resumed id on FIRST streamed content — a later pre-content error keeps the session (codex P2)', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        if (calls.length === 1) {
          // Turn 1: streams REAL content, then dies before any turn-end —
          // the id is proven valid by the content alone.
          return fakeHandle([
            { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
            { type: 'result', subtype: 'error_during_execution' },
          ]);
        }
        // Turn 2: pre-content error. With the flag still set this would be
        // misread as a dead persisted id and the conversation dropped.
        return fakeHandle([{ type: 'result', subtype: 'error_during_execution' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ resumeSessionId: 'sess-disk' });
    await collect(adapter.send('first'));
    expect(adapter.sessionId).toBe('sess-disk'); // kept after the mid-turn failure

    const events = await collect(adapter.send('second'));
    // Surfaces the error as-is: ONE attempt, no dead-id fallback, id retained.
    expect(events).toEqual([{ type: 'error', message: 'error_during_execution' }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBe('sess-disk');
    expect(adapter.sessionId).toBe('sess-disk');
  });

  it('does NOT retry once the resumed id was validated by a completed turn', async () => {
    const calls: Array<{ options: Record<string, unknown> }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { options: Record<string, unknown> });
        return calls.length === 1
          ? fakeHandle([{ type: 'result', subtype: 'success', session_id: 'sess-disk' }])
          : fakeHandle([{ type: 'result', subtype: 'error_during_execution' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ resumeSessionId: 'sess-disk' });
    await collect(adapter.send('first'));
    const events = await collect(adapter.send('second'));
    // The second turn's error surfaces as-is: one call per turn, no fallback.
    expect(events).toEqual([{ type: 'error', message: 'error_during_execution' }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBe('sess-disk');
  });

  it('interrupt() forwards to the active query handle', async () => {
    const onInterrupt = vi.fn();
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    const adapter = new ClaudeSdkAdapter({
      queryFn: () =>
        ({
          async *[Symbol.asyncIterator]() {
            await gate; // hold the turn open
            yield { type: 'result', subtype: 'success', session_id: 's' } as RawSdkMessage;
          },
          interrupt: onInterrupt,
        }) as SdkQueryHandle,
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({});
    const turn = collect(adapter.send('x'));
    // Let the iterator start and register the active handle.
    await Promise.resolve();
    adapter.interrupt();
    expect(onInterrupt).toHaveBeenCalled();
    released();
    await turn;
  });

  // ─── M1a: durable memory injection (read-only L0) ─────────────────────────

  it('injects memory before the fleet context on the first turn only', async () => {
    const calls: Array<{ prompt: string }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { prompt: string });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 'sess-M' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
      loadMemory: () => 'MEMORY-BLOCK',
    });
    adapter.start({ systemPrompt: 'SYS', fleetContext: 'FLEET' });

    await collect(adapter.send('first'));
    expect(calls[0].prompt).toContain('MEMORY-BLOCK');
    expect(calls[0].prompt.indexOf('MEMORY-BLOCK')).toBeLessThan(calls[0].prompt.indexOf('FLEET'));
    expect(calls[0].prompt).toContain('first');

    await collect(adapter.send('second'));
    expect(calls[1].prompt).not.toContain('MEMORY-BLOCK');
    expect(calls[1].prompt).not.toContain('FLEET');
  });

  it('injects memory even when there is no fleet context', async () => {
    const calls: Array<{ prompt: string }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { prompt: string });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 'sess-M2' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
      loadMemory: () => 'MEMORY-ONLY',
    });
    adapter.start({ systemPrompt: 'SYS' });
    await collect(adapter.send('go'));
    expect(calls[0].prompt).toContain('MEMORY-ONLY');
    expect(calls[0].prompt).toContain('go');
  });

  it('a throwing memory loader never breaks the turn', async () => {
    const calls: Array<{ prompt: string }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { prompt: string });
        return fakeHandle([
          { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
          { type: 'result', subtype: 'success', session_id: 'sess-M3' },
        ]);
      },
      mcpBundlePath: '/fake/mcp.js',
      loadMemory: () => {
        throw new Error('corrupt memory store');
      },
    });
    adapter.start({ systemPrompt: 'SYS', fleetContext: 'FLEET' });
    const events = await collect(adapter.send('resilient'));
    expect(events.map((e) => e.type)).toEqual(['text-delta', 'turn-end']);
    expect(calls[0].prompt).toContain('FLEET'); // fleet context still injected
    expect(calls[0].prompt).toContain('resilient');
  });

  it('default memory loader is workspace-aware (M1c)', async () => {
    // No loadMemory injected → exercises the DEFAULT loader, which must layer
    // THIS workspace's partition via loadCommanderMemory({ workspaceId }).
    vi.mocked(loadCommanderMemory).mockClear();
    const calls: Array<{ prompt: string }> = [];
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { prompt: string });
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 'sess-ws' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
      workspaceId: 'ws-x',
    });
    adapter.start({ systemPrompt: 'SYS' });
    await collect(adapter.send('go'));
    expect(loadCommanderMemory).toHaveBeenCalledWith({ workspaceId: 'ws-x' });
    // And its output actually reaches the composed first-turn prompt.
    expect(calls[0].prompt).toContain('MEM[ws-x]');
  });

  it('does not double-inject memory on a resume-fallback retry', async () => {
    // First attempt runs against a dead disk-seeded session id and errors
    // before any event; the retry must re-send the SAME composed prompt.
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    let attempt = 0;
    const adapter = new ClaudeSdkAdapter({
      queryFn: (p) => {
        calls.push(p as { prompt: string; options: Record<string, unknown> });
        attempt += 1;
        if (attempt === 1) {
          return fakeHandle([
            { type: 'result', subtype: 'error_during_execution', session_id: 'dead-id' },
          ]);
        }
        return fakeHandle([{ type: 'result', subtype: 'success', session_id: 'sess-M4' }]);
      },
      mcpBundlePath: '/fake/mcp.js',
      loadMemory: () => 'MEMORY-BLOCK',
    });
    adapter.start({ systemPrompt: 'SYS', fleetContext: 'FLEET', resumeSessionId: 'dead-id' });
    await collect(adapter.send('retry me'));
    expect(calls.length).toBe(2);
    // Same composed prompt on both attempts — one MEMORY-BLOCK each, not two.
    expect(calls[0].prompt).toBe(calls[1].prompt);
    expect(calls[1].prompt.match(/MEMORY-BLOCK/g)?.length).toBe(1);
  });

  // ── M3: limit-event account attribution (launch-time capture) ──────────────

  it('stamps a limit event with the account the session LAUNCHED on', async () => {
    acctMock.state.binding = 'acc-1';
    const adapter = new ClaudeSdkAdapter({
      workspaceId: 'ws-9',
      queryFn: () =>
        fakeHandle([
          { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_700_000_000 } } as RawSdkMessage,
          { type: 'result', subtype: 'success', session_id: 's' },
        ]),
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ systemPrompt: 'SYS' });
    const events = await collect(adapter.send('go'));
    const limit = events.find((e) => e.type === 'limit');
    expect(limit).toMatchObject({ type: 'limit', status: 'rejected', accountId: 'acc-1', accountName: 'Work Max' });
  });

  it('carries the LAUNCH account even if the binding changes mid-session (Codex P1)', async () => {
    acctMock.state.binding = 'acc-1';
    const adapter = new ClaudeSdkAdapter({
      workspaceId: 'ws-9',
      queryFn: () => {
        // Simulate a rebind that lands AFTER this turn's buildEnv already ran.
        acctMock.state.binding = 'acc-2';
        acctMock.state.accounts['acc-2'] = { id: 'acc-2', name: 'Personal', vendor: 'claude', configDir: 'C:/dirs/acc-2' };
        return fakeHandle([
          { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } } as RawSdkMessage,
          { type: 'result', subtype: 'success', session_id: 's' },
        ]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ systemPrompt: 'SYS' });
    const events = await collect(adapter.send('go'));
    const limit = events.find((e) => e.type === 'limit');
    // buildEnv captured acc-1 at launch — the mid-turn rebind to acc-2 must NOT win.
    expect(limit).toMatchObject({ accountId: 'acc-1', accountName: 'Work Max' });
  });

  it('omits the account name when the launch account was since removed (existence gate)', async () => {
    acctMock.state.binding = 'acc-1';
    const adapter = new ClaudeSdkAdapter({
      workspaceId: 'ws-9',
      queryFn: () => {
        // Account removed after launch: getBinding still returns the id (dangling)
        // but getAccount is now null → id kept, name omitted.
        delete acctMock.state.accounts['acc-1'];
        return fakeHandle([
          { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } } as RawSdkMessage,
          { type: 'result', subtype: 'success', session_id: 's' },
        ]);
      },
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ systemPrompt: 'SYS' });
    const events = await collect(adapter.send('go'));
    const limit = events.find((e) => e.type === 'limit') as Extract<BrainEvent, { type: 'limit' }>;
    expect(limit.accountId).toBe('acc-1');
    expect(limit.accountName).toBeUndefined();
  });

  it('no account binding → limit event carries no accountId (default credential)', async () => {
    acctMock.state.binding = null;
    acctMock.state.accounts['acc-1'] = { id: 'acc-1', name: 'Work Max', vendor: 'claude', configDir: 'C:/dirs/acc-1' };
    const adapter = new ClaudeSdkAdapter({
      workspaceId: 'ws-9',
      queryFn: () =>
        fakeHandle([
          { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } } as RawSdkMessage,
          { type: 'result', subtype: 'success', session_id: 's' },
        ]),
      mcpBundlePath: '/fake/mcp.js',
    });
    adapter.start({ systemPrompt: 'SYS' });
    const events = await collect(adapter.send('go'));
    const limit = events.find((e) => e.type === 'limit') as Extract<BrainEvent, { type: 'limit' }>;
    expect(limit.accountId).toBeUndefined();
    expect(limit.accountName).toBeUndefined();
  });

  it('logs the first limit-event shape ONCE per process, then stays silent (#2b)', async () => {
    __resetLimitShapeLogForTests();
    acctMock.state.binding = null;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const mk = () =>
        new ClaudeSdkAdapter({
          workspaceId: 'ws-9',
          queryFn: () =>
            fakeHandle([
              { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } } as RawSdkMessage,
              { type: 'result', subtype: 'success', session_id: 's' },
            ]),
          mcpBundlePath: '/fake/mcp.js',
        });
      const a = mk(); a.start({ systemPrompt: 'S' }); await collect(a.send('1'));
      const b = mk(); b.start({ systemPrompt: 'S' }); await collect(b.send('2'));
      const limitLogs = logSpy.mock.calls.filter((c) => String(c[0]).includes('rate-limit event observed'));
      expect(limitLogs).toHaveLength(1); // one-shot guard: second event is silent
      // And the log line never carries a token-shaped field.
      expect(JSON.stringify(limitLogs[0])).not.toMatch(/accessToken|Bearer|sk-/);
    } finally {
      logSpy.mockRestore();
    }
  });
});
