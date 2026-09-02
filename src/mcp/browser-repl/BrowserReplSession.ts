/**
 * One `browser_repl` runtime per MCP connection: a worker thread that holds
 * the script's globals between calls, plus the run queue in front of it.
 *
 * Runs are serialized. Two concurrent `browser_repl` calls on one connection
 * would otherwise interleave their `browser.*` calls on the same page — each
 * script's snapshot invalidated by the other's clicks — with nothing in either
 * result to show it happened.
 *
 * A timeout terminates the worker. That is the only way to stop a synchronous
 * loop, and it costs the script's state; the outcome says so and the next run
 * starts a fresh worker. Handler calls still in flight when the worker dies
 * run to completion (a half-finished click is worse than a finished one) and
 * their results are dropped.
 */
import { Worker } from 'worker_threads';
import { OutputBuffer, truncateText, type TruncatedText } from '../repl/truncate';
import type { BridgeCall } from './bridge';
import { BROWSER_REPL_WORKER_SOURCE } from './workerSource';

export const CONSOLE_CAP_BYTES = 32 * 1024;
export const RESULT_CAP_BYTES = 16 * 1024;
/** Worker startup is local and fast; anything slower is a broken runtime. */
const READY_TIMEOUT_MS = 10_000;

export interface BrowserReplRunOutcome {
  readonly ok: boolean;
  readonly elapsedMs: number;
  /** One line per `browser.*` call, in order, including refused/failed ones. */
  readonly ledger: readonly string[];
  readonly console: TruncatedText;
  readonly result?: TruncatedText;
  readonly error?: string;
  /** True when the run was killed by the deadline; the worker is gone. */
  readonly timedOut: boolean;
  /** True when this run started a new worker (first run, or after a timeout/crash). */
  readonly freshRuntime: boolean;
  /** Why the previous worker was gone, when this run had to start a new one. */
  readonly previousDeath?: string;
}

interface WorkerMessage {
  type: string;
  id?: number;
  callId?: number;
  name?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  result?: string;
  error?: string;
  text?: string;
}

export class BrowserReplSession {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private previousDeath: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private nextRunId = 1;
  private disposed = false;
  private lastUsedAt = Date.now();
  private runsInFlight = 0;

  constructor(private readonly tools: readonly string[]) {}

  get lastUsed(): number {
    return this.lastUsedAt;
  }

  get busy(): boolean {
    return this.runsInFlight > 0;
  }

  /**
   * Queue a run; resolves when it and every run queued before it are done.
   * `bridge` is per run because the call's surfaceId default and captured
   * connection scope belong to that call, not to the session.
   */
  run(code: string, timeoutMs: number, bridge: BridgeCall): Promise<BrowserReplRunOutcome> {
    if (this.disposed) return Promise.reject(new Error('browser_repl session is disposed'));
    this.runsInFlight++;
    const next = this.tail.then(
      () => this.execute(code, timeoutMs, bridge),
      () => this.execute(code, timeoutMs, bridge),
    );
    this.tail = next.finally(() => {
      this.runsInFlight--;
      this.lastUsedAt = Date.now();
    });
    return next;
  }

  /** Kill the worker; queued runs reject. Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.killWorker('disposed');
  }

  private killWorker(reason: string): void {
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    if (worker) {
      this.previousDeath = reason;
      worker.removeAllListeners();
      void worker.terminate().catch(() => { /* already gone */ });
    }
  }

  private ensureWorker(): { worker: Worker; ready: Promise<void>; fresh: boolean } {
    if (this.worker && this.ready) return { worker: this.worker, ready: this.ready, fresh: false };
    const worker = new Worker(BROWSER_REPL_WORKER_SOURCE, {
      eval: true,
      // The worker never touches stdio; captured console travels as messages.
      stdout: true,
      stderr: true,
    });
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser_repl worker did not start')), READY_TIMEOUT_MS);
      const onMessage = (msg: WorkerMessage) => {
        if (msg?.type === 'ready') {
          clearTimeout(timer);
          worker.off('message', onMessage);
          resolve();
        }
      };
      worker.on('message', onMessage);
      worker.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      worker.postMessage({ type: 'init', tools: this.tools });
    });
    return { worker, ready: this.ready, fresh: true };
  }

  private async execute(code: string, timeoutMs: number, bridge: BridgeCall): Promise<BrowserReplRunOutcome> {
    if (this.disposed) throw new Error('browser_repl session is disposed');
    const started = Date.now();
    const ledger: string[] = [];
    const consoleBuf = new OutputBuffer(CONSOLE_CAP_BYTES);
    const previousDeath = this.previousDeath;
    this.previousDeath = undefined;
    const { worker, ready, fresh } = this.ensureWorker();
    const base = { ledger, freshRuntime: fresh, previousDeath: fresh ? previousDeath : undefined };

    try {
      await ready;
    } catch (error) {
      this.killWorker('failed to start');
      return {
        ...base,
        ok: false,
        elapsedMs: Date.now() - started,
        console: consoleBuf.render(),
        error: `browser_repl runtime failed to start: ${error instanceof Error ? error.message : String(error)}`,
        timedOut: false,
      };
    }

    const id = this.nextRunId++;

    return new Promise<BrowserReplRunOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: Omit<BrowserReplRunOutcome, 'ledger' | 'freshRuntime' | 'previousDeath' | 'elapsedMs' | 'console'>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        resolve({ ...base, ...outcome, elapsedMs: Date.now() - started, console: consoleBuf.render() });
      };

      const timer = setTimeout(() => {
        this.killWorker(`stopped by the ${timeoutMs}ms timeout`);
        finish({
          ok: false,
          error: `the code was stopped by the ${timeoutMs}ms timeout`,
          timedOut: true,
        });
      }, timeoutMs);

      const onMessage = (msg: WorkerMessage) => {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.type) {
          case 'console':
            if (typeof msg.text === 'string') consoleBuf.append(Buffer.from(msg.text, 'utf8'));
            return;
          case 'call': {
            const callId = msg.callId;
            const name = typeof msg.name === 'string' ? msg.name : '';
            const args = msg.args && typeof msg.args === 'object' ? msg.args : {};
            void bridge(name, args).then((outcome) => {
              ledger.push(outcome.ledger);
              // After a timeout the worker is gone; the handler ran to
              // completion for the page's sake and the reply has nowhere to go.
              if (settled || this.worker !== worker) return;
              worker.postMessage(
                outcome.ok
                  ? { type: 'callResult', callId, ok: true, value: outcome.value }
                  : { type: 'callResult', callId, ok: false, error: outcome.error },
              );
            });
            return;
          }
          case 'result':
            if (msg.id !== id) return;
            if (msg.ok) {
              finish({
                ok: true,
                result: truncateText(typeof msg.result === 'string' ? msg.result : '', RESULT_CAP_BYTES),
                timedOut: false,
              });
            } else {
              finish({ ok: false, error: typeof msg.error === 'string' ? msg.error : 'unknown error', timedOut: false });
            }
            return;
          default:
            return;
        }
      };
      const onError = (err: Error) => {
        this.killWorker(`crashed: ${err.message}`);
        finish({ ok: false, error: `browser_repl runtime crashed: ${err.message}`, timedOut: false });
      };
      const onExit = (exitCode: number) => {
        if (settled) return;
        this.killWorker(`exited with code ${exitCode}`);
        finish({ ok: false, error: `browser_repl runtime exited (code ${exitCode})`, timedOut: false });
      };

      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage({ type: 'run', id, code });
    });
  }
}
