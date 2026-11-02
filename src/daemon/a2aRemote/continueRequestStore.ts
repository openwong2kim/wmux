import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { isHostId, type HostId } from '../../shared/a2aRemote';
import {
  CONTINUE_RECORD_KEEP_MS,
  continueAnswerFor,
  isContinueCode,
  isFinalContinueCode,
  parseContinueManifest,
  parseContinueRequest,
  type A2aContinueCode,
  type A2aContinueIncomingRecordV1,
  type A2aContinueIncomingState,
  type A2aContinueManifestV1,
  type A2aContinueRequestV1,
} from '../../shared/a2aContinue';
import { isIsoString, isPlainObject, isSafeId, loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * Conversations other PCs asked this PC to continue (`continue-requests.json`),
 * keyed by (hostId, continueId). It is what makes a resend harmless: the same
 * request again is answered from here and never checked twice; the same id
 * with another body is a conflict. Only one open request may carry a given
 * conversation (sessionId), from any PC.
 *
 * A record keeps its request whole (it holds no text and no path of A's). The
 * manifest is kept while the bytes arrive and until the start, and dropped
 * once the request is decided. A decided record goes
 * `CONTINUE_RECORD_KEEP_MS` after it was decided, so a status query still
 * gets its answer meanwhile. Each write lands before memory changes, so a
 * failed write leaves nothing behind. `sent` names the answer last queued for
 * the asker: a record whose answer moved on since is owed one, and gets it on
 * recovery.
 *
 * Load: a record this build cannot read is skipped, never the whole file.
 */

export const CONTINUE_REQUESTS_FILE = 'continue-requests.json';
/** Requests one PC may have open here at once; a claimed one (`starting`) holds no slot. */
export const CONTINUE_OPEN_PER_HOST_MAX = 3;
/** Decided requests kept per PC; past it, that PC's new requests are refused until some go. */
export const CONTINUE_DECIDED_PER_HOST_MAX = 100;
/** Records kept in all. */
export const CONTINUE_REQUESTS_MAX = 1000;

export interface ContinueRequestRecordV1 extends A2aContinueIncomingRecordV1 {
  /** Decided only: when (the keep window runs from it). */
  decidedAt?: string;
  /** The answer last queued for the asker. */
  sent?: A2aContinueCode;
}

const OPEN: ReadonlySet<string> = new Set<A2aContinueIncomingState>(['pending', 'awaiting', 'ready', 'receiving', 'received', 'starting']);
/** The states that hold a manifest. */
const WITH_MANIFEST: ReadonlySet<string> = new Set<A2aContinueIncomingState>(['receiving', 'received', 'starting']);

export type ContinueReceive =
  | { kind: 'new'; rec: ContinueRequestRecordV1 }
  | { kind: 'duplicate'; rec: ContinueRequestRecordV1 }
  | { kind: 'conflict' }
  /** Another open request carries that conversation. */
  | { kind: 'busy' }
  /** No room: this PC's open or decided records, or all records, are at their cap. */
  | { kind: 'full' };

export interface ContinueRequestStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
}

const key = (hostId: HostId, continueId: string): string => `${hostId}:${continueId}`;

/** What a manifest comes to on disk: the transcript and every file of the folder. */
export function continueManifestBytes(m: A2aContinueManifestV1): number {
  return m.files.reduce((n, f) => n + f.bytes, m.transcript.bytes);
}

/** Two parsed requests (or manifests) are the same: the parsers write their keys in one order. */
export function sameContinueBody(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class ContinueRequestStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly records = new Map<string, ContinueRequestRecordV1>();
  private readonly writable: boolean;

  constructor(opts: ContinueRequestStoreOptions) {
    this.filePath = path.join(opts.dir, CONTINUE_REQUESTS_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: CONTINUE_REQUESTS_FILE,
      coerce: (raw) => (isPlainObject(raw) && raw['v'] === 1 && Array.isArray(raw['records']) ? raw['records'] : null),
      now: this.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'no continued conversation is remembered',
    });
    this.writable = loaded.writable;
    for (const r of loaded.value ?? []) {
      const rec = coerceRecord(r);
      if (rec) this.records.set(key(rec.hostId, rec.request.continueId), rec);
      else this.log('warn', `[a2a-remote] ${CONTINUE_REQUESTS_FILE}: a record this build cannot read was skipped`);
    }
  }

  get(hostId: HostId, continueId: string): ContinueRequestRecordV1 | undefined {
    const rec = this.records.get(key(hostId, continueId));
    return rec ? structuredClone(rec) : undefined;
  }

  inState(state: A2aContinueIncomingState): ContinueRequestRecordV1[] {
    return [...this.records.values()].filter((r) => r.state === state).map((r) => structuredClone(r));
  }

  /** Records whose answer now is not the one last queued (a pending one has nothing to say yet). */
  unsent(): ContinueRequestRecordV1[] {
    return [...this.records.values()]
      .filter((r) => r.state !== 'pending' && r.sent !== continueAnswerFor(r))
      .map((r) => structuredClone(r));
  }

  /** Record a request that passed the cheap checks, pending the rest. */
  receive(hostId: HostId, req: A2aContinueRequestV1): ContinueReceive {
    this.assertWritable();
    const known = this.records.get(key(hostId, req.continueId));
    if (known) return sameContinueBody(known.request, req) ? { kind: 'duplicate', rec: structuredClone(known) } : { kind: 'conflict' };
    if ([...this.records.values()].some((r) => OPEN.has(r.state) && r.request.sessionId === req.sessionId)) return { kind: 'busy' };
    this.prune();
    const mine = [...this.records.values()].filter((r) => r.hostId === hostId);
    // A claimed start holds its conversation (above) but no slot: one a crash left is settled later, not counted against the PC.
    const open = mine.filter((r) => OPEN.has(r.state) && r.state !== 'starting').length;
    const decided = mine.filter((r) => r.state === 'decided').length;
    if (this.records.size >= CONTINUE_REQUESTS_MAX || open >= CONTINUE_OPEN_PER_HOST_MAX || decided >= CONTINUE_DECIDED_PER_HOST_MAX) {
      return { kind: 'full' };
    }
    const at = new Date(this.now()).toISOString();
    const rec: ContinueRequestRecordV1 = { v: 1, hostId, request: structuredClone(req), state: 'pending', receivedAt: at, updatedAt: at };
    this.commit((m) => m.set(key(hostId, req.continueId), rec));
    return { kind: 'new', rec: structuredClone(rec) };
  }

  /**
   * Move an open request on: `from` the states it may be in, `to` the next
   * (with the root it matched, or the manifest it took). Returns the record
   * as stored, or undefined when it is not in one of them.
   */
  advance(
    hostId: HostId,
    continueId: string,
    from: readonly A2aContinueIncomingState[],
    to: Exclude<A2aContinueIncomingState, 'pending' | 'decided'>,
    extra: { rootId?: string; manifest?: A2aContinueManifestV1 } = {},
  ): ContinueRequestRecordV1 | undefined {
    const rec = this.records.get(key(hostId, continueId));
    if (!rec || !from.includes(rec.state)) return undefined;
    this.assertWritable();
    const next: ContinueRequestRecordV1 = { ...rec, ...structuredClone(extra), state: to, updatedAt: new Date(this.now()).toISOString() };
    // Never a record a reload would skip (a manifest where none belongs, or none where one must be): it would vanish on the next start.
    if (!coerceRecord(next)) throw new Error(`a ${to} record this store could not read back (${WITH_MANIFEST.has(to) ? 'it needs' : 'it takes no'} manifest)`);
    this.commit((m) => m.set(key(hostId, continueId), next));
    return structuredClone(next);
  }

  /** An open request was decided with a final code: the manifest goes. */
  decide(hostId: HostId, continueId: string, code: A2aContinueCode): ContinueRequestRecordV1 | undefined {
    const rec = this.records.get(key(hostId, continueId));
    if (!rec || !OPEN.has(rec.state) || !isFinalContinueCode(code)) return undefined;
    this.assertWritable();
    const at = new Date(this.now()).toISOString();
    const { manifest: _dropped, ...rest } = rec;
    const next: ContinueRequestRecordV1 = { ...rest, state: 'decided', code, updatedAt: at, decidedAt: at };
    this.commit((m) => m.set(key(hostId, continueId), next));
    return structuredClone(next);
  }

  /** `code` is in the outbox for this request. */
  markSent(hostId: HostId, continueId: string, code: A2aContinueCode): void {
    const rec = this.records.get(key(hostId, continueId));
    if (!rec || rec.sent === code) return;
    this.assertWritable();
    this.commit((m) => m.set(key(hostId, continueId), { ...rec, sent: code }));
  }

  /**
   * Staging spoken for but not written yet: the manifests of the requests
   * this PC is taking (`receiving`). A received or starting one has its bytes
   * on disk already, where the free space reads them. PR2b, which writes
   * staging, reserves only what a partial receive still lacks.
   */
  reservedBytes(): number {
    let n = 0;
    for (const r of this.records.values()) if (r.manifest && r.state === 'receiving') n += continueManifestBytes(r.manifest);
    return n;
  }

  /**
   * A paired PC was removed: its requests go, from memory at once (nothing of
   * that PC is answered or started after this) and then from the file; a
   * write that fails is logged. Returns the records dropped.
   */
  forgetHost(hostId: HostId): number {
    return this.retainHosts((h) => h !== hostId, `forgetting ${hostId}`);
  }

  /**
   * Keep only the requests of PCs `paired` still knows, e.g. on start: a
   * removal whose write failed before a restart is applied again here. A
   * failed write is logged; the next write writes every record again.
   */
  retainHosts(paired: (hostId: HostId) => boolean, why = 'dropping PCs no longer paired'): number {
    const gone = [...this.records.values()].filter((r) => !paired(r.hostId));
    if (gone.length === 0) return 0;
    for (const r of gone) this.records.delete(key(r.hostId, r.request.continueId));
    try {
      this.assertWritable();
      this.write(this.filePath, { v: 1, records: [...this.records.values()] });
      this.scheduleHarden(this.filePath);
    } catch (err) {
      this.log('error', `[a2a-remote] ${CONTINUE_REQUESTS_FILE}: not saved after ${why}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return gone.length;
  }

  /** Drop decided records kept past `CONTINUE_RECORD_KEEP_MS` since their decision. */
  prune(): number {
    const cutoff = this.now() - CONTINUE_RECORD_KEEP_MS;
    const stale = [...this.records.values()].filter((r) => r.state === 'decided' && Date.parse(r.decidedAt ?? r.updatedAt) < cutoff);
    if (stale.length === 0 || !this.writable) return 0;
    this.commit((m) => { for (const r of stale) m.delete(key(r.hostId, r.request.continueId)); });
    return stale.length;
  }

  /** Write the changed records, then make them the live ones: a failed write changes nothing. */
  private commit(change: (m: Map<string, ContinueRequestRecordV1>) => void): void {
    const next = new Map(this.records);
    change(next);
    this.write(this.filePath, { v: 1, records: [...next.values()] });
    this.scheduleHarden(this.filePath);
    this.records.clear();
    for (const [k, v] of next) this.records.set(k, v);
  }

  private assertWritable(): void {
    if (!this.writable) throw storeUnavailable(CONTINUE_REQUESTS_FILE);
  }
}

function coerceRecord(raw: unknown): ContinueRequestRecordV1 | null {
  if (!isPlainObject(raw) || raw['v'] !== 1) return null;
  const { hostId, state, code, rootId, receivedAt, updatedAt, decidedAt, sent } = raw;
  const request = parseContinueRequest(raw['request']);
  if (!isHostId(hostId) || !request || !isIsoString(receivedAt) || !isIsoString(updatedAt)) return null;
  if (typeof state !== 'string' || (state !== 'decided' && !OPEN.has(state))) return null;
  // A decided record names a final code; an open one names none.
  if (state === 'decided' ? !isContinueCode(code) || !isFinalContinueCode(code) : code !== undefined) return null;
  const manifest = raw['manifest'] === undefined ? undefined : parseContinueManifest(raw['manifest']);
  if (manifest === null || (manifest && manifest.continueId !== request.continueId)) return null;
  if (WITH_MANIFEST.has(state) !== (manifest !== undefined)) return null;
  if (rootId !== undefined && !isSafeId(rootId)) return null;
  return {
    v: 1,
    hostId,
    request,
    state: state as A2aContinueIncomingState,
    ...(manifest ? { manifest } : {}),
    ...(isContinueCode(code) ? { code } : {}),
    ...(typeof rootId === 'string' ? { rootId } : {}),
    receivedAt,
    updatedAt,
    ...(state === 'decided' ? { decidedAt: isIsoString(decidedAt) ? decidedAt : updatedAt } : {}),
    ...(isContinueCode(sent) ? { sent } : {}),
  };
}
