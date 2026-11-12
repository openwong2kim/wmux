/**
 * The process a `browser_repl` runtime runs in.
 *
 * A child Node process (the one repl_run uses, ReplSession.ts) whose main
 * thread only relays: it starts the runtime's worker thread
 * (workerSource.ts, unchanged) and passes messages between that worker and
 * the parent over the IPC channel. Snippets therefore run in a process of
 * their own, never in the MCP server's: whatever they reach inside their
 * process (its main thread, its memory) is the runner's, not the server's.
 * Browser calls still travel as messages to the parent, which runs them
 * through the session's bridge; the runner opens no connection of its own
 * and gets neither the auth token nor any WMUX_* variable.
 *
 * `RunnerProcess` gives BrowserReplSession the part of the Worker interface it
 * uses: `postMessage`, `terminate`, and the `message`, `error` and `exit`
 * events.
 *
 * Teardown:
 * - `terminate()` (a timeout, `dispose`, the idle sweep) kills the runner and
 *   every process it started: its process group on macOS and Linux, its tree
 *   (`taskkill /T`) on Windows.
 * - When the parent dies, the IPC channel closes and the relay does the same
 *   to itself. Snippets never run on the relay's thread, so a busy snippet
 *   cannot keep it from noticing.
 */
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { buildReplChildEnv, resolveNodeBinary } from '../repl/ReplSession';
import { evalBootstrap } from '../repl/replRunnerSource';
import { BROWSER_REPL_WORKER_SOURCE } from './workerSource';

/** Live runner processes in this MCP server, across every connection. */
export const MAX_BROWSER_REPL_RUNNERS = 16;
let runnerCap = MAX_BROWSER_REPL_RUNNERS;
let liveRunners = 0;

/** Test seam: the cap on live runners. */
export function setBrowserReplRunnerCapForTest(cap: number | null): void {
  runnerCap = cap ?? MAX_BROWSER_REPL_RUNNERS;
}

/**
 * The relay, in the child's main thread. Worker messages go up wrapped as
 * `{ w }` and the relay's own reports as `{ c }`, so nothing a snippet posts
 * can pass for one of the relay's.
 */
function relaySource(): string {
  return String.raw`
'use strict';
const { Worker } = require('worker_threads');
const { spawnSync } = require('child_process');
const WORKER_SOURCE = ` + JSON.stringify(BROWSER_REPL_WORKER_SOURCE) + String.raw`;

// The parent is gone: end this runner and every process it started.
function endTree() {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-process.pid, 'SIGKILL');
    }
  } catch (_) { /* already going */ }
  process.exit(0);
}
process.on('disconnect', endTree);

const up = (message) => { try { process.send(message); } catch (_) { /* parent gone */ } };
const worker = new Worker(WORKER_SOURCE, { eval: true, stdout: true, stderr: true });
worker.stdout.resume();
worker.stderr.resume();
worker.on('message', (message) => up({ w: message }));
// An Error crosses the channel as its message (the channel's serializer drops
// its fields); any other thrown value as it is, or as text when it cannot.
worker.on('error', (error) => {
  const value = error instanceof Error ? { message: error.message } : error;
  try { process.send({ c: 'error', error: value }); } catch (_) {
    let text;
    try { text = String(value); } catch (_) { text = 'unprintable worker error'; }
    up({ c: 'error', error: text });
  }
});
worker.on('exit', (code) => process.exit(code));
process.on('message', (message) => {
  if (message && typeof message === 'object' && 'w' in message) worker.postMessage(message.w);
});
`;
}

/** Kill `child` and every process it started. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {
        child.kill('SIGKILL');
      });
    } else {
      // The runner leads its own process group (detached at spawn).
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
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
  private readonly exited: Promise<number>;
  private alive = true;

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
    const child = spawn(command, ['-e', evalBootstrap(relaySource())], {
      // The worker ran in this process's working directory; the runner keeps it.
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
      windowsHide: true,
      // Its own process group, so a kill takes what it started too.
      detached: process.platform !== 'win32',
    });
    this.child = child;
    liveRunners++;
    this.exited = new Promise<number>((resolve) => {
      child.once('exit', (code, signal) => {
        if (this.alive) {
          this.alive = false;
          liveRunners--;
        }
        const exitCode = code ?? (signal ? 1 : 0);
        resolve(exitCode);
        this.emit('exit', exitCode);
      });
    });
    child.on('message', (raw: unknown) => {
      const message = raw as { w?: unknown; c?: unknown; error?: unknown } | null;
      if (!message || typeof message !== 'object') return;
      if ('w' in message) this.emit('message', message.w);
      else if (message.c === 'error') this.raise(message.error);
    });
    child.on('error', (error) => this.raise(error));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** An `error` event, when anyone still listens (an unheard one would throw). */
  private raise(error: unknown): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  postMessage(message: unknown): void {
    try {
      this.child.send({ w: message });
    } catch {
      /* the runner is gone; its exit reports it */
    }
  }

  /** Kill the runner and what it started; resolves with its exit code. */
  terminate(): Promise<number> {
    if (this.alive) killTree(this.child);
    return this.exited;
  }
}
