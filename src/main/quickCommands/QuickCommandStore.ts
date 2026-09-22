import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import type { QuickCommand, QuickCommandSnapshot } from '../../shared/quickCommands';

function commands(value: unknown): QuickCommand[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('At most 100 quick commands are allowed');
  const ids = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(row.id) || ids.has(row.id) ||
        typeof row.title !== 'string' || !row.title.trim() || row.title.length > 120 ||
        typeof row.text !== 'string' || !row.text.trim() || row.text.length > 16000 || row.text.includes('\0')) {
      throw new Error('Invalid quick command');
    }
    ids.add(row.id);
    return { id: row.id, title: row.title.trim(), text: row.text };
  });
}

/** Main-process single writer, shared by desktop IPC and authenticated phone requests. */
export class QuickCommandStore {
  private snapshot: QuickCommandSnapshot;
  private file: string;
  constructor(directory = getWmuxDir()) {
    this.file = path.join(directory, 'quick-commands.json');
    this.snapshot = { revision: 'initial', commands: [] };
    if (fs.existsSync(this.file)) {
      if (fs.statSync(this.file).size > 8 * 1024 * 1024) throw new Error('Quick command storage exceeds limit');
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof loaded.revision !== 'string' || !loaded.revision) throw new Error('Invalid quick command revision');
      this.snapshot = { revision: loaded.revision, commands: commands(loaded.commands) };
    }
  }
  read(): QuickCommandSnapshot { return structuredClone(this.snapshot); }
  replace(value: unknown): QuickCommandSnapshot {
    if (!value || typeof value !== 'object') throw new Error('Invalid quick command update');
    const input = value as Record<string, unknown>;
    if (input.revision !== this.snapshot.revision) throw new Error('Quick commands changed elsewhere. Refresh before saving.');
    const next = { revision: randomUUID(), commands: commands(input.commands) };
    if (Buffer.byteLength(JSON.stringify(next)) > 64 * 1024) throw new Error('Quick commands exceed the 64 KiB shared limit');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    atomicWriteJSONSync(this.file, next, { durable: true });
    this.snapshot = next;
    return this.read();
  }
}
let singleton: QuickCommandStore | undefined;
export function getQuickCommandStore(): QuickCommandStore { return singleton ??= new QuickCommandStore(); }
export async function handlePhoneQuickCommands(command: string, payload: Record<string, unknown>): Promise<QuickCommandSnapshot> {
  if (command === 'prompts.list') return getQuickCommandStore().read();
  if (command === 'prompts.replace') return getQuickCommandStore().replace(payload);
  throw new Error('Unsupported quick command operation');
}
