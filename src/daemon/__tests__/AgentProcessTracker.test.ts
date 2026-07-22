import { describe, it, expect, vi } from 'vitest';
import {
  AgentProcessTracker,
  parsePipeDelimited,
  parsePsOutput,
  selectAgentPid,
  type PidWatcher,
  type ProcessTreeEntry,
} from '../AgentProcessTracker';

const entry = (pid: number, ppid: number, name: string): ProcessTreeEntry => ({ pid, ppid, name });

describe('parsePipeDelimited', () => {
  it('parses pid|ppid|name lines and skips garbage', () => {
    const out = parsePipeDelimited(
      'Windows PowerShell banner\r\n4|0|System\r\n123|4|pwsh.exe\r\n\r\nnot-a-line\r\n77|123|claude.exe\r\n',
    );
    expect(out).toEqual([
      entry(4, 0, 'System'),
      entry(123, 4, 'pwsh.exe'),
      entry(77, 123, 'claude.exe'),
    ]);
  });
});

describe('parsePsOutput', () => {
  it('parses ps -axo pid=,ppid=,comm= output, keeping path comms verbatim', () => {
    const out = parsePsOutput('    1     0 /sbin/launchd\n  500     1 -zsh\n  600   500 node\n');
    expect(out).toEqual([
      entry(1, 0, '/sbin/launchd'),
      entry(500, 1, '-zsh'),
      entry(600, 500, 'node'),
    ]);
  });
});

describe('selectAgentPid', () => {
  const SHELL = 100;

  it('picks a native agent binary among descendants (over its MCP node children)', () => {
    const table = [
      entry(SHELL, 1, 'pwsh.exe'),
      entry(200, SHELL, 'claude.exe'),
      entry(300, 200, 'node.exe'), // MCP server child of claude
    ];
    expect(selectAgentPid(table, SHELL)).toBe(200);
  });

  it('prefers the agent binary even when a runtime sits shallower', () => {
    const table = [
      entry(200, SHELL, 'node.exe'), // some wrapper at depth 1
      entry(300, 200, 'claude.exe'), // the agent at depth 2
    ];
    expect(selectAgentPid(table, SHELL)).toBe(300);
  });

  it('falls back to the SHALLOWEST runtime for npm installs (cmd shim → node CLI → MCP node)', () => {
    const table = [
      entry(200, SHELL, 'cmd.exe'), // claude.cmd shim
      entry(300, 200, 'node.exe'), // the CLI itself
      entry(400, 300, 'node.exe'), // its MCP server — deeper, must not win
    ];
    expect(selectAgentPid(table, SHELL)).toBe(300);
  });

  it('falls back to the first direct child for unknown wrappers', () => {
    const table = [entry(200, SHELL, 'somewrapper.exe')];
    expect(selectAgentPid(table, SHELL)).toBe(200);
  });

  it('returns undefined when the shell has no descendants', () => {
    const table = [entry(SHELL, 1, 'pwsh.exe'), entry(999, 1, 'claude.exe')];
    expect(selectAgentPid(table, SHELL)).toBeUndefined();
  });

  it('survives PPID cycles (stale/reused parent ids)', () => {
    const table = [
      entry(200, SHELL, 'cmd.exe'),
      entry(300, 200, 'node.exe'),
      entry(SHELL, 300, 'pwsh.exe'), // cycle back to the shell
    ];
    expect(selectAgentPid(table, SHELL)).toBe(300);
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

  it('arm → alive; onDead flips to the dead edge; re-arm re-probes', async () => {
    const watcher = makeWatcher();
    const enumerate = vi.fn(async () => TABLE);
    const tracker = new AgentProcessTracker(watcher, enumerate);

    expect(tracker.statusFor('s1')).toBeUndefined();
    tracker.arm('s1', SHELL);
    await flush();
    expect(tracker.statusFor('s1')).toBe(true);
    expect(watcher.watches.get('agent:s1')?.pid).toBe(200);

    // Hook storm: arming a live watch is a no-op (one probe per launch).
    tracker.arm('s1', SHELL);
    await flush();
    expect(enumerate).toHaveBeenCalledTimes(1);

    // The edge: the watched process died.
    watcher.watches.get('agent:s1')?.onDead();
    expect(tracker.statusFor('s1')).toBe(false);

    // Agent relaunched → a fresh hook re-arms and re-probes.
    tracker.arm('s1', SHELL);
    await flush();
    expect(enumerate).toHaveBeenCalledTimes(2);
    expect(tracker.statusFor('s1')).toBe(true);
  });

  it('stays undecided when nothing is attributable or enumeration fails', async () => {
    const watcher = makeWatcher();
    const empty = new AgentProcessTracker(watcher, async () => []);
    empty.arm('s1', SHELL);
    await flush();
    expect(empty.statusFor('s1')).toBeUndefined();

    const failing = new AgentProcessTracker(watcher, async () => {
      throw new Error('tasklist timeout');
    });
    failing.arm('s2', SHELL);
    await flush();
    expect(failing.statusFor('s2')).toBeUndefined();
    expect(watcher.watches.size).toBe(0);
  });

  it('disarm clears state, and a disarm racing an in-flight arm wins', async () => {
    const watcher = makeWatcher();
    let release: (v: ProcessTreeEntry[]) => void = () => {};
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
