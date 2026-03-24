import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import os from 'node:os';
import type { DaemonSession, DaemonSessionState, DaemonConfig } from './types';
import { RingBuffer } from './RingBuffer';
import { DaemonPTYBridge } from './DaemonPTYBridge';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_BUFFER_SIZE = 1 * 1024 * 1024; // 1 MB
const DEFAULT_DEAD_TTL_HOURS = 24;

/**
 * Internal type: session metadata + runtime resources.
 */
export interface ManagedSession {
  meta: DaemonSession;
  ptyProcess: IPty;
  ringBuffer: RingBuffer;
  bridge: DaemonPTYBridge;
}

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
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
    agent?: { role: string; teamId: string; displayName: string };
    createdAt?: string;
    scrollbackData?: Buffer;
  }): DaemonSession {
    if (this.sessions.has(params.id)) {
      throw new Error(`Session '${params.id}' already exists`);
    }

    const cols = params.cols ?? DEFAULT_COLS;
    const rows = params.rows ?? DEFAULT_ROWS;
    const cwd = params.cwd || os.homedir();
    const cmd = this.resolveShellPath(params.cmd) || this.getDefaultShell();

    // Build clean environment — strip Electron/Vite vars and sensitive credentials.
    // When no explicit env is provided, use a filtered copy of process.env
    // to prevent leaking secrets (API keys, tokens, etc.) to child processes.
    const SENSITIVE_PATTERNS = [
      /^ELECTRON_/,
      /^VITE_/,
      /^WMUX_AUTH/,       // internal auth tokens
    ];
    const SENSITIVE_EXACT = new Set([
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
    ]);
    const env: Record<string, string> = {};
    const baseEnv = params.env ?? globalThis.process.env;
    for (const [key, value] of Object.entries(baseEnv)) {
      if (value === undefined) continue;
      if (SENSITIVE_EXACT.has(key)) continue;
      if (SENSITIVE_PATTERNS.some((re) => re.test(key))) continue;
      env[key] = value;
    }

    // Spawn ConPTY
    const ptyProcess = pty.spawn(cmd, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      useConpty: true,
    });

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
      deadTtlHours: DEFAULT_DEAD_TTL_HOURS,
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

    const managed: ManagedSession = { meta, ptyProcess, ringBuffer, bridge };
    this.sessions.set(params.id, managed);

    // Forward bridge events to manager-level events
    bridge.on('idle', (payload) => {
      meta.lastActivity = new Date().toISOString();
      this.emit('session:idle', payload);
    });

    bridge.on('cwd', (payload: { sessionId: string; cwd: string }) => {
      meta.cwd = payload.cwd;
    });

    bridge.on('data', () => {
      meta.lastActivity = new Date().toISOString();
    });

    bridge.on('exit', (payload: { sessionId: string; exitCode: number | null }) => {
      meta.state = 'dead';
      meta.exitCode = payload.exitCode;
      this.emit('session:died', { id: params.id, exitCode: payload.exitCode });
      this.emit('session:stateChanged', { id: params.id, state: 'dead' as DaemonSessionState });
    });

    // Set up data forwarding (PTY → RingBuffer + events)
    bridge.setupDataForwarding(ptyProcess, ringBuffer, params.id);

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
  }

  listSessions(): DaemonSession[] {
    return Array.from(this.sessions.values()).map((m) => ({ ...m.meta }));
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
    return process.env.SHELL || '/bin/bash';
  }
}
