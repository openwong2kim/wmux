import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionData } from '../../shared/types';

export class SessionManager {
  private filePath: string;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'session.json');
  }

  save(data: SessionData): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save session:', err);
    }
  }

  load(): SessionData | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = fs.readFileSync(this.filePath, 'utf-8');

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
      console.error('Failed to load session:', err);
      return null;
    }
  }
}
