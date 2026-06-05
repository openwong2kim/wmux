import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import os from 'node:os';
import type { DaemonSession, DaemonSessionState, DaemonConfig } from './types';
import { RingBuffer } from './RingBuffer';
import { DaemonPTYBridge } from './DaemonPTYBridge';
import { PromptEventLog } from './PromptEventLog';
import { buildSpawnInjection } from './shell-integration';
import { buildSafeChildEnv } from '../shared/envFilter';
import { isMac } from '../shared/platform';
import { createDefaultConfig } from './config';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_BUFFER_SIZE = 512 * 1024; // 512 KB

/** The daemon's own RPC auth-token namespace — must never reach a child shell. */
const RESERVED_AUTH_PREFIX = /^WMUX_AUTH/i;

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
 * Manages ConPTY session lifecycles within the daemon process.
 * No Electron dependencies — uses EventEmitter for all notifications.
 *
 * Events:
 *  - 'session:created'      → { session: DaemonSession }
 *  - 'session:destroyed'    → { id: string }
 *  - 'session:died'         → { id: string, exitCode: number | null }
 *  - 'session:stateChanged' → { id: string, state: DaemonSessionState }
 */
export class DaemonSessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private config: DaemonConfig | null = null;

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

    const cols = params.cols ?? DEFAULT_COLS;
    const rows = params.rows ?? DEFAULT_ROWS;
    const cwd = params.cwd || os.homedir();
    const cmd = this.resolveShellPath(params.cmd) || this.getDefaultShell();

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
    const env = stripReservedAuth(params.env ?? buildSafeChildEnv(globalThis.process.env));

    // Shell integration: dot-source our OSC 133 init script when the shell
    // is a supported family (pwsh/bash). Unknown shells (cmd.exe, zsh, etc.)
    // get a plain spawn with no args and silently skip integration.
    let spawnArgs: string[] = [];
    try {
      const injection = buildSpawnInjection(cmd);
      if (injection) {
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
      lastActivity: now,
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

    bridge.on('cwd', (payload: { sessionId: string; cwd: string }) => {
      meta.cwd = payload.cwd;
    });

    bridge.on('data', () => {
      meta.lastActivity = new Date().toISOString();
    });

    bridge.on('exit', (payload: { sessionId: string; exitCode: number | null; signal?: number }) => {
      meta.state = 'dead';
      meta.exitCode = payload.exitCode;
      // Clean up bridge timers/listeners to prevent leaks when sessions die naturally
      managed.bridge.cleanup();
      // Enrich the death event with forensics so the daemon can log WHY a PTY
      // exited: code/signal, the shell, and how long it had been idle before
      // dying. Silent PTY deaths (no log, no recorded exitCode) made the
      // "powershell exits -1 under claude" report undiagnosable.
      const lastActivityMsAgo = Date.now() - new Date(meta.lastActivity).getTime();
      this.emit('session:died', {
        id: params.id,
        exitCode: payload.exitCode,
        signal: payload.signal,
        cmd: meta.cmd,
        lastActivityMsAgo,
      });
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

  attachSession(id: string): void {
    const managed = this.sessions.get(id);
    if (!managed) throw new Error(`Session '${id}' not found`);
    if (managed.meta.state === 'dead') throw new Error(`Session '${id}' is dead`);

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

    managed.ptyProcess.resize(cols, rows);
    managed.meta.cols = cols;
    managed.meta.rows = rows;

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
    const fs = require('fs');
    const path = require('path');
    // Already absolute?
    if (path.isAbsolute(cmd)) {
      try { if (fs.existsSync(cmd)) return cmd; } catch {}
      return null;
    }
    // Bare name — try well-known Windows locations
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const lookup: Record<string, string[]> = {
        'powershell.exe': [
          `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        ],
        'pwsh.exe': [
          `${progFiles}\\PowerShell\\7\\pwsh.exe`,
        ],
        'cmd.exe': [
          `${systemRoot}\\System32\\cmd.exe`,
        ],
        'bash.exe': [
          `${systemRoot}\\System32\\bash.exe`,
          `${progFiles}\\Git\\bin\\bash.exe`,
        ],
        'wsl.exe': [
          `${systemRoot}\\System32\\wsl.exe`,
        ],
      };
      const basename = path.basename(cmd).toLowerCase();
      const candidates = lookup[basename] || [];
      for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch {}
      }
    } else if (process.platform === 'darwin') {
      // mac: common shell names → absolute paths.
      const lookup: Record<string, string[]> = {
        'zsh': ['/bin/zsh'],
        'bash': ['/bin/bash'],
        'pwsh': ['/opt/homebrew/bin/pwsh', '/usr/local/bin/pwsh'],
        'fish': ['/opt/homebrew/bin/fish', '/usr/local/bin/fish'],
      };
      const basename = path.basename(cmd).toLowerCase();
      const candidates = lookup[basename] || [];
      for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch {}
      }
    } else if (process.platform === 'linux') {
      // linux: common shell names → absolute paths.
      const lookup: Record<string, string[]> = {
        'bash': ['/bin/bash'],
        'zsh': ['/usr/bin/zsh', '/bin/zsh'],
        'pwsh': ['/usr/bin/pwsh', '/snap/bin/pwsh'],
        'fish': ['/usr/bin/fish'],
      };
      const basename = path.basename(cmd).toLowerCase();
      const candidates = lookup[basename] || [];
      for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch {}
      }
    }
    return cmd; // fallback to original (let pty.spawn try PATH)
  }

  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      const fs = require('fs');
      const candidates = [
        `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`,
        'powershell.exe',
        'cmd.exe',
      ];
      for (const shell of candidates) {
        try {
          if (fs.existsSync(shell)) return shell;
        } catch {
          /* skip */
        }
      }
      return 'cmd.exe';
    }
    if (isMac) return process.env.SHELL || '/bin/zsh';
    return process.env.SHELL || '/bin/bash';
  }
}
