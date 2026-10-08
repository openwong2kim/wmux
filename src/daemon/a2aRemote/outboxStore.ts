import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { reHardenTokenFile } from '../../shared/security';
import {
  A2A_REMOTE_RECORD_V,
  isA2aRemoteMessageKind,
  isHostId,
  type A2aOutboxRecordV1,
  type A2aOutboxState,
  type A2aRemoteEnvelope,
  type A2aRemoteErrorCode,
  type A2aStreamCursor,
  type HostId,
} from '../../shared/a2aRemote';
import { isIsoString, isPlainObject, loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * Layer 4 of cross-host A2A: the durable outbox (`outbox.json`), one queue per
 * remote host. Every message this host owes a peer (task / reply / state /
 * link notice) is enqueued here first and leaves only when the peer
 * acknowledges it, so a daemon restart or a dropped connection never loses one.
 * Sending (HTTP POST, SSE) is the transport's job; this is only the queue.
 *
 * `epoch` belongs to the STORE, not the daemon process: minted once when the
 * file is first created and persisted, so a restart resumes a peer's cursor
 * instead of replaying from zero. `seq` is per host, strictly increasing, and
 * its high-water mark is persisted on its own (`seqByHost`), so pruning acked
 * records can never make a seq repeat.
 *
 * Corrupt file: keep the original as `outbox.json.corrupt-<ts>`, start empty,
 * and mint a NEW epoch — the old seqs are gone, so reusing the old epoch would
 * make a peer's cursor skip new messages. A peer still holding a cursor in the
 * old epoch no longer matches this store; reconciling that cursor is the
 * transport's job (PR3b). An UNREADABLE file leaves the
 * store unavailable: every mutation throws and the original is never touched.
 *
 * Write failure: every op rolls memory back and throws.
 */

export const OUTBOX_FILE = 'outbox.json';
/** Unsent records one host may hold; enqueue beyond this throws. */
export const OUTBOX_PENDING_MAX = 1000;
/** Acked / refused records are kept this long (for display / debugging), then pruned. */
export const OUTBOX_DONE_KEEP_MS = 60 * 60 * 1000;

const STATES: ReadonlySet<string> = new Set<A2aOutboxState>(['pending', 'outcome-unknown', 'acked', 'refused']);
const OPEN: ReadonlySet<A2aOutboxState> = new Set<A2aOutboxState>(['pending', 'outcome-unknown']);

interface OutboxFileV1 {
  v: 1;
  epoch: string;
  seqByHost: Record<HostId, number>;
  records: A2aOutboxRecordV1[];
}

export interface OutboxStoreOptions {
  /** Directory holding the store, e.g. `<wmux data dir>/a2a/`. */
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seam; defaults to `atomicWriteJSONSync`. */
  write?: (filePath: string, data: unknown) => void;
  /** Test seam; defaults to the deferred owner-only re-harden. */
  scheduleHarden?: (filePath: string) => void;
  /** Test seam for the epoch (defaults to a random UUID). */
  mintEpoch?: () => string;
  /** Called after a record was queued and persisted (the transport sends it now). */
  onEnqueue?: (record: A2aOutboxRecordV1) => void;
}

export class OutboxStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly onEnqueue: (record: A2aOutboxRecordV1) => void;
  private epochValue = '';
  private seqByHost: Record<HostId, number> = {};
  /** Keyed `${hostId}:${seq}`. */
  private records = new Map<string, A2aOutboxRecordV1>();
  private writable = true;
  /** The re-harden of the file running now (Windows rewrites the file), and whether another write wants one. */
  private hardening: Promise<void> | null = null;
  private hardenAgain = false;

  constructor(opts: OutboxStoreOptions) {
    this.filePath = path.join(opts.dir, OUTBOX_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? ((): void => this.harden());
    this.onEnqueue = opts.onEnqueue ?? ((): void => undefined);
    this.load(opts.mintEpoch ?? ((): string => crypto.randomUUID()));
  }

  /**
   * Re-harden the file after a write, tracked so `idle()` can wait for it: on
   * Windows it rewrites the file and holds it (and the directory) meanwhile.
   * Writes during a run ask for one more run, never a parallel one.
   */
  private harden(): void {
    if (this.hardening) {
      this.hardenAgain = true;
      return;
    }
    this.hardening = (async (): Promise<void> => {
      do {
        this.hardenAgain = false;
        await new Promise((r) => setImmediate(r));
        await reHardenTokenFile(this.filePath);
      } while (this.hardenAgain);
    })().finally(() => {
      this.hardening = null;
    });
  }

  /** Resolves once no re-harden of the file is running (call on shutdown). */
  async idle(): Promise<void> {
    while (this.hardening) await this.hardening;
  }

  /** The store's epoch: the first half of every stream cursor. */
  get epoch(): string {
    return this.epochValue;
  }

  // --- reads ------------------------------------------------------------------

  /** Records still owed to `hostId` (pending or outcome-unknown), oldest first. */
  pending(hostId: HostId): A2aOutboxRecordV1[] {
    return [...this.records.values()]
      .filter((r) => r.hostId === hostId && OPEN.has(r.state))
      .sort((a, b) => a.seq - b.seq)
      .map((r) => structuredClone(r));
  }

  /** The oldest record still owed to `hostId` (one copy, not the whole queue). */
  head(hostId: HostId): A2aOutboxRecordV1 | undefined {
    let first: A2aOutboxRecordV1 | undefined;
    for (const r of this.records.values()) {
      if (r.hostId === hostId && OPEN.has(r.state) && (!first || r.seq < first.seq)) first = r;
    }
    return first ? structuredClone(first) : undefined;
  }

  /** How many records are still owed to `hostId`. */
  openCount(hostId: HostId): number {
    let n = 0;
    for (const r of this.records.values()) if (r.hostId === hostId && OPEN.has(r.state)) n += 1;
    return n;
  }

  get(hostId: HostId, seq: number): A2aOutboxRecordV1 | undefined {
    const rec = this.records.get(key(hostId, seq));
    return rec ? structuredClone(rec) : undefined;
  }

  // --- mutations --------------------------------------------------------------

  /** Queue one envelope for `hostId`; returns the record with its new seq. */
  enqueue(hostId: HostId, envelope: A2aRemoteEnvelope): A2aOutboxRecordV1 {
    this.assertWritable();
    if (!isHostId(hostId)) throw new Error('outbox: invalid hostId');
    if (!isEnvelopeShape(envelope)) throw new Error('outbox: invalid envelope');
    const open = [...this.records.values()].filter((r) => r.hostId === hostId && OPEN.has(r.state)).length;
    if (open >= OUTBOX_PENDING_MAX) throw new Error(`outbox: host ${hostId} already has ${OUTBOX_PENDING_MAX} unsent messages`);
    const seq = (this.seqByHost[hostId] ?? 0) + 1;
    const at = this.iso();
    const rec: A2aOutboxRecordV1 = {
      v: A2A_REMOTE_RECORD_V,
      epoch: this.epochValue,
      seq,
      hostId,
      envelope: structuredClone(envelope),
      state: 'pending',
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.mutate(() => {
      this.seqByHost[hostId] = seq;
      this.records.set(key(hostId, seq), rec);
    });
    try {
      this.onEnqueue(structuredClone(rec));
    } catch (err) {
      this.log('warn', `[a2a-remote] outbox listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return structuredClone(rec);
  }

  /** One send attempt went out (the count is durable, for backoff and display). */
  markSent(hostId: HostId, seq: number): A2aOutboxRecordV1 {
    return this.update(hostId, seq, (r) => ({ ...r, attempts: r.attempts + 1 }));
  }

  /**
   * The send got no answer: the peer may or may not have it. Stays owed; a
   * resend is safe because the peer dedupes by (linkId, messageId).
   */
  markOutcomeUnknown(hostId: HostId, seq: number, error?: A2aRemoteErrorCode): A2aOutboxRecordV1 {
    return this.update(hostId, seq, (r) => ({ ...r, state: 'outcome-unknown', ...(error ? { lastError: error } : {}) }));
  }

  /** The peer refused it with a terminal error; it is never resent. */
  refuse(hostId: HostId, seq: number, code: A2aRemoteErrorCode): A2aOutboxRecordV1 {
    return this.update(hostId, seq, (r) => ({ ...r, state: 'refused', lastError: code }));
  }

  /**
   * The peer has everything for this host up to and including `cursor.seq`.
   * A cursor from another epoch acknowledges nothing. Returns how many records
   * moved to `acked`.
   */
  ack(hostId: HostId, cursor: A2aStreamCursor): number {
    this.assertWritable();
    if (cursor.epoch !== this.epochValue || !Number.isInteger(cursor.seq)) return 0;
    const hits = [...this.records.values()].filter((r) => r.hostId === hostId && OPEN.has(r.state) && r.seq <= cursor.seq);
    if (hits.length === 0) return 0;
    const at = this.iso();
    this.mutate(() => {
      for (const r of hits) this.records.set(key(hostId, r.seq), { ...r, state: 'acked', updatedAt: at });
    });
    return hits.length;
  }

  /** Drop acked / refused records older than `keepMs`. Returns how many went. */
  prune(keepMs = OUTBOX_DONE_KEEP_MS): number {
    this.assertWritable();
    const cutoff = this.now() - keepMs;
    const stale = [...this.records.entries()].filter(([, r]) => !OPEN.has(r.state) && Date.parse(r.updatedAt) < cutoff);
    if (stale.length === 0) return 0;
    this.mutate(() => {
      for (const [k] of stale) this.records.delete(k);
    });
    return stale.length;
  }

  // --- internals --------------------------------------------------------------

  private update(hostId: HostId, seq: number, patch: (r: A2aOutboxRecordV1) => A2aOutboxRecordV1): A2aOutboxRecordV1 {
    this.assertWritable();
    const rec = this.records.get(key(hostId, seq));
    if (!rec) throw new Error(`outbox: no record ${hostId}#${seq}`);
    if (!OPEN.has(rec.state)) throw new Error(`outbox: record ${hostId}#${seq} is already ${rec.state}`);
    const next = { ...patch(rec), updatedAt: this.iso() };
    this.mutate(() => this.records.set(key(hostId, seq), next));
    return structuredClone(next);
  }

  /** Apply `change` and persist; on a failed write restore the previous memory and throw. */
  private mutate(change: () => void): void {
    const seqBefore = { ...this.seqByHost };
    const recordsBefore = new Map(this.records);
    change();
    try {
      this.persist();
    } catch (err) {
      this.seqByHost = seqBefore;
      this.records = recordsBefore;
      throw err;
    }
  }

  private persist(): void {
    const file: OutboxFileV1 = {
      v: A2A_REMOTE_RECORD_V,
      epoch: this.epochValue,
      seqByHost: this.seqByHost,
      records: [...this.records.values()],
    };
    this.write(this.filePath, file);
    this.scheduleHarden(this.filePath);
  }

  private assertWritable(): void {
    if (!this.writable) throw storeUnavailable(OUTBOX_FILE);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private load(mintEpoch: () => string): void {
    const { value, writable } = loadStore({
      filePath: this.filePath,
      fileName: OUTBOX_FILE,
      coerce: coerceFile,
      now: this.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'starting with an empty outbox under a NEW epoch',
    });
    this.writable = writable;
    if (value) {
      this.epochValue = value.epoch;
      this.seqByHost = value.seqByHost;
      for (const r of value.records) this.records.set(key(r.hostId, r.seq), r);
      return;
    }
    this.epochValue = mintEpoch();
    if (!writable) return;
    // Persist the new epoch at once, so a restart before the first enqueue
    // keeps it. A failure here loses nothing (the store is empty); the next
    // successful write persists it.
    try {
      this.persist();
    } catch (err) {
      this.log('warn', `[a2a-remote] could not write a new ${OUTBOX_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function key(hostId: HostId, seq: number): string {
  return `${hostId}:${seq}`;
}

function isEnvelopeShape(e: unknown): e is A2aRemoteEnvelope {
  return (
    isPlainObject(e) &&
    typeof e['linkId'] === 'string' &&
    typeof e['messageId'] === 'string' &&
    typeof e['linkVersion'] === 'number' &&
    isA2aRemoteMessageKind(e['kind'])
  );
}

/** Whole-file validation: any bad record rejects the file. */
function coerceFile(raw: unknown): OutboxFileV1 | null {
  if (!isPlainObject(raw) || raw['v'] !== 1) return null;
  const { epoch, seqByHost, records } = raw;
  if (typeof epoch !== 'string' || epoch.length === 0 || epoch.length > 128) return null;
  if (!isPlainObject(seqByHost) || !Array.isArray(records)) return null;
  const seqs: Record<HostId, number> = {};
  for (const [h, n] of Object.entries(seqByHost)) {
    if (!isHostId(h) || typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
    seqs[h] = n;
  }
  const out: A2aOutboxRecordV1[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (!isPlainObject(r) || r['v'] !== 1 || r['epoch'] !== epoch) return null;
    const { seq, hostId, envelope, state, attempts, createdAt, updatedAt, lastError } = r;
    if (!isHostId(hostId) || typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return null;
    if (seq > (seqs[hostId] ?? 0) || seen.has(key(hostId, seq))) return null;
    if (!isEnvelopeShape(envelope)) return null;
    if (typeof state !== 'string' || !STATES.has(state)) return null;
    if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) return null;
    if (!isIsoString(createdAt) || !isIsoString(updatedAt)) return null;
    if (lastError !== undefined && typeof lastError !== 'string') return null;
    seen.add(key(hostId, seq));
    out.push({
      v: 1,
      epoch,
      seq,
      hostId,
      envelope,
      state: state as A2aOutboxState,
      attempts,
      createdAt,
      updatedAt,
      ...(lastError !== undefined ? { lastError: lastError as A2aRemoteErrorCode } : {}),
    });
  }
  return { v: 1, epoch, seqByHost: seqs, records: out };
}
