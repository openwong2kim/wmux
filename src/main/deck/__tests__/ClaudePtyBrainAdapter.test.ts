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
import { spawnSync } from 'node:child_process';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo', getPath: () => '/home' },
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

// Multi-account binding: empty by default (an unbound workspace), so the env
// scrub assertions below still see a CLAUDE-free environment.
let boundAccountEnv: Record<string, string> = {};
vi.mock('../../account/accountStore', () => ({
  VENDOR_ENV_KEYS: { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' },
  getAccountStore: () => ({
    resolveAccountEnv: () => boundAccountEnv,
    getBinding: () => null,
  }),
}));

import {
  ClaudePtyBrainAdapter,
  scrubBrainSpawnEnv,
  buildBrainSettingsProfile,
  buildDenyScript,
  buildBrainLaunchCommand,
  flattenPromptForPty,
  resolveBrainHomeDir,
  BRAIN_PTY_ALLOWED_TOOLS,
  createBrainPtyHost,
  type BrainPtyHost,
  type DaemonClientLike,
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
  /** Fire the daemon's session-died signal for one session. */
  killSession(id: string, exitCode?: number | null): void;
  /** Make the next attach() reject — the "createSession took, attach threw"
   *  leak the spawn rollback exists for. */
  failNextAttach: boolean;
  /** Ids whose data listener was installed, in order. */
  readonly listened: string[];
  /** Make every write throw — the production host's "the pty is gone" signal
   *  (createBrainPtyHost turns a false writeToSession into this). */
  failWrites: boolean;
}

function makeHost(): FakeHost {
  let pendingBanner: string | null = null;
  const created: FakeHost['created'] = [];
  const writes: FakeHost['writes'] = [];
  const destroyed: string[] = [];
  const listeners = new Map<string, (chunk: string) => void>();
  const exitListeners = new Map<string, (code: number | null) => void>();
  const listened: string[] = [];
  let failAttach = false;
  let failWrites = false;
  return {
    get failWrites() {
      return failWrites;
    },
    set failWrites(v: boolean) {
      failWrites = v;
    },
    created,
    writes,
    destroyed,
    listened,
    get failNextAttach() {
      return failAttach;
    },
    set failNextAttach(v: boolean) {
      failAttach = v;
    },
    killSession(id, exitCode = 1) {
      exitListeners.get(id)?.(exitCode);
    },
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
      if (failAttach) {
        failAttach = false;
        throw new Error('attach refused');
      }
    },
    write(id, data) {
      if (failWrites) throw new Error(`the terminal brain's pty session is gone (write to ${id} was refused)`);
      writes.push({ id, data });
    },
    async destroy(id) {
      destroyed.push(id);
      listeners.delete(id);
      exitListeners.delete(id);
    },
    onExit(id, cb) {
      exitListeners.set(id, cb);
      return () => exitListeners.delete(id);
    },
    onData(id, cb) {
      listeners.set(id, cb);
      listened.push(id);
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
    submitDelayMs: 1,
    readTranscript: () => ({ text: 'final answer', endsWithQuestion: false }),
    ...over,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      // Hooks inherit the session env; without this the Electron-run bridge
      // opens as a GUI app and the Stop signal never fires.
      expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
      adapter.dispose();
      await first;
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
      else process.env.CLAUDE_CODE_CHILD_SESSION = prev;
    }
  });

  it('re-applies the workspace\'s bound claude account AFTER the scrub', async () => {
    // The scrub drops every CLAUDE* var — including the CLAUDE_CONFIG_DIR of an
    // account the operator explicitly bound to this workspace, which silently
    // ran the brain on the DEFAULT account. The scrub is for inherited noise;
    // an explicit binding outranks it.
    const host = makeHost();
    boundAccountEnv = { CLAUDE_CONFIG_DIR: '/home/me/.claude-work' };
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/home/me/.claude-inherited';
    try {
      const adapter = makeAdapter(host);
      const turn = collect(adapter.send('hello'));
      await vi.waitFor(() => expect(host.created.length).toBe(1));
      expect(host.created[0].env.CLAUDE_CONFIG_DIR).toBe('/home/me/.claude-work');
      adapter.dispose();
      await turn;
    } finally {
      boundAccountEnv = {};
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

// ── per-workspace brain home (D4) ───────────────────────────────────────────

describe('resolveBrainHomeDir', () => {
  it('gives each workspace its own home under brains/', () => {
    expect(resolveBrainHomeDir('/wmux', 'ws-1')).toBe(path.join('/wmux', 'brains', 'ws-1'));
  });

  it('falls back to the wmux dir for a missing or unsafe workspace id', () => {
    expect(resolveBrainHomeDir('/wmux', undefined)).toBe('/wmux');
    expect(resolveBrainHomeDir('/wmux', '../evil')).toBe('/wmux');
    expect(resolveBrainHomeDir('/wmux', 'a/b')).toBe('/wmux');
  });

  it('spawns the pty in the workspace home and creates it', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host);
    const it2 = adapter.send('hello')[Symbol.asyncIterator]();
    const first = it2.next();
    await vi.waitFor(() => expect(host.created.length).toBe(1));
    const expected = path.join(tmpDir, 'brains', 'ws-1');
    expect(host.created[0].cwd).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    adapter.dispose();
    await first;
  });
});

// ── generated settings profile ──────────────────────────────────────────────

describe('buildBrainSettingsProfile', () => {
  const profile = buildBrainSettingsProfile({
    bridgePath: '/home/.wmux/hooks/wmux-bridge.mjs',
    nodePath: '/usr/bin/node',
    denyScriptPath: '/tmp/brain-profiles/deny-1.js',
  });

  it('denies every built-in the SDK adapter disallows, plus Write and AskUserQuestion', () => {
    const deny = (profile.permissions as { deny: string[] }).deny;
    expect(deny).toEqual([
      'Agent', 'Task', 'Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'AskUserQuestion',
    ]);
  });

  it('pre-approves exactly the commander MCP surface', () => {
    const allow = (profile.permissions as { allow: string[] }).allow;
    expect(allow).toEqual(BRAIN_PTY_ALLOWED_TOOLS);
    expect(allow.every((t) => t.startsWith('mcp__wmux__'))).toBe(true);
  });

  it('wires Stop + SessionStart to the bundled bridge, and only Stop gates', () => {
    const hooks = profile.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    for (const event of ['Stop', 'SessionStart']) {
      const command = hooks[event][0].hooks[0].command;
      expect(command).toContain('wmux-bridge.mjs');
      expect(command).toContain(event);
    }
    expect(hooks.Stop[0].hooks[0].command).toContain('--gate');
    expect(hooks.SessionStart[0].hooks[0].command).not.toContain('--gate');
  });

  it('backstops each denied tool with a PreToolUse hook that names the tool', () => {
    const pre = profile.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    const matchers = pre.PreToolUse.map((g) => g.matcher);
    expect(matchers).toContain('Bash');
    expect(matchers).toContain('AskUserQuestion');
    for (const group of pre.PreToolUse) {
      const command = group.hooks[0].command;
      expect(command).toContain('/tmp/brain-profiles/deny-1.js');
      expect(command.endsWith(` ${group.matcher}`)).toBe(true);
      // Windows-quoting regression guard (F8): the hook command is run by
      // Claude Code's OWN shell — a PowerShell on Windows, which reads neither
      // of this module's quoters. Exactly two double-quoted path arguments and
      // a bare tool name is the only shape that survives both shells, so no
      // quoted argument may contain a quote of its own.
      expect(command).toMatch(/^"[^"]+" "[^"]+" [A-Za-z]+$/);
    }
  });

  it('falls back to a bare exit 2 when no deny script could be written', () => {
    const noScript = buildBrainSettingsProfile({
      bridgePath: null,
      nodePath: '/usr/bin/node',
      denyScriptPath: null,
    });
    const pre = noScript.hooks as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    expect(pre.PreToolUse[0].hooks[0].command).toContain('process.exit(2)');
  });

  it('omits the signal hooks when no bridge could be located', () => {
    const noBridge = buildBrainSettingsProfile({ bridgePath: null, nodePath: '/usr/bin/node' });
    expect((noBridge.hooks as Record<string, unknown>).Stop).toBeUndefined();
  });
});

describe('buildDenyScript', () => {
  it('exits 2 and points AskUserQuestion at the decision gate', () => {
    const script = buildDenyScript();
    expect(script).toContain('process.exit(2)');
    expect(script).toContain('mcp__wmux__deck_ask_decision');
    // The reason has to reach stderr — that is the only channel Claude Code
    // shows the model on a blocked call.
    expect(script).toContain('process.stderr.write');
  });

  it('runs as real node, blocking with the tool-specific reason', () => {
    const scriptPath = path.join(tmpDir, 'deny.js');
    fs.writeFileSync(scriptPath, buildDenyScript(), 'utf8');
    const result = spawnSync(process.execPath, [scriptPath, 'Bash'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no shell');
    // An unknown tool still blocks rather than falling through.
    const unknown = spawnSync(process.execPath, [scriptPath, 'SomethingElse'], { encoding: 'utf8' });
    expect(unknown.status).toBe(2);
  });
});

// ── generated profile files ────────────────────────────────────────────────

describe('generated profile files', () => {
  it.skipIf(process.platform === 'win32')('writes the token-bearing profile + MCP config owner-only (0600 in a 0700 dir)', async () => {
    // POSIX-only: Windows has no chmod bits — token protection there rides the
    // profile dir living under the user profile + the existing ACL hardening.
    // The MCP config embeds WMUX_COMMANDER_TOKEN — a bearer credential for the
    // whole commander tool surface. At the default 0644 every local user could
    // read it off disk and drive the operator's fleet.
    const host = makeHost();
    const adapter = makeAdapter(host);
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.created.length).toBe(1));
    const dir = path.join(tmpDir, 'brain-profiles');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.startsWith('mcp-'))).toBe(true);
    expect(files.some((f) => f.startsWith('settings-'))).toBe(true);
    for (const f of files) {
      expect(fs.statSync(path.join(dir, f)).mode & 0o777, `${f} must be 0600`).toBe(0o600);
    }
    adapter.dispose();
    await turn;
  });
});

describe('buildBrainLaunchCommand', () => {
  it('restricts the ambient setting sources to project', () => {
    // `--settings` only ADDS a source: without this flag the operator's own
    // ~/.claude settings (apiKeyHelper, hooks, plugins) still load into the
    // brain. `project` keeps brains/<wsId>/CLAUDE.md (memory, not a settings
    // source) working. Flag semantics verified against the installed CLI —
    // see BRAIN_SETTING_SOURCES.
    const cmd = buildBrainLaunchCommand({
      executable: 'claude',
      settingsPath: '/tmp/s.json',
      mcpConfigPath: null,
      allowedTools: [],
    
      platform: 'linux',
    });
    expect(cmd).toContain('--setting-sources "project"');
    expect(cmd.indexOf('--setting-sources')).toBeLessThan(cmd.indexOf('--settings '));
  });

  it('quotes paths, pins the MCP config strictly, and carries --resume', () => {
    const cmd = buildBrainLaunchCommand({
      executable: '/Applications/My Apps/claude',
      settingsPath: '/tmp/s.json',
      mcpConfigPath: '/tmp/m.json',
      allowedTools: ['mcp__wmux__pane_list'],
      resumeSessionId: 'sess-9',
    
      platform: 'linux',
    });
    expect(cmd).toBe(
      '"/Applications/My Apps/claude" --setting-sources "project" --settings "/tmp/s.json" ' +
      '--mcp-config "/tmp/m.json" --strict-mcp-config ' +
      '--allowedTools "mcp__wmux__pane_list" --resume "sess-9"',
    );
  });

  it('carries the orchestrator model override', () => {
    const cmd = buildBrainLaunchCommand({
      executable: 'claude',
      settingsPath: '/tmp/s.json',
      mcpConfigPath: null,
      allowedTools: [],
      model: 'opus',
      platform: 'darwin',
    });
    expect(cmd).toContain('--model "opus"');
  });

  it('makes the command RUNNABLE under the daemon\'s pwsh exec wrapper', () => {
    // `pwsh -Command "\"C:\\...\\claude.exe\" --settings …"` parses a leading
    // quoted token as a STRING, prints it and exits 0 — nothing launches. The
    // `&` call operator is what makes it a command, and PowerShell's literal
    // quoting is single quotes (backslashes are NOT escapes there, so the
    // POSIX quoting would corrupt every Windows path).
    const cmd = buildBrainLaunchCommand({
      executable: 'C:\\Users\\me\\.local\\bin\\claude.exe',
      settingsPath: 'C:\\Users\\me\\.wmux\\brain-profiles\\s.json',
      mcpConfigPath: null,
      allowedTools: [],
      platform: 'win32',
    });
    expect(cmd.startsWith("& 'C:\\Users\\me\\.local\\bin\\claude.exe'")).toBe(true);
    expect(cmd).toContain("--settings 'C:\\Users\\me\\.wmux\\brain-profiles\\s.json'");
    expect(cmd).not.toContain('\\\\');
  });

  it('leaves the POSIX command line untouched', () => {
    const cmd = buildBrainLaunchCommand({
      executable: '/usr/local/bin/claude',
      settingsPath: '/tmp/s.json',
      mcpConfigPath: null,
      allowedTools: [],
      platform: 'linux',
    });
    expect(cmd.startsWith('"/usr/local/bin/claude"')).toBe(true);
  });

  it('omits --resume for a fresh conversation', () => {
    const cmd = buildBrainLaunchCommand({
      executable: 'claude',
      settingsPath: '/tmp/s.json',
      mcpConfigPath: null,
      allowedTools: [],
    
      platform: 'linux',
    });
    expect(cmd).not.toContain('--resume');
    expect(cmd).not.toContain('--mcp-config');
  });

  // ── the workspace mode as a launch flag (owner decision 2026-08-01) ────────

  it('assist launches in accept-edits, BEFORE --resume', () => {
    const cmd = buildBrainLaunchCommand({
      executable: 'claude',
      settingsPath: '/tmp/s.json',
      mcpConfigPath: null,
      allowedTools: [],
      permissionMode: 'acceptEdits',
      resumeSessionId: 'sess-9',
      platform: 'linux',
    });
    expect(cmd).toContain('--permission-mode "acceptEdits"');
    expect(cmd).not.toContain('--dangerously-skip-permissions');
    expect(cmd.indexOf('--permission-mode')).toBeLessThan(cmd.indexOf('--resume'));
  });

  it('danger launches with --dangerously-skip-permissions (not a --permission-mode value)', () => {
    const cmd = buildBrainLaunchCommand({
      executable: 'claude',
      settingsPath: '/tmp/s.json',
      mcpConfigPath: null,
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      resumeSessionId: 'sess-9',
      platform: 'linux',
    });
    expect(cmd).toContain('--dangerously-skip-permissions');
    expect(cmd).not.toContain('--permission-mode');
    expect(cmd.indexOf('--dangerously-skip-permissions')).toBeLessThan(cmd.indexOf('--resume'));
  });

  it('no mode → no permission flag at all (the pre-mode behaviour)', () => {
    for (const permissionMode of [undefined, null] as const) {
      const cmd = buildBrainLaunchCommand({
        executable: 'claude',
        settingsPath: '/tmp/s.json',
        mcpConfigPath: null,
        allowedTools: [],
        permissionMode,
        platform: 'linux',
      });
      expect(cmd).not.toContain('--permission-mode');
      expect(cmd).not.toContain('--dangerously-skip-permissions');
    }
  });

  it('quotes the flag with the PLATFORM quoter (PowerShell literals on win32)', () => {
    const cmd = buildBrainLaunchCommand({
      executable: 'C:\\bin\\claude.exe',
      settingsPath: 'C:\\s.json',
      mcpConfigPath: null,
      allowedTools: [],
      permissionMode: 'acceptEdits',
      platform: 'win32',
    });
    expect(cmd).toContain("--permission-mode 'acceptEdits'");
  });
});

describe('the spawned command line', () => {
  it('puts the model override on the spawned command line', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host, { model: 'opus' });
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.created.length).toBe(1));
    expect(host.created[0].command).toMatch(/--model ["']opus["']/);
    adapter.dispose();
    await turn;
  });

  it('carries the INJECTED workspace mode as the permission flag', async () => {
    // The mode resolver is called per spawn (not captured at construction), so
    // a mode flip applies to the next TUI without a manager swap.
    let mode: 'acceptEdits' | 'bypassPermissions' | null = 'acceptEdits';
    const host = makeHost();
    const adapter = makeAdapter(host, { resolvePermissionMode: () => mode });
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.created.length).toBe(1));
    expect(host.created[0].command).toMatch(/--permission-mode ["']acceptEdits["']/);
    mode = 'bypassPermissions';
    adapter.dispose();
    await turn;
  });

  it('a resolver that THROWS costs the flag, never the spawn', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host, {
      resolvePermissionMode: () => {
        throw new Error('store unreadable');
      },
    });
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.created.length).toBe(1));
    // No flag → claude's own prompting default, which is the safe direction.
    expect(host.created[0].command).not.toContain('--permission-mode');
    expect(host.created[0].command).not.toContain('--dangerously-skip-permissions');
    adapter.dispose();
    await turn;
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
    await vi.waitFor(() => expect(host.writes.length).toBe(3));
    const ptyId = host.created[0].id;
    // The prompt and the submitting Enter are separate writes (one chunk would
    // make the TUI's paste detection swallow the `\r` as pasted content), and
    // the Enter is retried once — a redraw can eat the first, and an Enter on
    // an already-empty input box is a no-op.
    expect(host.writes[0].data).toBe('summarise the fleet');
    expect(host.writes[1].data).toBe('\r');
    expect(host.writes[2].data).toBe('\r');

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
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    expect(host.created[0].command).toMatch(/--resume ["']sess-prev["']/);
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
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
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
      expect(deliverBrainPtyHookSignal(signal('agent.session_start', ptyId)).consumed).toBe(true),
    );
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
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
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
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
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const dir = path.join(tmpDir, 'brain-profiles');
    expect(fs.readdirSync(dir).length).toBe(3); // settings + mcp config + deny script
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

// ── turn identity ───────────────────────────────────────────────────────────

describe('ClaudePtyBrainAdapter — superseded turns', () => {
  it('drops a late Stop from a timed-out turn instead of ending the next one', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host, { turnTimeoutMs: 20 });
    const first = await collect(adapter.send('slow job'));
    expect(first).toEqual([{ type: 'error', message: 'the terminal brain did not finish its turn' }]);
    const ptyId = host.created[0].id;
    // The timed-out turn is ESC'd — otherwise claude keeps working on a turn
    // nobody will ever read.
    expect(host.writes.at(-1)).toEqual({ id: ptyId, data: '\u001b' });

    const second = collect(adapter.send('a new question'));
    await vi.waitFor(() => expect(host.writes.filter((w) => w.data === 'a new question').length).toBe(1));
    // The OLD turn's Stop finally lands. It must not resolve the new turn —
    // that would hang the old transcript off the new request.
    deliverBrainPtyHookSignal(
      signal('agent.stop', ptyId, {
        agentSessionId: 'sess-old',
        payload: { transcript_path: '/tmp/old.jsonl' },
      }),
    );
    // The new turn's own Stop is the one that ends it.
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-new' }));
    const events = await second;
    expect(events.at(-1)).toEqual({ type: 'turn-end', sessionId: 'sess-new' });
    adapter.dispose();
  });
});

// ── spawn lifecycle ─────────────────────────────────────────────────────────

describe('ClaudePtyBrainAdapter — spawn lifecycle', () => {
  it('installs the hook + data listeners BEFORE the session is created', async () => {
    // SessionStart and the banner can both land while createSession/attach are
    // still awaiting; listeners installed afterwards would miss them.
    const host = makeHost();
    const order: string[] = [];
    const wrapped: FakeHost = {
      ...host,
      async createSession(params) {
        order.push('create');
        await host.createSession(params);
      },
      onData(id, cb) {
        order.push('onData');
        return host.onData(id, cb);
      },
      onExit(id, cb) {
        order.push('onExit');
        return host.onExit(id, cb);
      },
    };
    const adapter = makeAdapter(wrapped);
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.created.length).toBe(1));
    expect(order.indexOf('onData')).toBeLessThan(order.indexOf('create'));
    expect(order.indexOf('onExit')).toBeLessThan(order.indexOf('create'));
    // The hook lane is claimed just as early — a SessionStart delivered before
    // createSession resolved must be accepted, not dropped.
    adapter.dispose();
    await turn;
  });

  it('destroys the created session when attach throws (no orphaned claude)', async () => {
    const host = makeHost();
    host.failNextAttach = true;
    const adapter = makeAdapter(host);
    const events = await collect(adapter.send('hi'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(host.created).toHaveLength(1);
    expect(host.destroyed).toEqual([host.created[0].id]);
    expect(adapter.brainPtyId).toBeNull();
    // A late hook signal from the abandoned pty must not be claimed any more.
    expect(deliverBrainPtyHookSignal(signal('agent.stop', host.created[0].id)).consumed).toBe(false);
    adapter.dispose();
  });

  it('ends the turn immediately when the pty dies, and retracts the embed', async () => {
    const host = makeHost();
    const spawned: Array<string | null> = [];
    const adapter = makeAdapter(host, {
      turnTimeoutMs: 60_000, // the point: we do NOT wait this out
      onPtySpawned: (id: string | null) => spawned.push(id),
    });
    const turn = collect(adapter.send('do a big job'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    host.killSession(host.created[0].id, 1);
    const events = await turn;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect((events[0] as { message: string }).message).toMatch(/session ended \(exit code 1\)/i);
    // Dead session state cleared: id retracted for the renderer, gone here.
    expect(spawned).toEqual([host.created[0].id, null]);
    expect(adapter.brainPtyId).toBeNull();
    // …so the next send spawns a fresh TUI rather than typing into a corpse.
    const next = collect(adapter.send('again'));
    await vi.waitFor(() => expect(host.created.length).toBe(2));
    adapter.dispose();
    await next;
  });

  it('retracts the embed on every teardown path', async () => {
    const host = makeHost();
    const spawned: Array<string | null> = [];
    const adapter = makeAdapter(host, {
      staleResumeWindowMs: 400,
      onPtySpawned: (id: string | null) => spawned.push(id),
    });
    // Stale-resume respawn: the first pty is destroyed — the renderer must be
    // told, or it keeps embedding a session that no longer exists.
    adapter.start({ resumeSessionId: 'sess-dead' });
    host.nextBanner = 'No conversation found with session ID: sess-dead\n';
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.created.length).toBe(2));
    expect(spawned).toEqual([host.created[0].id, null, host.created[1].id]);
    // Dispose (the /clear + vendor-swap path) retracts too.
    adapter.dispose();
    await turn;
    expect(spawned.at(-1)).toBeNull();
  });
});

// ── the Stop gate ───────────────────────────────────────────────────────────

describe('the Stop gate', () => {
  it('keeps the turn open on a blocked Stop and ends it exactly once when allowed', async () => {
    const host = makeHost();
    const calls: number[] = [];
    let blocking = true;
    const adapter = makeAdapter(host, {
      evaluateStopGate: (_ws: string, consecutiveBlocks: number) => {
        calls.push(consecutiveBlocks);
        return blocking
          ? { block: true, reason: 'worker-a (running) still needs you' }
          : { block: false };
      },
    });
    const turn = collect(adapter.send('delegate the build'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const ptyId = host.created[0].id;

    // The refusal rides the delivery result — this is what the gated bridge
    // turns into exit 2.
    const blocked = deliverBrainPtyHookSignal(
      signal('agent.stop', ptyId, { agentSessionId: 'sess-1' }),
    );
    expect(blocked.consumed).toBe(true);
    expect(blocked.block).toContain('worker-a (running)');

    // The turn must NOT have ended. Nothing else can prove that from out here,
    // so race the pending iterator against a tick.
    const settled = await Promise.race([turn.then(() => 'ended'), delay(20).then(() => 'open')]);
    expect(settled).toBe('open');

    // A second refusal reports a RISEN consecutive count — that counter is what
    // caps the refusal run.
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-1' }));
    expect(calls).toEqual([0, 1]);

    blocking = false;
    deliverBrainPtyHookSignal(
      signal('agent.stop', ptyId, {
        agentSessionId: 'sess-1',
        payload: { transcript_path: '/tmp/t.jsonl' },
      }),
    );
    const events = await turn;
    expect(events).toEqual([
      { type: 'text-delta', text: 'final answer' },
      { type: 'turn-end', sessionId: 'sess-1' },
    ]);
    // The allowed Stop reset the run, so the NEXT turn starts from zero.
    expect(calls).toEqual([0, 1, 2]);
    adapter.dispose();
  });

  it('starts every turn with a fresh refusal count, even after a turn that timed out', async () => {
    // The cap is a PER-TURN escape hatch. A turn that used its refusals up and
    // then died on the timeout used to hand its tally to the next turn, which
    // would then be allowed to stop on its very first Stop — the gate would go
    // quiet for exactly the fleet that had just proved it needs one.
    const host = makeHost();
    const calls: number[] = [];
    const adapter = makeAdapter(host, {
      turnTimeoutMs: 60,
      evaluateStopGate: (_ws: string, consecutiveBlocks: number) => {
        calls.push(consecutiveBlocks);
        return { block: true, reason: 'worker-a (running) still needs you' };
      },
    });

    const first = collect(adapter.send('delegate the build'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const ptyId = host.created[0].id;
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-1' }));
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-1' }));
    expect(calls).toEqual([0, 1]);
    // The turn is abandoned on the timeout, refusals still outstanding.
    expect(await first).toEqual([
      { type: 'error', message: 'the terminal brain did not finish its turn' },
    ]);

    const second = collect(adapter.send('a new question'));
    await vi.waitFor(() => expect(host.writes.filter((w) => w.data === 'a new question').length).toBe(1));
    // The superseded turn's late Stop is swallowed, so it never reaches the gate.
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-1' }));
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-2' }));
    expect(calls).toEqual([0, 1, 0]);
    adapter.dispose();
    await second;
  });

  it('is never consulted for a Stop with no open turn', async () => {
    const host = makeHost();
    let consulted = 0;
    const adapter = makeAdapter(host, {
      evaluateStopGate: () => {
        consulted += 1;
        return { block: true, reason: 'nope' };
      },
    });
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const ptyId = host.created[0].id;
    adapter.dispose();
    await turn;
    // Dispose released the id; a late Stop is not even delivered, let alone
    // gated — a refusal there would strand a turn nobody is awaiting.
    expect(deliverBrainPtyHookSignal(signal('agent.stop', ptyId)).consumed).toBe(false);
    expect(consulted).toBe(0);
  });

  it('fails open when the predicate throws', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host, {
      evaluateStopGate: () => {
        throw new Error('mirror exploded');
      },
    });
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const result = deliverBrainPtyHookSignal(
      signal('agent.stop', host.created[0].id, { agentSessionId: 'sess-x' }),
    );
    expect(result.block).toBeUndefined();
    const events = await turn;
    expect(events.some((e) => e.type === 'turn-end')).toBe(true);
    adapter.dispose();
  });
});

// ── foreign turns (the human types into the TUI) ─────────────────────────────

describe('a turn the human started in the TUI', () => {
  it('marks the adapter busy on UserPromptSubmit and clears it on the Stop', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host);
    const first = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const ptyId = host.created[0].id;
    // Our OWN turn's UserPromptSubmit is not a foreign turn — turnStop owns it.
    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId));
    expect(adapter.busy).toBe(false);
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-1', payload: { transcript_path: '/tmp/t.jsonl' } }));
    expect(await first).toEqual([
      { type: 'text-delta', text: 'final answer' },
      { type: 'turn-end', sessionId: 'sess-1' },
    ]);

    // Now the human types into the TUI directly: no send(), no waiter.
    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId));
    expect(adapter.busy).toBe(true);
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-2', payload: { transcript_path: '/tmp/t.jsonl' } }));
    expect(adapter.busy).toBe(false);

    // The foreign turn emitted no turn-end of its own: the next adapter turn
    // still ends exactly once (the manager's exactly-once contract).
    const second = collect(adapter.send('again'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(3));
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-3', payload: { transcript_path: '/tmp/t.jsonl' } }));
    expect(await second).toEqual([
      { type: 'text-delta', text: 'final answer' },
      { type: 'turn-end', sessionId: 'sess-3' },
    ]);
    adapter.dispose();
  });

  it('clears the flag when the pty dies mid-turn, so the workspace is not stranded busy', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host);
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const ptyId = host.created[0].id;
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-1', payload: { transcript_path: '/tmp/t.jsonl' } }));
    await turn;

    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId));
    expect(adapter.busy).toBe(true);
    host.killSession(ptyId, 1);
    expect(adapter.busy).toBe(false);

    // dispose() takes the same path for a live pty.
    const host2 = makeHost();
    const adapter2 = makeAdapter(host2);
    const t2 = collect(adapter2.send('hi'));
    await vi.waitFor(() => expect(host2.writes.length).toBeGreaterThan(0));
    const pty2 = host2.created[0].id;
    deliverBrainPtyHookSignal(signal('agent.stop', pty2, { agentSessionId: 's' }));
    await t2;
    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', pty2));
    expect(adapter2.busy).toBe(true);
    adapter2.dispose();
    expect(adapter2.busy).toBe(false);
  });
});

describe('a foreign turn that could get stuck open', () => {
  it('lets the foreign Stop close the turn instead of feeding a superseded credit', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host, { turnTimeoutMs: 20 });
    // Bank a superseded credit: this turn times out and is ESC'd, so its Stop
    // is still owed.
    const timedOut = await collect(adapter.send('slow job'));
    expect(timedOut).toEqual([
      { type: 'error', message: 'the terminal brain did not finish its turn' },
    ]);
    const ptyId = host.created[0].id;

    // The human then types into the TUI. Its Stop must close THEIR turn — if
    // the credit swallowed it first, nothing else would ever clear the flag.
    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId));
    expect(adapter.busy).toBe(true);
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-human' }));
    expect(adapter.busy).toBe(false);
    adapter.dispose();
  });

  it('releases a foreign turn whose Stop never arrives, past the turn timeout', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host, { turnTimeoutMs: 30 });
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const ptyId = host.created[0].id;
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-1' }));
    await turn;

    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId));
    expect(adapter.busy).toBe(true);
    // No Stop is ever delivered — the hook command died, the bridge could not
    // reach main, whatever. The next read past the ceiling releases it.
    await vi.waitFor(() => expect(adapter.busy).toBe(false), { timeout: 1_000 });
    adapter.dispose();
  });
});

describe('the foreign-turn-START notification', () => {
  it('announces one turn per submission, and folds a repeat with no Stop between', async () => {
    // Two UserPromptSubmits with no Stop between them is a real sequence: the
    // human interrupts with ESC (which fires no Stop) and re-submits. It is
    // ONE foreign turn — a second announcement opened a second work row for
    // the same turn.
    //
    // It is ALSO the shape a duplicate hook delivery would take, which is why
    // the fold is asserted rather than assumed. The brain launches with
    // `--setting-sources project`, so the operator's own settings hooks do not
    // load for its pty and today only one bridge fires; this test is what
    // keeps that from being load-bearing.
    const host = makeHost();
    const onForeignTurnStart = vi.fn();
    const adapter = makeAdapter(host, { onForeignTurnStart });
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const ptyId = host.created[0].id;
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-1' }));
    await turn;
    // Our OWN turn's UserPromptSubmit is not foreign — turnStop owned it.
    expect(onForeignTurnStart).not.toHaveBeenCalled();

    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId, { payload: { prompt: 'do it' } }));
    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId, { payload: { prompt: 'no, do it this way' } }));
    expect(onForeignTurnStart).toHaveBeenCalledTimes(1);
    expect(onForeignTurnStart).toHaveBeenCalledWith('do it');
    // Still exactly one open turn, closed by exactly one Stop.
    expect(adapter.busy).toBe(true);
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-2' }));
    expect(adapter.busy).toBe(false);

    // A submission AFTER the turn closed is a new turn and announces again.
    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId, { payload: { prompt: 'next' } }));
    expect(onForeignTurnStart).toHaveBeenCalledTimes(2);
    adapter.dispose();
  });
});

describe('the foreign-turn-end notification', () => {
  it('fires once when the human`s Stop closes their turn, and not for our own turns', async () => {
    const host = makeHost();
    const onForeignTurnEnd = vi.fn();
    const adapter = makeAdapter(host, { onForeignTurnEnd });
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const ptyId = host.created[0].id;
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-1' }));
    await turn;
    // Our own turn ends through the manager's normal path — no foreign wake.
    expect(onForeignTurnEnd).not.toHaveBeenCalled();

    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId));
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-2' }));
    expect(onForeignTurnEnd).toHaveBeenCalledTimes(1);
    // A duplicate Stop with no foreign turn open must not wake again.
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-2' }));
    expect(onForeignTurnEnd).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });

  it('fires when a pty that died mid-foreign-turn releases the flag', async () => {
    const host = makeHost();
    const onForeignTurnEnd = vi.fn();
    const adapter = makeAdapter(host, { onForeignTurnEnd });
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const ptyId = host.created[0].id;
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-1' }));
    await turn;
    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId));
    host.killSession(ptyId, 1);
    expect(onForeignTurnEnd).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
});

describe('an automation turn racing the human`s Enter', () => {
  it('stands down when the UserPromptSubmit lands inside the double-check window', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host, { foreignTurnRecheckMs: 40 });
    // Establish a live pty with a finished turn, so the ambient send below
    // takes the "already spawned" path and reaches the double-check.
    const first = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const ptyId = host.created[0].id;
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-1' }));
    await first;
    const writesBefore = host.writes.length;

    // The ambient turn starts while the adapter still reads idle — the human's
    // Enter is already typed but its hook has not arrived yet.
    expect(adapter.busy).toBe(false);
    const ambient = collect(adapter.send('ambient wake', { origin: 'automation' }));
    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId));

    expect(await ambient).toEqual([
      {
        type: 'error',
        message: 'the human is mid-turn in the terminal brain — the ambient turn stood down',
      },
    ]);
    // Nothing was typed into the TUI the human just claimed.
    expect(host.writes.length).toBe(writesBefore);
    adapter.dispose();
  });

  it('proceeds when no foreign turn opened during the window', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host, { foreignTurnRecheckMs: 5 });
    const turn = collect(adapter.send('ambient wake', { origin: 'automation' }));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    expect(host.writes[0].data).toBe('ambient wake');
    deliverBrainPtyHookSignal(
      signal('agent.stop', host.created[0].id, {
        agentSessionId: 'sess-1',
        payload: { transcript_path: '/tmp/t.jsonl' },
      }),
    );
    expect(await turn).toEqual([
      { type: 'text-delta', text: 'final answer' },
      { type: 'turn-end', sessionId: 'sess-1' },
    ]);
    adapter.dispose();
  });

  it('does not delay a human-origin send', async () => {
    const host = makeHost();
    // A recheck window long enough that a human send waiting on it would fail
    // the waitFor below.
    const adapter = makeAdapter(host, { foreignTurnRecheckMs: 5_000 });
    const turn = collect(adapter.send('typed by a person'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0), { timeout: 1_000 });
    deliverBrainPtyHookSignal(signal('agent.stop', host.created[0].id, { agentSessionId: 's' }));
    await turn;
    adapter.dispose();
  });
});

// ── hook bus isolation ──────────────────────────────────────────────────────

describe('brainPtyHookBus', () => {
  it('claims only signals from a live brain pty', async () => {
    const host = makeHost();
    const adapter = makeAdapter(host);
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const ptyId = host.created[0].id;
    // A worker pane's signal falls through to the fleet path untouched.
    expect(deliverBrainPtyHookSignal(signal('agent.stop', 'pane-42')).consumed).toBe(false);
    expect(deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 's' })).consumed).toBe(true);
    await turn;
    // After dispose the id is released — a late signal must not be swallowed
    // by a dead adapter.
    adapter.dispose();
    expect(deliverBrainPtyHookSignal(signal('agent.stop', ptyId)).consumed).toBe(false);
  });
});

// ── undeliverable keystrokes ────────────────────────────────────────────────

describe('a write the pty cannot take', () => {
  it('ends the turn immediately instead of waiting for a Stop that never comes', async () => {
    // DaemonClient.writeToSession returns false when the session/pipe is gone.
    // Discarding that verdict left the prompt undelivered while the turn sat
    // out the full TURN_TIMEOUT_MS with the composer locked.
    const host = makeHost();
    const adapter = makeAdapter(host);
    host.failWrites = true;
    const events = await collect(adapter.send('hi'));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect((events[0] as { message: string }).message).toContain('could not reach the terminal brain');
    adapter.dispose();
  });
});

describe('createBrainPtyHost.write', () => {
  it('throws when the daemon refuses the write', () => {
    const client = {
      rpc: async () => undefined,
      connectSessionPipe: async () => undefined,
      writeToSession: () => false,
      on: () => undefined,
      off: () => undefined,
    };
    const host = createBrainPtyHost(client as unknown as DaemonClientLike);
    expect(() => host.write('brain-1', 'hi')).toThrow(/pty session is gone/);
  });

  it('stays silent when the write lands', () => {
    const client = {
      rpc: async () => undefined,
      connectSessionPipe: async () => undefined,
      writeToSession: () => true,
      on: () => undefined,
      off: () => undefined,
    };
    const host = createBrainPtyHost(client as unknown as DaemonClientLike);
    expect(() => host.write('brain-1', 'hi')).not.toThrow();
  });
});

describe('a session id learned from a foreign Stop', () => {
  it('adopts it and reports it, so a TUI-only conversation survives a restart', async () => {
    const host = makeHost();
    const reported: string[] = [];
    const adapter = makeAdapter(host, { onForeignSessionId: (id: string) => reported.push(id) });
    const turn = collect(adapter.send('hi'));
    await vi.waitFor(() => expect(host.writes.length).toBeGreaterThan(0));
    const ptyId = host.created[0].id;
    // Our OWN turn's Stop persists through turn-end, never through the dep.
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-own', payload: { transcript_path: '/tmp/t.jsonl' } }));
    await turn;
    expect(reported).toEqual([]);

    // A TUI-typed turn: its Stop carries the transcript the human is now on.
    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId));
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-tui', payload: { transcript_path: '/tmp/t.jsonl' } }));
    expect(reported).toEqual(['sess-tui']);
    expect(adapter.sessionId).toBe('sess-tui');

    // Same id again (duplicate foreign Stop) — adopted once, reported once.
    deliverBrainPtyHookSignal(signal('agent.user_prompt_submit', ptyId));
    deliverBrainPtyHookSignal(signal('agent.stop', ptyId, { agentSessionId: 'sess-tui', payload: { transcript_path: '/tmp/t.jsonl' } }));
    expect(reported).toEqual(['sess-tui']);
    adapter.dispose();
  });
});
