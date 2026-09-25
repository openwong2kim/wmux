import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import type { ChatSendResult } from '../../shared/transcript/turnEvents';
import {
  CHAT_MESSAGE_RETENTION_MS, chatIdTime,
  type ChatEffect, type ChatOwner, type ChatSendReceiptView, type ChatSendTag,
} from './chatBridge';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const RESULTS: readonly string[] = ['sent', 'busy', 'blocked', 'unconfirmed', 'session_changed', 'unavailable', 'error'];
const EFFECTS: readonly string[] = ['none', 'uncertain', 'submitted'];
const TAGS: readonly string[] = [
  'chat-busy', 'chat-blocked', 'session-changed', 'chat-unavailable', 'input-not-provably-empty', 'send-interrupted',
  'delivery-unconfirmed', 'authorization-expired', 'invalid-chat-request', 'text-too-long', 'message-id-expired',
  'message-id-conflict', 'message-history-full', 'opencode-receipts-full', 'no-conversation', 'managed-read-only',
  'chat-persist-failed',
];

/** The final verdict a replay answers with. Current identity rides along on `session-changed`. */
export interface StoredChatOutcome {
  result?: ChatSendResult;
  effect: ChatEffect;
  error?: ChatSendTag;
  blockedBy?: 'approval' | 'terminal';
  /** Kept so a replayed `text-too-long` still says which limit it hit. */
  limit?: 'units' | 'bytes';
  maxSendBytes?: number;
  agentSessionId?: string;
  historyEpoch?: string;
  /** `sent` while the turn ran: the agent's composer queued the prompt. */
  queued?: true;
}

export interface ChatSendReceipt {
  createdAt: number;
  paneId: string;
  fingerprint: string;
  /** Identity the sender addressed, for the receipt read. */
  agentSessionId: string;
  historyEpoch?: string;
  state: 'pending' | 'final';
  outcome?: StoredChatOutcome;
}

/** What a dispatch that never reported back is, after a daemon restart: maybe typed. */
const RESTART_UNCERTAIN: StoredChatOutcome = { result: 'unconfirmed', effect: 'uncertain', error: 'delivery-unconfirmed' };

export type ChatReceiptInsert = 'inserted' | 'exists' | 'full' | 'persist-failed';

const hash = (parts: readonly string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const optionalString = (value: unknown, max: number): boolean => value === undefined || typeof value === 'string' && value.length <= max;

function validOutcome(value: unknown): value is StoredChatOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return EFFECTS.includes(String(row.effect)) &&
    (row.result === undefined || RESULTS.includes(String(row.result))) &&
    (row.error === undefined || TAGS.includes(String(row.error))) &&
    (row.blockedBy === undefined || row.blockedBy === 'approval' || row.blockedBy === 'terminal') &&
    (row.limit === undefined || row.limit === 'units' || row.limit === 'bytes') &&
    (row.maxSendBytes === undefined || Number.isSafeInteger(row.maxSendBytes) && Number(row.maxSendBytes) > 0) &&
    optionalString(row.agentSessionId, 256) && optionalString(row.historyEpoch, 64) &&
    (row.queued === undefined || typeof row.queued === 'boolean');
}

function validEntry(key: string, value: unknown): value is ChatSendReceipt {
  if (!/^[a-f0-9]{64}$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.createdAt) && typeof row.paneId === 'string' && row.paneId.length > 0 && row.paneId.length <= 256 &&
    typeof row.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(row.fingerprint) &&
    typeof row.agentSessionId === 'string' && row.agentSessionId.length <= 256 && optionalString(row.historyEpoch, 64) &&
    (row.state === 'pending' && row.outcome === undefined || row.state === 'final' && validOutcome(row.outcome));
}

/**
 * Durable, owner-bound send receipts shared by the desktop and the phone
 * (contract §6.2, N5). Single-daemon writer, modelled on InputReceiptStore:
 * `pending` is on disk before any PTY or plugin write, and a `pending` found
 * after a restart is uncertain forever, never replayed as a dispatch.
 *
 * Every mutation is synchronous so a lookup and its insert cannot interleave
 * with a concurrent send of the same id.
 */
export class ChatSendReceiptStore {
  private entries: Record<string, ChatSendReceipt> = {};
  private readonly file: string;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly write: (file: string, data: unknown) => void;

  constructor(directory: string, opts: { now?: () => number; limit?: number; write?: (file: string, data: unknown) => void } = {}) {
    this.file = path.join(directory, 'chat-send-receipts.json');
    this.now = opts.now ?? Date.now;
    this.limit = opts.limit ?? 10_000;
    this.write = opts.write ?? ((file, data) => atomicWriteJSONSync(file, data, { durable: true }));
    if (!fs.existsSync(this.file)) return;
    // Strict: silently dropping a corrupt store would turn "maybe typed" ids
    // into unknown ones a client may legitimately re-post.
    if (fs.statSync(this.file).size > MAX_FILE_BYTES) throw new Error('Chat send receipt storage exceeds limit');
    const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (saved?.version !== 1 || !saved.entries || typeof saved.entries !== 'object' || Array.isArray(saved.entries)) throw new Error('Invalid chat send receipt storage');
    for (const [key, value] of Object.entries(saved.entries)) {
      if (!validEntry(key, value)) throw new Error('Invalid chat send receipt entry');
      this.entries[key] = value.state === 'pending' ? { ...value, state: 'final', outcome: RESTART_UNCERTAIN } : value;
    }
  }

  /**
   * Deliberately excludes the pane incarnation: a legitimate re-post after a
   * pane restart must replay the stored verdict, not read as a conflict.
   * Attachments join the fingerprint only when present, so a text-only
   * request keeps the fingerprint receipts were stored with before them.
   */
  static fingerprint(paneId: string, agentSessionId: string, historyEpoch: string | undefined, text: string,
    attachments?: readonly string[]): string {
    return hash([paneId, agentSessionId, historyEpoch ?? '', text, ...(attachments?.length ? [JSON.stringify(attachments)] : [])]);
  }

  lookup(owner: ChatOwner, clientMessageId: string): Readonly<ChatSendReceipt> | undefined {
    const entry = this.entries[this.key(owner, clientMessageId)];
    return entry && entry.createdAt > this.now() - CHAT_MESSAGE_RETENTION_MS ? entry : undefined;
  }

  /** Insert-if-absent. `inserted` means `pending` is durable; nothing else leaves a trace. */
  insertPending(owner: ChatOwner, clientMessageId: string,
    receipt: Pick<ChatSendReceipt, 'paneId' | 'fingerprint' | 'agentSessionId' | 'historyEpoch'>): ChatReceiptInsert {
    if (this.lookup(owner, clientMessageId)) return 'exists';
    const now = this.now();
    const retained = Object.fromEntries(Object.entries(this.entries).filter(([, row]) => row.createdAt > now - CHAT_MESSAGE_RETENTION_MS));
    if (Object.keys(retained).length >= this.limit) return 'full';
    const next = { ...retained, [this.key(owner, clientMessageId)]: {
      createdAt: chatIdTime(clientMessageId), paneId: receipt.paneId, fingerprint: receipt.fingerprint,
      agentSessionId: receipt.agentSessionId, ...(receipt.historyEpoch !== undefined ? { historyEpoch: receipt.historyEpoch } : {}),
      state: 'pending' as const,
    } };
    try { this.save(next); } catch { return 'persist-failed'; }
    this.entries = next;
    return 'inserted';
  }

  /**
   * Record the verdict. A failed save keeps it in memory, so in-process
   * replays stay exact, while the disk copy stays `pending` and reads as
   * uncertain after a restart, which is still true of a dispatch.
   */
  complete(owner: ChatOwner, clientMessageId: string, outcome: StoredChatOutcome): boolean {
    const key = this.key(owner, clientMessageId);
    const entry = this.entries[key];
    if (!entry || entry.state !== 'pending') return false;
    const next = { ...this.entries, [key]: { ...entry, state: 'final' as const, outcome } };
    this.entries = next;
    try { this.save(next); return true; } catch { return false; }
  }

  view(owner: ChatOwner, paneId: string, clientMessageId: string): ChatSendReceiptView {
    const entry = this.lookup(owner, clientMessageId);
    if (!entry || entry.paneId !== paneId) return { clientMessageId, state: 'unknown' };
    const identity = { agentSessionId: entry.agentSessionId, ...(entry.historyEpoch !== undefined ? { historyEpoch: entry.historyEpoch } : {}), at: entry.createdAt };
    if (entry.state === 'pending' || !entry.outcome) return { clientMessageId, state: 'pending', ...identity };
    const { effect, result, error, queued } = entry.outcome;
    return { clientMessageId, state: effect === 'submitted' ? 'submitted' : effect === 'none' ? 'refused' : 'uncertain',
      ...(result ? { result } : {}), ...(error ? { error } : {}), ...(queued === true ? { queued: true as const } : {}), ...identity };
  }

  private key(owner: ChatOwner, clientMessageId: string): string { return hash([owner, clientMessageId.toLowerCase()]); }

  private save(entries: Record<string, ChatSendReceipt>): void {
    const data = { version: 1, entries };
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_FILE_BYTES) throw new Error('Chat send receipt storage exceeds limit');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.write(this.file, data);
  }
}
