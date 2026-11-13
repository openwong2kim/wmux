/**
 * The /proc readers answer what `ps` answers. Each Linux case asks both about
 * the same live processes and compares what the daemon keeps: the state
 * letter, the name, the lstart text byte for byte, the start time to etime's
 * second, and every row of the process table.
 *
 * Linux only (ubuntu leg of native-terminal-core.yml); elsewhere only the
 * formatting cases run.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { parsePsOutput } from '../AgentProcessTracker';
import { argsFromCmdline, formatLstart, procComm, procLstart, procStartMs, procState, procTable } from '../procfs';
import { parseEtime } from '../transcript/codexRolloutByCwd';
import { waitFor } from '../../test-utils/waitFor';

const linux = process.platform === 'linux';
const GONE = 4_194_303; // above any pid_max a runner uses

function ps(field: string, pid: number, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8', env }).trim();
}

const children: ChildProcess[] = [];
function child(cmd: string, args: string[]): ChildProcess {
  const c = spawn(cmd, args, { stdio: 'ignore' });
  children.push(c);
  return c;
}

afterAll(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
});

describe('formatting', () => {
  it('lstart is ctime(3) text: a space-padded day, no newline', () => {
    const at = new Date(2026, 10, 3, 7, 5, 9).getTime() / 1000;
    expect(formatLstart(at)).toBe('Tue Nov  3 07:05:09 2026');
    expect(formatLstart(at + 0.99)).toBe('Tue Nov  3 07:05:09 2026');
  });

  it('args joins argv with spaces, turns newlines into spaces and other control characters into ?, and names an empty one by comm', () => {
    expect(argsFromCmdline('node\0/opt/a b.js\0--x\0', 'node', 'S')).toBe('node /opt/a b.js --x');
    expect(argsFromCmdline('sh\0-c\0echo\nhi\0', 'sh', 'S')).toBe('sh -c echo hi');
    expect(argsFromCmdline('sh\0-c\0a\tb\x1bc\0', 'sh', 'S')).toBe('sh -c a?b?c');
    expect(argsFromCmdline('', 'kthreadd', 'S')).toBe('[kthreadd]');
    expect(argsFromCmdline('', 'sh', 'Z')).toBe('[sh] <defunct>');
  });

  it.skipIf(linux)('answers nothing off Linux, so the caller asks ps', async () => {
    expect(procState(process.pid)).toBeNull();
    expect(procComm(process.pid)).toBeNull();
    expect(procLstart(process.pid)).toBeNull();
    expect(procStartMs(process.pid)).toBeNull();
    await expect(procTable()).resolves.toBeNull();
  });
});

describe.runIf(linux)('/proc readers match ps', () => {
  it('state: running, stopped, zombie, gone', async () => {
    const stopped = child('sleep', ['60']);
    process.kill(stopped.pid as number, 'SIGSTOP');
    // A zombie: the shell's child exits and the shell, exec'd into sleep, never reaps it.
    const parent = child('sh', ['-c', 'sh -c "exit 0" & exec sleep 60']);
    let zombie = 0;
    await waitFor(() => {
      const kids = execFileSync('ps', ['-o', 'pid=,stat=', '--ppid', String(parent.pid)], { encoding: 'utf8' }).trim();
      const z = /^(\d+)\s+Z/m.exec(kids);
      if (z) zombie = Number(z[1]);
      return zombie > 0 && ps('stat', stopped.pid as number).startsWith('T');
    }, 10_000, 'a stopped and a zombie process');

    const sleeping = child('sleep', ['60']);
    await waitFor(() => ps('stat', sleeping.pid as number).startsWith('S'), 10_000, 'a sleeping process');
    // States that hold still while ps runs (this process is running as it reads itself, and sleeps while ps does).
    for (const pid of [sleeping.pid as number, stopped.pid as number, zombie]) {
      expect(procState(pid)).toEqual({ value: ps('stat', pid)[0] });
    }
    expect(procState(process.pid)?.value).toBe('R');
    expect(procState(stopped.pid as number)?.value).toBe('T');
    expect(procState(zombie)?.value).toBe('Z');
    expect(procState(GONE)).toEqual({ value: null });
  });

  it('a thread id is no process, as ps -p says', () => {
    const tid = fs.readdirSync('/proc/self/task').map(Number).find((t) => t !== process.pid);
    expect(tid, 'node runs more than one thread').toBeDefined();
    expect(() => ps('stat', tid as number)).toThrow();
    expect(procState(tid as number)).toEqual({ value: null });
    expect(procComm(tid as number)).toEqual({ value: null });
    expect(procLstart(tid as number)).toEqual({ value: null });
  });

  it('comm', () => {
    const sleeper = child('sleep', ['60']);
    for (const pid of [process.pid, 1, sleeper.pid as number]) {
      expect(procComm(pid)).toEqual({ value: ps('comm', pid) });
    }
    expect(procComm(GONE)).toEqual({ value: null });
  });

  it('lstart, byte for byte, in this time zone and another, whatever the locale', () => {
    const sleeper = child('sleep', ['60']);
    const pids = [process.pid, 1, sleeper.pid as number];
    for (const pid of pids) expect(procLstart(pid)).toEqual({ value: ps('lstart', pid) });
    expect(procLstart(GONE)).toEqual({ value: null });

    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Kolkata'; // a half-hour offset
    try {
      for (const pid of pids) expect(procLstart(pid)).toEqual({ value: ps('lstart', pid, { ...process.env, TZ: 'Asia/Kolkata' }) });
      // ps prints ctime(3): a locale does not change the text.
      for (const pid of pids) expect(procLstart(pid)).toEqual({ value: ps('lstart', pid, { ...process.env, TZ: 'Asia/Kolkata', LC_ALL: 'C.UTF-8', LANG: 'ko_KR.UTF-8' }) });
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('start time agrees with etime to its second', () => {
    const sleeper = child('sleep', ['60']);
    for (const pid of [process.pid, 1, sleeper.pid as number]) {
      const elapsed = parseEtime(ps('etime', pid)) as number;
      const fromPs = Date.now() - elapsed;
      const fromProc = procStartMs(pid)?.value as number;
      expect(Math.abs(fromProc - fromPs)).toBeLessThanOrEqual(2_000);
    }
    expect(procStartMs(GONE)).toEqual({ value: null });
  });

  it('the process table is ps -ww -axo pid=,ppid=,args=, row for row', async () => {
    // Spaces, a newline, a tab and an escape inside arguments.
    const spaced = child(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)', 'an argument with spaces', 'line\nbreak', 'tab\there', 'esc\x1bhere']);
    await waitFor(() => ps('args', spaced.pid as number).includes('an argument with spaces'), 10_000, 'the child');
    const asRows = (rows: Awaited<ReturnType<typeof procTable>>) => parsePsOutput((rows ?? []).map((r) => `${r.pid} ${r.ppid} ${r.args}`).join('\n'));
    const before = new Map(asRows(await procTable()).map((e) => [e.pid, e]));
    // A UTF-8 codeset, as a daemon runs with: procps 4 in a non-UTF-8 locale prints a control character as '.', not '?'.
    const env = { ...process.env, LC_ALL: 'C.UTF-8' };
    const fromPs = parsePsOutput(execFileSync('ps', ['-ww', '-axo', 'pid=,ppid=,args='], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 }));
    const after = new Map(asRows(await procTable()).map((e) => [e.pid, e]));
    // Only rows that did not change across the ps run (ps itself, a process
    // that exec'd), and no kernel thread: a kworker renames itself as it works.
    let compared = 0;
    for (const row of fromPs) {
      const a = before.get(row.pid);
      if (!a || JSON.stringify(a) !== JSON.stringify(after.get(row.pid)) || row.pid === 2 || row.ppid === 2) continue;
      expect(a).toEqual(row);
      compared++;
    }
    expect(compared).toBeGreaterThan(2); // a container sees only its own few
    expect([...before.values()].some((e) => e.cmdline?.includes('an argument with spaces'))).toBe(true);
  });
});
