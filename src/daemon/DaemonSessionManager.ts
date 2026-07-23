import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonSession, DaemonSessionState, DaemonSessionSupervision, DaemonConfig } from './types';
import { RingBuffer } from './RingBuffer';
import { DaemonPTYBridge } from './DaemonPTYBridge';
import { PromptEventLog } from './PromptEventLog';
import { buildSpawnInjection, classifyShell } from './shell-integration';
import { expandTilde } from '../shared/expandTilde';
import { buildExecArgs } from './execWrapper';
import { buildSafeChildEnv } from '../shared/envFilter';
import { isMac } from '../shared/platform';
import { getWindowsDefaultShell, resolveBareShellName, resolveLaunchableWindowsExe } from '../shared/shellResolution';
import { ENV_KEYS } from '../shared/constants';
import { createDefaultConfig } from './config';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_BUFFER_SIZE = 512 * 1024; // 512 KB

/** The daemon's own RPC auth-token namespace — must never reach a child shell. */
const RESERVED_AUTH_PREFIX = /^WMUX_AUTH/i;
/** The full reserved wmux namespace (auth token + identity vars). */
const RESERVED_PREFIX = /^WMUX_/i;

/**
 * Return a fresh env copy with the daemon's reserved auth-token namespace
 * removed. Applied to every child env regardless of caller (substrate
 * invariant). WMUX_AUTH* is reserved, so this can never drop a legitimate
 * user/profile key.
 */
function stripReservedAuth(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (RESERVED_AUTH_PREFIX.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Return a fresh env copy with the ENTIRE reserved WMUX_* namespace removed
 * (auth token + identity). Used only for the process.env fallback — a caller
 * that doesn't pre-resolve has supplied no forced identity, so a daemon that
 * was itself launched from a wmux pane must not leak its inherited
 * WMUX_WORKSPACE_ID/SURFACE_ID/SOCKET_PATH into the session. Mirrors the
 * main-side resolveSpawnEnv baseline strip. NOT applied to a supplied env,
 * which intentionally carries main's already-forced identity.
 */
function stripReservedNamespace(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (RESERVED_PREFIX.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Internal type: session metadata + runtime resources.
 */
export interface ManagedSession {
  meta: DaemonSession;
  ptyProcess: IPty;
  ringBuffer: RingBuffer;
  bridge: DaemonPTYBridge;
  /** Structured prompt/command boundaries emitted by OSC 133 shell integration. */
  promptLog: PromptEventLog;
  /**
   * True when the session was created in deferred-output mode (recovery)
   * and is still waiting for its first `resizeSession` to activate.
   * Once `resizeSession` runs, output capture starts and this flips to
   * `false` for the rest of the session's lifetime.
   */
  deferred: boolean;
}

/**
 * Time to wait between resizing a deferred PTY and unmuting its data
 * forwarding. ConPTY emits any output queued at the prior geometry
 * synchronously after a resize; the delay lets that flush so we don't
 * capture mismatched-width bytes into the ring buffer.
 */
const DEFERRED_UNMUTE_DELAY_MS = 100;

/**
 * Narrowest PTY geometry the daemon will ever apply, on create or resize.
 *
 * Root cause (2026-07-04, deterministic repro): resizing an interactive zsh
 * (macOS zsh 5.9) to cols <= 6 crashes it with SIGBUS inside `zle.so`
 * `resetvideo`/`zrefresh` (EXC_BAD_ACCESS / KERN_PROTECTION_FAILURE, raised
 * from the SIGWINCH handler) — 6/6 in a node-pty harness at cols 2-6, 0/6 at
 * cols >= 7, rows irrelevant (80x1 survives). Split/layout transitions
 * transiently compute 2-5-col geometries (the renderer floors at 2), and that
 * is exactly when panes were dying "randomly". 10 leaves margin over the
 * observed 6/7 boundary, which may shift with prompt width or locale. The
 * renderer's xterm view can briefly be narrower than the PTY during a layout
 * transition — harmless compared to a dead shell, and the next settled resize
 * reconciles them.
 */
const MIN_SAFE_COLS = 10;
const MIN_SAFE_ROWS = 2;
const clampCols = (cols: number): number => Math.max(MIN_SAFE_COLS, cols);
const clampRows = (rows: number): number => Math.max(MIN_SAFE_ROWS, rows);

/**
 * Manages ConPTY session lifecycles within the daemon process.
 * No Electron dependencies — uses EventEmitter for all notifications.
 *
 * Events:
 *  - 'session:created'      → { session: DaemonSession }
 *  - 'session:destroyed'    → { id: string }
 *  - 'session:died'         → { id: string, exitCode: number | null }
 *  - 'session:interrupted'  → { id, exitCode, signal, cmd, lastActivityMsAgo }
 *      A PTY exit classified as involuntary (OS shutdown killing children —
 *      see shutdownKill.ts). The session is SUSPENDED, not dead: daemon/index
 *      dumps the buffer + persists so post-reboot recovery replays the same id.
 *  - 'session:stateChanged' → { id: string, state: DaemonSessionState }
 */
export class DaemonSessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private config: DaemonConfig | null = null;

  /**
   * Injected by daemon/index.ts (keeps this class free of platform/shutdown
   * knowledge). Returns true when a PTY exit is an involuntary teardown
   * (system shutdown) → suspend for recovery instead of marking dead.
   * Default: never — behavior identical to pre-fix unless wired.
   */
  private involuntaryExitClassifier: (exitCode: number | null, signal?: number) => boolean =
    () => false;

  setInvoluntaryExitClassifier(fn: (exitCode: number | null, signal?: number) => boolean): void {
    this.involuntaryExitClassifier = fn;
  }

  /** Optionally set config so that session.bufferSizeMb is respected. */
  setConfig(config: DaemonConfig): void {
    this.config = config;
  }

  createSession(params: {
    id: string;
    cmd: string;
    cwd: string;
    /**
     * The child environment. When provided it is treated as AUTHORITATIVE and
     * replayed verbatim — the caller (main process) has already run
     * buildSafeChildEnv + any workspace-profile overlay + forced identity, so
     * the daemon must NOT re-filter it (re-filtering would strip an intentional
     * *_KEY/*_TOKEN). Only the `?? process.env` fallback is filtered, for
     * direct/legacy callers that don't pre-resolve. This keeps the daemon
     * profile-agnostic and makes recovery (which replays the persisted
     * meta.env) reproduce the exact create-time environment.
     */
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
    agent?: { role: string; teamId: string; displayName: string };
    createdAt?: string;
    /**
     * Recovery passes the session's persisted lastActivity so the TTL reaper
     * can age out stale orphan shells (#557). Without this, createSession
     * stamps `now` on every boot, immortalising resurrected detached sessions.
     * Omitted for brand-new sessions, which correctly start at `now`.
     */
    lastActivity?: string;
    /**
     * Recovery passes the session's persisted per-session dead-TTL so a
     * recovered session keeps its create-time retention instead of being
     * restamped from the current config (codex P2). Omitted for brand-new
     * sessions, which take the config default.
     */
    deadTtlHours?: number;
    scrollbackData?: Buffer;
    /**
     * v2.8.1 hotfix: when true, the bridge starts muted so PTY output
     * is dropped until `resizeSession` fires. Recovery uses this so the
     * 80x24-vs-renderer-cols/rows mismatch window can't garble the
     * terminal display. The pre-filled `scrollbackData` (historical
     * buffer dump) is unaffected — it lives in the ring buffer
     * directly, not on the muted PTY data path.
     */
    deferOutput?: boolean;
    /**
     * X8 exec-style unit: run `command` as the pane's root process via a
     * non-interactive wrapper shell (params.cmd, when classifiable, else a
     * known-good platform shell). Persisted on meta so recovery and the
     * supervisor replay the command itself, not an empty shell. OSC 133
     * shell integration is skipped (no prompt to mark).
     */
    exec?: { command: string };
    /**
     * X6 resume: a NON-persisted launch command used ONLY to spawn this
     * replay. When set (replay paths whose agent should resume — see
     * agentResume.toResumeCommand), buildExecArgs runs THIS command (e.g.
     * `claude --continue`) while `meta.exec.command` still stores the ORIGINAL
     * (`claude`). So first launch stays fresh, the badge/`wmux list` show the
     * launch command, and a restart/reboot revives the conversation. Ignored
     * unless `exec` is also set. Defaults to `exec.command`.
     */
    execLaunchCommand?: string;
    /**
     * X8 supervision policy + sticky status. Fresh creates pass
     * status:'armed'; recovery replays the persisted value so a
     * runaway-guard 'stopped' survives reboots.
     */
    supervision?: DaemonSessionSupervision;
  }): DaemonSession {
    // Validate session ID to prevent path traversal, injection, or oversized keys
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(params.id)) {
      throw new Error(`Invalid session ID: must be 1-64 chars of [a-zA-Z0-9_-]`);
    }

    // Resolve effective config once. The daemon main calls setConfig()
    // before any createSession(); the createDefaultConfig() fallback only
    // covers tests / early-boot paths and keeps the default SSOT in
    // config.ts (createDefaultConfig) rather than re-hardcoding 200 / 24 here.
    const cfg = this.config ?? createDefaultConfig();

    // Guard against resource exhaustion from unbounded session creation.
    // Substrate 3.0 Tier-2 floor: refuse the new session (RESOURCE_EXHAUSTED)
    // — never evict an existing one to make room. The error message is
    // user-facing, so phrase it as an action the user can actually take.
    // The ceiling is configurable via session.maxSessions (default 200);
    // startup recovery derives its own soft cap as min(maxSessions, 40).
    //
    // Count only LIVE PTYs (attached/detached). DEAD tombstones linger in the
    // map until the TTL/memory reaper runs but hold no live PTY — counting
    // them would wrongly reject a new session under a low maxSessions the
    // moment a PTY dies (codex P2). `suspended` never sits in this runtime
    // map (it is a disk-only state the shutdown path demotes live sessions to
    // before persisting, and recovery re-creates them as `detached`).
    const maxSessions = cfg.session.maxSessions;
    let liveCount = 0;
    for (const m of this.sessions.values()) {
      if (m.meta.state === 'attached' || m.meta.state === 'detached') liveCount++;
    }
    if (liveCount >= maxSessions) {
      throw new Error(
        `Cannot create new terminal: ${maxSessions} active sessions already running. ` +
          `Close some panes (or restart wmux) and try again.`,
      );
    }

    if (this.sessions.has(params.id)) {
      throw new Error(`Session '${params.id}' already exists`);
    }

    // Clamped for the same reason as resizeSession: spawning zsh directly INTO
    // a <=6-col PTY hits the same zle.so SIGBUS as resizing into one.
    const cols = clampCols(params.cols ?? DEFAULT_COLS);
    const rows = clampRows(params.rows ?? DEFAULT_ROWS);
    // Expand a leading `~`: this cwd can arrive straight off an RPC/CLI/MCP
    // argument that no shell ever touched, so `~/projects/foo` would otherwise
    // stay literal and silently fall back to $HOME (or throw as an unreadable
    // cwd). Single choke point — every caller-supplied cwd converges here.
    const cwd = params.cwd ? expandTilde(params.cwd) : os.homedir();
    let cmd = this.resolveShellPath(params.cmd) || this.getDefaultShell();

    // Resolve the child environment. A caller-supplied env is AUTHORITATIVE —
    // main already ran buildSafeChildEnv + the workspace-profile overlay +
    // forced identity, and recovery replays the persisted (already-resolved)
    // meta.env. Re-filtering here would strip an intentional *_KEY/*_TOKEN, so
    // we trust a supplied env verbatim and only filter the process.env fallback
    // (direct/legacy callers that don't pre-resolve). The daemon stays
    // profile-agnostic — it never needs to know what a "profile" is.
    //
    // SUBSTRATE INVARIANT (not profile policy): regardless of caller, the
    // daemon's own RPC auth token must never reach a child shell. We always
    // drop the WMUX_AUTH* namespace even from a supplied env — it is reserved
    // (a profile can never set it) so this can't strip a user/profile key. This
    // bounds the trusted-env contract: a misbehaving/legacy caller that passes
    // a raw env can at worst leak ITS inherited vars, never wmux's auth token.
    //
    // The fallback (no supplied env) carries NO caller-forced identity, so it
    // also drops the whole WMUX_* namespace — otherwise a daemon launched from
    // a wmux pane would leak its own inherited WMUX_WORKSPACE_ID/SURFACE_ID/
    // SOCKET_PATH into a session that should have none. Mirrors resolveSpawnEnv.
    // KNOWN LIMITATION: a supplied env is replayed verbatim (minus AUTH), so a
    // sessions.json written before the main-side identity-strip fix can still
    // carry a stale identity on recovery. New sessions persist a clean env;
    // pre-fix contaminated blobs are accepted rather than migrated (re-deriving
    // identity on replay would need session→workspace/surface plumbing the
    // daemon deliberately does not have).
    const env = params.env
      ? stripReservedAuth(params.env)
      : stripReservedNamespace(buildSafeChildEnv(globalThis.process.env));

    // X6 ③: stamp the pane's own daemon session id into its env so the Claude
    // hook bridge can attribute its resume-binding capture to the EXACT pane
    // (per-pane routing). The daemon is the only layer that knows this id at
    // spawn time — the renderer cannot supply a surfaceId at pty.create because
    // a surface is minted only AFTER the pty exists, so WMUX_SURFACE_ID never
    // reaches the shell. Set AFTER the reserved-namespace strip so it survives;
    // recovery replays meta.env (and re-stamps the same id), keeping it stable
    // across reboot. This is the join key the spool ingest matches on.
    env[ENV_KEYS.PTY_ID] = params.id;

    // Instance-isolation suffix: force the child onto THIS daemon's instance (its
    // own inherited WMUX_DATA_SUFFIX), overriding whatever a replayed session.env
    // blob carried. The recovery path above runs stripReservedAuth, which strips
    // only WMUX_AUTH* — so a persisted (or hand-edited) WMUX_DATA_SUFFIX would
    // otherwise survive verbatim and could point a recovered pane at a DIFFERENT
    // instance's control pipe. Sourced ONLY from the daemon's own process.env (the
    // authoritative instance key, inherited from main at spawn), never a child-
    // supplied value. The delete branch is the security-critical half: a
    // production daemon (no suffix) recovering a '-dev'-tainted blob must SCRUB the
    // key, not leave the child on the dev pipe.
    // Scrub ANY case-variant first (a replayed / hand-edited blob may carry
    // `wmux_data_suffix` or mixed case; Windows process env is case-insensitive,
    // so a stray variant would otherwise reach the child even after we set the
    // canonical key). Then apply the daemon's own value, or leave it absent.
    for (const k of Object.keys(env)) {
      if (k.toUpperCase() === ENV_KEYS.DATA_SUFFIX) delete env[k];
    }
    if (globalThis.process.env[ENV_KEYS.DATA_SUFFIX]) {
      env[ENV_KEYS.DATA_SUFFIX] = globalThis.process.env[ENV_KEYS.DATA_SUFFIX] as string;
    }

    let spawnArgs: string[] = [];
    if (params.exec) {
      // X8 exec unit: the command IS the pane process — no interactive
      // shell session, so OSC 133 injection is skipped (no prompt to mark,
      // and injection args would collide with the wrapper argv). When the
      // resolved shell's family is unknown we swap to a known-good platform
      // shell rather than guess argv for it.
      //
      // X6: spawn the (possibly resume-rewritten) launch command, but persist
      // the ORIGINAL below (meta.exec.command). Replay-only callers set
      // execLaunchCommand; brand-new sessions omit it → spawn === persisted.
      const launchCommand = params.execLaunchCommand ?? params.exec.command;
      let execArgs = buildExecArgs(cmd, launchCommand);
      if (!execArgs) {
        cmd = this.resolveExecFallbackShell();
        execArgs = buildExecArgs(cmd, launchCommand);
      }
      if (!execArgs) {
        throw new Error(`No usable wrapper shell for exec session (resolved: ${cmd})`);
      }
      spawnArgs = execArgs;
    } else {
      // Shell integration: dot-source our OSC 133 init script when the shell
      // is a supported family (pwsh/bash). Unknown shells (cmd.exe, zsh, etc.)
      // get a plain spawn with no args and silently skip integration.
      try {
        const injection = buildSpawnInjection(cmd);
        if (injection) {
          // zsh ZDOTDIR 가로채기: injection이 ZDOTDIR을 wmux 디렉토리로 덮어쓰기
          // 전에, 사용자의 원래 ZDOTDIR(없으면 HOME)을 WMUX_USER_ZDOTDIR로 보존한다.
          // stub .zshenv/.zshrc가 이 값으로 사용자 설정을 복원하므로, 보존을
          // 빠뜨리면 사용자 .zshrc(PATH/alias 등)가 통째로 날아간다.
          if (classifyShell(cmd) === 'zsh' && !env['WMUX_USER_ZDOTDIR']) {
            env['WMUX_USER_ZDOTDIR'] = env['ZDOTDIR'] || env['HOME'] || os.homedir();
          }
          spawnArgs = injection.args;
          for (const [k, v] of Object.entries(injection.env)) {
            env[k] = v;
          }
        }
      } catch (err) {
        // Integration install failure must not break session creation.
        // eslint-disable-next-line no-console
        console.warn('[DaemonSessionManager] shell integration unavailable:', err);
      }
    }

    // Spawn the PTY. node-pty throws synchronously on a missing/invalid shell
    // binary or an unreadable cwd — common on macOS/Linux where the resolved
    // shell path differs from Windows. Surface an actionable message instead of
    // letting the raw node-pty error propagate as an opaque session-create
    // failure. (useConpty is a Windows-only hint; node-pty ignores it elsewhere.)
    let ptyProcess: IPty;
    try {
      ptyProcess = pty.spawn(cmd, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        useConpty: true,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to start shell "${cmd}" in "${cwd}": ${detail}`);
    }

    const now = new Date().toISOString();
    const meta: DaemonSession = {
      id: params.id,
      state: 'detached',
      createdAt: params.createdAt ?? now,
      // #557: recovery passes the persisted timestamp; a brand-new session
      // takes `now`. Resetting to `now` unconditionally (the old behaviour)
      // immortalised orphan shells — a TTL could never fire post-restart.
      lastActivity: params.lastActivity ?? now,
      pid: ptyProcess.pid,
      cmd,
      cwd,
      env,
      cols,
      rows,
      // Per-session dead-TTL. codex #5: captured at create time and the
      // reaper reads the per-session value, so a later config change applies
      // only to NEW sessions. Recovery passes the persisted value
      // (params.deadTtlHours) so a recovered session keeps its create-time
      // retention; a brand-new session takes the current config default
      // (codex P2 — recovery must not silently restamp existing retention).
      deadTtlHours: params.deadTtlHours ?? cfg.session.deadSessionTtlHours,
    };
    if (params.agent) {
      meta.agent = params.agent;
    }
    if (params.exec) {
      meta.exec = { command: params.exec.command };
    }
    if (params.supervision) {
      // Own copy — meta is persisted via buildState and must not alias
      // caller-held objects (recovery replays the persisted blob verbatim).
      meta.supervision = {
        restart: params.supervision.restart,
        limit: { ...params.supervision.limit },
        status: params.supervision.status,
        // U-PERM: carry the consent-gated restore bit into the persisted meta so
        // recovery/restart replay can honor it. Omitted from the own-copy above
        // would silently disable the whole feature (tsc-invisible: optional field).
        ...(params.supervision.restorePermissionMode === true ? { restorePermissionMode: true } : {}),
      };
    }

    // Ring buffer for scrollback — use config's bufferSizeMb if available
    const bufferSize = this.config
      ? this.config.session.bufferSizeMb * 1024 * 1024
      : DEFAULT_BUFFER_SIZE;
    const ringBuffer = new RingBuffer(bufferSize);

    // Pre-fill ring buffer with saved scrollback (session recovery)
    if (params.scrollbackData && params.scrollbackData.length > 0) {
      ringBuffer.write(params.scrollbackData);
    }

    // Bridge: PTY data → RingBuffer + events
    const bridge = new DaemonPTYBridge();
    const promptLog = new PromptEventLog();

    const deferred = params.deferOutput === true;
    const managed: ManagedSession = {
      meta,
      ptyProcess,
      ringBuffer,
      bridge,
      promptLog,
      deferred,
    };
    this.sessions.set(params.id, managed);

    // Forward bridge events to manager-level events
    bridge.on('idle', (payload) => {
      meta.lastActivity = new Date().toISOString();
      this.emit('session:idle', payload);
    });

    // 'active' (start of an output burst), 'agent' (AgentDetector status
    // event), 'critical' (sensitive action approval request): forward to
    // session manager so daemon/index.ts can broadcast them to the main
    // process. Without this re-emission, daemon mode loses all notification
    // signal even though DaemonPTYBridge detects it correctly.
    bridge.on('active', (payload) => {
      this.emit('session:active', payload);
    });

    bridge.on('agent', (payload) => {
      this.emit('session:agent', payload);
    });

    bridge.on('critical', (payload) => {
      this.emit('session:critical', payload);
    });

    // OSC 133 shell integration markers — daemon-side parsing populates
    // PromptEventLog (canonical, byte-offset indexed); this re-emit teases
    // out the same parsed PromptEvent so main-process notification routing
    // can tee the D (command_end) marker to the EventBus as a
    // `source:'osc133'` agent.lifecycle event. Without it, daemon-backed
    // panes (the default production path) miss osc133 lifecycle entirely
    // even though the daemon detects every marker correctly.
    bridge.on('prompt', (payload) => {
      this.emit('session:prompt', payload);
    });

    // Desktop-notification sequences (OSC 9/777/99) parsed in the bridge.
    // Re-emitted so daemon/index.ts can broadcast them to main, which tees
    // them onto the EventBus as `notification.received` — same projection
    // pattern as session:prompt above.
    bridge.on('notification', (payload) => {
      this.emit('session:notification', payload);
    });

    bridge.on('cwd', (payload: { sessionId: string; cwd: string }) => {
      // Change-guard: OSC 7 / prompt scrape can re-report the SAME cwd on every
      // prompt. Only act on a real change so the daemon/index.ts persistence
      // write (and the renderer broadcast) fire on cd, not on every prompt —
      // keeps the immediate cwd persistence cheap (no write amplification).
      if (meta.cwd === payload.cwd) return;
      meta.cwd = payload.cwd;
      // Forward across the daemon→main boundary so the renderer can live-update
      // the per-surface cwd (tab tooltip + "Working directories" menu). Without
      // this, daemon mode (the default path) only kept cwd in daemon-local
      // meta and the UI never saw a change. Mirrors the session:prompt tee.
      this.emit('session:cwd', payload);
    });

    bridge.on('title', (payload: { sessionId: string; title: string }) => {
      // Forward across the daemon→main boundary so the renderer can set the
      // per-surface tab title (e.g. Claude Code `/rename`). Mirrors session:cwd.
      this.emit('session:title', payload);
    });

    bridge.on('data', () => {
      meta.lastActivity = new Date().toISOString();
    });

    bridge.on('exit', (payload: { sessionId: string; exitCode: number | null; signal?: number }) => {
      // Shutdown-kill classification (reboot-reattach RCA 2026-07-02): an OS
      // shutdown kills PTY children before the daemon. Persisting those exits
      // as 'dead' purged exactly the in-use sessions from recovery. Classified
      // exits suspend instead — recovery replays them under the same id.
      const involuntary = this.involuntaryExitClassifier(payload.exitCode, payload.signal);
      meta.state = involuntary ? 'suspended' : 'dead';
      meta.exitCode = payload.exitCode;
      // Clean up bridge timers/listeners to prevent leaks when sessions die naturally
      managed.bridge.cleanup();
      // Enrich the death event with forensics so the daemon can log WHY a PTY
      // exited: code/signal, the shell, and how long it had been idle before
      // dying. Silent PTY deaths (no log, no recorded exitCode) made the
      // "powershell exits -1 under claude" report undiagnosable.
      const lastActivityMsAgo = Date.now() - new Date(meta.lastActivity).getTime();
      const forensics = {
        id: params.id,
        exitCode: payload.exitCode,
        signal: payload.signal,
        cmd: meta.cmd,
        lastActivityMsAgo,
      };
      if (involuntary) {
        this.emit('session:interrupted', forensics);
        this.emit('session:stateChanged', { id: params.id, state: 'suspended' as DaemonSessionState });
        return;
      }
      this.emit('session:died', forensics);
      this.emit('session:stateChanged', { id: params.id, state: 'dead' as DaemonSessionState });
    });

    // Set up data forwarding (PTY → RingBuffer + events), hooking the
    // prompt/command log so OSC 133 markers populate a structured journal.
    // For deferred (recovery) sessions we mute the data path before any
    // PTY output can land — `resizeSession` unmutes once the renderer's
    // true geometry is known.
    if (deferred) {
      bridge.setMuted(true);
    }
    bridge.setupDataForwarding(ptyProcess, ringBuffer, params.id, promptLog);

    this.emit('session:created', { session: { ...meta } });
    return { ...meta };
  }

  destroySession(id: string): void {
    const managed = this.sessions.get(id);
    if (!managed) return;

    managed.bridge.cleanup();
    try {
      managed.ptyProcess.kill();
    } catch {
      /* already dead */
    }
    this.sessions.delete(id);
    this.emit('session:destroyed', { id });
  }

  /**
   * X8 supervised restart: drop a DEAD tombstone from the map with no
   * destroy side effects, so the supervisor can re-create the SAME session
   * id (createSession throws on a duplicate id). The died handler already
   * ran bridge.cleanup() and the PTY is gone — kill would be redundant, and
   * emitting 'session:destroyed' here would be wrong twice over: the
   * supervisor reads destroyed as "user closed the pane → disarm", and the
   * daemon broadcasts it to main as pane teardown. A restart must look like
   * died → (silence) → restarted, never like a destroy.
   */
  removeTombstone(id: string): boolean {
    const managed = this.sessions.get(id);
    if (!managed) return false;
    if (managed.meta.state !== 'dead') {
      throw new Error(`removeTombstone('${id}'): session is '${managed.meta.state}', not 'dead'`);
    }
    this.sessions.delete(id);
    return true;
  }

  /**
   * X8: undo removeTombstone when the restart's createSession failed (live
   * cap, transient ConPTY error). Without re-insertion the session would
   * vanish from the map — and therefore from sessions.json, the badge, and
   * the rearm target — on a spawn hiccup. The managed record is the exact
   * object removeTombstone unlinked: PTY already dead, bridge already
   * cleaned, so holding it costs nothing.
   */
  reinsertSession(managed: ManagedSession): void {
    if (managed.meta.state !== 'dead') {
      throw new Error(`reinsertSession('${managed.meta.id}'): session is '${managed.meta.state}', not 'dead'`);
    }
    if (this.sessions.has(managed.meta.id)) {
      throw new Error(`reinsertSession('${managed.meta.id}'): id already present`);
    }
    this.sessions.set(managed.meta.id, managed);
  }

  attachSession(id: string): void {
    const managed = this.sessions.get(id);
    if (!managed) throw new Error(`Session '${id}' not found`);
    // 'suspended' holds no live ptyProcess (shutdown-kill classification —
    // see shutdownKill.ts): the RPC handler would wire a fresh SessionPipe
    // straight into a destroyed process. Reject like 'dead' so the caller's
    // existing retry/backoff path handles it instead of crashing the daemon.
    if (managed.meta.state === 'dead') throw new Error(`Session '${id}' is dead`);
    if (managed.meta.state === 'suspended') throw new Error(`Session '${id}' is suspended`);

    managed.meta.state = 'attached';
    this.emit('session:stateChanged', { id, state: 'attached' as DaemonSessionState });
  }

  detachSession(id: string): void {
    const managed = this.sessions.get(id);
    if (!managed) throw new Error(`Session '${id}' not found`);
    if (managed.meta.state === 'dead') throw new Error(`Session '${id}' is dead`);

    managed.meta.state = 'detached';
    this.emit('session:stateChanged', { id, state: 'detached' as DaemonSessionState });
  }

  resizeSession(id: string, cols: number, rows: number): void {
    const managed = this.sessions.get(id);
    if (!managed) throw new Error(`Session '${id}' not found`);
    if (managed.meta.state === 'dead') throw new Error(`Session '${id}' is dead`);
    // Same rationale as attachSession — no live ptyProcess to resize.
    if (managed.meta.state === 'suspended') throw new Error(`Session '${id}' is suspended`);

    // Floor the geometry (MIN_SAFE_COLS — the zle.so SIGBUS guard) and skip
    // the SIGWINCH entirely when the effective geometry is unchanged: split/
    // layout transitions re-send the same or transiently-degenerate sizes on
    // every frame, and each avoided TIOCSWINSZ is one less signal delivered
    // into the shell.
    const safeCols = clampCols(cols);
    const safeRows = clampRows(rows);
    if (safeCols !== managed.meta.cols || safeRows !== managed.meta.rows) {
      managed.ptyProcess.resize(safeCols, safeRows);
      managed.meta.cols = safeCols;
      managed.meta.rows = safeRows;
      // Resize-redraw guard: stamp the bridge so the TUI's repaint burst
      // (arriving within RESIZE_REDRAW_GUARD_MS) does not reset the
      // AgentDetector emission dedup and re-fire stale prompt matches.
      managed.bridge.noteResize();
    }

    // First resize on a deferred (recovery) session unmutes data
    // capture. The 100ms delay drains any pre-resize output ConPTY
    // queued at the saved/default geometry.
    if (managed.deferred) {
      managed.deferred = false;
      const sessionId = id;
      setTimeout(() => {
        const current = this.sessions.get(sessionId);
        if (!current) return;
        current.bridge.setMuted(false);
      }, DEFERRED_UNMUTE_DELAY_MS).unref?.();
    }
  }

  listSessions(): DaemonSession[] {
    return Array.from(this.sessions.values()).map((m) => ({ ...m.meta }));
  }

  /**
   * Return only sessions that hold a usable PTY child — `attached` or
   * `detached`. Excludes `dead` (PTY exited, scrollback retained until
   * the reap TTL fires up to 24h later) and `suspended` (recovery
   * cap-skipped, no live PTY behind the metadata).
   *
   * Watchdog idle-shutdown uses this so a daemon whose only remaining
   * sessions are tombstones can self-terminate instead of waiting for
   * the dead-TTL reaper. Other lifecycle introspection (e.g. health
   * endpoints, MCP `is anyone using the daemon?` probes) should call
   * this rather than re-implementing the filter at each site.
   */
  listLiveSessions(): DaemonSession[] {
    return Array.from(this.sessions.values())
      .filter((m) => m.meta.state === 'attached' || m.meta.state === 'detached')
      .map((m) => ({ ...m.meta }));
  }

  getSession(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  /** Return all managed sessions (for shutdown buffer dump). */
  listManagedSessions(): ManagedSession[] {
    return Array.from(this.sessions.values());
  }

  disposeAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.destroySession(id);
    }
  }

  /** Resolve a bare shell name (e.g. 'powershell.exe') to an absolute path. */
  private resolveShellPath(cmd: string | undefined): string | null {
    if (!cmd) return null;
    // Already absolute?
    if (path.isAbsolute(cmd)) {
      // On Windows the path may be a Store App Execution Alias that
      // existsSync misses and node-pty cannot spawn — resolve it (#179/#183).
      if (process.platform === 'win32') return resolveLaunchableWindowsExe(cmd);
      try { if (fs.existsSync(cmd)) return cmd; } catch { /* fall through */ }
      return null;
    }
    // Bare name — shared well-known location tables (win/mac/linux), single
    // source with the main process (#185).
    const resolved = resolveBareShellName(cmd);
    if (resolved) return resolved;
    return cmd; // fallback to original (let pty.spawn try PATH)
  }

  /**
   * Wrapper shell for an exec unit whose resolved shell has no known argv
   * shape (e.g. nushell). Windows always resolves to a PowerShell family
   * via getDefaultShell; POSIX prefers bash (login-shell PATH semantics)
   * and falls back to the always-present /bin/sh.
   */
  private resolveExecFallbackShell(): string {
    if (process.platform === 'win32') return this.getDefaultShell();
    try {
      if (fs.existsSync('/bin/bash')) return '/bin/bash';
    } catch {
      /* fall through */
    }
    return '/bin/sh';
  }

  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      // Shared resolution (#183): PowerShell 7 first (traditional install OR
      // Store App Execution Alias, resolved to its spawnable package target),
      // then Windows PowerShell 5.1 — the exact same priority and candidate
      // table as the main process's ShellDetector (#176/#179).
      return getWindowsDefaultShell();
    }
    if (isMac) return process.env.SHELL || '/bin/zsh';
    return process.env.SHELL || '/bin/bash';
  }
}
