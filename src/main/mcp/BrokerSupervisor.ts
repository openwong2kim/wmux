import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

/**
 * Supervises the shared MCP broker process (Option A,
 * plans/mcp-broker-design-2026-07-16.md). Mirrors the daemon launcher's
 * pattern: Electron's own binary with ELECTRON_RUN_AS_NODE=1, restart with
 * backoff on crash, no restart on the "pipe already owned" exit (75).
 *
 * Rollout flag: WMUX_MCP_BROKER=1 (default OFF). While OFF nothing here
 * runs and registration keeps pointing agents at the single-child bundle —
 * the pre-broker world, byte for byte.
 */
export function isMcpBrokerEnabled(): boolean {
  return process.env.WMUX_MCP_BROKER === '1';
}

const RESTART_BACKOFF_MS = [500, 1000, 2000, 5000, 10000];
/** A broker that survived this long resets the backoff ladder. */
const STABLE_MS = 30_000;
const EXIT_ALREADY_RUNNING = 75;

export class BrokerSupervisor {
  private child: ChildProcess | null = null;
  private restarts = 0;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;

  /** Resolve the broker script for the current build layout. */
  private getBrokerScriptPath(): string | null {
    if (app.isPackaged) {
      const bundled = path.join(process.resourcesPath, 'mcp-bundle', 'broker.js');
      return fs.existsSync(bundled) ? bundled : null;
    }
    // Dev: unbundled tsc output (has node_modules access), same layout rule
    // as McpRegistrar.getMcpScriptPath.
    const devPath = path.join(app.getAppPath(), 'dist', 'mcp', 'mcp', 'broker.js');
    return fs.existsSync(devPath) ? devPath : null;
  }

  start(): void {
    if (this.stopped || this.child) return;
    const script = this.getBrokerScriptPath();
    if (!script) {
      console.error('[BrokerSupervisor] broker script not found — broker disabled');
      return;
    }

    const startedAt = Date.now();
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    console.log(`[BrokerSupervisor] broker started pid=${child.pid}`);

    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) console.log(`[mcp-broker] ${line}`);
    });

    // Guard so a spawn 'error' and the trailing 'exit' don't both schedule a
    // restart (a failed spawn emits both).
    let settled = false;
    const scheduleRestart = (reason: string) => {
      if (settled) return;
      settled = true;
      this.child = null;
      if (this.stopped) return;
      if (Date.now() - startedAt > STABLE_MS) this.restarts = 0;
      const delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)];
      this.restarts++;
      console.error(`[BrokerSupervisor] ${reason}; restart in ${delay}ms`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, delay);
    };

    // A spawn failure (EPERM, ENOENT, ...) emits 'error'. With no listener this
    // throws in the main process and can take down the whole app for an optional
    // feature — treat it like a crash exit: log, clear the handle, fail open via
    // the same backoff restart.
    child.on('error', (err) => {
      console.error(`[BrokerSupervisor] broker spawn error: ${err.message}`);
      scheduleRestart('broker spawn error');
    });

    child.on('exit', (code, signal) => {
      if (this.stopped) {
        this.child = null;
        settled = true;
        return;
      }
      if (code === EXIT_ALREADY_RUNNING) {
        // Another live broker owns the pipe (e.g. HMR main reload raced the
        // old instance). The pipe is served either way — do not fight it.
        this.child = null;
        settled = true;
        console.log('[BrokerSupervisor] pipe already served by another broker; standing down');
        return;
      }
      scheduleRestart(`broker exited code=${code} signal=${signal}`);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
