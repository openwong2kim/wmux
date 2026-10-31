import path from 'node:path';
import { atomicReadJSONSync } from './util/atomicWrite';
import { CLAUDE_FILE_SEND_FILENAME } from '../shared/claudeFileSend';

/** Where the Claude file send setting (shared/claudeFileSend.ts) is kept. */
export function claudeFileSendPath(wmuxDir: string): string {
  return path.join(wmuxDir, CLAUDE_FILE_SEND_FILENAME);
}

/** Whether the setting is on. A missing or unreadable file reads as off. */
export function readClaudeFileSend(wmuxDir: string): boolean {
  try {
    return atomicReadJSONSync<{ enabled?: unknown }>(claudeFileSendPath(wmuxDir))?.enabled === true;
  } catch {
    return false;
  }
}
