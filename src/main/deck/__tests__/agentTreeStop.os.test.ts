// Stopping a My Hermes agent with what it started (POSIX): Hermes's own
// cleanup first, then the snapshot's survivors, and never a process outside
// the snapshot or one whose PID was reused.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseProcTable, stopAgentTree, treeOf, type ProcRow } from '../agentTreeStop';

const posix = process.platform !== 'win32';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A fake agent: starts a grandchild in a session of its own (as Hermes
 *  starts a tool command) and writes its PID to `pidFile`. */
function fakeAgent(dir: string, opts: { onSigint: 'cleanup' | 'ignore' | 'spawn'; grandchildIgnoresTerm: boolean }): { agent: ChildProcess; pidFile: string; latePidFile: string } {
  const pidFile = path.join(dir, 'grandchild.pid');
  const latePidFile = path.join(dir, 'late.pid');
  const grandchild = `${opts.grandchildIgnoresTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000);`;
  const script = path.join(dir, 'agent.js');
  fs.writeFileSync(script, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
${opts.onSigint === 'cleanup'
    ? "process.on('SIGINT', () => { try { process.kill(g.pid, 'SIGKILL'); } catch {} process.exit(0); });"
    : opts.onSigint === 'spawn'
      // A tool command started after the stop began, in a session of its own, ignoring SIGTERM.
      ? `process.on('SIGINT', () => { const l = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(latePidFile)}, String(l.pid)); });`
      : "process.on('SIGINT', () => {});"}
setInterval(() => {}, 1000);
`);
  const agent = spawn(process.execPath, [script], { stdio: 'ignore' });
  return { agent, pidFile, latePidFile };
}

const spawned: number[] = [];
afterEach(() => {
  // Whatever a failed test left behind (its own processes only).
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

describe.skipIf(!posix)('stopAgentTree (POSIX, real processes)', () => {
  async function start(opts: Parameters<typeof fakeAgent>[1]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tree-'));
    const { agent, pidFile, latePidFile } = fakeAgent(dir, opts);
    await vi.waitFor(() => expect(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0).toBe(true), { timeout: 10_000 });
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    spawned.push(agent.pid as number, grandchild);
    const sent: Array<[number, NodeJS.Signals]> = [];
    const signal = (pid: number, sig: NodeJS.Signals): void => {
      sent.push([pid, sig]);
      process.kill(pid, sig);
    };
    return { agent: agent.pid as number, grandchild, sent, signal, dir, latePidFile };
  }

  it('an agent that cleans up on SIGINT is sent SIGINT only, and its tool command goes with its cleanup', async () => {
    const t = await start({ onSigint: 'cleanup', grandchildIgnoresTerm: false });
    await stopAgentTree(t.agent, { signal: t.signal, interruptWaitMs: 5_000, termGraceMs: 500, pollMs: 50 });
    expect(t.sent).toEqual([[t.agent, 'SIGINT']]);
    await vi.waitFor(() => expect([alive(t.agent), alive(t.grandchild)]).toEqual([false, false]), { timeout: 5_000 });
    fs.rmSync(t.dir, { recursive: true, force: true });
  });

  it('an agent that ignores SIGINT, with a tool command in its own session that ignores SIGTERM: both are gone', async () => {
    const t = await start({ onSigint: 'ignore', grandchildIgnoresTerm: true });
    await stopAgentTree(t.agent, { signal: t.signal, interruptWaitMs: 300, termGraceMs: 300, pollMs: 50 });
    expect(t.sent[0]).toEqual([t.agent, 'SIGINT']);
    expect(t.sent).toContainEqual([t.grandchild, 'SIGTERM']);
    expect(t.sent).toContainEqual([t.grandchild, 'SIGKILL']);
    // Nothing outside the agent's tree was signalled.
    expect(new Set(t.sent.map(([pid]) => pid))).toEqual(new Set([t.agent, t.grandchild]));
    await vi.waitFor(() => expect([alive(t.agent), alive(t.grandchild)]).toEqual([false, false]), { timeout: 5_000 });
    fs.rmSync(t.dir, { recursive: true, force: true });
  });
});

describe.skipIf(!posix)('stopAgentTree (POSIX, a command started during the stop)', () => {
  it('a tool command the agent starts after SIGINT is followed and gone at the end', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tree-'));
    const { agent, pidFile, latePidFile } = fakeAgent(dir, { onSigint: 'spawn', grandchildIgnoresTerm: true });
    await vi.waitFor(() => expect(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0).toBe(true), { timeout: 10_000 });
    spawned.push(agent.pid as number, Number(fs.readFileSync(pidFile, 'utf8')));
    await stopAgentTree(agent.pid as number, { interruptWaitMs: 600, termGraceMs: 300, pollMs: 50 });
    const late = Number(fs.readFileSync(latePidFile, 'utf8'));
    spawned.push(late);
    await vi.waitFor(() => expect([alive(agent.pid as number), alive(late)]).toEqual([false, false]), { timeout: 5_000 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('stopAgentTree (the snapshot)', () => {
  const AGENT: ProcRow = { pid: 10, ppid: 1, start: 'Thu Oct 29 10:00:00 2026' };
  const TOOL: ProcRow = { pid: 11, ppid: 10, start: 'Thu Oct 29 10:00:01 2026' };

  it('a process table that fails once is read again: the survivors are still signalled', async () => {
    const reads: Array<ProcRow[] | null> = [[AGENT, TOOL], [AGENT, TOOL], null, [{ ...TOOL, ppid: 1 }]];
    const sent: Array<[number, NodeJS.Signals]> = [];
    await stopAgentTree(10, {
      table: async () => (reads.length > 1 ? reads.shift() as ProcRow[] | null : reads[0]),
      signal: (pid, sig) => { sent.push([pid, sig]); },
      interruptWaitMs: 30, termGraceMs: 30, pollMs: 10,
    });
    expect(sent).toContainEqual([11, 'SIGTERM']);
    expect(sent).toContainEqual([11, 'SIGKILL']);
  });

  it('a table that stays unreadable stops the agent alone, while it lives, and says so', async () => {
    let reads = 0;
    const sent: Array<[number, NodeJS.Signals]> = [];
    const lines: string[] = [];
    await stopAgentTree(10, {
      table: async () => (reads++ === 0 ? [AGENT, TOOL] : null),
      signal: (pid, sig) => { sent.push([pid, sig]); },
      alive: (pid) => pid === 10,
      log: (l) => lines.push(l),
      interruptWaitMs: 30, termGraceMs: 30, pollMs: 10,
    });
    expect(sent).toEqual([[10, 'SIGINT'], [10, 'SIGTERM'], [10, 'SIGKILL']]);
    expect(lines.join('\n')).toMatch(/could not be read.*only the agent/);
  });

  it('an agent PID not in the table (gone, or reused) is not signalled at all', async () => {
    const sent: Array<[number, NodeJS.Signals]> = [];
    await stopAgentTree(10, { table: async () => [{ ...TOOL, ppid: 1 }], signal: (pid, sig) => { sent.push([pid, sig]); }, pollMs: 10 });
    expect(sent).toEqual([]);
  });

  it('skips a PID whose start time changed (reused), and signals nothing outside the tree', async () => {
    const before: ProcRow[] = [
      { pid: 10, ppid: 1, start: 'Thu Oct 29 10:00:00 2026' },
      { pid: 11, ppid: 10, start: 'Thu Oct 29 10:00:01 2026' },
      { pid: 12, ppid: 1, start: 'Thu Oct 29 09:00:00 2026' },
    ];
    // The agent is gone; PID 11 now belongs to another process, and 12 was never in the tree.
    const after: ProcRow[] = [
      { pid: 11, ppid: 1, start: 'Thu Oct 29 10:00:05 2026' },
      { pid: 12, ppid: 1, start: 'Thu Oct 29 09:00:00 2026' },
    ];
    let reads = 0;
    const sent: Array<[number, NodeJS.Signals]> = [];
    await stopAgentTree(10, {
      table: async () => (reads++ === 0 ? before : after),
      signal: (pid, sig) => { sent.push([pid, sig]); },
      interruptWaitMs: 200, termGraceMs: 50, pollMs: 10,
    });
    expect(sent).toEqual([[10, 'SIGINT']]);
  });

  it('reads the table and its tree by parent PID', () => {
    const rows = parseProcTable('  10     1 Ss   Thu Oct 29 10:00:00 2026\n  11    10 S    Thu Oct 29 10:00:01 2026\n  13    11 Z+   Thu Oct 29 10:00:02 2026\n  12     1 R    Thu Oct 29 09:00:00 2026\n');
    expect(rows[1]).toEqual({ pid: 11, ppid: 10, start: 'Thu Oct 29 10:00:01 2026' });
    expect(rows[2].zombie).toBe(true);
    expect(treeOf(10, rows).map((r) => r.pid).sort()).toEqual([10, 11, 13]);
    expect(treeOf(99, rows)).toEqual([]);
  });
});
