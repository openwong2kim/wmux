import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { codexRuntimeEnv } from './terminalLaunch';

/**
 * The shared, per-account Codex background server, as wmux sees it.
 *
 * wmux never stops or restarts that server: it cannot see every session on it
 * (other terminals, the Codex desktop app, an IDE, another wmux instance).
 * What it does, before every Codex launch it makes, is `ensureStarted`: start
 * the server with no WMUX_* variable when none is running, so wmux never seeds
 * a pane's environment into a fresh server.
 *
 * The result is one explicit state per account:
 *   - 'clean'     the running server is one a wmux `ensureStarted` provably
 *                 created: the control socket was absent (or different)
 *                 before, `start` reported that it started a server, and the
 *                 socket that appeared afterwards is recorded. Any later
 *                 restart by something else changes the socket and the state
 *                 falls back to 'unproven'.
 *   - 'unproven'  a server is running that wmux cannot prove it started clean.
 *                 wmux shows a one-time notice asking the user to restart
 *                 Codex when convenient, and never touches the server.
 *   - 'failed'    the server could not be queried or started.
 *
 * Starts are serialized per account with a lock file shared by every wmux
 * instance of this user, and the "created clean" record lives beside it, so
 * two instances neither race each other's start nor disagree about it.
 */

export type CodexRuntimeState =
  | { kind: 'clean' }
  | { kind: 'unproven' }
  | { kind: 'failed'; reason: string };

export interface CodexSharedRuntimeDeps {
  /** `codex app-server daemon <sub>`; resolves stdout, rejects on failure. */
  runDaemon(sub: 'version' | 'start', env: NodeJS.ProcessEnv): Promise<string>;
  /** Shared by every wmux instance of this user (not suffixed per instance). */
  stateDir: string;
  /** Identity of a socket file (inode + mtime), or undefined when absent. */
  socketIdentity?(socketPath: string): string | undefined;
  notice(paneId: string | undefined, title: string, body: string): void;
  log(level: 'info' | 'warn', message: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

export const CODEX_RUNTIME_NOTICE_TITLE = 'Restart Codex when convenient';
export const CODEX_RUNTIME_NOTICE_BODY =
  'The shared Codex background server was not started by wmux, so wmux cannot confirm which settings it ' +
  'carries. Some Codex actions from wmux panes will be refused until it restarts. When no Codex session is ' +
  'running, run `codex app-server daemon stop`; wmux starts a clean server on the next Codex launch.';

interface DaemonReport { status?: string; socketPath?: string }

/** The report is the last JSON line; a first start prints install progress before it. */
export function parseDaemonReport(stdout: string): DaemonReport {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { status?: unknown; socketPath?: unknown };
      if (!parsed || typeof parsed !== 'object') continue;
      return {
        ...(typeof parsed.status === 'string' ? { status: parsed.status } : {}),
        ...(typeof parsed.socketPath === 'string' ? { socketPath: parsed.socketPath } : {}),
      };
    } catch { /* not the report line */ }
  }
  return {};
}

function defaultSocketIdentity(socketPath: string): string | undefined {
  try {
    const st = fs.statSync(socketPath);
    return `${st.ino}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

/** Account key: the Codex home the server belongs to. */
export function codexAccountHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), '.codex');
}

export function createCodexSharedRuntime(deps: CodexSharedRuntimeDeps) {
  const socketIdentity = deps.socketIdentity ?? defaultSocketIdentity;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lockTimeoutMs = deps.lockTimeoutMs ?? 20_000;
  const lockStaleMs = deps.lockStaleMs ?? 60_000;
  const inflight = new Map<string, Promise<CodexRuntimeState>>();
  const last = new Map<string, CodexRuntimeState>();
  const noticed = new Set<string>();

  const fileFor = (home: string, ext: string) => {
    const hash = crypto.createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 24);
    return path.join(deps.stateDir, `${hash}.${ext}`);
  };

  const readRecord = (home: string): string | undefined => {
    try {
      const parsed = JSON.parse(fs.readFileSync(fileFor(home, 'json'), 'utf8')) as { socket?: unknown };
      return typeof parsed.socket === 'string' ? parsed.socket : undefined;
    } catch {
      return undefined;
    }
  };

  const writeRecord = (home: string, socket: string): void => {
    try {
      fs.mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(fileFor(home, 'json'), JSON.stringify({ version: 1, socket }), { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      deps.log('warn', `[codex-runtime] could not record the clean start: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Exclusive lock across wmux instances; a lock older than lockStaleMs is taken over. */
  const withLock = async <T>(home: string, fn: () => Promise<T>): Promise<T> => {
    const lock = fileFor(home, 'lock');
    fs.mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
    const deadline = now() + lockTimeoutMs;
    for (;;) {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (now() - fs.statSync(lock).mtimeMs > lockStaleMs) { fs.unlinkSync(lock); continue; }
        } catch { continue; }
        if (now() > deadline) throw new Error('timed out waiting for another Codex start');
        await sleep(100);
      }
    }
    try { return await fn(); } finally { try { fs.unlinkSync(lock); } catch { /* already gone */ } }
  };

  const decide = async (home: string, env: NodeJS.ProcessEnv): Promise<CodexRuntimeState> => {
    // `version` fails outright when no server has ever run for this account;
    // `start` below is idempotent, so a failed query only loses the shortcut.
    const before = await deps.runDaemon('version', env).then(parseDaemonReport, (): DaemonReport => ({}));
    const socketPath = before.socketPath ?? path.join(home, 'app-server-control', 'app-server-control.sock');
    if (before.status === 'running') {
      const id = socketPath ? socketIdentity(socketPath) : undefined;
      return id && readRecord(home) === id ? { kind: 'clean' } : { kind: 'unproven' };
    }
    const socketBefore = socketPath ? socketIdentity(socketPath) : undefined;
    const started = parseDaemonReport(await deps.runDaemon('start', env));
    const startedPath = started.socketPath ?? socketPath;
    const socketAfter = startedPath ? socketIdentity(startedPath) : undefined;
    // Proof of creation: this call's start says it started the server, and the
    // socket it serves is new. Anything else (a start that raced ours from
    // outside wmux, a missing socket) stays unproven.
    if (started.status === 'started' && socketAfter && socketAfter !== socketBefore) {
      writeRecord(home, socketAfter);
      return { kind: 'clean' };
    }
    return started.status ? { kind: 'unproven' } : { kind: 'failed', reason: 'start reported no status' };
  };

  const ensureStarted = async (paneId: string | undefined, rawEnv: NodeJS.ProcessEnv): Promise<CodexRuntimeState> => {
    const env = codexRuntimeEnv(rawEnv);
    const home = codexAccountHome(env);
    const existing = inflight.get(home);
    if (existing) return existing;
    const task = (async (): Promise<CodexRuntimeState> => {
      let state: CodexRuntimeState;
      try {
        state = await withLock(home, () => decide(home, env));
      } catch (error) {
        state = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
      }
      last.set(home, state);
      if (state.kind === 'failed') deps.log('warn', `[codex-runtime] ${state.reason}`);
      if (state.kind === 'unproven' && !noticed.has(home)) {
        noticed.add(home);
        deps.log('warn', '[codex-runtime] shared Codex server was not started by wmux; left running');
        deps.notice(paneId, CODEX_RUNTIME_NOTICE_TITLE, CODEX_RUNTIME_NOTICE_BODY);
      }
      return state;
    })();
    inflight.set(home, task);
    try { return await task; } finally { inflight.delete(home); }
  };

  return {
    ensureStarted,
    /** Last state seen for an account; undefined when never checked. */
    state(codeHome: string | undefined): CodexRuntimeState | undefined {
      return last.get(codeHome ?? codexAccountHome(process.env));
    },
  };
}

export type CodexSharedRuntime = ReturnType<typeof createCodexSharedRuntime>;

/** `codex app-server daemon <sub>`, bounded like the existing runtime start. */
export function runCodexDaemon(sub: 'version' | 'start', env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('codex', ['app-server', 'daemon', sub], { env, timeout: 15000, maxBuffer: 64000, windowsHide: true },
      (error, stdout) => (error ? reject(new Error(`codex app-server daemon ${sub} failed`)) : resolve(String(stdout))));
  });
}
