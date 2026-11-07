// @vitest-environment node
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RunnerProcess } from '../RunnerProcess';

// A stand-in for the helper's runner mode, speaking its protocol: every
// request starts a real child, which stays in the runner's process group, as
// in Runner.swift. Only the runner kills a child (by its pid, on a cancel).
//   ["echo", …]  answers at once with the argv as stdout
//   ["hang"]     starts a child that never ends
//   ["slow", ms] answers after ms
//   ["fail"]     answers with a runner error
const FAKE_RUNNER = String.raw`
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const kids = new Map();
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
send({ runner: 1, ready: true });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.cancel !== undefined) { const k = kids.get(m.cancel); if (k) { kids.delete(m.cancel); try { k.kill('SIGKILL'); } catch {} send({ id: m.cancel, ok: false, error: { code: 'aborted', message: 'the run was stopped' } }); } return; }
  const [cmd, arg] = m.argv;
  if (cmd === 'fail') return send({ id: m.id, ok: false, error: { code: 'helper_unavailable', message: 'the desktop component is missing from this wmux build' } });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  kids.set(m.id, child);
  send({ id: m.id, event: 'started', pid: child.pid });
  const done = (reply) => { try { child.kill('SIGKILL'); } catch {} kids.delete(m.id); send(reply); };
  if (cmd === 'echo') done({ id: m.id, ok: true, exitCode: 0, stdout: JSON.stringify(m.argv), stderr: '' });
  if (cmd === 'slow') setTimeout(() => done({ id: m.id, ok: true, exitCode: 0, stdout: String(arg), stderr: '' }), Number(arg));
});
process.stdin.on('end', () => { try { process.kill(0, 'SIGKILL'); } catch {} process.exit(0); });
`;

let script = '';
const spawned: ChildProcessWithoutNullStreams[] = [];
const runners: RunnerProcess[] = [];

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
  script = path.join(dir, 'fake-runner.cjs');
  fs.writeFileSync(script, FAKE_RUNNER);
});

afterEach(() => {
  for (const r of runners.splice(0)) r.dispose();
  // The whole group, while the runner is unreaped: a failed test must not
  // leave a child behind.
  for (const c of spawned.splice(0)) {
    if (c.exitCode === null && c.signalCode === null && c.pid !== undefined) {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {
        c.kill('SIGKILL');
      }
    }
  }
});

function runner(opts: { graceMs?: number; cancelGraceMs?: number } = {}): RunnerProcess {
  const r = new RunnerProcess({
    command: process.execPath,
    spawn: (_cmd, args) => {
      // As RunnerProcess spawns the real runner: the leader of its own group.
      const child = spawn(process.execPath, [script, ...args], { stdio: 'pipe', detached: true });
      spawned.push(child);
      return child;
    },
    ...opts,
  });
  runners.push(r);
  return r;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The pid of the child a run started, read off the runner's `started` line. */
function startedPid(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = /"event":"started","pid":(\d+)/.exec(buf);
      if (m) {
        child.stdout.off('data', onData);
        resolve(Number(m[1]));
      }
    };
    child.stdout.on('data', onData);
  });
}

// The runner is the macOS helper's mode; process groups are POSIX.
describe.skipIf(process.platform === 'win32')('RunnerProcess', () => {
  it('runs a command and hands back what it printed', async () => {
    const r = runner();
    const result = await r.run(['echo', 'snapshot'], { home: '/tmp/ad', timeoutMs: 5000 });
    expect(result).toEqual({ exitCode: 0, stdout: '["echo","snapshot"]', stderr: '' });
  });

  it('runs several at once; a long one does not hold up a short one', async () => {
    const r = runner();
    const slow = r.run(['slow', '400'], { home: '/tmp/ad', timeoutMs: 5000 });
    const quick = await r.run(['echo', 'get'], { home: '/tmp/ad', timeoutMs: 5000 });
    expect(quick.stdout).toBe('["echo","get"]');
    expect((await slow).stdout).toBe('400');
    expect(spawned).toHaveLength(1);
  });

  it('a stop kills the running child and leaves the runner up for the next call', async () => {
    const r = runner();
    await r.run(['echo'], { home: '/tmp/ad', timeoutMs: 5000 });
    const pid = startedPid(spawned[0]);
    const hung = r.run(['hang'], { home: '/tmp/ad', timeoutMs: 30_000 });
    const child = await pid;
    expect(alive(child)).toBe(true);
    r.abort();
    await expect(hung).rejects.toMatchObject({ code: 'aborted' });
    await until(() => !alive(child));
    expect((await r.run(['echo', 'next'], { home: '/tmp/ad', timeoutMs: 5000 })).stdout).toBe('["echo","next"]');
    expect(spawned).toHaveLength(1);
  });

  it('a run past its time fails with timeout, its child is killed, and the runner stays up', async () => {
    const r = runner({ graceMs: 50 });
    await r.run(['echo'], { home: '/tmp/ad', timeoutMs: 5000 });
    const pid = startedPid(spawned[0]);
    const hung = r.run(['hang'], { home: '/tmp/ad', timeoutMs: 100 });
    const child = await pid;
    await expect(hung).rejects.toMatchObject({ code: 'timeout' });
    await until(() => !alive(child));
    expect((await r.run(['echo', 'after'], { home: '/tmp/ad', timeoutMs: 5000 })).stdout).toBe('["echo","after"]');
    expect(spawned).toHaveLength(1);
  });

  it('never kills a child itself: an unresponsive runner is ended with its group, and nothing is left', async () => {
    const r = runner({ cancelGraceMs: 300 });
    await r.run(['echo'], { home: '/tmp/ad', timeoutMs: 5000 });
    const runnerPid = spawned[0].pid as number;
    const pid = startedPid(spawned[0]);
    const hung = r.run(['hang'], { home: '/tmp/ad', timeoutMs: 30_000 });
    const child = await pid;
    // The child is in the runner's group, which the runner leads.
    expect(Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(child)]).toString().trim())).toBe(runnerPid);
    process.kill(runnerPid, 'SIGSTOP');
    r.abort();
    await expect(hung).rejects.toMatchObject({ code: 'aborted' });
    // The stopped runner cannot kill its child; main ends the runner's group.
    await until(() => !alive(child) && spawned[0].signalCode === 'SIGKILL', 5000);
    expect(alive(runnerPid)).toBe(false);
  });

  it('passes the runner\'s own refusal through with its code', async () => {
    const r = runner();
    await expect(r.run(['fail'], { home: '/tmp/ad', timeoutMs: 5000 })).rejects.toMatchObject({ code: 'helper_unavailable' });
  });

  it('dispose ends the runner, which takes its children with it', async () => {
    const r = runner();
    await r.run(['echo'], { home: '/tmp/ad', timeoutMs: 5000 });
    const pid = startedPid(spawned[0]);
    const hung = r.run(['hang'], { home: '/tmp/ad', timeoutMs: 30_000 });
    const child = await pid;
    r.dispose();
    await expect(hung).rejects.toMatchObject({ code: 'aborted' });
    await until(() => !alive(child) && (spawned[0].exitCode !== null || spawned[0].signalCode !== null));
    await expect(r.run(['echo'], { home: '/tmp/ad', timeoutMs: 5000 })).rejects.toMatchObject({ code: 'shutting_down' });
  });

  it('does not start a runner that fails its check', async () => {
    const r = new RunnerProcess({
      command: process.execPath,
      verify: async () => {
        throw new Error('signature');
      },
      spawn: () => {
        throw new Error('must not spawn');
      },
    });
    runners.push(r);
    await expect(r.run(['echo'], { home: '/tmp/ad', timeoutMs: 5000 })).rejects.toThrow('signature');
  });
});
