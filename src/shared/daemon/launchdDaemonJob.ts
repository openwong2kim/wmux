import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { isCredentialEnvKey } from '../envFilter';

/**
 * macOS: start the daemon as a per-user launchd job instead of a child of the
 * launching process.
 *
 * Why: a `spawn(..., { detached: true })` child is still a *subordinate* of the
 * app as far as LaunchServices is concerned (responsibility / ASN lineage, not
 * the process group). When a foreground app quits, loginwindow asks Background
 * Task Management whether the app may keep background processes; for an
 * unsigned bundle BTM cannot answer (`BTMErrorDomain -98`) and loginwindow
 * schedules every subordinate for termination — the daemon got SIGTERM on each
 * plain Quit and took every hosted session with it. A process launchd starts
 * for a job in the user's `gui/<uid>` domain is nobody's subordinate (its
 * parent is launchd, pid 1), so quitting the app leaves it alone.
 *
 * Mechanism choices:
 * - `launchctl bootstrap gui/<uid> <plist>` with KeepAlive=false and
 *   RunAtLoad=true: one-shot start, no respawn after an intentional
 *   `daemon.shutdown`, exact env via EnvironmentVariables.
 * - Not `launchctl submit`: it implies KeepAlive (launchd would respawn the
 *   daemon after a full shutdown) and cannot pass an environment.
 * - Not `launchctl asuser`: it only switches the bootstrap context; the
 *   process would still be our child and subordinate.
 * - Not SMAppService: requires a signed app with an embedded agent plist.
 * - The plist lives in the wmux data dir, NOT ~/Library/LaunchAgents, so the
 *   daemon never auto-starts at login, and only until bootstrap returns: the
 *   loaded job does not need it, and it carries the whole spawn env.
 *
 * Labels are unique per start (`<base>.<ms36>-<rand36>`): a fixed label could
 * only be re-used after `bootout`, and booting out a job whose daemon is still
 * alive (pid file lost, split-brain yield path) would SIGTERM that live daemon.
 * Jobs that are no longer running are pruned before each start; a running
 * one is never touched, and neither is one younger than PRUNE_GRACE_MS (its
 * RunAtLoad process may not have appeared yet). Prune and bootstrap run under
 * a lock file in the plist dir so two launchers starting at once cannot
 * remove each other's plist or job mid-start.
 */

/** Base label; the data suffix (`-dev`, test suffixes) keeps instances apart. */
export function launchdBaseLabel(dataSuffix: string): string {
  return `com.wmux.daemon${dataSuffix.replace(/[^A-Za-z0-9.-]/g, '-')}`;
}

/**
 * Variables launchd manages for each job itself — inheriting the launching
 * app's values would mislabel the daemon's own job.
 */
const LAUNCHD_OWNED_ENV = new Set(['XPC_SERVICE_NAME', 'XPC_FLAGS']);

// XML 1.0 `Char` minus CR (a literal CR in element content is normalised to LF
// by the parser, so the value would not round-trip).
// eslint-disable-next-line no-control-regex
const XML_UNSAFE = /[^\t\n -퟿-�\u{10000}-\u{10FFFF}]/u;

/**
 * Credential-named variables the daemon itself reads from its own env, so they
 * must survive the credential filter below.
 */
const DAEMON_READ_CREDENTIALS = new Set(['WMUX_PUSH_RELAY_SECRET']);

/**
 * The spawn env, made launchd-safe: undefined values and launchd-owned keys
 * dropped, any variable that cannot be expressed in a plist skipped, and
 * credentials (the same rule `buildSafeChildEnv` applies) left out of the
 * plist except the few the daemon reads itself.
 */
export function filterEnvForLaunchd(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || LAUNCHD_OWNED_ENV.has(key)) continue;
    if (isCredentialEnvKey(key) && !DAEMON_READ_CREDENTIALS.has(key)) continue;
    if (!key || XML_UNSAFE.test(key) || XML_UNSAFE.test(value)) continue;
    out[key] = value;
  }
  return out;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface DaemonJobSpec {
  label: string;
  programArguments: string[];
  env: Record<string, string>;
}

export function buildDaemonLaunchdPlist(spec: DaemonJobSpec): string {
  const str = (s: string) => `<string>${xmlEscape(s)}</string>`;
  const envEntries = Object.keys(spec.env)
    .sort()
    .map((k) => `\t\t<key>${xmlEscape(k)}</key>\n\t\t${str(spec.env[k])}`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `\t<key>Label</key>\n\t${str(spec.label)}`,
    `\t<key>ProgramArguments</key>\n\t<array>\n${spec.programArguments.map((a) => `\t\t${str(a)}`).join('\n')}\n\t</array>`,
    `\t<key>EnvironmentVariables</key>\n\t<dict>\n${envEntries}\n\t</dict>`,
    // Start once, now; never respawn — a full shutdown must stay shut down,
    // and a crash is handled by the app's own respawn controller.
    '\t<key>RunAtLoad</key>\n\t<true/>',
    '\t<key>KeepAlive</key>\n\t<false/>',
    // The daemon's PTY shells and agents live in their own process groups, but
    // never let launchd reap anything left behind when the daemon exits.
    '\t<key>AbandonProcessGroup</key>\n\t<true/>',
    // Hosts interactive shells — opt out of background throttling.
    '\t<key>ProcessType</key>\n\t<string>Interactive</string>',
    // Matches the previous `stdio: 'ignore'`; the daemon writes its own logs.
    '\t<key>StandardOutPath</key>\n\t<string>/dev/null</string>',
    '\t<key>StandardErrorPath</key>\n\t<string>/dev/null</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export interface LaunchctlListEntry {
  pid: number | null;
  /** Last exit status; negative is the terminating signal. */
  status: number | null;
}

/** Parse `launchctl list` (`PID\tStatus\tLabel`, `-` for none). */
export function parseLaunchctlList(stdout: string): Map<string, LaunchctlListEntry> {
  const out = new Map<string, LaunchctlListEntry>();
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [pidCol, statusCol, label] = parts;
    if (!label || label === 'Label') continue;
    const pid = /^\d+$/.test(pidCol) ? Number(pidCol) : null;
    const status = /^-?\d+$/.test(statusCol) ? Number(statusCol) : null;
    out.set(label.trim(), { pid, status });
  }
  return out;
}

/** launchd itself could not run the job — the caller may fall back to spawn. */
export class LaunchdUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchdUnavailableError';
  }
}

export interface LaunchdDaemonHandle {
  label: string;
  /** null when the job already exited before its pid could be observed. */
  pid: number | null;
  isAlive(): boolean;
  /** Fires once with the exit code (null for a signal death). */
  onExit(cb: (code: number | null) => void): void;
  /** Stop watching for exit. Does not touch the job or the daemon. */
  dispose(): void;
}

export interface LaunchdRuntime {
  runLaunchctl(args: string[]): Promise<string>;
  isPidAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  uid: number;
  log(...args: unknown[]): void;
}

const LAUNCHCTL = '/bin/launchctl';

export const defaultLaunchdRuntime = (log: (...args: unknown[]) => void): LaunchdRuntime => ({
  runLaunchctl: (args) =>
    new Promise((resolve, reject) => {
      execFile(LAUNCHCTL, args, { encoding: 'utf-8', timeout: 10_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`launchctl ${args[0]} failed: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      });
    }),
  isPidAlive: (pid) => {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  uid: process.getuid ? process.getuid() : -1,
  log,
});

const PID_WAIT_MS = 5_000;
/** Jobs younger than this are never pruned: well past PID_WAIT_MS. */
export const PRUNE_GRACE_MS = 30_000;
const START_LOCK_NAME = 'start.lock';
const START_LOCK_WAIT_MS = 45_000;
const START_LOCK_POLL_MS = 50;
/** An ownerless lock (holder died between create and write) is reclaimed after this. */
const START_LOCK_OWNERLESS_MS = 10_000;

export function newDaemonJobLabel(baseLabel: string, nowMs: number = Date.now()): string {
  return `${baseLabel}.${nowMs.toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** Creation time encoded in a job label, or null for a label without one. */
export function daemonJobCreatedAt(label: string): number | null {
  const m = /\.([0-9a-z]+)-[0-9a-z]+$/.exec(label);
  if (!m) return null;
  const ms = parseInt(m[1], 36);
  return Number.isSafeInteger(ms) ? ms : null;
}

/** O_EXCL-create the lock holding our token. False when another holder has it. */
function tryCreateStartLock(lock: string, token: string): boolean {
  try {
    fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw new LaunchdUnavailableError(`could not take ${lock}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Remove a lock whose owner is dead. A live owner is never reclaimed, however
 * old the lock. The lock is first renamed aside, which only one waiter can
 * win, and deleted only if the moved file still holds the content judged dead;
 * a fresh lock moved by mistake is linked back.
 */
function reclaimDeadStartLock(lock: string, rt: LaunchdRuntime): void {
  let content: string;
  let mtimeMs: number;
  try {
    content = fs.readFileSync(lock, 'utf-8');
    mtimeMs = fs.statSync(lock).mtimeMs;
  } catch { return; }
  const owner = parseInt(content, 10);
  const dead = owner > 0 ? !rt.isPidAlive(owner) : Date.now() - mtimeMs > START_LOCK_OWNERLESS_MS;
  if (!dead) return;
  const aside = `${lock}.${randomUUID()}`;
  try { fs.renameSync(lock, aside); } catch { return; }
  let moved = '';
  try { moved = fs.readFileSync(aside, 'utf-8'); } catch { /* treat as mismatch */ }
  if (moved !== content) {
    try { fs.linkSync(aside, lock); } catch { /* a newer lock already took the name */ }
  }
  try { fs.unlinkSync(aside); } catch { /* gone */ }
}

function releaseStartLock(lock: string, token: string): void {
  try {
    if (fs.readFileSync(lock, 'utf-8') === token) fs.unlinkSync(lock);
  } catch { /* already gone */ }
}

/**
 * Run fn while holding `<plistDir>/start.lock` (O_EXCL create, owner
 * `<pid>:<uuid>`). Only a lock whose owner pid is dead is taken over.
 */
export async function withDaemonStartLock<T>(plistDir: string, rt: LaunchdRuntime, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(plistDir, START_LOCK_NAME);
  try {
    fs.mkdirSync(plistDir, { recursive: true });
  } catch (e) {
    throw new LaunchdUnavailableError(`could not create ${plistDir}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + START_LOCK_WAIT_MS;
  while (!tryCreateStartLock(lock, token)) {
    reclaimDeadStartLock(lock, rt);
    if (Date.now() >= deadline) throw new LaunchdUnavailableError(`timed out waiting for ${lock}`);
    await rt.sleep(START_LOCK_POLL_MS);
  }
  try { return await fn(); } finally { releaseStartLock(lock, token); }
}

/** Delete every plist file of this instance. Only safe under the start lock. */
function removeDaemonPlists(baseLabel: string, plistDir: string): void {
  let files: string[];
  try { files = fs.readdirSync(plistDir); } catch { return; }
  for (const f of files) {
    if (f.startsWith(`${baseLabel}.`) && f.endsWith('.plist')) {
      try { fs.unlinkSync(path.join(plistDir, f)); } catch { /* gone */ }
    }
  }
}

/**
 * Remove plist files left behind by a launcher that died between writing and
 * deleting one. Called on every ensure-daemon entry; skipped (the holder
 * cleans up) when another launcher holds the start lock.
 */
export function sweepLeftoverDaemonPlists(baseLabel: string, plistDir: string): void {
  const lock = path.join(plistDir, START_LOCK_NAME);
  const token = `${process.pid}:${randomUUID()}`;
  try {
    if (!fs.existsSync(plistDir) || !tryCreateStartLock(lock, token)) return;
  } catch { return; }
  try { removeDaemonPlists(baseLabel, plistDir); } finally { releaseStartLock(lock, token); }
}

export type DaemonJobState =
  | { kind: 'missing' }
  | { kind: 'unknown' }
  | { kind: 'loaded'; pid: number | null; runs: number; lastExit: number | null };

/** Parse the job-level fields of `launchctl print gui/<uid>/<label>`. */
export function parseLaunchctlPrint(stdout: string): Extract<DaemonJobState, { kind: 'loaded' }> {
  // Job-level fields sit at one tab; nested dicts (endpoints, …) are deeper.
  const field = (name: string): string | null => {
    const m = new RegExp(`^\\t${name} = (.*)$`, 'm').exec(stdout);
    return m ? m[1].trim() : null;
  };
  const num = (v: string | null): number | null => (v !== null && /^-?\d+$/.test(v) ? Number(v) : null);
  return { kind: 'loaded', pid: num(field('pid')), runs: num(field('runs')) ?? 0, lastExit: num(field('last exit code')) };
}

/** Whether launchd has the job loaded; `unknown` when launchctl itself failed. */
export async function queryDaemonJob(label: string, rt: LaunchdRuntime): Promise<DaemonJobState> {
  try {
    return parseLaunchctlPrint(await rt.runLaunchctl(['print', `gui/${rt.uid}/${label}`]));
  } catch (e) {
    return /Could not find service/.test(e instanceof Error ? e.message : String(e)) ? { kind: 'missing' } : { kind: 'unknown' };
  }
}

const PID_POLL_MS = 25;
const EXIT_POLL_MS = 250;

/**
 * Boot out (and delete the plist of) every job of this instance that is not
 * running. Never touches a job with a live pid or one younger than
 * PRUNE_GRACE_MS. Best-effort, never throws. Call it under the start lock.
 */
export async function pruneStaleDaemonJobs(baseLabel: string, plistDir: string, rt: LaunchdRuntime): Promise<void> {
  const prefix = `${baseLabel}.`;
  let jobs: Map<string, LaunchctlListEntry>;
  try { jobs = parseLaunchctlList(await rt.runLaunchctl(['list'])); } catch { return; }
  const labels = new Set<string>();
  for (const label of jobs.keys()) if (label.startsWith(prefix)) labels.add(label);
  try {
    for (const f of fs.readdirSync(plistDir)) {
      if (f.startsWith(prefix) && f.endsWith('.plist')) labels.add(f.slice(0, -'.plist'.length));
    }
  } catch { /* no dir yet */ }
  for (const label of labels) {
    const job = jobs.get(label);
    if (job && job.pid !== null) continue;
    const createdAt = daemonJobCreatedAt(label);
    if (createdAt !== null && Date.now() - createdAt < PRUNE_GRACE_MS) continue;
    if (job) {
      try { await rt.runLaunchctl(['bootout', `gui/${rt.uid}/${label}`]); } catch { /* already gone */ }
    }
    try { fs.unlinkSync(path.join(plistDir, `${label}.plist`)); } catch { /* not ours / gone */ }
  }
}

/**
 * Start the daemon as a launchd job and return a handle mirroring the bits
 * of ChildProcess the launcher uses (pid, liveness, exit code).
 *
 * Rejects with LaunchdUnavailableError only when the job could not be loaded
 * (no launchctl, no GUI domain, write failure) — nothing was started, so the
 * caller may safely fall back to a plain spawn. Once bootstrap has succeeded
 * any failure is a plain Error: falling back then could start a second daemon.
 */
export async function startDaemonViaLaunchd(
  opts: { baseLabel: string; plistDir: string; programArguments: string[]; env: Record<string, string | undefined> },
  rt: LaunchdRuntime,
): Promise<LaunchdDaemonHandle> {
  if (rt.uid < 0) throw new LaunchdUnavailableError('no uid on this platform');
  let label = '';
  let bootstrapError: unknown;
  await withDaemonStartLock(opts.plistDir, rt, async () => {
    // Under the lock every plist on disk is a leftover: nobody is mid-start.
    removeDaemonPlists(opts.baseLabel, opts.plistDir);
    await pruneStaleDaemonJobs(opts.baseLabel, opts.plistDir, rt);
    // Stamp the label only now, so the prune grace window counts from
    // bootstrap, not from before a long lock wait or prune.
    label = newDaemonJobLabel(opts.baseLabel);
    const plistPath = path.join(opts.plistDir, `${label}.plist`);
    try {
      fs.writeFileSync(
        plistPath,
        buildDaemonLaunchdPlist({ label, programArguments: opts.programArguments, env: filterEnvForLaunchd(opts.env) }),
        { mode: 0o600 },
      );
      await rt.runLaunchctl(['bootstrap', `gui/${rt.uid}`, plistPath]);
    } catch (e) {
      bootstrapError = e;
    } finally {
      // launchctl hands launchd the parsed plist, so the loaded job no longer
      // needs the file (list, bootout and prune all go by label). Removing it
      // keeps the spawn env off disk.
      try { fs.unlinkSync(plistPath); } catch { /* not written / gone */ }
    }
  });

  if (bootstrapError !== undefined) {
    const msg = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError);
    // A failed or timed-out bootstrap may still have loaded the job. Fall back
    // to a plain spawn only when launchd confirms it did not.
    const state = await queryDaemonJob(label, rt);
    if (state.kind === 'missing') throw new LaunchdUnavailableError(msg);
    if (state.kind === 'unknown') {
      throw new Error(`launchd job ${label}: bootstrap failed (${msg}) and its load state is unknown`);
    }
    rt.log(`[launcher] launchd job ${label}: bootstrap reported "${msg}" but the job is loaded`);
  } else {
    rt.log(`[launcher] launchd job ${label} bootstrapped`);
  }

  // RunAtLoad starts the process asynchronously; wait for its pid. `print`
  // tells "not started yet" from "ran and exited 0" (`runs`), which the
  // `list` status column cannot.
  let pid: number | null = null;
  let earlyExit: number | null | undefined;
  const deadline = Date.now() + PID_WAIT_MS;
  for (;;) {
    const state = await queryDaemonJob(label, rt);
    if (state.kind === 'loaded' && state.pid !== null) { pid = state.pid; break; }
    if (state.kind === 'loaded' && state.runs > 0) { earlyExit = state.lastExit; break; }
    if (state.kind === 'missing') {
      // Unloaded under us (nothing else of ours runs): safe to fall back.
      throw new LaunchdUnavailableError(`launchd job ${label} disappeared before its daemon started`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`launchd job ${label} is loaded (or its state is unknown) but its daemon pid never appeared`);
    }
    await rt.sleep(PID_POLL_MS);
  }

  const exitListeners: Array<(code: number | null) => void> = [];
  let exited = earlyExit !== undefined;
  let exitCode: number | null = earlyExit ?? null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const fire = () => { for (const cb of exitListeners.splice(0)) cb(exitCode); };

  if (!exited && pid !== null) {
    const watchedPid = pid;
    let checking = false;
    timer = setInterval(() => {
      if (checking || rt.isPidAlive(watchedPid)) return;
      checking = true;
      if (timer) { clearInterval(timer); timer = null; }
      void rt.runLaunchctl(['list']).then(
        (out) => {
          const s = parseLaunchctlList(out).get(label)?.status ?? null;
          exitCode = s === null || s < 0 ? null : s;
        },
        () => { exitCode = null; },
      ).finally(() => { exited = true; fire(); });
    }, EXIT_POLL_MS);
    timer.unref?.();
  }

  return {
    label,
    pid,
    isAlive: () => !exited && pid !== null && rt.isPidAlive(pid),
    onExit: (cb) => {
      if (exited) cb(exitCode);
      else exitListeners.push(cb);
    },
    dispose: () => {
      if (timer) { clearInterval(timer); timer = null; }
      exitListeners.length = 0;
    },
  };
}
