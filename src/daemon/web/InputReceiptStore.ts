import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJSONSync } from '../util/atomicWrite';

const RETENTION_MS = 24 * 60 * 60 * 1000;
interface Entry { createdAt: number; fingerprint: string; state: 'pending' | 'written'; inputToken?: string }
export interface InputReceipt { status: 'written' | 'uncertain'; replayed: boolean; inputToken?: string }

/** Single-daemon writer. A crash between journal and PTY write stays uncertain,
 * never silently replays. Written means write() returned, not agent execution. */
export class InputReceiptStore {
  private entries: Record<string, Entry> = {};
  private readonly file: string;
  constructor(directory: string, private readonly now = Date.now, private readonly limit = 10000) {
    this.file = path.join(directory, 'phone-input-receipts.json');
    if (fs.existsSync(this.file)) {
      if (fs.statSync(this.file).size > 4 * 1024 * 1024) throw new Error('Input receipt storage exceeds limit');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)) throw new Error('Invalid input receipt storage');
      for (const [key, value] of Object.entries(saved.entries)) {
        const row = value as Entry;
        if (!/^[a-f0-9]{64}$/.test(key) || !row || !Number.isSafeInteger(row.createdAt) ||
            typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
            !['pending','written'].includes(row.state) || (row.inputToken !== undefined && (typeof row.inputToken !== 'string' || row.inputToken.length > 160))) throw new Error('Invalid input receipt entry');
        this.entries[key] = row;
      }
    }
  }

  execute(owner: string, requestID: string, target: string, input: string, write: () => void | string, mayWrite: () => boolean = () => true): InputReceipt {
    const match = /^(\d{13})\.([a-f0-9-]{36})$/i.exec(requestID);
    if (!match || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(match[2])) throw new Error('Invalid input request ID');
    const createdAt = Number(match[1]);
    const now = this.now();
    // Expired IDs stay invalid even after their receipt is pruned.
    if (createdAt <= now - RETENTION_MS || createdAt > now + 60000) throw new Error('Input request ID expired or clock is ahead');
    const key = this.hash([owner, requestID.toLowerCase()]);
    const fingerprint = this.hash([target, input]);
    const existing = this.entries[key];
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Input request ID reused with different content');
      return {status: existing.state === 'written' ? 'written' : 'uncertain', replayed: true, ...(existing.inputToken ? {inputToken:existing.inputToken} : {})};
    }
    if (!mayWrite()) throw new Error('Input changed before continuation');
    const retained = Object.fromEntries(Object.entries(this.entries).filter(([, row]) => row.createdAt > now - RETENTION_MS));
    if (Object.keys(retained).length >= this.limit) throw new Error('Input receipt capacity reached');
    const pending: Entry = {createdAt, fingerprint, state: 'pending'};
    const next = {...retained, [key]: pending};
    this.save(next); // Any failure here prevents PTY input.
    this.entries = next;
    let inputToken: void | string;
    try { inputToken = write(); } catch { return {status:'uncertain',replayed:false}; }
    const token = typeof inputToken === 'string' ? {inputToken} : {};
    const completed = {...next, [key]: {...pending, state: 'written' as const, ...token}};
    try {
      this.save(completed);
      this.entries = completed;
      return {status:'written',replayed:false,...token};
    } catch {
      // Input may already be in the PTY. Keep the in-memory record pending.
      return {status:'uncertain',replayed:false};
    }
  }

  private hash(parts: string[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
  private save(entries: Record<string, Entry>): void {
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    atomicWriteJSONSync(this.file, {version:1, entries}, {durable:true});
  }
}
