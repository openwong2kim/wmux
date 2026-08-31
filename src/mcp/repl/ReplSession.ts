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
import * as fs from 'fs';
import * as path from 'path';
import { buildGatedAutomationEnv, withheldCredentialNames } from '../../shared/envFilter';
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
/** Quiet window the pipes must show before an eval's output is considered complete. */
const DRAIN_QUIET_MS = 20;
/** Ceiling on draining, so a still-chattering background timer cannot stall the tool. */
const DRAIN_MAX_MS = 250;
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
function resolveNodeBinary(): { command: string; electronRunAsNode: boolean } {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ReplSessionOptions {
  readonly name: string;
  readonly cwd: string;
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
  private lastChunkAt = 0;
  private out = new OutputBuffer(OUTPUT_CAP_BYTES);
  private err = new OutputBuffer(OUTPUT_CAP_BYTES);
  private pending: ((message: RunnerMessage) => void) | null = null;
  /** Id of the eval in flight; only a reply carrying it may settle. */
  private pendingId: number | null = null;
  private readonly ready: Promise<void>;

  constructor(options: ReplSessionOptions) {
    this.name = options.name;
    this.cwd = options.cwd;

    // Validated before spawn so a bad cwd reads as a bad cwd, not as an opaque
    // ENOENT from a process that never started.
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

    child.stdout?.on('data', (chunk: Buffer) => {
      this.lastChunkAt = Date.now();
      this.out.append(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.lastChunkAt = Date.now();
      this.err.append(chunk);
    });
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
      const message = raw as RunnerMessage;
      // Match the id of the eval actually in flight. User code shares this
      // process's global scope and therefore its `process.send`, so without the
      // check a script could post its own completion, collect the answer early,
      // AND keep the hard-deadline timer cleared while it spins forever in the
      // shared broker. A late reply from an abandoned earlier eval is dropped by
      // the same test.
      if (message?.id === undefined || message.id !== this.pendingId) return;
      this.pendingId = null;
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

  private markDead(reason: string): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.deathReason = reason;
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
   * Wait for the pipes to go quiet. The IPC result and the stdout bytes travel
   * on different channels, so the completion message can land before the last
   * `console.log` has been read — returning immediately would drop the tail of
   * the output the caller is asking for.
   */
  private async drain(): Promise<void> {
    const start = Date.now();
    await delay(DRAIN_QUIET_MS);
    while (Date.now() - start < DRAIN_MAX_MS) {
      if (Date.now() - this.lastChunkAt >= DRAIN_QUIET_MS) return;
      await delay(5);
    }
  }

  private takeOutput(): { stdout: TruncatedText; stderr: TruncatedText } {
    const stdout = this.out.render();
    const stderr = this.err.render();
    this.out = new OutputBuffer(OUTPUT_CAP_BYTES);
    this.err = new OutputBuffer(OUTPUT_CAP_BYTES);
    return { stdout, stderr };
  }

  async run(code: string, timeoutMs: number): Promise<ReplEvalOutcome> {
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

    // Anything buffered before this call came from a timer or handle left
    // running by an EARLIER eval. Take it now so it is reported as background
    // rather than blended into this eval's output, where the agent would read
    // it as its own code's doing.
    const background = this.takeOutput();
    // Reset the drain clock so quiet is measured from THIS eval. Left at the
    // previous eval's value it is always already stale, which makes the quiet
    // test vacuously true and defeats the drain entirely.
    this.lastChunkAt = Date.now();

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
        this.child?.send({ id, code, timeoutMs });
      } catch (error) {
        clearTimeout(hard);
        this.destroy(`the REPL process could not be reached: ${String(error)}`);
      }
    });

    await this.drain();
    const { stdout, stderr } = this.takeOutput();
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
