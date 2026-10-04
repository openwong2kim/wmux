// One-step GitHub connect: runs `gh auth login --web` headless and reports
// the one-time device code and the outcome to the Git page.
//
// gh keeps the credential in its own store (keychain / hosts.yml); wmux reads
// only gh's output and never sees or stores a token. With piped stdio gh runs
// non-interactively: it prints the code and the device URL and polls GitHub
// itself, without opening a browser (the page opens the URL). Older gh builds
// may still ask for Enter, which is fed once. Success is confirmed by
// `gh auth status`, polled until it passes or the timeout ends the run.
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import {
  GH_DEVICE_URL,
  GH_LOGIN_TIMEOUT_MS,
  asksForEnter,
  cleanGhOutput,
  loginSucceeded,
  parseDeviceCode,
  type GhLoginEvent,
  type GhLoginStartResult,
} from '../../shared/ghDeviceLogin';
import { ghIssueEnv } from './GhIssueService';
import { ghPrService } from './GhPrService';

const HOST = 'github.com';
const LOGIN_ARGS = ['auth', 'login', '--hostname', HOST, '--web', '--git-protocol', 'https'];
const STATUS_ARGS = ['auth', 'status', '--hostname', HOST];
/** How often `gh auth status` is polled once the code is shown. */
export const POLL_MS = 3_000;
/** How long gh may take to print the code before the terminal-tab fallback. */
export const CODE_WAIT_MS = 20_000;
/** How long gh may finish writing its config after success before it is ended. */
export const EXIT_GRACE_MS = 5_000;
const STATUS_TIMEOUT_MS = 10_000;
/** Output kept for parsing; gh prints a few lines. */
const OUTPUT_CAP = 16 * 1024;

/** The slice of a ChildProcess the login uses (mockable in tests). */
export interface LoginChild {
  pid?: number;
  exitCode: number | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: (NodeJS.WritableStream & { writable?: boolean }) | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'spawn', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface GhLoginDeps {
  spawn: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'] }) => LoginChild;
  exec: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; timeout: number; windowsHide: boolean }) => Promise<unknown>;
  /** Re-probe the Git page's gh gate so the lists see the new sign-in at once. */
  regate: () => Promise<unknown>;
  platform: NodeJS.Platform;
  cwd: () => string;
}

/** The env for `gh auth login`: the usual gh env, but prompts allowed (login
 *  needs them) and, on POSIX, a no-op browser so gh never opens one itself. */
export function ghLoginEnv(platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env = ghIssueEnv();
  delete env.GH_PROMPT_DISABLED;
  if (platform !== 'win32') env.GH_BROWSER = 'true';
  return env;
}

const execFileAsync = promisify(execFile);

const defaultDeps: GhLoginDeps = {
  spawn: (cmd, args, opts) => nodeSpawn(cmd, args, opts) as unknown as LoginChild,
  exec: (cmd, args, opts) => execFileAsync(cmd, args, opts),
  regate: () => ghPrService.gate(os.homedir(), HOST, true),
  platform: process.platform,
  cwd: () => os.homedir(),
};

/** The last non-empty lines of gh's output, for a failure message. */
function tailOf(text: string): string {
  const lines = cleanGhOutput(text).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(-3).join(' ').slice(0, 300);
}

interface Run {
  id: number;
  child: LoginChild;
  output: string;
  code: string | null;
  enterSent: boolean;
  polling: boolean;
  finished: boolean;
  timers: Array<ReturnType<typeof setTimeout>>;
  poller: ReturnType<typeof setInterval> | null;
}

export class GhLogin {
  private run: Run | null = null;
  private nextId = 1;
  private sinks = new Set<(e: GhLoginEvent) => void>();

  constructor(private deps: GhLoginDeps = defaultDeps) {}

  /** Subscribe to login events; returns the unsubscribe. */
  onEvent(sink: (e: GhLoginEvent) => void): () => void {
    this.sinks.add(sink);
    return () => { this.sinks.delete(sink); };
  }

  get running(): boolean {
    return this.run !== null;
  }

  private emit(e: GhLoginEvent): void {
    for (const sink of this.sinks) {
      try { sink(e); } catch { /* a broken sink must not stop the login */ }
    }
  }

  private gh(): string {
    return this.deps.platform === 'win32' ? 'gh.exe' : 'gh';
  }

  /** Starts a login, or reuses the one running (re-sending its code). */
  async start(): Promise<GhLoginStartResult> {
    if (this.run) {
      const code = this.run.code;
      if (code) queueMicrotask(() => this.emit({ kind: 'code', code, url: GH_DEVICE_URL }));
      return { ok: true };
    }
    let child: LoginChild;
    try {
      child = this.deps.spawn(this.gh(), LOGIN_ARGS, {
        env: ghLoginEnv(this.deps.platform),
        cwd: this.deps.cwd(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return this.spawnFailure(err);
    }
    const run: Run = {
      id: this.nextId++, child, output: '', code: null, enterSent: false,
      polling: false, finished: false, timers: [], poller: null,
    };
    this.run = run;

    let started = false;
    const spawned = await new Promise<{ ok: true } | { ok: false; err: unknown }>((resolve) => {
      child.on('spawn', () => { started = true; resolve({ ok: true }); });
      child.on('error', (err) => {
        if (!started) { resolve({ ok: false, err }); return; }
        // An error after spawn (rare): the run cannot go on.
        if (this.run === run) this.fail(run, err?.message || 'gh failed');
      });
    });
    if (!spawned.ok) {
      run.finished = true;
      if (this.run === run) this.run = null;
      return this.spawnFailure(spawned.err);
    }
    if (this.run !== run) return { ok: true }; // cancelled while spawning

    const onData = (chunk: Buffer | string) => this.onOutput(run, String(chunk));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    // EPIPE when gh has already exited must not reach main's uncaught handler.
    child.stdin?.on('error', () => undefined);
    child.on('exit', (code) => this.onExit(run, code));
    run.timers.push(setTimeout(() => {
      if (this.run === run && !run.code) this.fail(run, 'gh did not show a sign-in code');
    }, CODE_WAIT_MS));
    run.timers.push(setTimeout(() => {
      if (this.run !== run || run.finished) return;
      run.finished = true;
      this.end(run, true);
      this.emit({ kind: 'timeout' });
    }, GH_LOGIN_TIMEOUT_MS));
    return { ok: true };
  }

  /** Stops the running login (the user closed the dialog). No event. */
  cancel(): void {
    const run = this.run;
    if (!run) return;
    run.finished = true;
    this.end(run, true);
  }

  private spawnFailure(err: unknown): GhLoginStartResult {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: false, message: 'GitHub CLI (gh) is not installed', fallback: false };
    }
    return { ok: false, message: (err as Error)?.message || 'gh could not be started', fallback: true };
  }

  private onOutput(run: Run, chunk: string): void {
    if (this.run !== run || run.finished) return;
    run.output = (run.output + chunk).slice(-OUTPUT_CAP);
    // Whole lines only, so a code split across chunks is never read half.
    const complete = run.output.slice(0, run.output.lastIndexOf('\n') + 1);
    if (!run.code) {
      const code = parseDeviceCode(complete);
      if (code) {
        run.code = code;
        this.emit({ kind: 'code', code, url: GH_DEVICE_URL });
        run.poller = setInterval(() => void this.poll(run), POLL_MS);
      }
    }
    if (!run.enterSent && asksForEnter(run.output)) {
      run.enterSent = true;
      const stdin = run.child.stdin;
      if (stdin && stdin.writable !== false) {
        try { stdin.write('\n'); } catch { /* gh exited meanwhile */ }
      }
    }
    if (run.code && loginSucceeded(run.output)) void this.poll(run);
  }

  private onExit(run: Run, code: number | null): void {
    if (this.run !== run || run.finished) return;
    if (code === 0) {
      void this.poll(run, true);
      return;
    }
    this.fail(run, tailOf(run.output) || `gh exited with code ${code ?? 'unknown'}`);
  }

  /** One `gh auth status`; `last` means gh has exited, so a miss is a failure. */
  private async poll(run: Run, last = false): Promise<void> {
    if (this.run !== run || run.finished || run.polling) return;
    run.polling = true;
    let ok = false;
    try {
      await this.deps.exec(this.gh(), STATUS_ARGS, {
        env: ghIssueEnv(),
        cwd: this.deps.cwd(),
        timeout: STATUS_TIMEOUT_MS,
        windowsHide: true,
      });
      ok = true;
    } catch {
      ok = false;
    }
    run.polling = false;
    if (this.run !== run || run.finished) return;
    if (ok) {
      run.finished = true;
      this.end(run, false);
      void this.deps.regate().catch(() => undefined);
      this.emit({ kind: 'done' });
      return;
    }
    if (last) this.fail(run, tailOf(run.output) || 'gh exited before the sign-in finished');
  }

  private fail(run: Run, message: string): void {
    if (run.finished) return;
    run.finished = true;
    this.end(run, true);
    this.emit({ kind: 'failed', message, fallback: true });
  }

  /** Clears the run. `kill` ends gh now; otherwise it gets a grace period to
   *  finish writing its config and exit on its own. */
  private end(run: Run, kill = true): void {
    for (const t of run.timers) clearTimeout(t);
    run.timers = [];
    if (run.poller) clearInterval(run.poller);
    run.poller = null;
    if (this.run === run) this.run = null;
    if (run.child.exitCode !== null) return;
    if (kill) {
      try { run.child.kill(); } catch { /* already gone */ }
    } else {
      const grace = setTimeout(() => {
        if (run.child.exitCode === null) {
          try { run.child.kill(); } catch { /* already gone */ }
        }
      }, EXIT_GRACE_MS);
      (grace as { unref?: () => void }).unref?.();
    }
  }
}

/** Process-wide: one login at a time, independent of IPC re-registration. */
export const ghLogin = new GhLogin();
