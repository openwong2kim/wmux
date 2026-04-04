import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, getWmuxDir } from './config';
import { DaemonSessionManager } from './DaemonSessionManager';
import { DaemonPipeServer } from './DaemonPipeServer';
import { SessionPipe } from './SessionPipe';
import { StateWriter } from './StateWriter';
import { ProcessMonitor } from './ProcessMonitor';
import { Watchdog } from './Watchdog';
import type { DaemonState } from './types';
import type { DaemonEvent, DaemonCreateSessionParams, DaemonSessionIdParams, DaemonResizeParams } from '../shared/rpc';

// === Constants ===
const wmuxDir = getWmuxDir();
const PID_FILE = path.join(wmuxDir, 'daemon.pid');
const LOCK_FILE = path.join(wmuxDir, 'daemon.lock');

// === Logging (console-based) ===
function log(level: string, msg: string, ...args: unknown[]): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [daemon/${level}] ${msg}`, ...args);
}

// === PID / Lock helpers ===

function isProcessRunning(pid: number): boolean {
  if (process.platform === 'win32') {
    // process.kill(pid, 0) is unreliable on Windows — always succeeds for stale PIDs.
    // Use wmic with full paths to avoid PATH issues in non-standard shells.
    try {
      const { execFileSync } = require('child_process');
      const pathMod = require('path');
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const tasklist = pathMod.join(systemRoot, 'System32', 'tasklist.exe');
      const result = execFileSync(
        tasklist,
        ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'],
        { encoding: 'utf-8', timeout: 3000, windowsHide: true },
      );
      return result.includes(`"${pid}"`);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  const dir = getWmuxDir();
  if (!fs.existsSync(dir)) {
    // Note: mode is no-op on Windows; use icacls for NTFS ACLs
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Attempt exclusive lock file creation to prevent race conditions
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lock file exists — check if the owning process is still alive
      try {
        const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
        if (!isNaN(existingPid) && isProcessRunning(existingPid)) {
          log('error', `Another daemon is already running (PID ${existingPid})`);
          return false;
        }
        // Stale lock — owning process is dead, remove and retry
        log('warn', `Removing stale lock file (PID ${existingPid})`);
        fs.unlinkSync(LOCK_FILE);
      } catch {
        // Corrupted lock file — remove and retry
        try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
      }
      // Retry exclusive create after removing stale lock
      try {
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
      } catch {
        log('error', 'Failed to acquire lock after cleanup');
        return false;
      }
    } else {
      log('error', 'Failed to create lock file:', err);
      return false;
    }
  }

  // Write PID file (separate from lock for backward compat)
  fs.writeFileSync(PID_FILE, String(process.pid), { encoding: 'utf-8', mode: 0o600 });
  return true;
}

function releaseLock(): void {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
  // Clean up pipe name file
  try {
    const pipeNameFile = path.join(wmuxDir, 'daemon-pipe');
    if (fs.existsSync(pipeNameFile)) fs.unlinkSync(pipeNameFile);
  } catch {
    // ignore
  }
}

// === Session recovery ===

async function recoverSessions(
  stateWriter: StateWriter,
  sessionManager: DaemonSessionManager,
  processMonitor: ProcessMonitor,
): Promise<void> {
  const state = stateWriter.load();
  let changed = false;
  const recoveredIds = new Set<string>();

  for (const session of state.sessions) {
    if (session.state === 'dead') continue;

    if (session.state === 'suspended' && session.bufferDumpPath) {
      // Attempt to recover suspended session
      try {
        let scrollbackData: Buffer | undefined;
        if (fs.existsSync(session.bufferDumpPath)) {
          scrollbackData = fs.readFileSync(session.bufferDumpPath);
        }

        // Verify cwd still exists; fall back to homedir
        const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();

        const recovered = sessionManager.createSession({
          id: session.id,
          cmd: session.cmd,
          cwd,
          env: session.env,
          cols: session.cols,
          rows: session.rows,
          agent: session.agent,
          createdAt: session.createdAt,
          scrollbackData,
        });

        // Start process monitoring for the new PTY
        processMonitor.watch(recovered.id, recovered.pid, () => {
          const managed = sessionManager.getSession(recovered.id);
          if (managed && managed.meta.state !== 'dead') {
            managed.meta.state = 'dead';
            sessionManager.emit('session:died', { id: recovered.id, exitCode: null });
          }
        });

        // Clean up dump file
        try { fs.unlinkSync(session.bufferDumpPath); } catch { /* ignore */ }

        recoveredIds.add(session.id);
        changed = true;
        log('info', `Recovered session ${session.id} in ${cwd}`);
      } catch (err) {
        log('error', `Failed to recover session ${session.id}:`, err);
        session.state = 'dead';
        session.exitCode = null;
        changed = true;
      }
    } else {
      // Non-suspended live session — check for periodic snapshot buf file
      // (written every 30s, survives forced kills / power loss)
      if (await ProcessMonitor.isAlive(session.pid)) {
        try { process.kill(session.pid); } catch { /* ignore */ }
      }

      const snapshotPath = stateWriter.getBufferDumpPath(session.id);
      if (fs.existsSync(snapshotPath)) {
        try {
          const scrollbackData = fs.readFileSync(snapshotPath);
          const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();

          const recovered = sessionManager.createSession({
            id: session.id,
            cmd: session.cmd,
            cwd,
            env: session.env,
            cols: session.cols,
            rows: session.rows,
            agent: session.agent,
            createdAt: session.createdAt,
            scrollbackData,
          });

          processMonitor.watch(recovered.id, recovered.pid, () => {
            const managed = sessionManager.getSession(recovered.id);
            if (managed && managed.meta.state !== 'dead') {
              managed.meta.state = 'dead';
              sessionManager.emit('session:died', { id: recovered.id, exitCode: null });
            }
          });

          try { fs.unlinkSync(snapshotPath); } catch { /* ignore */ }
          recoveredIds.add(session.id);
          changed = true;
          log('info', `Recovered session ${session.id} from snapshot in ${cwd}`);
          continue;
        } catch (err) {
          log('error', `Failed to recover session ${session.id} from snapshot:`, err);
        }
      }

      // No snapshot file found — still try to recover the session
      // with an empty scrollback rather than marking it dead.
      // This handles cases where the daemon was killed before
      // the 30s snapshot interval fired (e.g. immediate reboot).
      try {
        const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();
        const recovered = sessionManager.createSession({
          id: session.id,
          cmd: session.cmd,
          cwd,
          env: session.env,
          cols: session.cols,
          rows: session.rows,
          agent: session.agent,
          createdAt: session.createdAt,
        });

        processMonitor.watch(recovered.id, recovered.pid, () => {
          const managed = sessionManager.getSession(recovered.id);
          if (managed && managed.meta.state !== 'dead') {
            managed.meta.state = 'dead';
            sessionManager.emit('session:died', { id: recovered.id, exitCode: null });
          }
        });

        recoveredIds.add(session.id);
        changed = true;
        log('info', `Recovered session ${session.id} without scrollback in ${cwd}`);
      } catch (err) {
        log('error', `Failed to recover session ${session.id}:`, err);
        session.state = 'dead';
        session.exitCode = null;
        changed = true;
      }
    }
  }

  if (changed) {
    // Build combined state: recovered (live) sessions + dead sessions from loaded state
    const liveState = buildState(sessionManager);
    const deadFromState = state.sessions.filter(
      (s) => s.state === 'dead' && !recoveredIds.has(s.id),
    );
    liveState.sessions.push(...deadFromState);
    stateWriter.saveImmediate(liveState);
  }

  // Clean up orphaned buffer files
  stateWriter.cleanOrphanedBuffers(recoveredIds);
}

// === RPC handler registration ===

function registerRpcHandlers(
  pipeServer: DaemonPipeServer,
  sessionManager: DaemonSessionManager,
  stateWriter: StateWriter,
  sessionPipes: Map<string, SessionPipe>,
  processMonitor: ProcessMonitor,
  startTime: number,
  sessionDataListeners: Map<string, { bridge: import('./DaemonPTYBridge').DaemonPTYBridge; listener: (data: Buffer) => void }>,
  watchdog: Watchdog,
): void {
  // daemon.createSession
  pipeServer.onRpc('daemon.createSession', async (params) => {
    if (watchdog.isBlocked) {
      throw new Error('Cannot create session: memory pressure too high. Try again later.');
    }
    const p = params as unknown as DaemonCreateSessionParams;
    if (typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.id)) {
      throw new Error('Invalid session ID');
    }
    const session = sessionManager.createSession({
      id: p.id,
      cmd: p.cmd,
      cwd: p.cwd,
      env: p.env,
      cols: p.cols,
      rows: p.rows,
      agent: p.agent,
    });

    // Start process monitoring
    processMonitor.watch(session.id, session.pid, () => {
      // Process died externally — session manager's bridge exit handler
      // should already handle this via PTY onExit, but this is a safety net
      const managed = sessionManager.getSession(session.id);
      if (managed && managed.meta.state !== 'dead') {
        managed.meta.state = 'dead';
        sessionManager.emit('session:died', { id: session.id, exitCode: null });
      }
    });

    // Save state immediately
    const state = buildState(sessionManager);
    stateWriter.saveImmediate(state);

    return session;
  });

  // daemon.destroySession
  pipeServer.onRpc('daemon.destroySession', async (params) => {
    const p = params as unknown as DaemonSessionIdParams;

    // Remove data listener to prevent leak
    const tracked = sessionDataListeners.get(p.id);
    if (tracked) {
      tracked.bridge.removeListener('data', tracked.listener);
      sessionDataListeners.delete(p.id);
    }

    // Clean up session pipe if exists
    const pipe = sessionPipes.get(p.id);
    if (pipe) {
      await pipe.stop();
      sessionPipes.delete(p.id);
    }

    // Stop process monitoring
    processMonitor.unwatch(p.id);

    sessionManager.destroySession(p.id);

    // Clean up buffer dump file if exists
    const bufPath = stateWriter.getBufferDumpPath(p.id);
    try { if (fs.existsSync(bufPath)) fs.unlinkSync(bufPath); } catch { /* ignore */ }

    const state = buildState(sessionManager);
    stateWriter.saveImmediate(state);

    return { ok: true };
  });

  // daemon.attachSession
  pipeServer.onRpc('daemon.attachSession', async (params) => {
    const p = params as unknown as DaemonSessionIdParams;
    sessionManager.attachSession(p.id);

    // Create and start SessionPipe for data streaming
    const managed = sessionManager.getSession(p.id);
    if (managed) {
      // Remove any previous data listener to prevent leaks
      const prev = sessionDataListeners.get(p.id);
      if (prev) {
        prev.bridge.removeListener('data', prev.listener);
        sessionDataListeners.delete(p.id);
      }

      // Stop existing SessionPipe if still listening (prevents EADDRINUSE on reconnect)
      const existingPipe = sessionPipes.get(p.id);
      if (existingPipe) {
        await existingPipe.stop().catch(() => {});
        sessionPipes.delete(p.id);
      }

      const pipe = new SessionPipe(p.id, managed.ringBuffer, pipeServer.getAuthToken());
      sessionPipes.set(p.id, pipe);

      // Forward PTY output to session pipe
      const onData = (data: Buffer) => {
        pipe.writeToClient(data);
      };
      managed.bridge.on('data', onData);
      sessionDataListeners.set(p.id, { bridge: managed.bridge, listener: onData });

      // Forward client input to PTY
      pipe.onInput((data: Buffer) => {
        managed.ptyProcess.write(data.toString());
      });

      await pipe.start();
    }

    const state = buildState(sessionManager);
    stateWriter.saveImmediate(state);

    return { ok: true };
  });

  // daemon.detachSession
  pipeServer.onRpc('daemon.detachSession', async (params) => {
    const p = params as unknown as DaemonSessionIdParams;

    // Remove data listener to prevent leak
    const tracked = sessionDataListeners.get(p.id);
    if (tracked) {
      tracked.bridge.removeListener('data', tracked.listener);
      sessionDataListeners.delete(p.id);
    }

    // Clean up session pipe
    const pipe = sessionPipes.get(p.id);
    if (pipe) {
      await pipe.stop();
      sessionPipes.delete(p.id);
    }

    sessionManager.detachSession(p.id);

    const state = buildState(sessionManager);
    stateWriter.saveImmediate(state);

    return { ok: true };
  });

  // daemon.resizeSession
  pipeServer.onRpc('daemon.resizeSession', async (params) => {
    const p = params as unknown as DaemonResizeParams;
    sessionManager.resizeSession(p.id, p.cols, p.rows);
    return { ok: true };
  });

  // daemon.listSessions
  pipeServer.onRpc('daemon.listSessions', async () => {
    return sessionManager.listSessions();
  });

  // daemon.ping
  pipeServer.onRpc('daemon.ping', async () => {
    const sessions = sessionManager.listSessions();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    return { status: 'ok', uptime, sessions: sessions.length };
  });
}

// === Event wiring ===

function wireEvents(
  sessionManager: DaemonSessionManager,
  pipeServer: DaemonPipeServer,
  stateWriter: StateWriter,
  sessionPipes: Map<string, SessionPipe>,
  processMonitor: ProcessMonitor,
  sessionDataListeners: Map<string, { bridge: import('./DaemonPTYBridge').DaemonPTYBridge; listener: (data: Buffer) => void }>,
): void {
  // session:died → broadcast DaemonEvent + save state + cleanup
  sessionManager.on('session:died', (payload: { id: string; exitCode: number | null }) => {
    const event: DaemonEvent = {
      type: 'session.died',
      sessionId: payload.id,
      data: { exitCode: payload.exitCode },
    };
    pipeServer.broadcast(event);

    // Remove data listener to prevent leak
    const tracked = sessionDataListeners.get(payload.id);
    if (tracked) {
      tracked.bridge.removeListener('data', tracked.listener);
      sessionDataListeners.delete(payload.id);
    }

    // Clean up session pipe
    const pipe = sessionPipes.get(payload.id);
    if (pipe) {
      pipe.stop().catch(() => {});
      sessionPipes.delete(payload.id);
    }

    // Stop process monitoring
    processMonitor.unwatch(payload.id);

    // Clean up buffer dump file — dead sessions don't need snapshots
    const bufPath = stateWriter.getBufferDumpPath(payload.id);
    try { if (fs.existsSync(bufPath)) fs.unlinkSync(bufPath); } catch { /* ignore */ }

    // Save state
    const state = buildState(sessionManager);
    stateWriter.saveImmediate(state);
  });

  // session:created → save state (debounced since saveImmediate is called in RPC handler)
  sessionManager.on('session:created', () => {
    const state = buildState(sessionManager);
    stateWriter.saveDebounced(state);
  });

  // session:stateChanged → save state debounced
  sessionManager.on('session:stateChanged', () => {
    const state = buildState(sessionManager);
    stateWriter.saveDebounced(state);
  });

  // Bridge-level events: forward agent/critical/idle from all sessions
  // These are emitted by DaemonSessionManager which re-emits bridge events
  sessionManager.on('session:idle', (payload: { sessionId: string }) => {
    const event: DaemonEvent = {
      type: 'activity.idle',
      sessionId: payload.sessionId,
      data: null,
    };
    pipeServer.broadcast(event);
  });
}

// === State builder ===

function buildState(sessionManager: DaemonSessionManager): DaemonState {
  return {
    version: 1,
    sessions: sessionManager.listSessions(),
  };
}

// === Graceful shutdown ===

let shuttingDown = false;

async function shutdown(
  signal: string,
  sessionManager: DaemonSessionManager,
  pipeServer: DaemonPipeServer,
  stateWriter: StateWriter,
  sessionPipes: Map<string, SessionPipe>,
  processMonitor: ProcessMonitor,
  watchdog: Watchdog,
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `Received ${signal} — shutting down gracefully`);

  // Hard timeout guard — force exit if shutdown hangs
  const shutdownTimeout = setTimeout(() => {
    log('error', 'Shutdown timed out after 10s — forcing exit');
    releaseLock();
    process.exit(1);
  }, 10_000);
  shutdownTimeout.unref();

  // Stop watchdog
  watchdog.stop();

  // Stop process monitor
  processMonitor.unwatchAll();

  // Clean up all session pipes
  const pipeStops = Array.from(sessionPipes.values()).map((pipe) =>
    pipe.stop().catch(() => {}),
  );
  await Promise.all(pipeStops);
  sessionPipes.clear();

  // Dump scrollback buffers and mark live sessions as suspended for recovery
  const managedSessions = sessionManager.listManagedSessions();
  stateWriter.ensureBufferDir();

  const dumpPromises: Promise<void>[] = [];
  for (const managed of managedSessions) {
    if (managed.meta.state === 'dead') continue;

    const dumpPath = stateWriter.getBufferDumpPath(managed.meta.id);
    dumpPromises.push(
      managed.ringBuffer.dumpToFile(dumpPath).then(() => {
        managed.meta.state = 'suspended';
        managed.meta.bufferDumpPath = dumpPath;
        log('info', `Suspended session ${managed.meta.id} (buffer: ${managed.ringBuffer.size} bytes)`);
      }).catch((err) => {
        log('warn', `Failed to dump buffer for ${managed.meta.id}:`, err);
        managed.meta.state = 'dead';
      }),
    );
  }
  await Promise.all(dumpPromises);

  // Save suspended state BEFORE disposing
  const suspendState: DaemonState = {
    version: 1,
    sessions: managedSessions.map((m) => ({ ...m.meta })),
  };
  stateWriter.saveImmediate(suspendState);

  // Dispose all sessions (kills PTYs, clears map)
  sessionManager.disposeAll();

  stateWriter.dispose();

  // Stop IPC server
  await pipeServer.stop().catch(() => {});

  releaseLock();
  log('info', 'Daemon stopped');
  process.exit(0);
}

// === Main entry point ===

async function main(): Promise<void> {
  const startTime = Date.now();
  log('info', `wmux-daemon starting (PID ${process.pid})`);

  // 1. Single-instance check
  if (!acquireLock()) {
    process.exit(1);
  }

  // 2. Load configuration
  const config = loadConfig();
  log('info', `Config loaded (logLevel=${config.daemon.logLevel})`);

  // 3. Initialize modules
  const stateWriter = new StateWriter(wmuxDir);
  const sessionManager = new DaemonSessionManager();
  sessionManager.setConfig(config);
  const pipeServer = new DaemonPipeServer(config.daemon.pipeName);
  const processMonitor = new ProcessMonitor();
  const watchdog = new Watchdog(30000);
  const sessionPipes = new Map<string, SessionPipe>();
  const sessionDataListeners = new Map<string, { bridge: import('./DaemonPTYBridge').DaemonPTYBridge; listener: (data: Buffer) => void }>();

  // 4. Recover previous sessions
  await recoverSessions(stateWriter, sessionManager, processMonitor);

  // 5. Register RPC handlers
  registerRpcHandlers(pipeServer, sessionManager, stateWriter, sessionPipes, processMonitor, startTime, sessionDataListeners, watchdog);

  // 6. Wire events
  wireEvents(sessionManager, pipeServer, stateWriter, sessionPipes, processMonitor, sessionDataListeners);

  // 7. Start control pipe
  await pipeServer.start();

  // Write active pipe name so clients know which pipe to connect to
  const activePipeName = pipeServer.getActivePipeName();
  const pipeNameFile = path.join(wmuxDir, 'daemon-pipe');
  try {
    fs.writeFileSync(pipeNameFile, activePipeName, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    log('warn', 'Failed to write pipe name file:', err);
  }

  // 8. Start watchdog with escalation callbacks
  watchdog.setCallbacks({
    onReapDeadSessions: () => {
      let reaped = 0;
      for (const managed of sessionManager.listManagedSessions()) {
        if (managed.meta.state !== 'dead') continue;
        const bufPath = stateWriter.getBufferDumpPath(managed.meta.id);
        try { if (fs.existsSync(bufPath)) fs.unlinkSync(bufPath); } catch { /* ignore */ }
        sessionManager.destroySession(managed.meta.id);
        reaped++;
      }
      if (reaped > 0) {
        const state = buildState(sessionManager);
        stateWriter.saveImmediate(state);
      }
      return reaped;
    },
    onBlockNewSessions: (blocked) => {
      log(blocked ? 'warn' : 'info',
        blocked ? 'New session creation blocked due to memory pressure'
                : 'New session creation unblocked — memory recovered');
    },
  });

  watchdog.start(() => ({
    sessions: sessionManager.listSessions().length,
    memory: process.memoryUsage().rss,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  }));

  // 8b. Reap dead sessions that exceeded their TTL (hourly)
  const reapInterval = setInterval(() => {
    let reaped = 0;
    for (const managed of sessionManager.listManagedSessions()) {
      if (managed.meta.state !== 'dead') continue;
      const deadSince = new Date(managed.meta.lastActivity).getTime();
      const ttlMs = managed.meta.deadTtlHours * 60 * 60 * 1000;
      if (Date.now() - deadSince >= ttlMs) {
        const bufPath = stateWriter.getBufferDumpPath(managed.meta.id);
        try { if (fs.existsSync(bufPath)) fs.unlinkSync(bufPath); } catch { /* ignore */ }
        sessionManager.destroySession(managed.meta.id);
        reaped++;
      }
    }
    if (reaped > 0) {
      log('info', `Reaped ${reaped} expired dead session(s)`);
      const state = buildState(sessionManager);
      stateWriter.saveImmediate(state);
    }
  }, 60 * 60 * 1000); // Every hour
  reapInterval.unref();

  // 8c. Periodic buffer snapshots (every 30s) — survives forced kills / power loss
  // Also save sessions.json so recovery has up-to-date session metadata
  const snapshotInterval = setInterval(() => {
    const managed = sessionManager.listManagedSessions();
    const live = managed.filter((m) => m.meta.state !== 'dead');
    if (live.length === 0) return;

    stateWriter.ensureBufferDir();
    const dumps = live.map((m) => {
      const dumpPath = stateWriter.getBufferDumpPath(m.meta.id);
      return m.ringBuffer.dumpToFile(dumpPath).catch((err) => {
        log('warn', `Snapshot dump failed for ${m.meta.id}:`, err);
      });
    });

    // Save session metadata only after all buffer dumps complete (atomicity)
    Promise.all(dumps).then(() => {
      const state = buildState(sessionManager);
      stateWriter.saveImmediate(state);
    });
  }, 30_000);
  snapshotInterval.unref();

  // 9. Signal handlers
  const doShutdown = (sig: string) =>
    shutdown(sig, sessionManager, pipeServer, stateWriter, sessionPipes, processMonitor, watchdog);

  process.on('SIGTERM', () => doShutdown('SIGTERM'));
  process.on('SIGINT', () => doShutdown('SIGINT'));

  // Windows-specific: handle OS shutdown/logoff/restart.
  // Detached Node processes on Windows don't receive SIGTERM on shutdown.
  // 'beforeExit' won't fire either. We use the 'exit' event as a last-resort
  // synchronous save, and also periodic state saves to minimize data loss.
  if (process.platform === 'win32') {
    process.on('exit', () => {
      // Synchronous-only — dump what we can before process dies
      try {
        const managed = sessionManager.listManagedSessions();
        stateWriter.ensureBufferDir();
        for (const m of managed) {
          if (m.meta.state === 'dead') continue;
          const dumpPath = stateWriter.getBufferDumpPath(m.meta.id);
          try {
            const data = m.ringBuffer.readAll();
            fs.writeFileSync(dumpPath, data);
            m.meta.state = 'suspended';
            m.meta.bufferDumpPath = dumpPath;
          } catch { /* best effort */ }
        }
        const suspendState: DaemonState = {
          version: 1,
          sessions: managed.map((m) => ({ ...m.meta })),
        };
        stateWriter.saveImmediate(suspendState);
      } catch { /* best effort */ }
    });
  }

  // 10. Uncaught error handlers
  process.on('uncaughtException', (err) => {
    log('error', 'Uncaught exception:', err);
    doShutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log('error', 'Unhandled rejection:', reason);
  });

  log('info', `Daemon ready — pipe: ${activePipeName}`);
}

main().catch((err) => {
  log('error', 'Fatal error during startup:', err);
  releaseLock();
  process.exit(1);
});
