/**
 * The process a `browser_repl` runtime runs in.
 *
 * A child Node process (the one repl_run uses, ReplSession.ts) whose main
 * thread only relays: it starts the runtime's worker thread
 * (workerSource.ts, unchanged) and passes messages between that worker and
 * the parent. Snippets therefore run in a process of their own, never in the
 * MCP server's: whatever they reach inside their process (its main thread,
 * its memory) is the runner's, not the server's. Browser calls still travel
 * as messages to the parent, which runs them through the session's bridge;
 * the runner is handed neither the auth token nor any WMUX_* variable. (It
 * runs as the same user, so this is no boundary on what that user can read.)
 *
 * The messages travel as JSON lines over two pipes of their own (fd 3 to the
 * runner, fd 4 back), not over Node's IPC channel: a snippet can write to any
 * fd of its process, and Node's channel takes what arrives on it as its own
 * framing, so a malformed frame there would throw in the MCP server. Here a
 * line that does not parse is dropped, and an oversized one ends the runner.
 * What the runner sends is the session's own data either way: a snippet can
 * forge any message for its own session (each browser call is still checked
 * against the run in flight).
 *
 * `RunnerProcess` gives BrowserReplSession the part of the Worker interface it
 * uses: `postMessage`, `terminate`, and the `message`, `error` and `exit`
 * events.
 *
 * Teardown (the runner and every process it started):
 * - `terminate()` (a timeout, `dispose`, the idle sweep) kills the runner's
 *   whole tree: descendants found by walking the process table (sessions of
 *   their own included), then its process group on macOS and Linux;
 *   `taskkill /T` on Windows (treeKill.ts).
 * - When the parent dies, the runner's fd 3 reaches end of input and the
 *   relay ends its own tree the same way. Snippets run on the worker, not the
 *   relay's thread, so a busy snippet does not keep it from noticing. Code
 *   that sets out to outlive the runner (by evaluating on the relay's thread
 *   through the inspector, or by leaving the process tree) is not stopped:
 *   it runs as the same user. On Windows the runner is also in a kill-on-close
 *   job the MCP server holds (paneJob.ts), which ends what is left in it when
 *   the server dies.
 * - A runtime that ends on its own (the worker exits) reports its code, and
 *   the relay ends its tree too.
 */
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { Readable, Writable } from 'stream';
import { createPaneJob, type PaneJob } from '../../daemon/paneJob';
import { killProcessTree } from '../../daemon/automation/treeKill';
import { buildReplChildEnv, resolveNodeBinary } from '../repl/ReplSession';
import { evalBootstrap } from '../repl/replRunnerSource';
import { BROWSER_REPL_WORKER_SOURCE } from './workerSource';

/** Live runner processes in this MCP server, across every connection. */
export const MAX_BROWSER_REPL_RUNNERS = 16;
/** The longest line the runner may send; a longer one ends it. */
export const MAX_RUNNER_LINE_BYTES = 16 * 1024 * 1024;
let runnerCap = MAX_BROWSER_REPL_RUNNERS;
let liveRunners = 0;

/** Test seam: the cap on live runners. */
export function setBrowserReplRunnerCapForTest(cap: number | null): void {
  runnerCap = cap ?? MAX_BROWSER_REPL_RUNNERS;
}

/** Windows: the job runners join, so they end with this process. */
let runnerJob: PaneJob | null | undefined;
function job(): PaneJob | null {
  if (runnerJob === undefined) {
    runnerJob = process.platform === 'win32'
      ? createPaneJob({ log: (level, message) => { if (level === 'warn') console.error(message); } })
      : null;
  }
  return runnerJob;
}

/**
 * The relay, in the child's main thread. Worker messages go up as
 * `{"w":…}` lines, the relay's own reports as `{"c":…}`.
 */
let relayBootstrap: string | null = null;
function relayArg(): string {
  relayBootstrap ??= evalBootstrap(String.raw`
'use strict';
const net = require('net');
const path = require('path');
const { Worker } = require('worker_threads');
const { execFileSync, spawnSync } = require('child_process');
const WORKER_SOURCE = ` + JSON.stringify(BROWSER_REPL_WORKER_SOURCE) + String.raw`;

// End this runner and every process it started: descendants found in the
// process table (sessions of their own included), leaves first, then its
// process group. Windows: taskkill /T (the parent's job is the backstop).
function endTree() {
  try {
    if (process.platform === 'win32') {
      const taskkill = path.win32.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');
      spawnSync(taskkill, ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      let rows = [];
      try {
        rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 })
          .split('\n')
          .map((line) => line.split(' ').filter(Boolean).map(Number))
          .filter((row) => row.length === 2 && row.every(Number.isInteger));
      } catch (_) { /* the group kill below still runs */ }
      const found = [process.pid];
      for (let changed = true; changed;) {
        changed = false;
        for (const [pid, ppid] of rows) {
          if (pid > 1 && found.includes(ppid) && !found.includes(pid)) { found.push(pid); changed = true; }
        }
      }
      for (const pid of found.slice(1).reverse()) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ } }
      try { process.kill(-process.pid, 'SIGKILL'); } catch (_) { /* gone */ }
    }
  } catch (_) { /* already going */ }
  process.exit(0);
}

const down = new net.Socket({ fd: 3, readable: true, writable: false });
const up = new net.Socket({ fd: 4, readable: false, writable: true });
up.on('error', () => endTree());
const send = (message, done) => {
  let line;
  try { line = JSON.stringify(message) + '\n'; } catch (_) { return false; }
  up.write(line, done);
  return true;
};

const worker = new Worker(WORKER_SOURCE, { eval: true, stdout: true, stderr: true });
worker.stdout.resume();
worker.stderr.resume();
worker.on('message', (message) => {
  if (send({ w: message })) return;
  // A call whose arguments cannot travel gets its answer here, or it would wait forever.
  if (message && message.type === 'call') {
    worker.postMessage({ type: 'callResult', callId: message.callId, ok: false, error: 'browser.' + message.name + '(args): the arguments cannot be sent' });
  }
});
// An Error travels as its message; any other thrown value as it is, or as text.
worker.on('error', (error) => {
  const value = error instanceof Error ? { message: error.message } : error;
  if (!send({ c: 'error', error: value })) {
    let text;
    try { text = String(value); } catch (_) { text = 'unprintable worker error'; }
    send({ c: 'error', error: text });
  }
});
// The worker ended on its own: report its code, then end what it started too.
worker.on('exit', (code) => {
  if (!send({ c: 'exit', code }, () => endTree())) endTree();
});

// The parent is gone when fd 3 ends.
let buffered = '';
down.setEncoding('utf8');
down.on('data', (chunk) => {
  buffered += chunk;
  let nl;
  while ((nl = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    let message;
    try { message = JSON.parse(line); } catch (_) { continue; }
    worker.postMessage(message);
  }
});
down.on('end', endTree);
down.on('error', endTree);
`);
  return relayBootstrap;
}

/** Splits what the runner sends into JSON lines, dropping any that do not parse. */
export class RunnerLines {
  private partial = '';
  constructor(
    private readonly onMessage: (message: unknown) => void,
    private readonly onOversized: () => void,
    private readonly maxBytes = MAX_RUNNER_LINE_BYTES,
  ) {}

  push(chunk: string): void {
    let text = this.partial + chunk;
    let nl: number;
    while ((nl = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, nl);
      text = text.slice(nl + 1);
      if (Buffer.byteLength(line) > this.maxBytes) {
        this.partial = '';
        this.onOversized();
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.onMessage(message);
    }
    if (Buffer.byteLength(text) > this.maxBytes) {
      this.partial = '';
      this.onOversized();
      return;
    }
    this.partial = text;
  }
}

/** The environment a runner gets: repl_run's, without any WMUX_* variable. */
export function buildRunnerEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const { env } = buildReplChildEnv(base);
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('WMUX_')) delete env[key];
  }
  return env;
}

export class RunnerProcess extends EventEmitter {
  private readonly child: ChildProcess;
  private readonly toRunner: Writable;
  private readonly exited: Promise<number>;
  /** Holds a slot of the cap. */
  private holding = true;
  /** The OS has reported the runner's exit: its pid may name another process now. */
  private reaped = false;

  /** Throws when this server already runs its cap of runners. */
  constructor() {
    super();
    if (liveRunners >= runnerCap) {
      throw new Error(
        `this wmux MCP server is already running ${runnerCap} browser_repl runtimes across its connected agents, ` +
          'which is its limit. A runtime ends when its agent disconnects or after 15 minutes idle; try again later.',
      );
    }
    const { command, electronRunAsNode } = resolveNodeBinary();
    const env = buildRunnerEnv();
    if (electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    const spawnMark = job()?.spawnMark() ?? null;
    const child = spawn(command, ['-e', relayArg()], {
      // The worker ran in this process's working directory; the runner keeps it.
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group, so a kill takes what it started too.
      detached: process.platform !== 'win32',
    });
    this.child = child;
    liveRunners++;
    if (child.pid !== undefined) job()?.contain(child.pid, spawnMark);
    this.toRunner = child.stdio[3] as Writable;
    const fromRunner = child.stdio[4] as Readable;
    // A pipe that breaks when the runner goes is reported by 'close'.
    this.toRunner.on('error', () => undefined);
    fromRunner.on('error', () => undefined);

    let reported: number | null = null;
    const lines = new RunnerLines(
      (raw) => {
        const message = raw as { w?: unknown; c?: unknown; error?: unknown; code?: unknown } | null;
        if (!message || typeof message !== 'object') return;
        if ('w' in message) this.emit('message', message.w);
        else if (message.c === 'error') this.raise(message.error);
        else if (message.c === 'exit' && typeof message.code === 'number') reported = message.code;
      },
      () => {
        this.raise(new Error(`it sent a message over ${MAX_RUNNER_LINE_BYTES / (1024 * 1024)} MB`));
        void this.terminate();
      },
    );
    fromRunner.setEncoding('utf8');
    fromRunner.on('data', (chunk: string) => lines.push(chunk));

    child.once('exit', () => {
      this.reaped = true;
    });
    // 'close', not 'exit': it also comes after a failed spawn (which has no
    // 'exit'), and only once everything the runner sent has been read.
    this.exited = new Promise<number>((resolve) => {
      child.once('close', (code, signal) => {
        this.reaped = true;
        this.free();
        const exitCode = reported ?? (code !== null && code >= 0 ? code : signal || code !== null ? 1 : 0);
        resolve(exitCode);
        this.emit('exit', exitCode);
      });
    });
    child.on('error', (error) => {
      // A spawn that failed has no process to wait for: its slot is free now.
      if (child.pid === undefined) this.free();
      this.raise(error);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Give the runner's slot back, once. */
  private free(): void {
    if (!this.holding) return;
    this.holding = false;
    liveRunners--;
  }

  /** An `error` event, when anyone still listens (an unheard one would throw). */
  private raise(error: unknown): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  postMessage(message: unknown): void {
    let line: string;
    try {
      line = JSON.stringify(message) + '\n';
    } catch {
      return;
    }
    if (!this.toRunner.destroyed) this.toRunner.write(line);
  }

  /** Kill the runner and what it started; resolves with its exit code. */
  terminate(): Promise<number> {
    const pid = this.child.pid;
    if (pid !== undefined && !this.reaped) {
      void killProcessTree(pid).catch(() => undefined);
    }
    return this.exited;
  }
}
