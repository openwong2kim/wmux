import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { spawnAgent, stopAgent } from '../agentProcess';

/** One stdout line longer than this is dropped whole (a protocol frame is far smaller). */
export const CHILD_MAX_LINE_BYTES = 16 * 1024 * 1024;
/** A stdin write that has not drained after this long fails the write. */
export const CHILD_WRITE_TIMEOUT_MS = 15_000;
/** How long a child gets to exit on its own after stdin closes before the tree kill. */
export const CHILD_GRACE_MS = 1_500;
/** How long `stop` waits for the exit after the tree kill. */
export const CHILD_REAP_TIMEOUT_MS = 4_000;
/** After the root exits, its process group gets SIGTERM, then SIGKILL this much later. */
export const CHILD_GROUP_KILL_DELAY_MS = 1_000;

/** A write that did not drain in time: it may still reach the agent later. */
export class ChildWriteTimeoutError extends Error {
  constructor() {
    super('Agent stdin write timed out');
  }
}

export interface ChildHandlers {
  line(line: string): void;
  /** Called once, after the last line. */
  exit(info: { code: number | null; signal: string | null }): void;
  /** stderr, for logs only (bounded by the caller). */
  stderr?(chunk: string): void;
}

export type SpawnChild = (command: string, args: string[], cwd: string, env: Record<string, string>) => ChildProcessWithoutNullStreams;
export type StopChild = (child: ChildProcessWithoutNullStreams) => void;
/** Signal what is left of a process group whose leader exited. */
export type ReapGroup = (pid: number) => void;

/**
 * POSIX: the agent runs as the leader of its own process group (spawnAgent's
 * `detached`), so tool processes it left behind are still in that group after
 * it exits. SIGTERM them, then SIGKILL what remains. Windows has no group to
 * signal once the root is gone; `stop` tree-kills there while the root lives.
 */
export function reapProcessGroup(pid: number): void {
  if (process.platform === 'win32' || pid <= 1) return;
  const signal = (name: NodeJS.Signals): void => {
    try { process.kill(-pid, name); } catch { /* the group is empty */ }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), CHILD_GROUP_KILL_DELAY_MS).unref();
}

/**
 * One agent process speaking newline-delimited JSON on stdio. Spawned in its
 * own process group through `agentProcess.ts` (never a user shell) and torn
 * down with its tree kill, never a bare `child.kill`.
 */
export class ChildBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> = Promise.resolve();
  private done = true;

  constructor(
    private readonly spawnChild: SpawnChild = spawnAgent,
    private readonly stopChild: StopChild = stopAgent,
    private readonly reapGroup: ReapGroup = reapProcessGroup,
  ) {}

  get pid(): number | undefined {
    return this.done ? undefined : this.child?.pid;
  }

  get alive(): boolean {
    return !this.done;
  }

  /** Spawn and start reading. Rejects when the executable cannot be started. */
  async start(command: string, args: string[], cwd: string, env: Record<string, string>, handlers: ChildHandlers): Promise<void> {
    if (this.child) throw new Error('Child already started');
    const child = this.spawnChild(command, args, cwd, env);
    this.child = child;
    this.done = false;
    let resolveExit!: () => void;
    this.exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let dropping = false;
    const flushLines = (final: boolean): void => {
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (dropping) { dropping = false; continue; }
        if (line.trim()) handlers.line(line);
      }
      if (buffer.length > CHILD_MAX_LINE_BYTES) { buffer = ''; dropping = true; }
      if (final && buffer.trim() && !dropping) { handlers.line(buffer); buffer = ''; }
    };
    child.stdout.on('data', (chunk: Buffer) => { buffer += decoder.write(chunk); flushLines(false); });
    child.stderr.on('data', (chunk: Buffer) => handlers.stderr?.(chunk.toString('utf8')));
    // A write to a child that died raises EPIPE on stdin; the exit handler reports it.
    child.stdin.on('error', () => undefined);
    let settled = false;
    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      buffer += decoder.end();
      flushLines(true);
      this.done = true;
      if (child.pid !== undefined) this.reapGroup(child.pid);
      resolveExit();
      handlers.exit({ code, signal });
    };
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => {
        // A spawn failure (ENOENT) never emits 'spawn' or 'exit'.
        finish(null, null);
        reject(error);
      });
    });
    // A later 'error' (a failed signal, a broken pipe on the handle) must not
    // crash the daemon; the exit handler reports the end.
    child.on('error', () => undefined);
    child.once('exit', (code, signal) => {
      // stdout may still hold lines after 'exit'; 'close' follows once it ends.
      child.once('close', () => finish(code, signal));
      setTimeout(() => finish(code, signal), 1_000).unref();
    });
  }

  /**
   * Write one line. Rejects when the child is gone. A write that does not
   * drain in time rejects with ChildWriteTimeoutError and kills the child:
   * the line is still queued and would otherwise reach the agent late, after
   * the caller treated it as failed.
   */
  write(line: string): Promise<void> {
    const child = this.child;
    if (!child || this.done || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new Error('Agent process is not running'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ChildWriteTimeoutError());
        if (!this.done) this.stopChild(child);
      }, CHILD_WRITE_TIMEOUT_MS);
      timer.unref();
      child.stdin.write(`${line}\n`, (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  /**
   * Close stdin (a stream-json agent exits on EOF), give it a moment, then
   * tree-kill whatever is left, and wait until the root process is reaped.
   * Windows tree-kills at once: its tree can only be walked from a live root.
   * Resolves false when the exit was never observed.
   */
  async stop(): Promise<boolean> {
    const child = this.child;
    if (!child || this.done) return true;
    try { child.stdin.end(); } catch { /* already closed */ }
    if (process.platform !== 'win32' && await this.waitExit(CHILD_GRACE_MS)) return true;
    this.stopChild(child);
    return this.waitExit(CHILD_REAP_TIMEOUT_MS);
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.done) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref();
      void this.exited.then(() => { clearTimeout(timer); resolve(true); });
    });
  }
}
