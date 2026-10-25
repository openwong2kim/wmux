import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import {
  AGENT_MISS_BACKOFF_MS,
  AgentProcessTracker,
  isAgentImage,
  parsePipeDelimited,
  readExecutableImage,
  parsePsOutput,
  resolveAgentSlug,
  selectAgentProcess,
  tokenizeCmdline,
  type PidWatcher,
  type ProcessTreeEntry,
} from '../AgentProcessTracker';
import { stopAgentTree } from '../agentStop';

const entry = (pid: number, ppid: number, name: string, cmdline?: string): ProcessTreeEntry => ({
  pid,
  ppid,
  name,
  ...(cmdline !== undefined ? { cmdline } : {}),
});

describe('fresh idle-shell evidence', () => {
  it('does not join an older in-flight snapshot that predates the caller\'s witness', async () => {
    const shell = entry(100, 1, 'bash');
    const worker = entry(200, 100, 'node', 'node claude.js');
    let finishOld!: (table: ProcessTreeEntry[]) => void;
    const enumerate = vi.fn<() => Promise<ProcessTreeEntry[]>>()
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue([shell, worker]);
    const tracker = new AgentProcessTracker({ watch: () => undefined, unwatch: () => undefined }, enumerate);
    // An unrelated lookup starts before the worker is launched. Its old
    // process listing has not been delivered when recovery captures a witness.
    const old = tracker.commandLineOf(100);
    const fresh = tracker.idleShellState(100, {}, true, { fresh: true });
    finishOld([shell]);
    expect(await fresh).toEqual({ ok: false, reason: 'shell-has-children' });
    expect(enumerate).toHaveBeenCalledTimes(2);
    await old;
  });
});

describe('parsePipeDelimited', () => {
  it('parses pid|ppid|created|name|cmdline lines, rejoining pipes inside the cmdline', () => {
    const out = parsePipeDelimited(
      'Windows PowerShell banner\r\n4|0||System\r\n123|4|1792407685810|pwsh.exe\r\n\r\nnot-a-line\r\n'
        + '77|123|1792407690000|claude.exe|claude --foo|bar\r\n'
        + '78|123||codex.exe\r\n'
        + '79|123|claude.exe\r\n',
    );
    expect(out).toEqual([
      entry(4, 0, 'System'),
      { ...entry(123, 4, 'pwsh.exe'), created: 1792407685810 },
      { ...entry(77, 123, 'claude.exe', 'claude --foo|bar'), created: 1792407690000 },
      entry(78, 123, 'codex.exe'),
    ]);
  });
});

describe('parsePsOutput', () => {
  it('derives the image from argv[0] of the args tail and keeps the full cmdline', () => {
    const out = parsePsOutput(
      '    1     0 /sbin/launchd\n  500     1 -zsh\n  600   500 node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js\n',
    );
    expect(out).toEqual([
      entry(1, 0, '/sbin/launchd', '/sbin/launchd'),
      entry(500, 1, '-zsh', '-zsh'),
      entry(600, 500, 'node', 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
    ]);
  });
});

describe('tokenizeCmdline', () => {
  it('keeps quoted paths with spaces as single tokens', () => {
    expect(tokenizeCmdline('"C:\\Program Files\\node.exe" "C:\\my work\\cli.js" --flag')).toEqual([
      'C:\\Program Files\\node.exe',
      'C:\\my work\\cli.js',
      '--flag',
    ]);
  });
});

describe('resolveAgentSlug', () => {
  it('resolves the real install spellings', () => {
    expect(resolveAgentSlug('node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('claude');
    expect(resolveAgentSlug('node /opt/homebrew/lib/node_modules/gemini/bin/gemini.js')).toBe('gemini');
    expect(resolveAgentSlug('node /x/node_modules/@google/gemini-cli/dist/index.js')).toBe('gemini');
    expect(resolveAgentSlug('node /x/node_modules/npx-cli.js -y gemini')).toBe('gemini');
    expect(resolveAgentSlug('npx -y gemini')).toBe('gemini');
    expect(resolveAgentSlug('python -m aider')).toBe('aider');
    expect(resolveAgentSlug('claude --resume')).toBeUndefined(); // < 2 tokens is not a runtime cmdline
    expect(resolveAgentSlug(undefined)).toBeUndefined();
  });

  // #1680 — the live-dogfood fake agents are attributed only when launched by
  // path (their header says so); a bare script name is the user's own file.
  it('attributes the fake agent fixtures launched by path, not by bare name', () => {
    expect(resolveAgentSlug('"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\scripts\\fixtures\\fake-agents\\claude.mjs')).toBe('claude');
    expect(resolveAgentSlug('node /repo/scripts/fixtures/fake-agents/codex.mjs')).toBe('codex');
    expect(resolveAgentSlug('node claude.mjs')).toBeUndefined();
  });

  it('never matches arbitrary ancestor directories or trailing positionals', () => {
    expect(resolveAgentSlug('node /work/claude/scratch.js')).toBeUndefined();
    expect(resolveAgentSlug('node demo.js claude')).toBeUndefined();
    expect(resolveAgentSlug('node /work/claude-notes/server.mjs')).toBeUndefined();
  });

  it('a BARE script-slot name is the user\'s own file, never an agent', () => {
    // Claude panel #919: `node claude.js` / `python aider.py` used to
    // attribute by bare basename. The script slot must be a path —
    // `node /usr/local/bin/claude` (npm global bin via env shebang) still is.
    expect(resolveAgentSlug('node claude.js')).toBeUndefined();
    expect(resolveAgentSlug('python aider.py')).toBeUndefined();
    expect(resolveAgentSlug('node /usr/local/bin/claude')).toBe('claude');
  });

  it('runtime flags before the script do not lose the identity', () => {
    // Claude panel #919: a launcher that injects node flags ahead of the
    // script (`--max-old-space-size`) used to leave the pane unresolved.
    expect(
      resolveAgentSlug('node --max-old-space-size=4096 /x/node_modules/@anthropic-ai/claude-code/cli.js'),
    ).toBe('claude');
  });

  it('never resolves a scoped name by basename or a non-segment node_modules', () => {
    // @acme/claude is NOT claude — scoped spellings match exact alias keys only
    expect(resolveAgentSlug('node /x/node_modules/@acme/claude/index.js')).toBeUndefined();
    // `not_node_modules` is not a path segment boundary
    expect(resolveAgentSlug('node /x/not_node_modules/claude/index.js')).toBeUndefined();
  });

  it('resolves launcher spellings whose name differs from the slug (kiro)', () => {
    expect(resolveAgentSlug('node /x/node_modules/kiro-cli/dist/cli.js')).toBe('kiro');
  });
});

describe('selectAgentProcess', () => {
  it('identifies the factory smoke launcher while leaving arbitrary Node stubs unnamed', () => {
    const shell = entry(100, 1, 'zsh', 'zsh');
    expect(selectAgentProcess([shell, entry(200, 100, 'node', 'node /repo/scripts/factory-e2e/claude.mjs --session-id stub')], 100))
      .toEqual({ pid: 200, slug: 'claude' });
    expect(selectAgentProcess([shell, entry(200, 100, 'node', 'node /repo/scripts/factory-e2e/fake-claude.mjs --session-id stub')], 100))
      .toEqual({ pid: 200 });
  });

  const SHELL = 100;

  it('exec-rooted pane: the PTY root itself is the agent, not its MCP node child', () => {
    const table = [
      entry(SHELL, 1, '/Users/me/.local/bin/claude', 'claude --permission-mode default'),
      entry(101, SHELL, 'node', 'node /tmp/mcp-server.js'),
    ];
    expect(selectAgentProcess(table, SHELL)).toEqual({ pid: SHELL, slug: 'claude' });
  });

  it('a plain shell root is never the pick (interactive panes unchanged)', () => {
    const table = [
      entry(SHELL, 1, '-zsh', '-zsh'),
      entry(201, SHELL, 'claude'),
      entry(301, 201, 'node', 'node /tmp/mcp-server.js'),
    ];
    expect(selectAgentProcess(table, SHELL)).toEqual({ pid: 201, slug: 'claude' });
  });

  it('picks a native agent binary among descendants (over its MCP node children)', () => {
    const table = [
      entry(SHELL, 1, 'pwsh.exe'),
      entry(200, SHELL, 'claude.exe'),
      entry(300, 200, 'node.exe', 'node mcp-server.js'), // MCP server child of claude
    ];
    expect(selectAgentProcess(table, SHELL)).toEqual({ pid: 200, slug: 'claude' });
  });

  it('compares attributed candidates by DEPTH regardless of class: a shallower node-hosted primary beats a deeper native child', () => {
    // #919 panel: the old native-beats-runtime priority let a deeper native
    // MCP-server binary steal the identity from the node-hosted primary CLI.
    const table = [
      entry(200, SHELL, 'node', 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
      entry(300, 200, 'codex'), // claude-code's MCP server for another agent
    ];
    expect(selectAgentProcess(table, SHELL)).toEqual({ pid: 200, slug: 'claude' });
  });

  it('an exact-depth tie between two different slugs drops the slug but keeps the death watch', () => {
    const table = [entry(200, SHELL, 'claude'), entry(300, SHELL, 'codex')];
    expect(selectAgentProcess(table, SHELL)).toEqual({ pid: 200 });
  });

  it('falls back to the SHALLOWEST unattributed runtime (cmd shim → node CLI → MCP node)', () => {
    const table = [
      entry(200, SHELL, 'cmd.exe'), // claude.cmd shim
      entry(300, 200, 'node.exe', 'node mystery.js'), // the CLI itself, unresolvable cmdline
      entry(400, 300, 'node.exe', 'node mcp.js'), // its MCP server — deeper, must not win
    ];
    expect(selectAgentProcess(table, SHELL)).toEqual({ pid: 300 });
  });

  it('falls back to the first direct child for unknown wrappers', () => {
    const table = [entry(200, SHELL, 'somewrapper.exe')];
    expect(selectAgentProcess(table, SHELL)).toEqual({ pid: 200 });
  });

  it('returns undefined when the shell has no descendants', () => {
    const table = [entry(SHELL, 1, 'pwsh.exe'), entry(999, 1, 'claude.exe')];
    expect(selectAgentProcess(table, SHELL)).toBeUndefined();
  });

  it('survives PPID cycles (stale/reused parent ids)', () => {
    const table = [
      entry(200, SHELL, 'cmd.exe'),
      entry(300, 200, 'node.exe', 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
      entry(SHELL, 300, 'pwsh.exe'), // cycle back to the shell
    ];
    expect(selectAgentProcess(table, SHELL)).toEqual({ pid: 300, slug: 'claude' });
  });

  it('maps a native stem that is not itself a slug (kiro-cli → kiro)', () => {
    const table = [entry(200, SHELL, 'kiro-cli')];
    expect(selectAgentProcess(table, SHELL)).toEqual({ pid: 200, slug: 'kiro' });
  });
});

// ── tracker lifecycle ────────────────────────────────────────────────────────

function makeWatcher(): PidWatcher & { watches: Map<string, { pid: number; onDead: () => void }> } {
  const watches = new Map<string, { pid: number; onDead: () => void }>();
  return {
    watches,
    watch(key, pid, onDead) {
      watches.set(key, { pid, onDead });
    },
    unwatch(key) {
      watches.delete(key);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AgentProcessTracker', () => {
  const SHELL = 100;
  const TABLE = [entry(200, SHELL, 'claude.exe')];

  it('arm → alive with identity; onDead flips to the dead edge; re-arm re-probes', async () => {
    const watcher = makeWatcher();
    const enumerate = vi.fn(async () => TABLE);
    const tracker = new AgentProcessTracker(watcher, enumerate);

    expect(tracker.statusFor('s1')).toBeUndefined();
    tracker.arm('s1', SHELL);
    await flush();
    expect(tracker.statusFor('s1')).toBe(true);
    expect(tracker.identityFor('s1')).toEqual({ slug: 'claude', alive: true });
    expect(watcher.watches.get('agent:s1')?.pid).toBe(200);

    // Hook storm: arming a live watch is a no-op (one probe per launch).
    tracker.arm('s1', SHELL);
    await flush();
    expect(enumerate).toHaveBeenCalledTimes(1);

    // The edge: the watched process died.
    watcher.watches.get('agent:s1')?.onDead();
    expect(tracker.statusFor('s1')).toBe(false);
    expect(tracker.identityFor('s1')).toEqual({ slug: 'claude', alive: false });

    // Agent relaunched → a fresh hook re-arms and re-probes.
    tracker.arm('s1', SHELL);
    await flush();
    expect(enumerate).toHaveBeenCalledTimes(2);
    expect(tracker.statusFor('s1')).toBe(true);
  });

  it('a stop\'s confirming read records the death edge at once, not on the monitor\'s next poll', async () => {
    // session.stopAgent kills the agent and confirms it gone with a fresh
    // table (stillRunning). The session list read right after must not still
    // report it alive until the monitor polls (a slot shown free, then in use
    // again, then free).
    const watcher = makeWatcher();
    let table: ProcessTreeEntry[] = [entry(200, SHELL, 'claude.exe')];
    const tracker = new AgentProcessTracker(watcher, async () => table);
    const edges: boolean[] = [];
    tracker.setStateChangeListener((_id, st) => edges.push(st.alive));
    tracker.arm('s1', SHELL);
    await flush();
    const root = (await tracker.agentProcessTree('s1', 'claude'))?.root;
    expect(root?.pid).toBe(200);

    table = [];
    expect(await tracker.stillRunning(root ? [root] : [])).toEqual([]);
    expect(tracker.statusFor('s1')).toBe(false);
    expect(edges).toEqual([true, false]);
    // The monitor no longer watches it: no second report of the same death.
    expect(watcher.watches.has('agent:s1')).toBe(false);
  });

  it('a confirming read that still lists the agent, or names another pid, changes nothing', async () => {
    const watcher = makeWatcher();
    const table: ProcessTreeEntry[] = [entry(200, SHELL, 'claude.exe')];
    const tracker = new AgentProcessTracker(watcher, async () => table);
    tracker.arm('s1', SHELL);
    await flush();
    expect(await tracker.stillRunning([entry(200, SHELL, 'claude.exe')])).toHaveLength(1);
    expect(await tracker.stillRunning([entry(999, 200, 'node')])).toEqual([]);
    expect(tracker.statusFor('s1')).toBe(true);
    expect(watcher.watches.has('agent:s1')).toBe(true);
  });

  it('processesWithArg: the marker in argv, and on Windows an agent image whose argv cannot be read', async () => {
    const MARK = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const table = [
      entry(300, 1, 'claude.exe', `claude --resume ${MARK}`),
      entry(301, 1, 'node.exe'),
      entry(302, 1, 'Bun.exe', ''),
      entry(303, 1, 'svchost.exe'),
      entry(304, 1, 'node.exe', 'node other.js'),
    ];
    const win = new AgentProcessTracker(makeWatcher(), async () => table, undefined, undefined, undefined, 'win32');
    expect((await win.processesWithArg(MARK)).map((e) => e.pid)).toEqual([300, 301, 302]);
    // Elsewhere ps always prints argv: only the marker counts.
    const mac = new AgentProcessTracker(makeWatcher(), async () => table, undefined, undefined, undefined, 'darwin');
    expect((await mac.processesWithArg(MARK)).map((e) => e.pid)).toEqual([300]);
  });

  it('a reused pid is no longer the agent: the confirming read records its death edge', async () => {
    const watcher = makeWatcher();
    let table: ProcessTreeEntry[] = [entry(200, SHELL, 'claude.exe')];
    const tracker = new AgentProcessTracker(watcher, async () => table);
    tracker.arm('s1', SHELL);
    await flush();
    const root = (await tracker.agentProcessTree('s1', 'claude'))?.root;
    table = [entry(200, 1, 'notepad.exe')];
    expect(await tracker.stillRunning(root ? [root] : [])).toEqual([]);
    expect(tracker.statusFor('s1')).toBe(false);
  });

  it('an agent armed after the tree read is not the one found gone', async () => {
    const watcher = makeWatcher();
    let table: ProcessTreeEntry[] = [entry(200, SHELL, 'claude.exe')];
    const tracker = new AgentProcessTracker(watcher, async () => table);
    tracker.arm('s1', SHELL);
    await flush();
    const root = (await tracker.agentProcessTree('s1', 'claude'))?.root;
    // A relaunch in the same pane, armed before the old tree is checked.
    table = [entry(300, SHELL, 'claude.exe')];
    tracker.rearm('s1', SHELL);
    await flush();
    expect(watcher.watches.get('agent:s1')?.pid).toBe(300);
    expect(await tracker.stillRunning(root ? [root] : [])).toEqual([]);
    expect(tracker.statusFor('s1')).toBe(true);
    expect(watcher.watches.get('agent:s1')?.pid).toBe(300);
  });

  it('a re-probe of the same agent after the tree read still takes the confirmed death', async () => {
    const watcher = makeWatcher();
    let table: ProcessTreeEntry[] = [entry(200, SHELL, 'claude.exe')];
    const tracker = new AgentProcessTracker(watcher, async () => table);
    tracker.arm('s1', SHELL);
    await flush();
    const root = (await tracker.agentProcessTree('s1', 'claude'))?.root;
    // A conflicting banner forces a probe that picks the same process again.
    tracker.rearm('s1', SHELL);
    await flush();
    expect(watcher.watches.get('agent:s1')?.pid).toBe(200);
    table = [];
    expect(await tracker.stillRunning(root ? [root] : [])).toEqual([]);
    expect(tracker.statusFor('s1')).toBe(false);
    expect(watcher.watches.has('agent:s1')).toBe(false);
  });

  it('a tree read that no longer finds the tracked agent records its death edge', async () => {
    const watcher = makeWatcher();
    let table: ProcessTreeEntry[] = [entry(200, SHELL, 'claude.exe')];
    const tracker = new AgentProcessTracker(watcher, async () => table);
    tracker.arm('s1', SHELL);
    await flush();
    table = [];
    expect(await tracker.agentProcessTree('s1', 'claude')).toBeNull();
    expect(tracker.statusFor('s1')).toBe(false);
    expect(watcher.watches.has('agent:s1')).toBe(false);
  });

  it('a slugless pick answers liveness but claims no identity', async () => {
    const watcher = makeWatcher();
    const tracker = new AgentProcessTracker(watcher, async () => [entry(200, SHELL, 'somewrapper.exe')]);
    tracker.arm('s1', SHELL);
    await flush();
    expect(tracker.statusFor('s1')).toBe(true);
    expect(tracker.identityFor('s1')).toEqual({ alive: true });
  });

  it('rearm forces a probe past a stale alive pick when the agent changed', async () => {
    const watcher = makeWatcher();
    let table = [entry(200, SHELL, 'claude.exe')];
    const enumerate = vi.fn(async () => table);
    const tracker = new AgentProcessTracker(watcher, enumerate);

    tracker.arm('s1', SHELL);
    await flush();
    expect(tracker.identityFor('s1')?.slug).toBe('claude');

    // Claude exited, codex launched — but the old pick's death poll hasn't
    // fired yet (alive still true). A plain arm no-ops; a CONFLICTING banner
    // must force the probe.
    table = [entry(300, SHELL, 'codex')];
    tracker.arm('s1', SHELL);
    await flush();
    expect(enumerate).toHaveBeenCalledTimes(1);
    tracker.rearm('s1', SHELL);
    await flush();
    expect(enumerate).toHaveBeenCalledTimes(2);
    expect(tracker.identityFor('s1')).toEqual({ slug: 'codex', alive: true });
  });

  it('a rearm queued behind an in-flight probe replays as a probe (cooldown already paid)', async () => {
    // Review bug: the replay used to route through rearm() again, which hit
    // the 10s cooldown the QUEUING rearm had just paid — the forced probe was
    // silently dropped and the stale pick kept winning.
    const watcher = makeWatcher();
    let table = [entry(200, SHELL, 'claude.exe')];
    const enumerate = vi.fn(async () => table);
    const tracker = new AgentProcessTracker(watcher, enumerate);

    tracker.arm('s1', SHELL); // probe A in flight
    table = [entry(300, SHELL, 'codex')];
    tracker.rearm('s1', SHELL); // queues the forced probe behind A
    await flush();
    await flush();
    expect(enumerate).toHaveBeenCalledTimes(2);
    expect(tracker.identityFor('s1')).toEqual({ slug: 'codex', alive: true });
  });

  it('unattributable and failed probes back off; rearm ignores the backoff', async () => {
    const watcher = makeWatcher();
    const enumerate = vi.fn(async () => []);
    const tracker = new AgentProcessTracker(watcher, enumerate);

    tracker.arm('s1', SHELL);
    await flush();
    expect(tracker.statusFor('s1')).toBeUndefined();

    tracker.arm('s1', SHELL); // negative backoff: no re-enumeration
    await flush();
    expect(enumerate).toHaveBeenCalledTimes(1);

    tracker.rearm('s1', SHELL); // explicit launch evidence beats the backoff
    await flush();
    expect(enumerate).toHaveBeenCalledTimes(2);

    const failing = new AgentProcessTracker(watcher, async () => {
      throw new Error('tasklist timeout');
    });
    failing.arm('s2', SHELL);
    await flush();
    expect(failing.statusFor('s2')).toBeUndefined();
    expect(watcher.watches.size).toBe(0);
  });

  it('armIfAgent names a resumed Codex that no hook or banner announced', async () => {
    const watcher = makeWatcher();
    const listener = vi.fn();
    // zsh → node …/@openai/codex/bin/codex.js resume --last → native codex
    const table = [
      entry(200, SHELL, 'node', 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js resume --last'),
      entry(201, 200, '/usr/local/lib/node_modules/@openai/codex/vendor/bin/codex', 'codex resume --last'),
    ];
    const tracker = new AgentProcessTracker(watcher, async () => table);
    tracker.setStateChangeListener(listener);

    tracker.armIfAgent('s1', SHELL);
    await flush();
    expect(tracker.identityFor('s1')).toEqual({ slug: 'codex', alive: true });
    // The scoped launcher script names no agent; the native binary does.
    expect(watcher.watches.get('agent:s1')?.pid).toBe(201);
    expect(listener).toHaveBeenCalledWith('s1', { slug: 'codex', alive: true, observedAt: expect.any(Number) });
  });

  it('armIfAgent leaves no trace for a non-agent command and backs off only itself', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const watcher = makeWatcher();
      const listener = vi.fn();
      let table = [entry(200, SHELL, 'node', 'node /work/app/node_modules/.bin/vite')];
      const enumerate = vi.fn(async () => table);
      const tracker = new AgentProcessTracker(watcher, enumerate);
      tracker.setStateChangeListener(listener);

      tracker.armIfAgent('s1', SHELL);
      await flush();
      // A plain dev server is not an agent: no liveness flag (so no later
      // processExit edge), no watch, no listener call.
      expect(tracker.statusFor('s1')).toBeUndefined();
      expect(watcher.watches.size).toBe(0);
      expect(listener).not.toHaveBeenCalled();

      // The miss keeps the next guess away for a few seconds…
      tracker.armIfAgent('s1', SHELL);
      await flush();
      expect(enumerate).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(AGENT_MISS_BACKOFF_MS);
      tracker.armIfAgent('s1', SHELL);
      await flush();
      expect(enumerate).toHaveBeenCalledTimes(2);

      // …but never holds back an agent that hook or banner evidence names.
      table = [entry(300, SHELL, 'claude')];
      tracker.arm('s1', SHELL);
      await flush();
      expect(enumerate).toHaveBeenCalledTimes(3);
      expect(tracker.identityFor('s1')).toEqual({ slug: 'claude', alive: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('armIfAgent backs off for ARM_BACKOFF_MS after an enumeration failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const enumerate = vi.fn(async (): Promise<ProcessTreeEntry[]> => {
        throw new Error('ps timeout');
      });
      const tracker = new AgentProcessTracker(makeWatcher(), enumerate);
      tracker.armIfAgent('s1', SHELL);
      await flush();
      vi.advanceTimersByTime(AGENT_MISS_BACKOFF_MS);
      tracker.armIfAgent('s1', SHELL);
      await flush();
      expect(enumerate).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_000);
      tracker.armIfAgent('s1', SHELL);
      await flush();
      expect(enumerate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('armIfAgent names the next agent when the tracked one exited before the monitor noticed', async () => {
    const watcher = makeWatcher();
    const listener = vi.fn();
    let table = [entry(200, SHELL, 'claude')];
    const tracker = new AgentProcessTracker(watcher, async () => table);
    tracker.setStateChangeListener(listener);

    tracker.arm('s1', SHELL);
    await flush();
    expect(tracker.identityFor('s1')).toEqual({ slug: 'claude', alive: true });

    // claude exits, codex starts inside the monitor's polling gap: the tracker
    // still reads claude as alive when codex's command-start arrives.
    table = [entry(300, SHELL, 'codex')];
    tracker.armIfAgent('s1', SHELL);
    await flush();
    expect(tracker.identityFor('s1')).toEqual({ slug: 'codex', alive: true });
    expect(watcher.watches.get('agent:s1')?.pid).toBe(300);
    expect(listener.mock.calls).toEqual([
      ['s1', { slug: 'claude', alive: true, observedAt: expect.any(Number) }],
      ['s1', { slug: 'claude', alive: false }],
      ['s1', { slug: 'codex', alive: true, observedAt: expect.any(Number) }],
    ]);
  });

  it('armIfAgent keeps a live agent and does not resurrect a dead one', async () => {
    const watcher = makeWatcher();
    let table = [entry(200, SHELL, 'codex')];
    const listener = vi.fn();
    const tracker = new AgentProcessTracker(watcher, async () => table);
    tracker.setStateChangeListener(listener);

    tracker.armIfAgent('s1', SHELL);
    await flush();
    tracker.armIfAgent('s1', SHELL); // still in the table → unchanged
    await flush();
    expect(tracker.identityFor('s1')).toEqual({ slug: 'codex', alive: true });
    expect(listener).toHaveBeenCalledTimes(1);

    watcher.watches.get('agent:s1')?.onDead();
    table = []; // the shell is back at its prompt: nothing under it
    tracker.armIfAgent('s1', SHELL);
    await flush();
    expect(tracker.identityFor('s1')).toEqual({ slug: 'codex', alive: false });
  });

  it('an armIfAgent call during an in-flight probe is queued, not dropped', async () => {
    const watcher = makeWatcher();
    let table: ProcessTreeEntry[] = [];
    const enumerate = vi.fn(async () => table);
    const tracker = new AgentProcessTracker(watcher, enumerate);

    tracker.arm('s1', SHELL); // plain probe in flight, sees an empty table
    table = [entry(300, SHELL, 'codex')];
    tracker.armIfAgent('s1', SHELL);
    await flush();
    await flush();
    expect(enumerate).toHaveBeenCalledTimes(2);
    expect(tracker.identityFor('s1')).toEqual({ slug: 'codex', alive: true });
  });

  it('an arm landing during an armIfAgent probe is replayed, not swallowed', async () => {
    const watcher = makeWatcher();
    const table = [entry(200, SHELL, 'somewrapper')];
    const enumerate = vi.fn(async () => table);
    const tracker = new AgentProcessTracker(watcher, enumerate);

    tracker.armIfAgent('s1', SHELL); // agent-only probe in flight
    tracker.arm('s1', SHELL); // hook evidence arrives meanwhile
    await flush();
    await flush();
    // The agent-only probe dropped the slugless pick; the replayed arm keeps
    // it for liveness, as a plain arm always has.
    expect(enumerate).toHaveBeenCalledTimes(2);
    expect(tracker.identityFor('s1')).toEqual({ alive: true });
  });

  it('fires the state listener on attribution and on the death edge', async () => {
    const watcher = makeWatcher();
    const listener = vi.fn();
    const tracker = new AgentProcessTracker(watcher, async () => TABLE);
    tracker.setStateChangeListener(listener);

    tracker.arm('s1', SHELL);
    await flush();
    expect(listener).toHaveBeenCalledWith('s1', { slug: 'claude', alive: true, observedAt: expect.any(Number) });

    watcher.watches.get('agent:s1')?.onDead();
    expect(listener).toHaveBeenCalledWith('s1', { slug: 'claude', alive: false });
  });

  it('disarm clears state, and a disarm racing an in-flight arm wins', async () => {
    const watcher = makeWatcher();
    let release: (v: ProcessTreeEntry[]) => void = () => undefined;
    const gated = new Promise<ProcessTreeEntry[]>((r) => { release = r; });
    const tracker = new AgentProcessTracker(watcher, () => gated);

    tracker.arm('s1', SHELL);
    tracker.disarm('s1'); // session destroyed while the probe is in flight
    release(TABLE);
    await flush();
    expect(tracker.statusFor('s1')).toBeUndefined();
    expect(watcher.watches.size).toBe(0);
  });

  it('a stale onDead from a superseded watch cannot kill a re-armed session', async () => {
    const watcher = makeWatcher();
    let table = [entry(200, SHELL, 'claude.exe')];
    const tracker = new AgentProcessTracker(watcher, async () => table);

    tracker.arm('s1', SHELL);
    await flush();
    const first = watcher.watches.get('agent:s1');
    first?.onDead();
    expect(tracker.statusFor('s1')).toBe(false);

    table = [entry(300, SHELL, 'claude.exe')]; // relaunched under a new pid
    tracker.arm('s1', SHELL);
    await flush();
    expect(tracker.statusFor('s1')).toBe(true);

    // A duplicate/stale death signal for the OLD pid must not flip the new watch.
    first?.onDead();
    expect(tracker.statusFor('s1')).toBe(true);
  });

  it('verifyLive passes only while a fresh table still picks the tracked pid and slug', async () => {
    const watcher = makeWatcher();
    let table = [entry(200, SHELL, 'claude.exe')];
    const tracker = new AgentProcessTracker(watcher, async () => table, undefined, undefined, undefined, 'win32');

    expect(await tracker.verifyLive('s1', 'claude')).toBe(false); // never armed
    tracker.arm('s1', SHELL);
    await flush();
    expect(await tracker.verifyLive('s1', 'claude')).toBe(true);
    expect(await tracker.verifyLive('s1', 'codex')).toBe(false);

    table = [entry(200, 999, 'claude.exe')]; // same pid, no longer under the pane shell
    expect(await tracker.verifyLive('s1', 'claude')).toBe(false);

    table = [entry(200, SHELL, 'claude.exe')];
    watcher.watches.get('agent:s1')?.onDead();
    expect(await tracker.verifyLive('s1', 'claude')).toBe(false);
  });

  it('verifyLive fails when the tracked pid now runs a different program — the #1307 regression guard', async () => {
    const watcher = makeWatcher();
    let table = [entry(200, SHELL, 'claude.exe')];
    const tracker = new AgentProcessTracker(watcher, async () => table, undefined, undefined, undefined, 'win32');
    tracker.arm('s1', SHELL);
    await flush();

    table = [entry(200, SHELL, 'bash')]; // pid reused before the death poll
    expect(tracker.statusFor('s1')).toBe(true);
    expect(await tracker.verifyLive('s1', 'claude')).toBe(false);
  });

  it('verifyLive fails when the agent dies while the table is being read', async () => {
    const watcher = makeWatcher();
    let release: ((table: ProcessTreeEntry[]) => void) | undefined;
    let gated = false;
    const tracker = new AgentProcessTracker(watcher, () => (gated
      ? new Promise<ProcessTreeEntry[]>((resolve) => { release = resolve; })
      : Promise.resolve(TABLE)), undefined, undefined, undefined, 'win32');
    tracker.arm('s1', SHELL);
    await flush();

    gated = true;
    const verdict = tracker.verifyLive('s1', 'claude');
    watcher.watches.get('agent:s1')?.onDead();
    release?.(TABLE);
    expect(await verdict).toBe(false);
  });

  it('verifyLive fails closed when enumeration throws', async () => {
    const watcher = makeWatcher();
    let fail = false;
    const tracker = new AgentProcessTracker(watcher, async () => {
      if (fail) throw new Error('ps timed out');
      return TABLE;
    }, undefined, undefined, undefined, 'win32');
    tracker.arm('s1', SHELL);
    await flush();

    fail = true;
    expect(await tracker.verifyLive('s1', 'claude')).toBe(false);
  });
});

describe('owned native agent root', () => {
  it('accepts only the armed PTY root with freshly matching executable metadata', async () => {
    let entries = [entry(100, 1, 'opencode')];
    const watcher = { watch: vi.fn(), unwatch: vi.fn() };
    const tracker = new AgentProcessTracker(watcher, async () => entries, undefined, undefined, undefined, 'win32');
    expect(await tracker.verifyOwnedRoot('pane', 100, 'opencode')).toBe(false);
    tracker.arm('pane', 100);
    expect(await tracker.verifyOwnedRoot('pane', 100, 'opencode')).toBe(true);
    expect(await tracker.verifyOwnedRoot('pane', 100, 'codex')).toBe(false);
    entries = [entry(100, 1, 'zsh')];
    expect(await tracker.verifyOwnedRoot('pane', 100, 'opencode')).toBe(false);
    tracker.disarm('pane');
    expect(await tracker.verifyOwnedRoot('pane', 100, 'opencode')).toBe(false);
  });
});

// Windows never reparents: a process whose parent died before the agent
// started keeps that parent's pid, which the agent may have reused.
describe('the agent tree on Windows is dated', () => {
  const dated = (pid: number, ppid: number, name: string, created?: number): ProcessTreeEntry =>
    ({ ...entry(pid, ppid, name), ...(created !== undefined ? { created } : {}) });
  const SHELL = dated(100, 1, 'pwsh.exe', 1_000);
  const AGENT = dated(200, 100, 'claude.exe', 2_000);
  const pids = (es: readonly ProcessTreeEntry[] | undefined) => (es ?? []).map((e) => e.pid);

  async function armed(table: () => ProcessTreeEntry[], platform: NodeJS.Platform = 'win32') {
    const tracker = new AgentProcessTracker(makeWatcher(), async () => table(), async () => '/Users/dev/.local/share/claude/versions/2.1.307',
      '/Users/dev', {}, platform);
    tracker.arm('s1', SHELL.pid);
    await flush();
    return tracker;
  }

  it('leaves out a process older than the agent, and everything under it', async () => {
    const table = [SHELL, AGENT,
      dated(201, 200, 'node.exe', 2_500), dated(202, 201, 'node.exe', 2_600),
      // Started before the agent, under a dead parent that had pid 200.
      dated(300, 200, 'Code.exe', 1_500), dated(301, 300, 'Code.exe', 3_000)];
    const tree = await (await armed(() => table)).agentProcessTree('s1', 'claude');
    expect(tree?.root.pid).toBe(200);
    expect(pids(tree?.descendants)).toEqual([201, 202]);
    expect(pids(tree?.uncertain)).toEqual([]);
  });

  it('a child started in the same millisecond as its parent is uncertain, with everything under it', async () => {
    const table = [SHELL, AGENT, dated(201, 200, 'node.exe', 2_000), dated(202, 201, 'node.exe', 2_500)];
    const tree = await (await armed(() => table)).agentProcessTree('s1', 'claude');
    expect(pids(tree?.descendants)).toEqual([]);
    expect(pids(tree?.uncertain)).toEqual([201, 202]);
  });

  it('a process whose age cannot be read is uncertain, with everything under it', async () => {
    const table = [SHELL, AGENT, dated(400, 200, 'node.exe'), dated(401, 400, 'node.exe', 3_000),
      // Under an undated parent but older than the agent: not below it.
      dated(402, 400, 'Code.exe', 1_500)];
    const tree = await (await armed(() => table)).agentProcessTree('s1', 'claude');
    expect(pids(tree?.descendants)).toEqual([]);
    expect(pids(tree?.uncertain)).toEqual([400, 401]);
  });

  it('a stop kills the agent\'s own children and never the older process', async () => {
    const alive = new Set([100, 200, 201, 300]);
    const table = [SHELL, AGENT, dated(201, 200, 'node.exe', 2_500), dated(300, 200, 'Code.exe', 1_500)];
    const tracker = await armed(() => table.filter((e) => alive.has(e.pid)));
    const kill = vi.fn((pid: number) => { alive.delete(pid); });
    const r = await stopAgentTree({
      tree: () => tracker.agentProcessTree('s1', 'claude'),
      stillRunning: (es) => tracker.liveness(es),
      kill,
      sleep: async () => undefined,
    });
    expect(kill.mock.calls).toEqual([[200, 'SIGTERM'], [201, 'SIGKILL']]);
    expect(r).toEqual({ ok: true, stopped: true, pid: 200, killed: 2 });
    expect(alive.has(300)).toBe(true);
  });

  it('a stop never signals an undated process, and is not confirmed while it runs', async () => {
    const alive = new Set([100, 200, 400]);
    const table = [SHELL, AGENT, dated(400, 200, 'node.exe')];
    const tracker = await armed(() => table.filter((e) => alive.has(e.pid)));
    const kill = vi.fn((pid: number) => { alive.delete(pid); });
    const r = await stopAgentTree({
      tree: () => tracker.agentProcessTree('s1', 'claude'),
      stillRunning: (es) => tracker.liveness(es),
      kill,
      sleep: async () => undefined,
    });
    expect(kill.mock.calls).toEqual([[200, 'SIGTERM']]);
    expect(r).toEqual({ ok: false, code: 'still_running', pid: 200 });
  });

  it('a process is the same one only with the same creation time', async () => {
    const mcp = dated(201, 200, 'node.exe', 2_500);
    let table = [SHELL, AGENT, mcp];
    const tracker = await armed(() => table);
    expect(await tracker.liveness([mcp])).toEqual({ same: [mcp], unsure: [] });
    // The pid taken by the same program with the same arguments, started later.
    table = [SHELL, AGENT, dated(201, 200, 'node.exe', 4_000)];
    expect(await tracker.liveness([mcp])).toEqual({ same: [], unsure: [] });
    expect(await tracker.stillRunning([mcp])).toEqual([]);
    // A creation time missing on either side proves nothing either way.
    table = [SHELL, AGENT, dated(201, 200, 'node.exe')];
    expect(await tracker.liveness([mcp])).toEqual({ same: [], unsure: [mcp] });
    expect(await tracker.stillRunning([mcp])).toEqual([mcp]);
  });

  it('a stop never kills a process that took a tree pid during the grace', async () => {
    let table = [SHELL, AGENT, dated(201, 200, 'node.exe', 2_500)];
    const tracker = await armed(() => table);
    const kill = vi.fn((pid: number) => {
      // The agent exits with its MCP server, and an identical server started
      // by something else gets pid 201 before the grace ends.
      if (pid === 200) table = [SHELL, dated(201, 999, 'node.exe', 6_000)];
      else table = table.filter((e) => e.pid !== pid);
    });
    const r = await stopAgentTree({
      tree: () => tracker.agentProcessTree('s1', 'claude'),
      stillRunning: (es) => tracker.liveness(es),
      kill,
      sleep: async () => undefined,
    });
    expect(kill.mock.calls).toEqual([[200, 'SIGTERM']]);
    expect(r).toEqual({ ok: true, stopped: true, pid: 200, killed: 2 });
  });

  it('a stop never kills a tree process a later read cannot date, and is not confirmed while it runs', async () => {
    let table = [SHELL, AGENT, dated(201, 200, 'node.exe', 2_500)];
    const tracker = await armed(() => table);
    const kill = vi.fn((pid: number) => {
      if (pid === 200) table = [SHELL, dated(201, 200, 'node.exe')];
      else table = table.filter((e) => e.pid !== pid);
    });
    const r = await stopAgentTree({
      tree: () => tracker.agentProcessTree('s1', 'claude'),
      stillRunning: (es) => tracker.liveness(es),
      kill,
      sleep: async () => undefined,
    });
    expect(kill.mock.calls).toEqual([[200, 'SIGTERM']]);
    expect(r).toEqual({ ok: false, code: 'still_running', pid: 200 });
  });

  it('POSIX reparents, so its tree is the plain ppid walk', async () => {
    const table = [SHELL, dated(200, 100, 'claude', 2_000), dated(201, 200, 'node', 1_500), dated(202, 200, 'node')];
    const tracker = await armed(() => table, 'linux');
    const tree = await tracker.agentProcessTree('s1', 'claude');
    expect(tree?.root.pid).toBe(200);
    expect(pids(tree?.descendants)).toEqual([201, 202]);
    expect(pids(tree?.uncertain)).toEqual([]);
    // Nor is a creation time part of a process's identity there.
    const later = [dated(201, 200, 'node', 9_000), dated(202, 200, 'node', 9_000)];
    expect(await tracker.liveness(later)).toEqual({ same: later, unsure: [] });
  });
});

const imageTracker = (table: ProcessTreeEntry[], readImage: (pid: number) => Promise<string | undefined>, platform: NodeJS.Platform) =>
  new AgentProcessTracker(makeWatcher(), async () => table, readImage, '/Users/dev', {}, platform);

// argv is self-reported, so on macOS and Linux an agent is verified by the
// executable the kernel reports for it. POSIX paths and symlinked fixtures.
describe.skipIf(process.platform === 'win32')('the real executable backs the agent', () => {
  const HOME = '/Users/dev';
  const NODE = '/opt/homebrew/Cellar/node/24.1.0/bin/node';
  const PYTHON = '/opt/homebrew/Cellar/python@3.12/3.12.7/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python';
  let root = '';
  let claudeBin = '';
  let codexBin = '';
  let openclaudeBin = '';
  let lookalike = '';
  // An npm global install: bin/<name> links into the package.
  const install = (pkg: string, file: string, bin: string): string => {
    const target = path.join(root, 'lib', 'node_modules', pkg, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.symlinkSync(target, path.join(root, 'bin', bin));
    return path.join(root, 'bin', bin);
  };
  // A python environment (pipx, uv tool, venv): bin/<script> beside lib/pythonX.Y/site-packages.
  const pythonEnv = (dir: string, script: string, pkg?: string): string => {
    const env = path.join(root, dir);
    fs.mkdirSync(path.join(env, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(env, 'bin', script), '');
    const site = path.join(env, 'lib', 'python3.12', 'site-packages');
    fs.mkdirSync(pkg ? path.join(site, pkg) : site, { recursive: true });
    if (pkg) fs.writeFileSync(path.join(site, pkg, 'main.py'), '');
    return path.join(env, 'bin', script);
  };
  beforeAll(() => {
    // Resolved, as the kernel reports paths (macOS tmpdir is a symlink).
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-agent-image-')));
    claudeBin = install('@anthropic-ai/claude-code', 'cli.js', 'claude');
    codexBin = install('@openai/codex', 'bin/codex.js', 'codex');
    openclaudeBin = install('@gitlawb/openclaude', 'bin/openclaude', 'openclaude');
    lookalike = path.join(root, 'claude.js');
    fs.writeFileSync(lookalike, '');
  });
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('a native agent is its own binary, never another program renamed by exec -a', () => {
    const claude = entry(200, 100, 'claude', 'claude --model opus');
    expect(isAgentImage(claude, 'claude', `${HOME}/.local/share/claude/versions/2.1.307`, HOME)).toBe(true);
    expect(isAgentImage(claude, 'claude', '/opt/homebrew/Caskroom/claude-code/2.1.307/claude', HOME)).toBe(true);
    // An npm install's postinstall copies the native binary over bin/claude.exe.
    expect(isAgentImage(claude, 'claude', '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe', HOME)).toBe(true);
    expect(isAgentImage(claude, 'claude', '/bin/sleep', HOME)).toBe(false);
    expect(isAgentImage(claude, 'claude', '/tmp/x/2.1.307', HOME)).toBe(false);
    expect(isAgentImage(claude, 'claude', undefined, HOME)).toBe(false);
    expect(isAgentImage(entry(200, 100, 'codex'), 'codex', '/opt/homebrew/Caskroom/codex/0.50.0/codex-aarch64-apple-darwin', HOME)).toBe(true);
    expect(isAgentImage(entry(200, 100, 'kiro-cli'), 'kiro', '/usr/local/bin/kiro-cli', HOME)).toBe(true);
    expect(isAgentImage(entry(200, 100, 'codex'), 'claude', '/usr/local/bin/codex', HOME)).toBe(false);
  });

  it('grok\'s installer binary is named for its version and platform', () => {
    const grok = entry(200, 100, 'grok', 'grok');
    expect(isAgentImage(grok, 'grok', `${HOME}/.grok/downloads/grok-1.0.52-macos-aarch64`, HOME)).toBe(true);
    expect(isAgentImage(grok, 'grok', `${HOME}/.grok/downloads/grok-1.0.52-linux-x86_64`, HOME)).toBe(true);
    expect(isAgentImage(grok, 'grok', '/tmp/downloads/grok-1.0.52-macos-aarch64', HOME)).toBe(false);
    expect(isAgentImage(grok, 'claude', `${HOME}/.grok/downloads/grok-1.0.52-macos-aarch64`, HOME)).toBe(false);
  });

  it('the version directory is matched through a symlinked home', () => {
    const real = path.join(root, 'real-home');
    fs.mkdirSync(path.join(real, '.local/share/claude/versions'), { recursive: true });
    fs.symlinkSync(real, path.join(root, 'home-link'));
    const image = path.join(real, '.local/share/claude/versions/2.1.307');
    expect(isAgentImage(entry(200, 100, 'claude'), 'claude', image, path.join(root, 'home-link'))).toBe(true);
  });

  it('a runtime-hosted agent runs a script inside that agent\'s installed package', () => {
    expect(isAgentImage(entry(200, 100, 'node', `node ${claudeBin}`), 'claude', NODE, HOME)).toBe(true);
    expect(isAgentImage(entry(200, 100, 'node', `node --max-old-space-size=4096 ${claudeBin} -c`), 'claude', NODE, HOME)).toBe(true);
    expect(isAgentImage(entry(200, 100, 'node', `node ${codexBin}`), 'codex', '/usr/bin/nodejs', HOME)).toBe(true);
    expect(isAgentImage(entry(200, 100, 'node', `node ${openclaudeBin}`), 'openclaude', NODE, HOME)).toBe(true);
    expect(isAgentImage(entry(200, 100, 'node', `node ${codexBin}`), 'claude', NODE, HOME)).toBe(false);
    // A script that only looks like the agent, a missing one, a relative one.
    expect(isAgentImage(entry(200, 100, 'node', `node ${lookalike}`), 'claude', NODE, HOME)).toBe(false);
    expect(isAgentImage(entry(200, 100, 'node', 'node /tmp/claude.js'), 'claude', NODE, HOME)).toBe(false);
    expect(isAgentImage(entry(200, 100, 'node', 'node ./cli.js'), 'claude', NODE, HOME)).toBe(false);
    // The image is no runtime.
    expect(isAgentImage(entry(200, 100, 'node', `node ${claudeBin}`), 'claude', '/bin/sleep', HOME)).toBe(false);
  });

  it('aider runs from an environment that has the aider package installed', () => {
    const pipx = pythonEnv('pipx/venvs/aider-chat', 'aider', 'aider');
    const brew = pythonEnv('Cellar/aider/0.86.1/libexec', 'aider', 'aider');
    const empty = pythonEnv('venvs/other', 'aider');
    const site = path.join(root, 'pipx/venvs/aider-chat/lib/python3.12/site-packages/aider/main.py');
    // A shebang launch: argv is the environment's interpreter, then the script.
    const venvPython = path.join(root, 'pipx/venvs/aider-chat/bin/python3');
    expect(isAgentImage(entry(200, 100, venvPython, `${venvPython} ${pipx} --model x`), 'aider', PYTHON, HOME)).toBe(true);
    const brewPython = path.join(root, 'Cellar/aider/0.86.1/libexec/bin/python');
    expect(isAgentImage(entry(200, 100, brewPython, `${brewPython} ${brew}`), 'aider', '/usr/bin/python3.12', HOME)).toBe(true);
    expect(isAgentImage(entry(200, 100, 'python', `python ${site}`), 'aider', PYTHON, HOME)).toBe(true);
    // No aider package beside the script, a node image, the wrong agent.
    expect(isAgentImage(entry(200, 100, 'python3', `python3 ${empty}`), 'aider', PYTHON, HOME)).toBe(false);
    expect(isAgentImage(entry(200, 100, 'python3', `python3 ${pipx}`), 'aider', NODE, HOME)).toBe(false);
    expect(isAgentImage(entry(200, 100, 'python3', `python3 ${pipx}`), 'claude', PYTHON, HOME)).toBe(false);
  });

  it('verifyLive refuses a renamed process and reads the image once per launch', async () => {
    const table = [entry(100, 1, 'zsh'), entry(200, 100, 'claude', 'claude 100')];
    const sleep = vi.fn(async () => '/bin/sleep');
    const renamed = imageTracker(table, sleep, 'darwin');
    renamed.arm('s1', 100);
    await flush();
    expect(await renamed.verifyLive('s1', 'claude')).toBe(false);

    const real = vi.fn(async () => `${HOME}/.local/share/claude/versions/2.1.307`);
    const live = imageTracker(table, real, 'linux');
    live.arm('s1', 100);
    await flush();
    expect(await live.verifyLive('s1', 'claude')).toBe(true);
    expect(await live.isAgentRunning('s1', 'claude', async () => true)).toBe(true);
    expect(real).toHaveBeenCalledTimes(1);
  });

  it('a failed image read is not cached: the next check reads again', async () => {
    const table = [entry(100, 1, 'zsh'), entry(200, 100, 'claude', 'claude')];
    const read = vi.fn<(pid: number) => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(`${HOME}/.local/share/claude/versions/2.1.307`);
    const t = imageTracker(table, read, 'darwin');
    t.arm('s1', 100);
    await flush();
    expect(await t.verifyLive('s1', 'claude')).toBe(false);
    expect(await t.verifyLive('s1', 'claude')).toBe(true);
    expect(await t.verifyLive('s1', 'claude')).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('verifyLive refuses node running a look-alike script, and accepts the installed agent', async () => {
    const read = async () => NODE;
    const fake = imageTracker([entry(100, 1, 'zsh'), entry(200, 100, 'node', 'node /tmp/claude.js')], read, 'darwin');
    fake.arm('s1', 100);
    await flush();
    expect(fake.identityFor('s1')).toEqual({ slug: 'claude', alive: true });
    expect(await fake.verifyLive('s1', 'claude')).toBe(false);

    const installed = imageTracker([entry(100, 1, 'zsh'), entry(200, 100, 'node', `node ${claudeBin}`)], read, 'darwin');
    installed.arm('s1', 100);
    await flush();
    expect(await installed.verifyLive('s1', 'claude')).toBe(true);
  });

  it('an exec pane\'s own root is checked the same way', async () => {
    const table = [entry(100, 1, 'opencode', 'opencode')];
    const renamed = imageTracker(table, async () => '/bin/sleep', 'darwin');
    renamed.arm('pane', 100);
    expect(await renamed.verifyOwnedRoot('pane', 100, 'opencode')).toBe(false);
    const real = imageTracker(table, async () => `${HOME}/.opencode/bin/opencode`, 'darwin');
    real.arm('pane', 100);
    expect(await real.verifyOwnedRoot('pane', 100, 'opencode')).toBe(true);
  });

  it('an exec pane\'s root is refused when the pane is re-armed while its image is read', async () => {
    let release: ((image: string) => void) | undefined;
    const t = imageTracker([entry(100, 1, 'opencode', 'opencode')],
      () => new Promise<string | undefined>((resolve) => { release = resolve; }), 'darwin');
    t.arm('pane', 100);
    const verdict = t.verifyOwnedRoot('pane', 100, 'opencode');
    await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 5_000 });
    t.disarm('pane');
    t.arm('pane', 100);
    release?.(`${HOME}/.opencode/bin/opencode`);
    expect(await verdict).toBe(false);
  });
});

describe('the executable image reader', () => {
  it('Linux: names a binary replaced while it runs without the " (deleted)" mark', async () => {
    const link = vi.fn(() => '/home/dev/.local/share/claude/versions/2.1.300 (deleted)');
    expect(await readExecutableImage(4242, 'linux', link)).toBe('/home/dev/.local/share/claude/versions/2.1.300');
    expect(link).toHaveBeenCalledWith('/proc/4242/exe');
    expect(await readExecutableImage(4242, 'linux', () => { throw new Error('ENOENT'); })).toBeUndefined();
  });

  it('Windows keeps the image-name check and never reads an image', async () => {
    const read = vi.fn(async () => undefined);
    const win = imageTracker([entry(100, 1, 'pwsh.exe'), entry(200, 100, 'claude.exe')], read, 'win32');
    win.arm('s1', 100);
    await flush();
    expect(await win.verifyLive('s1', 'claude')).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('idle shell launch verification', () => {
  it('refuses a child process, replaced root or missing PID', async () => {
    let entries = [entry(100, 1, 'zsh')];
    const tracker = new AgentProcessTracker({ watch: vi.fn(), unwatch: vi.fn() }, async () => entries);
    expect(await tracker.verifyIdleShell(100)).toBe(true);
    entries.push(entry(101, 100, 'vim'));
    expect(await tracker.verifyIdleShell(100)).toBe(false);
    entries = [entry(100, 1, 'codex')];
    expect(await tracker.verifyIdleShell(100)).toBe(false);
    expect(await tracker.verifyIdleShell(200)).toBe(false);
  });
});
