import { describe, it, expect, vi } from 'vitest';
import {
  AGENT_MISS_BACKOFF_MS,
  AgentProcessTracker,
  parsePipeDelimited,
  parsePsOutput,
  resolveAgentSlug,
  selectAgentProcess,
  tokenizeCmdline,
  type PidWatcher,
  type ProcessTreeEntry,
} from '../AgentProcessTracker';

const entry = (pid: number, ppid: number, name: string, cmdline?: string): ProcessTreeEntry => ({
  pid,
  ppid,
  name,
  ...(cmdline !== undefined ? { cmdline } : {}),
});

describe('parsePipeDelimited', () => {
  it('parses pid|ppid|name|cmdline lines, rejoining pipes inside the cmdline', () => {
    const out = parsePipeDelimited(
      'Windows PowerShell banner\r\n4|0|System\r\n123|4|pwsh.exe\r\n\r\nnot-a-line\r\n'
        + '77|123|claude.exe|claude --foo|bar\r\n'
        + '78|123|codex.exe\r\n',
    );
    expect(out).toEqual([
      entry(4, 0, 'System'),
      entry(123, 4, 'pwsh.exe'),
      entry(77, 123, 'claude.exe', 'claude --foo|bar'),
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
  const SHELL = 100;

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
    expect(listener).toHaveBeenCalledWith('s1', { slug: 'codex', alive: true });
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
      ['s1', { slug: 'claude', alive: true }],
      ['s1', { slug: 'claude', alive: false }],
      ['s1', { slug: 'codex', alive: true }],
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
    expect(listener).toHaveBeenCalledWith('s1', { slug: 'claude', alive: true });

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
    const tracker = new AgentProcessTracker(watcher, async () => table);

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
    const tracker = new AgentProcessTracker(watcher, async () => table);
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
      : Promise.resolve(TABLE)));
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
    });
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
    const tracker = new AgentProcessTracker(watcher, async () => entries);
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
