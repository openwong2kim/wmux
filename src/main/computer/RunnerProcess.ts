// Owns the macOS helper's runner mode (`--runner`, native/computer-use-macos
// Sources/wmux-computer-use/Runner.swift): a second helper process that starts
// the nested agent-desktop binary, one child per request, several at once.
//
// Kept apart from HelperProcess on purpose: that one allows one request at a
// time and kills its helper on a timeout, which is right for AX and input
// work, but a desktop `wait` blocks for seconds and must neither hold up other
// calls nor take the helper down when it runs long.
//
//   - The runner is started as the leader of its own process group, and its
//     children stay in that group. A stop or a timeout asks the runner to
//     cancel the run; only the runner kills a child, since only it knows the
//     child is unreaped. Main never kills a pid or group it was told about.
//   - A runner that does not acknowledge a cancel in time is taken down with
//     its whole group: main may name that group because the runner is its own
//     unreaped child, so the id cannot have been reused.
//   - The runner exits on stdin EOF (idle, dispose) and kills its group
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
  /** How long the runner has to acknowledge a cancel before main ends it. */
  cancelGraceMs?: number;
  /** Awaited at the start of every run (the state directory); a stop during it cancels the run. */
  prepare?: () => Promise<void>;
  log?: (message: string) => void;
}

/** Longest run a caller may ask for; the runner caps it the same way. */
export const RUNNER_MAX_TIMEOUT_MS = 35_000;
const HELLO_TIMEOUT_MS = 10_000;
const IDLE_EXIT_MS = 60_000;
const GRACE_MS = 5_000;
/** The child output the runner passes on (Runner.swift RunnerPolicy.maxOutputBytes). */
export const RUNNER_MAX_OUTPUT_BYTES = 8 << 20;
/**
 * The longest reply line: JSON escapes a control character as six bytes
 * (\u00XX), so the output cap times six, plus the 16 KB of stderr (escaped
 * too) and the envelope.
 */
export const RUNNER_MAX_LINE_BYTES = RUNNER_MAX_OUTPUT_BYTES * 6 + (16 << 10) * 6 + (64 << 10);

interface Pending {
  resolve: (result: RunnerResult) => void;
  reject: (error: ComputerError) => void;
  /** The runner the request was written to. */
  running: Running;
  /** The runner answered this run itself, so there is nothing to cancel. */
  answered?: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface Running {
  child: ChildProcessWithoutNullStreams;
  /** Cancels sent to this runner and not yet acknowledged, each with the timer that ends it. */
  cancelling: Map<number, ReturnType<typeof setTimeout>>;
}

const CANCEL_GRACE_MS = 2_000;

export class RunnerProcess {
  private readonly opts: RunnerProcessOptions;
  private running: Running | null = null;
  /** Every runner not yet seen to exit, the current one and any still winding down. */
  private readonly runners = new Set<Running>();
  private starting: Promise<Running> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** Bumped by abort(): a run that started before it never reaches the runner. */
  private generation = 0;
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
    const generation = this.generation;
    const current = () => {
      if (this.disposed) throw new ComputerError('shutting_down', 'computer use is shutting down');
      if (generation !== this.generation) throw new ComputerError('aborted', 'stopped by the user');
    };
    current();
    await this.opts.prepare?.();
    current();
    const running = await this.ensureRunning();
    current();
    const id = this.nextId++;
    const timeoutMs = Math.min(Math.max(1, Math.floor(options.timeoutMs)), RUNNER_MAX_TIMEOUT_MS);
    this.disarmIdle();
    return new Promise<RunnerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id, new ComputerError('timeout', `agent-desktop did not answer within ${timeoutMs} ms`));
      }, timeoutMs + (this.opts.graceMs ?? GRACE_MS));
      this.pending.set(id, { resolve, reject, running, timer });
      this.write(running, { id, argv: [...argv], timeoutMs, home: options.home });
    });
  }

  /**
   * Stops every run: each call fails with `aborted` now, the runner is told
   * to cancel its child, and a run still on its way (preparing, or waiting
   * for the runner to start) is never sent.
   */
  abort(): void {
    this.generation += 1;
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
      // A run that ends here early: the runner kills its child. If it does
      // not acknowledge in time, it is unresponsive and goes with its group.
      const running = p.running;
      if (!p.answered && running.child.exitCode === null && running.child.signalCode === null) {
        this.write(running, { cancel: id });
        const timer = setTimeout(() => {
          running.cancelling.delete(id);
          this.log(`the runner did not acknowledge cancel ${id}; ending it`);
          this.killRunner(running.child);
        }, this.opts.cancelGraceMs ?? CANCEL_GRACE_MS);
        running.cancelling.set(id, timer);
      }
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
    // detached: the runner leads a process group of its own, which holds its children.
    const spawnFn: SpawnRunner = this.opts.spawn ?? ((cmd, args) => nodeSpawn(cmd, [...args], { stdio: 'pipe', detached: true }));
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
        this.killRunner(child);
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
        if (buffer.length > RUNNER_MAX_LINE_BYTES) {
          buffer = '';
          this.log('oversized line; stopping the runner');
          this.killRunner(child);
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
            const running: Running = { child, cancelling: new Map() };
            this.running = running;
            this.runners.add(running);
            this.armIdle();
            resolve(running);
            continue;
          }
          this.onMessage(message, child);
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

  private onMessage(message: Record<string, unknown>, from: ChildProcessWithoutNullStreams): void {
    const id = typeof message.id === 'number' ? message.id : undefined;
    if (id === undefined) return;
    // Any answer for a canceled run acknowledges the cancel, from the runner it went to.
    const running = [...this.runners].find((r) => r.child === from);
    const acknowledged = running?.cancelling.get(id);
    if (running && acknowledged && message.event !== 'started') {
      clearTimeout(acknowledged);
      running.cancelling.delete(id);
    }
    const p = this.pending.get(id);
    if (!p || p.running.child !== from) return;
    if (message.event === 'started') return;
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
    p.answered = true;
    this.settle(id, new ComputerError(code, typeof error.message === 'string' ? error.message : 'agent-desktop failed'));
  }

  /**
   * Ends an unresponsive runner and every child in its group. Only while the
   * runner is unreaped (no exit seen), so its pid, the group's id, is still
   * its own.
   */
  private killRunner(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }

  private onExit(child: ChildProcessWithoutNullStreams): void {
    const exited = [...this.runners].find((r) => r.child === child);
    if (!exited) return;
    this.runners.delete(exited);
    // This runner's cancels only: another runner's stay armed.
    for (const timer of exited.cancelling.values()) clearTimeout(timer);
    if (this.running !== exited) return;
    this.running = null;
    this.disarmIdle();
    for (const id of [...this.pending.keys()]) {
      this.settle(id, new ComputerError('helper_unavailable', 'the computer-use helper stopped'));
    }
  }
}
