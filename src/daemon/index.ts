import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, getWmuxDir } from './config';
import { DaemonSessionManager } from './DaemonSessionManager';
import { DaemonPipeServer } from './DaemonPipeServer';
import { SessionPipe } from './SessionPipe';
import { ProcessMonitor } from './ProcessMonitor';
import { Watchdog } from './Watchdog';
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

// === RPC handler registration ===

function registerRpcHandlers(
  pipeServer: DaemonPipeServer,
  sessionManager: DaemonSessionManager,
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

// === Graceful shutdown ===

let shuttingDown = false;

async function shutdown(
  signal: string,
  sessionManager: DaemonSessionManager,
  pipeServer: DaemonPipeServer,
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

  // Dispose all sessions (kills PTYs, clears map)
  sessionManager.disposeAll();

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
  const sessionManager = new DaemonSessionManager();
  sessionManager.setConfig(config);
  const pipeServer = new DaemonPipeServer(config.daemon.pipeName);
  const processMonitor = new ProcessMonitor();
  const watchdog = new Watchdog(30000);
  const sessionPipes = new Map<string, SessionPipe>();
  const sessionDataListeners = new Map<string, { bridge: import('./DaemonPTYBridge').DaemonPTYBridge; listener: (data: Buffer) => void }>();

  // 4. Register RPC handlers
  registerRpcHandlers(pipeServer, sessionManager, sessionPipes, processMonitor, startTime, sessionDataListeners, watchdog);

  // 5. Wire events
  wireEvents(sessionManager, pipeServer, sessionPipes, processMonitor, sessionDataListeners);

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
        sessionManager.destroySession(managed.meta.id);
        reaped++;
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
        sessionManager.destroySession(managed.meta.id);
        reaped++;
      }
    }
    if (reaped > 0) {
      log('info', `Reaped ${reaped} expired dead session(s)`);
    }
  }, 60 * 60 * 1000); // Every hour
  reapInterval.unref();

  // 9. Signal handlers
  const doShutdown = (sig: string) =>
    shutdown(sig, sessionManager, pipeServer, sessionPipes, processMonitor, watchdog);

  process.on('SIGTERM', () => doShutdown('SIGTERM'));
  process.on('SIGINT', () => doShutdown('SIGINT'));

  // Windows-specific: handle OS shutdown/logoff/restart.
  if (process.platform === 'win32') {
    process.on('exit', () => {
      try {
        sessionManager.disposeAll();
        releaseLock();
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
