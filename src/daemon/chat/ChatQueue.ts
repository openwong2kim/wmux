import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { CHAT_MESSAGE_RETENTION_MS, type ChatOwner } from './chatBridge';

/**
 * Daemon-held phone chat queue: the durable half. One record per queued
 * message, FIFO per pane, owner-bound. Only the id, owner, pane, state and
 * times reach the disk; the prompt text never does (it lives in the bridge's
 * memory), so nothing queued can be delivered after a daemon restart:
 * `queued` loads as `canceled{daemon-restart}` and `delivering` as
 * `uncertain{restart-uncertain}`.
 *
 * Its own file, so the send receipt format (`chat-send-receipts.json`, v1)
 * never changes and an older daemon still loads everything it wrote.
 */

export type ChatQueueState = 'queued' | 'delivering' | 'delivered' | 'canceled' | 'failed' | 'uncertain';

/** Closed set (contract v0.2 §4). */
export type ChatQueueReason =
  | 'draft-present' | 'blocked' | 'prompt-active' | 'expired' | 'delivery-unconfirmed'
  | 'user' | 'daemon-restart' | 'authorization-revoked' | 'pane-closed' | 'session-changed'
  | 'restart-uncertain';

export interface ChatQueueRecord {
  clientMessageId: string;
  owner: ChatOwner;
  paneId: string;
  state: ChatQueueState;
  reason?: ChatQueueReason;
  /** Enqueue time, epoch ms. */
  queuedAt: number;
  /** Last state change, epoch ms. */
  at: number;
}

export type ChatQueueInsert = 'inserted' | 'exists' | 'full' | 'persist-failed';

/** Active items per pane and owner. */
export const CHAT_QUEUE_MAX_ITEMS = 8;
/** Final items kept per pane and owner for `/turns` `chat.queue[]`. */
const KEEP_FINAL = 16;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 4_000;

const STATES: readonly string[] = ['queued', 'delivering', 'delivered', 'canceled', 'failed', 'uncertain'];
const REASONS: readonly string[] = [
  'draft-present', 'blocked', 'prompt-active', 'expired', 'delivery-unconfirmed', 'user', 'daemon-restart',
  'authorization-revoked', 'pane-closed', 'session-changed', 'restart-uncertain',
];
const ID = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER = /^(?:operator|desktop|device:[A-Za-z0-9_-]{1,128})$/;

export const isActiveQueueState = (state: ChatQueueState): boolean => state === 'queued' || state === 'delivering';

function validRecord(value: unknown): value is ChatQueueRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.clientMessageId === 'string' && ID.test(row.clientMessageId) &&
    typeof row.owner === 'string' && OWNER.test(row.owner) &&
    typeof row.paneId === 'string' && row.paneId.length > 0 && row.paneId.length <= 256 &&
    STATES.includes(String(row.state)) && (row.reason === undefined || REASONS.includes(String(row.reason))) &&
    Number.isSafeInteger(row.queuedAt) && Number.isSafeInteger(row.at);
}

export class ChatQueueStore {
  private records: ChatQueueRecord[] = [];
  /** Called with each record pruning removed (the bridge drops its memory half). */
  onDrop?: (record: Readonly<ChatQueueRecord>) => void;
  private readonly file: string;
  private readonly now: () => number;
  private readonly write: (file: string, data: unknown) => void;

  constructor(directory: string, opts: { now?: () => number; write?: (file: string, data: unknown) => void } = {}) {
    this.file = path.join(directory, 'chat-queue.json');
    this.now = opts.now ?? Date.now;
    this.write = opts.write ?? ((file, data) => atomicWriteJSONSync(file, data, { durable: true }));
    if (!fs.existsSync(this.file)) return;
    if (fs.statSync(this.file).size > MAX_FILE_BYTES) throw new Error('Chat queue storage exceeds limit');
    const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (saved?.version !== 1 || !Array.isArray(saved.entries)) throw new Error('Invalid chat queue storage');
    const at = this.now();
    let changed = false;
    for (const value of saved.entries) {
      if (!validRecord(value)) throw new Error('Invalid chat queue entry');
      // The text died with the old process: nothing loaded is ever delivered.
      if (value.state === 'queued') { this.records.push({ ...value, state: 'canceled', reason: 'daemon-restart', at }); changed = true; }
      else if (value.state === 'delivering') { this.records.push({ ...value, state: 'uncertain', reason: 'restart-uncertain', at }); changed = true; }
      else this.records.push(value);
    }
    if (changed) {
      // Best effort: an unsaved rewrite loads the same way next time.
      try { this.save(this.records); } catch { /* see above */ }
    }
  }

  get(owner: ChatOwner, clientMessageId: string): Readonly<ChatQueueRecord> | undefined {
    const id = clientMessageId.toLowerCase();
    return this.records.find((row) => row.owner === owner && row.clientMessageId === id);
  }

  /** The pane's records in enqueue order. */
  list(paneId: string): readonly Readonly<ChatQueueRecord>[] {
    return this.records.filter((row) => row.paneId === paneId);
  }

  /** Oldest `queued` record of the pane, any owner. */
  head(paneId: string): Readonly<ChatQueueRecord> | undefined {
    return this.records.find((row) => row.paneId === paneId && row.state === 'queued');
  }

  hasActive(paneId: string): boolean {
    return this.records.some((row) => row.paneId === paneId && isActiveQueueState(row.state));
  }

  /** Panes holding at least one active record. */
  activePanes(): string[] {
    return [...new Set(this.records.filter((row) => isActiveQueueState(row.state)).map((row) => row.paneId))];
  }

  /** Durable before it returns `inserted`. */
  insert(owner: ChatOwner, paneId: string, clientMessageId: string): ChatQueueInsert {
    // One record per owner and id, whatever its state: a duplicate would be
    // delivered twice, and every lookup and transition keys on the pair.
    if (this.get(owner, clientMessageId)) return 'exists';
    const active = this.records.filter((row) => row.paneId === paneId && row.owner === owner && isActiveQueueState(row.state));
    if (active.length >= CHAT_QUEUE_MAX_ITEMS) return 'full';
    const now = this.now();
    const next = this.pruned([...this.records, { clientMessageId: clientMessageId.toLowerCase(), owner, paneId, state: 'queued', queuedAt: now, at: now }]);
    if (next.length > MAX_ENTRIES) return 'full';
    try { this.save(next); } catch { return 'persist-failed'; }
    this.commit(next);
    return 'inserted';
  }

  /**
   * Move one record. `strict` (used for `delivering`) keeps memory unchanged
   * when the save fails, so the caller can refuse to write; otherwise a failed
   * save keeps the change in memory and reports false.
   */
  transition(owner: ChatOwner, clientMessageId: string, state: ChatQueueState, reason?: ChatQueueReason,
    opts: { strict?: boolean } = {}): Readonly<ChatQueueRecord> | undefined {
    const id = clientMessageId.toLowerCase();
    const index = this.records.findIndex((row) => row.owner === owner && row.clientMessageId === id);
    if (index < 0) return undefined;
    const { reason: _old, ...base } = this.records[index];
    void _old;
    const row: ChatQueueRecord = { ...base, state, ...(reason ? { reason } : {}), at: this.now() };
    const next = [...this.records];
    next[index] = row;
    const pruned = isActiveQueueState(state) ? next : this.pruned(next);
    try { this.save(pruned); } catch {
      if (opts.strict) return undefined;
    }
    this.commit(pruned);
    return row;
  }

  private commit(next: ChatQueueRecord[]): void {
    const key = (row: ChatQueueRecord) => `${row.owner}\n${row.clientMessageId}`;
    const kept = new Set(next.map(key));
    const dropped = this.records.filter((row) => !kept.has(key(row)));
    this.records = next;
    for (const row of dropped) {
      try { this.onDrop?.(row); } catch { /* bookkeeping only */ }
    }
  }

  private pruned(records: ChatQueueRecord[]): ChatQueueRecord[] {
    const cutoff = this.now() - CHAT_MESSAGE_RETENTION_MS;
    const kept: ChatQueueRecord[] = [];
    const finals = new Map<string, number>();
    // Newest first, so the per-pane/owner cap keeps the latest finals.
    for (let i = records.length - 1; i >= 0; i--) {
      const row = records[i];
      if (!isActiveQueueState(row.state)) {
        if (row.at <= cutoff) continue;
        const key = `${row.paneId}\n${row.owner}`;
        const count = finals.get(key) ?? 0;
        if (count >= KEEP_FINAL) continue;
        finals.set(key, count + 1);
      }
      kept.push(row);
    }
    return kept.reverse();
  }

  private save(records: ChatQueueRecord[]): void {
    const data = { version: 1, entries: records };
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_FILE_BYTES) throw new Error('Chat queue storage exceeds limit');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.write(this.file, data);
  }
}
