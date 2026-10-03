import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CHATV2_AGENTS, CHATV2_PROVIDER_SESSION_ID } from '../../../shared/chatv2/ipc';
import type { ChatV2StoredRecord } from './types';

/** A record file larger than this is not loaded. */
const RECORD_MAX_BYTES = 64 * 1024 * 1024;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * `chat-sessions/v2/<chatSessionId>.json`: one file per record, written
 * atomically (temp file + rename) with mode 0600 in a 0700 directory.
 */
export class ChatV2Store {
  constructor(private readonly directory: string) {}

  private file(chatSessionId: string): string {
    if (!RECORD_ID.test(chatSessionId)) throw new Error('Invalid chat session id');
    return path.join(this.directory, `${chatSessionId}.json`);
  }

  /** Every readable record; anything malformed is skipped (and reported). */
  load(warn: (message: string) => void): ChatV2StoredRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory);
    } catch {
      return [];
    }
    const records: ChatV2StoredRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(this.directory, name);
      try {
        const stat = fs.lstatSync(full);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RECORD_MAX_BYTES) continue;
        const record = JSON.parse(fs.readFileSync(full, 'utf8')) as ChatV2StoredRecord;
        if (!validRecord(record) || `${record.chatSessionId}.json` !== name) {
          warn(`[chatv2] skipped malformed record ${name}`);
          continue;
        }
        records.push(record);
      } catch {
        warn(`[chatv2] skipped unreadable record ${name}`);
      }
    }
    return records;
  }

  save(record: ChatV2StoredRecord): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(record.chatSessionId);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
      fs.renameSync(temp, target);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* never written */ }
      throw error;
    }
  }

  remove(chatSessionId: string): void {
    try {
      fs.unlinkSync(this.file(chatSessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function validRecord(value: unknown): value is ChatV2StoredRecord {
  const r = value as Partial<ChatV2StoredRecord> | null;
  if (!r || typeof r !== 'object') return false;
  if (r.version !== 1 || typeof r.paneId !== 'string' || !r.paneId) return false;
  if (typeof r.chatSessionId !== 'string' || !RECORD_ID.test(r.chatSessionId)) return false;
  if (!CHATV2_AGENTS.includes(r.agent as ChatV2StoredRecord['agent'])) return false;
  if (r.mode !== 'default' && r.mode !== 'bypass') return false;
  if (typeof r.model !== 'string') return false;
  if (r.state !== 'active' && r.state !== 'handed-off') return false;
  if (typeof r.providerSessionId !== 'string' || !CHATV2_PROVIDER_SESSION_ID.test(r.providerSessionId)) return false;
  if (!Number.isSafeInteger(r.seq) || (r.seq as number) < 0) return false;
  const s = r.session;
  if (!s || typeof s !== 'object' || !Array.isArray(s.blocks) || s.id !== r.chatSessionId) return false;
  if (!r.bodies || typeof r.bodies !== 'object' || Array.isArray(r.bodies)) return false;
  if (!Array.isArray(r.sends)) return false;
  if (r.process !== undefined) {
    const p = r.process;
    if (!p || !Number.isSafeInteger(p.pid) || p.pid <= 1 || typeof p.startTime !== 'string' || typeof p.marker !== 'string') return false;
  }
  return true;
}
