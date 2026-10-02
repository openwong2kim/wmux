// Owns one native computer-use helper process and speaks its NDJSON protocol
// (src/shared/computer/protocol.ts) over stdio.
//
// Invariants:
//   - At most one request is in flight. UIA and AX work runs on a single
//     thread inside the helper anyway, and serialising here means a response
//     can only ever answer the request we are waiting on — any other id means
//     the stream is out of sync and the helper is killed.
//   - A request that times out kills the helper instead of waiting on it: a
//     hung UIA call does not come back. The next request spawns a fresh one.
//   - If a helper died while a control request was in flight (timeout, the stop
//     key, a crash) it may have left a modifier or mouse button pressed, and
//     killing it does not lift them. A fresh helper is started right away to
//     send `releaseInput`, without waiting for the next request; until one
//     succeeds, every request sends it first.
//   - dispose() is final: nothing starts a helper after it, and a helper that
//     was still starting is killed when it says hello.
//   - Closing stdin (idle, dispose) is the helper's signal to exit, so it never
//     outlives wmux.

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ComputerError } from '../../shared/computer/errors';
import {
  COMPUTER_PROTOCOL_VERSION,
  HELPER_IDLE_EXIT_MS,
  HELPER_MAX_LINE_BYTES,
  HELPER_TIMEOUT_MS,
  encodeHelperRequest,
  isControlAction,
  parseHelperLine,
  type HelperHello,
  type HelperMethod,
  type HelperMethods,
} from '../../shared/computer/protocol';

const STDERR_TAIL_BYTES = 4096;
/** How long an idle helper gets to exit on stdin EOF before it is killed. */
const IDLE_KILL_GRACE_MS = 5_000;

export type SpawnHelper = (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;

export interface HelperProcessOptions {
  command: string;
  args?: readonly string[];
  spawn?: SpawnHelper;
  helloTimeoutMs?: number;
  idleExitMs?: number;
  idleKillGraceMs?: number;
  /** Per-method timeout override, mainly for tests. */
  timeoutFor?: (method: HelperMethod) => number;
  log?: (message: string) => void;
}

interface Pending {
  id: number;
  method: HelperMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Running {
  child: ChildProcessWithoutNullStreams;
  hello: HelperHello;
}

function defaultTimeout(method: HelperMethod): number {
  return method === 'getAppState' ? HELPER_TIMEOUT_MS.getAppState : HELPER_TIMEOUT_MS.default;
}

export class HelperProcess {
  private readonly opts: HelperProcessOptions;
  private running: Running | null = null;
  private starting: Promise<Running> | null = null;
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Bumped by abort(); a request queued before the stop must never run. */
  private abortGeneration = 0;
  private nextId = 1;
  private needsRelease = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private stderrTail = '';
  private disposed = false;
  /** The child between spawn and hello, so dispose() can kill it too. */
  private startingChild: ChildProcessWithoutNullStreams | null = null;

  constructor(opts: HelperProcessOptions) {
    this.opts = opts;
  }

  /** The running helper's hello, if one is up. */
  get hello(): HelperHello | null {
    return this.running?.hello ?? null;
  }

  get lastStderr(): string {
    return this.stderrTail;
  }

  request<M extends HelperMethod>(method: M, params: HelperMethods[M]['params']): Promise<HelperMethods[M]['result']> {
    const generation = this.abortGeneration;
    const assertCurrent = () => {
      if (generation !== this.abortGeneration) throw new ComputerError('aborted', 'stopped by the user');
    };
    const run = async (): Promise<HelperMethods[M]['result']> => {
      if (this.disposed) throw new ComputerError('helper_unavailable', 'computer use is shutting down');
      assertCurrent();
      const running = await this.ensureRunning();
      assertCurrent();
      if (this.needsRelease && method !== 'releaseInput') {
        await this.send(running, 'releaseInput', {}).then(() => { this.needsRelease = false; }, () => undefined);
        assertCurrent();
      }
      const result = (await this.send(running, method, params)) as HelperMethods[M]['result'];
      if (method === 'releaseInput') this.needsRelease = false;
      return result;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Stops whatever is in flight (the user's abort key). The helper is killed so
   * a half-sent input batch cannot continue; its replacement starts by
   * releasing held input.
   */
  abort(reason = 'stopped by the user'): void {
    this.abortGeneration += 1;
    if (!this.running && !this.starting) return;
    const heldInput = this.pending !== null && isControlAction(this.pending.method);
    if (this.pending) this.failPending(new ComputerError('aborted', reason));
    this.kill();
    if (heldInput) this.releaseHeldInput();
  }

  dispose(): void {
    this.disposed = true;
    this.clearIdle();
    this.failPending(new ComputerError('helper_unavailable', 'computer use is shutting down'));
    this.kill();
    this.startingChild?.kill();
    this.startingChild = null;
  }

  /**
   * Lifts whatever a killed helper may have held, now rather than on the next
   * request: the person may be typing into another app meanwhile. Queued, so
   * it runs before any later request; a failure leaves `needsRelease` set and
   * the next request tries again.
   */
  private releaseHeldInput(): void {
    this.needsRelease = true;
    if (this.disposed) return;
    const run = async (): Promise<void> => {
      if (this.disposed || !this.needsRelease) return;
      const running = await this.ensureRunning();
      if (this.disposed || !this.needsRelease) return;
      await this.send(running, 'releaseInput', {});
      this.needsRelease = false;
    };
    this.queue = this.queue.then(run, run).catch((err: unknown) => {
      this.log(`could not release held input: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private ensureRunning(): Promise<Running> {
    if (this.disposed) return Promise.reject(new ComputerError('helper_unavailable', 'computer use is shutting down'));
    if (this.running) return Promise.resolve(this.running);
    if (!this.starting) {
      this.starting = this.start()
        .catch(async (err: unknown) => {
          // One retry on a version mismatch: an old helper left over from an
          // update is replaced once before we give up.
          if (err instanceof ComputerError && err.code === 'helper_incompatible') {
            return this.start();
          }
          throw err;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  private start(): Promise<Running> {
    const spawnFn: SpawnHelper = this.opts.spawn ?? ((cmd, args) => nodeSpawn(cmd, [...args], { stdio: 'pipe', windowsHide: true }));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(this.opts.command, this.opts.args ?? []);
    } catch (err) {
      return Promise.reject(new ComputerError('helper_unavailable', `could not start the computer-use helper: ${String(err)}`));
    }
    this.stderrTail = '';
    this.startingChild = child;

    return new Promise<Running>((resolve, reject) => {
      let settled = false;
      let buffer = '';
      const helloTimer = setTimeout(() => {
        fail(new ComputerError('helper_unavailable', 'the computer-use helper did not start in time'));
      }, this.opts.helloTimeoutMs ?? HELPER_TIMEOUT_MS.hello);

      const fail = (error: ComputerError) => {
        clearTimeout(helloTimer);
        if (this.startingChild === child) this.startingChild = null;
        if (!settled) {
          settled = true;
          child.kill();
          reject(error);
        }
      };

      // Decode as a stream: a multibyte character (Korean titles, emoji) can
      // straddle two chunks, and per-chunk decoding would turn it into U+FFFD.
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      // A helper that dies mid-write raises EPIPE here; unhandled, it would
      // crash main.
      child.stdin.on('error', (err) => {
        this.log(`helper stdin error: ${err.message}`);
        this.failPending(new ComputerError('helper_unavailable', `computer-use helper input failed: ${err.message}`));
      });

      child.stderr.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      });

      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > HELPER_MAX_LINE_BYTES) {
          this.log('helper line exceeded the size cap; killing it');
          this.failPending(new ComputerError('internal', 'the computer-use helper sent an oversized reply'));
          fail(new ComputerError('internal', 'oversized helper output'));
          child.kill();
          return;
        }
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.onLine(child, line, (hello) => {
            clearTimeout(helloTimer);
            if (settled) return;
            if (hello.protocolVersion !== COMPUTER_PROTOCOL_VERSION) {
              fail(new ComputerError(
                'helper_incompatible',
                `helper speaks protocol ${hello.protocolVersion}, wmux expects ${COMPUTER_PROTOCOL_VERSION}`,
              ));
              return;
            }
            if (this.disposed) {
              fail(new ComputerError('helper_unavailable', 'computer use is shutting down'));
              return;
            }
            settled = true;
            if (this.startingChild === child) this.startingChild = null;
            this.running = { child, hello };
            this.armIdle();
            resolve(this.running);
          });
          newline = buffer.indexOf('\n');
        }
      });

      child.on('error', (err) => {
        fail(new ComputerError('helper_unavailable', `computer-use helper failed: ${err.message}`));
        this.onExit(child);
      });
      child.on('exit', (code, signal) => {
        this.log(`helper exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
        fail(new ComputerError('helper_unavailable', 'the computer-use helper exited during start-up'));
        this.onExit(child);
      });
    });
  }

  private onLine(child: ChildProcessWithoutNullStreams, line: string, onHello: (hello: HelperHello) => void): void {
    const parsed = parseHelperLine(line);
    if (parsed.kind === 'hello') {
      onHello(parsed.hello);
      return;
    }
    if (parsed.kind === 'invalid') {
      this.log(`invalid helper line (${parsed.reason}); killing it`);
      this.failPending(new ComputerError('internal', `the computer-use helper sent an invalid reply (${parsed.reason})`));
      child.kill();
      return;
    }
    const pending = this.pending;
    if (!pending || pending.id !== parsed.response.id) {
      this.log(`helper answered unknown request ${parsed.response.id}; killing it`);
      this.failPending(new ComputerError('internal', 'the computer-use helper lost track of requests'));
      child.kill();
      return;
    }
    clearTimeout(pending.timer);
    this.pending = null;
    if (parsed.response.ok) {
      pending.resolve(parsed.response.result);
    } else {
      pending.reject(new ComputerError(parsed.response.error.code, parsed.response.error.message));
    }
  }

  private send(running: Running, method: HelperMethod, params: unknown): Promise<unknown> {
    this.clearIdle();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeoutMs = this.opts.timeoutFor?.(method) ?? defaultTimeout(method);
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.failPending(new ComputerError('timeout', `${method} did not finish within ${timeoutMs} ms`));
        this.kill();
        if (isControlAction(method)) this.releaseHeldInput();
      }, timeoutMs);
      this.pending = {
        id,
        method,
        resolve: (value) => {
          this.armIdle();
          resolve(value);
        },
        reject: (error) => {
          this.armIdle();
          reject(error);
        },
        timer,
      };
      running.child.stdin.write(encodeHelperRequest({ id, method, params } as never));
    });
  }

  private onExit(child: ChildProcessWithoutNullStreams): void {
    if (this.running?.child !== child) return;
    this.running = null;
    this.clearIdle();
    if (this.pending) {
      const heldInput = isControlAction(this.pending.method);
      const tail = this.stderrTail.trim().split('\n').slice(-1)[0] ?? '';
      this.failPending(new ComputerError('helper_unavailable', `the computer-use helper exited${tail ? `: ${tail}` : ''}`));
      if (heldInput) this.releaseHeldInput();
    }
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(error);
  }

  private kill(): void {
    const running = this.running;
    this.running = null;
    this.clearIdle();
    if (running) {
      running.child.stdin.end();
      running.child.kill();
    }
  }

  private armIdle(): void {
    this.clearIdle();
    const idleMs = this.opts.idleExitMs ?? HELPER_IDLE_EXIT_MS;
    this.idleTimer = setTimeout(() => {
      if (!this.pending) {
        // Closing stdin asks the helper to exit on its own. A helper stuck in
        // a native call never reads that EOF, so it is killed after a grace
        // period instead of lingering as an orphan until wmux quits.
        const running = this.running;
        this.running = null;
        if (running) {
          const { child } = running;
          child.stdin.end();
          const grace = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill();
          }, this.opts.idleKillGraceMs ?? IDLE_KILL_GRACE_MS);
          grace.unref?.();
        }
      }
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private log(message: string): void {
    this.opts.log?.(`[computer] ${message}`);
  }
}
