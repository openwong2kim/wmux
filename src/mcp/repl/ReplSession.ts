/**
 * One persistent Node runtime, owned by one MCP connection.
 *
 * Why a child process and not `node:vm` in this process: REPL code is code the
 * caller wrote seconds ago and has never run. It calls `process.exit()`, it
 * blows the heap, it throws out of a native callback. In the broker topology
 * this process hosts EVERY agent's MCP connection, so an in-process runtime
 * would turn one agent's typo into every agent's outage. A child process makes
 * the blast radius exactly one session.
 *
 * Lifecycle, and every way a session ends:
 *
 *      spawn ──► starting ──ready──► idle ◄────────────┐
 *                   │                 │               │
 *                   │              run()               │ eval completes
 *                   │                 ▼               │
 *                   │               busy ─────────────┘
 *                   │                 │
 *                   └────────┬────────┴──── hard deadline (SIGKILL)
 *                            │         ├──── child exited on its own
 *                            │         ├──── the registry's idle sweep
 *                            ▼         └──── reset() / dispose()
 *                          dead  ── state is gone; the registry respawns clean
 *
 * `dead` is always reported, never papered over: an agent that believes a
 * variable survived when it did not writes code against a fiction.
 */
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { buildGatedAutomationEnv, withheldCredentialNames } from '../../shared/envFilter';
import type { BridgeCall } from '../browser-repl/bridge';
import {
  RunHintCollector,
  RunImageCollector,
  lateCallRefusal,
  type RunImage,
} from '../browser-repl/runCollect';
import { win32AliasedName } from '../wslPaths';
import { buildRunnerBootstrap } from './replRunnerSource';
import { OutputBuffer, truncateText, type TruncatedText } from './truncate';

/** Per-eval retention for each of stdout and stderr. */
export const OUTPUT_CAP_BYTES = 64 * 1024;
/** Retention for the inspected return value. */
export const RESULT_CAP_BYTES = 16 * 1024;
/**
 * How long past the caller's timeout the child gets before SIGKILL.
 *
 * The vm watchdog inside the child stops synchronous runaways on its own, so
 * this grace only has to cover the watchdog's message hop back. It is generous
 * anyway: if a loaded broker delays that hop past the grace, a stop that should
 * have KEPT the session escalates into a kill that destroys it, and losing a
 * session's state is far worse than waiting an extra second for a genuine hang.
 */
export const HARD_KILL_GRACE_MS = 2_000;
/**
 * How long a run waits, after its result, for its end mark on each pipe. A
 * backstop only: a mark ends the wait as soon as its bytes are read, and a pipe
 * that closes ends it too. It bounds the case where neither happens, such as a
 * process the run started that still holds the pipe after the runtime died.
 */
const END_MARK_WAIT_MS = 2_000;
/** How long the child gets to report `ready` before the spawn is called failed. */
const READY_TIMEOUT_MS = 10_000;

export type ReplSessionState = 'starting' | 'idle' | 'busy' | 'dead';

export interface ReplEvalOutcome {
  readonly ok: boolean;
  /** util.inspect of the completed value, truncated. Absent on failure. */
  readonly result?: TruncatedText;
  /** Stack or message. Absent on success. */
  readonly error?: string;
  readonly stdout: TruncatedText;
  readonly stderr: TruncatedText;
  readonly elapsedMs: number;
  /**
   * Set when this eval also destroyed the session (hard deadline, child exit).
   * The caller MUST surface it: session state did not survive.
   */
  readonly fatal?: string;
  /** True when the vm watchdog stopped a synchronous runaway; state survived. */
  readonly timedOut?: boolean;
  /** Set when a `let`/`const` collided with a still-live binding. */
  readonly remedy?: string;
  /**
   * Output that arrived BEFORE this eval started — a timer or handle left
   * running by an earlier one. Reported separately so the agent never reads
   * another eval's output as its own code's doing.
   */
  readonly background?: string;
  /** Present when the run made `browser.*` calls, or tried to. */
  readonly browser?: ReplBrowserReport;
}

/**
 * The `browser` object one run gets.
 *
 * `call` null means the tool is installed in the child (so `browser.X` exists
 * and the error is about authority, not a typo) while every call is refused
 * with `refusal` — the shape the non-full profiles take.
 */
export interface ReplBrowserBinding {
  /** Names installed on the child's `browser` object. */
  readonly tools: readonly string[];
  readonly call: BridgeCall | null;
  readonly refusal: string;
}

export interface ReplBrowserReport {
  /** Browser calls the run's own eval made, refusals included. */
  readonly calls: number;
  readonly hints: readonly string[];
  readonly hintsElided: number;
  readonly images: readonly RunImage[];
  readonly imagesElided: number;
}

/** One run's browser state: the binding plus what its calls collected. */
interface BrowserRun {
  readonly id: number;
  readonly binding: ReplBrowserBinding;
  readonly hints: RunHintCollector;
  readonly images: RunImageCollector;
  readonly inFlight: Set<Promise<unknown>>;
  calls: number;
}

interface BrowserCallMessage {
  readonly type: 'browserCall';
  readonly callId?: unknown;
  readonly runId?: unknown;
  readonly name?: unknown;
  readonly args?: unknown;
}

interface RunnerMessage {
  readonly id?: number;
  readonly ready?: boolean;
  readonly ok?: boolean;
  readonly result?: string;
  readonly error?: string;
  /** Runner's own classification. Never re-derived from `error` text. */
  readonly kind?: 'timeout' | 'redeclare';
}

/** Node binary plus whether Electron needs telling to behave as one. */
export function resolveNodeBinary(): { command: string; electronRunAsNode: boolean } {
  const base = path.basename(process.execPath).toLowerCase();
  const isPlainNode = base === 'node' || base === 'node.exe';
  return { command: process.execPath, electronRunAsNode: !isPlainNode };
}

/**
 * The environment a REPL child inherits.
 *
 * Starts from the same gated-automation filter every agent pane spawn uses, so
 * the REPL is never a wider hole than the shell the caller already drives with
 * `terminal_send`: wmux/Electron internals and credential-shaped names are
 * dropped. Then it drops `CLAUDE*` / `ANTHROPIC*` / `AI_AGENT` on top, for the
 * reason `scrubBrainSpawnEnv` documents — wmux is routinely launched from
 * inside a Claude Code session, and passing that session's markers into a child
 * makes any nested agent silently stop persisting its transcript, while an
 * ambient API key would quietly move work onto metered auth.
 */
export function buildReplChildEnv(
  base: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; withheldCredentials: string[] } {
  const env = buildGatedAutomationEnv(base);
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('CLAUDE') || upper.startsWith('ANTHROPIC') || upper === 'AI_AGENT') {
      delete env[key];
    }
  }
  return { env, withheldCredentials: withheldCredentialNames(base) };
}

/**
 * One of the child's output pipes, split at a run's end mark.
 *
 * The eval result travels on the IPC channel and the output on a pipe, and
 * nothing orders the two: on darwin a large write is still queued in the pipe
 * when the result arrives. So the runner writes the run's mark on stdout and
 * on stderr just before it sends a result, and a run's output is exactly what
 * precedes the mark on each pipe. Bytes after it were written after the
 * result, by code the run left running, and are the next run's background.
 * The mark itself is stripped, also when it arrives split across chunks.
 */
export class MarkedOutput {
  private current = new OutputBuffer(OUTPUT_CAP_BYTES);
  /** The run's output, complete, once its mark has arrived. */
  private sealed: OutputBuffer | null = null;
  private mark: Buffer | null = null;
  /** A chunk's tail that may be the start of the mark. */
  private held = Buffer.alloc(0);
  private ended = false;

  constructor(private readonly onSettled: () => void = () => undefined) {}

  /** Nothing more of the run's output can arrive: its mark did, the pipe ended, or no mark is awaited. */
  get settled(): boolean {
    return this.mark === null || this.ended;
  }

  /** Start a run: its output ends at `mark`. */
  expect(mark: Buffer): void {
    this.mark = mark;
    this.sealed = null;
    this.held = Buffer.alloc(0);
  }

  append(chunk: Buffer): void {
    const mark = this.mark;
    if (!mark) {
      this.current.append(chunk);
      return;
    }
    const data = this.held.length > 0 ? Buffer.concat([this.held, chunk]) : chunk;
    const at = data.indexOf(mark);
    if (at === -1) {
      let keep = Math.min(mark.length - 1, data.length);
      while (keep > 0 && !data.subarray(data.length - keep).equals(mark.subarray(0, keep))) keep--;
      if (data.length > keep) this.current.append(data.subarray(0, data.length - keep));
      this.held = Buffer.from(data.subarray(data.length - keep));
      return;
    }
    if (at > 0) this.current.append(data.subarray(0, at));
    this.sealed = this.current;
    this.current = new OutputBuffer(OUTPUT_CAP_BYTES);
    this.mark = null;
    this.held = Buffer.alloc(0);
    const rest = data.subarray(at + mark.length);
    if (rest.length > 0) this.current.append(rest);
    this.onSettled();
  }

  /** The pipe closed: a mark still awaited will not come. */
  end(): void {
    this.ended = true;
    this.onSettled();
  }

  /**
   * The run's output, or with no run open everything since the last take, and
   * stop awaiting a mark. Bytes held back as a possible mark start were output.
   */
  take(): TruncatedText {
    if (this.held.length > 0) this.current.append(this.held);
    this.held = Buffer.alloc(0);
    this.mark = null;
    const taken = this.sealed ?? this.current;
    if (this.sealed) this.sealed = null;
    else this.current = new OutputBuffer(OUTPUT_CAP_BYTES);
    return taken.render();
  }
}

export interface ReplSessionOptions {
  readonly name: string;
  readonly cwd: string;
  /**
   * Where browser calls left running by a finished run are tracked. The
   * registry passes one set per connection so they outlive this session.
   */
  readonly browserStragglers?: Set<Promise<unknown>>;
}

export class ReplSession {
  readonly name: string;
  readonly cwd: string;
  readonly createdAt = Date.now();
  readonly withheldCredentials: string[];

  private child: ChildProcess | null = null;
  private state: ReplSessionState = 'starting';
  private deathReason: string | null = null;
  private nextEvalId = 1;
  private evalCount = 0;
  private lastUsedAt = Date.now();
  /** Called when a pipe settles while a run waits for its end marks. */
  private onPipeSettled: (() => void) | null = null;
  private readonly out = new MarkedOutput(() => this.onPipeSettled?.());
  private readonly err = new MarkedOutput(() => this.onPipeSettled?.());
  private pending: ((message: RunnerMessage) => void) | null = null;
  /** Id of the eval in flight; only a reply carrying it may settle. */
  private pendingId: number | null = null;
  /** Browser state of the eval in flight, if it was given a binding. */
  private browserRun: BrowserRun | null = null;
  /** Browser calls started by an eval that is over; the next run waits for them. */
  private readonly stragglingBrowserCalls: Set<Promise<unknown>>;
  private readonly ready: Promise<void>;

  constructor(options: ReplSessionOptions) {
    this.name = options.name;
    this.cwd = options.cwd;
    this.stragglingBrowserCalls = options.browserStragglers ?? new Set();

    // Validated before spawn so a bad cwd reads as a bad cwd, not as an opaque
    // ENOENT from a process that never started.
    //
    // On Windows, Node stats through the `\\?\` namespace but CreateProcess
    // normalizes the working directory: with `D:\x\repo.` and `D:\x\repo`
    // both on disk (a WSL caller can create the first), the stat below finds
    // `repo.` and the runtime starts in `repo`. Refuse such a name outright.
    if (process.platform === 'win32') {
      const aliased = win32AliasedName(path.resolve(options.cwd));
      if (aliased !== undefined) {
        throw new Error(
          `cwd has a name (${JSON.stringify(aliased)}) that Windows reads as a different directory ` +
            `(a trailing dot or space, or a device name): ${options.cwd}`,
        );
      }
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(options.cwd);
    } catch {
      throw new Error(`cwd does not exist: ${options.cwd}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`cwd is not a directory: ${options.cwd}`);
    }

    const { command, electronRunAsNode } = resolveNodeBinary();
    const { env, withheldCredentials } = buildReplChildEnv();
    this.withheldCredentials = withheldCredentials;
    // Re-added AFTER the filter (which strips it as an internal). Setting it
    // here rather than leaving it in place keeps the filter honest: nothing
    // reaches the child that was not deliberately put back.
    if (electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1';

    const child = spawn(command, ['-e', buildRunnerBootstrap()], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.out.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.err.append(chunk));
    child.stdout?.on('close', () => this.out.end());
    child.stderr?.on('close', () => this.err.end());
    child.on('error', (error) => this.markDead(`failed to spawn the REPL runtime: ${error.message}`));
    child.on('exit', (code, signal) => {
      this.markDead(
        this.deathReason ??
          `the REPL process exited on its own (code ${String(code)}, signal ${String(signal)})`,
      );
    });

    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.destroy('the REPL runtime did not come up within 10s');
        reject(new Error('the REPL runtime did not come up within 10s'));
      }, READY_TIMEOUT_MS);
      timer.unref?.();
      const onMessage = (raw: unknown) => {
        const message = raw as RunnerMessage;
        if (message?.ready) {
          clearTimeout(timer);
          child.off('message', onMessage);
          if (this.state === 'starting') this.state = 'idle';
          resolve();
        }
      };
      child.on('message', onMessage);
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(this.deathReason ?? 'the REPL runtime exited during startup'));
      });
    });
    // A rejection is delivered through run(); nothing else awaits this promise,
    // and an unobserved rejection would take the whole MCP server down.
    this.ready.catch(() => { /* surfaced by run() */ });

    child.on('message', (raw: unknown) => {
      if ((raw as BrowserCallMessage | null)?.type === 'browserCall') {
        this.onBrowserCall(raw as BrowserCallMessage);
        return;
      }
      const message = raw as RunnerMessage;
      // Match the id of the eval actually in flight. User code shares this
      // process's global scope and therefore its `process.send`, so without the
      // check a script could post its own completion, collect the answer early,
      // AND keep the hard-deadline timer cleared while it spins forever in the
      // shared broker. A late reply from an abandoned earlier eval is dropped by
      // the same test.
      if (message?.id === undefined || message.id !== this.pendingId) return;
      this.pendingId = null;
      // The run is over the moment its result arrives, not after the output
      // drain: a timer firing in that window must not pass as this run's call.
      this.endBrowserRun();
      const settle = this.pending;
      this.pending = null;
      settle?.(message);
    });
  }

  get status(): ReplSessionState {
    return this.state;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get evals(): number {
    return this.evalCount;
  }

  get lastUsed(): number {
    return this.lastUsedAt;
  }

  get dead(): boolean {
    return this.state === 'dead';
  }

  get busy(): boolean {
    return this.state === 'busy';
  }

  /** Why the session died, for the message the caller reads. */
  get diedBecause(): string | null {
    return this.deathReason;
  }

  /**
   * Execute one `browser.X(args)` the child asked for.
   *
   * Everything here treats the message as forgeable: user code shares the
   * child's `process.send`, so the run id, the tool name, and the args are all
   * re-checked on arrival rather than trusted because the child sent them. A
   * call that does not belong to the eval in flight is REFUSED with a reason
   * rather than dropped — a dropped reply is a promise that never settles.
   */
  private onBrowserCall(message: BrowserCallMessage): void {
    const callId = message.callId;
    if (typeof callId !== 'number') return;
    const name = typeof message.name === 'string' ? message.name : '?';
    const reply = (body: { ok: boolean; value?: unknown; error?: string }): void => {
      try {
        this.child?.send({ type: 'browserResult', callId, ...body });
      } catch {
        /* the child is gone; its promise dies with it */
      }
    };
    const run = this.browserRun;
    if (!run || message.runId !== run.id) {
      reply({ ok: false, error: lateCallRefusal(name, 'repl_run') });
      return;
    }
    if (!run.binding.call) {
      reply({ ok: false, error: `browser.${name}: ${run.binding.refusal}` });
      return;
    }
    if (!run.binding.tools.includes(name)) {
      reply({ ok: false, error: `browser.${name} is not available inside repl_run` });
      return;
    }
    const args =
      message.args !== null && typeof message.args === 'object' && !Array.isArray(message.args)
        ? (message.args as Record<string, unknown>)
        : {};
    run.calls += 1;
    const index = run.calls;
    const pending = run.binding.call(name, args).then(
      (outcome) => {
        if (!outcome.ok) {
          reply({ ok: false, error: outcome.error });
          return;
        }
        // Only while this run still owns the result: a hint or an image id
        // collected afterwards would name nothing the caller ever reads.
        if (this.browserRun === run) run.hints.record(outcome.hints, index);
        const mark = run.images.offer(outcome.images, index);
        reply({ ok: true, value: { ...outcome.value, ...mark } });
      },
      (error: unknown) => {
        // The bridge reports tool failures as outcomes; a rejection is a bug in
        // the bridge itself. Still answer, or the script hangs.
        reply({
          ok: false,
          error: `browser.${name}: bridge failure: ${error instanceof Error ? error.message : String(error)}`,
        });
      },
    );
    run.inFlight.add(pending);
    void pending.finally(() => run.inFlight.delete(pending));
  }

  /**
   * Close the binding: later calls are refused, and this run's unfinished
   * browser calls go to the straggler set the next run waits on. Idempotent.
   */
  private endBrowserRun(): void {
    const run = this.browserRun;
    this.browserRun = null;
    if (!run) return;
    run.images.close();
    const stragglers = this.stragglingBrowserCalls;
    for (const pending of run.inFlight) {
      stragglers.add(pending);
      void pending.finally(() => stragglers.delete(pending));
    }
  }

  private static browserReport(run: BrowserRun | null): ReplBrowserReport | undefined {
    if (!run || run.calls === 0) return undefined;
    return {
      calls: run.calls,
      hints: run.hints.lines,
      hintsElided: run.hints.elided,
      images: run.images.images,
      imagesElided: run.images.elided,
    };
  }

  private markDead(reason: string): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.deathReason = reason;
    this.endBrowserRun();
    const settle = this.pending;
    this.pending = null;
    this.pendingId = null;
    settle?.({ ok: false, error: reason });
  }

  /** Kill the child and mark the session dead. Idempotent. */
  destroy(reason: string): void {
    if (this.state !== 'dead') this.deathReason = reason;
    const child = this.child;
    this.child = null;
    this.markDead(reason);
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * Wait for the run's end mark on both pipes (see MarkedOutput). The IPC
   * result can land before the last `console.log` has been read; finishing
   * then would drop the tail of the output the caller is asking for and report
   * it as the next run's background.
   */
  private awaitEndMarks(): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.onPipeSettled = null;
        resolve();
      };
      const timer = setTimeout(finish, END_MARK_WAIT_MS);
      this.onPipeSettled = () => {
        if (this.out.settled && this.err.settled) finish();
      };
      this.onPipeSettled();
    });
  }

  private takeOutput(): { stdout: TruncatedText; stderr: TruncatedText } {
    return { stdout: this.out.take(), stderr: this.err.take() };
  }

  async run(
    code: string,
    timeoutMs: number,
    browserBinding?: ReplBrowserBinding,
  ): Promise<ReplEvalOutcome> {
    const started = Date.now();
    await this.ready;
    if (this.state === 'dead') {
      throw new Error(this.deathReason ?? 'the REPL session is gone');
    }
    if (this.state === 'busy') {
      throw new Error('this REPL session is already running code');
    }

    this.state = 'busy';
    this.evalCount += 1;
    this.lastUsedAt = Date.now();
    const id = this.nextEvalId++;

    // A browser call an earlier run left running cannot be cancelled, only
    // waited for: letting it land mid-way through THIS run's steps is exactly
    // the interleaving (its click between this run's snapshot and click) that
    // makes a scripted flow unreproducible. Bounded by this run's own timeout,
    // or a handler that never settles would pin every later run.
    if (this.stragglingBrowserCalls.size > 0) {
      const waitedOn = [...this.stragglingBrowserCalls];
      let waitTimer: NodeJS.Timeout | undefined;
      const landed = await Promise.race([
        Promise.allSettled(waitedOn).then(() => true),
        new Promise<boolean>((resolve) => {
          waitTimer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      clearTimeout(waitTimer);
      if (!landed) {
        // A call that never settles cannot be cancelled either. Waiting on it
        // again would fail every later run the same way, so this run pays for
        // it once and the calls are no longer tracked.
        for (const pending of waitedOn) this.stragglingBrowserCalls.delete(pending);
        this.state = 'idle';
        const empty = new OutputBuffer(OUTPUT_CAP_BYTES).render();
        return {
          ok: false,
          error:
            `a browser call started by an earlier run did not finish within ${timeoutMs}ms and was ` +
            'abandoned (it cannot be cancelled and may still land later); this run did not start — run it again',
          stdout: empty,
          stderr: empty,
          elapsedMs: Date.now() - started,
        };
      }
    }
    let browserRun: BrowserRun | null = null;
    if (browserBinding) {
      browserRun = this.browserRun = {
        id,
        binding: browserBinding,
        hints: new RunHintCollector(),
        images: new RunImageCollector(),
        inFlight: new Set(),
        calls: 0,
      };
    }

    // Anything buffered before this call came from a timer or handle left
    // running by an EARLIER eval. Take it now so it is reported as background
    // rather than blended into this eval's output, where the agent would read
    // it as its own code's doing.
    const background = this.takeOutput();
    // Armed before the eval is sent: the mark can reach a pipe before the
    // result reaches the IPC channel.
    const mark = Buffer.from(`\0wmux-repl-end:${randomUUID()}\0`);
    this.out.expect(mark);
    this.err.expect(mark);

    const message = await new Promise<RunnerMessage>((resolve) => {
      this.pending = resolve;
      this.pendingId = id;
      // Layer two of the timeout. The child's vm watchdog cannot see a promise
      // that never settles or a blocked native call, so the only reliable stop
      // is killing the process — which is why this costs the session's state
      // and the vm watchdog (which does not) is tried first.
      const hard = setTimeout(() => {
        this.destroy(
          `hard timeout: the code did not finish within ${timeoutMs}ms and did not stop when asked, ` +
            'so the REPL process was killed and all session state was lost',
        );
      }, timeoutMs + HARD_KILL_GRACE_MS);
      hard.unref?.();
      const settle = this.pending;
      this.pending = (msg) => {
        clearTimeout(hard);
        settle?.(msg);
      };
      try {
        this.child?.send({
          id,
          code,
          timeoutMs,
          mark: mark.toString(),
          ...(browserBinding && { browser: browserBinding.tools }),
        });
      } catch (error) {
        clearTimeout(hard);
        this.destroy(`the REPL process could not be reached: ${String(error)}`);
      }
    });

    await this.awaitEndMarks();
    const { stdout, stderr } = this.takeOutput();
    this.endBrowserRun();
    const browser = ReplSession.browserReport(browserRun);
    const elapsedMs = Date.now() - started;
    const backgroundText =
      [background.stdout.text, background.stderr.text].filter(Boolean).join('') || undefined;

    // Read through the getter: the assignment above narrows `this.state` to
    // 'busy' for the checker, but the eval could have killed the session while
    // we were awaiting it.
    if (this.dead) {
      return {
        ok: false,
        error: this.deathReason ?? 'the REPL session ended',
        fatal: this.deathReason ?? 'the REPL session ended',
        stdout,
        stderr,
        background: backgroundText,
        elapsedMs,
        browser,
      };
    }

    this.state = 'idle';
    this.lastUsedAt = Date.now();

    if (message.ok) {
      return {
        ok: true,
        result: truncateText(message.result ?? 'undefined', RESULT_CAP_BYTES),
        stdout,
        stderr,
        background: backgroundText,
        elapsedMs,
        browser,
      };
    }

    const error = message.error ?? 'unknown REPL error';
    return {
      ok: false,
      error,
      stdout,
      stderr,
      background: backgroundText,
      elapsedMs,
      browser,
      // Trust the runner's classification, never a substring of `error`: that
      // text is whatever the caller's own code threw, so sniffing it lets a
      // script make the tool announce a watchdog stop that never happened.
      timedOut: message.kind === 'timeout' || undefined,
      remedy: message.kind === 'redeclare'
        ? 'That name is already bound in this session. `let`/`const` cannot be re-declared ' +
          'against a live binding — assign without a keyword (`x = ...`) to update it, or call ' +
          'repl_reset to start from a clean runtime.'
        : undefined,
    };
  }
}
