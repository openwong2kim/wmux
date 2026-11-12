/**
 * An idle Linux daemon starts no process. The real daemon bundle runs in a
 * temp HOME with a few shell sessions; after they settle, every fork, vfork,
 * clone (not a thread) and execve of the daemon is counted for an idle window.
 *
 * strace -f, run through sudo because Yama's ptrace_scope=1 refuses to attach
 * to a process that is not the tracer's child, sees every process the daemon
 * starts, however short-lived. A /proc children poll would miss a `ps` that
 * exits between two polls.
 *
 * Linux CI only (native-terminal-core.yml, ubuntu leg): it needs the daemon
 * bundle (`npm run build:daemon`), strace and passwordless sudo, so it runs
 * only with WMUX_IDLE_FORK_TEST=1.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliberateSleep } from '../../test-utils/waitFor';

const REPO = path.resolve(__dirname, '../../..');
const BUNDLE = path.join(REPO, 'dist', 'daemon-bundle', 'index.js');
const IDLE_MS = Number(process.env.WMUX_IDLE_FORK_MS ?? 45_000);
const SESSIONS = 3;

const enabled = process.platform === 'linux' && process.env.WMUX_IDLE_FORK_TEST === '1';

/** Process creations in strace output: fork, vfork, execve, and clone/clone3 without CLONE_THREAD. */
function processStarts(trace: string): string[] {
  return trace.split('\n').filter((line) => {
    const call = line.replace(/^\d+\s+/, '');
    if (call.startsWith('<...')) return false; // the resumed half of a call already counted
    if (/^(fork|vfork|execve)\(/.test(call)) return true;
    return /^clone3?\(/.test(call) && !call.includes('CLONE_THREAD');
  });
}

class Control {
  private buf = '';
  private readonly pending = new Map<string, (msg: { ok: boolean; result?: unknown; error?: string }) => void>();

  private constructor(private readonly socket: net.Socket, private readonly token: string) {
    socket.on('data', (chunk) => {
      this.buf += chunk.toString();
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as { id?: unknown; ok: boolean; result?: unknown; error?: string };
          if (typeof msg.id === 'string') this.pending.get(msg.id)?.(msg);
        } catch {
          // A broadcast frame or a partial line: not an answer.
        }
      }
    });
  }

  static async connect(pipe: string, token: string): Promise<Control> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(pipe);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    return new Control(socket, token);
  }

  rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 15_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error ?? `rpc failed: ${method}`));
      });
      this.socket.write(`${JSON.stringify({ id, method, params, token: this.token })}\n`);
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Every process `pid` starts while `during` runs, as strace lines. */
async function traceStarts(pid: number, during: () => Promise<void>): Promise<string[]> {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-idle-trace-')), 'trace.txt');
  const tracer = spawn('sudo', ['-n', 'strace', '-f', '-qq', '-e', 'trace=fork,vfork,clone,clone3,execve', '-p', String(pid), '-o', out], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  tracer.stderr?.on('data', (d) => (stderr += String(d)));
  // Attached once strace has created its output file.
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(out)) {
    if (Date.now() > deadline || tracer.exitCode !== null) throw new Error(`strace did not attach: ${stderr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  await deliberateSleep(500, 'strace attaches every thread after it opens its output file');
  await during();
  const exited = new Promise<void>((resolve) => tracer.once('exit', () => resolve()));
  spawnSync('sudo', ['-n', 'kill', '-INT', String(tracer.pid)]);
  await exited;
  return processStarts(fs.readFileSync(out, 'utf8'));
}

describe.runIf(enabled)('an idle Linux daemon starts no process', { timeout: IDLE_MS + 120_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-idle-forks-'));
  const suffix = `-idlefork-${process.pid}`;
  const dataDir = path.join(home, `.wmux${suffix}`);
  const pipe = path.join(home, 'daemon.sock');
  const token = randomUUID();
  let daemon: ChildProcess | undefined;
  let control: Control | undefined;

  beforeAll(async () => {
    expect(fs.existsSync(BUNDLE), `build the daemon first: ${BUNDLE}`).toBe(true);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(home, 'pane'));
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      version: 1,
      daemon: { pipeName: pipe, logLevel: 'info', autoStart: true },
      session: { defaultShell: '/bin/sh', defaultCols: 100, defaultRows: 30, bufferSizeMb: 8, bufferMaxMb: 64, deadSessionTtlHours: 24, deadSessionDumpBuffer: false },
    }));
    fs.writeFileSync(path.join(dataDir, 'daemon-auth-token'), token);
    fs.writeFileSync(path.join(dataDir, 'sessions.json'), JSON.stringify({ version: 1, sessions: [] }));
    daemon = spawn(process.execPath, [BUNDLE], {
      cwd: REPO,
      env: { ...process.env, HOME: home, WMUX_DATA_SUFFIX: suffix },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const hint = path.join(dataDir, 'daemon-pipe');
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(hint) || !fs.readFileSync(hint, 'utf8').trim()) {
      if (Date.now() > deadline) throw new Error('the daemon did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
    control = await Control.connect(fs.readFileSync(hint, 'utf8').trim(), token);
    for (let i = 0; i < SESSIONS; i++) {
      await control.rpc('daemon.createSession', { id: `idle-${i}`, cmd: '/bin/sh', cwd: path.join(home, 'pane'), cols: 100, rows: 30 });
    }
    await deliberateSleep(10_000, "the sessions' shells start and boot-time tasks finish before anything is counted");
  });

  afterAll(() => {
    control?.close();
    daemon?.kill('SIGTERM');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('the tracer sees the daemon start a session (control)', async () => {
    const starts = await traceStarts(daemon?.pid as number, async () => {
      await control?.rpc('daemon.createSession', { id: 'idle-control', cmd: '/bin/sh', cwd: path.join(home, 'pane'), cols: 100, rows: 30 });
      await deliberateSleep(2_000, 'the session spawn completes inside the trace');
    });
    expect(starts.length).toBeGreaterThan(0);
  });

  it(`starts nothing over ${IDLE_MS / 1000} s with ${SESSIONS} idle sessions`, async () => {
    await deliberateSleep(5_000, 'the control session settles before the idle window');
    const starts = await traceStarts(daemon?.pid as number, () => deliberateSleep(IDLE_MS, 'the idle window: nothing should start in it'));
    expect(starts).toEqual([]);
  });
});

describe('processStarts', () => {
  it('counts process creations and skips threads and resumed halves', () => {
    const trace = [
      '101 clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0x7f) = 120',
      '101 clone(child_stack=0x7f, flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM) = 121',
      '101 clone3({flags=CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD|CLONE_SYSVSEM, exit_signal=0}, 88) = 122',
      '102 clone3({flags=CLONE_VM|CLONE_VFORK, exit_signal=SIGCHLD, stack=0x7f}, 88 <unfinished ...>',
      '102 <... clone3 resumed>) = 123',
      '123 execve("/usr/bin/ps", ["ps", "-o", "stat=", "-p", "5"], 0x7ffd /* 20 vars */) = 0',
      '103 vfork() = 124',
      '104 read(3, "", 4096) = 0',
    ].join('\n');
    expect(processStarts(trace).map((l) => l.split(' ')[1].split('(')[0])).toEqual(['clone', 'clone3', 'execve', 'vfork']);
  });
});
