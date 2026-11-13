import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { isHostId, type HostId } from '../../shared/a2aRemote';
import {
  SPAWN_CLOCK_SKEW_MS,
  SPAWN_REQUEST_KEEP_MS,
  SPAWN_REQUESTS_MAX,
  SPAWN_TTL_MAX_MS,
  isSpawnCode,
  isSpawnId,
  parseSpawnRequest,
  type A2aSpawnCode,
  type A2aSpawnRequestState,
  type A2aSpawnRequestSummary,
  type A2aSpawnRequestV1,
} from '../../shared/a2aSpawn';
import { isIsoString, isPlainObject, isSafeId, loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * Remote spawn requests this PC received (`spawn-requests.json`), keyed by
 * (hostId, spawnId). It is what makes a resend harmless: the same request
 * again is answered from here and never decided twice; the same id with
 * another body is a conflict.
 *
 * The prompt is kept only while a request is open (pending, awaiting its
 * card, approved or starting: its card and its first task need it after a
 * restart); a decided record keeps the fingerprint and the outcome, never
 * the text. A decided record is kept while a resend of its request could
 * still pass the clock check (until the request's own expiry), and at least
 * `SPAWN_REQUEST_KEEP_MS` after it was decided. Each write lands before memory
 * changes, so a failed write leaves nothing behind. The decision's answer is
 * marked `sent` once it is queued, so one that never left is sent again on
 * recovery. At most `SPAWN_REQUESTS_MAX` records are kept in all: when they
 * are, the oldest decided ones whose answer left and whose request expired
 * make room. One PC may hold at most half of them in decided records that
 * could still be resent; past that its new requests wait. A start time such a record still counts for the hour and day
 * limits is kept apart (`starts`) for a day, while the receiver asks for it.
 *
 * Load: a record this build cannot read is skipped, never the whole file.
 */

export const SPAWN_REQUESTS_FILE = 'spawn-requests.json';

export interface SpawnRequestRecordV1 {
  v: 1;
  hostId: HostId;
  spawnId: string;
  /** sha256 of the request body as received (its canonical JSON). */
  fingerprint: string;
  agent: A2aSpawnRequestV1['agent'];
  rootId: string;
  state: A2aSpawnRequestState;
  code?: A2aSpawnCode;
  receivedAt: string;
  expiresAt: string;
  /** The request's own expiry (`expiresAt` is the one here, which may be sooner): a resend passes the clock check until then. */
  requestExpiresAt?: string;
  /** When it was approved (by its card or a rule); kept once decided, for the start caps. */
  approvedAt?: string;
  /** Decided only. */
  decidedAt?: string;
  /** Decided only: its spawn-result is in the outbox. */
  sent?: true;
  /** Open only (every state but `decided`). */
  request?: A2aSpawnRequestV1;
  /** Decided `started` only: B's new pane, the link's id and version, for a resend of the answer. */
  endpoint?: { kind: 'pane'; workspaceId: string; paneId: string };
  linkVersion?: number;
  linkId?: string;
  /** Starting only: when main claimed it (a start that never reports back is ended after a while). */
  claimedAt?: string;
  /** Starting only: the root's path the claim checked; the start must still match it. */
  claimedRoot?: string;
}

/** A start time of a record that made room, still counted by the hour and day limits. */
export interface SpawnStartMark {
  hostId: HostId;
  spawnId: string;
  approvedAt: string;
  /** It was started (`startsSince` counts it), not only approved. */
  started: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Until when a resend of this record's request could pass the clock check; a record from before `requestExpiresAt` was kept gets the longest such time. */
function replayableUntil(r: SpawnRequestRecordV1): number {
  if (r.requestExpiresAt) return Date.parse(r.requestExpiresAt);
  return Date.parse(r.receivedAt) + SPAWN_CLOCK_SKEW_MS + SPAWN_TTL_MAX_MS;
}

/** What a `started` decision keeps. */
export interface SpawnStarted {
  endpoint: { kind: 'pane'; workspaceId: string; paneId: string };
  linkVersion: number;
  linkId: string;
}

const OPEN: ReadonlySet<A2aSpawnRequestState> = new Set(['pending', 'awaiting', 'approved', 'starting']);

export type SpawnReceive =
  | { kind: 'new'; rec: SpawnRequestRecordV1 }
  | { kind: 'duplicate'; rec: SpawnRequestRecordV1 }
  | { kind: 'conflict' }
  /** No room: this PC holds half the store in decided records that could still be resent, or every record kept is open, owes its answer, or could still be resent. */
  | { kind: 'full' };

export interface SpawnRequestStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
}

const key = (hostId: HostId, spawnId: string): string => `${hostId}:${spawnId}`;

export function spawnFingerprint(req: A2aSpawnRequestV1): string {
  const canonical = {
    v: req.v, spawnId: req.spawnId, agent: req.agent,
    folder: { root: req.folder.root, sub: req.folder.sub ?? '' },
    text: req.text, expiresAt: req.expiresAt, from: req.from,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export class SpawnRequestStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly records = new Map<string, SpawnRequestRecordV1>();
  private starts: SpawnStartMark[] = [];
  private writable: boolean;

  constructor(opts: SpawnRequestStoreOptions) {
    this.filePath = path.join(opts.dir, SPAWN_REQUESTS_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: SPAWN_REQUESTS_FILE,
      coerce: (raw) => (isPlainObject(raw) && raw['v'] === 1 && Array.isArray(raw['records']) ? raw : null),
      now: this.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'no remote spawn request is remembered',
    });
    this.writable = loaded.writable;
    for (const r of (loaded.value?.['records'] as unknown[] | undefined) ?? []) {
      const rec = coerceRecord(r);
      if (rec) this.records.set(key(rec.hostId, rec.spawnId), rec);
      else this.log('warn', `[a2a-remote] ${SPAWN_REQUESTS_FILE}: a record this build cannot read was skipped`);
    }
    const marks = loaded.value?.['starts'];
    for (const m of Array.isArray(marks) ? marks : []) {
      if (isPlainObject(m) && isHostId(m['hostId']) && isSpawnId(m['spawnId']) && isIsoString(m['approvedAt']) && typeof m['started'] === 'boolean') {
        this.starts.push({ hostId: m['hostId'], spawnId: m['spawnId'], approvedAt: m['approvedAt'], started: m['started'] });
      }
    }
  }

  get(hostId: HostId, spawnId: string): SpawnRequestRecordV1 | undefined {
    const rec = this.records.get(key(hostId, spawnId));
    return rec ? structuredClone(rec) : undefined;
  }

  pending(): SpawnRequestRecordV1[] {
    return this.inState('pending');
  }

  inState(state: A2aSpawnRequestState): SpawnRequestRecordV1[] {
    return [...this.records.values()].filter((r) => r.state === state).map((r) => structuredClone(r));
  }

  /** Requests of `hostId` not decided yet (in any open state). */
  pendingCount(hostId: HostId): number {
    return [...this.records.values()].filter((r) => r.hostId === hostId && OPEN.has(r.state)).length;
  }

  /** Requests approved at or after `since` (ms), of `hostId` or of every PC. */
  approvedSince(since: number, hostId?: HostId): number {
    return [...this.records.values(), ...this.starts].filter((r) =>
      (hostId === undefined || r.hostId === hostId) && r.approvedAt !== undefined && Date.parse(r.approvedAt) >= since).length;
  }

  /**
   * Starts at or after `since` (ms) for `hostId`: requests approved then that
   * are starting or were started. `except` leaves one request out (the one
   * being checked).
   */
  startsSince(since: number, hostId: HostId, except?: string): number {
    const records = [...this.records.values()].filter((r) =>
      r.hostId === hostId && r.spawnId !== except && r.approvedAt !== undefined && Date.parse(r.approvedAt) >= since &&
      (r.state === 'starting' || r.code === 'started')).length;
    return records + this.starts.filter((m) => m.hostId === hostId && m.started && Date.parse(m.approvedAt) >= since).length;
  }

  /** Requests approved or starting, of `hostId` or of every PC (they are about to be live). */
  startingCount(hostId?: HostId): number {
    return [...this.records.values()].filter((r) =>
      (hostId === undefined || r.hostId === hostId) && (r.state === 'approved' || r.state === 'starting')).length;
  }

  /**
   * Move an open request on: `from` the states it may be in, `to` the next.
   * Returns the record as stored, or undefined when it is not in one of them.
   */
  advance(hostId: HostId, spawnId: string, from: readonly A2aSpawnRequestState[], to: Exclude<A2aSpawnRequestState, 'decided'>): SpawnRequestRecordV1 | undefined {
    const rec = this.records.get(key(hostId, spawnId));
    if (!rec || !from.includes(rec.state)) return undefined;
    this.assertWritable();
    const at = new Date(this.now()).toISOString();
    const { claimedAt: _claimed, claimedRoot: _root, ...rest } = rec;
    const next: SpawnRequestRecordV1 = {
      ...rest,
      state: to,
      ...(to === 'approved' && rec.approvedAt === undefined ? { approvedAt: at } : {}),
      ...(to === 'starting' ? { claimedAt: at } : {}),
    };
    this.commit((m) => m.set(key(hostId, spawnId), next));
    return structuredClone(next);
  }

  /** Newest first, without the prompt. */
  summaries(): A2aSpawnRequestSummary[] {
    return [...this.records.values()]
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
      .map((r) => ({
        hostId: r.hostId, spawnId: r.spawnId, agent: r.agent, rootId: r.rootId, state: r.state,
        ...(r.code ? { code: r.code } : {}), receivedAt: r.receivedAt, expiresAt: r.expiresAt,
      }));
  }

  /** Decided records whose answer never reached the outbox. */
  unsent(): SpawnRequestRecordV1[] {
    return [...this.records.values()].filter((r) => r.state === 'decided' && !r.sent).map((r) => structuredClone(r));
  }

  /**
   * Record a request that passed the cheap checks, pending its decision.
   * `localExpiresAt`: when it ends here, if this PC keeps it for less time
   * than the request asks (the record's `expiresAt`; the request is kept as sent).
   * `keepStarts`: an hour or day limit on starts is set, so a record that
   * makes room leaves its start time behind.
   */
  receive(hostId: HostId, req: A2aSpawnRequestV1, localExpiresAt?: string, keepStarts = false): SpawnReceive {
    this.assertWritable();
    const fingerprint = spawnFingerprint(req);
    const known = this.records.get(key(hostId, req.spawnId));
    if (known) return known.fingerprint === fingerprint ? { kind: 'duplicate', rec: structuredClone(known) } : { kind: 'conflict' };
    this.prune();
    const now = this.now();
    // One PC holds at most half the store in decided requests that could still be resent: the others keep room.
    const replayableHere = [...this.records.values()].filter((r) => r.hostId === hostId && r.state === 'decided' && replayableUntil(r) >= now).length;
    if (replayableHere >= SPAWN_REQUESTS_MAX / 2) return { kind: 'full' };
    // Room: the oldest decided records that can no longer matter (answer gone, request expired) go first.
    const over = this.records.size - SPAWN_REQUESTS_MAX + 1;
    const making = over <= 0 ? [] : [...this.records.values()]
      .filter((r) => r.state === 'decided' && r.sent && replayableUntil(r) < now)
      .sort((a, b) => Date.parse(a.decidedAt ?? a.receivedAt) - Date.parse(b.decidedAt ?? b.receivedAt))
      .slice(0, over);
    if (making.length < over) return { kind: 'full' };
    const marks = keepStarts
      ? making.flatMap((r): SpawnStartMark[] => (r.approvedAt !== undefined && Date.parse(r.approvedAt) >= now - DAY_MS
        ? [{ hostId: r.hostId, spawnId: r.spawnId, approvedAt: r.approvedAt, started: r.code === 'started' }]
        : []))
      : [];
    const rec: SpawnRequestRecordV1 = {
      v: 1,
      hostId,
      spawnId: req.spawnId,
      fingerprint,
      agent: req.agent,
      rootId: req.folder.root,
      state: 'pending',
      request: structuredClone(req),
      receivedAt: new Date(now).toISOString(),
      expiresAt: localExpiresAt ?? req.expiresAt,
      requestExpiresAt: req.expiresAt,
    };
    this.commit((m) => {
      for (const r of making) m.delete(key(r.hostId, r.spawnId));
      m.set(key(hostId, req.spawnId), rec);
    }, marks.length > 0 ? [...this.starts, ...marks] : undefined);
    return { kind: 'new', rec: structuredClone(rec) };
  }

  /** A starting request's claim passed its checks against this root path. */
  noteClaimedRoot(hostId: HostId, spawnId: string, rootPath: string): void {
    const rec = this.records.get(key(hostId, spawnId));
    if (!rec || rec.state !== 'starting') return;
    this.assertWritable();
    this.commit((m) => m.set(key(hostId, spawnId), { ...rec, claimedRoot: rootPath }));
  }

  /** An open request was decided: keep the outcome, drop the text. `started` names the new pane. */
  decide(
    hostId: HostId,
    spawnId: string,
    code: A2aSpawnCode,
    started?: SpawnStarted,
  ): SpawnRequestRecordV1 | undefined {
    const rec = this.records.get(key(hostId, spawnId));
    if (!rec || !OPEN.has(rec.state)) return undefined;
    this.assertWritable();
    const { request: _dropped, claimedAt: _claimed, claimedRoot: _root, ...rest } = rec;
    const next: SpawnRequestRecordV1 = {
      ...rest,
      state: 'decided',
      code,
      decidedAt: new Date(this.now()).toISOString(),
      ...(code === 'started' && started ? { endpoint: { ...started.endpoint }, linkVersion: started.linkVersion, linkId: started.linkId } : {}),
    };
    this.commit((m) => m.set(key(hostId, spawnId), next));
    return structuredClone(next);
  }

  /** The decision's answer is in the outbox. */
  markSent(hostId: HostId, spawnId: string): void {
    const rec = this.records.get(key(hostId, spawnId));
    if (!rec || rec.state !== 'decided' || rec.sent) return;
    this.assertWritable();
    this.commit((m) => m.set(key(hostId, spawnId), { ...rec, sent: true }));
  }

  /**
   * A paired PC was removed: its requests go, from memory at once (nothing
   * of that PC is decided or answered after this) and then from the file;
   * a write that fails is logged. Returns the pending ones dropped.
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
    const marksGone = this.starts.some((m) => !paired(m.hostId));
    if (gone.length === 0 && !marksGone) return 0;
    for (const r of gone) this.records.delete(key(r.hostId, r.spawnId));
    this.starts = this.starts.filter((m) => paired(m.hostId));
    try {
      this.assertWritable();
      this.write(this.filePath, this.fileOf(this.records, this.starts));
      this.scheduleHarden(this.filePath);
    } catch (err) {
      this.log('error', `[a2a-remote] ${SPAWN_REQUESTS_FILE}: not saved after ${why}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return gone.filter((r) => r.state === 'pending').length;
  }

  /**
   * Drop decided records kept past `SPAWN_REQUEST_KEEP_MS` since their
   * decision whose request can no longer be resent, and start times older
   * than a day.
   */
  prune(): number {
    const now = this.now();
    const cutoff = now - SPAWN_REQUEST_KEEP_MS;
    const stale = [...this.records.values()].filter((r) =>
      r.state === 'decided' && Date.parse(r.decidedAt ?? r.receivedAt) < cutoff && replayableUntil(r) < now);
    const marks = this.starts.filter((m) => Date.parse(m.approvedAt) >= now - DAY_MS);
    if ((stale.length === 0 && marks.length === this.starts.length) || !this.writable) return 0;
    this.commit((m) => { for (const r of stale) m.delete(key(r.hostId, r.spawnId)); }, marks);
    return stale.length;
  }

  /** Write the changed records (and start times), then make them the live ones: a failed write changes nothing. */
  private commit(change: (m: Map<string, SpawnRequestRecordV1>) => void, starts = this.starts): void {
    const next = new Map(this.records);
    change(next);
    this.write(this.filePath, this.fileOf(next, starts));
    this.scheduleHarden(this.filePath);
    this.records.clear();
    for (const [k, v] of next) this.records.set(k, v);
    this.starts = starts;
  }

  private fileOf(records: Map<string, SpawnRequestRecordV1>, starts: readonly SpawnStartMark[]): unknown {
    return { v: 1, records: [...records.values()], ...(starts.length > 0 ? { starts } : {}) };
  }

  private assertWritable(): void {
    if (!this.writable) throw storeUnavailable(SPAWN_REQUESTS_FILE);
  }
}

function coerceRecord(raw: unknown): SpawnRequestRecordV1 | null {
  if (!isPlainObject(raw) || raw['v'] !== 1) return null;
  const { hostId, spawnId, fingerprint, agent, rootId, state, code, receivedAt, expiresAt } = raw;
  if (!isHostId(hostId) || !isSpawnId(spawnId) || typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
  if (typeof agent !== 'string' || typeof rootId !== 'string' || !isIsoString(receivedAt) || !isIsoString(expiresAt)) return null;
  const approvedAt = isIsoString(raw['approvedAt']) ? { approvedAt: raw['approvedAt'] } : {};
  const requestExpiresAt = isIsoString(raw['requestExpiresAt']) ? { requestExpiresAt: raw['requestExpiresAt'] } : {};
  if (typeof state === 'string' && OPEN.has(state as A2aSpawnRequestState)) {
    const request = parseSpawnRequest(raw['request']);
    if (!request || request.spawnId !== spawnId) return null;
    return {
      v: 1, hostId, spawnId, fingerprint, agent: request.agent, rootId: request.folder.root,
      state: state as A2aSpawnRequestState, receivedAt, expiresAt, ...requestExpiresAt, ...approvedAt,
      ...(state === 'starting' && isIsoString(raw['claimedAt']) ? { claimedAt: raw['claimedAt'] } : {}),
      ...(state === 'starting' && typeof raw['claimedRoot'] === 'string' ? { claimedRoot: raw['claimedRoot'] } : {}),
      request,
    };
  }
  if (state !== 'decided' || !isSpawnCode(code)) return null;
  // A `started` answer is resent with its pane, so it is kept only whole.
  const endpoint = raw['endpoint'];
  const linkVersion = raw['linkVersion'];
  const linkId = raw['linkId'];
  const started = code === 'started' && isPlainObject(endpoint) && endpoint['kind'] === 'pane' &&
    isSafeId(endpoint['workspaceId']) && isSafeId(endpoint['paneId']) && typeof linkVersion === 'number' && Number.isInteger(linkVersion) && linkVersion >= 1 &&
    isSafeId(linkId)
    ? { endpoint: { kind: 'pane' as const, workspaceId: endpoint['workspaceId'] as string, paneId: endpoint['paneId'] as string }, linkVersion, linkId }
    : undefined;
  if (code === 'started' && !started) return null;
  const decidedAt = isIsoString(raw['decidedAt']) ? raw['decidedAt'] : receivedAt;
  return {
    v: 1, hostId, spawnId, fingerprint, agent: agent as A2aSpawnRequestV1['agent'], rootId, state, code, receivedAt, expiresAt, ...requestExpiresAt, decidedAt, ...approvedAt,
    ...(started ?? {}),
    ...(raw['sent'] === true ? { sent: true as const } : {}),
  };
}
