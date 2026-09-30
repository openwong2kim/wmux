import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { CHAT_MESSAGE_RETENTION_MS, chatIdTime, type ChatCancelEffect, type ChatOwner } from './chatBridge';
import {
  effectiveCancelProgress, isFinalCancelState,
  type ChatCancelProgress, type StoredCancelProgress,
} from '../../shared/phoneChatCancelOutcome';

const MAX_FILE_BYTES = 1024 * 1024;
const EFFECTS: readonly string[] = ['interrupt-requested', 'uncertain'];

/** What a replay answers with. Only cancels that reached the write are kept. */
export interface StoredCancelOutcome {
  effect: Exclude<ChatCancelEffect, 'none'>;
  /** The turn the ESC was aimed at. */
  turnId?: string;
}

export interface ChatCancelReceipt {
  createdAt: number;
  paneId: string;
  fingerprint: string;
  state: 'pending' | 'final';
  outcome?: StoredCancelOutcome;
  /**
   * What happened after the write (contract v-next item 3). Optional and
   * ignored by an older daemon: the file stays `version: 1` and
   * `outcome.effect` keeps its two values.
   */
  progress?: StoredCancelProgress;
}

/** `GET …/chat/cancel/:clientCancelId`: the progress of one cancel, with the turn it was aimed at. */
export type ChatCancelProgressView = ChatCancelProgress;

/** A cancel that never reported back before a daemon restart: the ESC may have been written. */
const RESTART_UNCERTAIN: StoredCancelOutcome = { effect: 'uncertain' };

export type ChatCancelInsert = 'inserted' | 'exists' | 'full' | 'persist-failed';

const hash = (parts: readonly string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function validOutcome(value: unknown): value is StoredCancelOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return EFFECTS.includes(String(row.effect)) &&
    (row.turnId === undefined || typeof row.turnId === 'string' && row.turnId.length <= 128);
}

function validEntry(key: string, value: unknown): value is ChatCancelReceipt {
  if (!/^[a-f0-9]{64}$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.createdAt) && typeof row.paneId === 'string' && row.paneId.length > 0 && row.paneId.length <= 256 &&
    typeof row.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.fingerprint) &&
    (row.state === 'pending' && row.outcome === undefined || row.state === 'final' && validOutcome(row.outcome));
}

/**
 * Durable, owner-bound receipts for phone chat cancels, in their own file so
 * the send receipt format never changes. Modelled on `ChatSendReceiptStore`:
 * `pending` is on disk before the ESC, a `pending` found after a restart is
 * uncertain forever, and ids follow `checkChatId`. A cancel refused before the
 * write leaves no receipt (`discard`), so retrying the same id re-evaluates.
 */
export class ChatCancelReceiptStore {
  private entries: Record<string, ChatCancelReceipt> = {};
  /** When the interrupt was written, per key. Memory only: the file keeps `progress` alone, so it is absent after a restart. */
  private readonly requestedAt = new Map<string, number>();
  private readonly file: string;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly write: (file: string, data: unknown) => void;

  constructor(directory: string, opts: { now?: () => number; limit?: number; write?: (file: string, data: unknown) => void } = {}) {
    this.file = path.join(directory, 'chat-cancel-receipts.json');
    this.now = opts.now ?? Date.now;
    this.limit = opts.limit ?? 2_000;
    this.write = opts.write ?? ((file, data) => atomicWriteJSONSync(file, data, { durable: true }));
    if (!fs.existsSync(this.file)) return;
    if (fs.statSync(this.file).size > MAX_FILE_BYTES) throw new Error('Chat cancel receipt storage exceeds limit');
    const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (saved?.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)) throw new Error('Invalid chat cancel receipt storage');
    const now = this.now();
    let changed = false;
    for (const [key, value] of Object.entries(saved.entries)) {
      if (!validEntry(key, value)) throw new Error('Invalid chat cancel receipt entry');
      const { progress: raw, ...rest } = value as ChatCancelReceipt & { progress?: unknown };
      // Nothing observes a cancel across a restart: a `requested` progress,
      // and the `pending` entry that becomes a final `uncertain` one here,
      // both settle `unknown` (`daemon-restart`). Read from the entry as
      // loaded, before the conversion, so a crashed `pending` keeps that
      // reason. The shared reader normalizes the untrusted stored value, so a
      // `progress` never makes an entry invalid.
      const progress = effectiveCancelProgress({ ...rest, ...(raw !== undefined ? { progress: raw as StoredCancelProgress } : {}) }, true, now);
      if (JSON.stringify(progress) !== JSON.stringify(raw)) changed = true;
      this.entries[key] = rest.state === 'pending' ? { ...rest, state: 'final', outcome: RESTART_UNCERTAIN, progress } : { ...rest, progress };
    }
    // Write the settled progress once, so its `at` stays put across later
    // restarts. A failed write only repeats this at the next load.
    if (changed) { try { this.save(this.entries); } catch { /* see above */ } }
  }

  static fingerprint(paneId: string, agentSessionId: string, historyEpoch: string | undefined, turnId: string | undefined): string {
    return hash([paneId, agentSessionId, historyEpoch ?? '', turnId ?? '']);
  }

  lookup(owner: ChatOwner, clientCancelId: string): Readonly<ChatCancelReceipt> | undefined {
    const entry = this.entries[this.key(owner, clientCancelId)];
    return entry && entry.createdAt > this.now() - CHAT_MESSAGE_RETENTION_MS ? entry : undefined;
  }

  /** Insert-if-absent. `inserted` means `pending` is durable. */
  insertPending(owner: ChatOwner, clientCancelId: string, receipt: Pick<ChatCancelReceipt, 'paneId' | 'fingerprint'>): ChatCancelInsert {
    if (this.lookup(owner, clientCancelId)) return 'exists';
    const now = this.now();
    const retained = Object.fromEntries(Object.entries(this.entries).filter(([, row]) => row.createdAt > now - CHAT_MESSAGE_RETENTION_MS));
    if (Object.keys(retained).length >= this.limit) return 'full';
    const next = { ...retained, [this.key(owner, clientCancelId)]: {
      createdAt: chatIdTime(clientCancelId), paneId: receipt.paneId, fingerprint: receipt.fingerprint, state: 'pending' as const,
    } };
    try { this.save(next); } catch { return 'persist-failed'; }
    this.entries = next;
    return 'inserted';
  }

  /**
   * Record the verdict of a cancel that reached the write, and its first
   * progress, in one write. A failed save stays `pending` on disk (uncertain
   * after a restart).
   */
  complete(owner: ChatOwner, clientCancelId: string, outcome: StoredCancelOutcome, progress?: StoredCancelProgress): boolean {
    const key = this.key(owner, clientCancelId);
    const entry = this.entries[key];
    if (!entry || entry.state !== 'pending') return false;
    const next = { ...this.entries, [key]: { ...entry, state: 'final' as const, outcome, ...(progress ? { progress } : {}) } };
    this.entries = next;
    if (progress?.state === 'requested') this.requestedAt.set(key, progress.at);
    try { this.save(next); return true; } catch { return false; }
  }

  /**
   * Move a final entry's progress on. `final`: its progress is already final
   * and never changes again. `unsaved`: the write failed and nothing changed,
   * in memory or on disk, so the caller may try again.
   */
  setProgress(owner: ChatOwner, clientCancelId: string, progress: StoredCancelProgress): 'saved' | 'unsaved' | 'final' {
    const key = this.key(owner, clientCancelId);
    const entry = this.entries[key];
    if (!entry || entry.state !== 'final' || isFinalCancelState(effectiveCancelProgress(entry, false, this.now()).state)) return 'final';
    const next = { ...this.entries, [key]: { ...entry, progress } };
    try { this.save(next); } catch { return 'unsaved'; }
    this.entries = next;
    return 'saved';
  }

  /** The progress of a cancel, or undefined (none, refused, expired, another owner). */
  progress(owner: ChatOwner, clientCancelId: string): ChatCancelProgressView | undefined {
    const entry = this.lookup(owner, clientCancelId);
    // A `pending` entry (the write in flight under the pane lock) reads `requested`.
    if (!entry) return undefined;
    const { endedAs, evidence, reason, state, at } = effectiveCancelProgress(entry, false, this.now());
    const requestedAt = this.requestedAt.get(this.key(owner, clientCancelId));
    return {
      state,
      ...(entry.outcome?.turnId ? { turnId: entry.outcome.turnId } : {}),
      ...(endedAs ? { endedAs } : {}),
      ...(evidence ? { evidence } : {}),
      ...(reason ? { reason } : {}),
      ...(requestedAt !== undefined ? { requestedAt } : {}),
      at,
    };
  }

  /** Drop a `pending` receipt whose cancel wrote nothing. */
  discard(owner: ChatOwner, clientCancelId: string): void {
    const key = this.key(owner, clientCancelId);
    if (this.entries[key]?.state !== 'pending') return;
    const { [key]: _dropped, ...next } = this.entries;
    void _dropped;
    this.entries = next;
    // A failed save leaves `pending` on disk: after a restart that reads as
    // uncertain, which only ever over-reports a write.
    try { this.save(next); } catch { /* see above */ }
  }

  private key(owner: ChatOwner, clientCancelId: string): string { return hash([owner, clientCancelId.toLowerCase()]); }

  private save(entries: Record<string, ChatCancelReceipt>): void {
    const data = { version: 1, entries };
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_FILE_BYTES) throw new Error('Chat cancel receipt storage exceeds limit');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.write(this.file, data);
    // Retention pruning and discards drop entries here; their write times go with them.
    for (const key of this.requestedAt.keys()) if (!Object.hasOwn(entries, key)) this.requestedAt.delete(key);
  }
}
