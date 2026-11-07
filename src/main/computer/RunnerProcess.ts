// Owns the macOS helper's runner mode (`--runner`, native/computer-use-macos
// Sources/wmux-computer-use/Runner.swift): a second helper process that starts
// the nested agent-desktop binary, one child per request, several at once.
//
// Kept apart from HelperProcess on purpose: that one allows one request at a
// time and kills its helper on a timeout, which is right for AX and input
// work, but a desktop `wait` blocks for seconds and must neither hold up other
// calls nor take the helper down when it runs long.
//
//   - Every child runs in its own process group, whose id the runner reports
//     (`started`). A stop or a timeout kills that group from here and tells
//     the runner to cancel; the runner itself stays up.
//   - The runner exits on stdin EOF (idle, dispose) and kills its children
//     first, so nothing it started outlives wmux.
//   - Late replies for a request that already settled are ignored.

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ComputerError, isComputerErrorCode } from '../../shared/computer/errors';

export interface RunnerResult {
  /** The child's exit code, or undefined when a signal ended it. */
  exitCode?: number;
  signal?: number;
  stdout: string;
  stderr: string;
}

export type SpawnRunner = (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;

export interface RunnerProcessOptions {
  command: string;
  spawn?: SpawnRunner;
  /** Awaited before every spawn (verifyHelper.ts); a rejection keeps the binary from running. */
  verify?: (command: string) => Promise<void>;
  helloTimeoutMs?: number;
  idleExitMs?: number;
  /** Added to a run's own timeout before main gives up on the runner's answer. */
  graceMs?: number;
  /** Kills a child's process group; injectable for tests. */
  killGroup?: (pgid: number) => void;
  log?: (message: string) => void;
}

/** Longest run a caller may ask for; the runner caps it the same way. */
export const RUNNER_MAX_TIMEOUT_MS = 35_000;
const HELLO_TIMEOUT_MS = 10_000;
const IDLE_EXIT_MS = 60_000;
const GRACE_MS = 5_000;
/** A reply carries up to 8 MB of child output, JSON-escaped. */
const MAX_LINE_BYTES = 32 << 20;

interface Pending {
  resolve: (result: RunnerResult) => void;
  reject: (error: ComputerError) => void;
  pgid?: number;
  timer: ReturnType<typeof setTimeout>;
}

interface Running {
  child: ChildProcessWithoutNullStreams;
  ready: boolean;
}

const killGroupDefault = (pgid: number): void => {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Gone already.
  }
};

export class RunnerProcess {
  private readonly opts: RunnerProcessOptions;
  private running: Running | null = null;
  private starting: Promise<Running> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(opts: RunnerProcessOptions) {
    this.opts = opts;
  }

  private log(message: string): void {
    this.opts.log?.(`[computer-runner] ${message}`);
  }

  /** Runs agent-desktop with `argv` and resolves with what it printed. */
  async run(argv: readonly string[], options: { home: string; timeoutMs: number }): Promise<RunnerResult> {
    if (this.disposed) throw new ComputerError('shutting_down', 'computer use is shutting down');
    const running = await this.ensureRunning();
    const id = this.nextId++;
    const timeoutMs = Math.min(Math.max(1, Math.floor(options.timeoutMs)), RUNNER_MAX_TIMEOUT_MS);
    this.disarmIdle();
    return new Promise<RunnerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id, new ComputerError('timeout', `agent-desktop did not answer within ${timeoutMs} ms`));
      }, timeoutMs + (this.opts.graceMs ?? GRACE_MS));
      this.pending.set(id, { resolve, reject, timer });
      this.write(running, { id, argv: [...argv], timeoutMs, home: options.home });
    });
  }

  /** Stops every run: kills each child's group now and fails its call with `aborted`. */
  abort(): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, new ComputerError('aborted', 'stopped by the user'));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort();
    this.stop();
  }

  private settle(id: number, outcome: RunnerResult | ComputerError): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (outcome instanceof ComputerError) {
      // A run that ends here early takes its child with it; the runner is
      // told too, for a child it has not reported yet.
      if (p.pgid !== undefined) (this.opts.killGroup ?? killGroupDefault)(p.pgid);
      if (this.running) this.write(this.running, { cancel: id });
      p.reject(outcome);
    } else {
      p.resolve(outcome);
    }
    if (this.pending.size === 0) this.armIdle();
  }

  private write(running: Running, message: unknown): void {
    if (running.child.stdin.destroyed) return;
    running.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private armIdle(): void {
    this.disarmIdle();
    if (!this.running) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) this.stop();
    }, this.opts.idleExitMs ?? IDLE_EXIT_MS);
  }

  private disarmIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** stdin EOF: the runner kills its children and exits. */
  private stop(): void {
    this.disarmIdle();
    const running = this.running;
    this.running = null;
    running?.child.stdin.end();
  }

  private ensureRunning(): Promise<Running> {
    if (this.running) return Promise.resolve(this.running);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<Running> {
    await this.opts.verify?.(this.opts.command);
    if (this.disposed) throw new ComputerError('shutting_down', 'computer use is shutting down');
    const spawnFn: SpawnRunner = this.opts.spawn ?? ((cmd, args) => nodeSpawn(cmd, [...args], { stdio: 'pipe' }));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(this.opts.command, ['--runner']);
    } catch (err) {
      throw new ComputerError('helper_unavailable', `could not start the computer-use helper: ${String(err)}`);
    }
    return new Promise<Running>((resolve, reject) => {
      let settled = false;
      let buffer = '';
      const helloTimer = setTimeout(() => fail('the computer-use helper did not start in time'), this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
      const fail = (message: string) => {
        clearTimeout(helloTimer);
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new ComputerError('helper_unavailable', message));
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdin.on('error', (err) => this.log(`stdin error: ${err.message}`));
      child.stderr.on('data', (chunk: string) => this.log(chunk.trimEnd()));
      child.stdout.on('data', (chunk: string) => {
        // Only the new chunk is searched for a line end: a reply of several
        // megabytes arrives in many chunks.
        const searchFrom = buffer.length;
        buffer += chunk;
        if (buffer.length > MAX_LINE_BYTES) {
          buffer = '';
          this.log('oversized line; stopping the runner');
          child.kill('SIGKILL');
          return;
        }
        let newline = buffer.indexOf('\n', searchFrom);
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (!settled && message.runner === 1) {
            clearTimeout(helloTimer);
            settled = true;
            const running: Running = { child, ready: message.ready === true };
            this.running = running;
            this.armIdle();
            resolve(running);
            continue;
          }
          this.onMessage(message);
        }
      });
      child.on('error', (err) => {
        fail(`computer-use helper failed: ${err.message}`);
        this.onExit(child);
      });
      child.on('exit', (code) => {
        fail(`the computer-use helper exited during start-up (exit code ${code ?? 'none'})`);
        this.onExit(child);
      });
    });
  }

  private onMessage(message: Record<string, unknown>): void {
    const id = typeof message.id === 'number' ? message.id : undefined;
    if (id === undefined) return;
    const p = this.pending.get(id);
    if (!p) return;
    if (message.event === 'started') {
      if (typeof message.pid === 'number' && message.pid > 1) p.pgid = message.pid;
      return;
    }
    if (message.ok === true) {
      this.settle(id, {
        ...(typeof message.exitCode === 'number' && { exitCode: message.exitCode }),
        ...(typeof message.signal === 'number' && { signal: message.signal }),
        stdout: typeof message.stdout === 'string' ? message.stdout : '',
        stderr: typeof message.stderr === 'string' ? message.stderr : '',
      });
      return;
    }
    const error = (message.error ?? {}) as { code?: unknown; message?: unknown };
    const code = isComputerErrorCode(error.code) ? error.code : 'internal';
    // The child is gone already; nothing to kill.
    p.pgid = undefined;
    this.settle(id, new ComputerError(code, typeof error.message === 'string' ? error.message : 'agent-desktop failed'));
  }

  private onExit(child: ChildProcessWithoutNullStreams): void {
    if (this.running?.child !== child) return;
    this.running = null;
    this.disarmIdle();
    for (const id of [...this.pending.keys()]) {
      this.settle(id, new ComputerError('helper_unavailable', 'the computer-use helper stopped'));
    }
  }
}
