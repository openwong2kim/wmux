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
//   - A helper is ended for cause through one path, terminate(). If the
//     request it was running was an input action (or a release), it may have
//     left keys or buttons down, and killing it does not lift them: a fresh
//     helper is started right away to send `releaseInput`, without waiting for
//     the next request. Until a release answers `released: true`, every
//     request tries one first, and control requests fail closed.
//   - The pending request is bound to the child it was written to, so late
//     output or errors from a dead helper never touch its replacement.
//   - dispose() is final: nothing starts a helper after it, and a helper that
//     was still starting is killed when it says hello. A helper killed by
//     dispose mid-input gets a short stdin-EOF grace to release first.
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
  MODIFIERS,
  parseHelperLine,
  type MouseButton,
  type ReleaseInputParams,
  type HelperHello,
  type HelperMethod,
  type HelperMethods,
} from '../../shared/computer/protocol';

const STDERR_TAIL_BYTES = 4096;
/** How long an idle helper gets to exit on stdin EOF before it is killed. */
const IDLE_KILL_GRACE_MS = 5_000;
/** dispose() mid-input: time for the helper's release-on-EOF before the kill. */
const DISPOSE_RELEASE_GRACE_MS = 200;
/** Background releases in a row before waiting for the next request to retry. */
const MAX_BACKGROUND_RELEASES = 3;
/** Release attempts (each on a fresh helper) before a control request fails closed. */
const RELEASE_ATTEMPTS_BEFORE_CONTROL = 2;

export type SpawnHelper = (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams;

export interface HelperProcessOptions {
  command: string;
  args?: readonly string[];
  spawn?: SpawnHelper;
  helloTimeoutMs?: number;
  idleExitMs?: number;
  idleKillGraceMs?: number;
  /** dispose() mid-input: stdin-EOF grace before the kill. */
  disposeReleaseGraceMs?: number;
  /**
   * Awaited before every spawn; a rejection means the binary must not run
   * (verifyHelper.ts: the packaged macOS helper's code signature).
   */
  verify?: (command: string) => Promise<void>;
  /** Per-method timeout override, mainly for tests. */
  timeoutFor?: (method: HelperMethod) => number;
  log?: (message: string) => void;
}

interface Pending {
  id: number;
  method: HelperMethod;
  /** What was sent, so a cut-off input action can name what to release. */
  params: unknown;
  /** The helper this request was written to. */
  child: ChildProcessWithoutNullStreams;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Running {
  child: ChildProcessWithoutNullStreams;
  hello: HelperHello;
}

/** A request that may leave keys or buttons down if it is cut off. */
function holdsInput(method: HelperMethod): boolean {
  return isControlAction(method) || method === 'releaseInput';
}

const MOUSE_BUTTONS: readonly MouseButton[] = ['left', 'right', 'middle'];

/**
 * What a cut-off request may have left down, named from what main sent it
 * (protocol.ts, Held input). Actions whose keys main does not name (setValue
 * and scroll may fall back to synthetic input) get the modifiers and buttons,
 * never a list of ordinary keys.
 */
function releaseSpecFor(method: HelperMethod, params: unknown): ReleaseInputParams {
  const p = (params ?? {}) as Record<string, unknown>;
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  switch (method) {
    case 'click':
      return { modifiers: list(p.modifiers), buttons: typeof p.button === 'string' ? [p.button as MouseButton] : [...MOUSE_BUTTONS] };
    case 'pressKey':
      return { keys: typeof p.key === 'string' ? [p.key] : [] };
    case 'hotkey':
      return { keys: typeof p.key === 'string' ? [p.key] : [], modifiers: list(p.modifiers) };
    case 'type':
      // Typing presses Enter and Tab for line breaks and tabs; the key behind
      // a Unicode event is in the helper's own crash record. A helper that
      // pastes uses a modifier chord.
      return { keys: ['Enter', 'Tab'], modifiers: [...MODIFIERS] };
    case 'releaseInput':
      return { keys: list(p.keys), modifiers: list(p.modifiers), buttons: list(p.buttons) };
    default:
      return { modifiers: [...MODIFIERS], buttons: [...MOUSE_BUTTONS] };
  }
}

function mergeRelease(a: ReleaseInputParams | null, b: ReleaseInputParams): ReleaseInputParams {
  const union = <T>(x: T[] | undefined, y: T[] | undefined): T[] | undefined => {
    const all = [...new Set([...(x ?? []), ...(y ?? [])])];
    return all.length > 0 ? all : undefined;
  };
  const keys = union(a?.keys, b.keys);
  const modifiers = union(a?.modifiers, b.modifiers);
  const buttons = union(a?.buttons, b.buttons);
  return { ...(keys && { keys }), ...(modifiers && { modifiers }), ...(buttons && { buttons }) };
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
  /** What still has to be released, or null when nothing is held. */
  private heldInput: ReleaseInputParams | null = null;
  private backgroundReleases = 0;
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
      if (this.heldInput && method !== 'releaseInput') {
        let released = false;
        for (let attempt = 0; attempt < RELEASE_ATTEMPTS_BEFORE_CONTROL && !released; attempt++) {
          const helper = await this.ensureRunning();
          assertCurrent();
          released = (await this.tryRelease(helper)) === 'released';
          assertCurrent();
        }
        // Observation cannot press anything, so it may go ahead; input may not
        // pile onto keys that might still be down.
        if (!released && isControlAction(method)) {
          throw new ComputerError(
            'internal',
            'wmux could not confirm that keys held by a stopped computer-use action were released, so it sends no more input. Retry once; if it fails again, tell the user',
          );
        }
      }
      const running = await this.ensureRunning();
      assertCurrent();
      // An explicit release also carries whatever is still known to be held.
      const sent = method === 'releaseInput' && this.heldInput
        ? mergeRelease(this.heldInput, params as ReleaseInputParams)
        : params;
      const result = (await this.send(running, method, sent)) as HelperMethods[M]['result'];
      if (method === 'releaseInput' && (result as { released?: unknown })?.released === true) this.markReleased();
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
    // A release in flight is killed too, and rescheduled by terminate().
    if (this.running) this.terminate(this.running.child, new ComputerError('aborted', reason));
  }

  dispose(): void {
    this.disposed = true;
    this.clearIdle();
    const error = new ComputerError('helper_unavailable', 'computer use is shutting down');
    if (this.running) {
      // Mid-input, stdin EOF first: the helper releases what it holds on EOF,
      // and no fresh helper may be started for it any more.
      const pending = this.pending;
      const midInput = pending !== null && pending.child === this.running.child && holdsInput(pending.method);
      this.terminate(this.running.child, error, midInput ? (this.opts.disposeReleaseGraceMs ?? DISPOSE_RELEASE_GRACE_MS) : 0);
    }
    this.failPending(error);
    this.startingChild?.kill();
    this.startingChild = null;
  }

  /**
   * The one way a helper is ended for cause (timeout, abort, a bad reply, a
   * broken pipe, an exit). Fails the request written to this child, if any;
   * a no-op for `pending` when the request belongs to another child. When that
   * request could have left input down, schedules the release.
   */
  private terminate(child: ChildProcessWithoutNullStreams, error: ComputerError, graceMs = 0): void {
    const pending = this.pending?.child === child ? this.pending : null;
    const held = pending !== null && holdsInput(pending.method) ? releaseSpecFor(pending.method, pending.params) : null;
    if (pending) this.failPending(error);
    if (this.running?.child === child) {
      this.running = null;
      this.clearIdle();
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      if (graceMs > 0) {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        }, graceMs);
        timer.unref?.();
      } else {
        child.kill();
      }
    }
    if (held) this.releaseHeldInput(held);
  }

  /**
   * One release on `running`. `refused` means the helper answered but did not
   * confirm (`released` not true): it is retired so the next try gets a fresh
   * one. `failed` means the request itself failed; terminate() already took
   * care of the helper.
   */
  private async tryRelease(running: Running): Promise<'released' | 'refused' | 'failed'> {
    let result: unknown;
    try {
      result = await this.send(running, 'releaseInput', this.heldInput ?? {});
    } catch {
      return 'failed';
    }
    if ((result as { released?: unknown } | null)?.released === true) {
      this.markReleased();
      return 'released';
    }
    this.log('helper did not confirm releasing held input; retiring it');
    this.terminate(running.child, new ComputerError('internal', 'release not confirmed'));
    return 'refused';
  }

  private markReleased(): void {
    this.heldInput = null;
    this.backgroundReleases = 0;
  }

  /**
   * Lifts whatever a killed helper may have held, now rather than on the next
   * request: the person may be typing into another app meanwhile. Queued, so
   * it runs before any later request; a failure leaves `heldInput` set and
   * the next request tries again. `spec` names what the cut-off request sent.
   */
  private releaseHeldInput(spec?: ReleaseInputParams): void {
    this.heldInput = mergeRelease(this.heldInput, spec ?? {});
    if (this.disposed) return;
    // Bounded: a helper that hangs on every release must not respawn forever.
    // Past the cap the next request retries, and control fails closed.
    if (this.backgroundReleases >= MAX_BACKGROUND_RELEASES) {
      this.log('held input is still not released; the next request will retry');
      return;
    }
    this.backgroundReleases += 1;
    const run = async (): Promise<void> => {
      if (this.disposed || !this.heldInput) return;
      const running = await this.ensureRunning();
      if (this.disposed || !this.heldInput) return;
      // `failed` was rescheduled by terminate(); `refused` is rescheduled here.
      if ((await this.tryRelease(running)) === 'refused') this.releaseHeldInput();
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

  private async start(): Promise<Running> {
    if (this.opts.verify) {
      await this.opts.verify(this.opts.command);
      if (this.disposed) throw new ComputerError('helper_unavailable', 'computer use is shutting down');
    }
    return this.spawnHelper();
  }

  private spawnHelper(): Promise<Running> {
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
        this.terminate(child, new ComputerError('helper_unavailable', `computer-use helper input failed: ${err.message}`));
      });

      child.stderr.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      });

      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > HELPER_MAX_LINE_BYTES) {
          this.log('helper line exceeded the size cap; killing it');
          buffer = '';
          fail(new ComputerError('internal', 'oversized helper output'));
          this.terminate(child, new ComputerError('internal', 'the computer-use helper sent an oversized reply'));
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
        fail(new ComputerError('helper_unavailable', `the computer-use helper exited during start-up (exit code ${code ?? 'none'})`));
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
    // A helper that is no longer the running one has nothing to answer.
    if (this.running?.child !== child && this.startingChild !== child) return;
    if (parsed.kind === 'invalid') {
      this.log(`invalid helper line (${parsed.reason}); killing it`);
      this.terminate(child, new ComputerError('internal', `the computer-use helper sent an invalid reply (${parsed.reason})`));
      return;
    }
    const pending = this.pending;
    if (!pending || pending.child !== child || pending.id !== parsed.response.id) {
      this.log(`helper answered unknown request ${parsed.response.id}; killing it`);
      this.terminate(child, new ComputerError('internal', 'the computer-use helper lost track of requests'));
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
        this.terminate(running.child, new ComputerError('timeout', `${method} did not finish within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending = {
        id,
        method,
        params,
        child: running.child,
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
    const tail = this.stderrTail.trim().split('\n').slice(-1)[0] ?? '';
    this.terminate(child, new ComputerError('helper_unavailable', `the computer-use helper exited${tail ? `: ${tail}` : ''}`));
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(error);
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
