import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import { getWmuxDir } from '../../daemon/config';
import { getDaemonPipeName, readDaemonAuthToken } from '../../main/DaemonClient';
import { DAEMON_EXIT_ALREADY_RUNNING, ENV_KEYS } from '../constants';
import { classifyTasklistOutput, classifyKillOutcome, type ProcessLiveness } from '../processLiveness';

export interface DaemonInfo {
  /**
   * `null` only on the yield-and-reconnect path (`spawned: false`): our spawn
   * lost the race to an already-live daemon, and that daemon's ping omitted
   * `pid` (pre-Step-③ daemon) with no `daemon.pid` file to fall back to
   * either. Every `spawned: true` result carries a real, verified pid from
   * the child we just spawned — never null.
   */
  pid: number | null;
  authToken: string;
  pipeName: string;
  spawned: boolean;
}

/**
 * Everything a caller of this module must supply because it differs between
 * hosts: Electron main resolves the bundled script via `app.getAppPath()` /
 * `process.resourcesPath` and recovers a stale PID through a native dialog;
 * `wmux daemon` (headless CLI, #1001) resolves the script relative to its own
 * bundle location and never has a window to put a dialog in, so it always
 * takes the `WMUX_NO_DIALOG=1` branch structurally instead of by env var.
 *
 * This module deliberately has ZERO import of `electron` — that is the whole
 * point of the extraction (#1001): the spawn/readiness chain is shared code,
 * not copied code, so `src/main/daemon/launcher.ts` and
 * `src/cli/commands/daemon.ts` cannot drift apart the way two independent
 * implementations would.
 */
export interface DaemonLauncherDeps {
  /**
   * Candidate paths for the daemon entry script, in priority order. The first
   * one that exists on disk wins — mirrors the historical production /
   * production-fallback / development / development-fallback list.
   */
  resolveDaemonScriptCandidates(): string[];
  /** Stamped into `ENV_KEYS.SPAWNED_BY_VERSION` — see the call site below for why this must never be empty. */
  resolveSpawnedByVersion(): string;
  /**
   * Ask whether to clean up and spawn over a PID whose liveness could not be
   * verified. Returning `false` takes the existing "refuse" branch — the
   * daemon is a stateful process holding live PTYs, so a headless caller must
   * never guess "probably dead" and spawn over it.
   */
  askUserToRecoverFromStalePid(opts: { reason: string; pid: number; pidFile: string }): Promise<boolean>;
  /**
   * Whether THIS host is Electron. Previously inferred as
   * `nodePath === process.execPath && !nodePath.toLowerCase().includes('node.exe')`
   * — a heuristic that happened to work when this module only ever ran
   * inside Electron. Since #1001 a headless CLI process also calls
   * `spawnDaemon`, and on non-Windows hosts the plain Node binary is named
   * `node`, not `node.exe`, so the substring check would misclassify a
   * headless CLI spawn as Electron and set `ELECTRON_RUN_AS_NODE=1` on a
   * process that doesn't understand it. Explicit and unambiguous instead.
   */
  isElectronHost(): boolean;
  /**
   * Optional boot-phase timing hook (see `main/util/bootTrace.ts`). Deliberately
   * NOT a static import here: that module's body writes a `[boot-trace]` line
   * to stderr as a side effect of merely being loaded (it needs to capture
   * `js-start` at eval time). This module is imported by every `wmux` CLI
   * subcommand via `commands/daemon.ts` → `src/cli/index.ts`'s static import
   * list, so a static import here would print that line on every invocation
   * of the CLI, not just `wmux daemon *`. Electron's launcher supplies the
   * real one; the headless CLI omits it and gets a silent no-op via `?.`.
   */
  markBoot?(name: string): void;
  /**
   * Diagnostic logging for the spawn/reuse/recovery chain — candidate paths
   * tried, PID found, recovery decisions. Omit to get the historical
   * `console.log`/`console.warn` behavior (what Electron's launcher still
   * gets, unchanged). The headless CLI supplies its own here instead of
   * omitting: this module is invoked from `runStart`'s `--json` branch,
   * where the ONLY thing allowed on stdout is the final JSON object — a
   * bare `console.log` diagnostic printed ahead of it would corrupt any
   * `wmux daemon start --json | jq .` pipeline. Routing both `log` and
   * `warn` to stderr (not just `warn`) keeps that contract regardless of
   * `--json` vs text mode, since neither CLI output shape has room for
   * launcher-internal chatter mixed into it.
   */
  log?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

// `ProcessLiveness` + the pure classifiers now live in shared/processLiveness so
// the daemon (a bare Node process that must NOT import this electron-dependent
// module) shares the exact same contract. Re-exported here so existing importers
// (launcher.liveness.test.ts) keep resolving them from '../launcher'.
export { classifyTasklistOutput, classifyKillOutcome };
export type { ProcessLiveness };

/**
 * Three-state liveness probe. A probe FAILURE (timeout / exec error) is
 * `unknown`, never `dead` — mirroring `ProcessMonitor.isDefinitelyDead`
 * (PR #87). Only positive confirmation of death (`dead`) may authorize a
 * destructive / spawn-over branch; callers must treat `unknown` as "assume
 * alive, do not spawn over it." Reading a probe timeout as "process absent"
 * was the upstream trigger of the duplicate-daemon / split-brain bug
 * (Defect 1): tasklist stalls on a loaded box → false "dead" → ensureDaemon
 * skips ping/reuse and spawns a second daemon over the live one.
 */
export function checkProcessLiveness(pid: number): ProcessLiveness {
  if (process.platform === 'win32') {
    let stdout: string | null = null;
    try {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const tasklist = path.join(systemRoot, 'System32', 'tasklist.exe');
      stdout = execFileSync(tasklist, ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
        encoding: 'utf-8', timeout: 3000, windowsHide: true,
      });
    } catch {
      stdout = null; // timeout / exec failure → unknown (NOT dead)
    }
    return classifyTasklistOutput(pid, stdout);
  }
  try {
    process.kill(pid, 0);
    return classifyKillOutcome(undefined);
  } catch (err: unknown) {
    return classifyKillOutcome((err as NodeJS.ErrnoException | undefined)?.code);
  }
}

/**
 * Look up the process image name (executable basename) for a PID, so the
 * launcher can verify a PID actually belongs to wmux before sending SIGKILL.
 *
 * Critical for the "alive but unresponsive" branch: after a crash, the OS
 * may reuse the daemon's PID for an unrelated user process (Chrome, an
 * IDE, anything). Killing whichever process owns the recycled PID is a
 * tier-1 "wtf is wmux doing" bug.
 *
 * Returns null when lookup fails — callers must treat null as "don't kill".
 */
function getProcessImageName(pid: number): string | null {
  if (process.platform === 'win32') {
    try {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const tasklist = path.join(systemRoot, 'System32', 'tasklist.exe');
      const result = execFileSync(tasklist, ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
        encoding: 'utf-8', timeout: 3000, windowsHide: true,
      });
      // tasklist /fo csv /nh format:
      //   "image.exe","PID","sessionName","sessionNum","memUsage"
      const match = result.match(/^"([^"]+)"/);
      return match ? match[1] : null;
    } catch { return null; }
  }
  // Linux: /proc/<pid>/comm carries the executable name (truncated to 15
  // bytes). Fast path because /proc reads are basically free.
  if (process.platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
    } catch { return null; }
  }
  // macOS / other POSIX without /proc: shell out to `ps`. The `comm=`
  // format spec strips the header and emits just the executable name.
  // (Codex review #5 — without this branch, Darwin lookups always
  // returned null and the launcher threw on every unresponsive daemon
  // instead of recovering.)
  try {
    const result = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf-8', timeout: 3000,
    });
    const trimmed = result.trim();
    if (!trimmed) return null;
    // `ps -o comm=` returns the full path on macOS; the basename
    // matches the expected wmux image more reliably across builds.
    return path.basename(trimmed);
  } catch { return null; }
}

/**
 * Read a process's full command line, so callers can verify it actually
 * carries the daemon-script path before treating it as a wmux daemon.
 *
 * This is the second safety net for the kill path: image basename alone
 * ("electron.exe" in dev) collides with the main process itself and with
 * any other Electron-based app the user happens to be running. Adding
 * "did this process get spawned with the daemon script as argv[1]"
 * narrows the false-positive surface dramatically.
 *
 * On Windows uses PowerShell + CIM (WMI replacement) — wmic is being
 * deprecated and this path runs at most once per ensureDaemon() call.
 * Returns null on any failure; callers must treat null as "can't verify".
 */
function getProcessCommandLine(pid: number): string | null {
  if (process.platform === 'win32') {
    try {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const powershell = path.join(
        systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
      );
      // Single quotes around the filter so the parser doesn't expand
      // anything; -NoProfile keeps startup cheap.
      const result = execFileSync(
        powershell,
        [
          '-NoProfile', '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
        ],
        { encoding: 'utf-8', timeout: 5000, windowsHide: true },
      );
      const trimmed = result.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch { return null; }
  }
  // Linux: /proc/<pid>/cmdline carries the argv joined by NUL.
  if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return raw.replace(/\0/g, ' ').trim() || null;
    } catch { return null; }
  }
  // macOS / other POSIX without /proc: shell out to `ps`. (Codex
  // review #5 — Darwin builds need this path so the daemon verifier
  // can confirm cmdline carries the daemon-script path.)
  try {
    const result = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8', timeout: 3000,
    });
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch { return null; }
}

/** Quote-aware split of a raw command line into argv-shaped tokens, so a
 * Windows path containing spaces (inside `"..."`) survives as one token
 * instead of fragmenting on its internal whitespace. */
function tokenizeCommandLine(cmdline: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmdline)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return tokens;
}

/**
 * Does this command line invoke one of wmux's daemon entry-script paths?
 *
 * Two signals, strongest first.
 *
 * **Identity (#1025).** `scriptCandidates` are the exact paths THIS host
 * would spawn (`deps.resolveDaemonScriptCandidates()`). If a cmdline token
 * equals one of them, the process is running the very script we launch —
 * that is proof, not a pattern. Marker matching cannot reach this bar: the
 * previous generic markers accepted any argv carrying `<anything>/daemon/
 * index.js`, an extremely common project layout, so an unrelated
 * `node /srv/app/daemon/index.js` inheriting a recycled PID was verified as
 * ours and SIGKILLed (reproduced by execution in #1025). Those markers are
 * gone; the dev-checkout layouts they existed for (`dist/daemon/daemon/
 * index.js`, `dist/daemon/index.js`) are candidates, so identity covers them.
 *
 * **Cross-host fallback.** Since #1001 a daemon may have been spawned by a
 * different host than the one asking — Electron killing a CLI-spawned
 * daemon, or the reverse — and the two resolve their scripts from different
 * roots, so the asking host's candidate list will not contain the other's
 * path. A path segment beginning `daemon-bundle` keeps that case working:
 * the name is wmux's own (package.json's `build:daemon` esbuild outfile),
 * not a generic layout, and it is what every packaged install runs. The
 * segment must BEGIN with it (a build/test variant may suffix it), which is
 * what keeps `/srv/my-daemon-bundle-backup/index.js` out — there the marker
 * is not at the segment's start.
 *
 * Callers that cannot supply candidates get the fallback alone. That is a
 * deliberate narrowing: refusing to kill degrades to the respawn budget and
 * a manual-recovery message, while a false positive kills a stranger's
 * process, so the asymmetry belongs on the refusing side.
 */
function cmdlineMatchesDaemonScript(cmdline: string, scriptCandidates: string[] = []): boolean {
  const tokens = tokenizeCommandLine(cmdline);
  // Windows path comparison is case-insensitive; POSIX is not, and folding
  // case there would accept a genuinely different file.
  const normalize = (raw: string): string => {
    const slashed = raw.replace(/\\/g, '/');
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
  };

  if (scriptCandidates.length > 0) {
    const wanted = new Set(scriptCandidates.map(normalize));
    for (const token of tokens) {
      if (wanted.has(normalize(token))) return true;
    }
  }

  for (const token of tokens) {
    for (const segment of normalize(token).split('/')) {
      if (segment.startsWith('daemon-bundle')) return true;
    }
  }
  return false;
}

export interface DaemonPingResult {
  status?: string;
  pid?: number;
  uptime?: number;
  sessions?: number;
  eventLoopLagMs?: number;
  // B′ auto-replace additives. A pre-B′ daemon omits both; a B′ daemon always
  // sends spawnedByVersion (sentinel 'unknown' when its spawn env was bare).
  spawnedByVersion?: string;
  channelsEpoch?: number;
}

/**
 * Send `daemon.ping` and return the daemon's reported result (which carries
 * `pid` since the Step ③ follow-up), or `null` on timeout / error / refusal.
 * `pingDaemon` is the boolean wrapper most callers use; the reconnect path
 * uses the result's `pid` to restore daemon.pid.
 */
function daemonPing(pipeName: string, token: string, timeoutMs = 3000): Promise<DaemonPingResult | null> {
  return new Promise((resolve) => {
    const socket = net.connect(pipeName);
    let settled = false;
    const finish = (value: DaemonPingResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();

    socket.on('connect', () => {
      const id = crypto.randomUUID();
      socket.write(JSON.stringify({ id, method: 'daemon.ping', params: {}, token }) + '\n');
    });

    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line.trim());
          if (resp.ok || (resp.result && resp.result.status === 'ok')) {
            finish((resp.result as DaemonPingResult) ?? { status: 'ok' });
            return;
          }
        } catch { /* not a complete/valid JSON ping line yet — keep buffering */ }
      }
    });

    socket.on('error', () => finish(null));
  });
}

function pingDaemon(pipeName: string, token: string, timeoutMs = 3000): Promise<boolean> {
  return daemonPing(pipeName, token, timeoutMs).then((r) => r !== null);
}

/**
 * Escalating re-ping. After the two short startup pings (250+250 ms) fail,
 * give a busy-but-alive daemon a longer budget before treating it as wedged
 * and SIGKILLing it — which would destroy the sessions the user chose to keep
 * (split-brain Defect 2). Injectable (`ping`/`sleep` passed in) so the
 * reuse-vs-kill decision is unit-testable without a live daemon. Returns true
 * as soon as any escalated ping succeeds (→ reuse, do not kill); stops at the
 * first success.
 */
export async function tryEscalatedReping(
  ping: (timeoutMs: number) => Promise<boolean>,
  timeouts: number[],
  backoffMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (const timeoutMs of timeouts) {
    await sleep(backoffMs);
    if (await ping(timeoutMs)) return true;
  }
  return false;
}

/**
 * Issue #546 — parse the daemon's boot-progress marker (`daemon-booting`,
 * written by the daemon's acquireLock()). True only when it names EXACTLY the
 * PID we already verified as a live wmux daemon. Missing / unparseable / a
 * different PID all read false.
 *
 * PID equality is the whole safety argument: the caller reaches this only after
 * image+cmdline verification of `expectedPid`, so a marker naming that PID
 * cannot be a crashed predecessor's leftover (that marker would name a dead
 * PID, and a dead PID never gets here).
 */
export function parseBootMarker(raw: string | null, expectedPid: number): boolean {
  if (raw === null) return false;
  const parsed = parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed === expectedPid;
}

/** Poll cadence while waiting out a cold-recovering daemon (#546). */
export const BOOT_WAIT_POLL_MS = 500;

export type RecoveringWaitOutcome =
  /** A ping answered — the daemon finished booting. Reuse it, do not kill. */
  | 'alive'
  /** The marker no longer names our PID: the daemon either just became ready
   *  (it unlinks the marker right after writing its pipe file) or it died.
   *  Caller runs one final escalated re-ping to tell those apart. */
  | 'gone'
  /** Still marked as booting past the ceiling — treat as genuinely hung. */
  | 'ceiling';

export interface RecoveringWaitDeps {
  ping: (timeoutMs: number) => Promise<boolean>;
  readMarker: () => string | null;
  expectedPid: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  ceilingMs: number;
  onWaiting?: (elapsedMs: number) => void;
}

/**
 * Issue #546 — wait out a daemon that is alive and provably still booting,
 * instead of SIGKILLing it for failing a ping.
 *
 * The daemon writes `daemon.pid` at lock acquisition but its `daemon-pipe` file
 * only after `recoverSessions` completes (~19-23 s for 30-35 sessions). In that
 * window it cannot answer any ping. The reuse path used to grant it
 * `tryEscalatedReping` (~1.9 s) and then kill it, which restarts the same
 * recovery and can thrash the respawn budget into local mode with duplicate
 * sessions — the #537 symptom. #543 fixed only the spawn path, which proves
 * progress via `isChildAlive`; the reuse path has no child handle, so it reads
 * the marker instead.
 *
 *   ping ok ─────────────────────────────────► 'alive'  (reuse, no kill)
 *   marker still ours ──► sleep 500ms ──► loop
 *   marker gone/other ──────────────────────► 'gone'    (caller re-pings once)
 *   elapsed > ceiling ──────────────────────► 'ceiling' (fall through to kill)
 *
 * Ping is checked BEFORE the marker each iteration so the daemon becoming ready
 * mid-wait resolves as 'alive' rather than racing its own marker deletion.
 *
 * Every effect is injected (`ping` / `readMarker` / `sleep` / `now`), the same
 * seam `tryEscalatedReping` uses, so the decision is unit-testable with no live
 * daemon and no real clock.
 */
export async function waitOutRecoveringDaemon(
  deps: RecoveringWaitDeps,
): Promise<RecoveringWaitOutcome> {
  const start = deps.now();
  let notified = false;
  for (;;) {
    if (await deps.ping(1000)) return 'alive';
    if (!parseBootMarker(deps.readMarker(), deps.expectedPid)) return 'gone';
    const elapsed = deps.now() - start;
    if (elapsed >= deps.ceilingMs) return 'ceiling';
    if (!notified) {
      notified = true;
      deps.onWaiting?.(elapsed);
    }
    await deps.sleep(BOOT_WAIT_POLL_MS);
  }
}

/**
 * Recovery decision shared by the two "process probe was blocked" branches of
 * ensureDaemon — image-lookup-failure and command-line-lookup-failure. On
 * fleets running aggressive anti-virus, tasklist.exe / PowerShell
 * Get-CimInstance can be silently blocked and return null, so the launcher
 * cannot prove WHAT process owns the daemon PID.
 *
 * The old code went straight from a null probe to the recovery dialog. But a
 * daemon that ANSWERS A PING is provably alive regardless of what an AV-blocked
 * process probe reports — so, exactly like the verified branch already does
 * before its SIGKILL, give the busy-but-alive daemon the SAME cheap, decisive
 * escalated re-ping FIRST. A missed two-shot startup ping under ~13 concurrent
 * sessions is a busy event loop, not a dead daemon. Only if the escalated
 * re-ping ALSO fails (or there is no auth token to ping with) do we fall
 * through to the dialog.
 *
 * Injectable (`reping`/`sleep`/`askUser` passed in) so the reuse-before-dialog
 * ordering is unit-testable without a live daemon or an Electron dialog — the
 * same seam `tryEscalatedReping` already uses.
 *
 * Returns:
 *   'reuse'   — an escalated ping answered; reuse the existing daemon (no
 *               dialog, no kill).
 *   'recover' — re-ping failed (or no token) AND the user approved cleanup.
 *   'refuse'  — re-ping failed (or no token) AND the user declined (or the
 *               dialog was suppressed); the caller re-throws the legacy error.
 */
export async function recoverFromBlockedProbe(deps: {
  token: string;
  reping: (timeoutMs: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  askUser: () => Promise<boolean>;
}): Promise<'reuse' | 'recover' | 'refuse'> {
  if (deps.token) {
    // Same [500, 1000] budget / 200 ms backoff the verified branch uses.
    const alive = await tryEscalatedReping(deps.reping, [500, 1000], 200, deps.sleep);
    if (alive) return 'reuse';
  }
  return (await deps.askUser()) ? 'recover' : 'refuse';
}

/**
 * Poll cadence for the freshly-spawned daemon readiness loop.
 *
 * The daemon typically writes its pipe file and answers its first ping
 * within a few hundred ms on a warm machine, so the old fixed 200 ms
 * interval quantized that wait by +0–200 ms (~+100 ms median, visible in
 * the daemon-spawned → daemon-first-ping-ok boot-trace span). Poll densely
 * (40 ms) for the first 2 s to catch the common fast path with minimal
 * latency, then back off to the original 200 ms for the long tail
 * (Defender cold-scan, ConPTY cold-init) where poll resolution no longer
 * matters and cheap-but-nonzero pipe probes shouldn't pile onto a machine
 * that is already struggling.
 */
export function nextPollDelayMs(elapsedMs: number): number {
  return elapsedMs < 2_000 ? 40 : 200;
}

/**
 * Issue #537 — absolute wall-clock ceiling for waiting on a freshly-spawned
 * daemon that is alive but still cold-recovering (no pipe file yet). Sized for
 * the worst realistic recovery: the cap is MAX_RECOVER_SESSIONS (40) ConPTY
 * spawns, measured ~0.9 s each (~36 s), with margin for ConPTY-87 retry bursts
 * and Defender cold-scan. A boot still alive but silent past this is treated as
 * genuinely hung → reject → the app falls back to local mode (old behavior),
 * rather than hanging forever. Only applies while `isChildAlive` reports alive.
 */
export const DAEMON_READY_HARD_CEILING_MS = 90_000;

export interface DaemonReadinessPollOptions {
  budgetMs: number;
  readPipeName: () => string | null;
  readToken: () => string | null;
  ping: (pipeName: string, token: string) => Promise<boolean>;
  onPipeFileSeen?: () => void;
  onPingOk?: () => void;
  /**
   * Issue #537 — the spawned daemon writes daemon.pid at acquireLock (boot
   * start) but its daemon-pipe file only AFTER `recoverSessions` finishes, and
   * cold-recovering a large session set is slow: measured ~23 s for 30 ConPTY
   * sessions, well past `budgetMs`. Rejecting at `budgetMs` there declares a
   * live, hard-working daemon "not responding" → ensureDaemon throws →
   * replacement dead-ends → the renderer falls to local mode and every pane
   * self-creates (duplicate agent sessions, the reported symptom).
   *
   * When provided, this reports whether the child we spawned is still alive. A
   * live child that hasn't written its pipe file yet is, by construction, still
   * in its boot/recovery path (acquireLock → config → recoverSessions are the
   * only steps before the pipe file), NOT wedged — so we keep waiting past
   * `budgetMs`, up to `hardCeilingMs`, instead of abandoning it. Absent →
   * behavior is exactly the old flat-`budgetMs` give-up (callers/tests that
   * don't spawn a child, e.g. the reuse path, are unaffected).
   */
  isChildAlive?: () => boolean;
  /**
   * Absolute wall-clock cap for the `isChildAlive` extension. Only meaningful
   * with `isChildAlive`; without it the effective ceiling stays `budgetMs`.
   * Bounds a genuinely-hung-but-alive boot so the app still falls back to local
   * mode eventually rather than hanging forever. Fired-once `onSlowStart`
   * surfaces that we crossed `budgetMs` while the child was still alive.
   */
  hardCeilingMs?: number;
  /** Fired once, the first time the wait is extended past `budgetMs` because
   *  the spawned child is still alive (recovery in progress). */
  onSlowStart?: () => void;
}

/**
 * Wait for a freshly-spawned daemon to become reachable: pipe-name file
 * written → auth token readable → first ping answered.
 *
 * Self-scheduling timeout chain (not setInterval): each check runs to
 * completion — including the up-to-2 s ping — before the next one is
 * scheduled, so checks can never overlap and the old `pinging` in-flight
 * guard is structural now. The budget is wall-clock from poll start rather
 * than an attempt count because the cadence is adaptive (nextPollDelayMs).
 *
 * The pipe-file gate is preserved from the original loop: pinging before
 * the daemon writes its pipe name would connect to a zombie Windows named
 * pipe left by a crashed predecessor and burn 1 s timeouts.
 *
 * `cancel(err)` settles the poll with `err` (used when the child exits
 * with DAEMON_EXIT_ALREADY_RUNNING mid-poll); a ping already in flight is
 * discarded on return.
 */
export function pollDaemonReady(
  opts: DaemonReadinessPollOptions,
): { promise: Promise<void>; cancel: (err: Error) => void } {
  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  let pipeFileSeen = false;
  let resolveFn!: () => void;
  let rejectFn!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  const start = Date.now();
  // Issue #537 — the base `budgetMs` is the fast-path expectation; the
  // effective ceiling extends to `hardCeilingMs` while the spawned child is
  // provably alive (cold recovery). Without `isChildAlive` the ceiling stays
  // `budgetMs`, preserving the old flat give-up.
  const hardCeilingMs = opts.isChildAlive
    ? Math.max(opts.budgetMs, opts.hardCeilingMs ?? opts.budgetMs)
    : opts.budgetMs;
  const elapsedLabel = (): string => `${Math.round((Date.now() - start) / 1000)} seconds`;
  let slowStartFired = false;

  const finish = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fn();
  };

  const schedule = (): void => {
    if (settled) return;
    timer = setTimeout(() => {
      void check();
    }, nextPollDelayMs(Date.now() - start));
  };

  // Give up when we hit the hard ceiling, OR when we pass the base budget and
  // the child is not provably alive (dead, or no liveness signal supplied).
  // While the child is alive past the base budget it is still recovering —
  // keep waiting. `child died` is surfaced fast by spawnDaemon's exit handler
  // (cancel), so this predicate only tops out at the ceiling in practice.
  const overBudget = (): boolean => {
    const elapsed = Date.now() - start;
    if (elapsed >= hardCeilingMs) return true;
    if (elapsed < opts.budgetMs) return false;
    const childAlive = opts.isChildAlive ? opts.isChildAlive() : false;
    if (childAlive && !slowStartFired) {
      slowStartFired = true;
      opts.onSlowStart?.();
    }
    return !childAlive;
  };

  const check = async (): Promise<void> => {
    if (settled) return;

    // Wait for daemon to write its pipe name file before attempting ping
    const pipeName = opts.readPipeName();
    if (!pipeName) {
      if (overBudget()) {
        finish(() => rejectFn(new Error(`Daemon spawned but pipe name file not created after ${elapsedLabel()}`)));
      } else {
        schedule();
      }
      return;
    }
    if (!pipeFileSeen) {
      pipeFileSeen = true;
      opts.onPipeFileSeen?.();
    }

    const token = opts.readToken();
    if (!token) {
      if (overBudget()) {
        finish(() => rejectFn(new Error(`Daemon spawned but auth token not found after ${elapsedLabel()}`)));
      } else {
        schedule();
      }
      return;
    }

    // Defensive: the real pingDaemon never rejects (errors resolve false),
    // but the injected contract only promises Promise<boolean> — treat a
    // rejection as a failed ping instead of leaking an unhandled rejection
    // out of the void-returning chain.
    let alive: boolean;
    try {
      alive = await opts.ping(pipeName, token);
    } catch {
      alive = false;
    }
    if (settled) return; // cancelled while the ping was in flight

    if (alive) {
      opts.onPingOk?.();
      finish(() => resolveFn());
      return;
    }

    // Budget is evaluated after the ping returns, so a ping started just
    // inside the budget can settle up to one ping-timeout past it — same
    // property as the old attempt-count loop, intentional.
    if (overBudget()) {
      finish(() => rejectFn(new Error(`Daemon spawned but not responding after ${elapsedLabel()}`)));
      return;
    }
    schedule();
  };

  // First check immediately rather than after one interval: on a warm
  // machine the pipe file can already exist within tens of ms of spawn,
  // and the old fixed setInterval burned a guaranteed 200 ms before even
  // looking.
  void check();

  return { promise, cancel: (err: Error) => finish(() => rejectFn(err)) };
}

function findNodePath(): string {
  // Prefer Electron's bundled node (via ELECTRON_RUN_AS_NODE) — it's a GUI
  // subsystem executable, so it won't flash a console window on Windows.
  // System node.exe is a console app and briefly shows a window even with
  // windowsHide: true.
  return process.execPath;
}

function spawnDaemon(deps: DaemonLauncherDeps): Promise<number> {
  deps.markBoot?.('daemon-spawn-start');
  return new Promise((resolve, reject) => {
    // Set once pollDaemonReady starts below. The 'error' handler needs this
    // to tear down the poll's pending timer on a failed spawn — without it,
    // the poll keeps its own setTimeout chain alive up to the 90 s hard
    // ceiling even though the caller was already rejected, holding a
    // one-shot CLI process open for no reason after it already printed the
    // error.
    // Must exist (as undefined) for the 'error' handler below to read,
    // before pollDaemonReady assigns it.
    // eslint-disable-next-line prefer-const
    let readiness: { promise: Promise<void>; cancel: (err: Error) => void } | undefined;
    const candidates = deps.resolveDaemonScriptCandidates();
    (deps.log ?? console.log)(`[launcher] Daemon script candidates:`, candidates);
    (deps.log ?? console.log)(`[launcher] Exists:`, candidates.map(c => fs.existsSync(c)));
    const daemonScript = candidates.find(c => fs.existsSync(c));
    if (!daemonScript) {
      reject(new Error(`Daemon script not found in: ${candidates.join(', ')}. Run 'npm run build:daemon' first.`));
      return;
    }

    const nodePath = findNodePath();

    (deps.log ?? console.log)(`[launcher] Spawning daemon: ${nodePath} ${daemonScript}`);

    const env: Record<string, string | undefined> = { ...process.env };
    if (deps.isElectronHost()) {
      env.ELECTRON_RUN_AS_NODE = '1';
    }
    // Clear Electron-specific vars that interfere with plain Node
    delete env.ELECTRON_NO_ASAR;
    // B′ auto-replace: stamp the spawning app's version UNCONDITIONALLY —
    // `{...process.env}` above may carry an inherited value when this app
    // itself runs inside a daemon-spawned PTY (wmux-in-wmux dogfood), and an
    // inherited stale version would poison the staleness gate.
    env[ENV_KEYS.SPAWNED_BY_VERSION] = deps.resolveSpawnedByVersion();

    const child = spawn(nodePath, [daemonScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });

    // `spawn` reports failures asynchronously via 'error' (e.g. EMFILE,
    // EACCES). Without a listener that emission throws an uncaught exception,
    // bypassing the reject() contract every caller — including the headless
    // CLI's `runStart` — relies on to report a clean, non-crashing message.
    child.on('error', (err) => {
      const spawnErr = new Error(`Failed to spawn daemon: ${err instanceof Error ? err.message : String(err)}`);
      // Route through the poll's own cancel once it exists so its timer is
      // cleared; before that, nothing has started yet and a direct reject
      // is correct (and `readiness.promise.then(_, reject)` below would
      // otherwise double-reject the same already-settled promise, which is
      // harmless but pointless).
      if (readiness) readiness.cancel(spawnErr);
      else reject(spawnErr);
    });

    child.unref();

    if (!child.pid) {
      reject(new Error('Failed to spawn daemon — no PID'));
      return;
    }

    deps.markBoot?.('daemon-spawned');
    (deps.log ?? console.log)(`[launcher] Daemon spawned with PID: ${child.pid}`);

    // Wait for daemon to be ready. Adaptive cadence + the pipe-file zombie
    // guard live in pollDaemonReady (extracted so the chain is unit-testable
    // with fake timers).
    readiness = pollDaemonReady({
      budgetMs: 15_000, // wall-clock 15 s fast-path expectation for a warm daemon
      // Issue #537 — extend the wait while THIS spawned child is still alive.
      // The daemon writes daemon.pid at boot start but its pipe file only after
      // `recoverSessions`, and cold-recovering a big session set runs long (~23 s
      // for 30 ConPTY sessions, and the recovery cap is 40). A live child that
      // hasn't produced its pipe file yet is recovering, not wedged — waiting is
      // correct, and it is what stops the replacement/respawn machinery from
      // declaring a dead-end and dropping every recovered session on the floor.
      // The ceiling still bounds a genuinely hung boot so the app can fall back.
      isChildAlive: () => child.exitCode === null,
      hardCeilingMs: DAEMON_READY_HARD_CEILING_MS,
      onSlowStart: () => {
        deps.markBoot?.('daemon-recovery-slow');
        (deps.warn ?? console.warn)(
          `[launcher] daemon (PID ${child.pid}) still booting past 15 s but alive — waiting up to ` +
            `${Math.round(DAEMON_READY_HARD_CEILING_MS / 1000)} s (large session recovery in progress)`,
        );
      },
      readPipeName: () => readPipeNameFromFile(getWmuxDir()),
      readToken: readDaemonAuthToken,
      ping: (pipeName, token) => pingDaemon(pipeName, token, 2000),
      onPipeFileSeen: () => deps.markBoot?.('daemon-pipe-file-seen'),
      onPingOk: () => deps.markBoot?.('daemon-first-ping-ok'),
    });
    readiness.promise.then(() => resolve(child.pid!), reject);

    // A redundant second daemon (spawned over a daemon the launcher failed to
    // detect) yields the canonical pipe to the live owner and exits with
    // DAEMON_EXIT_ALREADY_RUNNING (split-brain Defect 3). Surface that as a
    // distinct error so ensureDaemon reconnects to the existing daemon instead
    // of treating it as a spawn failure. Any OTHER early exit means the boot
    // genuinely crashed — cancel the readiness poll immediately (Issue #537:
    // the poll now waits on child liveness, so without this a crash-exit would
    // otherwise idle out the whole hard ceiling instead of failing fast).
    child.on('exit', (code) => {
      // readiness.cancel routes through the poll's own settled-guard, so a
      // post-ready exit here is a harmless no-op.
      if (code === DAEMON_EXIT_ALREADY_RUNNING) {
        const e = new Error(
          'daemon yielded: another daemon already owns the canonical control pipe',
        ) as NodeJS.ErrnoException;
        e.code = 'EDAEMON_ALREADY_RUNNING';
        readiness.cancel(e);
      } else {
        readiness.cancel(
          new Error(`Daemon process exited during startup (code ${code ?? 'null'}) before becoming ready`),
        );
      }
    });
  });
}

function readPipeNameFromFile(wmuxDir: string): string | null {
  try {
    return fs.readFileSync(path.join(wmuxDir, 'daemon-pipe'), 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Issue #545 — is the daemon control pipe gone (nothing listening)?
 *
 * Second, `tasklist`-independent proof that a shutdown ran to completion, for
 * the B′ replacement death poll. On a box where tasklist is slow or AV-blocked,
 * `checkProcessLiveness` can only ever return `unknown` (never `dead`, by
 * design), so the poll burns its whole 5 s budget and dead-ends even though the
 * daemon exited cleanly ~10 ms after its ack.
 *
 * Fail-closed on purpose: only an authoritative "nothing is listening"
 * (ENOENT / ECONNREFUSED) returns true. A successful connect means a server is
 * still there, and a TIMEOUT means we learned nothing — both report false, so a
 * flaky probe can only cost us the old wait, never authorize a bad spawn.
 *
 * The socket is destroyed the instant it connects so this probe can never be
 * the connection that holds a dying pipe server open (the same hazard step 2's
 * `disconnectClient` exists to avoid).
 */
export function isDaemonPipeGone(timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const pipeName = readPipeNameFromFile(getWmuxDir()) || getDaemonPipeName();
    let settled = false;
    const finish = (gone: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(gone);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();

    const socket = net.connect(pipeName);
    socket.on('connect', () => finish(false));
    socket.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOENT' || err.code === 'ECONNREFUSED');
    });
  });
}

/** Issue #546 — raw read of the daemon's boot-progress marker. Absent file (the
 *  overwhelmingly common case: the daemon is past boot) reads as null. */
function readBootMarker(wmuxDir: string): string | null {
  try {
    return fs.readFileSync(path.join(wmuxDir, 'daemon-booting'), 'utf-8');
  } catch {
    return null;
  }
}

export async function ensureDaemon(deps: DaemonLauncherDeps): Promise<DaemonInfo> {
  deps.markBoot?.('daemon-ensure-start');
  const wmuxDir = getWmuxDir();
  const pidFile = path.join(wmuxDir, 'daemon.pid');

  // 1. Check PID file
  let existingPid: number | null = null;
  try {
    const pidStr = fs.readFileSync(pidFile, 'utf8').trim();
    existingPid = parseInt(pidStr, 10);
  } catch { /* no readable daemon.pid file — fall through to the spawn path */ }

  // 2. If the PID is alive OR its liveness is unknown (a probe timeout must
  //    NOT be read as "dead" — Defect 1), enter the ping/reuse path. Only a
  //    confirmed-dead PID skips straight to spawn over a possibly-live daemon.
  const livenessOnBoot = existingPid ? checkProcessLiveness(existingPid) : null;
  // Boot-trace only (first-occurrence-wins): isolates the tasklist.exe cost
  // on machines where AV slows process probes. No-op on respawn re-entry.
  deps.markBoot?.('daemon-liveness-checked');
  if (existingPid && livenessOnBoot !== 'dead') {
    const token = readDaemonAuthToken();
    const pipeName = readPipeNameFromFile(wmuxDir) || getDaemonPipeName();

    if (token) {
      // Two-shot ping: a freshly spawned daemon can briefly miss the ping
      // window while its event loop is busy on startup (recovery loop on
      // big sessions.json, Defender realtime scan on cold ASAR, ConPTY
      // cold-init). 250 ms between attempts is comfortably above observed
      // worst-case startup hiccups but well below the 15-second spawn
      // budget — so the retry doesn't push us into the verification
      // throw-or-kill branch for what is actually a transient stall.
      let alive = await pingDaemon(pipeName, token);
      if (!alive) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        alive = await pingDaemon(pipeName, token);
      }
      if (alive) {
        deps.markBoot?.('daemon-reused');
        (deps.log ?? console.log)(`[launcher] Daemon already running (PID: ${existingPid})`);
        return { pid: existingPid, authToken: token, pipeName, spawned: false };
      }
    }

    // PID is alive but we cannot talk to it: either the auth token is
    // missing or the daemon's event loop is wedged (the `DaemonRespawnController`
    // health-probe path lands here after `client.disconnectSync()`).
    //
    // Without terminating it first, the "clean stale files + spawn"
    // branch below would leave the original daemon process running,
    // still holding every PTY child it owns, while a second daemon
    // spawns and races for the same lock/pipe state.
    //
    // BUT — after a crash, daemon.pid may be stale and the OS may have
    // reused that PID for an unrelated user process (Chrome, an IDE,
    // an unrelated Electron app). Sending SIGKILL blindly would take
    // out whatever now owns the recycled PID. Verify the process image
    // matches a wmux host's executable before killing.
    //
    // `expectedImage` below is THIS CALLER's own image (Electron in dev, the
    // packaged exe in prod, or node/node.exe for the headless CLI, #1001) —
    // it is a fast pre-filter and a diagnostic label, NOT the authoritative
    // check. Since #1001, a daemon can be spawned by a DIFFERENT host than
    // the one now checking status (Electron spawned it, CLI reconnects, or
    // vice versa), so an image mismatch no longer proves the PID is a
    // stale-reuse victim — it only means "check the command line before
    // deciding," which the code below always does regardless of match.
    //
    // (Codex review #2/#3/#4 hardening sequence on the original issue
    // #54 fix.) Three categories the gate logic must distinguish:
    //
    //   (a) Verified-daemon → kill, then spawn. Safe because we know
    //       what we're killing.
    //   (b) Verified-stale-reuse (we are sure the PID is NOT our daemon
    //       anymore — it's ourselves, an unrelated program, or another
    //       Electron app whose cmdline doesn't carry the daemon script
    //       path) → don't kill, but the stale-files cleanup + spawn
    //       path below is safe because the actual daemon is gone.
    //   (c) Unverified-live (process is alive but we couldn't read its
    //       image or command line at all) → refuse to act. Spawning over
    //       an unverified live daemon would orphan its PTYs and produce
    //       duplicate sessions. Throw so the respawn controller surfaces
    //       the failure via its budget + IPC, instead of silently
    //       corrupting state.
    const expectedImage = path.basename(process.execPath);
    if (existingPid === process.pid) {
      // (b) PID file points back at ourselves — the real daemon must be
      // gone (the OS recycled its PID into us). Safe to clean + spawn.
      (deps.warn ?? console.warn)(
        `[launcher] daemon.pid=${existingPid} equals current process pid — stale, cleaning + spawning fresh`,
      );
    } else {
      const imageName = getProcessImageName(existingPid);
      if (imageName === null) {
        // (c) Could not even read the image (AV blocked tasklist.exe / ps /
        // WMI). Before popping the recovery dialog, give the daemon the SAME
        // escalated re-ping the verified branch uses: a daemon that answers a
        // ping is alive regardless of what an AV-blocked process probe says.
        // Only when the re-ping ALSO fails do we ask the user. Refusing/asking
        // outright used to leave the user stranded (or worse, spawn a second
        // daemon over the live one) whenever AV blocked the probe.
        const outcome = await recoverFromBlockedProbe({
          token,
          reping: (timeoutMs) => pingDaemon(pipeName, token, timeoutMs),
          sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          askUser: () =>
            deps.askUserToRecoverFromStalePid({
              reason: `image lookup for PID ${existingPid} failed (anti-virus may be blocking tasklist.exe / ps / WMI)`,
              pid: existingPid,
              pidFile,
            }),
        });
        if (outcome === 'reuse') {
          (deps.log ?? console.log)(
            `[launcher] Daemon (PID ${existingPid}) answered escalated re-ping despite a blocked image lookup — reusing, no kill`,
          );
          return { pid: existingPid, authToken: token, pipeName, spawned: false };
        }
        if (outcome === 'refuse') {
          throw new Error(
            `[launcher] daemon.pid=${existingPid} alive but image lookup failed; refusing to spawn over an unverified live process. Manually delete ${pidFile} if you have verified the daemon is gone (or in elevated PowerShell: taskkill /F /PID ${existingPid}).`,
          );
        }
        (deps.warn ?? console.warn)(
          `[launcher] user approved cleanup of unverified PID ${existingPid} (image lookup failed)`,
        );
      } else {
        // Do NOT let an image-name mismatch alone decide "stale, someone
        // else's program": a genuine wmux daemon's image is whichever host
        // spawned it (this host's own Electron binary, OR node/node.exe if
        // the headless CLI spawned it, #1001) — and the process checking
        // status here can be a DIFFERENT host than the one that originally
        // spawned the daemon. Treating that cross-host mismatch as proof of
        // staleness would spawn a second daemon over a still-live one
        // (split-brain) without ever consulting the one signal that IS
        // host-independent: whether the command line invokes the daemon
        // script. So a mismatch here only downgrades confidence — cmdline is
        // still checked below rather than skipped.
        if (imageName.toLowerCase() !== expectedImage.toLowerCase()) {
          (deps.warn ?? console.warn)(
            `[launcher] PID ${existingPid} image "${imageName}" != this host's own "${expectedImage}" — ` +
              `could be a daemon spawned by a different host (Electron vs headless CLI); checking cmdline before deciding`,
          );
        }
        const cmdline = getProcessCommandLine(existingPid);
        if (cmdline === null) {
          // (c) Lookup failed — same recovery dance as the image path, and the
          // same escalated re-ping FIRST. The image already matches wmux here,
          // so a daemon that answers a ping is almost certainly the real one:
          // an AV-blocked Get-CimInstance must not be allowed to trigger a
          // spawn-over-live-daemon. Only when the re-ping ALSO fails do we ask
          // the user; cancel stays the legacy throw.
          const outcome = await recoverFromBlockedProbe({
            token,
            reping: (timeoutMs) => pingDaemon(pipeName, token, timeoutMs),
            sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
            askUser: () =>
              deps.askUserToRecoverFromStalePid({
                reason: `command-line lookup for PID ${existingPid} (image "${imageName}") failed (anti-virus may be blocking PowerShell / Get-CimInstance)`,
                pid: existingPid,
                pidFile,
              }),
          });
          if (outcome === 'reuse') {
            (deps.log ?? console.log)(
              `[launcher] Daemon (PID ${existingPid}) answered escalated re-ping despite a blocked command-line lookup — reusing, no kill`,
            );
            return { pid: existingPid, authToken: token, pipeName, spawned: false };
          }
          if (outcome === 'refuse') {
            throw new Error(
              `[launcher] daemon.pid=${existingPid} alive (image "${imageName}" matches wmux) but command-line lookup failed; refusing to spawn over an unverified live process. Manually delete ${pidFile} if you have verified the daemon is gone (or in elevated PowerShell: taskkill /F /PID ${existingPid}).`,
            );
          }
          (deps.warn ?? console.warn)(
            `[launcher] user approved cleanup of unverified PID ${existingPid} (cmdline lookup failed)`,
          );
        } else {
          const cmdlineMatches = cmdlineMatchesDaemonScript(cmdline, deps.resolveDaemonScriptCandidates());
          if (!cmdlineMatches) {
            // (b) Same image but different app (e.g. another Electron
            // tool). Don't kill, but the cleanup path below is safe.
            (deps.warn ?? console.warn)(
              `[launcher] PID ${existingPid} image matches but cmdline does not reference daemon script — stale-PID reuse by sibling Electron app, cleaning + spawning fresh`,
            );
          } else {
            // (a) Verified wmux daemon (image+cmdline match) that missed the
            //     two-shot (250+250 ms) ping. Before the DESTRUCTIVE SIGKILL —
            //     which nukes the very sessions the user chose to keep
            //     (Defect 2) — escalate the ping budget. A busy-but-alive
            //     daemon (big sessions.json recovery, ConPTY cold-init,
            //     Defender realtime scan) can stall past the short pings while
            //     fully alive and still owning its PTYs. Only a daemon that
            //     ALSO fails the escalated ping is treated as genuinely wedged.
            //     The escalating budget (~1.9 s worst case) stays well inside
            //     the 15 s spawn budget.
            //
            //     A graceful shutdown RPC is intentionally NOT attempted: a
            //     daemon that can't answer a ping can't answer an RPC either,
            //     so escalated re-ping (→ reuse) is the only thing that
            //     actually preserves kept sessions. A confirmed-wedged daemon
            //     leaves SIGKILL+respawn as the single-daemon recovery.
            if (token) {
              const recovered = await tryEscalatedReping(
                (timeoutMs) => pingDaemon(pipeName, token, timeoutMs),
                [500, 1000],
                200,
                (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
              );
              if (recovered) {
                (deps.log ?? console.log)(
                  `[launcher] Daemon (PID ${existingPid}) recovered on escalated re-ping — reusing, no kill`,
                );
                return { pid: existingPid, authToken: token, pipeName, spawned: false };
              }
              // Issue #546 — the escalated re-ping (~1.9 s) is far too short for
              // a daemon that is cold-recovering a big session set (~19-23 s for
              // 30-35 sessions, no pipe open the whole time). Before the
              // DESTRUCTIVE kill, check whether it is provably still booting and
              // wait it out if so. Gated on the marker existing, so the ordinary
              // wedged-daemon path below adds ZERO latency.
              if (parseBootMarker(readBootMarker(wmuxDir), existingPid)) {
                const outcome = await waitOutRecoveringDaemon({
                  ping: (timeoutMs) => pingDaemon(pipeName, token, timeoutMs),
                  readMarker: () => readBootMarker(wmuxDir),
                  expectedPid: existingPid,
                  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
                  now: () => Date.now(),
                  ceilingMs: DAEMON_READY_HARD_CEILING_MS,
                  onWaiting: () => {
                    (deps.log ?? console.log)(
                      `[launcher] Daemon (PID ${existingPid}) is still cold-recovering (boot marker present) — waiting up to ` +
                        `${Math.round(DAEMON_READY_HARD_CEILING_MS / 1000)} s instead of killing it (#546)`,
                    );
                  },
                });
                if (outcome === 'alive') {
                  (deps.log ?? console.log)(
                    `[launcher] Daemon (PID ${existingPid}) finished recovery and answered — reusing, no kill`,
                  );
                  return { pid: existingPid, authToken: token, pipeName, spawned: false };
                }
                if (outcome === 'gone') {
                  // The marker was dropped: either the daemon just became ready
                  // (it unlinks the marker immediately after writing its pipe
                  // file, so a ping can lag it by a hair) or it died. One more
                  // escalated re-ping tells those apart before we escalate.
                  const readyNow = await tryEscalatedReping(
                    (timeoutMs) => pingDaemon(pipeName, token, timeoutMs),
                    [500, 1000],
                    200,
                    (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
                  );
                  if (readyNow) {
                    (deps.log ?? console.log)(
                      `[launcher] Daemon (PID ${existingPid}) became ready as its boot marker cleared — reusing, no kill`,
                    );
                    return { pid: existingPid, authToken: token, pipeName, spawned: false };
                  }
                } else {
                  (deps.warn ?? console.warn)(
                    `[launcher] Daemon (PID ${existingPid}) still claimed to be booting after ` +
                      `${Math.round(DAEMON_READY_HARD_CEILING_MS / 1000)} s — treating as hung (#546)`,
                  );
                }
              }
            }
            // (a) Verified wmux daemon → kill before respawning.
            (deps.warn ?? console.warn)(
              `[launcher] PID ${existingPid} verified wmux daemon (image+cmdline) but unresponsive${token ? ' after escalated re-ping' : ' (no auth token to ping)'} — terminating before respawn`,
            );
            let killSucceeded = true;
            try {
              process.kill(existingPid, 'SIGKILL');
            } catch (err: unknown) {
              const code = (err as NodeJS.ErrnoException | undefined)?.code;
              if (code === 'ESRCH') {
                // ESRCH = process died between the liveness check and kill.
                // Benign race — we wanted it gone and it is.
              } else {
                // EPERM (Windows: Access Denied), EINVAL, anything else:
                // we asked the OS to kill the verified daemon and it
                // refused. taskkill /F travels the same TerminateProcess
                // path with the same user token, so we don't auto-retry —
                // we surface the failure with the exact command the user
                // needs to run in an elevated shell. RespawnController
                // catches the throw and burns a budget unit.
                killSucceeded = false;
                (deps.warn ?? console.warn)(`[launcher] failed to terminate PID ${existingPid}:`, err);
                throw new Error(
                  `[launcher] verified wmux daemon at PID ${existingPid} alive but SIGKILL failed (${code ?? 'unknown'}); refusing to spawn a second daemon. Run in an elevated PowerShell:  taskkill /F /PID ${existingPid}  — then retry.`,
                );
              }
            }
            if (killSucceeded) {
              // Brief settle so the named-pipe handle on the dying daemon's
              // side releases before spawnDaemon's first `createServer`
              // listen attempt.
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
        }
      }
    }
  }

  // 3. Clean stale files before spawning — prevents new daemon from seeing
  //    zombie lock/pipe state left by a crashed predecessor.
  (deps.log ?? console.log)('[launcher] No running daemon found. Cleaning stale files...');
  // 'daemon-booting' (#546) joins the list: a marker left by a daemon that
  // crashed mid-recovery must not outlive it into the fresh spawn.
  const staleFiles = ['daemon.lock', 'daemon.pid', 'daemon-pipe', 'daemon-booting'];
  for (const name of staleFiles) {
    try { fs.unlinkSync(path.join(wmuxDir, name)); } catch { /* ignore */ }
  }

  let pid: number;
  try {
    pid = await spawnDaemon(deps);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'EDAEMON_ALREADY_RUNNING') {
      // The daemon we spawned yielded to a live daemon already owning the
      // canonical pipe (split-brain avoided — no second live daemon, no `-N`
      // pipe). Reconnect to the existing daemon instead of looping into another
      // spawn. The pipe file was cleaned with the stale files above, so resolve
      // the canonical name deterministically.
      const canonicalPipe = getDaemonPipeName();
      const reconnectToken = readDaemonAuthToken();
      if (reconnectToken) {
        const pong = await daemonPing(canonicalPipe, reconnectToken);
        if (pong) {
          // Restore daemon.pid (the stale-file cleanup above deleted it) to the
          // live daemon's reported pid, so the NEXT launch hits the cheap reuse
          // branch (existingPid → ping → reuse) instead of repeating this
          // spawn-yield-reconnect dance every launch.
          const livePid =
            typeof pong.pid === 'number' && pong.pid > 0 ? pong.pid : (existingPid ?? null);
          if (livePid !== null) {
            try {
              fs.writeFileSync(pidFile, String(livePid), { encoding: 'utf-8', mode: 0o600 });
            } catch { /* best effort — reconnect still succeeds without it */ }
          } else {
            (deps.warn ?? console.warn)(
              '[launcher] reconnected daemon did not report a pid — daemon.pid not restored',
            );
          }
          (deps.log ?? console.log)(
            '[launcher] spawned daemon yielded to a live daemon — reconnected to the existing daemon',
          );
          return {
            pid: livePid,
            authToken: reconnectToken,
            pipeName: canonicalPipe,
            spawned: false,
          };
        }
      }
    }
    throw err;
  }

  // Read connection info after spawn
  const token = readDaemonAuthToken();
  const pipeName = readPipeNameFromFile(wmuxDir) || getDaemonPipeName();

  if (!token) {
    throw new Error('Daemon spawned but auth token not found');
  }

  return { pid, authToken: token, pipeName, spawned: true };
}

/**
 * Force-kill the daemon recorded in `daemon.pid` — but ONLY if the live
 * process at that PID verifiably still belongs to wmux (image basename +
 * cmdline carry the daemon script). This is the explicit-full-shutdown
 * backstop for main's before-quit: when the user picks "Shut down wmux
 * completely" and the graceful `daemon.shutdown` RPC times out, this
 * guarantees a wedged daemon can't survive the teardown the user explicitly
 * asked for.
 *
 * The PID-reuse guards mirror ensureDaemon()'s verify-before-kill logic so we
 * never SIGKILL an unrelated process that recycled the daemon's old PID. We
 * only abort the kill when a check returns a DEFINITIVE mismatch; an
 * indeterminate result (null image/cmdline, e.g. AV blocking tasklist) still
 * proceeds, because this path runs at most a few seconds after we were
 * actively talking to that PID, so reuse is near-impossible and leaving an
 * orphan is the worse outcome here.
 *
 * Best-effort: never throws. Returns true only when a verified daemon was
 * signalled.
 */
export function killDaemonByPidFile(scriptCandidates: string[] = []): boolean {
  try {
    const wmuxDir = getWmuxDir();
    const pidStr = fs.readFileSync(path.join(wmuxDir, 'daemon.pid'), 'utf8').trim();
    const pid = parseInt(pidStr, 10);
    // Before-quit mode: indeterminate verification still proceeds — this
    // path runs seconds after we were actively talking to that PID, so
    // reuse is near-impossible and an orphan is the worse outcome.
    return killVerifiedDaemonPid(pid, { definitiveOnly: false, scriptCandidates });
  } catch {
    return false;
  }
}

/**
 * B′ auto-replace backstop: SIGKILL an EXPLICIT daemon PID after verifying it
 * still belongs to wmux. Two differences from `killDaemonByPidFile` — both
 * load-bearing for the replacement path (Codex #5 + Claude #6):
 *
 *  - The PID is the one captured when the shutdown was acked, NEVER re-read
 *    from daemon.pid. Between ack and backstop another app instance may have
 *    already spawned a replacement daemon and rewritten the pid file; a
 *    file-read here would SIGKILL the fresh daemon.
 *  - `definitiveOnly: true` refuses to kill when the image or cmdline lookup
 *    is indeterminate (null — AV blocking tasklist/ps/WMI). The replacement
 *    path deliberately waits up to ~5s after asking the daemon to die, which
 *    is long enough for PID reuse to stop being "near-impossible"; the
 *    before-quit relaxation does not transfer. A refused kill degrades to
 *    the respawn-budget machinery, never to a blind SIGKILL.
 *
 * Best-effort: never throws. Returns true only when a verified daemon was
 * signalled.
 */
export function killVerifiedDaemonPid(
  pid: number,
  opts: { definitiveOnly: boolean; scriptCandidates?: string[] },
): boolean {
  try {
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
    // Only a confirmed-dead PID skips the kill (already gone). `unknown`
    // proceeds to verification — the image/cmdline guards below decide.
    if (checkProcessLiveness(pid) === 'dead') return false;

    // `expectedImage` is THIS caller's own image — a diagnostic pre-filter,
    // not authoritative (see the comment on the equivalent check in
    // `ensureDaemon` above). Since #1001 a daemon may have been spawned by a
    // different host than the one asking to kill it here (Electron killing a
    // CLI-spawned daemon, or vice versa), so a mismatch alone must not
    // refuse the kill — only the cmdline check below is host-independent.
    const expectedImage = path.basename(process.execPath);
    const image = getProcessImageName(pid);
    // A definite read that does NOT match is inconclusive on its own since
    // #1001 (a different host may have spawned this daemon) — but it is
    // still a real, negative signal. Recorded so a null cmdline right after
    // it can be refused instead of silently combined into "proceed".
    const imageDefinitivelyMismatched = image !== null && image.toLowerCase() !== expectedImage.toLowerCase();
    if (image === null) {
      if (opts.definitiveOnly) return false; // indeterminate — refuse
    }
    const cmdline = getProcessCommandLine(pid);
    if (cmdline === null) {
      // `definitiveOnly` already refuses on any indeterminate cmdline. Below
      // that threshold, a null cmdline COMBINED with an already-confirmed
      // image mismatch is refused too: neither signal alone proves the PID
      // isn't ours (cross-host support needs that), but having both point
      // away from "ours" restores the pre-#1001 guarantee that an image
      // mismatch blocks the kill — it just needs the second, cmdline signal
      // to also fail to clear it, rather than mismatch alone.
      if (opts.definitiveOnly || imageDefinitivelyMismatched) return false;
    } else if (!cmdlineMatchesDaemonScript(cmdline, opts.scriptCandidates ?? [])) {
      return false; // definitive: same image but not our daemon script
    }

    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
