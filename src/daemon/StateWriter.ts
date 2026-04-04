import fs from 'node:fs';
import path from 'node:path';
import type { DaemonState, DaemonSession } from './types';

const DEBOUNCE_MS = 30_000;

/**
 * Persists DaemonState (sessions.json) to disk using atomic write pattern.
 * Mirrors SessionManager's tmp → bak → rename strategy.
 */
export class StateWriter {
  private filePath: string;
  private tmpPath: string;
  private bakPath: string;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingState: DaemonState | null = null;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, 'sessions.json');
    this.tmpPath = this.filePath + '.tmp';
    this.bakPath = this.filePath + '.bak';
  }

  /** Immediately write state to disk (session create/destroy/state change). */
  saveImmediate(state: DaemonState): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const json = JSON.stringify(state, null, 2);

      // 1. Write to temporary file
      // Note: mode is no-op on Windows; use icacls for NTFS ACLs
      fs.writeFileSync(this.tmpPath, json, { encoding: 'utf-8', mode: 0o600 });

      // 2. Backup current file (if it exists)
      if (fs.existsSync(this.filePath)) {
        try {
          fs.renameSync(this.filePath, this.bakPath);
        } catch (bakErr) {
          console.warn('[StateWriter] Failed to create backup:', bakErr);
          // Continue — saving is more important than backing up
        }
      }

      // 3. Atomic rename: tmp → sessions.json
      fs.renameSync(this.tmpPath, this.filePath);

      // Clear pending since we just saved
      this.pendingState = null;
    } catch (err) {
      console.error('[StateWriter] Failed to save state:', err);
      // Clean up tmp file if it exists
      try {
        if (fs.existsSync(this.tmpPath)) fs.unlinkSync(this.tmpPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  /** Debounced save — coalesces frequent updates (e.g. lastActivity) over 30s. */
  saveDebounced(state: DaemonState): void {
    this.pendingState = state;

    if (this.debounceTimer !== null) {
      return; // Timer already running; state will be picked up when it fires
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.pendingState !== null) {
        this.saveImmediate(this.pendingState);
      }
    }, DEBOUNCE_MS);
  }

  /** Load state from disk. Falls back to .bak on failure. Prunes expired DEAD sessions. */
  load(): DaemonState {
    const empty: DaemonState = { version: 1, sessions: [] };

    let state: DaemonState | null = null;

    // Try primary
    try {
      state = this.parseStateFile(this.filePath);
    } catch (err) {
      console.error('[StateWriter] Failed to load primary state:', err);
    }

    // Fallback to backup
    if (!state) {
      try {
        console.warn('[StateWriter] Trying backup...');
        state = this.parseStateFile(this.bakPath);
        if (state) {
          console.warn('[StateWriter] Recovered state from backup.');
        }
      } catch (bakErr) {
        console.error('[StateWriter] Backup recovery also failed:', bakErr);
      }
    }

    if (!state) {
      return empty;
    }

    // Prune DEAD sessions that exceeded their TTL
    state.sessions = state.sessions.filter((s) => {
      if (s.state !== 'dead') return true;
      const deadSince = new Date(s.lastActivity).getTime();
      const ttlMs = s.deadTtlHours * 60 * 60 * 1000;
      return Date.now() - deadSince < ttlMs;
    });

    return state;
  }

  /** Flush pending debounce — if there is pending state, write it immediately. */
  flush(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pendingState !== null) {
      this.saveImmediate(this.pendingState);
    }
  }

  /** Clean up timers (daemon shutdown). Flushes pending state first. */
  dispose(): void {
    this.flush();
  }

  /** Get the path where a session's scrollback buffer should be dumped. */
  getBufferDumpPath(sessionId: string): string {
    return path.join(path.dirname(this.filePath), 'buffers', `${sessionId}.buf`);
  }

  /** Ensure the buffers/ directory exists. */
  ensureBufferDir(): void {
    const dir = path.join(path.dirname(this.filePath), 'buffers');
    if (!fs.existsSync(dir)) {
      // Note: mode is no-op on Windows; use icacls for NTFS ACLs
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** Remove orphaned .buf files not referenced by any session. */
  cleanOrphanedBuffers(activeIds: Set<string>): void {
    const dir = path.join(path.dirname(this.filePath), 'buffers');
    if (!fs.existsSync(dir)) return;
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.buf')) continue;
        const id = file.replace(/\.buf$/, '');
        if (!activeIds.has(id)) {
          try { fs.unlinkSync(path.join(dir, file)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private parseStateFile(filePath: string): DaemonState | null {
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw, (key, value) => {
      // Prototype pollution guard
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined;
      }
      return value;
    });

    return this.validateState(parsed);
  }

  private validateState(parsed: unknown): DaemonState | null {
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    if (typeof obj['version'] !== 'number') return null;
    if (!Array.isArray(obj['sessions'])) return null;

    // Validate each session has minimum required fields
    for (const s of obj['sessions'] as unknown[]) {
      if (typeof s !== 'object' || s === null) return null;
      const sess = s as Record<string, unknown>;
      if (typeof sess['id'] !== 'string') return null;
      if (typeof sess['state'] !== 'string') return null;
    }

    return parsed as DaemonState;
  }
}
