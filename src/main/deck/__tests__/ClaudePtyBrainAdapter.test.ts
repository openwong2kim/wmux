// Unit tests for ClaudePtyBrainAdapter (the `claude-pty` brain vendor).
//
// The daemon pty host is injected as a fake, so no daemon runs, no claude
// spawns, and the whole turn protocol is driven by hand-built hook signals —
// exactly the shape the real `wmux-bridge.mjs` sends. Electron is mocked at
// import time (the adapter pulls resolveMcpBundlePath from ClaudeSdkAdapter).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' },
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import {
  ClaudePtyBrainAdapter,
  scrubBrainSpawnEnv,
  buildBrainSettingsProfile,
  buildBrainLaunchCommand,
  flattenPromptForPty,
  BRAIN_PTY_ALLOWED_TOOLS,
  type BrainPtyHost,
} from '../ClaudePtyBrainAdapter';
import { deliverBrainPtyHookSignal, __resetBrainPtyHookBusForTesting } from '../brainPtyHookBus';
import { __resetCommanderTrustForTesting } from '../commanderTrust';
import type { AgentSignal } from '../../../shared/hooks/signal-types';
import type { BrainEvent } from '../BrainAdapter';

// ── fake daemon pty ─────────────────────────────────────────────────────────

interface FakeHost extends BrainPtyHost {
  readonly created: Array<{ id: string; command: string; env: Record<string, string>; cwd: string }>;
  readonly writes: Array<{ id: string; data: string }>;
  readonly destroyed: string[];
  /** Output the NEXT spawned session replays the moment the adapter
   *  subscribes — the banner arrives before any test code can observe the
   *  spawn, so queueing it is the only race-free way to script it. */
  nextBanner: string | null;
}

function makeHost(): FakeHost {
  let pendingBanner: string | null = null;
  const created: FakeHost['created'] = [];
  const writes: FakeHost['writes'] = [];
  const destroyed: string[] = [];
  const listeners = new Map<string, (chunk: string) => void>();
  return {
    created,
    writes,
    destroyed,
    get nextBanner() {
      return pendingBanner;
    },
    set nextBanner(v: string | null) {
      pendingBanner = v;
    },
    async createSession(params) {
      created.push({ id: params.id, command: params.command, env: params.env, cwd: params.cwd });
    },
    async attach() {
      /* nothing to attach in the fake */
    },
    write(id, data) {
      writes.push({ id, data });
    },
    async destroy(id) {
      destroyed.push(id);
      listeners.delete(id);
    },
    onData(id, cb) {
      listeners.set(id, cb);
      if (pendingBanner) {
        const banner = pendingBanner;
        pendingBanner = null;
        cb(banner);
      }
      return () => listeners.delete(id);
    },
  };
}

/** A hook signal shaped like the real bridge's envelope. */
function signal(kind: AgentSignal['kind'], ptyId: string, extra: Partial<AgentSignal> = {}): AgentSignal {
  return {
    kind,
    agent: 'claude',
    cwd: '/tmp',
    ts: Date.now(),
    payload: {},
    ptyId,
    ...extra,
  };
}

let tmpDir: string;

function makeAdapter(host: FakeHost, over: Record<string, unknown> = {}): ClaudePtyBrainAdapter {
  return new ClaudePtyBrainAdapter({
    workspaceId: 'ws-1',
    host,
    claudeExecutable: '/usr/local/bin/claude',
    mcpBundlePath: '/repo/dist/mcp/entry.js',
    bridgePath: '/home/.wmux/hooks/wmux-bridge.mjs',
    wmuxDir: tmpDir,
    nodePath: '/usr/bin/node',
    sessionStartTimeoutMs: 5,
    staleResumeWindowMs: 5,
    turnTimeoutMs: 500,
    readTranscript: () => ({ text: 'final answer', endsWithQuestion: false }),
    ...over,
  });
}

/** Drain an adapter turn, feeding hook signals as the fake bridge would. */
async function collect(iterable: AsyncIterable<BrainEvent>): Promise<BrainEvent[]> {
  const out: BrainEvent[] = [];
  for await (const ev of iterable) out.push(ev);
  return out;
}

beforeEach(() => {
  __resetBrainPtyHookBusForTesting();
  __resetCommanderTrustForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-brainpty-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── env scrub ───────────────────────────────────────────────────────────────

describe('scrubBrainSpawnEnv', () => {
  it('drops every CLAUDE*/ANTHROPIC* var and AI_AGENT, keeping WMUX stamps', () => {
    const env = scrubBrainSpawnEnv({
      PATH: '/usr/bin',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDECODE: '1',
      ANTHROPIC_API_KEY: 'sk-live',
      ANTHROPIC_BASE_URL: 'https://x',
      AI_AGENT: 'claude',
      WMUX_WORKSPACE_ID: 'ws-1',
      WMUX_DATA_SUFFIX: '-dev',
    });
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('CLAUDE'))).toBe(false);
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('ANTHROPIC'))).toBe(false);
    expect(env.AI_AGENT).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.WMUX_WORKSPACE_ID).toBe('ws-1');
    expect(env.WMUX_DATA_SUFFIX).toBe('-dev');
  });

  it('scrubs the spawned session env too (the resume-killer regression)', async () => {
    const host = makeHost();
    const prev = process.env.CLAUDE_CODE_CHILD_SESSION;
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    try {
      const adapter = makeAdapter(host);
      const it = adapter.send('hello')[Symbol.asyncIterator]();
      const first = it.next();
      await vi.waitFor(() => expect(host.created.length).toBe(1));
      const env = host.created[0].env;
      expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('CLAUDE'))).toBe(false);
      // The hook bridge must target MAIN's pipe (`hooks.signal`), which is
      // where the brain-pty lane claims the signal.
      expect(env.WMUX_HOOKS_TO_MAIN).toBe('1');
      expect(env.WMUX_BRAIN_PTY).toBe('1');
      adapter.dispose();
      await first;
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
      else process.env.CLAUDE_CODE_CHILD_SESSION = prev;
    }
  });
});

// ── generated settings profile ──────────────────────────────────────────────

describe('buildBrainSettingsProfile', () => {
  const profile = buildBrainSettingsProfile({
    bridgePath: '/home/.wmux/hooks/wmux-bridge.mjs',
    nodePath: '/usr/bin/node',
  });

  it('denies every built-in the SDK adapter disallows, plus Write', () => {
    const deny = (profile.permissions as { deny: string[] }).deny;
    expect(deny).toEqual(['Agent', 'Task', 'Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
  });

  it('pre-approves exactly the commander MCP surface', () => {
    const allow = (profile.permissions as { allow: string[] }).allow;
    expect(allow).toEqual(BRAIN_PTY_ALLOWED_TOOLS);
    expect(allow.every((t) => t.startsWith('mcp__wmux__'))).toBe(true);
  });

  it('wires Stop + SessionStart to the bundled bridge', () => {
    const hooks = profile.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    for (const event of ['Stop', 'SessionStart']) {
      const command = hooks[event][0].hooks[0].command;
      expect(command).toContain('wmux-bridge.mjs');
      expect(command).toContain(event);
    }
  });

  it('backstops each denied tool with a PreToolUse hook that exits 2', () => {
    const pre = profile.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    expect(pre.PreToolUse.map((g) => g.matcher)).toContain('Bash');
    expect(pre.PreToolUse[0].hooks[0].command).toContain('process.exit(2)');
  });

  it('omits the signal hooks when no bridge could be located', () => {
    const noBridge = buildBrainSettingsProfile({ bridgePath: null, nodePath: '/usr/bin/node' });
    expect((noBridge.hooks as Record<string, unknown>).Stop).toBeUndefined();
  });
});

describe('buildBrainLaunchCommand', () => {
  it('quotes paths, pins the MCP config strictly, and carries --resume', () => {
    const cmd = buildBrainLaunchCommand({
      executable: '/Applications/My Apps/claude',
      settingsPath: '/tmp/s.json',
      mcpConfigPath: '/tmp/m.json',
      allowedTools: ['mcp__wmux__pane_list'],
      resumeSessionId: 'sess-9',
    });
    expect(cmd).toBe(
      '"/Applications/My Apps/claude" --settings "/tmp/s.json" ' +
      '--mcp-config "/tmp/m.json" --strict-mcp-config ' +
      '--allowedTools "mcp__wmux__pane_list" --resume "sess-9"',
    );
  });

  it('omits --resume for a fresh conversation', () => {
    const cmd = buildBrainLaunchCommand({
      executable: 'claude',
      settingsPath: '/tmp/s.json',
      mcpConfigPath: null,
      allowedTools: [],
    });
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('--mcp-config');
  });
});

describe('flattenPromptForPty', () => {
  it('collapses newlines and control characters — the TUI submits on Enter', () => {
    expect(flattenPromptForPty('do this\nthen that[A')).toBe('do this then that [A');
  });
});

// ── turn protocol ───────────────────────────────────────────────────────────

describe('ClaudePtyBrainAdapter — turn mapping', () => {
  it('emits one text-delta and exactly one turn-end per turn, ignoring duplicate Stops', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host);
    const turn = collect(adapter.send('summarise the fleet'));
    await vi.waitFor(() => expect(host.writes.length).toBe(1));
    const ptyId = host.created[0].id;
    // The prompt is typed into the pty with a trailing carriage return.
    expect(host.writes[0].data).toBe('summarise the fleet\r');

    deliverBrainPtyHookSignal(
      signal('agent.stop', ptyId, {
        agentSessionId: 'sess-abc',
        payload: { transcript_path: '/tmp/t.jsonl' },
      }),
    );
    // A second Stop for the same turn (the TUI re-firing, a SubagentStop race)
    // must not produce a second turn-end.
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-abc' }));

    const events = await turn;
    expect(events).toEqual([
      { type: 'text-delta', text: 'final answer' },
      { type: 'turn-end', sessionId: 'sess-abc' },
    ]);
    expect(adapter.sessionId).toBe('sess-abc');
    adapter.dispose();
  });

  it('resumes the persisted session on the next spawn', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host);
    adapter.start({ resumeSessionId: 'sess-prev' });
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBe(1));
    expect(host.created[0].command).toContain('--resume "sess-prev"');
    deliverBrainPtyHookSignal(signal('agent.stop', host.created[0].id, { agentSessionId: 'sess-prev' }));
    await turn;
    adapter.dispose();
  });

  it('soft-fails a stale resume: respawns fresh instead of erroring the turn', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host, { staleResumeWindowMs: 400 });
    adapter.start({ resumeSessionId: 'sess-dead' });
    host.nextBanner = 'No conversation found with session ID: sess-dead\n';
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.created.length).toBe(2));
    expect(host.created[0].command).toContain('--resume');
    expect(host.created[1].command).not.toContain('--resume');
    expect(host.destroyed).toContain(host.created[0].id);
    await vi.waitFor(() => expect(host.writes.length).toBe(1));
    deliverBrainPtyHookSignal(
      signal('agent.stop', host.created[1].id, { agentSessionId: 'sess-new' }),
    );
    const events = await turn;
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn-end', sessionId: 'sess-new' });
    adapter.dispose();
  });

  // Permission prompts enabled (not bypass mode): Claude Code's folder-trust /
  // permission / sign-in dialogs render BEFORE SessionStart, so the hook never
  // fires. Typing the prompt into that dialog would answer it with the user's
  // message and hang the turn for the whole TURN_TIMEOUT_MS with the composer
  // disabled — "needs your input" with no way to give any.
  it('hands the turn back when the TUI printed but never fired SessionStart', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host);
    host.nextBanner = 'Do you trust the files in this folder?\n';
    const events = await collect(adapter.send('summarise the fleet'));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect((events[0] as { message: string }).message).toMatch(/answer it in the terminal/i);
    // Nothing was typed — the dialog is the user's to answer, in the embed.
    expect(host.writes).toEqual([]);
    // And the pty survives, so answering it there resumes the same session.
    expect(host.destroyed).toEqual([]);
    adapter.dispose();
  });

  it('runs the turn normally when SessionStart lands despite a noisy banner', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host, { sessionStartTimeoutMs: 2_000 });
    host.nextBanner = 'Welcome to Claude Code\n';
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.created.length).toBe(1));
    const ptyId = host.created[0].id;
    // The hook bus registration lands just after createSession resolves, so
    // retry until the signal is actually claimed by this pty's lane.
    await vi.waitFor(() =>
      expect(deliverBrainPtyHookSignal(signal('agent.session_start', ptyId))).toBe(true),
    );
    await vi.waitFor(() => expect(host.writes.length).toBe(1));
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-ok' }));
    const events = await turn;
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn-end', sessionId: 'sess-ok' });
    adapter.dispose();
  });

  it('terminates the iterator when disposed mid-turn', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host, { turnTimeoutMs: 60_000 });
    const turn = collect(adapter.send('long job'));
    await vi.waitFor(() => expect(host.writes.length).toBe(1));
    adapter.dispose();
    // Must RESOLVE (not hang): the session manager's for-await has to unwind
    // on app quit. No turn-end is emitted for a turn that never finished.
    const events = await turn;
    expect(events).toEqual([]);
    expect(host.destroyed).toContain(host.created[0].id);
  });

  it('refuses to run without a hook bridge — there would be no turn protocol', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host, { bridgePath: null });
    const events = await collect(adapter.send('hi'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(host.created).toHaveLength(0);
  });

  it('deletes its generated profile files on dispose', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host);
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBe(1));
    const dir = path.join(tmpDir, 'brain-profiles');
    expect(fs.readdirSync(dir).length).toBe(2); // settings + mcp config
    adapter.dispose();
    await turn;
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('announces its pty id so the deck can embed the terminal', async () => {
    const host = makeHost();
    const spawned: string[] = [];
    const adapter = makeAdapter(host, { onPtySpawned: (id: string) => spawned.push(id) });
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(spawned.length).toBe(1));
    expect(spawned[0]).toBe(host.created[0].id);
    expect(adapter.brainPtyId).toBe(spawned[0]);
    adapter.dispose();
    await turn;
  });
});

// ── hook bus isolation ──────────────────────────────────────────────────────

describe('brainPtyHookBus', () => {
  it('claims only signals from a live brain pty', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host);
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBe(1));
    const ptyId = host.created[0].id;
    // A worker pane's signal falls through to the fleet path untouched.
    expect(deliverBrainPtyHookSignal(signal('agent.stop', 'pane-42'))).toBe(false);
    expect(deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 's' }))).toBe(true);
    await turn;
    // After dispose the id is released — a late signal must not be swallowed
    // by a dead adapter.
    adapter.dispose();
    expect(deliverBrainPtyHookSignal(signal('agent.stop', ptyId))).toBe(false);
  });
});
