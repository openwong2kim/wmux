import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { codexRuntimeEnv } from './terminalLaunch';

/**
 * Make sure the shared Codex runtime server was started without wmux state.
 *
 * A server started before this change (or by anything else that passed a
 * pane's environment) keeps that environment for its whole life, and every
 * thread it runs inherits it. The server is shared by every Codex session on
 * the account, so it is restarted only when that is safe:
 *
 *   - not running                → start it with the clean environment;
 *   - running and known clean    → nothing to do;
 *   - running, not known clean,
 *     and no Codex pane is live  → `codex app-server daemon stop`, then start;
 *   - running, not known clean,
 *     and a Codex pane is live   → leave it alone and show a one-time notice.
 *
 * "Known clean" means wmux started the server that is running now. The server
 * is identified by its control socket (inode + mtime change when a new server
 * binds it), recorded per account in a small file under the wmux data dir, so
 * the answer survives a daemon restart and goes stale once anything else
 * restarts the server.
 */

export interface CodexServerStatus {
  running: boolean;
  /** Control socket path, when the server reports one. */
  socketPath?: string;
}

export interface CodexRuntimeHygieneDeps {
  /** `codex app-server daemon <sub>` with `env`; resolves stdout, rejects on failure. */
  runDaemon(sub: 'version' | 'start' | 'stop', env: NodeJS.ProcessEnv): Promise<string>;
  /** Number of wmux panes currently running Codex. */
  liveCodexPanes(): number;
  /** Where the per-account "started clean" record lives. */
  recordPath: string;
  /** Identity of the running server's socket, or undefined when it cannot be read. */
  socketIdentity?(socketPath: string): string | undefined;
  notice(paneId: string, title: string, body: string): void;
  log(level: 'info' | 'warn', message: string): void;
}

export const CODEX_RUNTIME_NOTICE_TITLE = 'Codex background server needs a restart';
export const CODEX_RUNTIME_NOTICE_BODY =
  'The shared Codex background server was started before this wmux update and still carries old ' +
  'settings, so commands run through it may not be attributed to the right pane. When no Codex ' +
  'session is running, stop it with `codex app-server daemon stop`; wmux starts a clean one on the ' +
  'next Codex launch.';

export function parseDaemonVersion(stdout: string): CodexServerStatus {
  try {
    const parsed = JSON.parse(stdout.trim()) as { status?: unknown; socketPath?: unknown };
    return {
      running: parsed.status === 'running',
      ...(typeof parsed.socketPath === 'string' ? { socketPath: parsed.socketPath } : {}),
    };
  } catch {
    return { running: false };
  }
}

function defaultSocketIdentity(socketPath: string): string | undefined {
  try {
    const st = fs.statSync(socketPath);
    return `${st.ino}:${Math.trunc(st.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

function readRecord(file: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { accounts?: unknown };
    if (parsed.accounts && typeof parsed.accounts === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.accounts as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch { /* absent or unreadable: nothing known clean */ }
  return {};
}

function writeRecord(file: string, accounts: Record<string, string>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts }), { encoding: 'utf8', mode: 0o600 });
  } catch { /* best-effort: the next launch re-checks */ }
}

export function createCodexRuntimeHygiene(deps: CodexRuntimeHygieneDeps) {
  const socketIdentity = deps.socketIdentity ?? defaultSocketIdentity;
  const inflight = new Map<string, Promise<void>>();
  const noticed = new Set<string>();

  const status = async (env: NodeJS.ProcessEnv): Promise<CodexServerStatus> =>
    parseDaemonVersion(await deps.runDaemon('version', env));

  const markClean = async (key: string, env: NodeJS.ProcessEnv): Promise<void> => {
    const now = await status(env);
    const id = now.running && now.socketPath ? socketIdentity(now.socketPath) : undefined;
    if (!id) return;
    const record = readRecord(deps.recordPath);
    record[key] = id;
    writeRecord(deps.recordPath, record);
  };

  const run = async (paneId: string, key: string, env: NodeJS.ProcessEnv): Promise<void> => {
    const current = await status(env);
    if (!current.running) {
      await deps.runDaemon('start', env);
      await markClean(key, env);
      return;
    }
    const id = current.socketPath ? socketIdentity(current.socketPath) : undefined;
    if (id && readRecord(deps.recordPath)[key] === id) return;
    if (deps.liveCodexPanes() > 0) {
      if (!noticed.has(key)) {
        noticed.add(key);
        deps.notice(paneId, CODEX_RUNTIME_NOTICE_TITLE, CODEX_RUNTIME_NOTICE_BODY);
        deps.log('warn', '[codex-runtime] shared server predates a clean start; Codex panes are live, left running');
      }
      return;
    }
    deps.log('info', '[codex-runtime] restarting the shared server with a clean environment (no Codex pane live)');
    await deps.runDaemon('stop', env);
    await deps.runDaemon('start', env);
    await markClean(key, env);
  };

  return {
    /** Never throws: a failure leaves the launch to the existing start path. */
    async ensureClean(paneId: string, rawEnv: NodeJS.ProcessEnv): Promise<void> {
      const env = codexRuntimeEnv(rawEnv);
      const key = env.CODEX_HOME ?? env.HOME ?? '';
      const existing = inflight.get(key);
      if (existing) return existing;
      const task = run(paneId, key, env).catch((error: unknown) => {
        deps.log('warn', `[codex-runtime] clean-start check failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      inflight.set(key, task);
      try { await task; } finally { inflight.delete(key); }
    },
  };
}

/** `codex app-server daemon <sub>`, bounded like the existing runtime start. */
export function runCodexDaemon(sub: 'version' | 'start' | 'stop', env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('codex', ['app-server', 'daemon', sub], { env, timeout: 15000, maxBuffer: 64000, windowsHide: true },
      (error, stdout) => (error ? reject(new Error(`codex app-server daemon ${sub} failed`)) : resolve(String(stdout))));
  });
}
