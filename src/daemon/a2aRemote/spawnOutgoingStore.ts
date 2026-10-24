import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { isAgentSlug, type AgentSlug } from '../../shared/agentIdentity';
import { isHostId, type HostId } from '../../shared/a2aRemote';
import {
  SPAWN_REQUESTS_MAX,
  SPAWN_REQUEST_KEEP_MS,
  SPAWN_REQUEST_KEY_RE,
  isSpawnCode,
  isSpawnId,
  isSpawnRootId,
  normalizeSpawnSub,
  parseSpawnTargets,
  type A2aSpawnCode,
  type A2aSpawnOutgoingState,
  type A2aSpawnTargetsV1,
} from '../../shared/a2aSpawn';
import { isIsoString, isPlainObject, isSafeId, loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * The asking side of remote spawn (`spawn-outgoing.json`): the requests this
 * PC sent to other PCs, and what each of them last said this PC may ask for.
 *
 * The prompt is kept until the request is started or refused (it becomes
 * this PC's copy of the started agent's first task); an expired request keeps
 * it, since the other PC may still answer `started`. A closed record is kept
 * for a day past its expiry, then pruned; open ones are never dropped to make room.
 */

export const SPAWN_OUTGOING_FILE = 'spawn-outgoing.json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES: ReadonlySet<string> = new Set<A2aSpawnOutgoingState>(['sent', 'waiting', 'started', 'refused', 'expired']);
const OPEN: ReadonlySet<A2aSpawnOutgoingState> = new Set<A2aSpawnOutgoingState>(['sent', 'waiting']);
/** Still takes the other PC's answer (and keeps the prompt for it): an expired one too, until it is pruned. */
const TAKES_ANSWER: ReadonlySet<A2aSpawnOutgoingState> = new Set<A2aSpawnOutgoingState>(['sent', 'waiting', 'expired']);

export interface SpawnOutgoingRecordV1 {
  v: 1;
  hostId: HostId;
  spawnId: string;
  agent: AgentSlug;
  rootId: string;
  sub?: string;
  /** The pane here that gets the replies. */
  from: { workspaceId: string; paneId: string };
  /** Who asked, for the per-pane hourly limit: the pane that gets the replies. */
  callerKey: string;
  /** The asker's id for the request (`A2aSpawnAskInput.requestKey`). */
  requestKey?: string;
  /** The prompt, until the request is final. */
  text?: string;
  state: A2aSpawnOutgoingState;
  code?: A2aSpawnCode;
  /** `started`: the link to the agent (the uuid the other PC minted). */
  linkId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface SpawnOutgoingStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
}

const key = (hostId: string, spawnId: string): string => `${hostId}:${spawnId}`;

export class SpawnOutgoingStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private records = new Map<string, SpawnOutgoingRecordV1>();
  private targetsBy = new Map<HostId, A2aSpawnTargetsV1>();
  private readonly writable: boolean;

  constructor(opts: SpawnOutgoingStoreOptions) {
    this.filePath = path.join(opts.dir, SPAWN_OUTGOING_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: SPAWN_OUTGOING_FILE,
      coerce: (raw) => (isPlainObject(raw) && raw['v'] === 1 && Array.isArray(raw['requests']) && isPlainObject(raw['targets']) ? raw : null),
      now: this.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'this PC has sent no request to start an agent',
    });
    this.writable = loaded.writable;
    const value = loaded.value as { requests: unknown[]; targets: Record<string, unknown> } | null;
    for (const r of value?.requests ?? []) {
      const rec = coerceRecord(r);
      if (rec) this.records.set(key(rec.hostId, rec.spawnId), rec);
      else this.log('warn', `[a2a-remote] ${SPAWN_OUTGOING_FILE}: a request this build cannot read was skipped`);
    }
    for (const [hostId, t] of Object.entries(value?.targets ?? {})) {
      const targets = parseSpawnTargets(t);
      if (isHostId(hostId) && targets) this.targetsBy.set(hostId, targets);
    }
  }

  get(hostId: HostId, spawnId: string): SpawnOutgoingRecordV1 | undefined {
    const rec = this.records.get(key(hostId, spawnId));
    return rec ? structuredClone(rec) : undefined;
  }

  /** Newest first. */
  list(): SpawnOutgoingRecordV1[] {
    return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => structuredClone(r));
  }

  /** Waiting for the other PC's answer, or expired here and still taking it. */
  takesAnswer(hostId: HostId, spawnId: string): boolean {
    const rec = this.records.get(key(hostId, spawnId));
    return rec !== undefined && TAKES_ANSWER.has(rec.state);
  }

  /** Requests to `hostId` still waiting for their answer. */
  openCount(hostId: HostId): number {
    let n = 0;
    for (const r of this.records.values()) if (r.hostId === hostId && OPEN.has(r.state)) n += 1;
    return n;
  }

  /** The request `callerKey` already stored under `requestKey`, if any. */
  byRequestKey(callerKey: string, requestKey: string): SpawnOutgoingRecordV1 | undefined {
    for (const r of this.records.values()) if (r.callerKey === callerKey && r.requestKey === requestKey) return r;
    return undefined;
  }

  /** Requests `callerKey` sent since `since` (ms), to any PC. */
  sentSince(callerKey: string, since: number): number {
    let n = 0;
    for (const r of this.records.values()) if (r.callerKey === callerKey && Date.parse(r.createdAt) >= since) n += 1;
    return n;
  }

  /**
   * Written before the envelope is queued. Past the bound, the oldest final
   * record that takes no answer goes. Open and expired ones never go (an
   * expired one still takes a late `started`): with only those left, the new
   * request is refused until expired ones are pruned.
   */
  add(rec: SpawnOutgoingRecordV1): void {
    if (!this.writable) throw storeUnavailable(SPAWN_OUTGOING_FILE);
    const clean = coerceRecord(rec);
    if (!clean) throw new Error('spawn request: invalid record');
    const k = key(clean.hostId, clean.spawnId);
    if (this.records.has(k)) throw new Error(`spawn request ${clean.spawnId}: already recorded`);
    const next = this.pruned();
    if (next.size >= SPAWN_REQUESTS_MAX) {
      const oldestFinal = [...next.values()].filter((r) => !TAKES_ANSWER.has(r.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
      if (!oldestFinal) throw new Error(`spawn requests: ${SPAWN_REQUESTS_MAX} are waiting or may still be answered`);
      next.delete(key(oldestFinal.hostId, oldestFinal.spawnId));
    }
    next.set(k, clean);
    this.save(next, this.targetsBy);
  }

  /** Drop a record that was never sent (its envelope could not be queued). */
  remove(hostId: HostId, spawnId: string): void {
    const k = key(hostId, spawnId);
    if (!this.records.has(k)) return;
    if (!this.writable) throw storeUnavailable(SPAWN_OUTGOING_FILE);
    const next = new Map(this.records);
    next.delete(k);
    this.save(next, this.targetsBy);
  }

  /** A new state; started or refused drops the prompt, refused its link id too. Written before memory changes. */
  settle(hostId: HostId, spawnId: string, patch: { state: A2aSpawnOutgoingState; code?: A2aSpawnCode; linkId?: string }): SpawnOutgoingRecordV1 {
    const k = key(hostId, spawnId);
    const rec = this.records.get(k);
    if (!rec) throw new Error(`spawn request ${spawnId}: not recorded`);
    if (!this.writable) throw storeUnavailable(SPAWN_OUTGOING_FILE);
    const { text: _text, ...rest } = rec;
    const { linkId: _linkId, ...unlinked } = rest;
    const updated: SpawnOutgoingRecordV1 = {
      ...(TAKES_ANSWER.has(patch.state) ? rec : patch.state === 'refused' ? unlinked : rest),
      state: patch.state,
      ...(patch.code ? { code: patch.code } : {}),
      ...(patch.linkId ? { linkId: patch.linkId } : {}),
      updatedAt: new Date(this.now()).toISOString(),
    };
    const next = new Map(this.records);
    next.set(k, updated);
    this.save(next, this.targetsBy);
    return structuredClone(updated);
  }

  targets(hostId: HostId): A2aSpawnTargetsV1 | undefined {
    const t = this.targetsBy.get(hostId);
    return t ? structuredClone(t) : undefined;
  }

  /** What `hostId` says this PC may ask for; an older version than the one kept changes nothing. */
  setTargets(hostId: HostId, targets: A2aSpawnTargetsV1): boolean {
    const had = this.targetsBy.get(hostId);
    if (had && had.version >= targets.version) return false;
    if (!this.writable) throw storeUnavailable(SPAWN_OUTGOING_FILE);
    const next = new Map(this.targetsBy);
    next.set(hostId, structuredClone(targets));
    this.save(this.records, next);
    return true;
  }

  /** A PC no longer paired: its requests and targets go. */
  forgetHost(hostId: HostId): void {
    const next = new Map([...this.records].filter(([, r]) => r.hostId !== hostId));
    if (next.size === this.records.size && !this.targetsBy.has(hostId)) return;
    if (!this.writable) throw storeUnavailable(SPAWN_OUTGOING_FILE);
    const targets = new Map(this.targetsBy);
    targets.delete(hostId);
    this.save(next, targets);
  }

  /** Final records a day past their expiry go. */
  private pruned(): Map<string, SpawnOutgoingRecordV1> {
    const now = this.now();
    return new Map([...this.records].filter(([, r]) => OPEN.has(r.state) || Date.parse(r.expiresAt) + SPAWN_REQUEST_KEEP_MS > now));
  }

  /** Write first, then make it the live set: a failed write changes nothing. */
  private save(records: Map<string, SpawnOutgoingRecordV1>, targets: Map<HostId, A2aSpawnTargetsV1>): void {
    this.write(this.filePath, { v: 1, requests: [...records.values()], targets: Object.fromEntries(targets) });
    this.scheduleHarden(this.filePath);
    this.records = new Map(records);
    this.targetsBy = new Map(targets);
  }
}

function coerceRecord(raw: unknown): SpawnOutgoingRecordV1 | null {
  if (!isPlainObject(raw) || raw['v'] !== 1) return null;
  const { hostId, spawnId, agent, rootId, sub, from, callerKey, requestKey, text, state, code, linkId, createdAt, updatedAt, expiresAt } = raw;
  if (!isHostId(hostId) || !isSpawnId(spawnId) || !isAgentSlug(agent) || !isSpawnRootId(rootId)) return null;
  if (sub !== undefined && (typeof sub !== 'string' || !sub || normalizeSpawnSub(sub) !== sub)) return null;
  if (!isPlainObject(from) || !isSafeId(from['workspaceId']) || !isSafeId(from['paneId'])) return null;
  if (!isSafeId(callerKey) || (text !== undefined && typeof text !== 'string')) return null;
  if (requestKey !== undefined && (typeof requestKey !== 'string' || !SPAWN_REQUEST_KEY_RE.test(requestKey))) return null;
  if (typeof state !== 'string' || !STATES.has(state) || (code !== undefined && !isSpawnCode(code))) return null;
  if (linkId !== undefined && (typeof linkId !== 'string' || !UUID_RE.test(linkId))) return null;
  if (!isIsoString(createdAt) || !isIsoString(updatedAt) || !isIsoString(expiresAt)) return null;
  return {
    v: 1, hostId, spawnId, agent, rootId, ...(sub ? { sub: sub as string } : {}),
    from: { workspaceId: from['workspaceId'] as string, paneId: from['paneId'] as string },
    callerKey, ...(typeof requestKey === 'string' ? { requestKey } : {}), ...(typeof text === 'string' ? { text } : {}),
    state: state as A2aSpawnOutgoingState, ...(code ? { code: code as A2aSpawnCode } : {}),
    ...(typeof linkId === 'string' ? { linkId } : {}),
    createdAt, updatedAt, expiresAt,
  };
}
