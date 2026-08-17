import { describe, it, expect, vi } from 'vitest';
import {
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
});
