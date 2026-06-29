import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, getWmuxDir } from './config';
import { DaemonSessionManager } from './DaemonSessionManager';
import { PaneSupervisor } from './PaneSupervisor';
import { DaemonPipeServer } from './DaemonPipeServer';
import { SessionPipe } from './SessionPipe';
import { StateWriter } from './StateWriter';
import { LanLinkInbox } from './lanlink/inbox';
import { LanLinkController } from './lanlink/controller';
import { LanLinkServer } from './lanlink/server';
import { PeerStore } from './lanlink/peers';
import { coerceLanLinkPatch } from '../shared/lanlink';
import { ChannelService, ChannelStateWriter, wrapChannelMessageEnvelope, wrapChannelCatalogEnvelope } from './channels';
import { DEFAULT_COMPANY_ID } from '../shared/channels';
import { ProcessMonitor } from './ProcessMonitor';
import { Watchdog } from './Watchdog';
import { selectRecoverableSessions } from './recoverySelector';
import { createSnapshotRunner } from './snapshotRunner';
import { RingBuffer } from './RingBuffer';
import { GitContextWatcher } from '../main/pty/gitContextWatch';
import { PortWatcher } from '../main/pty/portWatch';
import { initDaemonLogSink } from './util/logSink';
import type { DaemonState } from './types';
import type { DaemonEvent, DaemonCreateSessionParams, DaemonSessionIdParams, DaemonResizeParams, DaemonSetResumeBindingParams } from '../shared/rpc';
import { monitorEventLoopDelay, performance as nodePerformance } from 'node:perf_hooks';
import { DAEMON_EXIT_ALREADY_RUNNING } from '../shared/constants';
import { toResumeCommand, resumeOfferForRecovered, mergeResumeBinding, normalizeResumeCwd } from '../shared/agentResume';
import type { ResumeBinding } from '../shared/agentResume';
import { agentDisplayToSlug } from '../main/pty/AgentDetector';
import type { AgentSlug } from '../shared/events';
import { LANLINK_SENTINEL_SESSION_ID } from '../shared/lanlink';

// X6 Feature ②: sessions RECOVERED this daemon boot that were running an
// INTERACTIVE agent (non-exec, non-supervised) → ptyId → the agent slug to
// resume. The only sessions that get a one-click resume pill. Transient
// (per-boot, never persisted): populated in recoverSessions FROM THE PERSISTED
// session (the recovered LIVE meta is a fresh shell with no lastDetectedAgent,
// so the slug MUST be captured here, not read back off the live session).
// Cleared when the agent is re-detected (it relaunched) or the session ends.
// A LIVE reconnect never enters this map, so the pill can't paste
// `claude --continue` into a still-running agent (Codex eng review EC4).
const recoveredAgentShellIds = new Map<string, AgentSlug>();

// X6 ③: parallel to recoveredAgentShellIds — the captured resume binding for a
// pane recovered this boot, read FROM THE PERSISTED session at recovery (the
// live recovered meta has none yet). Surfaced on listSessions so the resume
// pill can build `--resume <id>` for the EXACT conversation; cleared when the
// agent relaunches (live again → no pill).
const recoveredResumeBindings = new Map<string, ResumeBinding>();

// X6 ③: closed set of resumable agent slugs, used to validate a hook-supplied
// binding agent before it is written to `lastDetectedAgent` (an AgentSlug). Keep
// in sync with AgentSlug in src/shared/events.ts and ALLOWED_AGENT_SLUGS in
// integrations/shared/signal-types.ts.
const KNOWN_AGENT_SLUGS: ReadonlySet<string> = new Set([
  'claude', 'codex', 'gemini', 'aider', 'opencode', 'copilot',
]);

// === Constants ===
const wmuxDir = getWmuxDir();

// Boot-phase trace (S-A). The launcher spawns this process with
// `stdio: 'ignore'`, so unlike the main process we cannot stream marks over
// stderr — instead marks accumulate here and are exposed two ways:
//  - `daemon.ping` response carries `bootTrace` (additive field; the bench
//    reads it, the launcher/respawn-controller only read status/pid)
//  - one `[boot-trace] summary=` log line at the end of main() lands in
//    ~/.wmux/logs/daemon-YYYY-MM-DD.log for postmortems.
// Marks are absolute Date.now() epochs so the bench can place them on the
// same timeline as the main-process marks (same machine, same clock).
const DAEMON_BOOT: { jsStartEpochMs: number; marks: Record<string, number> } = {
  jsStartEpochMs: Date.now(),
  marks: {},
};
function markDaemonBoot(name: string): void {
  if (name in DAEMON_BOOT.marks) return; // first-occurrence-wins
  DAEMON_BOOT.marks[name] = Date.now();
}

// RCA A4 — event-loop lag monitor. Enabled once at module load; daemon.ping
// reports the mean lag (ms) since the previous ping so the main-side health
// probe (DaemonRespawnController) can tell a busy-but-responsive daemon from a
// hung one and skip a false-positive respawn under CPU load.
const eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopMonitor.enable();

// Install the file log sink before any log() / console.* call below. The
// launcher spawns this process with `stdio: 'ignore'`, so without this
// every diagnostic line (recovery, shutdown.phase, PTY retry) is dropped
// at the OS pipe layer and never reaches disk. After this call the same
// lines land in ~/.wmux/logs/daemon-YYYY-MM-DD.log.
initDaemonLogSink(wmuxDir);

// Recovery soft-cap ceiling. The hard PTY ceiling is now configurable
// (config.session.maxSessions, default 200); recovery derives its own cap
// as min(maxSessions, 40) in main(). This 40 is the startup-headroom
// heuristic: even with a large maxSessions, recover at most 40 so a state
// file inflated by past v2.8.0 accumulation can't consume every slot before
// the user creates their first new pane. Deriving from maxSessions also
// guarantees maxRecover ≤ maxSessions, so recovery can never trip the
// createSession cap and dead-mark the overflow (codex #4). Sessions beyond
// the cap stay suspended and become recoverable on a later launch, or get
// reaped by the suspended TTL.
const MAX_RECOVER_SESSIONS = 40;

/** Get a unique identifier for the current OS boot session (async).
 *  Changes after every reboot, enabling stale PID detection. */
async function getBootId(): Promise<string> {
  try {
    if (process.platform === 'win32') {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const pathMod = require('path');
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const wmic = pathMod.join(systemRoot, 'System32', 'wbem', 'wmic.exe');
      const { stdout } = await execFileAsync(
        wmic,
        ['os', 'get', 'LastBootUpTime', '/value'],
        { encoding: 'utf-8', timeout: 5000, windowsHide: true },
      );
      const match = (stdout as string).match(/LastBootUpTime=(\S+)/);
      return match ? match[1].trim() : `fallback-${os.uptime()}`;
    } else if (process.platform === 'darwin') {
      // macOS: sysctl exposes the boot timestamp; encode it as a stable string.
      // Format: "{ sec = 1745678901, usec = 123456 } Mon Apr 28 ..."
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(
        'sysctl',
        ['-n', 'kern.boottime'],
        { encoding: 'utf-8', timeout: 5000 },
      );
      const match = (stdout as string).match(/sec\s*=\s*(\d+)/);
      return match ? `darwin-${match[1]}` : `fallback-${os.uptime()}`;
    } else {
      // Linux: /proc/sys/kernel/random/boot_id
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    }
  } catch {
    // Fallback: use uptime (less precise but better than nothing)
    return `uptime-${Math.floor(os.uptime())}`;
  }
}

/** Synchronous getBootId for use in process 'exit' handler where async is not possible. */
function getBootIdSync(): string {
  try {
    if (process.platform === 'win32') {
      const { execFileSync } = require('child_process');
      const pathMod = require('path');
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const wmic = pathMod.join(systemRoot, 'System32', 'wbem', 'wmic.exe');
      const result = execFileSync(
        wmic,
        ['os', 'get', 'LastBootUpTime', '/value'],
        { encoding: 'utf-8', timeout: 5000, windowsHide: true },
      );
      const match = result.match(/LastBootUpTime=(\S+)/);
      return match ? match[1].trim() : `fallback-${os.uptime()}`;
    } else if (process.platform === 'darwin') {
      const { execFileSync } = require('child_process');
      const result = execFileSync(
        'sysctl',
        ['-n', 'kern.boottime'],
        { encoding: 'utf-8', timeout: 5000 },
      );
      const match = (result as string).match(/sec\s*=\s*(\d+)/);
      return match ? `darwin-${match[1]}` : `fallback-${os.uptime()}`;
    } else {
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    }
  } catch {
    return `uptime-${Math.floor(os.uptime())}`;
  }
}
const PID_FILE = path.join(wmuxDir, 'daemon.pid');
const LOCK_FILE = path.join(wmuxDir, 'daemon.lock');

// === Logging (console-based) ===
function log(level: string, msg: string, ...args: unknown[]): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [daemon/${level}] ${msg}`, ...args);
}

// === X6 resume on replay ===
// Compute the NON-persisted launch command for a supervised exec session being
// REPLAYED (recovery or supervisor restart). Returns the resume-rewritten
// command only when:
//   - the session is an exec unit (has `exec`), AND
//   - its ORIGINAL cwd still exists — resume is cwd-scoped, so a homedir
//     fallback would resume an unrelated/empty session (run fresh instead), AND
//   - the launch command is a known agent launcher (toResumeCommand rewrites it).
// Otherwise returns undefined → createSession spawns the original command.
// The persisted meta.exec.command is never affected; first launch is never
// touched (brand-new createSession callers don't call this).
//
// X6 ③: with a captured resumeBinding whose cwd still matches, the rewrite
// targets the EXACT session (`claude --resume <id>`); otherwise it falls back to
// `--continue` (latest-in-cwd). The permission mode is deliberately NOT restored
// here — supervised auto-run has no human in the loop, so re-granting
// `--dangerously-skip-permissions` silently every reboot is unsafe (D6
// fail-safe). Permission restore happens ONLY on the pill path (explicit user
// Enter); the trust-gated supervised auto-restore is a deferred follow-up.
// X6 ③ (D5): a binding is usable for an EXACT-session resume only when its
// origin transcript still exists. A purged id turns `--resume` into a silent
// "No conversation found." (F8 — exit 0, so no exit-code fallback). We probe the
// exact stored path (slug-rule-free). Bindings with no transcriptPath (older
// captures) are treated as usable — we can't prove them dead, and `--resume`
// degrades gracefully if so.
function bindingTranscriptLives(binding: ResumeBinding | undefined): boolean {
  if (!binding) return false;
  if (!binding.transcriptPath) return true;
  return fs.existsSync(binding.transcriptPath);
}

function resumeLaunchCommand(
  session: { id: string; exec?: { command: string }; cwd: string; resumeBinding?: ResumeBinding },
  spoolBinding?: ResumeBinding,
): string | undefined {
  if (!session.exec) return undefined;
  if (!fs.existsSync(session.cwd)) return undefined; // cwd gone → fresh, not wrong-target resume
  // Prefer the persisted binding; fall back to a spool-captured one (the live
  // capture RPC failed, so the exact id only survived in the spool) so an exec
  // agent pane replays as `--resume <id>` instead of an ambiguous `--continue`.
  // The spool ingest runs AFTER this replay, so without consulting it here the
  // exec pane would launch with --continue before the binding lands (CodeRabbit).
  // Pick the fresher of the two by ts; toResumeCommand still applies the F7
  // cwd-match guard, and bindingTranscriptLives is the D5 probe.
  let binding = session.resumeBinding;
  if (spoolBinding && (!binding || (spoolBinding.ts ?? 0) > (binding.ts ?? 0))) {
    binding = spoolBinding;
  }
  // D5: drop to `--continue` when the exact transcript is gone (pass no binding).
  const usableBinding = bindingTranscriptLives(binding) ? binding : undefined;
  const rewritten = toResumeCommand(session.exec.command, usableBinding, session.cwd);
  if (rewritten === session.exec.command) return undefined; // not a known agent launcher / already resuming
  log('info', `X6 resume: replaying session ${session.id} as resume form in ${session.cwd}`);
  return rewritten;
}

// === X6 ③ resume-binding spool ingest (Rung 3) ===
// Drain the durable spool the Claude hook bridge writes (~/.wmux/resume-spool/)
// when its capture RPC to wmux fails (main pipe absent during boot/restart,
// no-workspace-match, timeout). Each record is self-describing and keyed by the
// EXACT pane — WMUX_PTY_ID, the daemon session id — so we attribute it to a live
// session by id with NO cwd guessing (the per-pane correctness the live hook
// path also relies on). Applied through the same merge + F7 cwd guard + D5
// existence probe as the live capture, and ONLY when at least as fresh as any
// binding already on the session, so a stale spool can never clobber a newer
// live capture. Consumed / dead / aged records are deleted. Best-effort: never
// throws (a corrupt spool file must not fail the recovery path). Returns the
// number of bindings applied so the caller can skip the save when nothing changed.
const RESUME_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // prune orphans after 7d
const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set([
  'bypassPermissions', 'acceptEdits', 'plan', 'default',
]);

// Validate one spool record into a {ptyId, binding} pair, or null when it is
// malformed or names an unknown agent (a hostile / stale spool file). Shared by
// the recovery-replay pre-read (readResumeSpoolMap) and the durable ingest.
function spoolRecordToBinding(rec: Record<string, unknown>): { ptyId: string; binding: ResumeBinding } | null {
  const ptyId = typeof rec.ptyId === 'string' ? rec.ptyId : null;
  const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : null;
  const cwd = typeof rec.cwd === 'string' ? rec.cwd : null;
  const agent = typeof rec.agent === 'string' ? rec.agent : 'claude';
  if (!ptyId || !sessionId || !cwd || !KNOWN_AGENT_SLUGS.has(agent)) return null;
  const permissionMode = typeof rec.permissionMode === 'string' && KNOWN_PERMISSION_MODES.has(rec.permissionMode)
    ? (rec.permissionMode as ResumeBinding['permissionMode'])
    : undefined;
  return {
    ptyId,
    binding: {
      agent,
      sessionId,
      cwd,
      ...(permissionMode ? { permissionMode } : {}),
      ...(typeof rec.transcriptPath === 'string' ? { transcriptPath: rec.transcriptPath } : {}),
      ts: typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? rec.ts : 0,
    },
  };
}

// Read the spool into a ptyId→binding map WITHOUT consuming it (the post-recovery
// ingestResumeSpool does the durable apply + delete). Used to feed an exec /
// supervised pane's replay launch (resumeLaunchCommand) BEFORE ingest runs, so a
// spool-only binding still produces `--resume <id>` instead of an ambiguous
// `--continue` (CodeRabbit). cwd-match + D5 are applied by resumeLaunchCommand.
function readResumeSpoolMap(): Map<string, ResumeBinding> {
  const out = new Map<string, ResumeBinding>();
  const dir = path.join(wmuxDir, 'resume-spool');
  let names: string[];
  try {
    if (!fs.existsSync(dir)) return out;
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // skips *.json.tmp (ends with .tmp)
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as Record<string, unknown>;
      const parsed = spoolRecordToBinding(rec);
      if (parsed) out.set(parsed.ptyId, parsed.binding);
    } catch { /* skip corrupt — ingestResumeSpool drops it on its pass */ }
  }
  return out;
}

function ingestResumeSpool(
  sessionManager: DaemonSessionManager,
  stateWriter: StateWriter,
): number {
  const dir = path.join(wmuxDir, 'resume-spool');
  let names: string[];
  try {
    if (!fs.existsSync(dir)) return 0;
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let applied = 0;
  for (const name of names) {
    // Prune an abandoned temp from a crashed bridge write. The bridge now uses a
    // UNIQUE temp name (pid+uuid) so a crash leaks one orphan that nothing
    // overwrites; spool writes are atomic and instant, so anything older than a
    // minute is dead (CodeRabbit).
    if (name.endsWith('.json.tmp')) {
      try {
        const tmpPath = path.join(dir, name);
        if (Date.now() - fs.statSync(tmpPath).mtimeMs > 60_000) fs.unlinkSync(tmpPath);
      } catch { /* ignore */ }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const drop = (): void => { try { fs.unlinkSync(file); } catch { /* ignore */ } };
    let rec: Record<string, unknown>;
    let mtimeMs = 0;
    try {
      rec = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
    } catch {
      drop(); // corrupt / partial write — never let it wedge the drain
      continue;
    }
    // Validate + bound unknown agents (codex P2): a malformed / hostile record
    // never becomes a durable binding.
    const parsed = spoolRecordToBinding(rec);
    if (!parsed) { drop(); continue; }
    const { ptyId, binding } = parsed;

    const managed = sessionManager.getSession(ptyId);
    if (!managed) {
      // No live session owns this ptyId yet — a cap-skipped / not-yet-recovered
      // pane. Keep the record until it ages out so a later launch can use it.
      if (Date.now() - mtimeMs > RESUME_SPOOL_MAX_AGE_MS) drop();
      continue;
    }
    // F7: `--resume` is cwd-scoped, so the capture's origin cwd must match the
    // recovered pane's cwd; a mismatch would dead-end (offer --continue instead).
    // Normalized compare so a drive-case / trailing-slash diff isn't a false miss.
    if (normalizeResumeCwd(binding.cwd) !== normalizeResumeCwd(managed.meta.cwd)) { drop(); continue; }
    const prev = managed.meta.resumeBinding;
    // Never clobber: for a DIFFERENT conversation, only a strictly-newer spool
    // wins (ts tiebreak). For the SAME conversation the spool is redundant — its
    // durable fields can only be staler than the live one (mergeResumeBinding
    // keeps permissionMode sticky), and setResumeBinding's durable-change check
    // omits ts, so the persisted ts can lag a same-session live update; skipping
    // by sessionId avoids an older spool overwriting it (codex P2).
    // ...and never let a provisional (no-transcript) spool replace an existing
    // transcript-derived binding for a different session (codex P2, mirrors the
    // live setResumeBinding guard).
    if (prev && (prev.sessionId === binding.sessionId || prev.ts >= binding.ts
        || (prev.transcriptPath && !binding.transcriptPath))) { drop(); continue; }

    // D5: a purged origin transcript makes `--resume` a silent "No conversation
    // found." — drop the record (the pill can still degrade to --continue).
    if (!bindingTranscriptLives(binding)) { drop(); continue; }

    managed.meta.resumeBinding = mergeResumeBinding(prev, binding);
    // Rung 1 parity: a spooled capture also proves the pane ran claude, so it
    // arms the pill gate even if no live banner was ever detected. (binding.agent
    // is already a KNOWN_AGENT_SLUG — validated in spoolRecordToBinding.)
    if (!managed.meta.lastDetectedAgent) {
      managed.meta.lastDetectedAgent = binding.agent as AgentSlug;
    }
    drop();
    applied++;
    log('info', `X6 resume-spool: ingested binding for ${ptyId} (session ${binding.sessionId.slice(0, 8)})`);
  }
  if (applied > 0) stateWriter.saveImmediate(buildState(sessionManager));
  return applied;
}

// === PID / Lock helpers ===

async function isProcessRunning(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    // process.kill(pid, 0) is unreliable on Windows — always succeeds for stale PIDs.
    try {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const pathMod = require('path');
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const tasklist = pathMod.join(systemRoot, 'System32', 'tasklist.exe');
      const { stdout } = await execFileAsync(
        tasklist,
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

/** Check if a PID belongs to the shell process we originally spawned.
 *  Prevents killing unrelated processes after PID recycling (e.g. reboot). */
async function isOurShellProcess(pid: number, expectedCmd: string): Promise<boolean> {
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    if (process.platform === 'win32') {
      const pathMod = require('path');
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const wmic = pathMod.join(systemRoot, 'System32', 'wbem', 'wmic.exe');
      const { stdout } = await execFileAsync(
        wmic,
        ['process', 'where', `ProcessId=${pid}`, 'get', 'ExecutablePath', '/value'],
        { encoding: 'utf-8', timeout: 3000, windowsHide: true },
      );
      // WMIC output: "ExecutablePath=C:\Windows\...\powershell.exe\r\n"
      const match = (stdout as string).match(/ExecutablePath=(.+)/i);
      if (!match) return false;
      const actualExe = match[1].trim().toLowerCase();
      const expectedExe = expectedCmd.toLowerCase();
      // Match if the actual executable path ends with the expected command
      return actualExe.endsWith(pathMod.basename(expectedExe).toLowerCase()) ||
             actualExe === expectedExe;
    } else {
      // Unix: check /proc/<pid>/exe or use ps
      const { stdout } = await execFileAsync('ps', ['-o', 'comm=', '-p', String(pid)], {
        encoding: 'utf-8', timeout: 3000,
      });
      const actualCmd = (stdout as string).trim();
      const expectedBase = path.basename(expectedCmd);
      return actualCmd === expectedBase || actualCmd.includes(expectedBase);
    }
  } catch {
    // If we can't determine, err on the side of caution — don't kill
    return false;
  }
}

async function acquireLock(): Promise<boolean> {
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
        if (!isNaN(existingPid)) {
          const running = await isProcessRunning(existingPid);
          if (running) {
            log('error', `Another daemon is already running (PID ${existingPid})`);
            return false;
          }
          // tasklist says not running — but could be a tasklist failure.
          // Use bootId comparison as a fallback: if bootId matches the saved state,
          // the lock is truly stale (same boot, process gone).
          // If bootId differs, it's definitely stale (reboot happened).
          //
          // This one-shot StateWriter intentionally omits the suspended-TTL
          // config — acquireLock() runs before loadConfig(), so it isn't
          // available yet. Safe: we only read savedState.bootId here and
          // discard the pruned session list; the authoritative, config-driven
          // prune runs on the main StateWriter during recovery (codex #3 —
          // both startup paths handled).
          const stateWriter = new StateWriter(wmuxDir);
          const savedState = stateWriter.load();
          const currentBoot = await getBootId();
          if (savedState.bootId && savedState.bootId !== currentBoot) {
            log('info', `Boot ID changed — lock is stale (reboot detected)`);
          }
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
  maxRecover: number,
): Promise<void> {
  const state = stateWriter.load();
  let changed = false;
  const recoveredIds = new Set<string>();
  // X6 ③ (CodeRabbit): pre-read the spool (no consume) so an exec/supervised agent
  // pane whose exact binding only exists in the spool replays as `--resume <id>`,
  // not `--continue`. The post-recovery ingestResumeSpool still does the durable
  // apply + cleanup; this just makes the binding available at replay-launch time.
  const spoolBindings = readResumeSpoolMap();

  // Detect reboot: if bootId changed, all old PIDs are stale — skip kill attempts
  const currentBootId = await getBootId();
  const rebooted = state.bootId != null && state.bootId !== currentBootId;
  if (rebooted) {
    log('info', `Boot ID changed (${state.bootId} → ${currentBootId}) — reboot detected, skipping PID kills`);
  }

  // Pick the MAX_RECOVER_SESSIONS most recently active sessions and skip
  // the rest. Skipped sessions stay in state.sessions verbatim and can be
  // recovered on a later launch once the live count drops, or get reaped
  // by SUSPENDED_TTL_HOURS in StateWriter.load if they keep idling.
  // Cap is independent of MAX_SESSIONS so the user always has headroom
  // to create new panes after a heavy session.
  const { recoverableIds, cappedCount } = selectRecoverableSessions(
    state.sessions,
    maxRecover,
  );
  if (cappedCount > 0) {
    log(
      'warn',
      `Recovery cap: ${recoverableIds.size + cappedCount} eligible sessions, recovering ${recoverableIds.size} most recent. ${cappedCount} kept suspended for next launch (or pruned by 7-day TTL).`,
    );
  }

  for (const session of state.sessions) {
    if (session.state === 'dead') continue;
    // Cap-skipped: leave session untouched in state.sessions. It will be
    // re-evaluated on the next launch.
    if (!recoverableIds.has(session.id)) continue;

    if (session.state === 'suspended' && session.bufferDumpPath) {
      // Attempt to recover suspended session
      try {
        let scrollbackData: Buffer | undefined;
        if (fs.existsSync(session.bufferDumpPath)) {
          scrollbackData = fs.readFileSync(session.bufferDumpPath);
        }
        // Instrumentation for #35 (scrollback-empty-after-restart). The
        // matching `Suspended session X (buffer: N bytes)` line on the
        // shutdown side already proves what we dumped; this line proves
        // what we found on the next boot. If they match, the dump/restore
        // file path is intact and a downstream layer (RingBuffer write,
        // SessionPipe flush, renderer) is at fault. If the bytes drop
        // here, the dump file itself was empty or missing.
        log(
          'info',
          `[recovery] session ${session.id} dump=${session.bufferDumpPath} exists=${scrollbackData !== undefined} bytes=${scrollbackData?.length ?? 0}`,
        );

        // Verify cwd still exists; fall back to homedir
        const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();

        // ConPTY on Windows occasionally rejects the first spawn after a
        // daemon restart with ERROR_INVALID_PARAMETER (87) — a known
        // transient race in the PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE init.
        // Without retry, a single transient failure permanently dead-marks
        // the session and the user loses their scrollback for good. The
        // RPC-level retry in scripts/instrumentation-verify.mjs (Flow 1)
        // is the same pattern; mirror it here for recovery.
        // Other errors (e.g. ENOENT cwd, MAX_SESSIONS) are not transient
        // and fall through to the outer catch immediately.
        // Retry budget sized to absorb the worst observed ConPTY ERROR 87
        // burst (4 consecutive failures in dynamic verify on a busy box).
        // 8 attempts × (200 + i*100) ms backoff = up to ~4.4 s waiting
        // before giving up. Recovery runs once per daemon boot, so the
        // worst-case latency hit is only paid by users actually hitting
        // the burst — the happy path still resolves on attempt 1.
        const RECOVERY_PTY_RETRIES = 8;
        let recovered: ReturnType<typeof sessionManager.createSession> | undefined;
        let lastSpawnErr: unknown;
        for (let attempt = 1; attempt <= RECOVERY_PTY_RETRIES; attempt++) {
          try {
            recovered = sessionManager.createSession({
              id: session.id,
              cmd: session.cmd,
              cwd,
              env: session.env,
              cols: session.cols,
              rows: session.rows,
              agent: session.agent,
              createdAt: session.createdAt,
              deadTtlHours: session.deadTtlHours,
              // X8: replay the exec unit + supervision policy — for an exec
              // session this relaunches the supervised command itself (the
              // reboot-survival story), not an empty shell.
              exec: session.exec,
              // X6: if the exec unit is an agent, resume its conversation
              // (non-persisted launch command; meta.exec.command stays original).
              execLaunchCommand: resumeLaunchCommand(session, spoolBindings.get(session.id)),
              supervision: session.supervision,
              scrollbackData,
              // v2.8.1: stay muted until the renderer's first resize so PTY
              // output produced at the saved geometry can't interleave with
              // the renderer paint at its current geometry (Bug 2).
              deferOutput: true,
            });
            break;
          } catch (err) {
            lastSpawnErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            const transient = msg.includes('error code: 87');
            if (!transient) break;
            log(
              'warn',
              `Recovery PTY spawn attempt ${attempt}/${RECOVERY_PTY_RETRIES} failed for ${session.id}: ${msg}`,
            );
            if (attempt < RECOVERY_PTY_RETRIES) {
              await new Promise((resolve) =>
                setTimeout(resolve, 200 + attempt * 100),
              );
            }
          }
        }
        if (!recovered) {
          throw lastSpawnErr ?? new Error('PTY spawn failed (no error captured)');
        }

        // Start process monitoring for the new PTY
        processMonitor.watch(recovered.id, recovered.pid, () => {
          const managed = sessionManager.getSession(recovered.id);
          if (managed && managed.meta.state !== 'dead') {
            managed.meta.state = 'dead';
            sessionManager.emit('session:died', { id: recovered.id, exitCode: null, reason: 'recovery' });
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
      if (!rebooted && await ProcessMonitor.isAlive(session.pid)) {
        // Guard against PID recycling: verify the process is actually
        // the shell we spawned, not an unrelated system process.
        if (await isOurShellProcess(session.pid, session.cmd)) {
          try { process.kill(session.pid); } catch { /* ignore */ }
        } else {
          log('warn', `PID ${session.pid} is alive but not our shell (${session.cmd}) — skipping kill`);
        }
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
            deadTtlHours: session.deadTtlHours,
            // X8: replay exec unit + supervision (see suspended path above).
            exec: session.exec,
            // X6: resume the agent conversation on replay (see suspended path).
            execLaunchCommand: resumeLaunchCommand(session, spoolBindings.get(session.id)),
            supervision: session.supervision,
            scrollbackData,
            // v2.8.1: see deferOutput rationale above (Bug 2).
            deferOutput: true,
          });

          processMonitor.watch(recovered.id, recovered.pid, () => {
            const managed = sessionManager.getSession(recovered.id);
            if (managed && managed.meta.state !== 'dead') {
              managed.meta.state = 'dead';
              sessionManager.emit('session:died', { id: recovered.id, exitCode: null, reason: 'recovery' });
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
          deadTtlHours: session.deadTtlHours,
          // X8: replay exec unit + supervision (see suspended path above).
          exec: session.exec,
          // X6: resume the agent conversation on replay (see suspended path).
          execLaunchCommand: resumeLaunchCommand(session, spoolBindings.get(session.id)),
          supervision: session.supervision,
          // v2.8.1: see deferOutput rationale above (Bug 2).
          deferOutput: true,
        });

        processMonitor.watch(recovered.id, recovered.pid, () => {
          const managed = sessionManager.getSession(recovered.id);
          if (managed && managed.meta.state !== 'dead') {
            managed.meta.state = 'dead';
            sessionManager.emit('session:died', { id: recovered.id, exitCode: null, reason: 'recovery' });
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
    // X6 ②/③ (codex review 2026-06-14): createSession does NOT replay the
    // persisted resume markers (lastDetectedAgent / resumeBinding) into the
    // fresh recovered meta — so the recovery save below would DROP them, and a
    // SECOND reboot before the agent re-runs (and re-emits them) would lose the
    // resume offer / exact-session binding. Carry them forward onto the live
    // meta first so buildState persists them durably across consecutive reboots.
    for (const persisted of state.sessions) {
      if (!recoveredIds.has(persisted.id)) continue;
      const managed = sessionManager.getSession(persisted.id);
      if (!managed) continue;
      if (persisted.lastDetectedAgent && !managed.meta.lastDetectedAgent) {
        managed.meta.lastDetectedAgent = persisted.lastDetectedAgent;
      }
      if (persisted.resumeBinding && !managed.meta.resumeBinding) {
        managed.meta.resumeBinding = persisted.resumeBinding;
      }
    }
    // Build combined state: recovered (live) sessions + everything we
    // intentionally left untouched (originally-dead within TTL, plus
    // any session the recovery cap excluded — which stays suspended).
    const liveState = buildState(sessionManager);
    const preservedFromState = state.sessions.filter(
      (s) => !recoveredIds.has(s.id),
    );
    liveState.sessions.push(...preservedFromState);
    stateWriter.saveImmediate(liveState);
  }

  // X6 ③ (Rung 3): reconcile the durable hook spool onto the recovered sessions
  // BEFORE surfacing the pill, so a binding lost to a failed live RPC (main pipe
  // down at capture time — the dominant ENOENT case in the bug report) still
  // drives an EXACT-session resume. Keyed by WMUX_PTY_ID, so attribution is
  // per-pane with no cwd guessing. Writes the binding + (Rung 1) lastDetectedAgent
  // onto the live meta and persists, so the loop below surfaces it like any other.
  ingestResumeSpool(sessionManager, stateWriter);

  // X6 Feature ②/③: flag recovered INTERACTIVE agent panes for the resume pill.
  // Read off the LIVE recovered meta (not the persisted record): the carry-forward
  // above, the spool ingest, and the Rung-1 hook-sourced gate ALL write their
  // markers onto managed.meta, so the live meta is the single source that reflects
  // every capture path. Exec/supervised panes are excluded — they already
  // auto-resume via execLaunchCommand (Feature ①).
  for (const recoveredId of recoveredIds) {
    const managed = sessionManager.getSession(recoveredId);
    if (!managed) continue;
    const m = managed.meta;
    const offer = resumeOfferForRecovered(m);
    if (!offer) continue;
    recoveredAgentShellIds.set(recoveredId, offer as AgentSlug);
    // Surface the EXACT-session binding ONLY when its captured cwd still matches
    // the recovered session's cwd (F7 — `--resume` is cwd-scoped) AND its origin
    // transcript still exists (D5 — a purged id is a dead-end). Either miss drops
    // the pill to the cwd-relative `--continue`.
    if (m.resumeBinding && normalizeResumeCwd(m.resumeBinding.cwd) === normalizeResumeCwd(m.cwd) && bindingTranscriptLives(m.resumeBinding)) {
      recoveredResumeBindings.set(recoveredId, m.resumeBinding);
    }
  }

  // Clean up orphaned buffer files. Preserve buffers for both the
  // recovered sessions and the cap-skipped suspended ones — the latter
  // need their .buf files intact to survive until the next launch.
  const preservedBufferIds = new Set(recoveredIds);
  for (const session of state.sessions) {
    if (session.state !== 'dead' && !recoveredIds.has(session.id)) {
      preservedBufferIds.add(session.id);
    }
  }
  stateWriter.cleanOrphanedBuffers(preservedBufferIds);
}

// === X8 supervised restart ===

/**
 * Re-create the SAME session id with a fresh PTY — the PaneSupervisor's
 * restart primitive. Mirrors the recovery path (createSession replay of the
 * persisted meta incl. the exec unit + processMonitor re-watch + persist),
 * with two deliberate differences:
 *  - tombstone removal is SILENT (removeTombstone, never destroySession) so
 *    the restart can't masquerade as a user close to main or the supervisor;
 *  - no scrollbackData / deferOutput — the renderer's xterm survives the
 *    death and keeps visual continuity itself; replaying the old buffer
 *    through the fresh ring would duplicate it on the PTY_RECONNECT flush.
 * The renderer is told via the 'session.restarted' broadcast (supervisor
 * emits it after this returns) and re-attaches through the existing
 * PTY_RECONNECT machinery.
 *
 * Throws on spawn failure — the supervisor counts that as a failed start
 * and backs off. On failure the dead tombstone is re-inserted so the
 * session keeps existing for sessions.json, the badge, and rearm.
 */
function restartSupervisedSession(
  id: string,
  sessionManager: DaemonSessionManager,
  stateWriter: StateWriter,
  processMonitor: ProcessMonitor,
): void {
  const managed = sessionManager.getSession(id);
  if (!managed) throw new Error(`restart: session '${id}' not found`);
  if (managed.meta.state !== 'dead') {
    throw new Error(`restart: session '${id}' is '${managed.meta.state}', not dead`);
  }

  const meta = managed.meta;
  const replay = {
    id: meta.id,
    cmd: meta.cmd,
    cwd: fs.existsSync(meta.cwd) ? meta.cwd : os.homedir(),
    env: meta.env,
    cols: meta.cols,
    rows: meta.rows,
    agent: meta.agent,
    createdAt: meta.createdAt,
    deadTtlHours: meta.deadTtlHours,
    exec: meta.exec,
    // X6: a supervised agent that crashed resumes its conversation on restart
    // (non-persisted launch command; meta.exec.command stays original).
    execLaunchCommand: resumeLaunchCommand(meta),
    supervision: meta.supervision,
  };

  sessionManager.removeTombstone(id);
  let recovered;
  try {
    recovered = sessionManager.createSession(replay);
  } catch (err) {
    sessionManager.reinsertSession(managed);
    throw err;
  }

  // Carry the resume markers onto the recreated session meta. createSession builds
  // FRESH metadata, so without this the saveImmediate below drops the exact binding
  // (and the pill gate), and a second crash/reboot before another hook lands falls
  // back to ambiguous --continue (codex P2). Mirrors the recovery carry-forward.
  const fresh = sessionManager.getSession(recovered.id);
  if (fresh) {
    if (meta.resumeBinding && !fresh.meta.resumeBinding) fresh.meta.resumeBinding = meta.resumeBinding;
    if (meta.lastDetectedAgent && !fresh.meta.lastDetectedAgent) fresh.meta.lastDetectedAgent = meta.lastDetectedAgent;
  }

  // Same external-death safety net as the create/recovery paths.
  processMonitor.watch(recovered.id, recovered.pid, () => {
    const current = sessionManager.getSession(recovered.id);
    if (current && current.meta.state !== 'dead') {
      current.meta.state = 'dead';
      sessionManager.emit('session:died', { id: recovered.id, exitCode: null, reason: 'process-monitor' });
    }
  });

  stateWriter.saveImmediate(buildState(sessionManager));
  log('info', `[supervisor] session ${id} re-created (pid ${recovered.pid})`);
}

// === RPC handler registration ===

function registerRpcHandlers(
  pipeServer: DaemonPipeServer,
  sessionManager: DaemonSessionManager,
  stateWriter: StateWriter,
  lanLinkInbox: LanLinkInbox,
  lanLinkController: LanLinkController,
  lanLinkServer: LanLinkServer,
  channelStateWriter: ChannelStateWriter,
  sessionPipes: Map<string, SessionPipe>,
  processMonitor: ProcessMonitor,
  startTime: number,
  sessionDataListeners: Map<string, { bridge: import('./DaemonPTYBridge').DaemonPTYBridge; listener: (data: Buffer) => void }>,
  watchdog: Watchdog,
  paneSupervisor: PaneSupervisor,
  triggerSnapshot: () => void,
  channelService: ChannelService,
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
      // X8: exec unit + supervision. Fresh creates always start 'armed' —
      // a persisted 'stopped' only ever enters through recovery replay.
      exec: p.exec,
      supervision: p.supervision
        ? { restart: p.supervision.restart, limit: p.supervision.limit, status: 'armed' }
        : undefined,
    });
    if (session.supervision) {
      paneSupervisor.arm(
        session.id,
        { restart: session.supervision.restart, limit: session.supervision.limit },
        session.supervision.status,
      );
    }

    // Start process monitoring
    processMonitor.watch(session.id, session.pid, () => {
      // Process died externally — session manager's bridge exit handler
      // should already handle this via PTY onExit, but this is a safety net
      const managed = sessionManager.getSession(session.id);
      if (managed && managed.meta.state !== 'dead') {
        managed.meta.state = 'dead';
        sessionManager.emit('session:died', { id: session.id, exitCode: null, reason: 'process-monitor' });
      }
    });

    // Save state immediately
    const state = buildState(sessionManager);
    stateWriter.saveImmediate(state);

    // A1b — fire the snapshot runner so the new session has a .buf on disk
    // before the next 30 s tick. Crashes within that window now keep a
    // recoverable trace instead of losing the brand-new pane entirely.
    triggerSnapshot();

    return session;
  });

  // daemon.destroySession
  pipeServer.onRpc('daemon.destroySession', async (params) => {
    const p = params as unknown as DaemonSessionIdParams;
    // OBSERVABILITY: log wmux-initiated kills (pane/workspace close, reset) so
    // they can be told apart from a process self-exit in the session:died log.
    log('info', `[lifecycle] destroySession id=${p.id} reason=rpc`);

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

    // X8 belt: the session:destroyed event below also disarms, but a
    // destroy of an id the manager no longer holds (restart-failure edge)
    // emits nothing — drop any pending supervised restart explicitly.
    paneSupervisor.disarm(p.id);

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

      try {
        await pipe.start();
      } catch (err) {
        managed.bridge.removeListener('data', onData);
        sessionDataListeners.delete(p.id);
        sessionPipes.delete(p.id);
        log('error', `Failed to start session pipe for ${p.id}:`, err);
        throw err;
      }
    }

    const state = buildState(sessionManager);
    stateWriter.saveImmediate(state);

    // A1b — fire the snapshot runner after attach so a freshly-attached
    // recovered session has its .buf refreshed inside the first 30 s window.
    triggerSnapshot();

    // RCA A8 — log the attach lifecycle event. Previously success was silent,
    // so a client re-attaching (the renderer reconnect path) left no daemon-side
    // trace to correlate with renderer ptyId-clear / session-replacement.
    log('info', `[lifecycle] attachSession id=${p.id} pipe=${managed ? 'started' : 'no-managed-session'} total=${sessionManager.listSessions().length}`);

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
      try {
        await pipe.stop();
      } catch (err) {
        log('warn', `Failed to stop session pipe for ${p.id}:`, err);
      }
      sessionPipes.delete(p.id);
    }

    sessionManager.detachSession(p.id);

    const state = buildState(sessionManager);
    stateWriter.saveImmediate(state);

    // RCA A8 — log the detach lifecycle event (was silent on success).
    log('info', `[lifecycle] detachSession id=${p.id} total=${sessionManager.listSessions().length}`);

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
    // X8: join the supervisor's volatile runtime (restart counts, pending
    // backoff) onto supervised sessions — additive field consumed by
    // `wmux list --json` and the sidebar badge.
    // X6 ②: attach resumeAgent ONLY for sessions recovered-this-boot that were
    // interactive agents (recoveredAgentShellIds) — drives the resume pill.
    return sessionManager.listSessions().map((s) => {
      // The slug is held in the map (captured from the persisted session at
      // recovery) — NOT read off the live meta, which is a fresh shell here.
      const resumeAgent = recoveredAgentShellIds.get(s.id);
      // X6 ③: the captured binding for the EXACT-session resume, also recovery-
      // only (same transient-map reasoning as resumeAgent) and guarded by the
      // cwd-match + transcript existence-probe at recovery time.
      const resumeBinding = recoveredResumeBindings.get(s.id);
      // meta.resumeBinding is an INTERNAL durability field — it is persisted
      // (and carried forward across consecutive recoveries) so the EXACT-session
      // resume survives multiple reboots, but it must NOT leak to clients raw:
      // the pill only ever gets the recovery-SURFACED binding (which passed the
      // cwd + existence guards). Strip the meta field, then re-attach the
      // guarded transient one. Without this strip, the carry-forward would
      // bypass the D5/F7 guards (caught by x6-resume-binding-dogfood D/E).
      const base = { ...s };
      delete base.resumeBinding;
      const withRuntime = base.supervision
        ? { ...base, supervisionRuntime: paneSupervisor.getRuntime(s.id) }
        : base;
      const withAgent = resumeAgent ? { ...withRuntime, resumeAgent } : withRuntime;
      return resumeBinding ? { ...withAgent, resumeBinding } : withAgent;
    });
  });

  // X8 supervision control — renderer-only surface (main IPC → daemon).
  // External pipe clients are blocked upstream by the 'wmux.internal'
  // capability gate; nobody but the user re-arms a tripped runaway guard.
  pipeServer.onRpc('daemon.superviseRearm', async (params) => {
    const p = params as unknown as DaemonSessionIdParams;
    return { ok: paneSupervisor.rearm(p.id) };
  });

  pipeServer.onRpc('daemon.superviseStop', async (params) => {
    const p = params as unknown as DaemonSessionIdParams;
    return { ok: paneSupervisor.stop(p.id) };
  });

  // X6 ③: persist the resume binding captured live from the claude hook (main
  // forwards it after env-first ptyId resolution). Always refresh the in-memory
  // meta (ts freshness), but only saveImmediate when a DURABLE field changes
  // (sessionId / permissionMode / cwd) — bounding sync writes to ~once per
  // permission-mode transition, exactly like lastDetectedAgent (X6 ②). The
  // SIGKILL-survival rule is the whole point: the binding must be on disk before
  // a reboot, and a reboot fires no exit hook.
  pipeServer.onRpc('daemon.setResumeBinding', async (params) => {
    const p = params as unknown as DaemonSetResumeBindingParams;
    const managed = sessionManager.getSession(p.id);
    if (!managed || !p.resumeBinding || !p.resumeBinding.sessionId) return { ok: false };
    const prev = managed.meta.resumeBinding;
    // codex P2: ignore a STALE capture — an older hook RPC (a delayed Stop /
    // SessionStart from a prior turn) reaching the daemon after a newer one must
    // not replace the durable exact id. The spool ingest already does this; mirror
    // it on the live path so a reboot can't resume the wrong conversation.
    if (prev && typeof p.resumeBinding.ts === 'number' && p.resumeBinding.ts < prev.ts) {
      return { ok: true };
    }
    // codex P2: a SessionStart fired before its transcript exists (F9) sends the
    // #12235-UNSAFE payload.session_id as the id and carries NO transcriptPath.
    // Don't let that provisional capture overwrite an existing transcript-derived
    // (authoritative) binding for a DIFFERENT session — a reboot in between would
    // then `--resume <wrong id>`.
    if (prev && prev.transcriptPath && !p.resumeBinding.transcriptPath
        && prev.sessionId !== p.resumeBinding.sessionId) {
      return { ok: true };
    }
    // Sticky-merge: a capture that couldn't read permissionMode (transcript tail
    // miss) must not wipe a previously-captured mode (codex review 2026-06-14).
    const next = mergeResumeBinding(prev, p.resumeBinding);
    let durableChange = !prev
      || prev.sessionId !== next.sessionId
      || prev.agent !== next.agent
      || prev.permissionMode !== next.permissionMode
      || prev.cwd !== next.cwd
      // transcriptPath is the D5 liveness-probe input. A SessionStart persists a
      // binding without it (the .jsonl doesn't exist yet, F9); the first Stop
      // fills it in with the same sessionId/cwd — without this the fill is not
      // saveImmediate'd and a reboot loses the probe path (CodeRabbit). It only
      // transitions once (absent → present), so no per-turn write amplification.
      || prev.transcriptPath !== next.transcriptPath;
    managed.meta.resumeBinding = next;
    // X6 ③ (Rung 1): a captured binding PROVES claude ran in this pane, so the
    // hook is a SECOND, independent writer of the pill gate (lastDetectedAgent) —
    // the live AgentDetector banner is once-per-session and is never re-armed from
    // restored scrollback, so a pane whose banner was missed but whose hook landed
    // would otherwise hold the exact uuid yet show NO pill after a reboot. Bounded
    // to a known slug and a one-time set (the !lastDetectedAgent guard) so it costs
    // at most one extra sync write per pane, exactly like the banner path.
    if (!managed.meta.lastDetectedAgent && KNOWN_AGENT_SLUGS.has(next.agent)) {
      managed.meta.lastDetectedAgent = next.agent as AgentSlug;
      durableChange = true;
    }
    if (durableChange) {
      stateWriter.saveImmediate(buildState(sessionManager));
    }
    return { ok: true };
  });

  // daemon.getAgentName — daemon AgentDetector가 gate로 확정한 에이전트 표시명을
  // 직접 조회한다. renderer detection pull의 권위 소스: main으로의 session:agent
  // emit 전파(타이밍 race)를 우회해, 배너 매칭이 됐다면 항상 정답을 준다.
  pipeServer.onRpc('daemon.getAgentName', async (params) => {
    const id = typeof params['id'] === 'string' ? params['id'] : '';
    const session = id ? sessionManager.getSession(id) : undefined;
    return { agentName: session?.bridge.getLastAgent() ?? null };
  });

  // daemon.readPromptEvents — read structured OSC 133 prompt/command events
  // from a session's PromptEventLog. Falls back to an empty response when the
  // session doesn't exist so callers can degrade gracefully.
  pipeServer.onRpc('daemon.readPromptEvents', async (params) => {
    const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : '';
    if (!sessionId) {
      throw new Error('daemon.readPromptEvents: sessionId is required');
    }
    const managed = sessionManager.getSession(sessionId);
    if (!managed) {
      return {
        events: [],
        lastCompletedRange: null,
        totalBytesWritten: 0,
        sessionFound: false,
      };
    }

    const limit = typeof params['limit'] === 'number' ? Math.max(0, Math.floor(params['limit'])) : 32;
    const sinceOffset = typeof params['sinceOffset'] === 'number' ? params['sinceOffset'] : null;
    const lastCommandOnly = params['lastCommandOnly'] === true;

    const lastCompletedRange = managed.promptLog.lastCompletedCommandRange();
    const totalBytesWritten = managed.ringBuffer.totalBytesWritten;

    if (lastCommandOnly) {
      return {
        events: [],
        lastCompletedRange,
        totalBytesWritten,
        sessionFound: true,
      };
    }

    const events = sinceOffset !== null
      ? managed.promptLog.since(sinceOffset)
      : managed.promptLog.recent(limit);

    return {
      events,
      lastCompletedRange,
      totalBytesWritten,
      sessionFound: true,
    };
  });

  // daemon.inbox.poll — LanLink PR-2 cursor-pull. Returns every inbox record
  // with seq > cursor (the DELIVERY guarantee; the lanlink.remote.received
  // broadcast is only a re-pull nudge). The store degrades gracefully (typed
  // empty) on a bogus cursor. No origin gating — the daemon control pipe is
  // machine-local; remote bytes never reach here (they land in the inbox via
  // the PR-4 LAN listener, which this PR does not build).
  pipeServer.onRpc('daemon.inbox.poll', async (params) => {
    const cursor = typeof params['cursor'] === 'number' ? params['cursor'] : 0;
    return lanLinkInbox.poll(cursor);
  });

  // LanLink PR-3 — control-plane read/write. Like inbox.poll these are NOT origin-
  // gated: the daemon control pipe is machine-local (the future PR-4 LAN listener
  // is a SEPARATE net.Server with its own allow-list router that never registers
  // these). `lanlink.status` reads persisted state + live NICs; `lanlink.configure`
  // validates the renderer-supplied patch (coerceLanLinkPatch — throws on garbage),
  // persists, and fires the 'changed' seam. Network-0: no listener is started here.
  pipeServer.onRpc('lanlink.status', async () => {
    return lanLinkController.getStatus();
  });
  pipeServer.onRpc('lanlink.configure', async (params) => {
    return lanLinkController.configure(coerceLanLinkPatch(params));
  });

  // LanLink PR-4 — pairing + peer control plane. Machine-local control-pipe RPCs
  // (NOT origin-gated, NOT registered on the LAN net.Server, which carries framed
  // bytes only). `pair.begin` mints a 6-digit PIN + arms the <=2min window;
  // `pair.join`/`send` are the OUTBOUND initiator paths; `peers.remove` revokes a
  // peer and destroys its live AEAD connection (C13). These are control-pipe RPCs,
  // not RpcMethods — the renderer/Settings UI bridge for them is PR-5.
  const coercePort = (v: unknown): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535 ? v : 0;
  pipeServer.onRpc('lanlink.pair.begin', async () => lanLinkServer.beginPairing());
  pipeServer.onRpc('lanlink.pair.status', async () => lanLinkServer.pairingStatus());
  pipeServer.onRpc('lanlink.pair.cancel', async () => {
    lanLinkServer.cancelPairing();
    return { ok: true };
  });
  pipeServer.onRpc('lanlink.pair.join', async (params) => {
    const host = typeof params['host'] === 'string' ? params['host'] : '';
    const port = coercePort(params['port']);
    const pin = typeof params['pin'] === 'string' ? params['pin'] : '';
    if (!host || !port || !pin) throw new Error('lanlink.pair.join: host, port, and pin are required');
    return lanLinkServer.joinPeer(host, port, pin);
  });
  pipeServer.onRpc('lanlink.send', async (params) => {
    const host = typeof params['host'] === 'string' ? params['host'] : '';
    const port = coercePort(params['port']);
    const peerUuid = typeof params['peerUuid'] === 'string' ? params['peerUuid'] : '';
    const text = typeof params['text'] === 'string' ? params['text'] : '';
    if (!host || !port || !peerUuid) throw new Error('lanlink.send: host, port, and peerUuid are required');
    await lanLinkServer.sendMessage(host, port, peerUuid, text);
    return { ok: true };
  });
  pipeServer.onRpc('lanlink.peers.list', async () => ({ peers: lanLinkServer.listPeers() }));
  pipeServer.onRpc('lanlink.peers.remove', async (params) => {
    const peerUuid = typeof params['peerUuid'] === 'string' ? params['peerUuid'] : '';
    if (peerUuid) lanLinkServer.revokePeer(peerUuid);
    return { ok: true };
  });

  // __lanlink.inject — DEV/TEST ONLY synthetic inject (no real LAN peer). Gated
  // so it never registers in a production build. Lets PR-2 be exercised end to
  // end (durable append → nudge → main cursor-pull → renderer) independently of
  // the PR-4 LAN transport. The future PR-4 receive path and the channels
  // deliver() remote endpoint call the SAME LanLinkInbox.append() under the hood.
  // Positive dev-detection (matches enforcementMode.detectIsDev). This codebase
  // does NOT set NODE_ENV='production' for packaged builds — it judges prod via
  // app.isPackaged — so a `!== 'production'` gate would WRONGLY register this in
  // packaged production (NODE_ENV is unset there). Allowlist dev/test/explicit
  // opt-in only, so the inject RPC is absent in a shipped build.
  if (
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'test' ||
    process.env.WMUX_LANLINK_INJECT === '1'
  ) {
    pipeServer.onRpc('__lanlink.inject', async (params) => {
      const { seq } = lanLinkInbox.injectSynthetic({
        id: typeof params['id'] === 'string' ? params['id'] : undefined,
        peerName: typeof params['peerName'] === 'string' ? params['peerName'] : 'peer',
        text: typeof params['text'] === 'string' ? params['text'] : '',
      });
      // The durable write already completed (append is synchronous) BEFORE we
      // broadcast — the nudge is best-effort and may be dropped; the cursor-pull
      // is the delivery guarantee.
      pipeServer.broadcast({
        type: 'lanlink.remote.received',
        sessionId: LANLINK_SENTINEL_SESSION_ID,
        data: { seq },
      });
      return { ok: true, seq };
    });
  }

  // daemon.ping
  pipeServer.onRpc('daemon.ping', async () => {
    const sessions = sessionManager.listSessions();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    // RCA A4 — report event-loop lag (ms) so the controller distinguishes a
    // busy-but-responsive daemon from a hung one. histogram.mean is in
    // nanoseconds and is NaN before the first sample; reset so the next ping
    // reflects lag since this one.
    const meanNs = eventLoopMonitor.mean;
    const eventLoopLagMs = Number.isFinite(meanNs) ? Math.round(meanNs / 1e6) : 0;
    eventLoopMonitor.reset();
    // `pid` lets the launcher restore daemon.pid after a Step ③ reconnect
    // (the redundant-daemon path cleaned the pid file). Log-only otherwise.
    // `bootTrace` is additive (S-A cold-start instrumentation): the perf
    // bench reads it; launcher/respawn-controller only read status/pid.
    return {
      status: 'ok',
      pid: process.pid,
      uptime,
      sessions: sessions.length,
      eventLoopLagMs,
      bootTrace: { jsStartEpochMs: DAEMON_BOOT.jsStartEpochMs, marks: DAEMON_BOOT.marks },
    };
  });

  // === A2A Channels (a2a-channels U4) ===
  // Seven thin pass-throughs onto ChannelService. Each handler validates the
  // caller-supplied shape enough to keep `params as unknown as XParams`
  // sound, then returns the service's Result envelope verbatim. Wire-format
  // errors (the `ChannelError` branch) flow back to the renderer untouched
  // so a typed RPC failure mirrors the typed service error. The Post path
  // additionally emits a `channel.message` event via the injected emit
  // sink (ChannelService.emit → pipeServer.broadcast) — see ChannelService
  // plan KTD3 for the critical-section placement.
  //
  // Capability enforcement lives upstream in RpcRouter (methodCapabilityMap)
  // and gates these as either `a2a.channel.read` (list, get, getMessages,
  // getMembers) or `a2a.channel.send` (create, post, join, leave, archive).
  // The pipe layer has no per-call identity context here; the auth token
  // covers the daemon transport, and finer-grained plugin permission will
  // land in the follow-up PR that introduces the permission enforcer for
  // method dispatch (mcp-plugin-spec).
  pipeServer.onRpc('a2a.channel.list', async (params) => {
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    if (!verifiedWorkspaceId) {
      return {
        ok: false,
        error: {
          code: 'NOT_AUTHORIZED',
          message: 'verifiedWorkspaceId is required',
        },
      };
    }
    return { ok: true, channels: channelService.list(verifiedWorkspaceId) };
  });

  pipeServer.onRpc('a2a.channel.get', async (params) => {
    const channelId = typeof params['channelId'] === 'string' ? params['channelId'] : '';
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    if (!channelId) {
      return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: 'channelId is required' } };
    }
    if (!verifiedWorkspaceId) {
      return {
        ok: false,
        error: {
          code: 'NOT_AUTHORIZED',
          message: 'verifiedWorkspaceId is required',
        },
      };
    }
    const channel = channelService.get(channelId, verifiedWorkspaceId);
    if (!channel) {
      return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: `No such channel: ${channelId}` } };
    }
    return { ok: true, channel };
  });

  pipeServer.onRpc('a2a.channel.getMessages', async (params) => {
    const channelId = typeof params['channelId'] === 'string' ? params['channelId'] : '';
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    if (!channelId) {
      return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: 'channelId is required' } };
    }
    if (!verifiedWorkspaceId) {
      return {
        ok: false,
        error: {
          code: 'NOT_AUTHORIZED',
          message: 'verifiedWorkspaceId is required',
        },
      };
    }
    const sinceSeq = typeof params['sinceSeq'] === 'number' ? params['sinceSeq'] : undefined;
    // Normalize limit to a finite non-negative integer before it reaches
    // getMessages — a NaN/Infinity/negative/fractional value would otherwise
    // produce a nonsensical tail slice (CodeRabbit review). Invalid ⇒ undefined
    // (no cap), the documented renderer default.
    const rawLimit = params['limit'];
    const limit =
      typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit >= 0
        ? rawLimit
        : undefined;
    return { ok: true, messages: channelService.getMessages(channelId, sinceSeq, verifiedWorkspaceId, limit) };
  });

  pipeServer.onRpc('a2a.channel.getMembers', async (params) => {
    const channelId = typeof params['channelId'] === 'string' ? params['channelId'] : '';
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    if (!channelId) {
      return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: 'channelId is required' } };
    }
    if (!verifiedWorkspaceId) {
      return {
        ok: false,
        error: {
          code: 'NOT_AUTHORIZED',
          message: 'verifiedWorkspaceId is required',
        },
      };
    }
    return { ok: true, members: channelService.getMembers(channelId, verifiedWorkspaceId) };
  });

  pipeServer.onRpc('a2a.channel.ack', async (params) => {
    const channelId = typeof params['channelId'] === 'string' ? params['channelId'] : '';
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    const rawUpto = params['uptoSeq'];
    // Guard NaN/Infinity/negative (review A1 P3) — uptoSeq is a monotonic seq floor.
    const uptoSeq = typeof rawUpto === 'number' && Number.isFinite(rawUpto) && rawUpto >= 0 ? rawUpto : 0;
    if (!channelId) {
      return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: 'channelId is required' } };
    }
    if (!verifiedWorkspaceId) {
      return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'verifiedWorkspaceId is required' } };
    }
    return channelService.ack({ channelId, verifiedWorkspaceId, uptoSeq });
  });

  pipeServer.onRpc('a2a.channel.create', async (params) => {
    const p = params as unknown as import('./channels/ChannelService').CreateChannelParams;
    if (!p.name || !p.visibility || !p.createdBy) {
      return { ok: false, error: { code: 'INVALID_NAME', message: 'name, visibility, and createdBy are required' } };
    }
    // D5: create is a mutating call whose server-pinned `createdBy` feeds the
    // archive authz gate — require a server-resolved verifiedWorkspaceId and
    // fail closed without one, identical to join/leave/post/archive below.
    if (!p.verifiedWorkspaceId) {
      return {
        ok: false,
        error: {
          code: 'NOT_AUTHORIZED',
          message: 'name, visibility, createdBy, and a server-resolved verifiedWorkspaceId are required',
        },
      };
    }
    return channelService.create(p);
  });

  pipeServer.onRpc('a2a.channel.archive', async (params) => {
    const channelId = typeof params['channelId'] === 'string' ? params['channelId'] : '';
    const archivedBy = typeof params['archivedBy'] === 'string' ? params['archivedBy'] : '';
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    if (!channelId || !archivedBy || !verifiedWorkspaceId) {
      return {
        ok: false,
        error: {
          code: 'NOT_AUTHORIZED',
          message: 'channelId, archivedBy, and verifiedWorkspaceId are required',
        },
      };
    }
    return channelService.archive({ channelId, archivedBy, verifiedWorkspaceId });
  });

  pipeServer.onRpc('a2a.channel.join', async (params) => {
    const p = params as unknown as import('./channels/ChannelService').JoinChannelParams;
    if (!p.channelId || !p.member || !p.verifiedWorkspaceId) {
      return {
        ok: false,
        error: { code: 'NOT_AUTHORIZED', message: 'channelId, member, and a server-resolved verifiedWorkspaceId are required' },
      };
    }
    return channelService.join(p);
  });

  pipeServer.onRpc('a2a.channel.leave', async (params) => {
    const p = params as unknown as import('./channels/ChannelService').LeaveChannelParams;
    if (!p.channelId || !p.workspaceId || !p.memberId || !p.verifiedWorkspaceId) {
      return {
        ok: false,
        error: { code: 'NOT_AUTHORIZED', message: 'channelId, workspaceId, memberId, and a server-resolved verifiedWorkspaceId are required' },
      };
    }
    return channelService.leave(p);
  });

  pipeServer.onRpc('a2a.channel.post', async (params) => {
    const p = params as unknown as import('./channels/ChannelService').PostMessageParams;
    if (!p.channelId || !p.sender || typeof p.text !== 'string' || !p.verifiedWorkspaceId) {
      return {
        ok: false,
        error: {
          code: 'NOT_AUTHORIZED',
          message: 'channelId, sender, text, and verifiedWorkspaceId are required',
        },
      };
    }
    return channelService.post(p);
  });

  pipeServer.onRpc('a2a.channel.invite', async (params) => {
    const p = params as unknown as import('./channels/ChannelService').InviteChannelParams;
    if (
      !p.channelId ||
      !p.invitedMember ||
      !p.invitedMember.workspaceId ||
      !p.invitedMember.memberId ||
      !p.verifiedWorkspaceId
    ) {
      return {
        ok: false,
        error: {
          code: 'NOT_AUTHORIZED',
          message: 'channelId, invitedMember{workspaceId,memberId}, and a server-resolved verifiedWorkspaceId are required',
        },
      };
    }
    return channelService.invite(p);
  });

  // a2a.channel.kick — eject another member. HUMANS-ONLY: this handler lives on
  // the DAEMON pipe (both renderer and pipe callers ultimately land here), but the
  // MAIN-process pipe router (a2a.channel.rpc.ts) deliberately does NOT register
  // 'a2a.channel.kick', so no MCP/agent client can reach it — only the renderer-only
  // channels:mutate-local IPC forwards it. See KickChannelParams for the rationale.
  pipeServer.onRpc('a2a.channel.kick', async (params) => {
    const p = params as unknown as import('./channels/ChannelService').KickChannelParams;
    if (!p.channelId || !p.targetWorkspaceId || !p.targetMemberId || !p.verifiedWorkspaceId) {
      return {
        ok: false,
        error: {
          code: 'NOT_AUTHORIZED',
          message:
            'channelId, targetWorkspaceId, targetMemberId, and a server-resolved verifiedWorkspaceId are required',
        },
      };
    }
    return channelService.kick(p);
  });

  // daemon.shutdown — gracefully terminate the daemon process. A2 makes
  // this RPC awaitable: the handler runs the full shutdown body (dumps,
  // state save, dispose) before returning, then defers the pipe stop and
  // process.exit to setImmediate so the RPC ack actually flushes back to
  // the caller. Callers (e.g., main before-quit / WM_ENDSESSION) can
  // await this with a per-call timeoutMs override (DaemonClient.rpc opt).
  pipeServer.onRpc('daemon.shutdown', async () => {
    log('info', 'Shutdown requested via RPC');
    await shutdown(
      'rpc.shutdown',
      sessionManager,
      pipeServer,
      stateWriter,
      channelStateWriter,
      sessionPipes,
      processMonitor,
      watchdog,
      { skipPipeStop: true, skipExit: true },
    );
    // ack flushes after this return; then the pipe + process tear down.
    //
    // Orphan-daemon fix: `pipeServer.stop()` awaits `server.close(cb)`, and
    // Node only fires that callback once EVERY tracked connection has closed.
    // If one client socket won't close (the very socket we just acked on, a
    // half-open session pipe, or a lingering Windows named-pipe handle), the
    // callback never fires, the returned promise never settles, and the
    // `.finally(() => process.exit(0))` never runs — leaving the daemon alive
    // forever after it already acked shutdown. That was the zombie `wmux.exe`
    // daemon users saw survive every Quit. Guard with a force-exit timer that
    // is deliberately NOT unref()'d, so it keeps the event loop alive until it
    // fires and guarantees the process dies even when stop() hangs.
    setImmediate(() => {
      const forceExit = setTimeout(() => {
        log('warn', 'daemon.shutdown: pipeServer.stop() did not finalize in 1s — forcing process.exit(0)');
        process.exit(0);
      }, 1000);
      // Delay stop()+exit by a tick so the `{status:'ok'}` ack flushes to the
      // caller's socket FIRST. pipeServer.stop() destroys every connected
      // socket; running it in the same macrotask as the queued ack write drops
      // the ack before it leaves the kernel buffer, and the caller (main's
      // full-shutdown race) then waits out its ENTIRE RPC timeout (~8-10s
      // observed) before the pid-kill backstop fires — a sluggish, ugly "Shut
      // down completely". 50 ms is ample for a local named-pipe / UDS flush;
      // the 1 s forceExit above still bounds a genuinely hung stop().
      setTimeout(() => {
        void pipeServer.stop().catch(() => { /* best effort */ }).finally(() => {
          clearTimeout(forceExit);
          process.exit(0);
        });
      }, 50);
    });
    return { status: 'ok' };
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
  // session:died → broadcast DaemonEvent + save state + cleanup.
  //
  // Each side-effect runs inside its own try/catch. A single broken pipe,
  // file-system EBUSY, or transient broadcast error must NEVER turn into an
  // uncaughtException — the daemon's uncaughtException handler treats three
  // repeats as fatal and shuts the whole daemon down, killing every other
  // session as collateral damage. Per-step isolation ensures one session's
  // exit can't cascade into a mass kill.
  sessionManager.on('session:died', (payload: { id: string; exitCode: number | null; signal?: number; cmd?: string; lastActivityMsAgo?: number; reason?: string }) => {
    // OBSERVABILITY: PTY deaths were previously unlogged — a session could
    // vanish (e.g. powershell exiting -1 under a TUI like claude) with zero
    // trace in the daemon log, making root-cause impossible. Log the forensics
    // on every death. Read it as: NO preceding `destroySession` log for this id
    // ⇒ the process exited on its own (exitCode/signal say why); a
    // `destroySession` log just before ⇒ wmux killed it.
    log('info', `[lifecycle] session:died id=${payload.id} reason=${payload.reason ?? 'pty-exit'} exitCode=${payload.exitCode ?? 'null'} signal=${payload.signal ?? 'none'} cmd=${payload.cmd ?? '?'} idleMsBeforeExit=${payload.lastActivityMsAgo ?? '?'} liveTotal=${sessionManager.listSessions().length}`);
    recoveredAgentShellIds.delete(payload.id); // X6 ②: drop a stale resume hint
    recoveredResumeBindings.delete(payload.id); // X6 ③: ...and its exact binding (id reuse, CodeRabbit)
    try {
      const event: DaemonEvent = {
        type: 'session.died',
        sessionId: payload.id,
        data: { exitCode: payload.exitCode },
      };
      pipeServer.broadcast(event);
    } catch (err) {
      log('warn', `session:died broadcast failed for ${payload.id}:`, err);
    }

    // Remove data listener to prevent leak
    try {
      const tracked = sessionDataListeners.get(payload.id);
      if (tracked) {
        tracked.bridge.removeListener('data', tracked.listener);
        sessionDataListeners.delete(payload.id);
      }
    } catch (err) {
      log('warn', `session:died data-listener cleanup failed for ${payload.id}:`, err);
    }

    // Clean up session pipe
    try {
      const pipe = sessionPipes.get(payload.id);
      if (pipe) {
        pipe.stop().catch(() => {});
        sessionPipes.delete(payload.id);
      }
    } catch (err) {
      log('warn', `session:died pipe stop failed for ${payload.id}:`, err);
    }

    // Stop process monitoring
    try {
      processMonitor.unwatch(payload.id);
    } catch (err) {
      log('warn', `session:died unwatch failed for ${payload.id}:`, err);
    }

    // Clean up buffer dump file — dead sessions don't need snapshots
    try {
      const bufPath = stateWriter.getBufferDumpPath(payload.id);
      if (fs.existsSync(bufPath)) fs.unlinkSync(bufPath);
    } catch { /* ignore */ }

    // Save state. This is the persistence anchor: even if every other step
    // failed above, the dead-state record still lands on disk so recovery
    // doesn't try to resurrect a process that's gone.
    try {
      const state = buildState(sessionManager);
      stateWriter.saveImmediate(state);
    } catch (err) {
      log('error', `session:died state save failed for ${payload.id}:`, err);
    }
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

  // Bridge-level events: forward agent/critical/idle/active from all sessions
  // to clients (main process). These are emitted by DaemonSessionManager
  // which re-emits bridge events.
  sessionManager.on('session:idle', (payload: { sessionId: string }) => {
    const event: DaemonEvent = {
      type: 'activity.idle',
      sessionId: payload.sessionId,
      data: null,
    };
    pipeServer.broadcast(event);
  });

  sessionManager.on('session:active', (payload: { sessionId: string; agentName?: string }) => {
    const event: DaemonEvent = {
      type: 'activity.active',
      sessionId: payload.sessionId,
      // gate로 확정된 에이전트 이름을 data에 실어 main으로 전달한다(없으면 null).
      // daemon mode running 상태에 agentName을 채우는 경로(local mode는
      // PTYBridge가 getLastAgent로 직접 처리).
      data: payload.agentName ?? null,
    };
    pipeServer.broadcast(event);
  });

  sessionManager.on('session:agent', (payload: { sessionId: string; event: { agent: string; status: string; message: string } }) => {
    // X6 Feature ②: record the detected agent SLUG on the session so a future
    // reboot knows this interactive pane was an agent. agentDisplayToSlug maps
    // the AgentDetector display name ('Claude Code') → canonical slug ('claude').
    const slug = agentDisplayToSlug(payload.event.agent);
    if (slug) {
      const managed = sessionManager.getSession(payload.sessionId);
      if (managed && managed.meta.lastDetectedAgent !== slug) {
        managed.meta.lastDetectedAgent = slug;
        // X6 ②: persist IMMEDIATELY, not debounced. lastDetectedAgent is the
        // SOLE basis for the post-reboot resume offer (resumeOfferForRecovered
        // reads it off the persisted session). A real OS reboot SIGKILLs the
        // daemon — flush()/process.on('exit') never run — so a 30s debounce
        // (or the periodic snapshot) can drop a fresh detection that has no
        // other state-changing event to opportunistically flush it. The
        // !== slug guard above bounds this to one sync write per agent
        // transition (effectively once per idle agent pane), so the cost is
        // negligible vs. the durability it buys.
        stateWriter.saveImmediate(buildState(sessionManager));
      }
      // The agent is live again → this pane is no longer a "resume me" shell.
      recoveredAgentShellIds.delete(payload.sessionId);
      recoveredResumeBindings.delete(payload.sessionId);
    }
    const event: DaemonEvent = {
      type: 'agent.event',
      sessionId: payload.sessionId,
      data: payload.event,
    };
    pipeServer.broadcast(event);
  });

  sessionManager.on('session:critical', (payload: { sessionId: string; event: { action: string; riskLevel: string } }) => {
    const event: DaemonEvent = {
      type: 'agent.critical',
      sessionId: payload.sessionId,
      data: payload.event,
    };
    pipeServer.broadcast(event);
  });

  // OSC 133 prompt/command markers — broadcast to main so
  // DaemonNotificationRouter can mirror the local-mode PTYBridge OSC 133
  // tee onto the EventBus as `source:'osc133'` agent.lifecycle events.
  // Daemon-side PromptEventLog remains the byte-offset authoritative log
  // used by `terminal_read_events`; this broadcast is a parallel projection
  // for workspaceId-scoped poll consumers.
  sessionManager.on('session:prompt', (payload: { sessionId: string; event: { type: string; ts: number; byteOffset: number; exitCode?: number } }) => {
    const event: DaemonEvent = {
      type: 'prompt.event',
      sessionId: payload.sessionId,
      data: payload.event,
    };
    pipeServer.broadcast(event);
  });

  // Desktop-notification sequences (OSC 9/777/99) parsed in the daemon
  // bridge. Broadcast so main can tee them onto the EventBus as
  // `notification.received` and drive toasts/badges — same projection
  // pattern as prompt.event above.
  sessionManager.on('session:notification', (payload: { sessionId: string; event: { source: string; title: string | null; body: string; ts: number } }) => {
    const event: DaemonEvent = {
      type: 'notification.event',
      sessionId: payload.sessionId,
      data: payload.event,
    };
    pipeServer.broadcast(event);
  });

  // Working-directory change (OSC 7 / prompt scrape, detected in the daemon
  // bridge). Broadcast so main can forward it to the renderer as
  // IPC.CWD_CHANGED, giving daemon-mode panes the same live per-surface cwd
  // the local path already had.
  sessionManager.on('session:cwd', (payload: { sessionId: string; cwd: string }) => {
    const event: DaemonEvent = {
      type: 'cwd.changed',
      sessionId: payload.sessionId,
      data: payload.cwd,
    };
    pipeServer.broadcast(event);
    // Persist the new cwd IMMEDIATELY. Recovery replays meta.cwd (the pane
    // respawns in it) AND the X6 ② resume pill pastes `claude --continue`,
    // which is cwd-scoped — so a cwd lost to the reboot window would restore
    // the pane to a stale directory and resume the wrong (or no) conversation.
    // The bridge-level change-guard (DaemonSessionManager 'cwd' handler) means
    // this only fires on an actual cd, so the immediate write stays cheap.
    stateWriter.saveImmediate(buildState(sessionManager));
  });

  // Window-title change (OSC 0/2, detected in the daemon bridge). Broadcast so
  // main can forward it to the renderer as IPC.TERMINAL_TITLE_CHANGED — same
  // shape as cwd.changed above.
  sessionManager.on('session:title', (payload: { sessionId: string; title: string }) => {
    const event: DaemonEvent = {
      type: 'title.changed',
      sessionId: payload.sessionId,
      data: payload.title,
    };
    pipeServer.broadcast(event);
  });

  // Explicit destroy (pty:dispose path): distinct from session:died (natural
  // PTY exit). Both must clear the main-side agentStatus so the sidebar dot
  // doesn't lie about a closed terminal (Codex P2).
  sessionManager.on('session:destroyed', (payload: { id: string }) => {
    recoveredAgentShellIds.delete(payload.id); // X6 ②: drop hint on explicit close too (CodeRabbit #2)
    recoveredResumeBindings.delete(payload.id); // X6 ③: drop the exact binding too (id reuse, CodeRabbit)
    const event: DaemonEvent = {
      type: 'session.destroyed',
      sessionId: payload.id,
      data: null,
    };
    pipeServer.broadcast(event);
  });
}

// === X1 workspace-context watchers (schema-freeze §2) ===

/**
 * Wire the per-session git-branch watcher (fs.watch on .git/HEAD, no
 * polling) and the PID-tree→listening-port watcher (10 s interval) to the
 * DaemonEvent broadcast channel. Returns a dispose function consumed by
 * shutdown().
 *
 * Lifecycle:
 *  - session:created → start tracking the session's cwd + pid
 *  - session:cwd     → re-resolve the repo for the new cwd
 *  - session:died / session:destroyed → drop the session's watcher state
 *    (PortWatcher self-prunes via the listLiveSessions provider)
 */
function wireContextWatchers(
  sessionManager: DaemonSessionManager,
  pipeServer: DaemonPipeServer,
): () => void {
  const gitWatcher = new GitContextWatcher();
  const portWatcher = new PortWatcher(() =>
    sessionManager.listLiveSessions().map((s) => ({ sessionId: s.id, pid: s.pid })),
  );

  gitWatcher.on('git', (payload: { sessionId: string; branch: string | null; isWorktree: boolean }) => {
    try {
      const event: DaemonEvent = {
        type: 'context.git',
        sessionId: payload.sessionId,
        data: { branch: payload.branch, isWorktree: payload.isWorktree },
      };
      pipeServer.broadcast(event);
    } catch (err) {
      log('warn', `context.git broadcast failed for ${payload.sessionId}:`, err);
    }
  });

  portWatcher.on('ports', (payload: { sessionId: string; ports: Array<{ port: number; pid: number }> }) => {
    try {
      const event: DaemonEvent = {
        type: 'context.ports',
        sessionId: payload.sessionId,
        data: { ports: payload.ports },
      };
      pipeServer.broadcast(event);
    } catch (err) {
      log('warn', `context.ports broadcast failed for ${payload.sessionId}:`, err);
    }
  });

  const onCreated = (payload: { session: { id: string; cwd: string } }) => {
    gitWatcher.update(payload.session.id, payload.session.cwd);
  };
  const onCwd = (payload: { sessionId: string; cwd: string }) => {
    gitWatcher.update(payload.sessionId, payload.cwd);
  };
  const onGone = (payload: { id: string }) => {
    gitWatcher.remove(payload.id);
  };
  sessionManager.on('session:created', onCreated);
  sessionManager.on('session:cwd', onCwd);
  sessionManager.on('session:died', onGone);
  sessionManager.on('session:destroyed', onGone);

  portWatcher.start();

  // Seed git context for sessions recovered before this wiring ran.
  for (const s of sessionManager.listLiveSessions()) {
    gitWatcher.update(s.id, s.cwd);
  }

  return () => {
    sessionManager.off('session:created', onCreated);
    sessionManager.off('session:cwd', onCwd);
    sessionManager.off('session:died', onGone);
    sessionManager.off('session:destroyed', onGone);
    portWatcher.stop();
    gitWatcher.dispose();
  };
}

/** Set in main(); consumed by shutdown(). */
let disposeContextWatchers: (() => void) | null = null;

/** X8: set in main(); shutdown() cancels pending supervised restarts through it. */
let paneSupervisorRef: PaneSupervisor | null = null;
// Module-level so the standalone shutdown() can dispose the LanLink listener
// (close the net.Server, drop live connections, remove the firewall rules).
let lanLinkServerRef: LanLinkServer | null = null;

// === State builder ===

/** Cached boot ID — populated at startup via initBootId() */
let cachedBootId: string | undefined;

/** Initialize the cached boot ID (call once at startup). */
async function initBootId(): Promise<void> {
  cachedBootId = await getBootId();
}

function buildState(sessionManager: DaemonSessionManager): DaemonState {
  // cachedBootId is initialized in main() before any calls to buildState.
  // Fallback to sync version only if somehow not initialized.
  if (!cachedBootId) cachedBootId = getBootIdSync();
  return {
    version: 1,
    sessions: sessionManager.listSessions(),
    bootId: cachedBootId,
  };
}

// Phase A — A1b snapshot runner lives in ./snapshotRunner so the unit tests
// can import it without triggering main() at the bottom of this file.

// === Graceful shutdown ===

let shuttingDown = false;
// Phase A — A4. Flipped to true once the async shutdown body has resolved
// every Promise from ringBuffer.dumpToFile(). The Windows process.on('exit')
// sync fallback consults this flag: if dumps already completed it skips
// (avoiding duplicate writes), otherwise it runs dumpToFileSyncAtomic for
// every live session as a last-resort save. Replaces a broader
// `if (shuttingDown) return` guard that would have skipped the sync save
// even when the async path was interrupted mid-dump.
let dumpsCompleted = false;

async function shutdown(
  signal: string,
  sessionManager: DaemonSessionManager,
  pipeServer: DaemonPipeServer,
  stateWriter: StateWriter,
  channelStateWriter: ChannelStateWriter,
  sessionPipes: Map<string, SessionPipe>,
  processMonitor: ProcessMonitor,
  watchdog: Watchdog,
  opts: { skipPipeStop?: boolean; skipExit?: boolean } = {},
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

  // Phase-level latency instrumentation. The 4 s race budget on the main
  // side (BEFORE_QUIT_TIMEOUT_MS) is regularly exceeded on a 48-PTY daemon
  // (user dogfood 2026-05-16/17). Without per-phase timing we can only
  // guess at which step dominates: pipe drain, buffer dump fanout,
  // state save, or serial PTY kill. These logs make the budget call
  // empirical instead of a guess.
  const shutdownStartedAt = Date.now();
  const phaseStartedAt = (): number => Date.now();
  const phaseLog = (name: string, startedAt: number, extra?: Record<string, unknown>): void => {
    const elapsedMs = Date.now() - startedAt;
    const totalMs = Date.now() - shutdownStartedAt;
    const extraStr = extra ? ' ' + JSON.stringify(extra) : '';
    log('info', `[shutdown.phase] ${name} elapsed=${elapsedMs}ms total=${totalMs}ms${extraStr}`);
  };

  // Stop watchdog
  watchdog.stop();

  // X8: cancel pending supervised restarts FIRST — a backoff timer firing
  // mid-shutdown would spawn a fresh PTY between the buffer dump and
  // disposeAll. Policies stay persisted on the session meta; recovery
  // re-arms them on the next boot.
  try { paneSupervisorRef?.dispose(); } catch { /* best effort */ }

  // LanLink PR-4: close the listener, drop live AEAD connections, remove firewall
  // rules. Best-effort — must never block the shutdown path.
  try { lanLinkServerRef?.dispose(); } catch { /* best effort */ }
  paneSupervisorRef = null;

  // Stop X1 context watchers (port poll timer + git fs.watch handles)
  try { disposeContextWatchers?.(); } catch { /* best effort */ }
  disposeContextWatchers = null;

  // Stop process monitor
  processMonitor.unwatchAll();

  // Clean up all session pipes
  const pipeStopsStart = phaseStartedAt();
  const pipeStops = Array.from(sessionPipes.values()).map((pipe) =>
    pipe.stop().catch(() => {}),
  );
  await Promise.all(pipeStops);
  sessionPipes.clear();
  phaseLog('pipeStops', pipeStopsStart, { count: pipeStops.length });

  // Dump scrollback buffers and mark live sessions as suspended for recovery
  const managedSessions = sessionManager.listManagedSessions();
  stateWriter.ensureBufferDir();

  const dumpsStart = phaseStartedAt();
  const dumpPromises: Promise<void>[] = [];
  for (const managed of managedSessions) {
    if (managed.meta.state === 'dead') continue;

    const dumpPath = stateWriter.getBufferDumpPath(managed.meta.id);
    const sizeAtDump = managed.ringBuffer.size;
    dumpPromises.push(
      managed.ringBuffer.dumpToFile(dumpPath).then(() => {
        managed.meta.state = 'suspended';
        managed.meta.bufferDumpPath = dumpPath;
        log('info', `Suspended session ${managed.meta.id} (buffer: ${sizeAtDump} bytes)`);
      }).catch((err) => {
        log('warn', `Failed to dump buffer for ${managed.meta.id}:`, err);
        managed.meta.state = 'dead';
      }),
    );
  }
  await Promise.all(dumpPromises);
  // A4 — async dumps are durable. Sync exit handler will short-circuit.
  dumpsCompleted = true;
  phaseLog('bufferDumps', dumpsStart, { count: dumpPromises.length });

  // Save suspended state BEFORE disposing
  if (!cachedBootId) cachedBootId = await getBootId();
  const stateSaveStart = phaseStartedAt();
  const suspendState: DaemonState = {
    version: 1,
    sessions: managedSessions.map((m) => ({ ...m.meta })),
    bootId: cachedBootId,
  };
  stateWriter.saveImmediate(suspendState);
  phaseLog('stateSave', stateSaveStart, { sessions: managedSessions.length });

  // Dispose all sessions (kills PTYs, clears map)
  const disposeStart = phaseStartedAt();
  const disposedCount = sessionManager.listManagedSessions().length;
  sessionManager.disposeAll();
  phaseLog('disposeAll', disposeStart, { count: disposedCount });

  stateWriter.dispose();
  channelStateWriter.dispose();

  // Stop IPC server — skipped when the caller (e.g., daemon.shutdown RPC)
  // still needs the pipe to flush its ack.
  if (!opts.skipPipeStop) {
    const pipeServerStopStart = phaseStartedAt();
    await pipeServer.stop().catch(() => {});
    phaseLog('pipeServerStop', pipeServerStopStart);
  }

  releaseLock();
  log('info', `Daemon stopped (total shutdown ${Date.now() - shutdownStartedAt}ms)`);

  // Clear the hard-timeout guard now that shutdown has reached its end.
  // Without this, the timer would still fire after a skipExit deferral if
  // the macrotask was delayed under load.
  clearTimeout(shutdownTimeout);

  if (opts.skipExit) {
    // Caller (RPC handler) will fire setImmediate(() => process.exit(0))
    // after returning so the ack flushes back to the client first.
    return;
  }
  process.exit(0);
}

// === Main entry point ===

async function main(): Promise<void> {
  const startTime = Date.now();
  markDaemonBoot('main-start');
  log('info', `wmux-daemon starting (PID ${process.pid})`);

  // 1. Single-instance check
  if (!(await acquireLock())) {
    process.exit(1);
  }
  markDaemonBoot('lock-acquired');

  // Cache boot ID early (async) so buildState() never needs to block
  await initBootId();
  markDaemonBoot('bootid-done');

  // 2. Load configuration
  const config = loadConfig();
  markDaemonBoot('config-loaded');
  log('info', `Config loaded (logLevel=${config.daemon.logLevel})`);

  // 3. Initialize modules
  // Thread the configured suspended-tombstone TTL into the authoritative
  // StateWriter (codex #2). The acquireLock() one-shot above runs pre-config
  // and only reads bootId, so the default there is harmless.
  const stateWriter = new StateWriter(wmuxDir, config.session.suspendedTtlHours);
  // LanLink PR-2 — durable inbound inbox (remote peer messages). Daemon-owned
  // so it survives main/renderer death (C3). Lives next to sessions.json under
  // the same suffix-aware wmuxDir; every append is synchronous + fsync'd.
  const lanLinkInbox = new LanLinkInbox(wmuxDir);
  // LanLink PR-3 — control-plane state (enable toggle + NIC selection). Mutates
  // config.lanlink IN PLACE on the boot `config` object (so every holder of that
  // reference sees it) + persists via saveConfig, and emits 'changed' — the seam
  // a future in-daemon LAN listener (PR-4) subscribes to. PR-3 builds no listener.
  const lanLinkController = new LanLinkController({ config, persist: saveConfig });
  // A4 — sweep tmp dumps left behind by a previous crash. They are safe to
  // delete: tmp files only exist between the write and rename steps of an
  // atomic dump, so any tmp on disk now is from a daemon that died before
  // the rename completed. The .buf at the same path is either intact (old
  // good dump) or absent (first dump never finished, scrollback lost for
  // that session, which we cannot recover anyway).
  RingBuffer.cleanupStaleTmpFiles(stateWriter.getBufferDir());

  const sessionManager = new DaemonSessionManager();
  sessionManager.setConfig(config);
  const pipeServer = new DaemonPipeServer(config.daemon.pipeName);
  // Channels (a2a-channels U3). Channels live in their own file
  // (`channels.json`, see ChannelStateWriter doc) so a channel-loss event
  // cannot cascade into session-state failure. The service receives
  // `pipeServer.broadcast` as its emit sink so a successful post is
  // fanned out to every connected client before the next RPC turn.
  // Company id is the shared `DEFAULT_COMPANY_ID` until the company-mode
  // config key lands; the channel state format already supports
  // multi-company, so this is a single line to swap. The renderer uses the
  // SAME constant when it has no in-app Company, so optimistic rows and the
  // daemon's authoritative rows share one companyId.
  const channelStateWriter = new ChannelStateWriter(wmuxDir);
  const channelService = new ChannelService({
    writer: channelStateWriter,
    companyId: DEFAULT_COMPANY_ID,
    // U5 archive-authz (KTD-F): the CEO override is gated on this field.
    // The renderer owns `Company.ceoWorkspaceId` today; the daemon does
    // not have a copy, so we pass `undefined` (creator-only archive)
    // until the company-mode config key lands. The gate in
    // `ChannelService.archive()` is already wired and will activate
    // automatically once a real value is plumbed in.
    ceoWorkspaceId: undefined,
    emit: (event) => {
      // Wrap the ChannelMessageEvent in the canonical DaemonEvent envelope
      // before broadcasting on the control pipe. The helper lives in
      // `src/daemon/channels/channelEventEnvelope.ts` and is unit tested
      // for shape stability — the prior producer emitted a raw event,
      // which the main-side consumer never matched, silently dropping
      // every channel.message fan-out (plan R2).
      try {
        if (event.type === 'channel.catalog') {
          // A1 — catalog/membership lifecycle rides the same bridge as a posted
          // message; the main-side DaemonClient switch routes each by `type`.
          pipeServer.broadcast(wrapChannelCatalogEnvelope(event));
        } else {
          pipeServer.broadcast(wrapChannelMessageEnvelope(event));
        }
      } catch (err) {
        const ref = event.type === 'channel.catalog' ? event.channelId : `${event.channelId}#${event.seq}`;
        log('warn', `channel emit failed for ${ref}:`, err);
      }
    },
  });
  const processMonitor = new ProcessMonitor();

  // LanLink PR-4 — the network surface. An ISOLATED net.Server (its OWN admission
  // counters, never the control pipe's = G1) bound to the configured NIC, with
  // PIN-EKE pairing + AEAD + an allow-list router. `enabled` defaults OFF, so a
  // listener exists only after the user opts in via Settings. Inbound messages
  // decode -> sanitize -> LanLinkInbox.append (the PR-2 durable inbox) -> the SAME
  // `lanlink.remote.received` nudge the dev __lanlink.inject fires. execute is
  // physically impossible — the daemon imports 0 of the execute machinery
  // (daemonExecuteWall.test.ts). The peer store's live-eviction guard reads back
  // through the server lazily, to break the construction cycle.
  const lanLinkPeers = new PeerStore(wmuxDir, {
    isLive: (uuid) => lanLinkServerRef?.hasLiveConn(uuid) ?? false,
  });
  const lanLinkServer = new LanLinkServer({
    inbox: lanLinkInbox,
    controller: lanLinkController,
    peers: lanLinkPeers,
    selfName: os.hostname(),
    nudge: (seq) =>
      pipeServer.broadcast({
        type: 'lanlink.remote.received',
        sessionId: LANLINK_SENTINEL_SESSION_ID,
        data: { seq },
      }),
  });
  lanLinkServerRef = lanLinkServer;

  // Idle-shutdown config. Defaults: 5 min idle window + 60 s grace.
  // `WMUX_IDLE_SHUTDOWN_MS` and `WMUX_IDLE_GRACE_MS` env vars override
  // both — the dynamic test (scripts/daemon-idle-shutdown-dynamic.mjs)
  // uses them to verify the self-terminate path in seconds instead of
  // waiting the production 6 minutes. Env overrides only apply when the
  // value parses to a finite positive number.
  const parsePositiveMs = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const idleEnvMs = parsePositiveMs(process.env.WMUX_IDLE_SHUTDOWN_MS);
  const graceEnvMs = parsePositiveMs(process.env.WMUX_IDLE_GRACE_MS);
  const configuredIdleMinutes = config.daemon.idleShutdownMinutes ?? 5;
  // Negative or non-finite config falls back to defaults; 0 = disabled.
  const safeConfigIdleMs = Number.isFinite(configuredIdleMinutes) && configuredIdleMinutes >= 0
    ? configuredIdleMinutes * 60_000
    : 5 * 60_000;
  const idleConfig = {
    idleTimeoutMs: idleEnvMs ?? safeConfigIdleMs,
    graceMs: graceEnvMs ?? 60_000,
    startTime,
  };
  // Watchdog tick interval — production stays at 30s. The dynamic test
  // (scripts/daemon-idle-shutdown-dynamic.mjs) drops this so it doesn't
  // have to wait a full tick after the idle window elapses.
  const watchdogTickMs = parsePositiveMs(process.env.WMUX_WATCHDOG_TICK_MS) ?? 30000;
  const watchdog = new Watchdog(watchdogTickMs, idleConfig, {
    warnMb: config.daemon.memWarnMb,
    reapMb: config.daemon.memReapMb,
    blockMb: config.daemon.memBlockMb,
  });
  const sessionPipes = new Map<string, SessionPipe>();
  const sessionDataListeners = new Map<string, { bridge: import('./DaemonPTYBridge').DaemonPTYBridge; listener: (data: Buffer) => void }>();

  // Forward reference — initialised at step 8c after the snapshot runner is
  // wired. RPC handlers that fire before initialisation simply skip the
  // immediate snapshot; the 30 s interval will still cover them.
  let runSnapshotOnceRef: (() => Promise<void>) | null = null;

  // 4. Recover previous sessions. Derive the recovery soft cap from the
  // configured session ceiling: min(maxSessions, 40). Capping at maxSessions
  // guarantees recovery never trips the createSession limit and dead-marks
  // the overflow — a freshly lowered maxSessions keeps the excess SUSPENDED
  // instead of destroying it (codex #4).
  // X8 pane supervisor — the daemon-side init system for supervised exec
  // panes. Created before recovery so recovered sessions can be re-armed.
  const paneSupervisor = new PaneSupervisor({
    restartSession: (id) => restartSupervisedSession(id, sessionManager, stateWriter, processMonitor),
    isSessionDead: (id) => {
      const m = sessionManager.getSession(id);
      return !m || m.meta.state === 'dead';
    },
    broadcast: (event) => {
      try {
        pipeServer.broadcast(event);
      } catch (err) {
        log('warn', `supervision broadcast failed for ${event.sessionId}:`, err);
      }
    },
    persistStatus: (id, status) => {
      const m = sessionManager.getSession(id);
      if (m?.meta.supervision) m.meta.supervision.status = status;
      try {
        stateWriter.saveImmediate(buildState(sessionManager));
      } catch (err) {
        log('warn', `supervision status persist failed for ${id}:`, err);
      }
    },
    log: (level, msg) => log(level, msg),
  });
  paneSupervisorRef = paneSupervisor;

  const maxRecover = Math.min(config.session.maxSessions, MAX_RECOVER_SESSIONS);
  await recoverSessions(stateWriter, sessionManager, processMonitor, maxRecover);
  markDaemonBoot('recovery-done');

  // X6 ③ (Rung 3): recoverSessions drains the hook spool once at boot (the reboot
  // headline). Also drain on a low-frequency timer so a capture spooled while the
  // MAIN process was restarting — but the daemon stayed alive (dev HMR, a main
  // crash) — is reconciled within the interval instead of waiting for the next
  // reboot. ingestResumeSpool is a no-op (single readdir, no write) when the spool
  // dir is empty, so the steady-state cost is negligible. Unref'd: never holds the
  // process open.
  const RESUME_SPOOL_DRAIN_INTERVAL_MS = 60_000;
  const resumeSpoolTimer = setInterval(() => {
    try {
      ingestResumeSpool(sessionManager, stateWriter);
    } catch (err) {
      log('warn', 'resume-spool drain failed:', err);
    }
  }, RESUME_SPOOL_DRAIN_INTERVAL_MS);
  resumeSpoolTimer.unref?.();

  // X8: re-arm supervision for recovered sessions. The policy + sticky
  // status live on the persisted meta, so this is a pure replay — a
  // runaway-guard 'stopped' comes back stopped (badge + manual rearm only),
  // an 'armed' loop resumes supervision exactly where the reboot cut it.
  for (const s of sessionManager.listLiveSessions()) {
    if (s.supervision) {
      paneSupervisor.arm(
        s.id,
        { restart: s.supervision.restart, limit: s.supervision.limit },
        s.supervision.status,
      );
    }
  }

  // 5. Register RPC handlers
  registerRpcHandlers(
    pipeServer,
    sessionManager,
    stateWriter,
    lanLinkInbox,
    lanLinkController,
    lanLinkServer,
    channelStateWriter,
    sessionPipes,
    processMonitor,
    startTime,
    sessionDataListeners,
    watchdog,
    paneSupervisor,
    () => {
      if (runSnapshotOnceRef) void runSnapshotOnceRef();
    },
    channelService,
  );

  // 6. Wire events
  wireEvents(sessionManager, pipeServer, stateWriter, sessionPipes, processMonitor, sessionDataListeners);

  // 6b-X8. Supervisor lifecycle hooks. `session:died` = the PTY exited on
  // its own → policy evaluation. `session:destroyed` = the USER closed the
  // pane (destroySession disposes the exit listener before killing, so died
  // never fires for it) → disarm, cancelling any backoff-pending restart.
  // The supervisor's own restarts bypass destroySession (removeTombstone),
  // so neither hook ever fires for a supervised restart itself.
  sessionManager.on('session:died', (payload: { id: string; exitCode: number | null; signal?: number }) => {
    try {
      paneSupervisor.onSessionDied({ id: payload.id, exitCode: payload.exitCode, signal: payload.signal });
    } catch (err) {
      log('error', `supervisor onSessionDied failed for ${payload.id}:`, err);
    }
  });
  sessionManager.on('session:destroyed', (payload: { id: string }) => {
    try {
      paneSupervisor.disarm(payload.id);
    } catch (err) {
      log('warn', `supervisor disarm failed for ${payload.id}:`, err);
    }
  });

  // 6b. X1 workspace-context watchers (git HEAD fs.watch + PID-tree ports)
  disposeContextWatchers = wireContextWatchers(sessionManager, pipeServer);

  // 7. Start control pipe
  markDaemonBoot('pre-pipe-start');
  await pipeServer.start();
  markDaemonBoot('pipe-listening');

  // Write active pipe name so clients know which pipe to connect to
  const activePipeName = pipeServer.getActivePipeName();
  const pipeNameFile = path.join(wmuxDir, 'daemon-pipe');
  try {
    fs.writeFileSync(pipeNameFile, activePipeName, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    log('warn', 'Failed to write pipe name file:', err);
  }
  markDaemonBoot('pipe-file-written');

  // doShutdown is hoisted ahead of `setCallbacks` so the idle-shutdown
  // callback can route through the same termination path used by
  // SIGTERM/SIGINT/daemon.shutdown — referenced from within the
  // Watchdog tick (always runs after this point in the boot order).
  const doShutdown = (sig: string): Promise<void> =>
    shutdown(sig, sessionManager, pipeServer, stateWriter, channelStateWriter, sessionPipes, processMonitor, watchdog);

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
    // Idle snapshot: how Watchdog sees the daemon's "is anyone using me?"
    // signals. connections is the live wmux main + any MCP clients that
    // sit directly on the daemon pipe (currently none — MCP routes via
    // main). sessions = LIVE PTY count only — listLiveSessions() filters
    // out `dead` (PTY exited, retained for scrollback until the 24h
    // reap fires) and `suspended` (recovery cap-skipped, no PTY behind
    // the metadata). Without that filter, a daemon whose only remaining
    // sessions are tombstones would stay alive for up to 24 hours past
    // the user closing every pane. lastDisconnectAt anchors the idle
    // window; see DaemonPipeServer.getLastDisconnectAt for the 0-edge
    // stamping rule.
    onIdleCheck: () => ({
      connections: pipeServer.getConnectionCount(),
      sessions: sessionManager.listLiveSessions().length,
      lastDisconnectAt: pipeServer.getLastDisconnectAt(),
    }),
    // Idle self-terminate. Routes through the same shutdown() path used
    // by SIGTERM / SIGINT / daemon.shutdown RPC — the `shuttingDown`
    // re-entry guard at index.ts top-level protects against a racing
    // signal arriving while we're already on our way out.
    onIdleShutdown: (idleMs) => {
      log('info', `[shutdown.phase] idle.timeout idleMs=${idleMs} cfgMs=${idleConfig.idleTimeoutMs}`);
      void doShutdown('idle.timeout');
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
  // Also save sessions.json so recovery has up-to-date session metadata.
  // Sequential dumps to avoid simultaneous memory peaks from all buffers at once.
  // The runner is also invoked once immediately below (A1b) to close the
  // 30 s window where no .buf exists yet on disk.
  const runSnapshotOnce = createSnapshotRunner(sessionManager, stateWriter, {
    getBootId: () => {
      if (!cachedBootId) cachedBootId = getBootIdSync();
      return cachedBootId;
    },
  });
  runSnapshotOnceRef = runSnapshotOnce;
  const snapshotInterval = setInterval(() => {
    void runSnapshotOnce();
  }, 30_000);
  snapshotInterval.unref();

  // A1b — fire an initial snapshot at spawn so a crash within the first
  // 30 s leaves a recoverable .buf trace rather than nothing.
  void runSnapshotOnce();

  // 9. Signal handlers — doShutdown was hoisted above setCallbacks so
  // the idle-shutdown callback can reuse it.
  process.on('SIGTERM', () => doShutdown('SIGTERM'));
  process.on('SIGINT', () => doShutdown('SIGINT'));

  // Windows-specific: handle OS shutdown/logoff/restart.
  // Detached Node processes on Windows don't receive SIGTERM on shutdown.
  // 'beforeExit' won't fire either. We use the 'exit' event as a last-resort
  // synchronous save, and also periodic state saves to minimize data loss.
  if (process.platform === 'win32') {
    process.on('exit', () => {
      // Phase A — A4. Precise guard: skip the sync save only if the async
      // shutdown body actually finished its dumps. If the async path was
      // interrupted mid-dump (process about to die), fall through and run
      // the sync atomic save as a last-resort.
      if (dumpsCompleted) return;
      // Synchronous-only — dump what we can before process dies.
      try {
        const managed = sessionManager.listManagedSessions();
        stateWriter.ensureBufferDir();
        for (const m of managed) {
          if (m.meta.state === 'dead') continue;
          const dumpPath = stateWriter.getBufferDumpPath(m.meta.id);
          try {
            // A4 — atomic sync write: tmp + renameSync so a reader can
            // never observe a half-written .buf, even if the OS pulls the
            // plug mid-write. Replaces the bare writeFileSync that left a
            // partial file behind on power loss.
            m.ringBuffer.dumpToFileSyncAtomic(dumpPath);
            m.meta.state = 'suspended';
            m.meta.bufferDumpPath = dumpPath;
          } catch { /* best effort */ }
        }
        if (!cachedBootId) cachedBootId = getBootIdSync();
        const suspendState: DaemonState = {
          version: 1,
          sessions: managed.map((m) => ({ ...m.meta })),
          bootId: cachedBootId,
        };
        stateWriter.saveImmediate(suspendState);
      } catch { /* best effort */ }
    });
  }

  // 10. Uncaught error handlers — with resilience for recoverable errors
  const FATAL_CODES = new Set(['ENOMEM', 'ENOSPC', 'ERR_OUT_OF_RANGE']);
  const uncaughtErrorCounts = new Map<string, number[]>();
  const UNCAUGHT_WINDOW_MS = 30_000;
  const UNCAUGHT_THRESHOLD = 3;
  const MAX_TRACKED_ERRORS = 50;

  process.on('uncaughtException', (err) => {
    log('error', 'Uncaught exception:', err);

    // Fatal system errors — shutdown immediately
    const code = (err as NodeJS.ErrnoException).code;
    if (code && FATAL_CODES.has(code)) {
      log('error', `Fatal error code ${code} — shutting down immediately`);
      doShutdown('uncaughtException');
      return;
    }

    const now = Date.now();
    const errKey = (err.message || String(err)).slice(0, 200);

    let timestamps = uncaughtErrorCounts.get(errKey);
    if (!timestamps) {
      if (uncaughtErrorCounts.size >= MAX_TRACKED_ERRORS) {
        const oldest = uncaughtErrorCounts.keys().next().value!;
        uncaughtErrorCounts.delete(oldest);
      }
      timestamps = [];
      uncaughtErrorCounts.set(errKey, timestamps);
    }
    timestamps.push(now);

    // Prune old timestamps for this error
    while (timestamps.length > 0 && timestamps[0] < now - UNCAUGHT_WINDOW_MS) {
      timestamps.shift();
    }

    if (timestamps.length >= UNCAUGHT_THRESHOLD) {
      log('error', `Same uncaught exception repeated ${timestamps.length} times in ${UNCAUGHT_WINDOW_MS / 1000}s — shutting down`);
      doShutdown('uncaughtException');
    }
  });
  process.on('unhandledRejection', (reason) => {
    log('error', 'Unhandled rejection:', reason);
  });

  markDaemonBoot('ready');
  log('info', `Daemon ready — pipe: ${activePipeName}`);
  // Boot summary for postmortems. nodeTiming gives the Node/V8 startup split
  // for free (all values are ms relative to nodeTiming's own timeOrigin).
  try {
    const nt = nodePerformance.nodeTiming;
    log('info', `[boot-trace] summary=${JSON.stringify({
      jsStartEpochMs: DAEMON_BOOT.jsStartEpochMs,
      marks: DAEMON_BOOT.marks,
      nodeTiming: { nodeStart: nt.nodeStart, v8Start: nt.v8Start, bootstrapComplete: nt.bootstrapComplete, environment: nt.environment },
    })}`);
  } catch { /* tracing must never break boot */ }
}

main().catch((err) => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EDAEMON_ALREADY_RUNNING') {
    // Another LIVE daemon already owns the canonical control pipe — we are a
    // redundant second daemon the launcher spawned over a daemon it failed to
    // detect (split-brain Defect 3 / Step ③). Exit with a DISTINCT code so the
    // launcher reconnects to the existing daemon instead of treating this as a
    // generic startup failure. releaseLock() clears the daemon.pid that
    // acquireLock() wrote for us; the launcher reconnects via the canonical
    // pipe name, not the pid file.
    log('warn', 'another live daemon owns the control pipe — exiting cleanly (EDAEMON_ALREADY_RUNNING)');
    releaseLock();
    process.exit(DAEMON_EXIT_ALREADY_RUNNING);
  }
  log('error', 'Fatal error during startup:', err);
  releaseLock();
  process.exit(1);
});
