import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, getWmuxDir } from './config';
import { DaemonSessionManager } from './DaemonSessionManager';
import { PaneSupervisor } from './PaneSupervisor';
import { DaemonPipeServer } from './DaemonPipeServer';
import { SessionPipe } from './SessionPipe';
import { generateSnapshot, generateSnapshotUnqueued, enqueueSnapshotJob } from './HeadlessSnapshot';
import { StateWriter, scrubPersistedCredentials } from './StateWriter';
import { stripCredentialValues } from '../shared/envFilter';
import { LanLinkInbox } from './lanlink/inbox';
import { LanLinkController } from './lanlink/controller';
import { LanLinkServer } from './lanlink/server';
import { PeerStore } from './lanlink/peers';
import { coerceLanLinkPatch } from '../shared/lanlink';
import { ChannelService, ChannelStateWriter, ChannelWakeWorker, wrapChannelMessageEnvelope, wrapChannelCatalogEnvelope, stampChannelCaller, type CallerFieldSpec, type ChannelServiceEventLog } from './channels';
import { AppendOnlyLog } from './eventlog/AppendOnlyLog';
import { SnapshotStore, SNAPSHOT_DIRNAME } from './eventlog/SnapshotStore';
import { manifestFileExists, pingFormatVersionField } from './eventlog/EventLogManifest';
import { runMigration, evaluateWatermark, performReseed, stampWatermark } from './eventlog/migrateToEventLog';
import { PrincipalService, PrincipalStateWriter } from './principals';
import { isPrincipalUpsertInput } from '../shared/principals';
import { DEFAULT_COMPANY_ID, CHANNELS_EPOCH } from '../shared/channels';
// envelope PR4 (§5 D11): A2A 태스크 정본을 렌더러 인메모리에서 데몬 이벤트 로그로.
// (로그·machineId는 채널 부트 게이트 산출물 공유 — 별도 개방 금지.)
import { A2aTaskService, type CreateTaskInput } from './a2a/A2aTaskService';
import { WorkTaskService } from './worktask/WorkTaskService';
import { isTaskState, type Message } from '../shared/types';
import { ProcessMonitor } from './ProcessMonitor';
import { Watchdog } from './Watchdog';
import { selectRecoverableSessions } from './recoverySelector';
import { isShutdownKillExit, SHUTDOWN_KILL_RECLASSIFY_MS } from './shutdownKill';
import { createSnapshotRunner } from './snapshotRunner';
import { RingBuffer } from './RingBuffer';
import { GitContextWatcher } from '../main/pty/gitContextWatch';
import { PortWatcher } from '../main/pty/portWatch';
import { initDaemonLogSink } from './util/logSink';
import type { DaemonState } from './types';
import type { DaemonEvent, DaemonCreateSessionParams, DaemonSessionIdParams, DaemonResizeParams, DaemonSetResumeBindingParams } from '../shared/rpc';
import { monitorEventLoopDelay, performance as nodePerformance } from 'node:perf_hooks';
import { DAEMON_EXIT_ALREADY_RUNNING, ENV_KEYS } from '../shared/constants';
import { toResumeCommand, resumeOfferForRecovered, mergeResumeBinding, normalizeResumeCwd } from '../shared/agentResume';
import type { ResumeBinding } from '../shared/agentResume';
import { agentDisplayToSlug } from '../main/pty/AgentDetector';
import type { AgentSlug } from '../shared/events';
import { LANLINK_SENTINEL_SESSION_ID } from '../shared/lanlink';
import { classifyTasklistOutput, classifyKillOutcome, lockOwnerIsReclaimable, type ProcessLiveness } from '../shared/processLiveness';

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
  'claude', 'codex', 'gemini', 'aider', 'opencode', 'copilot', 'openclaude',
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

// B′ daemon auto-replace: the app version that spawned this process, captured
// once at load from the env the launcher injects unconditionally. The sentinel
// 'unknown' is load-bearing: a B′-era daemon ALWAYS echoes SOMETHING in
// daemon.ping, so a ping response with no `spawnedByVersion` field at all is a
// positive confirmation of pre-B′ daemon code (replace-safe), while 'unknown'
// means "B′ code but spawn path unclear" (information absence — never treated
// as older; the gate falls back to the stale banner instead of destruction).
const SPAWNED_BY_VERSION: string =
  process.env[ENV_KEYS.SPAWNED_BY_VERSION] || 'unknown';

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

// === Logging (console + durable file) ===
// The daemon is spawned with stdio:'ignore' (see src/main/daemon/launcher.ts),
// so console output is discarded on EVERY platform — there is no way to see
// what a running daemon did after the fact. Mirror every line to a rotating
// file so post-hoc debugging is possible; the recovery decisions taken right
// after an OS reboot are the case this exists for. Best-effort: a logging
// failure must never crash the daemon.
const DAEMON_LOG_PATH = path.join(wmuxDir, 'daemon.log');
const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate at 5 MB, keep one .1 backup
// In-memory byte counter so we don't statSync on every write. -1 = uninitialised
// (seeded from the existing file size on the first line this process writes).
let daemonLogBytes = -1;
function log(level: string, msg: string, ...args: unknown[]): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [daemon/${level}] ${msg}`, ...args);
  try {
    const extra = args.length
      ? ' ' + args
          .map((a) => {
            if (a instanceof Error) return a.stack ?? a.message;
            if (typeof a === 'object' && a !== null) {
              try { return JSON.stringify(a); } catch { return String(a); }
            }
            return String(a);
          })
          .join(' ')
      : '';
    const line = `[${ts}] [daemon/${level}] ${msg}${extra}\n`;
    if (daemonLogBytes < 0) {
      try { daemonLogBytes = fs.statSync(DAEMON_LOG_PATH).size; } catch { daemonLogBytes = 0; }
    }
    if (daemonLogBytes > DAEMON_LOG_MAX_BYTES) {
      try { fs.renameSync(DAEMON_LOG_PATH, `${DAEMON_LOG_PATH}.1`); } catch { /* ignore */ }
      daemonLogBytes = 0;
    }
    fs.appendFileSync(DAEMON_LOG_PATH, line);
    daemonLogBytes += Buffer.byteLength(line);
  } catch {
    // Logging must never crash the daemon.
  }
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
// `--continue` (latest-in-cwd). Permission-mode restore (re-applying the
// captured `--dangerously-skip-permissions` etc.) is OPT-IN via the persisted
// `supervision.restorePermissionMode` bit (U-PERM): main sets it at CREATION
// only when the leaf declared `unattended` AND the user gave explicit unattended
// consent for the project (ProjectTrustRecord.unattended). The daemon honors
// that bit verbatim here — no trust file is read at replay (Minimal design-lock
// 2026-07-01: trust is gated at creation, consistent with how every other
// supervised replay is unconditional post-creation). Absent/false → D6 fail-safe
// (plain --resume/--continue, NO bypass flag). The pill path (explicit user
// Enter) still opts in via permissionFlagFor separately.
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
  session: {
    id: string;
    exec?: { command: string };
    cwd: string;
    resumeBinding?: ResumeBinding;
    supervision?: { restorePermissionMode?: boolean };
  },
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
  // U-PERM: honor the persisted, consent-gated restore bit (set by main at
  // creation). When ON, toResumeCommand appends the captured permission flag
  // (e.g. --dangerously-skip-permissions) — but ONLY inside its binding+cwd-match
  // branch, so a purged transcript (usableBinding undefined) still yields a plain
  // --continue with no bypass (fail-safe). No trust file is read here.
  const restorePermissionMode = session.supervision?.restorePermissionMode === true;
  const rewritten = toResumeCommand(
    session.exec.command,
    usableBinding,
    session.cwd,
    restorePermissionMode ? { restorePermissionMode: true } : undefined,
  );
  if (rewritten === session.exec.command) return undefined; // not a known agent launcher / already resuming
  log(
    'info',
    `X6 resume: replaying session ${session.id} as resume form in ${session.cwd}` +
      (restorePermissionMode ? ' (unattended permission-mode restore ON)' : ''),
  );
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

/**
 * Three-state liveness probe for the daemon lock (Defect-1 of the split-brain
 * chain). A probe FAILURE — `tasklist` stalling under Defender/CPU/WMI load, or
 * an exec error — is `unknown`, NEVER `dead`. The prior boolean form read that
 * flaky failure as "process absent" (catch → false), letting a second daemon
 * treat a LIVE daemon's lock as stale and stomp it (duplicate-daemon →
 * session-pipe EADDRINUSE → terminal reset). Only positive confirmation of death
 * authorizes reclaiming the lock (see lockOwnerIsReclaimable). Mirrors the
 * launcher-side checkProcessLiveness so both processes share one contract
 * (src/shared/processLiveness).
 */
async function processLiveness(pid: number): Promise<ProcessLiveness> {
  if (process.platform === 'win32') {
    // process.kill(pid, 0) is unreliable on Windows — it succeeds for stale PIDs
    // — so probe with tasklist. A thrown probe leaves stdout null → unknown.
    let stdout: string | null = null;
    try {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const tasklist = path.join(systemRoot, 'System32', 'tasklist.exe');
      const res = await execFileAsync(
        tasklist,
        ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'],
        { encoding: 'utf-8', timeout: 3000, windowsHide: true },
      );
      stdout = res.stdout as string;
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
          // 3-state liveness (Defect-1 fix): a probe FAILURE is `unknown`, never
          // `dead`. The lock is reclaimable ONLY on positive confirmation of
          // death — `alive` OR `unknown` (a flaky tasklist) means "assume a live
          // daemon holds it, do not stomp its lock and spawn a second daemon."
          const liveness = await processLiveness(existingPid);
          if (!lockOwnerIsReclaimable(liveness)) {
            log('error', `Another daemon holds the lock (PID ${existingPid}, liveness=${liveness})`);
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

  // Recovery summary up front so the daemon log makes the outcome legible after
  // an OS reboot: how many sessions the state file carried and their states.
  // "loaded 0 session(s)" here means the state file was empty/lost (persistence
  // failure) — distinct from sessions loading but failing to spawn below.
  {
    const byState: Record<string, number> = {};
    for (const s of state.sessions) byState[s.state] = (byState[s.state] ?? 0) + 1;
    log(
      'info',
      `[recovery] loaded ${state.sessions.length} session(s) from state ` +
        `(${JSON.stringify(byState)}), rebooted=${rebooted}, bootId=${currentBootId}`,
    );
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
          if (managed && managed.meta.state !== 'dead' && managed.meta.state !== 'suspended') {
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
            if (managed && managed.meta.state !== 'dead' && managed.meta.state !== 'suspended') {
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
          if (managed && managed.meta.state !== 'dead' && managed.meta.state !== 'suspended') {
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

  // Completion summary — pairs with the "[recovery] loaded N" line above so the
  // daemon log tells the whole story: N loaded → M respawned. M=0 while N>0 means
  // every spawn failed (see the per-session error lines); the daemon has the
  // sessions but the renderer will show nothing.
  log(
    'info',
    `[recovery] complete: recovered ${recoveredIds.size} of ${state.sessions.length} ` +
      `loaded; ${recoveredAgentShellIds.size} agent pane(s) flagged for resume pill`,
  );
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
    if (current && current.meta.state !== 'dead' && current.meta.state !== 'suspended') {
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
  principalService: PrincipalService,
  principalStateWriter: PrincipalStateWriter,
  // envelope PR4: A2A 태스크 데몬 정본. 로그 개방 실패 시 null → 렌더러-only 폴백.
  a2aTaskService: A2aTaskService | null,
  // J0: WorkTask 미션 채널 정본. 로그 개방 실패 시 null → 미션 RPC fail-closed.
  workTaskService: WorkTaskService | null,
): void {
  // daemon.createSession
  pipeServer.onRpc('daemon.createSession', async (params) => {
    // B′ auto-replace (Codex #1): shutdown() snapshots the managed-session
    // list once, so a session created AFTER that snapshot would be disposed
    // without any durable suspended record — silent data loss. shutdown()
    // does not stop the RPC layer (the ack must still flush), so reject
    // creates explicitly once shutdown has begun.
    if (shuttingDown) {
      throw new Error('SHUTTING_DOWN: daemon is shutting down — retry after reconnect');
    }
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
        ? {
            restart: p.supervision.restart,
            limit: p.supervision.limit,
            status: 'armed',
            // U-PERM: preserve the consent-gated restore bit through the create
            // RPC — a field-by-field copy silently dropped it (tsc-invisible:
            // the field is optional on the target).
            ...(p.supervision.restorePermissionMode === true ? { restorePermissionMode: true } : {}),
          }
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
      if (managed && managed.meta.state !== 'dead' && managed.meta.state !== 'suspended') {
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

    // 응답에서 자격증명 값 제거(main은 pid 등만 사용). fresh env 교체 — live meta 불변.
    return { ...session, env: stripCredentialValues(session.env) };
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

  // daemon.resyncSession (phase 3 PR-B) — re-run the flush sequence on the
  // live, already-connected session pipe: RESYNC_BEGIN marker → headless
  // snapshot (or raw-replay degrade) → FLUSH_DONE marker. The socket is never
  // torn down, so input keeps flowing throughout ("무단절 reflush").
  pipeServer.onRpc('daemon.resyncSession', async (params) => {
    const p = params as unknown as { id: string; scrollback?: number };
    const managed = sessionManager.getSession(p.id);
    if (!managed) {
      throw new Error(`SESSION_NOT_FOUND: ${p.id}`);
    }
    if (managed.meta.state === 'dead' || managed.meta.state === 'suspended') {
      throw new Error(`SESSION_DEAD: ${p.id} is ${managed.meta.state} — use daemon.serializeSession`);
    }
    const pipe = sessionPipes.get(p.id);
    if (!pipe || !pipe.isFlushed) {
      throw new Error(`NO_PIPE: session ${p.id} has no flushed client pipe`);
    }
    const result = await pipe.reflush({
      bridge: managed.bridge,
      cols: managed.meta.cols,
      rows: managed.meta.rows,
      scrollback: typeof p.scrollback === 'number' ? p.scrollback : undefined,
      // The reflush owns the global snapshot slot for its whole
      // suppress→finalize window (Codex P2: announcing RESYNC_BEGIN while
      // queued would suppress the pane for N×budget under concurrent
      // reveals), so it takes the slot-acquirer and the unqueued generator.
      generate: generateSnapshotUnqueued,
      enqueue: enqueueSnapshotJob,
    });
    log('info', `[resync] session=${p.id} mode=${result.mode}${result.fallbackReason ? ` fallback=${result.fallbackReason}` : ''}`);
    return { ok: true, mode: result.mode, fallbackReason: result.fallbackReason };
  });

  // daemon.serializeSession (phase 3 PR-B) — read-only snapshot of a session
  // that has NO live pipe (dead/suspended), returned over the control RPC so
  // a dirty reveal can paint the final screen. NEVER clears or replaces the
  // session (F2: a dead pane's last screen must survive reveal). Payload is
  // size-capped for the 1 MB control-pipe line limit: an oversized snapshot
  // retries viewport-only, then reports 'unavailable' (renderer keeps its
  // current stale screen — status quo, never wrong).
  pipeServer.onRpc('daemon.serializeSession', async (params) => {
    const p = params as unknown as { id: string; scrollback?: number };
    const managed = sessionManager.getSession(p.id);
    if (!managed) {
      throw new Error(`SESSION_NOT_FOUND: ${p.id}`);
    }
    const MAX_RPC_PAYLOAD_BYTES = 512 * 1024; // base64 ×1.37 + JSON stays < 1 MB
    const scrollback = Math.min(typeof p.scrollback === 'number' ? p.scrollback : 2000, 10_000);
    const base = {
      cols: managed.meta.cols,
      rows: managed.meta.rows,
      initial: managed.ringBuffer.readAll(),
    };
    let outcome = await generateSnapshot({ ...base, scrollback });
    if (outcome.ok && outcome.payload.length > MAX_RPC_PAYLOAD_BYTES) {
      outcome = await generateSnapshot({ ...base, scrollback: 0 });
    }
    if (!outcome.ok) {
      log('info', `[serialize] session=${p.id} unavailable reason=${outcome.reason}`);
      return { ok: true, mode: 'unavailable', reason: outcome.reason };
    }
    if (outcome.payload.length > MAX_RPC_PAYLOAD_BYTES) {
      log('info', `[serialize] session=${p.id} unavailable reason=too-large bytes=${outcome.payload.length}`);
      return { ok: true, mode: 'unavailable', reason: 'too-large' };
    }
    log('info', `[serialize] session=${p.id} mode=snapshot payload=${outcome.payload.length}`);
    return {
      ok: true,
      mode: 'snapshot',
      payloadBase64: outcome.payload.toString('base64'),
      cols: managed.meta.cols,
      rows: managed.meta.rows,
    };
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
      // 자격증명 값을 뺀 fresh env로 교체 — 데몬 토큰 보유 클라이언트가 RPC로 세션
      // 자격증명을 읽지 못하게. s.env는 live 인메모리 meta.env와 동일 참조라 in-place
      // 수정 금지(스폰이 깨짐); stripCredentialValues는 fresh를 반환하므로 교체만 한다.
      const base = { ...s, env: stripCredentialValues(s.env) };
      // Capture the durable meta binding before stripping it — reused below to
      // surface a guard-passed binding for LIVE agent panes too, so the per-pane
      // resume affordance (Inspect/pane-header UUID + 복구) works ANY time, not
      // only right after a reboot.
      const durableBinding = base.resumeBinding;
      delete base.resumeBinding;
      const withRuntime = base.supervision
        ? { ...base, supervisionRuntime: paneSupervisor.getRuntime(s.id) }
        : base;
      const withAgent = resumeAgent ? { ...withRuntime, resumeAgent } : withRuntime;
      // Binding to SURFACE: the recovery-transient one (recovered-this-boot,
      // cwd+transcript guarded) OR the durable meta binding re-probed for
      // transcript existence (D5). The cwd guard (F7) is deliberately NOT applied
      // here — the renderer re-checks cwd against the LIVE surface cwd when it
      // assembles the command (exact `--resume` vs. cwd-relative `--continue`),
      // exactly like the recovery pill — so the UUID stays viewable after a `cd`
      // while an EXACT resume never fires against a mismatched directory. The
      // existsSync is a per-poll stat but only for agent panes that carry a
      // binding, and it is what keeps a purged conversation from surfacing a
      // dead `--resume` (F8).
      const surfacedBinding =
        resumeBinding ??
        (durableBinding && bindingTranscriptLives(durableBinding) ? durableBinding : undefined);
      // OSC 133 shell-integration state — the AUTHORITATIVE resume-chip gate.
      // Only surfaced when this pane's shell actually emits markers (size > 0);
      // an empty log means shell integration is off, so we send `undefined` and
      // the renderer falls back to its activity heuristic. `true` = a foreground
      // command (e.g. a live `claude`) owns the PTY, so the chip stays hidden
      // even while the agent sits idle past the activity TTL — the exact gap the
      // heuristic alone can't close.
      const managedForPrompt = sessionManager.getSession(s.id);
      const commandRunning =
        managedForPrompt && managedForPrompt.promptLog.size > 0
          ? managedForPrompt.promptLog.isCommandRunning()
          : undefined;
      const withPrompt =
        commandRunning === undefined ? withAgent : { ...withAgent, commandRunning };
      return surfacedBinding ? { ...withPrompt, resumeBinding: surfacedBinding } : withPrompt;
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
    // `spawnedByVersion` + `channelsEpoch` are additive (B′ auto-replace):
    // the launcher's staleness gate compares them against the running app.
    // A pre-B′ daemon omits both — that absence is itself the gate's
    // "positively old" signal (see SPAWNED_BY_VERSION sentinel note).
    // `eventLogFormatVersion` is additive (§6.4a): present only when the event
    // log is durable-active (value = active manifest.formatVersion); absent when
    // the daemon runs the legacy channels.json commit path (migration incomplete
    // /fail-open). Its absence = pre-envelope legacy generation — the B′ gate
    // treats an unknown formatVersion as fail-closed (B′ verdict itself is out of
    // PR5 scope; exposing the value is PR5's part).
    return {
      status: 'ok',
      pid: process.pid,
      uptime,
      sessions: sessions.length,
      eventLoopLagMs,
      bootTrace: { jsStartEpochMs: DAEMON_BOOT.jsStartEpochMs, marks: DAEMON_BOOT.marks },
      spawnedByVersion: SPAWNED_BY_VERSION,
      channelsEpoch: CHANNELS_EPOCH,
      ...pingFormatVersionField(activeEventLogFormatVersion),
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
  //
  // Channels v2 Step 0 — daemon-side caller stamping. Every handler below
  // (EXCEPT archive/kick, which stay humans-only: their honest reachable
  // surface remains the renderer-local mutate path) first runs
  // `stampChannelCaller`: a pre-stamped `verifiedWorkspaceId` is trusted
  // verbatim (main D5 / renderer paths, unchanged), and a headless caller
  // that supplies only `senderPtyId` gets a SERVER-side stamp resolved from
  // the daemon's own session record (env WMUX_WORKSPACE_ID, persisted at
  // spawn by main). See channelCallerIdentity.ts for the acceptance rules.
  // LIVE sessions only (attached/detached): the manager retains dead
  // tombstones for hours (dead-TTL) and suspended records across restarts,
  // and a pane that no longer has a usable PTY child cannot legitimately be
  // the caller — a stale senderPtyId must fail closed exactly like an
  // unknown one (CodeRabbit review). Uses the manager's canonical live
  // filter rather than re-implementing state checks here.
  const resolveSessionWorkspace = (sessionId: string): string => {
    const meta = sessionManager.listLiveSessions().find((m) => m.id === sessionId);
    const ws = meta?.env?.[ENV_KEYS.WORKSPACE_ID];
    return typeof ws === 'string' && ws.trim().length > 0 ? ws.trim() : '';
  };
  const stampCaller = (
    rawParams: Record<string, unknown>,
    callerField: CallerFieldSpec,
  ): ReturnType<typeof stampChannelCaller> => stampChannelCaller(resolveSessionWorkspace, rawParams, callerField);

  pipeServer.onRpc('a2a.channel.list', async (rawParams) => {
    const stamped = stampCaller(rawParams, { kind: 'none' });
    if (!stamped.ok) return stamped;
    const params = stamped.params;
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
    // `channelsEpoch` is additive (ship review C1): the renderer compares it
    // against its own CHANNELS_EPOCH on hydration to detect a stale daemon
    // (pre-P5 daemons simply omit the field).
    return { ok: true, channelsEpoch: CHANNELS_EPOCH, channels: channelService.list(verifiedWorkspaceId) };
  });

  pipeServer.onRpc('a2a.channel.get', async (rawParams) => {
    const stamped = stampCaller(rawParams, { kind: 'none' });
    if (!stamped.ok) return stamped;
    const params = stamped.params;
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

  pipeServer.onRpc('a2a.channel.getMessages', async (rawParams) => {
    const stamped = stampCaller(rawParams, { kind: 'none' });
    if (!stamped.ok) return stamped;
    const params = stamped.params;
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

  pipeServer.onRpc('a2a.channel.getMembers', async (rawParams) => {
    const stamped = stampCaller(rawParams, { kind: 'none' });
    if (!stamped.ok) return stamped;
    const params = stamped.params;
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

  pipeServer.onRpc('a2a.channel.ack', async (rawParams) => {
    const stamped = stampCaller(rawParams, { kind: 'none' });
    if (!stamped.ok) return stamped;
    const params = stamped.params;
    const channelId = typeof params['channelId'] === 'string' ? params['channelId'] : '';
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    const rawUpto = params['uptoSeq'];
    // Guard NaN/Infinity/negative/fractional (review A1 P3 + CodeRabbit) —
    // uptoSeq is a monotonic seq floor and the cursor it advances persists,
    // so only whole seq values may reach ChannelService.ack. Invalid ⇒ 0
    // (a no-op ack: the cursor never moves backwards).
    const uptoSeq = typeof rawUpto === 'number' && Number.isSafeInteger(rawUpto) && rawUpto >= 0 ? rawUpto : 0;
    // Channels v2: optional member narrowing (agent path). Absent = whole-ws ack.
    const memberId = typeof params['memberId'] === 'string' && params['memberId'].length > 0 ? params['memberId'] : undefined;
    if (!channelId) {
      return { ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: 'channelId is required' } };
    }
    if (!verifiedWorkspaceId) {
      return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'verifiedWorkspaceId is required' } };
    }
    return channelService.ack({ channelId, verifiedWorkspaceId, uptoSeq, ...(memberId !== undefined ? { memberId } : {}) });
  });

  // Shared nudge ledger (remediation 2a-2) — the renderer reports a mention
  // paste it just delivered, so the wake worker's re-nudge budget/backoff
  // counts it and does not immediately double-paste the same member. Exposed
  // to callers ONLY via the renderer-local mutate path (channelLocal.handler);
  // the MAIN pipe router (a2a.channel.rpc.ts) deliberately does NOT register
  // it — a forgeable pipe caller could otherwise suppress ANOTHER member's
  // re-nudges. Direct daemon-pipe reachability bottoms out at the same
  // same-user ceiling as kick/purge (#113, documented residual).
  pipeServer.onRpc('a2a.channel.nudgeRecorded', async (rawParams) => {
    const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? rawParams
      : {}) as Record<string, unknown>;
    const channelId = typeof params['channelId'] === 'string' ? params['channelId'] : '';
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    const memberId =
      typeof params['memberId'] === 'string' && params['memberId'].length > 0 ? params['memberId'] : '';
    if (!channelId || !memberId) {
      return { ok: false, error: { code: 'INVALID_PARAMS', message: 'channelId and memberId are required' } };
    }
    if (!verifiedWorkspaceId) {
      return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'verifiedWorkspaceId is required' } };
    }
    // Best-effort by design: `recorded:false` means the ledger did not change
    // (worker not booted yet, or the tuple is not a live membership row — the
    // worker validates before inserting so bogus keys cannot grow its map).
    const recorded = channelWakeWorkerRef?.recordExternalNudge(channelId, verifiedWorkspaceId, memberId) ?? false;
    return { ok: true, recorded };
  });

  // Channels v2 — per-member unread summary (durable-inbox read model).
  // Read-only; the wake worker computes the same numbers in-process, this
  // RPC is the CLI/agent surface.
  pipeServer.onRpc('a2a.channel.unread', async (rawParams) => {
    const stamped = stampCaller(rawParams, { kind: 'none' });
    if (!stamped.ok) return stamped;
    const params = stamped.params;
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    if (!verifiedWorkspaceId) {
      return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'verifiedWorkspaceId is required' } };
    }
    const memberId = typeof params['memberId'] === 'string' && params['memberId'].length > 0 ? params['memberId'] : undefined;
    return { ok: true, entries: channelService.unreadFor(verifiedWorkspaceId, memberId) };
  });

  pipeServer.onRpc('a2a.channel.create', async (rawParams) => {
    const stamped = stampCaller(rawParams, { kind: 'ref', key: 'createdBy' });
    if (!stamped.ok) return stamped;
    const p = stamped.params as unknown as import('./channels/ChannelService').CreateChannelParams;
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

  // NOTE (Channels v2 Step 0): archive is deliberately NOT run through
  // `stampCaller` — archive/kick are HUMANS-ONLY (renderer-local mutate path,
  // which pre-stamps verifiedWorkspaceId). Stamping here would hand every
  // pane agent an honest daemon-pipe route to a destructive humans-only op.
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

  pipeServer.onRpc('a2a.channel.join', async (rawParams) => {
    const stamped = stampCaller(rawParams, { kind: 'ref', key: 'member' });
    if (!stamped.ok) return stamped;
    const p = stamped.params as unknown as import('./channels/ChannelService').JoinChannelParams;
    if (!p.channelId || !p.member || !p.verifiedWorkspaceId) {
      return {
        ok: false,
        error: { code: 'NOT_AUTHORIZED', message: 'channelId, member, and a server-resolved verifiedWorkspaceId are required' },
      };
    }
    return channelService.join(p);
  });

  pipeServer.onRpc('a2a.channel.leave', async (rawParams) => {
    const stamped = stampCaller(rawParams, { kind: 'flat', key: 'workspaceId' });
    if (!stamped.ok) return stamped;
    const p = stamped.params as unknown as import('./channels/ChannelService').LeaveChannelParams;
    if (!p.channelId || !p.workspaceId || !p.memberId || !p.verifiedWorkspaceId) {
      return {
        ok: false,
        error: { code: 'NOT_AUTHORIZED', message: 'channelId, workspaceId, memberId, and a server-resolved verifiedWorkspaceId are required' },
      };
    }
    return channelService.leave(p);
  });

  pipeServer.onRpc('a2a.channel.post', async (rawParams) => {
    const stamped = stampCaller(rawParams, { kind: 'ref', key: 'sender' });
    if (!stamped.ok) return stamped;
    const p = stamped.params as unknown as import('./channels/ChannelService').PostMessageParams;
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

  pipeServer.onRpc('a2a.channel.invite', async (rawParams) => {
    // NOTE: `invitedMember` is a TARGET identity, never backfilled — only the
    // INVITER's verifiedWorkspaceId is stamped here.
    const stamped = stampCaller(rawParams, { kind: 'none' });
    if (!stamped.ok) return stamped;
    const p = stamped.params as unknown as import('./channels/ChannelService').InviteChannelParams;
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
    // Deliberately NOT stamped (humans-only, same rationale as archive above).
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

  pipeServer.onRpc('a2a.channel.purgeMembership', async (params) => {
    // R2 system cleanup — same humans-only convention as kick, reachable only
    // via the renderer-only path (`channels:mutate-local`). Not registered on
    // the pipe router. For the same reason as archive/kick, it does not run
    // `stampCaller` (review C2): stamping would hand a pipe agent that only has
    // senderPtyId an honest daemon-pipe path to a humans-only destructive op
    // (bulk removal across all channels). Only a pre-stamped
    // verifiedWorkspaceId (filled by the renderer) is accepted.
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    if (!verifiedWorkspaceId) {
      return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'verifiedWorkspaceId is required' } };
    }
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : '';
    if (!workspaceId) {
      return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'workspaceId is required' } };
    }
    const memberId =
      typeof params['memberId'] === 'string' && params['memberId'].length > 0
        ? params['memberId']
        : undefined;
    const principalId =
      typeof params['principalId'] === 'string' && params['principalId'].length > 0
        ? params['principalId']
        : undefined;
    // B(패널·완료증거 §③ E10): whole-workspace purge(memberId·principalId 모두
    // 부재)는 workspace 제거 teardown 신호다(workspaceSlice). 데몬이 이 사실을 아는
    // 유일 지점이므로, 여기서 그 workspace로 향한 non-terminal A2A 태스크를 정본
    // (로그)에서 force-fail한다 — 렌더러 캐시에서만 죽이면 재시작 시 restoreFromLog가
    // 부활시켜 정본이 실제와 어긋난다. per-member purge(paneSlice)는 teardown이
    // 아니므로 제외. 로그 커밋을 await해 응답 전 내구화(데몬 미가용 아님 — 동일 프로세스).
    if (a2aTaskService && memberId === undefined && principalId === undefined) {
      try {
        const n = await a2aTaskService.failTasksForWorkspaceRemoved(
          workspaceId,
          'Receiver workspace was removed before this task completed.',
        );
        if (n > 0) log('info', `A2A: force-failed ${n} task(s) for removed workspace ${workspaceId}`);
      } catch (err) {
        log('warn', `A2A: failTasksForWorkspaceRemoved(${workspaceId}) failed:`, err);
      }
    }
    return channelService.purgeMembership({
      workspaceId,
      verifiedWorkspaceId,
      ...(memberId !== undefined ? { memberId } : {}),
      ...(principalId !== undefined ? { principalId } : {}),
    });
  });

  // a2a.channel.operatorJoin — 오퍼레이터(사람)가 에이전트들이 만든 비공개 채널에
  // 스스로 들어가는 신뢰 경로(operator-join 설계 §2.1). kick/purgeMembership과 동일한
  // HUMANS-ONLY 관례: 파이프 라우터(a2a.channel.rpc.ts)에 등록되지 않고 렌더러 전용
  // channels:mutate-local IPC로만 도달한다. stampCaller를 돌리지 않는다(archive/kick과
  // 동일 근거): 스탬프하면 senderPtyId만 가진 파이프 에이전트에게 humans-only 목적지로
  // 향하는 정직한 데몬-파이프 경로를 열어주게 된다. 렌더러가 미리 채운
  // verifiedWorkspaceId만 수용한다.
  //
  // §2.1.2 직결 잔여(명시 수용, kick 선례와 동일 클래스): 데몬 소켓 직결 호출자(같은
  // OS 유저)는 이 메서드를 임의 verifiedWorkspaceId로 호출해 사람 좌석을 임의 채널에
  // 심을 수 있다. 그러나 이 호출자는 이미 channels.json을 디스크에서 메시지 전문 포함
  // 읽을 수 있으므로(L3 천장, #113) operatorJoin이 새로 주는 읽기 능력은 없다. 새로
  // 생기는 "위조된 사람 입장 신호"는 ChannelService가 남기는 서버-발행 시스템 메시지
  // (§2.1.1)가 사람에게 가시화한다 — 유일하게 가능한 방어 형태다.
  pipeServer.onRpc('a2a.channel.operatorJoin', async (params) => {
    // Deliberately NOT stamped (humans-only, kick/purgeMembership과 동일 근거).
    const channelId = typeof params['channelId'] === 'string' ? params['channelId'] : '';
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    if (!channelId || !verifiedWorkspaceId) {
      return {
        ok: false,
        error: {
          code: 'NOT_AUTHORIZED',
          message: 'channelId and a server-resolved verifiedWorkspaceId are required',
        },
      };
    }
    // 좌석 행은 ChannelService.operatorJoin이 상수로만 구성한다 — 여기서 params의
    // 여분 필드(member/includeHistory 등)를 전달하지 않는다(§2.1 파라미터 표면 제거).
    return channelService.operatorJoin({ channelId, verifiedWorkspaceId });
  });

  // a2a.channel.operatorList — 비공개 채널 발견 어포던스(설계 §2.2, 읽기 전용).
  // operatorJoin과 동일한 humans-only 트랜스포트: private 채널은 list()에서 비멤버에게
  // 숨겨지므로 GUI가 "들어갈 수 있는 방"을 보여주려면 이 메서드가 필요하다. 읽기지만
  // 파이프에 노출하면 에이전트가 전 private 채널 이름을 열거할 수 있으므로 파이프
  // 미등록 + 렌더러 전용 경로만. §2.2 직결 잔여: 같은 호출자는 이미 디스크에서 동일
  // 정보+메시지 전문을 읽는다 — API가 디스크보다 강하지 않다(명시 수용).
  pipeServer.onRpc('a2a.channel.operatorList', async (params) => {
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    if (!verifiedWorkspaceId) {
      return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'verifiedWorkspaceId is required' } };
    }
    return { ok: true, channels: channelService.operatorList({ verifiedWorkspaceId }) };
  });

  // ── A2A task registry (envelope PR4 §5 D11) ─────────────────────────
  // 데몬 정본 A2A 태스크 서비스. main의 a2a.rpc.ts가 렌더러 delivery와 병행해 이
  // 핸들러로 정본 상태(생성·전이·취소)를 커밋한다(dual-write 브리지 — D1). 정본은
  // 데몬 로그, 렌더러 a2aSlice는 캐시로 강등. a2aTaskService가 null(로그 개방 실패)
  // 이면 렌더러-only로 degrade한다 — A2A는 역사적으로 best-effort 비내구(a2aSlice
  // 30분 GC)라 로그 부재가 파국이 아니다.
  pipeServer.onRpc('a2a.task.create', async (rawParams) => {
    if (!a2aTaskService) return { ok: false, error: 'a2a.task.create: task log unavailable' };
    const p = rawParams as Record<string, unknown>;
    const from = p.from as CreateTaskInput['from'] | undefined;
    const to = p.to as CreateTaskInput['to'] | undefined;
    if (!from?.workspaceId || !to?.workspaceId || typeof p.title !== 'string') {
      return { ok: false, error: 'a2a.task.create: from{workspaceId}, to{workspaceId}, and title are required' };
    }
    return a2aTaskService.createTask({
      ...(typeof p.id === 'string' ? { id: p.id } : {}),
      title: p.title,
      from,
      to,
      // 초기 히스토리(첫 메시지)는 생성 envelope에 실려 내구화된다. 이후 증분
      // 히스토리(reply) 내구화는 §6.F 몫 — 전이·생성·취소가 이 PR의 로그 정본.
      ...(Array.isArray(p.history) ? { history: p.history as Message[] } : {}),
    });
  });

  pipeServer.onRpc('a2a.task.update', async (rawParams) => {
    if (!a2aTaskService) return { ok: false, error: 'a2a.task.update: task log unavailable' };
    const p = rawParams as Record<string, unknown>;
    const taskId = typeof p.taskId === 'string' ? p.taskId : '';
    const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : '';
    const status = typeof p.status === 'string' ? p.status : '';
    if (!taskId || !workspaceId || !status) {
      return { ok: false, error: 'a2a.task.update: taskId, workspaceId, and status are required' };
    }
    // 'canceled'는 a2a.task.cancel 전용(a2aSlice 현행 계약과 동형).
    if (status === 'canceled') return { ok: false, error: 'a2a.task.update: use a2a.task.cancel instead' };
    if (!isTaskState(status)) return { ok: false, error: `a2a.task.update: invalid status "${status}"` };
    return a2aTaskService.transition({
      taskId,
      to: status,
      callerWorkspaceId: workspaceId,
      // S-C2: 페인 신원 주장 여부 — 페인 핀 태스크면 서비스가 soft-defer해 main이
      // 렌더러 페인 게이트(오늘의 판정 지점)로 폴백한다(ptyId→pane 해석은 렌더러 소유).
      callerHasPaneIdentity: typeof p.senderPtyId === 'string' && p.senderPtyId.trim() !== '',
      // evidence는 서비스가 normalizeCompletionEvidenceWire로 재검증(sanitize)한 뒤
      // 완료증거 게이트(PR-B)로 판정한다 — completed/failed는 구조화 증거 강제(거부는
      // completion_evidence_* 사유코드로 호출자에 포워딩).
      ...(p.evidence !== undefined ? { evidence: p.evidence } : {}),
      ...(typeof p.idempotencyKey === 'string' ? { idempotencyKey: p.idempotencyKey } : {}),
    });
  });

  pipeServer.onRpc('a2a.task.cancel', async (rawParams) => {
    if (!a2aTaskService) return { ok: false, error: 'a2a.task.cancel: task log unavailable' };
    const p = rawParams as Record<string, unknown>;
    const taskId = typeof p.taskId === 'string' ? p.taskId : '';
    const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : '';
    if (!taskId || !workspaceId) return { ok: false, error: 'a2a.task.cancel: taskId and workspaceId are required' };
    return a2aTaskService.cancelTask({
      taskId,
      callerWorkspaceId: workspaceId,
      ...(typeof p.idempotencyKey === 'string' ? { idempotencyKey: p.idempotencyKey } : {}),
    });
  });

  pipeServer.onRpc('a2a.task.query', async (rawParams) => {
    if (!a2aTaskService) return { ok: false, error: 'a2a.task.query: task log unavailable' };
    const p = rawParams as Record<string, unknown>;
    const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : '';
    if (!workspaceId) return { ok: false, error: 'a2a.task.query: workspaceId is required' };
    const tasks = a2aTaskService.queryTasks(workspaceId, {
      ...(typeof p.status === 'string' && isTaskState(p.status) ? { status: p.status } : {}),
      ...(p.role === 'user' || p.role === 'agent' ? { role: p.role } : {}),
      ...(typeof p.updatedSince === 'string' && p.updatedSince ? { updatedSince: p.updatedSince } : {}),
    });
    return { ok: true, workspaceId, tasks };
  });

  // ── WorkTask 미션 채널 (J0 §3) ──────────────────────────────────────
  // start/close/list. 신원은 a2a.channel.* 변이와 동일 규율(stampCaller로
  // senderPtyId→verifiedWorkspaceId 서버 해석, 해석 불가 fail-closed). owner는
  // 서비스가 born-owned로 강제 투입(§5.1) — wire는 title·invite·memberId만.
  // 로그 미가용(workTaskService=null)이면 명시 에러(fail-closed, §1 D).

  pipeServer.onRpc('task.mission.start', async (rawParams) => {
    if (!workTaskService) {
      return { ok: false, error: { code: 'NOT_AVAILABLE', message: 'task.mission.start: mission log unavailable' } };
    }
    const stamped = stampCaller(rawParams, { kind: 'none' });
    if (!stamped.ok) return stamped;
    const p = stamped.params;
    const verifiedWorkspaceId =
      typeof p['verifiedWorkspaceId'] === 'string' ? p['verifiedWorkspaceId'] : '';
    if (!verifiedWorkspaceId) {
      return {
        ok: false,
        error: { code: 'NOT_AUTHORIZED', message: 'task.mission.start: a server-resolved verifiedWorkspaceId is required' },
      };
    }
    const title = typeof p['title'] === 'string' ? p['title'] : '';
    if (!title) {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'task.mission.start: title is required' } };
    }
    // memberId: 채널 생성자 멤버 좌표. 미제공이면 verifiedWorkspaceId를 폴백으로 삼는다
    // (a2a.channel.create의 createdBy.memberId와 동일 시멘틱 — pipe 클라이언트는 자신의
    // memberId를 알 수도, 모를 수도 있다).
    const memberId =
      typeof p['memberId'] === 'string' && p['memberId'].length > 0 ? p['memberId'] : verifiedWorkspaceId;
    // invite: 선택 초대 목록(채널 초기 멤버). 형태 방어적 파싱.
    const invite = Array.isArray(p['invite'])
      ? (p['invite'] as unknown[])
          .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>) : null))
          .filter((m): m is Record<string, unknown> => m !== null)
          .filter((m) => typeof m['workspaceId'] === 'string' && typeof m['memberId'] === 'string')
          .map((m) => ({ workspaceId: m['workspaceId'] as string, memberId: m['memberId'] as string }))
      : undefined;
    return workTaskService.startMission({
      title,
      verifiedWorkspaceId,
      memberId,
      ...(invite && invite.length > 0 ? { invite } : {}),
      ...(typeof p['idempotencyKey'] === 'string' ? { idempotencyKey: p['idempotencyKey'] } : {}),
    });
  });

  pipeServer.onRpc('task.mission.close', async (rawParams) => {
    if (!workTaskService) {
      return { ok: false, error: { code: 'NOT_AVAILABLE', message: 'task.mission.close: mission log unavailable' } };
    }
    const stamped = stampCaller(rawParams, { kind: 'none' });
    if (!stamped.ok) return stamped;
    const p = stamped.params;
    const verifiedWorkspaceId =
      typeof p['verifiedWorkspaceId'] === 'string' ? p['verifiedWorkspaceId'] : '';
    if (!verifiedWorkspaceId) {
      return {
        ok: false,
        error: { code: 'NOT_AUTHORIZED', message: 'task.mission.close: a server-resolved verifiedWorkspaceId is required' },
      };
    }
    const taskId = typeof p['taskId'] === 'string' ? p['taskId'] : '';
    if (!taskId) {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'task.mission.close: taskId is required' } };
    }
    return workTaskService.closeMission({
      taskId,
      verifiedWorkspaceId,
      ...(typeof p['idempotencyKey'] === 'string' ? { idempotencyKey: p['idempotencyKey'] } : {}),
    });
  });

  pipeServer.onRpc('task.mission.list', async (rawParams) => {
    if (!workTaskService) {
      return { ok: false, error: { code: 'NOT_AVAILABLE', message: 'task.mission.list: mission log unavailable' } };
    }
    const stamped = stampCaller(rawParams, { kind: 'none' });
    if (!stamped.ok) return stamped;
    const p = stamped.params;
    const verifiedWorkspaceId =
      typeof p['verifiedWorkspaceId'] === 'string' ? p['verifiedWorkspaceId'] : '';
    if (!verifiedWorkspaceId) {
      return {
        ok: false,
        error: { code: 'NOT_AUTHORIZED', message: 'task.mission.list: a server-resolved verifiedWorkspaceId is required' },
      };
    }
    return { ok: true, verifiedWorkspaceId, tasks: workTaskService.listMissions(verifiedWorkspaceId) };
  });

  // task.mission.update(J1 §5): 물질화 필드 단조 커밋. 신원 규율은 start/close와
  // 동형(stampCaller로 senderPtyId→verifiedWorkspaceId, fail-closed). wire
  // 화이트리스트: {taskId, branch?, worktreePath?, paneGroupId?, prUrl?} —
  // prUrl(J3 §2)은 비단조·closed 단독 갱신 허용·형식 검증(WORKTASK_PR_URL_RE).
  pipeServer.onRpc('task.mission.update', async (rawParams) => {
    if (!workTaskService) {
      return { ok: false, error: { code: 'NOT_AVAILABLE', message: 'task.mission.update: mission log unavailable' } };
    }
    const stamped = stampCaller(rawParams, { kind: 'none' });
    if (!stamped.ok) return stamped;
    const p = stamped.params;
    const verifiedWorkspaceId =
      typeof p['verifiedWorkspaceId'] === 'string' ? p['verifiedWorkspaceId'] : '';
    if (!verifiedWorkspaceId) {
      return {
        ok: false,
        error: { code: 'NOT_AUTHORIZED', message: 'task.mission.update: a server-resolved verifiedWorkspaceId is required' },
      };
    }
    const taskId = typeof p['taskId'] === 'string' ? p['taskId'] : '';
    if (!taskId) {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'task.mission.update: taskId is required' } };
    }
    return workTaskService.updateMission({
      taskId,
      verifiedWorkspaceId,
      ...(typeof p['branch'] === 'string' ? { branch: p['branch'] } : {}),
      ...(typeof p['worktreePath'] === 'string' ? { worktreePath: p['worktreePath'] } : {}),
      ...(typeof p['paneGroupId'] === 'string' ? { paneGroupId: p['paneGroupId'] } : {}),
      ...(typeof p['prUrl'] === 'string' ? { prUrl: p['prUrl'] } : {}),
    });
  });

  // ── Principal registry (R2) ─────────────────────────────────────────
  // The three writes are renderer-only system actions: reachable only via
  // main's `channels:mutate-local` (renderer-only IPC), and deliberately not
  // registered on the pipe router (a2a.channel.rpc.ts) — same humans-only
  // convention as kick (#113: same-machine agent identity is forgeable, so we
  // do not open a path for agents to register/delete arbitrary principals).
  // verifiedWorkspaceId is always stamped by mutateLocal, so we only check the
  // "no anonymous mutation" posture.

  pipeServer.onRpc('a2a.principal.upsert', async (rawParams) => {
    const params = rawParams as Record<string, unknown>;
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    if (!verifiedWorkspaceId) {
      return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'verifiedWorkspaceId is required' } };
    }
    const record = params['record'];
    if (!isPrincipalUpsertInput(record)) {
      return { ok: false, error: { code: 'INVALID_PARAMS', message: 'Malformed principal record' } };
    }
    // Review I7 — ptyId cross-check: an upsert is not display, it changes the
    // wake worker's PTY-write target. Using the daemon's own session records
    // (WMUX_WORKSPACE_ID stamped by main on spawn — the same anchor
    // stampChannelCaller uses), verify that record.ptyId really is a session of
    // record.workspaceId. A mismatch / unresolved (dead session, env not bound)
    // is rejected — and even on registration failure the wake worker degrades
    // safely to the existing heuristic.
    if (record.kind === 'pane-agent' && typeof record.ptyId === 'string' && record.ptyId.length > 0) {
      const sessionWs = resolveSessionWorkspace(record.ptyId);
      if (!sessionWs || sessionWs !== record.workspaceId) {
        return {
          ok: false,
          error: {
            code: 'NOT_AUTHORIZED',
            message: `principal ptyId does not resolve to workspace ${String(record.workspaceId)}`,
          },
        };
      }
    }
    return { ok: true, principal: principalService.upsert(record) };
  });

  pipeServer.onRpc('a2a.principal.remove', async (rawParams) => {
    const params = rawParams as Record<string, unknown>;
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    if (!verifiedWorkspaceId) {
      return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'verifiedWorkspaceId is required' } };
    }
    const principalId = typeof params['principalId'] === 'string' ? params['principalId'] : '';
    if (!principalId) {
      return { ok: false, error: { code: 'INVALID_PARAMS', message: 'principalId is required' } };
    }
    return { ok: true, removed: principalService.remove(principalId) };
  });

  pipeServer.onRpc('a2a.principal.markStaleWorkspace', async (rawParams) => {
    const params = rawParams as Record<string, unknown>;
    const verifiedWorkspaceId =
      typeof params['verifiedWorkspaceId'] === 'string' ? params['verifiedWorkspaceId'] : '';
    if (!verifiedWorkspaceId) {
      return { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'verifiedWorkspaceId is required' } };
    }
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : '';
    if (!workspaceId) {
      return { ok: false, error: { code: 'INVALID_PARAMS', message: 'workspaceId is required' } };
    }
    return { ok: true, changed: principalService.markStaleByWorkspace(workspaceId) };
  });

  // daemon.shutdown — gracefully terminate the daemon process. A2 makes
  // this RPC awaitable: the handler runs the full shutdown body (dumps,
  // state save, dispose) before returning, then defers the pipe stop and
  // process.exit to setImmediate so the RPC ack actually flushes back to
  // the caller. Callers (e.g., main before-quit / WM_ENDSESSION) can
  // await this with a per-call timeoutMs override (DaemonClient.rpc opt).
  pipeServer.onRpc('daemon.shutdown', async () => {
    log('info', 'Shutdown requested via RPC');
    const { stateSaved } = await shutdown(
      'rpc.shutdown',
      sessionManager,
      pipeServer,
      stateWriter,
      channelStateWriter,
      principalStateWriter,
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
    // `stateSaved` is additive (B′ auto-replace): false tells the caller the
    // suspended records did not land and recovery will be snapshot-grade.
    return { status: 'ok', stateSaved };
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

  // session:interrupted → shutdown-kill path (reboot-reattach RCA 2026-07-02).
  // The PTY was torn down by the OS (system shutdown/logoff), not by the user.
  // Suspend-in-place: dump the ring buffer, persist state 'suspended' so the
  // post-reboot recovery replays the SAME session id and the renderer's saved
  // ptyId binding reconnects. Deliberately NOT done here (vs session:died):
  //  - no `session.died` broadcast — a still-alive renderer must not clear its
  //    binding during the shutdown window;
  //  - no buffer-dump deletion — the dump IS the recovery payload;
  //  - no supervisor restart — spawning processes during OS shutdown just
  //    yields 0xC0000142 corpses; recovery replays supervision after reboot.
  // Misclassification safety net: if the daemon is still alive after
  // SHUTDOWN_KILL_RECLASSIFY_MS (cancelled shutdown / isolated conhost kill),
  // reclassify as a genuine death and run the standard died flow.
  //
  // Pipe/listener cleanup IS done here (adversarial review), unlike the other
  // died-only steps above: an isolated conhost kill (the exact case the
  // reclassify timer exists for) leaves the daemon AND a still-connected
  // renderer alive for up to SHUTDOWN_KILL_RECLASSIFY_MS. Without stopping the
  // SessionPipe, its `onInput` closure keeps forwarding client keystrokes
  // straight into the now-destroyed `ptyProcess.write()` — an unhandled
  // socket 'error' with no listener, which the daemon's own uncaughtException
  // handler treats as fatal after 3 repeats, killing every OTHER session as
  // collateral. Stopping the pipe destroys the client's connection for THIS
  // session only (the renderer's own reconnect-with-retry handles that as a
  // transient failure) without broadcasting session.died or touching the
  // renderer's saved binding.
  sessionManager.on('session:interrupted', (payload: { id: string; exitCode: number | null; signal?: number; cmd?: string; lastActivityMsAgo?: number }) => {
    log('info', `[lifecycle] session:interrupted id=${payload.id} exitCode=${payload.exitCode ?? 'null'} signal=${payload.signal ?? 'none'} cmd=${payload.cmd ?? '?'} — shutdown-kill classified, suspending for recovery (reclassify in ${SHUTDOWN_KILL_RECLASSIFY_MS}ms if daemon survives)`);
    // The PTY is gone — stop the liveness poll BEFORE it can observe the dead
    // pid and re-emit session:died (which would resurrect the purge this fix
    // removes). The watch closures also skip 'suspended' as defense in depth.
    try {
      processMonitor.unwatch(payload.id);
    } catch (err) {
      log('warn', `session:interrupted unwatch failed for ${payload.id}:`, err);
    }
    // Graceful-shutdown race (posix SIGTERM fan-out / mid-suspend deaths): the
    // shutdown loop already stops every session's pipe (see `pipeStops` above)
    // and is dumping every non-dead session's buffer — doing either again here
    // would just race the same pipe/file.
    if (shuttingDown) return;

    // Remove the PTY→client data listener to prevent a leak (mirrors
    // session:died) — the bridge is dead and will emit nothing more, but the
    // map entry would otherwise dangle.
    try {
      const tracked = sessionDataListeners.get(payload.id);
      if (tracked) {
        tracked.bridge.removeListener('data', tracked.listener);
        sessionDataListeners.delete(payload.id);
      }
    } catch (err) {
      log('warn', `session:interrupted data-listener cleanup failed for ${payload.id}:`, err);
    }

    // Stop the SessionPipe so its onInput closure can never write another
    // keystroke into the destroyed ptyProcess (see comment above the
    // listener). This is the crash-prevention step.
    try {
      const pipe = sessionPipes.get(payload.id);
      if (pipe) {
        pipe.stop().catch(() => {});
        sessionPipes.delete(payload.id);
      }
    } catch (err) {
      log('warn', `session:interrupted pipe stop failed for ${payload.id}:`, err);
    }

    const managed = sessionManager.getSession(payload.id);
    if (!managed) return;
    try {
      stateWriter.ensureBufferDir();
      const dumpPath = stateWriter.getBufferDumpPath(payload.id);
      managed.ringBuffer
        .dumpToFile(dumpPath)
        .then(() => {
          managed.meta.bufferDumpPath = dumpPath;
        })
        .catch((err) => {
          // Dump failed — recovery still replays via the 30s snapshot (or
          // empty scrollback); losing scrollback beats losing the session.
          log('warn', `session:interrupted buffer dump failed for ${payload.id}:`, err);
        })
        .finally(() => {
          // Persistence anchor: the 'suspended' record MUST land before the
          // OS kills us. saveImmediate is synchronous-atomic on the state file.
          try {
            stateWriter.saveImmediate(buildState(sessionManager));
          } catch (err) {
            log('error', `session:interrupted state save failed for ${payload.id}:`, err);
          }
        });
    } catch (err) {
      log('error', `session:interrupted suspend failed for ${payload.id}:`, err);
    }

    const timer = setTimeout(() => {
      interruptedTimers.delete(payload.id);
      const current = sessionManager.getSession(payload.id);
      // Destroyed/replayed meanwhile → nothing to reclassify.
      if (!current || current.meta.state !== 'suspended') return;
      log('info', `[lifecycle] session:interrupted id=${payload.id} — daemon survived ${SHUTDOWN_KILL_RECLASSIFY_MS}ms, no shutdown happened → reclassifying as death`);
      current.meta.state = 'dead';
      sessionManager.emit('session:died', { ...payload, reason: 'interrupted-timeout' });
      sessionManager.emit('session:stateChanged', { id: payload.id, state: 'dead' });
    }, SHUTDOWN_KILL_RECLASSIFY_MS);
    interruptedTimers.set(payload.id, timer);
  });

  // A pane the user closes while a reclassification is pending must not get a
  // ghost died event 15s later.
  sessionManager.on('session:destroyed', (payload: { id: string }) => {
    const t = interruptedTimers.get(payload.id);
    if (t) {
      clearTimeout(t);
      interruptedTimers.delete(payload.id);
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
    // Persist the new cwd NOW but asynchronously (saveAsap, not
    // saveImmediate). Recovery replays meta.cwd AND the X6 ② resume pill
    // pastes `claude --continue`, which is cwd-scoped — so the cwd must not
    // wait out the 30s debounce. But the write must not run synchronously
    // either: at fleet scale (30 sessions) sessions.json grows to hundreds
    // of KB and concurrent agents `cd` constantly, so the old sync write +
    // .bak rotation stalled the event loop right when it was busiest — the
    // stall pattern that starves daemon.ping and gets a live daemon
    // force-respawned. saveAsap persists within ms via the coalescing
    // queue; only a SIGKILL inside that window can lose the cwd, and the
    // next lifecycle event re-persists it.
    stateWriter.saveAsap(buildState(sessionManager));
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

// Channels v2 — wake worker handle for shutdown + the emit fast path.
let channelWakeWorkerRef: ChannelWakeWorker | null = null;

// 이벤트로그(PR3) — projection 스냅샷 스토어. shutdown 경로가 pending 스냅샷을
// durable로 flush(dispose)할 수 있도록 모듈 레벨 핸들 유지(§6.4b).
let channelSnapshotStoreRef: SnapshotStore | null = null;
// §6.4a: 활성 이벤트로그 formatVersion. manifest durable 활성(로그 모드) 시에만
// main()이 세팅 — 레거시 폴백/마이그레이션 미완(channelEventLogDeps null 경로)이면
// undefined로 남아 daemon.ping이 필드를 뺀다(부재 = pre-envelope 데몬 = 레거시
// 세대). ping 핸들러(registerRpcHandlers 클로저)는 이 모듈 변수의 live binding을
// 캡처하므로 값을 **호출 시점**에 읽는다 — 실제 ping RPC는 부트 완료 후에나 도착하니
// 마이그레이션 세팅과 핸들러 등록의 상대 순서는 무관하다(등록이 앞서도 안전).
let activeEventLogFormatVersion: number | undefined = undefined;

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

// Pending shutdown-kill reclassification timers, keyed by session id (see the
// session:interrupted listener in wireEvents). Module-level so shutdown() can
// cancel them — a reclassify-to-dead firing mid-graceful-shutdown would race
// the suspend loop's own state save.
const interruptedTimers = new Map<string, NodeJS.Timeout>();

async function shutdown(
  signal: string,
  sessionManager: DaemonSessionManager,
  pipeServer: DaemonPipeServer,
  stateWriter: StateWriter,
  channelStateWriter: ChannelStateWriter,
  principalStateWriter: PrincipalStateWriter,
  sessionPipes: Map<string, SessionPipe>,
  processMonitor: ProcessMonitor,
  watchdog: Watchdog,
  opts: { skipPipeStop?: boolean; skipExit?: boolean } = {},
): Promise<{ stateSaved: boolean }> {
  if (shuttingDown) return { stateSaved: false };
  shuttingDown = true;
  log('info', `Received ${signal} — shutting down gracefully`);

  // Cancel pending shutdown-kill reclassifications — the suspend loop below is
  // now the single owner of every non-dead session's persisted state.
  for (const t of interruptedTimers.values()) clearTimeout(t);
  interruptedTimers.clear();

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

  // Channels v2 — stop the wake worker BEFORE sessions are torn down so a
  // pending Enter timer can never write into a disposed PTY.
  try { channelWakeWorkerRef?.stop(); } catch { /* best effort */ }
  channelWakeWorkerRef = null;

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
  // saveImmediate is non-throwing (returns false on write failure). Capture
  // the outcome so daemon.shutdown can report it (`stateSaved` additive) —
  // a false here means the suspended records did NOT land and the next boot
  // degrades to the 30s-snapshot recovery path (Codex review B′ #2).
  const stateSaved = stateWriter.saveImmediate(suspendState);
  if (!stateSaved) {
    log('error', 'Shutdown state save FAILED — suspended records not durable; next boot falls back to periodic snapshots');
  }
  phaseLog('stateSave', stateSaveStart, { sessions: managedSessions.length, stateSaved });

  // Dispose all sessions (kills PTYs, clears map)
  const disposeStart = phaseStartedAt();
  const disposedCount = sessionManager.listManagedSessions().length;
  sessionManager.disposeAll();
  phaseLog('disposeAll', disposeStart, { count: disposedCount });

  stateWriter.dispose();
  channelStateWriter.dispose();
  principalStateWriter.dispose();
  // 이벤트로그 스냅샷 flush(§6.4b) — pending projection 스냅샷을 durable로 소진.
  try {
    channelSnapshotStoreRef?.dispose();
  } catch (err) {
    log('warn', 'channel snapshot store dispose failed:', err);
  }

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
    return { stateSaved };
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
  // Shutdown-kill classification (reboot-reattach RCA 2026-07-02): a PTY exit
  // with the Windows console-teardown code, or ANY exit while our own graceful
  // shutdown is in flight, is an involuntary kill — suspend for recovery
  // instead of persisting a dead tombstone. See shutdownKill.ts for the RCA.
  sessionManager.setInvoluntaryExitClassifier((exitCode) =>
    isShutdownKillExit(exitCode, { platform: process.platform, shuttingDown }),
  );
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
  // ── 이벤트로그 부트 게이트 (envelope-design §6.1·§6.4 — PR3 배선) ──────────
  // 순서: 마이그레이션 감지→변환→검증→활성(runMigration, §6.1) → 로그 open(스캔
  // 복구+hwm 복원, §3) → 워터마크 판정(+필요 시 reseed, §6.4c) → dual-write
  // 스탬프/durable 활성(§6.4b·c). 이후 ChannelService가 로그 커밋 경로로 구동된다.
  const eventsDir = path.join(wmuxDir, 'events');
  const channelsJsonPath = path.join(wmuxDir, 'channels.json');
  let channelEventLogDeps: ChannelServiceEventLog | undefined;
  // 로그 정본 플래그(패널 CL-1): manifest가 durable 활성인 순간부터 레거시
  // channels.json 폴백은 로그-only 커밋을 유기하는 split-brain이다. fail-open은
  // manifest 생성 "전"의 마이그레이션 실패(레거시 무손상·§6.1-3)에만 허용한다.
  let logCanonical = false;
  try {
    // 기존 부트에서 이미 활성이면(runMigration 자체가 던져도) fail-closed 대상.
    // 파일 실존 기준(파싱 무관) — 손상 manifest도 로그-모드 물증이다(패널 델타).
    logCanonical = manifestFileExists(eventsDir);
    const migration = runMigration({
      eventsDir,
      // 레거시 부재(진짜 first-boot)는 null. 존재 시 기존 로더(리퍼·프로토타입
      // 가드 포함)로 READ만 한다 — 변환은 레거시를 절대 쓰지 않는다(§6.1-2).
      readLegacyState: () =>
        fs.existsSync(channelsJsonPath) ? channelStateWriter.load() : null,
      validateProjection: (d) => ChannelStateWriter.isChannelState(d),
      // 완결 직후 워터마크 스탬프 되쓰기(§6.4c pristine 창 봉합) — durable(§2.3).
      writeLegacyStamped: (stamped) => {
        channelStateWriter.saveImmediate(stamped, { durable: true });
      },
    });
    // runMigration 반환 = manifest durable 활성(신규·기존 불문). 이 지점부터 실패는
    // 레거시로 계속할 수 없다(위 플래그 주석).
    logCanonical = true;
    let manifest = migration.manifest;
    const channelEventLog = new AppendOnlyLog({
      dir: eventsDir,
      // §3-4 하한 클램프(PR2 배선 계약): 컴팩션-전소 부트에서도 스냅샷 좌표가
      // lamport/seq 재사용을 차단한다.
      hwmFloor: { lamport: manifest.snapshotLamport, seq: manifest.snapshotLamport },
    });
    channelEventLog.open();
    const channelSnapshots = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
    channelSnapshotStoreRef = channelSnapshots;
    // 워터마크 부트 판정(§6.4c) — 기존 로그-활성 부트에서만. 신규 마이그레이션은
    // 방금 genesis를 떴으므로 다운그레이드 창이 없고, 파일 부재는 reseed 대상이 아니다.
    if (migration.detection === 'active' && fs.existsSync(channelsJsonPath)) {
      const raw = channelStateWriter.load();
      const verdict = evaluateWatermark(raw);
      if (verdict.kind === 'downgrade-write') {
        log('warn', `channels.json 구-데몬 쓰기 감지(${verdict.reason}) — legacy-reseed 수행(§6.4c)`);
        const reseed = await performReseed({
          eventsDir,
          manifest,
          downgradeState: raw,
          append: (draft) => channelEventLog.append(draft),
          lamportHwm: () => channelEventLog.lamportHwm,
          origin: { machineId: migration.machineId, daemonEpoch: CHANNELS_EPOCH },
          // 데몬 자체 발행 감사 마커 — authz 비관여(§7 스탬핑 완전형은 PR5).
          authContext: { principalId: 'daemon', verifiedWorkspaceId: 'daemon', trustTier: 'trusted' },
          validateProjection: (d) => ChannelStateWriter.isChannelState(d),
          writeLegacyStamped: (stamped) => {
            channelStateWriter.saveImmediate(stamped, { durable: true });
          },
        });
        if (reseed.ok) {
          manifest = reseed.manifest;
        } else {
          // fail-closed (패널 CL-1): 다운그레이드(구-데몬이 channels.json에 직접 쓴 상태)를
          // 감지했으나 reseed가 완결되지 못했다 — 그 상태는 정본인 로그에 실리지 못했다.
          // 여기서 그대로 enableEventLogDualWrite로 진행하면 두 가지가 동시에 터진다:
          //   (1) 데몬이 다운그레이드 데이터가 빠진 로그 projection 위에서 구동되고
          //       (ChannelService는 channels.json이 아니라 로그에서 시드한다),
          //   (2) 직후 첫 dual-write가 channels.json을 fresh 워터마크로 되쓰며 그 안의
          //       다운그레이드 데이터까지 로그-파생 상태로 덮어써, "다음 부트 재시도"가
          //       의존하는 downgrade 신호(stale 워터마크)를 소거한다 — 조용한 split-brain
          //       + 데이터 유실. 부트를 실패시키면 channels.json은 stale 워터마크·데이터가
          //       무손상으로 남아 다음 부트가 downgrade를 재감지·reseed 재시도한다.
          //   append-failed는 디스크 결함이라 삼킬 수 없고, lamport-race는 single-instance
          //   부트 락 하에서 발생 불가하다. logCanonical=true이므로 아래 catch가 fail-closed
          //   재-throw한다(§6.1-4 활성 이후 실패 = 부트 중단).
          throw new Error(
            `legacy-reseed incomplete (${reseed.failReason ?? 'unknown'}) — fail-closed: ` +
              `log is canonical but downgrade state was not committed to the log ` +
              `(channels.json left untouched for next-boot retry)`,
          );
        }
      }
    }
    // 이후 모든 dual-write가 write-시점 워터마크(lamport+stateHash)를 싣고(§6.4c),
    // shutdown flush는 durable로 승격된다(§6.4b).
    channelStateWriter.enableEventLogDualWrite({
      stamp: (s) => stampWatermark(s, channelEventLog.lamportHwm),
      durableFlush: true,
    });
    channelEventLogDeps = {
      log: channelEventLog,
      snapshots: channelSnapshots,
      genesisRef: manifest.genesisRef,
      reseedRefs: manifest.reseedRefs,
      machineId: migration.machineId,
    };
    // §6.4a: 활성 formatVersion을 노출값으로 확정(로그 모드 활성 지점). fail-open
    // 경로(catch)는 이 줄에 도달하지 않으므로 undefined로 남아 ping이 필드를 뺀다.
    activeEventLogFormatVersion = manifest.formatVersion;
    log('info', `event log active (detection=${migration.detection}, lamport hwm=${channelEventLog.lamportHwm}, seg=${manifest.activeSegment})`);
  } catch (err) {
    if (logCanonical) {
      // fail-closed(패널 CL-1, 2-MODEL): 로그가 정본으로 활성된 뒤의 실패(open 절단
      // 실패·스냅샷 스토어 등)에서 레거시 커밋 경로로 계속하면, 로그에만 커밋된
      // 최신 채널 상태를 버리고 stale channels.json 위에 새 mutation을 쌓는
      // split-brain이 된다. 데몬 부트를 실패시키는 것이 조용한 데이터 유실보다 낫다.
      log('error', 'event log boot gate failed AFTER manifest activation — fail-closed:', err);
      throw err;
    }
    // fail-open: 마이그레이션 중단(§6.1-3)은 레거시 무손상·manifest 미기록이므로,
    // 이번 부트는 레거시 커밋 경로로 계속하고 다음 부트가 재시도한다(가용성 우선).
    // 조용히 로그 모드로 진행하는 것(§6.1-1 (c) fail-safe 위반)이 아니라 그 반대다.
    log('error', 'event log boot gate failed — legacy channels.json commit path for this boot:', err);
    channelSnapshotStoreRef = null;
  }
  // Principal registry (R2). Like channels, it writes its own file
  // (principals.json), so registry corruption does not spill into
  // session/channel state. The constructor backfills every pane-agent to stale
  // + seeds human:me (on restart the daemon cannot prove pane liveness, so only
  // a renderer re-registration brings it back to live). Constructed BEFORE the
  // channel service since 1b injects its display lookup below.
  const principalStateWriter = new PrincipalStateWriter(wmuxDir);
  const principalService = new PrincipalService({ writer: principalStateWriter });
  const channelService = new ChannelService({
    writer: channelStateWriter,
    // 이벤트로그 커밋 경로(§5) — 부트 게이트 성공 시에만. 실패 시 레거시 경로 유지.
    ...(channelEventLogDeps ? { eventLog: channelEventLogDeps } : {}),
    companyId: DEFAULT_COMPANY_ID,
    // 1b (server-owned roster identity): member rows derive their display
    // name from the principal registry at create/join/invite time.
    resolvePrincipalDisplay: (principalId) => principalService.find(principalId)?.display,
    // 1b/1d bridge (review F1/F2): CLI self-joins resolve their pane
    // principal from the verified pty so the seat gets the registry
    // display / canonical auto-name instead of an opaque ptyId. O(n) over
    // a small registry, called once per join.
    resolvePrincipalByPtyId: (ptyId) => {
      const rec = principalService.list().find((r) => r.ptyId === ptyId);
      return rec
        ? {
            id: rec.id,
            ...(rec.display ? { display: rec.display } : {}),
            ...(rec.memberId ? { memberId: rec.memberId } : {}),
          }
        : undefined;
    },
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
          // Channels v2 wake fast-path: a fresh post means someone may owe a
          // read — sweep soon instead of waiting for the next 15 s tick.
          // Correctness never depends on this (pull path owns it).
          channelWakeWorkerRef?.notifyChannelActivity();
        }
      } catch (err) {
        const ref = event.type === 'channel.catalog' ? event.channelId : `${event.channelId}#${event.seq}`;
        log('warn', `channel emit failed for ${ref}:`, err);
      }
    },
  });

  // ── A2A 태스크 데몬 정본 (envelope PR4 §5 D11 — 공유 로그) ──────────────
  // 채널과 **단일 AppendOnlyLog 인스턴스를 공유**한다(§2.1 단일 논리 스트림 —
  // lamport는 데몬 전역 단일 시계. 같은 events/에 인스턴스를 둘 열면 hwm이
  // 갈라져 lamport가 중복 발급된다). machineId도 게이트 산출물 재사용. 양쪽
  // replay는 각자 domain 필터로 자기 레코드만 소비한다(ChannelService :2560,
  // A2aTaskService.restoreFromLog). 부트 게이트가 비활성(레거시 fail-open)이면
  // A2A도 렌더러-only degrade — a2aSlice 30분 GC의 역사적 best-effort와 동형.
  let a2aTaskService: A2aTaskService | null = null;
  if (channelEventLogDeps) {
    try {
      const svc = new A2aTaskService({
        log: channelEventLogDeps.log,
        origin: { machineId: channelEventLogDeps.machineId, daemonEpoch: CHANNELS_EPOCH },
      });
      svc.restoreFromLog(); // 크로스-재시작: 태스크 projection 복원(비내구→내구 전환의 핵심 가치)
      a2aTaskService = svc;
      // A(패널): projection GC 주기 배선 — 렌더러 a2aSlice(useRpcBridge 5분 타이머)와
      // 동형. 이게 없으면 종단 태스크가 projection Map에 영구 적재된다(부트 GC는
      // restoreFromLog가 1회 수행하나 런타임 누적은 주기 GC 몫). unref로 이벤트
      // 루프를 붙잡지 않는다. 로그 상주분 절단은 §9 컴팩션 소관(별도).
      const a2aGcInterval = setInterval(() => {
        svc.gcTerminalTasks();
      }, 5 * 60 * 1000);
      a2aGcInterval.unref();
      log('info', `A2A task service active (shared log, tasks=${svc.taskCount})`);
    } catch (err) {
      // 서비스 복원 실패는 파국이 아니다 — A2A는 역사적으로 best-effort 비내구.
      // 렌더러-only로 degrade한다(a2aTaskService=null → 핸들러가 폴백 응답).
      log('warn', 'A2A task service unavailable — degrading to renderer-only A2A:', err);
    }
  } else {
    log('warn', 'A2A task service skipped — event log inactive this boot (legacy path)');
  }

  // ── WorkTask 미션 채널 데몬 정본 (J0 — 공유 로그) ─────────────────────
  // A2aTaskService와 동일하게 채널·A2A와 단일 AppendOnlyLog 인스턴스를 공유한다
  // (§2.1 단일 논리 스트림). replay는 domain:'task' 필터로 자기 레코드만 소비.
  // 부트 순서 고정(§1): replay → reconcile(양방향) → closed GC. 로그 미가용이면
  // 미션 RPC는 fail-closed(null → 핸들러가 명시 에러). await 부트는 register
  // 배선 전에 완료돼야 reconcile이 채널 상태를 정리한 뒤 첫 RPC를 받는다.
  let workTaskService: WorkTaskService | null = null;
  if (channelEventLogDeps) {
    try {
      const svc = new WorkTaskService({
        log: channelEventLogDeps.log,
        channels: channelService,
        origin: { machineId: channelEventLogDeps.machineId, daemonEpoch: CHANNELS_EPOCH },
        // 데몬은 오늘 ceoWorkspaceId를 알지 못한다(ChannelService.archive와 동일 —
        // 렌더러가 Company.ceoWorkspaceId 소유). CEO 예외 활성은 배선 후속.
        ceoWorkspaceId: undefined,
        // §5 배타 불변식의 realpath 해석기. 경로가 디스크에 실존하면 심링크를 풀고,
        // 부재면(fs 예외) 원본을 반환해 순수 문자열 정규화로 폴백한다.
        realpath: (p: string): string => {
          try {
            return fs.realpathSync(p);
          } catch {
            return p;
          }
        },
      });
      await svc.boot();
      workTaskService = svc;
      // closed GC 주기 배선(A2A projection GC와 동형). 부트 GC는 boot()가 1회 수행,
      // 런타임 누적은 주기 GC 몫. unref로 이벤트 루프를 붙잡지 않는다.
      const workTaskGcInterval = setInterval(() => {
        svc.gcClosedTasks();
      }, 60 * 60 * 1000);
      workTaskGcInterval.unref();
      log('info', `WorkTask mission service active (shared log, tasks=${svc.taskCount})`);
    } catch (err) {
      log('warn', 'WorkTask mission service unavailable — mission RPCs will fail closed:', err);
    }
  } else {
    log('warn', 'WorkTask mission service skipped — event log inactive this boot (legacy path)');
  }

  // Channels v2 Step 3a — the wake worker (see channelWakeWorker.ts for the
  // full strategy stack + safety rules). Adapters keep it decoupled: session
  // views come from the manager's live list, the workspace binding is the
  // SAME env-record read the Step 0 stamping uses, and writes go through the
  // session's PTY exactly like client keystrokes.
  channelWakeWorkerRef = new ChannelWakeWorker({
    memberWorkspaces: () => channelService.memberWorkspaces(),
    unreadFor: (ws) => channelService.unreadFor(ws),
    // R2: member row principalId → direct LIVE ptyId lookup. A stale principal
    // returns undefined and falls back to the existing slug heuristic.
    livePtyIdOf: (principalId) => principalService.livePtyIdOf(principalId),
    listLiveSessions: () =>
      sessionManager.listLiveSessions().map((meta) => ({
        id: meta.id,
        ...(meta.lastDetectedAgent !== undefined ? { lastDetectedAgent: meta.lastDetectedAgent as string } : {}),
        // Fail SAFE on a broken/missing timestamp (GLM review): a NaN getTime()
        // must not become 0, which reads as "quiet since the epoch" and makes
        // the pane permanently pass the quiet gate (perpetual nudge candidate).
        // Unknown last-activity ⇒ treat as JUST active ⇒ the quiet gate holds
        // off — the accelerator stays silent, the pull path still owns delivery.
        lastActivityMs: (() => {
          const t = new Date(meta.lastActivity).getTime();
          return Number.isFinite(t) ? t : Date.now();
        })(),
        // Same env-record binding the Step 0 stamping reads (main stamps
        // WMUX_WORKSPACE_ID into the session env at spawn; the daemon
        // persists it) — meta already carries env, no getSession round-trip.
        workspaceId: (meta.env?.[ENV_KEYS.WORKSPACE_ID] ?? '').trim(),
        // Dogfood G5: a recovered session still in deferred-output mode is
        // bookkept live but renders nothing and holds no agent — the worker
        // must never spend nudges on it.
        deferred: sessionManager.getSession(meta.id)?.deferred === true,
        // Attached ⇔ a renderer holds this session ⇔ the Stop-hook mention
        // path can deliver to Claude panes. Detached (headless) Claude panes
        // are the worker's job (Codex round-3).
        attached: meta.state === 'attached',
      })),
    // Contract: this MAY throw (a pane can die between target selection and
    // the write; writing a destroyed PTY stream throws synchronously — and a
    // session GONE from the manager throws here explicitly, because a silent
    // no-op would let inject() report success and burn the nudge budget with
    // zero bytes delivered, Codex re-review). Do NOT swallow either case —
    // the worker catches the throw itself, treats it as failed delivery, and
    // PRESERVES the budget for a retry (G5: never spend nudges into a void).
    // Its timer entry points are also guarded, so a throw can never escape
    // into the event loop.
    write: (sessionId, data) => {
      const managed = sessionManager.getSession(sessionId);
      if (!managed) throw new Error(`session ${sessionId} is gone`);
      managed.ptyProcess.write(data);
    },
    // Envelope discipline (channelEventEnvelope.ts, plan R2 lesson): the
    // control pipe carries DaemonEvent {type, sessionId, data} — a raw
    // payload broadcast would be silently unmatched by DaemonClient's
    // switch, which is exactly how channel.message was once lost. The
    // worker's one broadcast today is nudge exhaustion (human handoff).
    broadcast: (event) => {
      if (event['type'] === 'channel.nudgeExhausted') {
        pipeServer.broadcast({ type: 'channel.nudgeExhausted', sessionId: '', data: event });
      }
    },
    log: (level, message) => log(level, message),
    now: () => Date.now(),
  });
  // app-weight P1-1: cadence from config (default 15 s; clamped 5–120 s).
  const processMonitor = new ProcessMonitor((config.daemon.livenessIntervalSec ?? 15) * 1000);

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

  // PR2 레거시 마이그레이션: recovery(load) 전에 기존 sessions.json 주 파일 + 모든
  // .bak 슬롯에서 자격증명 값을 1회 스크럽. PR1이 사용자 셸 자격증명 투과를 열며 그
  // 값이 평문으로 영속되기 시작했으므로, 재기동 시 at-rest 자격증명을 제거한다.
  // (이후 정상 write는 StateWriter의 toPersistable로 자동 clean 유지.)
  scrubPersistedCredentials(wmuxDir);
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
    principalService,
    principalStateWriter,
    a2aTaskService,
    workTaskService,
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
    // R2: a dead session's pane-agent principal goes stale immediately — the
    // safety premise that keeps the wake worker from targeting a stale
    // principal's ptyId.
    try {
      principalService.markStaleByPtyId(payload.id);
    } catch (err) {
      log('warn', `principal stale-mark failed for ${payload.id}:`, err);
    }
  });
  sessionManager.on('session:destroyed', (payload: { id: string }) => {
    try {
      paneSupervisor.disarm(payload.id);
    } catch (err) {
      log('warn', `supervisor disarm failed for ${payload.id}:`, err);
    }
    // R2: the user-closed-pane path — the renderer's purge does the canonical
    // cleanup, but stale must still be guaranteed even in a window where the
    // renderer is dead (headless destroy).
    try {
      principalService.markStaleByPtyId(payload.id);
    } catch (err) {
      log('warn', `principal stale-mark failed for ${payload.id}:`, err);
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
  const doShutdown = async (sig: string): Promise<void> => {
    await shutdown(sig, sessionManager, pipeServer, stateWriter, channelStateWriter, principalStateWriter, sessionPipes, processMonitor, watchdog);
  };

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

  // Channels v2 — start the wake worker sweep (15 s tick + post fast-path).
  channelWakeWorkerRef?.start();

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
  }, (config.daemon.snapshotIntervalSec ?? 30) * 1000); // app-weight P1 knob (clamped 10–600 s)
  snapshotInterval.unref();

  // A1b — fire an initial snapshot at spawn so a crash within the first
  // 30 s leaves a recoverable .buf trace rather than nothing.
  void runSnapshotOnce();

  // 9. Signal handlers — doShutdown was hoisted above setCallbacks so
  // the idle-shutdown callback can reuse it.
  process.on('SIGTERM', () => doShutdown('SIGTERM'));
  process.on('SIGINT', () => doShutdown('SIGINT'));

  // Last-resort synchronous save on process exit — registered on ALL platforms.
  //
  // Windows: detached Node processes don't receive SIGTERM on OS shutdown and
  // 'beforeExit' won't fire, so 'exit' is the ONLY hook that runs; it is the
  // primary shutdown-save path there.
  //
  // macOS/Linux: the SIGTERM handler above runs the async shutdown() (demote to
  // suspended + fresh scrollback dump), and the 30s snapshot persists the
  // session list continuously. This 'exit' handler is a backstop for the paths
  // that DO reach a clean exit with dumps unfinished (process.exit() from the
  // shutdown timeout / uncaughtException, or an event-loop drain) — it does NOT
  // fire on an uncatchable SIGKILL, so on a hard reboot the async SIGTERM path
  // and the periodic snapshot remain the real durability guarantees. The
  // dumpsCompleted guard makes it a no-op when the async path already finished.
  {
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
