/**
 * Monitors child process liveness by periodically checking PID status.
 * No Electron dependencies — uses only Node.js APIs.
 *
 * Uses a single batched tasklist call (on Windows) to check all watched PIDs
 * at once, instead of spawning one process per session.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

function tasklistPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'tasklist.exe');
}

export class ProcessMonitor {
  private watchedPids: Map<string, { pid: number; onDead: () => void; imageName?: string }> = new Map();
  private batchInterval: NodeJS.Timeout | null = null;
  private batchRunning = false;

  /** Default batch cadence. app-weight P1-1: 5 s → 15 s — each Windows tick
   *  spawns a tasklist.exe (1–6 s of CPU on a contended machine), and at 5 s
   *  that spawn train was the single largest contributor to the daemon's
   *  measured 3.1% idle CPU. Worst-case death detection is now
   *  ~interval + 10 s batch timeout + 3 s re-verify ≈ 28 s (the supervision
   *  restart SLA — documented in docs/performance.md). Overridable per
   *  instance via the constructor (config.daemon.livenessIntervalSec). */
  private static readonly CHECK_INTERVAL_MS = 15_000;

  /** @param intervalMs batch cadence override (config knob); falls back to
   *  the static default at interval-creation time so tests can still stub
   *  `CHECK_INTERVAL_MS` before the first watch(). */
  constructor(private readonly intervalMs?: number) {}

  /** Check whether a process with the given PID is still alive (individual check). */
  static async isAlive(pid: number): Promise<boolean> {
    if (process.platform === 'win32') {
      // process.kill(pid, 0) is unreliable on Windows — always returns true.
      // Use tasklist which is available on all Windows versions.
      try {
        const { stdout } = await execFileAsync(
          tasklistPath(),
          ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'],
          { encoding: 'utf-8', timeout: 3000, windowsHide: true },
        );
        return (stdout as string).includes(`"${pid}"`);
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

  /**
   * Positively confirm a PID is dead. Returns true ONLY when the liveness
   * probe SUCCEEDS and reports the PID absent. THROWS when the probe itself
   * fails (tasklist timeout/error) so the caller can tell "confirmed dead"
   * from "couldn't check" and defer rather than kill.
   *
   * This is the critical distinction `isAlive` collapses: `isAlive` returns
   * `false` on a probe error, conflating an unreachable/slow tasklist with a
   * genuinely dead process. On machines where tasklist intermittently times
   * out, that false negative makes the watch loop fire onDead for LIVE
   * sessions (observed: powershell panes "exit -1" with exitCode=null while
   * the process is still running). The kill gate must require positive proof.
   */
  static async isDefinitelyDead(pid: number): Promise<boolean> {
    if (process.platform === 'win32') {
      // No catch: a timeout/error rejects, and the caller treats a rejection
      // as "unknown — do not kill". A clean run that lacks the PID is the only
      // path to a confirmed death.
      const probe = await ProcessMonitor.probeWindowsPid(pid);
      return !probe.present;
    }
    // POSIX: kill(pid, 0) is reliable. ESRCH ⇒ dead; EPERM ⇒ alive (not ours).
    try {
      process.kill(pid, 0);
      return false; // signal delivered ⇒ alive
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true; // no such process
      return false; // EPERM or other ⇒ exists / can't prove dead
    }
  }

  /**
   * Windows per-PID probe: presence + image name from a filtered tasklist
   * call. THROWS on exec failure (timeout, spawn error) so callers can tell
   * "confirmed state" from "couldn't check" — the unknown-is-never-dead
   * principle (PR #87) applies to reuse detection exactly as to death.
   */
  static async probeWindowsPid(pid: number): Promise<{ present: boolean; imageName?: string }> {
    const { stdout } = await execFileAsync(
      tasklistPath(),
      ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'],
      { encoding: 'utf-8', timeout: 3000, windowsHide: true },
    );
    const parsed = ProcessMonitor.parseTasklistCsv(stdout as string, new Set([pid]));
    return parsed.alive.has(pid)
      ? { present: true, imageName: parsed.images.get(pid) }
      : { present: false };
  }

  /**
   * Parse `tasklist /fo csv` output into (alive PIDs ∩ pidSet) plus their
   * image names. Pure — exported for unit tests. Lines that don't match the
   * CSV shape (headers, locale banners like "INFO: No tasks...") are ignored.
   */
  static parseTasklistCsv(
    stdout: string,
    pidSet: ReadonlySet<number>,
  ): { alive: Set<number>; images: Map<number, string> } {
    const alive = new Set<number>();
    const images = new Map<number, string>();
    for (const line of stdout.split('\n')) {
      // CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
      const match = line.match(/^"([^"]*)","(\d+)"/);
      if (!match) continue;
      const runningPid = parseInt(match[2], 10);
      if (!pidSet.has(runningPid)) continue;
      alive.add(runningPid);
      images.set(runningPid, match[1]);
    }
    return { alive, images };
  }

  /**
   * Batch-check all given PIDs in a single tasklist call (Windows).
   * Returns the set of PIDs that are alive.
   */
  static async batchCheckAlive(pids: number[]): Promise<Set<number>> {
    return (await ProcessMonitor.batchCheckAliveDetailed(pids)).alive;
  }

  /**
   * Batch liveness plus image names (Windows). Image names feed the PID-reuse
   * check in the watch loop (app-weight P1-1): a ghost "alive" from a reused
   * PID keeps `listLiveSessions() > 0`, which blocks the daemon's idle
   * self-shutdown and pins the session's RingBuffer. POSIX returns an empty
   * image map (kill(0) carries no identity — reuse detection is Windows-only).
   */
  static async batchCheckAliveDetailed(
    pids: number[],
  ): Promise<{ alive: Set<number>; images: Map<number, string> }> {
    const empty = { alive: new Set<number>(), images: new Map<number, string>() };
    if (pids.length === 0) return empty;

    if (process.platform === 'win32') {
      try {
        // Single call: get full process list in CSV format (no filter)
        const { stdout } = await execFileAsync(
          tasklistPath(),
          ['/fo', 'csv', '/nh'],
          { encoding: 'utf-8', timeout: 10000, windowsHide: true },
        );
        return ProcessMonitor.parseTasklistCsv(stdout as string, new Set(pids));
      } catch {
        // On failure, fall back to per-PID probes. probeWindowsPid returns
        // the image name too, so the PID-reuse check keeps working exactly
        // when it matters most — a loaded machine where the full-list
        // tasklist timed out is also where the OS recycles PIDs fastest
        // (GLM review, PR #471). A per-PID probe failure marks the pid
        // not-alive here, same as the old isAlive fallback; the watch loop's
        // isDefinitelyDead re-verify still gates any actual death.
        const alive = new Set<number>();
        const images = new Map<number, string>();
        for (const pid of pids) {
          try {
            const probe = await ProcessMonitor.probeWindowsPid(pid);
            if (probe.present) {
              alive.add(pid);
              if (probe.imageName) images.set(pid, probe.imageName);
            }
          } catch { /* unknown — not added; re-verify gates death */ }
        }
        return { alive, images };
      }
    }
    // Non-Windows: use process.kill(pid, 0) for each
    const alive = new Set<number>();
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        alive.add(pid);
      } catch {
        // not alive
      }
    }
    return { alive, images: new Map() };
  }

  /** Start monitoring a process. Calls onDead when the process is no longer alive. */
  watch(sessionId: string, pid: number, onDead: () => void): void {
    // Clear any existing watcher for this session
    this.unwatch(sessionId);
    this.watchedPids.set(sessionId, { pid, onDead });
    this.ensureBatchInterval();
    // Immediate first check so a PID that is already dead at watch() time
    // doesn't have to wait CHECK_INTERVAL_MS for the first interval tick.
    // batchRunning guards against concurrent overlap with a running cycle.
    void this.runBatchCheck();
  }

  /** Stop monitoring a specific session. */
  unwatch(sessionId: string): void {
    this.watchedPids.delete(sessionId);
    // Stop the batch interval if nothing is being watched
    if (this.watchedPids.size === 0 && this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
  }

  /** Stop monitoring all sessions. */
  unwatchAll(): void {
    this.watchedPids.clear();
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
    this.batchRunning = false;
  }

  /** Ensure a single batch interval is running. The cadence is resolved at
   *  creation time (instance override → static default) so tests that stub
   *  `CHECK_INTERVAL_MS` before the first watch() keep working. */
  private ensureBatchInterval(): void {
    if (this.batchInterval) return;
    this.batchInterval = setInterval(() => {
      this.runBatchCheck();
    }, this.intervalMs ?? (ProcessMonitor as unknown as { CHECK_INTERVAL_MS: number }).CHECK_INTERVAL_MS);
    if (this.batchInterval.unref) {
      this.batchInterval.unref();
    }
  }

  /** Run one batch check cycle. */
  private runBatchCheck(): void {
    if (this.batchRunning) return; // skip if previous check still in flight
    if (this.watchedPids.size === 0) return;

    this.batchRunning = true;

    // Snapshot the current watch list
    const entries = Array.from(this.watchedPids.entries());
    const pids = entries.map(([, v]) => v.pid);

    void ProcessMonitor.batchCheckAliveDetailed(pids)
      .then(async ({ alive: aliveSet, images }) => {
        // Collect every session the batch reports dead, then re-verify each one
        // via a second, independent `tasklist /fi PID eq <pid>` call. The batch
        // path uses the unfiltered process list (`tasklist /fo csv /nh`); any
        // truncation, locale mismatch, or transient empty stdout in that single
        // call would otherwise mark every watched PID dead in one cycle and
        // cascade-fire onDead for every session simultaneously. The per-PID
        // re-verify uses different command arguments and an independent
        // execFile invocation, so a parse failure in one is highly unlikely
        // to repeat in the other.
        const apparentlyDead: Array<[string, { pid: number; onDead: () => void; imageName?: string }]> = [];
        // PID-reuse suspects (app-weight P1-1): the PID answered the batch,
        // but under a DIFFERENT image name than when we first observed it —
        // the watched process died and the OS handed its PID to something
        // else. Without this check the ghost stays "alive" forever, blocking
        // idle self-shutdown and pinning the session's RingBuffer.
        const reuseSuspects: Array<[string, { pid: number; onDead: () => void; imageName?: string }]> = [];
        for (const entry of entries) {
          const [sessionId, info] = entry;
          if (!this.watchedPids.has(sessionId)) continue;
          if (!aliveSet.has(info.pid)) {
            apparentlyDead.push(entry);
            continue;
          }
          const seenImage = images.get(info.pid);
          if (!seenImage) continue; // POSIX / fallback path — no identity info
          if (!info.imageName) {
            // First observation: bind the identity. Best-effort — if the PID
            // was already reused before we ever saw it, this binds the new
            // occupant, which is no worse than the pre-P1 behavior.
            info.imageName = seenImage;
            continue;
          }
          if (info.imageName.toLowerCase() !== seenImage.toLowerCase()) {
            reuseSuspects.push(entry);
          }
        }

        // Re-verify reuse suspects with an independent per-PID probe before
        // declaring death — same unknown-is-never-dead discipline as below.
        for (const [sessionId, info] of reuseSuspects) {
          if (!this.watchedPids.has(sessionId)) continue;
          try {
            const probe = await ProcessMonitor.probeWindowsPid(info.pid);
            if (!probe.present) {
              apparentlyDead.push([sessionId, info]); // died between calls
              continue;
            }
            if (
              probe.imageName &&
              info.imageName &&
              probe.imageName.toLowerCase() !== info.imageName.toLowerCase()
            ) {
              // Confirmed: same PID, different process. The watched process
              // is gone — fire onDead exactly as a confirmed death.
              if (!this.watchedPids.has(sessionId)) continue;
              this.unwatch(sessionId);
              info.onDead();
            }
            // Same image on re-probe → the batch parse glitched; leave it.
          } catch {
            // Probe failed: unknown, never dead. Defer to the next cycle.
          }
        }

        if (apparentlyDead.length === 0) return;

        for (const [sessionId, { pid, onDead }] of apparentlyDead) {
          // Skip if unwatched during async re-verification
          if (!this.watchedPids.has(sessionId)) continue;

          let confirmedDead = false;
          try {
            // Require POSITIVE proof of death. isDefinitelyDead throws when the
            // probe itself fails (tasklist timeout), so a slow/unreachable
            // tasklist can NEVER be read as "dead" — it falls into the catch
            // and defers. (Previously this used `!isAlive(pid)`, which returns
            // false on a probe error and thus mis-fired onDead for live
            // sessions whenever tasklist timed out — the "powershell exit -1 /
            // exitCode=null" false death.)
            confirmedDead = await ProcessMonitor.isDefinitelyDead(pid);
          } catch {
            // Probe failed (timeout/error): cannot confirm death. Defer to the
            // next cycle rather than killing a possibly-live session. Better to
            // leave a watcher in place for one extra tick than to mass-kill
            // live sessions when the OS is having a bad five seconds.
            confirmedDead = false;
          }

          if (!confirmedDead) continue;
          if (!this.watchedPids.has(sessionId)) continue;
          this.unwatch(sessionId);
          onDead();
        }
      })
      .catch(() => {
        // Batch check failed entirely — skip this cycle
      })
      .finally(() => {
        this.batchRunning = false;
      });
  }
}
