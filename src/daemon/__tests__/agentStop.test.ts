// The stop of a pane's agent: SIGTERM, then a kill of whatever of its tree is
// still the same process after the grace; nothing outside that tree.
import { describe, expect, it, vi } from 'vitest';
import { paneTurnClosed, stopAgentTree } from '../agentStop';
import type { ProcessTreeEntry } from '../AgentProcessTracker';

const root: ProcessTreeEntry = { pid: 100, ppid: 10, name: 'claude' };
const mcp: ProcessTreeEntry = { pid: 101, ppid: 100, name: 'node' };

describe('stopAgentTree', () => {
  it('no agent: nothing is signalled', async () => {
    const kill = vi.fn();
    expect(await stopAgentTree({ tree: async () => null, stillRunning: async () => [], kill })).toEqual({ ok: true, stopped: false });
    expect(kill).not.toHaveBeenCalled();
  });

  it('asks the agent to exit and kills an MCP server it left behind', async () => {
    const alive = new Set([100, 101]);
    const kill = vi.fn((pid: number) => { if (pid === 100) alive.delete(100); else alive.delete(pid); });
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [mcp] }),
      stillRunning: async (es) => es.filter((e) => alive.has(e.pid)),
      kill,
      sleep: async () => undefined,
    });
    expect(kill.mock.calls).toEqual([[100, 'SIGTERM'], [101, 'SIGKILL']]);
    expect(r).toEqual({ ok: true, stopped: true, pid: 100, killed: 2 });
  });

  it('an agent that survives even the kill is reported, not hidden', async () => {
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [] }),
      stillRunning: async (es) => [...es],
      kill: () => undefined,
      sleep: async () => undefined,
      graceMs: 400,
    });
    expect(r).toEqual({ ok: false, code: 'still_running', pid: 100 });
  });
});

describe('a stop with an orphan sweep (Windows, fromTerminal)', () => {
  it('arms the sweep before the turn check and the first signal, and runs it once the tree is gone', async () => {
    const order: string[] = [];
    const alive = new Set([100, 101]);
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [mcp] }),
      stillRunning: async (es) => es.filter((e) => alive.has(e.pid)),
      kill: (pid, sig) => { order.push(`${sig} ${pid}`); alive.delete(pid); },
      sleep: async () => undefined,
      stillIdle: () => { order.push('stillIdle'); return true; },
      sweep: {
        arm: async (tree) => { order.push(`arm ${[tree.root, ...tree.descendants].map((e) => e.pid).join(',')}`); return { kill: tree.descendants, unsure: [] }; },
        run: async () => { order.push('run'); return 'clean'; },
      },
    });
    expect(order).toEqual(['arm 100,101', 'stillIdle', 'SIGTERM 100', 'SIGKILL 101', 'run']);
    expect(r).toEqual({ ok: true, stopped: true, pid: 100, killed: 2 });
  });

  it('a sweep that cannot confirm the tree stops nothing: no signal, no turn check', async () => {
    const kill = vi.fn();
    const stillIdle = vi.fn(() => true);
    const run = vi.fn(async () => 'clean' as const);
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [mcp] }),
      stillRunning: async (es) => [...es],
      kill,
      sleep: async () => undefined,
      stillIdle,
      sweep: { arm: async () => null, run },
    });
    expect(r).toEqual({ ok: false, code: 'unverified' });
    expect(kill).not.toHaveBeenCalled();
    expect(stillIdle).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('tells the sweep when each tree process was first seen gone', async () => {
    let t = 1_000;
    const alive = new Set([100, 101]);
    let goneBy: ReadonlyMap<number, number> | undefined;
    await stopAgentTree({
      tree: async () => ({ root, descendants: [mcp] }),
      stillRunning: async (es) => { t += 100; return es.filter((e) => alive.has(e.pid)); },
      kill: (pid) => { t += 10; alive.delete(pid); },
      sleep: async () => undefined,
      now: () => t,
      sweep: { arm: async (tree) => ({ kill: tree.descendants, unsure: [] }), run: async (g) => { goneBy = g; return 'clean'; } },
    });
    // SIGTERM 100 at 1010; the grace read at 1110 finds it gone; the tree read at 1210
    // finds 101 alive; SIGKILL 101 at 1220; the read at 1320 finds it gone.
    expect(goneBy).toEqual(new Map([[100, 1_110], [101, 1_320]]));
  });

  it('a root that outlives its SIGTERM is not gone until a read shows it gone', async () => {
    let t = 1_000;
    let rootReads = 0;
    const alive = new Set([100]);
    let goneBy: ReadonlyMap<number, number> | undefined;
    await stopAgentTree({
      tree: async () => ({ root, descendants: [] }),
      // The root survives the SIGTERM for two grace reads, then exits.
      stillRunning: async (es) => {
        t += 100;
        if (es.includes(root) && ++rootReads > 2) alive.delete(100);
        return es.filter((e) => alive.has(e.pid));
      },
      kill: () => { t += 10; },
      sleep: async () => undefined,
      now: () => t,
      sweep: { arm: async () => ({ kill: [], unsure: [] }), run: async (g) => { goneBy = g; return 'clean'; } },
    });
    // SIGTERM at 1010; grace reads at 1110 and 1210 still show it; the one at 1310 does not.
    expect(goneBy?.get(100)).toBe(1_310);
  });

  it('an orphan left running, or a sweep that fails, is not a stop', async () => {
    for (const run of [async () => 'left' as const, async (): Promise<'clean'> => { throw new Error('unreadable'); }]) {
      const r = await stopAgentTree({
        tree: async () => ({ root, descendants: [] }),
        stillRunning: async () => [],
        kill: () => undefined,
        sleep: async () => undefined,
        sweep: { arm: async () => ({ kill: [], unsure: [] }), run },
      });
      expect(r).toEqual({ ok: false, code: 'still_running', pid: 100 });
    }
  });

  // A descendant the sweep's fresh read no longer shows as the same process.
  const changed: ProcessTreeEntry = { pid: 102, ppid: 100, name: 'node' };

  it('signals only the descendants the sweep’s read confirms; one it does not, gone, does not fail the stop', async () => {
    const alive = new Set([100, 101]);
    const kill = vi.fn((pid: number) => { alive.delete(pid); });
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [mcp, changed] }),
      stillRunning: async (es) => es.filter((e) => alive.has(e.pid)),
      kill,
      sleep: async () => undefined,
      sweep: { arm: async () => ({ kill: [mcp], unsure: [changed] }), run: async () => 'clean' },
    });
    expect(kill.mock.calls).toEqual([[100, 'SIGTERM'], [101, 'SIGKILL']]);
    expect(r).toEqual({ ok: true, stopped: true, pid: 100, killed: 2 });
  });

  it('a descendant the sweep cannot confirm is never signalled; still running, it is not a stop', async () => {
    const alive = new Set([100, 101]);
    const kill = vi.fn((pid: number) => { alive.delete(pid); });
    const run = vi.fn(async () => 'clean' as const);
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [mcp] }),
      stillRunning: async (es) => es.filter((e) => alive.has(e.pid)),
      kill,
      sleep: async () => undefined,
      sweep: { arm: async () => ({ kill: [], unsure: [mcp] }), run },
    });
    expect(kill.mock.calls).toEqual([[100, 'SIGTERM']]);
    expect(r).toEqual({ ok: false, code: 'still_running', pid: 100 });
    expect(run).not.toHaveBeenCalled();
  });

  it('without a sweep every descendant of the tree read is killed, as before', async () => {
    const alive = new Set([100, 101, 102]);
    const kill = vi.fn((pid: number) => { alive.delete(pid); });
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [mcp, changed] }),
      stillRunning: async (es) => es.filter((e) => alive.has(e.pid)),
      kill,
      sleep: async () => undefined,
    });
    expect(kill.mock.calls).toEqual([[100, 'SIGTERM'], [101, 'SIGKILL'], [102, 'SIGKILL']]);
    expect(r).toEqual({ ok: true, stopped: true, pid: 100, killed: 3 });
  });

  it('a tree that survives is reported without a sweep', async () => {
    const run = vi.fn(async () => 'clean' as const);
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [] }),
      stillRunning: async (es) => [...es],
      kill: () => undefined,
      sleep: async () => undefined,
      graceMs: 400,
      sweep: { arm: async () => ({ kill: [], unsure: [] }), run },
    });
    expect(r).toEqual({ ok: false, code: 'still_running', pid: 100 });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('a conditional stop (main\'s idle stop of a reported worker)', () => {
  it('signals nothing when the turn opened by the time the tree is known', async () => {
    const kill = vi.fn();
    let open = false;
    const stillIdle = vi.fn(() => !open);
    const r = await stopAgentTree({
      tree: async () => {
        open = true; // a turn starts while the process table is read
        return { root, descendants: [mcp] };
      },
      stillRunning: async (es) => [...es],
      kill,
      sleep: async () => undefined,
      stillIdle,
    });
    expect(r).toEqual({ ok: false, code: 'turn_open' });
    expect(kill).not.toHaveBeenCalled();
    expect(stillIdle).toHaveBeenCalledTimes(1);
  });

  it('stops as usual while the turn stays over', async () => {
    const alive = new Set([100]);
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [] }),
      stillRunning: async (es) => es.filter((e) => alive.has(e.pid)),
      kill: (pid) => { alive.delete(pid); },
      sleep: async () => undefined,
      stillIdle: () => true,
    });
    expect(r).toEqual({ ok: true, stopped: true, pid: 100, killed: 1 });
  });

  it('paneTurnClosed: a turn known closed, not running, no prompt waiting', () => {
    expect(paneTurnClosed({ agentStatus: 'idle', turnOpen: false })).toBe(true);
    expect(paneTurnClosed({ agentStatus: 'complete', turnOpen: false })).toBe(true);
    expect(paneTurnClosed({ agentStatus: 'idle', turnOpen: true })).toBe(false);
    expect(paneTurnClosed({ agentStatus: 'running', turnOpen: false })).toBe(false);
    expect(paneTurnClosed({ agentStatus: 'awaiting_input', turnOpen: false })).toBe(false);
    expect(paneTurnClosed({ agentStatus: 'idle', turnOpen: undefined })).toBe(false);
  });
});

describe('stopAgentTree failures', () => {
  it('a captured process that survives its kill fails the stop even when the agent exited', async () => {
    const alive = new Set([100, 101]);
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [mcp] }),
      stillRunning: async (es) => es.filter((e) => alive.has(e.pid)),
      kill: (pid) => { if (pid === 100) alive.delete(100); else throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
      sleep: async () => undefined,
    });
    expect(r).toEqual({ ok: false, code: 'still_running', pid: 100 });
  });

  it('an uncertain process is never signalled, and one still running fails the stop', async () => {
    const unsure: ProcessTreeEntry = { pid: 102, ppid: 100, name: 'node' };
    const alive = new Set([100, 101, 102]);
    const kill = vi.fn((pid: number) => { alive.delete(pid); });
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [mcp], uncertain: [unsure] }),
      stillRunning: async (es) => es.filter((e) => alive.has(e.pid)),
      kill,
      sleep: async () => undefined,
    });
    expect(kill.mock.calls).toEqual([[100, 'SIGTERM'], [101, 'SIGKILL']]);
    expect(r).toEqual({ ok: false, code: 'still_running', pid: 100 });
  });

  it('an uncertain process gone by the final read does not hold the stop', async () => {
    const unsure: ProcessTreeEntry = { pid: 102, ppid: 100, name: 'node' };
    const alive = new Set([100]);
    const kill = vi.fn((pid: number) => { alive.delete(pid); });
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [], uncertain: [unsure] }),
      stillRunning: async (es) => es.filter((e) => alive.has(e.pid)),
      kill,
      sleep: async () => undefined,
    });
    expect(kill.mock.calls).toEqual([[100, 'SIGTERM']]);
    expect(r).toEqual({ ok: true, stopped: true, pid: 100, killed: 1 });
  });

  it('a tree process a later read cannot prove the same is never killed, and fails the stop while it runs', async () => {
    const alive = new Set([100, 101]);
    const kill = vi.fn((pid: number) => { alive.delete(pid); });
    const r = await stopAgentTree({
      tree: async () => ({ root, descendants: [mcp] }),
      stillRunning: async (es) => ({ same: [], unsure: es.filter((e) => alive.has(e.pid)) }),
      kill,
      sleep: async () => undefined,
    });
    expect(kill.mock.calls).toEqual([[100, 'SIGTERM']]);
    expect(r).toEqual({ ok: false, code: 'still_running', pid: 100 });
  });

  it('a process table that cannot be read fails the stop instead of reading as "nothing runs"', async () => {
    await expect(stopAgentTree({ tree: async () => { throw new Error('ps failed'); }, stillRunning: async () => [], kill: vi.fn() })).rejects.toThrow('ps failed');
  });
});
