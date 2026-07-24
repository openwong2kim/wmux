import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { canConnectBrokerPipe } from './brokerProbe';

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
/** How often a stood-down supervisor probes whether the pipe was orphaned. */
const RECLAIM_PROBE_MS = 15_000;
/** Per-probe connect timeout — Windows named-pipe connect can hang without it. */
const PROBE_TIMEOUT_MS = 200;

export class BrokerSupervisor {
  private child: ChildProcess | null = null;
  private restarts = 0;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  /** Set when start() bailed because the broker script was missing. */
  private scriptMissing = false;
  /** Exit-75 reclaim probe (W2): live only while standing down for another broker. */
  private reclaimTimer: NodeJS.Timeout | null = null;

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
      this.scriptMissing = true;
      console.error('[BrokerSupervisor] broker script not found — broker disabled');
      return;
    }
    this.scriptMissing = false;

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
        // old instance). The pipe is served either way — do not fight it, but
        // keep probing: if that other broker later dies, nothing else would
        // reclaim the orphaned pipe and every shim would be stranded (W2).
        this.child = null;
        settled = true;
        console.log('[BrokerSupervisor] pipe already served by another broker; standing down');
        this.startReclaimProbe();
        return;
      }
      scheduleRestart(`broker exited code=${code} signal=${signal}`);
    });
  }

  /**
   * Resolve `true` once the broker pipe accepts a test connection, `false` on
   * deadline. Never rejects and never blocks boot beyond `timeoutMs`: the caller
   * uses the result to decide whether agents get the shim (broker up) or the
   * full bundle (broker down) — a false is a fail-open, not an error (W1).
   *
   * Polls every 200ms; each probe socket carries its own 200ms connect timeout
   * so a half-open pipe (server spawned but not yet listening) can't hang us.
   */
  async whenReady(timeoutMs = 4000): Promise<boolean> {
    // start() already gave up (script missing) — no point polling to the deadline.
    if (this.scriptMissing) return false;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await canConnectBrokerPipe(PROBE_TIMEOUT_MS)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS));
    }
  }

  /**
   * After standing down on exit 75, poll the pipe: when a probe FAILS to
   * connect the other broker is gone, so clear the timer and reclaim the pipe
   * via start(). If two instances both stood down, both reclaim and one loses
   * the race (exit 75 again → re-arms this probe), converging to one owner.
   */
  private startReclaimProbe(): void {
    if (this.stopped || this.reclaimTimer) return;
    this.reclaimTimer = setInterval(() => {
      void this.reclaimTick();
    }, RECLAIM_PROBE_MS);
  }

  private async reclaimTick(): Promise<void> {
    if (await canConnectBrokerPipe(PROBE_TIMEOUT_MS)) return; // still owned — keep waiting
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }
    if (this.stopped) return;
    console.log('[BrokerSupervisor] broker pipe orphaned — reclaiming');
    this.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
