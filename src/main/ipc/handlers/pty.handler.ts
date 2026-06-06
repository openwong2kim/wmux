import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { PTYManager } from '../../pty/PTYManager';
import { PTYBridge } from '../../pty/PTYBridge';
import { DaemonClient } from '../../DaemonClient';
import { IPC, getPidMapDir, ENV_KEYS } from '../../../shared/constants';
import { sanitizePtyText } from '../../../shared/types';
import { resolveSpawnEnv } from '../../pty/resolveSpawnEnv';
import { scheduleInitialCommand } from './scheduleInitialCommand';
import { updateCwd } from './metadata.handler';
import { markResize, markUserWrite } from '../../notification/idleSuppression';
import { wrapHandler } from '../wrapHandler';

/**
 * Allowed shell basenames (compared case-insensitively).
 * Only these executables may be spawned via IPC.
 * Windows entries keep `.exe`; Unix entries (mac/linux) are bare basenames
 * so that detector paths like `/bin/zsh` or `/opt/homebrew/bin/pwsh` resolve.
 */
const ALLOWED_SHELLS = new Set([
  // Windows
  'powershell.exe',
  'pwsh.exe',
  'cmd.exe',
  'bash.exe',
  'wsl.exe',
  'git-bash.exe',
  'sh.exe',
  // Unix (mac/linux)
  'zsh',
  'bash',
  'fish',
  'pwsh',
  'sh',
]);

function isAllowedShell(shell: string): boolean {
  const basename = path.basename(shell).toLowerCase();
  return ALLOWED_SHELLS.has(basename);
}

/**
 * Recovery PTY mute race retry (v2.9.0-rc.2 fix for the symptom reported
 * during v2.9.0-rc.1 dogfood).
 *
 * After a reboot, recovery sessions spawn with `deferOutput=true` so the
 * bridge starts muted. `DaemonSessionManager.resizeSession` is what
 * unmutes the bridge (Line 290-298) — but only after `attachSession`
 * has registered the session. If useTerminal's first `pty:resize` RPC
 * lands before `daemon.attachSession` completes, the daemon throws
 * "Session 'X' not found", and a one-shot swallow would leave the
 * bridge muted forever. Symptom to the user: input reaches the PTY,
 * PowerShell processes it, but every echo and command output gets
 * dropped. Looks like "input doesn't work" on every recovered pane.
 *
 * The retry rides out the attach race without reordering daemon-side
 * attach/resize. That ordering reorder (commit 7d5fee3) was reverted
 * in e032ae3 because it hit an OSC 7 ConPTY interaction — see the
 * e032ae3 revert message for the v2.9.1 fix plan; this is the
 * "retry-on-not-found in pty.handler.ts pty:resize" option.
 *
 * Retry budget: 50 attempts * 20ms = up to ~1s total. The initial
 * v2.9.0-rc.2 try (5 * 20 = 80ms) was empirically too short during
 * dogfood — daemon attach can stretch into hundreds of ms or more
 * on a cold-restart, especially if multiple panes mass-mount and
 * each invokes attach back-to-back. 1s gives real headroom while
 * staying well under any human-perceptible delay.
 *
 * Cost in steady state: zero. Retry only fires on "not found",
 * which only happens during the attach window. A normal resize
 * (drag, splitter move, font change) returns on attempt 0.
 *
 * The final attempt's not-found is still swallowed gracefully so
 * post-dispose / reconciliation races keep the prior behavior
 * (the silent return existed for a reason — see git blame).
 *
 * A diagnostic console line fires whenever the retry actually rode
 * out >=1 attempt, so we can measure real-world attach latency from
 * dogfood logs and decide whether the budget needs further tuning
 * or whether option (2) — renderer-side attach-await-then-fit — is
 * worth the larger blast radius.
 */
const RESIZE_RETRY_ATTEMPTS = 50;
const RESIZE_RETRY_DELAY_MS = 20;

/**
 * Startup-command scheduling lives in ./scheduleInitialCommand (electron-free,
 * unit-tested). The wiring below supplies the per-mode writer + an exhaustion
 * log so a command that never gets delivered leaves a diagnostic trail.
 */

/**
 * Validate and resolve cwd. Returns undefined if invalid.
 * Shared by both daemon and local modes.
 */
function validateCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const resolved = path.resolve(cwd);
  // Block UNC paths (e.g. \\server\share)
  if (resolved.startsWith('\\\\')) return undefined;
  if (!fs.existsSync(resolved)) return undefined;
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return undefined;
  return resolved;
}

/**
 * Write a PID → ptyId mapping for MCP workspace-identity resolution.
 *
 * We deliberately store the ptyId, NOT the workspaceId: a workspace id can be
 * re-minted (daemon respawn / session restore) while the shell process lives
 * on, so a frozen workspace id goes stale. The ptyId is immutable for the
 * process lifetime; `a2a.resolve.identity` maps ptyId → the CURRENT owning
 * workspace at lookup time. (Claude Code doesn't propagate env vars to MCP
 * child processes, so this on-disk map is the resolution anchor.)
 */
function writePidMap(pid: string | number, ptyId: string): void {
  try {
    const dir = getPidMapDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, String(pid)), ptyId, 'utf8');
  } catch { /* best-effort */ }
}

export function registerPTYHandlers(
  ptyManager: PTYManager,
  ptyBridge: PTYBridge,
  daemonClient?: DaemonClient,
  getWindow?: () => BrowserWindow | null,
): () => void {
  const useDaemon = daemonClient?.isConnected ?? false;

  // Track daemon session:data listeners by sessionId so PTY_CREATE / PTY_RECONNECT
  // can be idempotent. Without per-id tracking, every reconcile (mount + each
  // daemon.onConnected) would push another listener for an already-active
  // session, and the same PTY frame would be forwarded to the renderer N times
  // — manifesting as spinner lines stacking up and characters smearing across
  // rows in TUIs like Claude Code.
  const daemonSessionListeners = new Map<string, (...args: unknown[]) => void>();

  /** Register (or replace) the per-session data listener for `sessionId`. */
  function setSessionDataListener(
    sessionId: string,
    listener: (...args: unknown[]) => void,
  ): void {
    if (!daemonClient) return;
    const existing = daemonSessionListeners.get(sessionId);
    if (existing) {
      daemonClient.removeListener('session:data', existing);
    }
    daemonClient.on('session:data', listener);
    daemonSessionListeners.set(sessionId, listener);
  }

  /** Remove the per-session data listener for `sessionId`, if any. */
  function clearSessionDataListener(sessionId: string): void {
    if (!daemonClient) return;
    const existing = daemonSessionListeners.get(sessionId);
    if (!existing) return;
    daemonClient.removeListener('session:data', existing);
    daemonSessionListeners.delete(sessionId);
  }

  // Per-session StringDecoder to handle UTF-8 multi-byte sequences split across chunks
  const sessionDecoders = new Map<string, StringDecoder>();
  function decodeSessionData(sessionId: string, data: Buffer): string {
    let decoder = sessionDecoders.get(sessionId);
    if (!decoder) {
      decoder = new StringDecoder('utf8');
      sessionDecoders.set(sessionId, decoder);
    }
    return decoder.write(data);
  }

  // Forward daemon flush-complete events to the renderer so useTerminal can
  // decide whether to wipe its .txt-cache replay. recoveredBytes>0 means the
  // daemon has authoritative scrollback that supersedes the cache;
  // recoveredBytes=0 (cap-skipped session or fresh create) means the cache
  // is the best approximation and must be kept.
  // Single broadcast listener; the renderer filters by ptyId.
  // Stored in a named variable (not an anonymous closure) so the cleanup function below
  // can removeListener it, mirroring session:data / session:died. Without this, repeated
  // handler swaps on the same surviving daemonClient (renderer-crash / unresponsive-reload
  // recovery) accumulate flushComplete listeners → MaxListenersExceededWarning + duplicate
  // PTY_FLUSH_COMPLETE sends.
  let onDaemonFlushComplete:
    | ((payload: { sessionId: string; recoveredBytes: number }) => void)
    | null = null;
  // Daemon-mode cwd forwarder. Same named-variable/cleanup discipline as
  // flushComplete: the daemon detects cwd (OSC 7 / prompt) and emits
  // session:cwd; we relay it to the renderer as IPC.CWD_CHANGED and refresh
  // the main-side cwd cache, matching what local-mode PTYBridge does inline.
  let onDaemonCwd: ((payload: { sessionId: string; cwd: string }) => void) | null = null;
  if (useDaemon && daemonClient) {
    onDaemonFlushComplete = (payload: { sessionId: string; recoveredBytes: number }) => {
      const win = getWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send(
          IPC.PTY_FLUSH_COMPLETE,
          payload.sessionId,
          payload.recoveredBytes,
        );
      }
    };
    daemonClient.on('session:flushComplete', onDaemonFlushComplete);

    onDaemonCwd = (payload: { sessionId: string; cwd: string }) => {
      updateCwd(payload.sessionId, payload.cwd);
      const win = getWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.CWD_CHANGED, payload.sessionId, payload.cwd);
      }
    };
    daemonClient.on('session:cwd', onDaemonCwd);
  }

  // pty:create
  ipcMain.removeHandler(IPC.PTY_CREATE);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_CREATE, wrapHandler(IPC.PTY_CREATE, async (_event: Electron.IpcMainInvokeEvent, options?: { shell?: string; cwd?: string; cols?: number; rows?: number; workspaceId?: string; surfaceId?: string; env?: Record<string, string>; initialCommand?: string }) => {
      if (options?.shell !== undefined && !isAllowedShell(options.shell)) {
        throw new Error(`PTY_CREATE: shell not allowed: ${options.shell}`);
      }

      const safeCwd = validateCwd(options?.cwd);
      const effectiveCwd = safeCwd ?? require('os').homedir();
      const shell = options?.shell || (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'));

      // Generate a unique session ID
      const crypto = require('crypto');
      const sessionId = `daemon-${crypto.randomUUID().slice(0, 8)}`;

      // Identity env vars for the spawned shell. The daemon's
      // `buildSafeChildEnv` passes WMUX_WORKSPACE_ID / WMUX_SURFACE_ID
      // through (only WMUX_AUTH* is stripped), so PTY children — and
      // any tooling that spawns from them like the Claude Code hook
      // bridge — can use the env for deterministic routing instead of
      // ambiguous cwd matching. (User dogfood 2026-05-24: workspace 4
      // turn-end was landing on workspace 2's toast because both had
      // cwd C:\Users\rizz. Env-first now resolves it.)
      //
      // Without this, daemon-mode sessions get a bare `globalThis.process.env`
      // baseline that has no wmux identity at all — main process never had
      // WMUX_WORKSPACE_ID/SURFACE_ID in its own env (those are PTY-level).
      //
      // Env resolution happens HERE in main (the trusted control process),
      // symmetric with local-mode PTYManager.create, so the daemon stays
      // profile-agnostic and replays the persisted env verbatim on recovery:
      //   1. buildSafeChildEnv(process.env) — strip the main process's own
      //      inherited secrets/build-tooling vars from the child baseline.
      //   2. applyProfileEnv(...) — overlay the workspace profile AFTER the
      //      denylist (so an intentional *_KEY/*_TOKEN survives) and skip
      //      reserved WMUX_* keys.
      //   3. force WMUX identity LAST so a profile can never spoof it.
      // The daemon receives this as the complete `env`; it no longer needs a
      // separate `profileEnv` field, and recovery (which replays session.env)
      // reproduces the exact create-time environment without re-filtering.
      const identity: Record<string, string> = {};
      if (options?.workspaceId) identity[ENV_KEYS.WORKSPACE_ID] = options.workspaceId;
      if (options?.surfaceId) identity[ENV_KEYS.SURFACE_ID] = options.surfaceId;
      const resolvedEnv = resolveSpawnEnv(globalThis.process.env, options?.env, identity);

      // Create session via daemon RPC. `env` is the FULLY-RESOLVED child env;
      // the daemon replays it verbatim (see DaemonCreateSessionParams.env).
      const result = await daemonClient.rpc('daemon.createSession', {
        id: sessionId,
        cmd: shell,
        cwd: effectiveCwd,
        cols: options?.cols || 80,
        rows: options?.rows || 24,
        env: resolvedEnv,
      });

      // Attach to the session (makes daemon start the SessionPipe server)
      await daemonClient.rpc('daemon.attachSession', { id: sessionId });

      // Connect session data pipe
      await daemonClient.connectSessionPipe(sessionId);

      // Workspace profile startup command. Written as shell INPUT (not spawned
      // as the executable) so the allowed-shell check and quoting behavior are
      // preserved — same pattern company provisioning uses. Gated on the
      // session's first output (see scheduleInitialCommand) and retried while
      // the pipe reports "not delivered", which fixes the intermittent
      // never-ran-the-command race the fixed-delay version had.
      const initialCmd = scheduleInitialCommand(options?.initialCommand, {
        write: (cmd) => daemonClient.writeToSession(sessionId, sanitizePtyText(cmd) + '\r'),
        onExhausted: () => console.warn(
          `[pty:create] startup command for ${sessionId} not delivered after ` +
          `retries — session pipe never became writable (pane may be empty).`,
        ),
      });

      // Forward session data to renderer. Routed through the per-id helper so
      // a stale listener (from a prior create with the same id, or a reconnect)
      // is removed before the new one is attached.
      const onSessionData = (payload: { sessionId: string; data: Buffer }) => {
        if (payload.sessionId !== sessionId) return;
        initialCmd.onFirstData();
        const win = getWindow?.();
        if (win && !win.isDestroyed()) {
          const text = decodeSessionData(sessionId, payload.data);
          if (text) win.webContents.send(IPC.PTY_DATA, sessionId, text);
        }
      };
      setSessionDataListener(sessionId, onSessionData as (...args: unknown[]) => void);

      // Register initial CWD
      updateCwd(sessionId, effectiveCwd);

      // Anchor MCP workspace-identity resolution: map the shell PID → ptyId
      // (the session id). The owning workspace is resolved live downstream,
      // so this never goes stale when a workspace id is re-minted.
      const shellPid = (result as { pid?: number })?.pid;
      if (shellPid) {
        writePidMap(shellPid, sessionId);
      }

      return { id: sessionId, shell, cwd: effectiveCwd };
    }));
  } else {
    ipcMain.handle(IPC.PTY_CREATE, wrapHandler(IPC.PTY_CREATE, (_event: Electron.IpcMainInvokeEvent, options?: { shell?: string; cwd?: string; cols?: number; rows?: number; workspaceId?: string; surfaceId?: string; env?: Record<string, string>; initialCommand?: string }) => {
      if (options?.shell !== undefined && !isAllowedShell(options.shell)) {
        throw new Error(`PTY_CREATE: shell not allowed: ${options.shell}`);
      }

      const safeCwd = validateCwd(options?.cwd);
      const effectiveCwd = safeCwd ?? undefined;
      // Split off initialCommand — it's written into the shell post-create, not
      // a spawn option. The rest (incl. the profile env overlay) goes to create.
      const { initialCommand, ...createOpts } = options ?? {};
      const instance = ptyManager.create({ ...createOpts, cwd: effectiveCwd });
      ptyBridge.setupDataForwarding(instance.id);
      const actualCwd = effectiveCwd || require('os').homedir();
      updateCwd(instance.id, actualCwd);
      // Startup command: gate on the shell's first output (one-shot onData)
      // so it lands at a ready prompt, mirroring the daemon path. ptyManager
      // writes are always delivered locally, so the writer returns void.
      if (initialCommand && initialCommand.trim().length > 0) {
        const initialCmd = scheduleInitialCommand(initialCommand, {
          write: (cmd) => { ptyManager.write(instance.id, sanitizePtyText(cmd) + '\r'); },
        });
        const disposable = instance.process.onData(() => {
          disposable.dispose();
          initialCmd.onFirstData();
        });
      }
      return { id: instance.id, shell: instance.shell, cwd: actualCwd };
    }));
  }

  // pty:write
  // User keystrokes echo back through the PTY (the shell/TUI writes them
  // to the screen), so they show up to ActivityMonitor as agent output.
  // Mark the user-write timestamp so the idle fallback suppresses itself
  // while the user is typing (see idleSuppression.ts).
  //
  // Oversize backstop (defense-in-depth): the renderer chunks paste
  // payloads into PTY_WRITE_BACKSTOP_CHUNK_SIZE-byte segments before
  // sending (`src/renderer/utils/clipboardChunk.ts`), so normal callers
  // never exceed PTY_WRITE_BACKSTOP. If a future code path or external
  // tooling slips a larger write through, we now split it locally
  // rather than silently dropping — silent drops were the root cause
  // of the chronic "front of paste disappears" regression. The warn
  // log surfaces the caller so it can be fixed at the source.
  const PTY_WRITE_BACKSTOP = 100_000;
  const PTY_WRITE_BACKSTOP_CHUNK_SIZE = 8_192;
  const PTY_WRITE_HARD_LIMIT = 10_000_000; // 10 MB — true denial-of-service guard

  /** Split an oversize payload into safe segments without dropping any data. */
  function segmentOversize(data: string): string[] {
    if (data.length <= PTY_WRITE_BACKSTOP) return [data];
    const out: string[] = [];
    for (let i = 0; i < data.length; i += PTY_WRITE_BACKSTOP_CHUNK_SIZE) {
      // Avoid splitting a UTF-16 surrogate pair at the boundary so the
      // shell never sees a lone surrogate (would render as U+FFFD).
      let end = Math.min(i + PTY_WRITE_BACKSTOP_CHUNK_SIZE, data.length);
      if (end < data.length) {
        const last = data.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      }
      out.push(data.slice(i, end));
    }
    return out;
  }

  ipcMain.removeAllListeners(IPC.PTY_WRITE);
  if (useDaemon && daemonClient) {
    // Per-session diagnostic: log the first dropped write so silent
    // input-mute leaves a paper trail in main.log without spamming on
    // every keystroke if a pipe stays dead. Reset when a write succeeds
    // so future regressions still log their first occurrence.
    const writeDropLogged = new Set<string>();
    const onPtyWrite = (_event: Electron.IpcMainEvent, id: string, data: string): void => {
      if (typeof data !== 'string') return;
      if (data.length > PTY_WRITE_HARD_LIMIT) {
        console.error(`[PTY_WRITE] refused payload exceeding hard limit: ${data.length} chars > ${PTY_WRITE_HARD_LIMIT}. Caller must fix.`);
        return;
      }
      if (data.length > PTY_WRITE_BACKSTOP) {
        console.warn(`[PTY_WRITE] oversize payload ${data.length} chars > ${PTY_WRITE_BACKSTOP}; segmenting locally. Renderer should chunk at the source.`);
      }
      markUserWrite(id);
      const segments = segmentOversize(data);
      let allDelivered = true;
      for (const segment of segments) {
        const delivered = daemonClient.writeToSession(id, sanitizePtyText(segment));
        if (!delivered) {
          allDelivered = false;
          break;
        }
      }
      if (!allDelivered) {
        if (!writeDropLogged.has(id)) {
          writeDropLogged.add(id);
          console.warn(`[PTY_WRITE] drop sessionId=${id} reason=no-live-session-pipe (first occurrence; suppressing further logs for this id until next successful write)`);
        }
      } else if (writeDropLogged.has(id)) {
        writeDropLogged.delete(id);
      }
    };
    ipcMain.on(IPC.PTY_WRITE, onPtyWrite);
  } else {
    const onPtyWrite = (_event: Electron.IpcMainEvent, id: string, data: string): void => {
      if (!ptyManager.get(id)) return;
      if (typeof data !== 'string') return;
      if (data.length > PTY_WRITE_HARD_LIMIT) {
        console.error(`[PTY_WRITE] refused payload exceeding hard limit: ${data.length} chars > ${PTY_WRITE_HARD_LIMIT}. Caller must fix.`);
        return;
      }
      if (data.length > PTY_WRITE_BACKSTOP) {
        console.warn(`[PTY_WRITE] oversize payload ${data.length} chars > ${PTY_WRITE_BACKSTOP}; segmenting locally. Renderer should chunk at the source.`);
      }
      markUserWrite(id);
      const segments = segmentOversize(data);
      for (const segment of segments) {
        ptyManager.write(id, sanitizePtyText(segment));
      }
    };
    ipcMain.on(IPC.PTY_WRITE, onPtyWrite);
  }

  // pty:resize
  // TUI agents (Claude, Codex, etc.) respond to SIGWINCH with a full-screen
  // redraw, which spikes ActivityMonitor's byte counter and triggers the
  // "Task may have finished" fallback when the user moves on within 5s.
  // Mark the resize timestamp so the fallback suppresses itself for the
  // suppression window (see idleSuppression.ts).
  ipcMain.removeHandler(IPC.PTY_RESIZE);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_RESIZE, wrapHandler(IPC.PTY_RESIZE, async (_event: Electron.IpcMainInvokeEvent, id: string, cols: number, rows: number) => {
      if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
        throw new Error(`PTY_RESIZE: cols and rows must be positive integers (got cols=${cols}, rows=${rows})`);
      }
      markResize(id);

      // Retry on "not found" to ride out the recovery-PTY attach race
      // (see RESIZE_RETRY_ATTEMPTS doc block above for the full story).
      // Non-"not found" errors throw immediately. The final attempt's
      // not-found is swallowed gracefully to preserve the prior
      // reconciliation-destroyed-session behavior.
      for (let attempt = 0; attempt < RESIZE_RETRY_ATTEMPTS; attempt++) {
        try {
          await daemonClient.rpc('daemon.resizeSession', { id, cols, rows });
          if (attempt > 0) {
            // Diagnostic: log how many retries the attach race needed.
            // Stays cheap (one log line per recovery, not per resize).
            const elapsedMs = attempt * RESIZE_RETRY_DELAY_MS;
            // eslint-disable-next-line no-console
            console.log(
              `[pty:resize] attach race retry succeeded for ${id} ` +
              `after ${attempt + 1} attempts (~${elapsedMs}ms wait)`,
            );
          }
          return;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const isNotFound = msg.includes('not found') || msg.includes('not exist');
          if (!isNotFound) throw err;
          if (attempt === RESIZE_RETRY_ATTEMPTS - 1) {
            // Final attempt also failed with not-found: graceful return.
            // Session genuinely gone (destroyed during reconciliation,
            // or post-dispose race). Preserves prior swallow behavior.
            const elapsedMs = RESIZE_RETRY_ATTEMPTS * RESIZE_RETRY_DELAY_MS;
            // eslint-disable-next-line no-console
            console.warn(
              `[pty:resize] attach race retry exhausted for ${id} ` +
              `after ${RESIZE_RETRY_ATTEMPTS} attempts (~${elapsedMs}ms). ` +
              `Session may be genuinely gone, or attach is taking >${elapsedMs}ms.`,
            );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, RESIZE_RETRY_DELAY_MS));
        }
      }
    }));
  } else {
    ipcMain.handle(IPC.PTY_RESIZE, wrapHandler(IPC.PTY_RESIZE, (_event: Electron.IpcMainInvokeEvent, id: string, cols: number, rows: number) => {
      if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
        throw new Error(`PTY_RESIZE: cols and rows must be positive integers (got cols=${cols}, rows=${rows})`);
      }
      if (!ptyManager.get(id)) return;
      markResize(id);
      ptyManager.resize(id, cols, rows);
    }));
  }

  // pty:dispose
  ipcMain.removeHandler(IPC.PTY_DISPOSE);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_DISPOSE, wrapHandler(IPC.PTY_DISPOSE, async (_event: Electron.IpcMainInvokeEvent, id: string) => {
      await daemonClient.rpc('daemon.destroySession', { id });
      await daemonClient.disconnectSessionPipe(id);
      sessionDecoders.delete(id);
      // Drop the data forwarding listener for this session so a future
      // create or reconnect doesn't pile new listeners on top of dead ones.
      clearSessionDataListener(id);
    }));
  } else {
    ipcMain.handle(IPC.PTY_DISPOSE, wrapHandler(IPC.PTY_DISPOSE, (_event: Electron.IpcMainInvokeEvent, id: string) => {
      ptyManager.dispose(id);
    }));
  }

  // pty:list
  ipcMain.removeHandler(IPC.PTY_LIST);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_LIST, wrapHandler(IPC.PTY_LIST, async () => {
      const sessions = await daemonClient.rpc('daemon.listSessions', {}) as Array<{ id: string; cmd: string; state: string }>;
      // Map to same shape as local PTYManager.getActiveInstances()
      const live = sessions
        .filter(s => s.state !== 'dead')
        .map(s => ({ id: s.id, shell: s.cmd }));
      // RCA A8 — log the count the renderer's reconcile will act on. An empty
      // or short list here, correlated with a renderer ptyId-clear, is the
      // signature of the session-replacement bug. Without this line the
      // decision was invisible in the daemon/main logs.
      console.log(`[lifecycle] pty.list -> ${live.length} live session(s) of ${sessions.length} total`);
      return live;
    }));
  } else {
    ipcMain.handle(IPC.PTY_LIST, wrapHandler(IPC.PTY_LIST, () => {
      return ptyManager.getActiveInstances();
    }));
  }

  // pty:reconnect
  ipcMain.removeHandler(IPC.PTY_RECONNECT);
  if (useDaemon && daemonClient) {
    ipcMain.handle(IPC.PTY_RECONNECT, wrapHandler(IPC.PTY_RECONNECT, async (_event: Electron.IpcMainInvokeEvent, id: string) => {
      try {
        const sessions = await daemonClient.rpc('daemon.listSessions', {}) as Array<{ id: string; cmd: string; state: string; pid?: number }>;
        const session = sessions.find(s => s.id === id);
        if (!session || session.state === 'dead') {
          // RCA A1 — permanent failure: the daemon authoritatively reports the
          // session as absent or dead. Safe for the renderer to clear the
          // ptyId and self-create. transient:false signals "do not retry".
          console.log(`[lifecycle] pty.reconnect id=${id} result=fail code=session-dead (transient=false)`);
          return { success: false, error: 'Session not found or dead', code: 'session-dead', transient: false };
        }

        // Reconnect is an explicit fresh-attach intent — pass forceFresh
        // so a stale sessionPipes entry (left over from a prior daemon
        // pipe replacement) is torn down rather than silently reused.
        // Without this, attach+connect can return success while the
        // underlying socket is moments away from receiving its close
        // event, and every subsequent write silently disappears.
        await daemonClient.rpc('daemon.attachSession', { id });
        await daemonClient.connectSessionPipe(id, { forceFresh: true });

        // Health probe: confirm the freshly connected pipe is actually
        // writable before reporting success. A truthy reconnect that
        // points at a dead socket is the exact shape of the input-mute
        // bug we're trying to prevent here.
        const probeOk = daemonClient.isSessionPipeWritable(id);
        if (!probeOk) {
          // RCA A1 — transient failure: the session is alive in the daemon but
          // the freshly-attached pipe is not writable yet (forceFresh tears the
          // old socket down asynchronously; the daemon-side close can arrive a
          // tick after connect resolves). The renderer must NOT clear the ptyId
          // — it should retry, otherwise a live session gets replaced by an
          // empty one. transient:true signals "retry".
          console.log(`[lifecycle] pty.reconnect id=${id} result=fail code=pipe-not-writable (transient=true)`);
          return { success: false, error: 'Session pipe not writable after reconnect', code: 'pipe-not-writable', transient: true };
        }

        // Re-anchor the PID → ptyId identity map. A surviving shell keeps its
        // OS PID across a renderer restart / daemon respawn, but its workspace
        // id may have been re-minted in the meantime, leaving the create-time
        // map stale. Rewriting it here (keyed by the live shell PID) keeps MCP
        // identity resolution correct without a full restart. ptyId is the
        // stable anchor; the owning workspace is resolved live by
        // a2a.resolve.identity.
        if (typeof session.pid === 'number' && session.pid > 0) {
          writePidMap(session.pid, id);
        }

        // Set up data forwarding. Routed through the per-id helper so a
        // repeat reconnect (e.g. AppLayout's reconcile firing again on the
        // late daemon.onConnected event) replaces the prior listener instead
        // of stacking a duplicate that doubles every byte the PTY emits.
        const onSessionData = (payload: { sessionId: string; data: Buffer }) => {
          if (payload.sessionId !== id) return;
          const win = getWindow?.();
          if (win && !win.isDestroyed()) {
            const text = decodeSessionData(id, payload.data);
            if (text) win.webContents.send(IPC.PTY_DATA, id, text);
          }
        };
        setSessionDataListener(id, onSessionData as (...args: unknown[]) => void);

        console.log(`[lifecycle] pty.reconnect id=${id} result=ok pid=${session.pid ?? '?'}`);
        return { success: true, id: session.id, shell: session.cmd };
      } catch (err) {
        // RCA A1 — RPC threw (timeout, ECONNRESET, handler swap mid-call).
        // This is a transient infrastructure failure, NOT proof the session is
        // dead. transient:true so the renderer retries rather than discarding
        // the session.
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[lifecycle] pty.reconnect id=${id} result=fail code=rpc-error transient=true err=${msg}`);
        return { success: false, error: msg, code: 'rpc-error', transient: true };
      }
    }));
  } else {
    ipcMain.handle(IPC.PTY_RECONNECT, wrapHandler(IPC.PTY_RECONNECT, (_event: Electron.IpcMainInvokeEvent, id: string) => {
      const instance = ptyManager.get(id);
      if (!instance) {
        return { success: false, error: 'PTY not found' };
      }
      return { success: true, id: instance.id, shell: instance.shell };
    }));
  }

  // Listen for daemon session:died events and forward to renderer
  let onDaemonSessionDied: ((payload: { sessionId: string; exitCode: number | null }) => void) | null = null;
  if (useDaemon && daemonClient) {
    onDaemonSessionDied = (payload: { sessionId: string; exitCode: number | null }) => {
      const win = getWindow?.();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.PTY_EXIT, payload.sessionId, payload.exitCode ?? -1);
      }
      daemonClient.disconnectSessionPipe(payload.sessionId).catch(() => {});
    };
    daemonClient.on('session:died', onDaemonSessionDied);
  }

  // Cleanup function
  return () => {
    ipcMain.removeHandler(IPC.PTY_CREATE);
    ipcMain.removeAllListeners(IPC.PTY_WRITE);
    ipcMain.removeHandler(IPC.PTY_RESIZE);
    ipcMain.removeHandler(IPC.PTY_DISPOSE);
    ipcMain.removeHandler(IPC.PTY_LIST);
    ipcMain.removeHandler(IPC.PTY_RECONNECT);

    // Clean up daemon listeners
    if (daemonClient) {
      for (const listener of daemonSessionListeners.values()) {
        daemonClient.removeListener('session:data', listener);
      }
      daemonSessionListeners.clear();
      if (onDaemonSessionDied) {
        daemonClient.removeListener('session:died', onDaemonSessionDied);
      }
      if (onDaemonFlushComplete) {
        daemonClient.removeListener('session:flushComplete', onDaemonFlushComplete);
      }
      if (onDaemonCwd) {
        daemonClient.removeListener('session:cwd', onDaemonCwd);
      }
    }
  };
}
