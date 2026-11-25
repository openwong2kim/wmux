/**
 * The native Linux process table answers what `ps` answers, for every column
 * the callers that moved off `ps` parse: pid, ppid, pgid, tpgid, the state
 * letter, lstart byte for byte, comm, and args in a UTF-8 locale. It also
 * checks the identity rows tree kills compare by start time.
 *
 * Linux only, with the built module (native-terminal-core.yml): procps 3.3 on
 * ubuntu-22.04 and procps 4 in an ubuntu:24.04 container.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { loadNativeTerminalCore } from '../../shared/nativeTerminalCore';
import { lstartOf, readLinuxProcessTable, type LinuxProcessRow } from '../nativeProcessTable';
import { listPosixIdentityRows, parsePsIdentityRows } from '../automation/verifiedTreeKill';
import { waitFor } from '../../test-utils/waitFor';

let available = false;
if (process.platform === 'linux') {
  try {
    loadNativeTerminalCore('process-table-linux-v1');
    available = true;
  } catch (error) {
    if (process.env.WMUX_REQUIRE_RUST_CORE === '1') throw error;
  }
}

// A UTF-8 codeset, as the daemon runs with: procps 4 in a non-UTF-8 locale
// prints a control character as '.', not '?'.
const UTF8 = { ...process.env, LC_ALL: 'C.UTF-8' };

function ps(args: string[]): string {
  return execFileSync('ps', args, { encoding: 'utf8', env: UTF8, maxBuffer: 64 * 1024 * 1024 });
}

type PsRow = { pid: number; ppid: number; pgid: number; tpgid: number; stat: string; lstart: string; comm: string; args: string };

/** Three `ps` reads joined by pid: the fixed columns, comm, and args (each may hold spaces, so each has its own read). */
function psTable(): Map<number, PsRow> {
  const rows = new Map<number, PsRow>();
  for (const line of ps(['-axo', 'pid=,ppid=,pgid=,tpgid=,stat=,lstart=']).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})$/.exec(line);
    if (m) rows.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), tpgid: Number(m[4]), stat: m[5], lstart: m[6], comm: '', args: '' });
  }
  for (const line of ps(['-ww', '-axo', 'pid=,comm=']).split('\n')) {
    const m = /^\s*(\d+) (.*)$/.exec(line);
    const row = m && rows.get(Number(m[1]));
    // ps names a zombie "<comm> <defunct>": that suffix is its presentation, read off.
    if (row) row.comm = row.stat.startsWith('Z') ? m[2].replace(/ <defunct>$/, '') : m[2];
  }
  for (const line of ps(['-ww', '-axo', 'pid=,args=']).split('\n')) {
    const m = /^\s*(\d+) (.*)$/.exec(line);
    const row = m && rows.get(Number(m[1]));
    if (row) row.args = m[2];
  }
  return rows;
}

const btime = (): string | undefined => /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1];

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

describe.runIf(available)('the native Linux process table matches ps', () => {
  it('every column, row for row, for every process that held still across the ps reads', async () => {
    // Arguments with spaces, a newline, a tab and an escape; argv[0] with a byte that is no UTF-8.
    const odd = child(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)', 'an argument with spaces', 'line\nbreak', 'tab\there', 'esc\x1bhere']);
    const raw = child('bash', ['-c', "exec -a $'raw\\xffbyte' sleep 60"]);
    const stopped = child('sleep', ['60']);
    process.kill(stopped.pid as number, 'SIGSTOP');
    // A zombie: the shell's child exits and the shell, exec'd into sleep, never reaps it.
    const parent = child('sh', ['-c', 'sh -c "exit 0" & exec sleep 60']);
    let zombie = 0;
    await waitFor(() => {
      const kids = ps(['-o', 'pid=,stat=', '--ppid', String(parent.pid)]);
      zombie = Number(/^\s*(\d+)\s+Z/m.exec(kids)?.[1] ?? 0);
      return zombie > 0
        && ps(['-o', 'stat=', '-p', String(stopped.pid)]).trim().startsWith('T')
        && ps(['-o', 'args=', '-p', String(raw.pid)]).includes('raw')
        && ps(['-o', 'args=', '-p', String(odd.pid)]).includes('an argument with spaces');
    }, 10_000, 'the children');

    const bootBefore = btime();
    const before = new Map((await readLinuxProcessTable(true))?.map((r) => [r.pid, r]));
    const fromPs = psTable();
    const after = new Map((await readLinuxProcessTable(true))?.map((r) => [r.pid, r]));
    // lima slews the boot time with its clock: lstart then moves in both readers.
    const sameBoot = bootBefore === btime();
    expect(before.size).toBeGreaterThan(0);

    let compared = 0;
    for (const [pid, row] of fromPs) {
      const a = before.get(pid);
      // Only rows that did not change across the ps reads (ps itself, a process
      // that exec'd), and no kernel thread: a kworker renames itself as it works.
      if (!a || JSON.stringify(a) !== JSON.stringify(after.get(pid)) || pid === 2 || row.ppid === 2) continue;
      // The state of a busy process can change between reads, so it is
      // compared below, on the children that hold theirs still.
      const columns = (r: PsRow | LinuxProcessRow, lstart: string | undefined) =>
        ({ pid: r.pid, ppid: r.ppid, pgid: r.pgid, tpgid: r.tpgid, lstart, comm: r.comm, args: r.args });
      expect(columns(a, sameBoot ? lstartOf(a) : row.lstart)).toEqual(columns(row, row.lstart));
      compared++;
    }
    expect(compared).toBeGreaterThan(2); // a container sees only its own few
    for (const pid of [odd.pid, raw.pid, stopped.pid, zombie]) {
      expect(before.get(pid as number)?.state, `pid ${pid}`).toBe(fromPs.get(pid as number)?.stat[0]);
    }
    expect(before.get(raw.pid as number)?.args).toBe('raw?byte 60');
    expect(before.get(stopped.pid as number)?.state).toBe('T');
    expect(before.get(zombie)?.args).toBe('[sh] <defunct>');
  });

  it('a thread id is no row, as it is no process for ps', async () => {
    const tid = fs.readdirSync('/proc/self/task').map(Number).find((t) => t !== process.pid);
    expect(tid, 'node runs more than one thread').toBeDefined();
    const rows = await readLinuxProcessTable(false);
    expect(rows?.some((r) => r.pid === process.pid)).toBe(true);
    expect(rows?.some((r) => r.pid === tid)).toBe(false);
    expect(psTable().has(tid as number)).toBe(false);
  });

  it('gives tree kills the identity rows ps gave them: the same start text for the same pid', async () => {
    const sleeper = child('sleep', ['60']);
    await waitFor(() => fs.existsSync(`/proc/${sleeper.pid}`), 10_000, 'the child');
    const bootBefore = btime();
    const native = new Map((await listPosixIdentityRows()).map((r) => [r.pid, r]));
    const fromPs = parsePsIdentityRows(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    if (bootBefore !== btime()) return; // a slewed clock moves lstart in both; nothing to compare
    let compared = 0;
    for (const row of fromPs) {
      const n = native.get(row.pid);
      if (!n || row.pid === 2 || row.ppid === 2) continue;
      expect([n.pid, n.ppid, n.start]).toEqual([row.pid, row.ppid, row.start]);
      compared++;
    }
    expect(native.has(sleeper.pid as number)).toBe(true);
    expect(compared).toBeGreaterThan(2);
  });
});
