// The Windows stop's sweep: the tree is checked against a fresh read before
// any signal, and a child started after the tree was read is ended only when
// it is provably the tree's; a ppid that names an earlier or later holder of
// the pid is never acted on.
import { describe, expect, it, vi } from 'vitest';
import type { ProcessTreeEntry } from '../AgentProcessTracker';
import { stopAgentTree } from '../agentStop';
import { confirmTree, createOrphanSweep, planOrphanSweep, type SweepParent } from '../winProcessSweep';

const proc = (pid: number, ppid: number, name: string, cmdline: string | undefined, created: number | undefined): ProcessTreeEntry =>
  ({ pid, ppid, name, ...(cmdline !== undefined ? { cmdline } : {}), ...(created !== undefined ? { created } : {}) });

/** The tree as the tracker read it: the root started at 1000, its MCP server at 1100. */
const ROOT = proc(100, 10, 'claude.exe', 'claude.exe --resume x', 1000);
const MCP = proc(101, 100, 'node.exe', 'node github-mcp-server', 1100);
const TREE = { root: ROOT, descendants: [MCP], uncertain: [] };
/** When the stop knew each tree process gone (right after its signal). */
const GONE = new Map([[100, 5_000], [101, 5_000]]);

/** A sweep whose reads return `tables` in turn (the arm's first), and the pids it killed. */
function sweep(tables: ProcessTreeEntry[][], now = 5_000) {
  const read = vi.fn(async () => {
    const next = tables.shift();
    if (!next) throw new Error('no more reads');
    return next;
  });
  const killed: number[] = [];
  const s = createOrphanSweep({ read, kill: (pid) => { killed.push(pid); }, now: () => now, sleep: async () => undefined });
  return { s, killed, read };
}

describe('confirmTree', () => {
  it('confirms a process only as the same pid, image, readable command line and start time', () => {
    expect(confirmTree(TREE, [ROOT, MCP])).toEqual({ kill: [MCP], unsure: [] });
    // A descendant shown otherwise (another start time, unreadable argv, gone) is not signalled.
    expect(confirmTree(TREE, [ROOT, { ...MCP, created: 4_000 }])).toEqual({ kill: [], unsure: [MCP] });
    const unreadable = proc(102, 100, 'node.exe', undefined, 1200);
    expect(confirmTree({ root: ROOT, descendants: [unreadable] }, [ROOT, unreadable])).toEqual({ kill: [], unsure: [unreadable] });
    expect(confirmTree(TREE, [ROOT])).toEqual({ kill: [], unsure: [MCP] });
  });

  it('is null when the root is not shown as the same process', () => {
    expect(confirmTree(TREE, [MCP])).toBeNull();
    expect(confirmTree(TREE, [{ ...ROOT, cmdline: 'claude.exe --other' }, MCP])).toBeNull();
    expect(confirmTree(TREE, [{ ...ROOT, created: 2_000 }, MCP])).toBeNull();
    const undatedRoot = proc(100, 10, 'claude.exe', 'claude.exe --resume x', undefined);
    expect(confirmTree({ root: undatedRoot, descendants: [] }, [undatedRoot])).toBeNull();
  });
});

describe('planOrphanSweep', () => {
  const parents = new Map<number, SweepParent>([[100, { created: 1000, goneByMs: 5_000 }]]);
  const images = new Set(['claude.exe', 'node.exe']);

  it('a process started before its parent names an earlier holder of the pid: neither ended nor in the way', () => {
    expect(planOrphanSweep(parents, [proc(500, 100, 'node.exe', 'node server.js', 900)], images)).toEqual({ kill: [], left: [] });
  });

  it('a child started while the parent ran, reading as the tree’s, is ended', () => {
    const node = proc(501, 100, 'node.exe', 'node server.js', 1500);
    const mcp = proc(502, 100, 'uvx.exe', 'uvx some-mcp', 1600);
    expect(planOrphanSweep(parents, [node, mcp], images)).toEqual({ kill: [node, mcp], left: [] });
  });

  it('a child that cannot be read, cannot be dated, ties its parent’s start or is another program is left, and fails the stop', () => {
    const unreadable = proc(504, 100, 'node.exe', undefined, 1500);
    const undated = proc(505, 100, 'node.exe', 'node server.js', undefined);
    const other = proc(506, 100, 'notepad.exe', 'notepad.exe notes.txt', 1500);
    const tie = proc(503, 100, 'claude.exe', 'claude.exe', 1000);
    expect(planOrphanSweep(parents, [unreadable, undated, other, tie], images)).toEqual({ kill: [], left: [unreadable, undated, other, tie] });
    // The parent's own start time unknown: nothing can be shown to be its child.
    const undatedParent = new Map<number, SweepParent>([[100, { created: undefined, goneByMs: 5_000 }]]);
    const node = proc(501, 100, 'node.exe', 'node server.js', 1500);
    expect(planOrphanSweep(undatedParent, [node], images)).toEqual({ kill: [], left: [node] });
  });

  it('a tie with the pid’s new holder is not ours; a tie with the parent’s end, with no holder, is', () => {
    const reuser = proc(100, 4, 'svchost.exe', 'svchost.exe -k x', 3_000);
    expect(planOrphanSweep(parents, [reuser, proc(510, 100, 'node.exe', 'node server.js', 3_000)], images)).toEqual({ kill: [], left: [] });
    const atEnd = proc(511, 100, 'node.exe', 'node server.js', 5_000);
    expect(planOrphanSweep(parents, [atEnd], images)).toEqual({ kill: [atEnd], left: [] });
  });

  it('a process started once the parent was gone is another process’s child', () => {
    expect(planOrphanSweep(parents, [proc(507, 100, 'node.exe', 'node server.js', 6_000)], images)).toEqual({ kill: [], left: [] });
    // The parent's pid went to a newer process: its children are not the parent's.
    const reuser = proc(100, 4, 'svchost.exe', 'svchost.exe -k x', 3_000);
    const reusersChild = proc(508, 100, 'node.exe', 'node server.js', 3_500);
    const orphan = proc(509, 100, 'node.exe', 'node server.js', 2_000);
    expect(planOrphanSweep(parents, [reuser, reusersChild, orphan], images)).toEqual({ kill: [orphan], left: [] });
    // A process on the parent's pid that cannot be dated after it: nothing on that pid is decided.
    const undatedReuser = proc(100, 4, 'svchost.exe', 'svchost.exe -k x', undefined);
    expect(planOrphanSweep(parents, [undatedReuser, orphan], images)).toEqual({ kill: [], left: [orphan] });
  });

  it('is pure: the same input gives the same plan and is not changed', () => {
    const table = [proc(501, 100, 'node.exe', 'node server.js', 1500)];
    const copy = JSON.parse(JSON.stringify(table));
    expect(planOrphanSweep(parents, table, images)).toEqual(planOrphanSweep(parents, table, images));
    expect(table).toEqual(copy);
  });
});

describe('createOrphanSweep', () => {
  it('arms only on a read that shows the same root; otherwise nothing may be signalled', async () => {
    expect(await sweep([]).s.arm(TREE)).toBeNull();
    expect(await sweep([[{ ...ROOT, cmdline: 'claude.exe --other' }, MCP]]).s.arm(TREE)).toBeNull();
    expect(await sweep([[ROOT, MCP]]).s.arm(TREE)).toEqual({ kill: [MCP], unsure: [] });
  });

  it('a stale-ppid process started before the tree is never killed and does not fail the stop', async () => {
    const stale = proc(500, 100, 'node.exe', 'node server.js', 900);
    const { s, killed } = sweep([[ROOT, MCP, stale], [stale]]);
    await s.arm(TREE);
    expect(await s.run(GONE)).toBe('clean');
    expect(killed).toEqual([]);
  });

  it('ends a late MCP child and then its own child, each checked again right before its kill', async () => {
    const late = proc(501, 101, 'node.exe', 'node mcp-server.js', 1500);
    const grandchild = proc(502, 501, 'node.exe', 'node worker.js', 1600);
    const { s, killed, read } = sweep([
      [ROOT, MCP],
      [late, grandchild], // round 1: only the late child's parent is known dead
      [late, grandchild], // the check before its kill
      [grandchild], // round 2: the late child is gone, its own child is an orphan now
      [grandchild],
      [], // round 3: clean
    ]);
    await s.arm(TREE);
    expect(await s.run(GONE)).toBe('clean');
    expect(killed).toEqual([501, 502]);
    expect(read).toHaveBeenCalledTimes(6);
  });

  it('a late child that cannot be read or dated is left running and fails the stop', async () => {
    for (const child of [proc(503, 100, 'node.exe', undefined, 1500), proc(504, 100, 'node.exe', 'node x.js', undefined)]) {
      const { s, killed } = sweep([[ROOT, MCP], [child]]);
      await s.arm(TREE);
      expect(await s.run(GONE)).toBe('left');
      expect(killed).toEqual([]);
    }
  });

  it('what a process the tree only may hold left behind is reported, never ended', async () => {
    // The MCP server and an uncertain one beside it are gone by the arm's read.
    const uncertain = proc(103, 100, 'node.exe', 'node tool.js', 1000);
    const late = proc(502, 101, 'node.exe', 'node server.js', 1500);
    const { s, killed } = sweep([[ROOT], [late]]);
    expect(await s.arm({ ...TREE, uncertain: [uncertain] })).toEqual({ kill: [], unsure: [MCP] });
    expect(await s.run(new Map([[100, 5_000], [101, 5_000], [103, 5_000]]))).toBe('left');
    expect(killed).toEqual([]);
  });

  it('does not arm while a descendant it cannot confirm, or an uncertain one, still runs', async () => {
    // Shown with another start time, or with no command line: alive, but not proven the same.
    expect(await sweep([[ROOT, { ...MCP, created: 4_000 }]]).s.arm(TREE)).toBeNull();
    expect(await sweep([[ROOT, { ...MCP, cmdline: undefined }]]).s.arm(TREE)).toBeNull();
    const uncertain = proc(103, 100, 'node.exe', 'node tool.js', 1000);
    expect(await sweep([[ROOT, MCP, uncertain]]).s.arm({ ...TREE, uncertain: [uncertain] })).toBeNull();
    // The same pid now names another program: that one is not ours, and ours is gone.
    expect(await sweep([[ROOT, MCP, { ...uncertain, name: 'svchost.exe' }]]).s.arm({ ...TREE, uncertain: [uncertain] })).toEqual({ kill: [MCP], unsure: [] });
  });

  it('a kill that throws is not proven, so the stop fails', async () => {
    const late = proc(501, 100, 'node.exe', 'node server.js', 1500);
    const tables = [[ROOT, MCP], [late], [late], []];
    const s = createOrphanSweep({
      read: async () => tables.shift() ?? [],
      kill: () => { throw new Error('access denied'); },
      now: () => 5_000,
      sleep: async () => undefined,
    });
    await s.arm(TREE);
    expect(await s.run(GONE)).toBe('left');
  });

  it('a pid that changed between the plan and the kill is not signalled', async () => {
    const late = proc(501, 100, 'node.exe', 'node server.js', 1500);
    const { s, killed } = sweep([[ROOT, MCP], [late], [{ ...late, cmdline: 'node other.js', created: 4_000 }]]);
    await s.arm(TREE);
    expect(await s.run(GONE)).toBe('left');
    expect(killed).toEqual([]);
  });

  it('a kill that did not take fails the stop', async () => {
    const late = proc(501, 100, 'node.exe', 'node server.js', 1500);
    const { s, killed } = sweep([[ROOT, MCP], [late], [late], [late]]);
    await s.arm(TREE);
    expect(await s.run(GONE)).toBe('left');
    expect(killed).toEqual([501]);
  });

  it('a swept orphan’s window ends right after its own kill', async () => {
    // Each read advances the clock 500 ms: the late child is killed right after
    // the read at t=6500, so its window ends at 6500 (not at the next read, 7000).
    for (const [startedAt, killedChild] of [[6_500, true], [6_600, false]] as const) {
      let t = 5_000;
      const late = proc(501, 100, 'node.exe', 'node mcp-server.js', 1500);
      const grandchild = proc(502, 501, 'node.exe', 'node worker.js', startedAt);
      const tables = [[ROOT, MCP], [late], [late], [grandchild], [grandchild], []];
      const killed: number[] = [];
      const s = createOrphanSweep({
        read: async () => { const next = tables.shift(); if (!next) throw new Error('no more reads'); t += 500; return next; },
        kill: (pid) => { killed.push(pid); },
        now: () => t,
        sleep: async () => undefined,
      });
      await s.arm(TREE);
      expect(await s.run(GONE)).toBe('clean');
      // Started by the kill: the tree's, ended. Started after it: another process's child, left alone.
      expect(killed).toEqual(killedChild ? [501, 502] : [501]);
    }
  });

  it('a tree parent’s window ends when the stop knew it gone, not when the sweep starts', async () => {
    const late = proc(501, 100, 'node.exe', 'node server.js', 4_000);
    const { s, killed } = sweep([[ROOT, MCP], [late]], 9_000);
    await s.arm(TREE);
    // Started after the root's signal (t=3000): not the root's child, though before the sweep (t=9000).
    expect(await s.run(new Map([[100, 3_000], [101, 3_000]]))).toBe('clean');
    expect(killed).toEqual([]);
  });
});

describe('stopAgentTree with the sweep', () => {
  it('signals nothing when the read before the first signal fails or shows another root', async () => {
    for (const read of [async (): Promise<ProcessTreeEntry[]> => { throw new Error('no table'); }, async () => [{ ...ROOT, cmdline: 'claude.exe --other' }]]) {
      const kill = vi.fn();
      const r = await stopAgentTree({
        tree: async () => TREE,
        stillRunning: async (es) => [...es],
        kill,
        sleep: async () => undefined,
        stillIdle: () => true,
        sweep: createOrphanSweep({ read, kill, sleep: async () => undefined }),
      });
      expect(r).toEqual({ ok: false, code: 'unverified' });
      expect(kill).not.toHaveBeenCalled();
    }
  });

  it('a stale-ppid process started before the agent is never signalled, and the stop succeeds', async () => {
    // The tracker's dated walk already left it out of the tree; the sweep sees its ppid too.
    const stale = proc(102, 100, 'node.exe', 'node unrelated.js', 500);
    const alive = new Set([100, 101, 102]);
    const killed: number[] = [];
    const kill = (pid: number) => { killed.push(pid); alive.delete(pid); };
    const table = () => [ROOT, MCP, stale].filter((e) => alive.has(e.pid));
    const r = await stopAgentTree({
      tree: async () => TREE,
      stillRunning: async (es) => es.filter((e) => alive.has(e.pid)),
      kill,
      sleep: async () => undefined,
      sweep: createOrphanSweep({ read: async () => table(), kill, now: () => 5_000, sleep: async () => undefined }),
    });
    expect(r).toEqual({ ok: true, stopped: true, pid: 100, killed: 2 });
    expect(killed).toEqual([100, 101]);
    expect(alive.has(102)).toBe(true);
  });

  it('a running descendant the read does not confirm refuses the stop before the root is touched', async () => {
    const kill = vi.fn();
    const stillIdle = vi.fn(() => true);
    const r = await stopAgentTree({
      tree: async () => TREE,
      stillRunning: async (es) => [...es],
      kill,
      sleep: async () => undefined,
      stillIdle,
      // The MCP server's start time cannot be read now.
      sweep: createOrphanSweep({ read: async () => [ROOT, { ...MCP, created: undefined }], kill, now: () => 5_000, sleep: async () => undefined }),
    });
    expect(r).toEqual({ ok: false, code: 'unverified' });
    expect(kill).not.toHaveBeenCalled();
    expect(stillIdle).not.toHaveBeenCalled();
  });

  it('a child the root starts while outliving its SIGTERM is in the sweep’s window', async () => {
    let t = 1_000;
    let rootReads = 0;
    const late = proc(501, 100, 'node.exe', 'node server.js', 1_150);
    const alive = new Set([100, 101]);
    const killed: string[] = [];
    const kill = (pid: number, sig: NodeJS.Signals | 'sweep') => {
      killed.push(`${sig} ${pid}`);
      if (sig !== 'SIGTERM') alive.delete(pid);
    };
    const table = () => [ROOT, MCP, late].filter((e) => alive.has(e.pid));
    const r = await stopAgentTree({
      tree: async () => TREE,
      stillRunning: async (es) => {
        t += 100;
        if (es.includes(ROOT)) {
          rootReads += 1;
          // Still alive at the first grace read (t=1100), it starts a child (t=1150), then exits.
          if (rootReads === 1) alive.add(501);
          if (rootReads === 2) alive.delete(100);
        }
        return es.filter((e) => alive.has(e.pid));
      },
      kill,
      sleep: async () => undefined,
      now: () => t,
      sweep: createOrphanSweep({ read: async () => table(), kill: (pid) => kill(pid, 'sweep'), now: () => t, sleep: async () => undefined }),
    });
    // Ended by the sweep, not passed over as started after the root was gone.
    expect(killed).toContain('sweep 501');
    expect(r).toEqual({ ok: true, stopped: true, pid: 100, killed: 2 });
  });
});
