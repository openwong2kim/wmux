import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { canConnectBrokerPipe } from './brokerProbe';
import { parseBrokerConnectionsReport, type BrokerDownReason, type BrokerStatus } from '../../shared/mcpSessions';

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
  /** When the current child was spawned; null while none runs. */
  private childStartedAt: number | null = null;
  /** Open connections, as the current child last reported them. */
  private connections = 0;
  private crashExits = 0;
  /** Spawns that failed outright (ENOENT, EPERM, a scanner): not crashes. */
  private spawnFailures = 0;
  private standDowns = 0;

  /** The running broker's pid, for telling its relayed calls apart (peer pid measurement). */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Counts for `wmux doctor` (mcp.sessions.summary). */
  status(): BrokerStatus {
    const pid = this.child?.pid ?? null;
    return {
      running: pid !== null,
      pid,
      uptimeS: this.child && this.childStartedAt !== null ? Math.floor((Date.now() - this.childStartedAt) / 1000) : null,
      connections: this.child ? this.connections : 0,
      crashExits: this.crashExits,
      spawnFailures: this.spawnFailures,
      standDowns: this.standDowns,
      standingDown: this.reclaimTimer !== null,
      downReason: this.downReason(),
    };
  }

  private downReason(): BrokerDownReason | null {
    if (this.child) return null;
    if (this.stopped) return 'stopped';
    if (this.scriptMissing) return 'script-missing';
    if (this.reclaimTimer) return 'standing-down';
    if (this.restartTimer) return 'restarting';
    return 'not-started';
  }

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

    // Defensive: if a reclaim probe is somehow still armed as we spawn our own
    // child, tear it down — otherwise every 15s tick would see our live broker
    // and early-return without ever clearing, leaking the interval. Not
    // reachable in current wiring (reclaimTick clears its own timer before
    // calling start()), purely belt-and-suspenders.
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }

    const startedAt = Date.now();
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // The IPC channel carries the broker's connection reports; stdout stays
      // ignored, since a hosted server's stray console.log would land there.
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.child = child;
    this.childStartedAt = startedAt;
    this.connections = 0;
    console.log(`[BrokerSupervisor] broker started pid=${child.pid}`);

    child.on('message', (message: unknown) => {
      if (this.child !== child) return;
      const open = parseBrokerConnectionsReport(message);
      if (open !== null) this.connections = open;
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) console.log(`[mcp-broker] ${line}`);
    });

    // Guard so a spawn 'error' and the trailing 'exit' don't both schedule a
    // restart (a failed spawn emits both).
    let settled = false;
    const scheduleRestart = (reason: string, kind: 'crash' | 'spawn') => {
      if (settled) return;
      settled = true;
      this.clearChild();
      if (this.stopped) return;
      if (kind === 'spawn') this.spawnFailures++;
      else this.crashExits++;
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
    // A child that is no longer the current one (stop() then resume() spawned a
    // replacement before it exited) must not touch the replacement's state.
    child.on('error', (err) => {
      if (this.child !== child) return;
      console.error(`[BrokerSupervisor] broker spawn error: ${err.message}`);
      scheduleRestart('broker spawn error', 'spawn');
    });

    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      if (this.stopped) {
        this.clearChild();
        settled = true;
        return;
      }
      if (code === EXIT_ALREADY_RUNNING) {
        // Another live broker owns the pipe (e.g. HMR main reload raced the
        // old instance). The pipe is served either way — do not fight it, but
        // keep probing: if that other broker later dies, nothing else would
        // reclaim the orphaned pipe and every shim would be stranded (W2).
        this.clearChild();
        settled = true;
        this.standDowns++;
        console.log('[BrokerSupervisor] pipe already served by another broker; standing down');
        this.startReclaimProbe();
        return;
      }
      scheduleRestart(`broker exited code=${code} signal=${signal}`, 'crash');
    });
  }

  private clearChild(): void {
    this.child = null;
    this.childStartedAt = null;
    this.connections = 0;
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
      this.clearChild();
    }
  }

  /**
   * Undo `stop()` for a teardown that turned out not to happen — an install-quit
   * that was prepared and then aborted (see AutoUpdaterHooks). `stop()` latches
   * `stopped` so a dying app cannot respawn the broker, and `start()` refuses to
   * run while that latch is set; an aborted teardown has to clear it or MCP
   * stays down for the rest of the session with nothing saying so.
   */
  resume(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.start();
  }
}
