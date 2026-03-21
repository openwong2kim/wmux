import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionData } from '../../shared/types';

export class SessionManager {
  private filePath: string;
  private tmpPath: string;
  private bakPath: string;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'session.json');
    this.tmpPath = this.filePath + '.tmp';
    this.bakPath = this.filePath + '.bak';
  }

  /**
   * Atomic save: write to .tmp, backup existing to .bak, then rename .tmp → session.json.
   * If the process crashes mid-write, only the .tmp file is corrupted;
   * the original session.json (or .bak) remains intact.
   */
  save(data: SessionData): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const json = JSON.stringify(data, null, 2);

      // 1. Write to temporary file
      fs.writeFileSync(this.tmpPath, json, 'utf-8');

      // 2. Backup current session file (if it exists)
      if (fs.existsSync(this.filePath)) {
        try {
          fs.renameSync(this.filePath, this.bakPath);
        } catch (bakErr) {
          console.warn('[SessionManager] Failed to create backup:', bakErr);
          // Continue — saving is more important than backing up
        }
      }

      // 3. Atomic rename: tmp → session.json
      fs.renameSync(this.tmpPath, this.filePath);
    } catch (err) {
      console.error('[SessionManager] Failed to save session:', err);
      // Clean up tmp file if it exists
      try {
        if (fs.existsSync(this.tmpPath)) fs.unlinkSync(this.tmpPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  private validateSession(parsed: unknown): SessionData | null {
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>)['workspaces']) ||
      typeof (parsed as Record<string, unknown>)['activeWorkspaceId'] !== 'string'
    ) {
      return null;
    }
    return parsed as SessionData;
  }

  private parseSessionFile(filePath: string): SessionData | null {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw, (key, value) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    });
    return this.validateSession(parsed);
  }

  load(): SessionData | null {
    try {
      const result = this.parseSessionFile(this.filePath);
      if (result) return result;
    } catch (err) {
      console.error('[SessionManager] Failed to load primary session:', err);
    }

    // Primary missing, empty, corrupt, or failed schema — try backup
    try {
      console.warn('[SessionManager] Trying backup...');
      const result = this.parseSessionFile(this.bakPath);
      if (result) {
        console.warn('[SessionManager] Recovered session from backup.');
        return result;
      }
    } catch (bakErr) {
      console.error('[SessionManager] Backup recovery also failed:', bakErr);
    }

    return null;
  }
}
