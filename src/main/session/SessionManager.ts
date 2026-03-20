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
          fs.copyFileSync(this.filePath, this.bakPath);
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

  load(): SessionData | null {
    try {
      let raw: string | null = null;

      // Try primary file first
      if (fs.existsSync(this.filePath)) {
        raw = fs.readFileSync(this.filePath, 'utf-8');
      }

      // If primary file is missing or empty, try backup
      if (!raw && fs.existsSync(this.bakPath)) {
        console.warn('[SessionManager] Primary session file missing, trying backup...');
        raw = fs.readFileSync(this.bakPath, 'utf-8');
      }

      if (!raw) return null;

      // Guard against prototype pollution via JSON reviver
      const parsed: unknown = JSON.parse(raw, (key, value) => {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
        return value;
      });

      // Basic schema validation
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as Record<string, unknown>)['workspaces']) ||
        typeof (parsed as Record<string, unknown>)['activeWorkspaceId'] !== 'string'
      ) {
        console.warn('[SessionManager] Session file failed schema validation — discarding.');
        return null;
      }

      return parsed as SessionData;
    } catch (err) {
      console.error('[SessionManager] Failed to load session:', err);

      // If primary file is corrupt, try backup as fallback
      if (fs.existsSync(this.bakPath)) {
        try {
          console.warn('[SessionManager] Attempting recovery from backup...');
          const bakRaw = fs.readFileSync(this.bakPath, 'utf-8');
          const bakParsed: unknown = JSON.parse(bakRaw, (key, value) => {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
            return value;
          });
          if (
            typeof bakParsed === 'object' &&
            bakParsed !== null &&
            Array.isArray((bakParsed as Record<string, unknown>)['workspaces']) &&
            typeof (bakParsed as Record<string, unknown>)['activeWorkspaceId'] === 'string'
          ) {
            console.warn('[SessionManager] Recovered session from backup.');
            return bakParsed as SessionData;
          }
        } catch (bakErr) {
          console.error('[SessionManager] Backup recovery also failed:', bakErr);
        }
      }

      return null;
    }
  }
}
