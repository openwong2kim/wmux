import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { isAgentSlug, type AgentSlug } from '../../shared/agentIdentity';
import { isHostId, type HostId } from '../../shared/a2aRemote';
import { isSpawnId } from '../../shared/a2aSpawn';
import { isIsoString, isPlainObject, isSafeId, loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * The starts this daemon made itself in headless mode (`headless-starts.json`
 * in the a2a dir). A record is written before anything it names exists, so a
 * start cut short at any step (a crash, a restart) is found and taken back:
 *
 *   prepared — the session id is reserved; the worktree may exist
 *   created  — the worktree and the session exist; `started` not stored yet
 *   started  — the request is stored `started` (the link exists or is owed)
 *   ended    — the session is gone and its link ended; the worktree and its
 *              branch are kept (the agent's work), listed by
 *              `wmux daemon headless status`
 *
 * `runId` is the daemon run that started the session: a daemon restart ends
 * every agent it ran, so a record of another run is never live.
 */

export const HEADLESS_STARTS_FILE = 'headless-starts.json';
/** Records kept at most; past it the oldest ended one is dropped (its worktree stays on disk). */
export const HEADLESS_STARTS_MAX = 1000;

export type HeadlessStartPhase = 'prepared' | 'created' | 'started' | 'ended';
const PHASES: ReadonlySet<string> = new Set<HeadlessStartPhase>(['prepared', 'created', 'started', 'ended']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface HeadlessStartRecordV1 {
  v: 1;
  hostId: HostId;
  spawnId: string;
  agent: AgentSlug;
  /** The allowed root the claim checked (a git repository's top level). */
  repoPath: string;
  /** The daemon session the agent runs in (also the link's local pane id). */
  sessionId: string;
  /** The link's local workspace id. */
  workspaceId: string;
  /** The conversation id the agent is pinned to (`--session-id`). */
  agentSessionId: string;
  /** "Started remotely, cannot fan out again": the PC it was started for. */
  lineage: string;
  runId: string;
  phase: HeadlessStartPhase;
  worktreePath?: string;
  cwd?: string;
  linkId?: string;
  startedAt: string;
  endedAt?: string;
}

export interface HeadlessStartStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
}

const key = (hostId: string, spawnId: string): string => `${hostId}:${spawnId}`;

export class HeadlessStartStore {
  readonly filePath: string;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly records = new Map<string, HeadlessStartRecordV1>();
  private readonly writable: boolean;

  constructor(opts: HeadlessStartStoreOptions) {
    this.filePath = path.join(opts.dir, HEADLESS_STARTS_FILE);
    const log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: HEADLESS_STARTS_FILE,
      coerce: (raw) => (isPlainObject(raw) && raw['v'] === 1 && Array.isArray(raw['starts']) ? raw['starts'] : null),
      now: opts.now ?? Date.now,
      log,
      level: 'warn',
      emptyMeans: 'no headless start is known',
    });
    this.writable = loaded.writable;
    for (const r of loaded.value ?? []) {
      const rec = coerceHeadlessStart(r);
      if (rec) this.records.set(key(rec.hostId, rec.spawnId), rec);
      else log('warn', `[a2a-remote] ${HEADLESS_STARTS_FILE}: a record this build cannot read was skipped`);
    }
  }

  get(hostId: string, spawnId: string): HeadlessStartRecordV1 | undefined {
    const rec = this.records.get(key(hostId, spawnId));
    return rec ? structuredClone(rec) : undefined;
  }

  /** The phase of the start that runs in `sessionId`, if any (no copy made). */
  phaseOfSession(sessionId: string): HeadlessStartPhase | undefined {
    for (const rec of this.records.values()) if (rec.sessionId === sessionId) return rec.phase;
    return undefined;
  }

  /** The phase of the start that made `linkId`, if any (no copy made). */
  phaseOfLink(linkId: string): HeadlessStartPhase | undefined {
    for (const rec of this.records.values()) if (rec.linkId === linkId) return rec.phase;
    return undefined;
  }

  list(): HeadlessStartRecordV1[] {
    return [...this.records.values()].map((r) => structuredClone(r));
  }

  add(rec: HeadlessStartRecordV1): void {
    if (!this.writable) throw storeUnavailable(HEADLESS_STARTS_FILE);
    const clean = coerceHeadlessStart(rec);
    if (!clean) throw new Error('headless start: invalid record');
    const k = key(clean.hostId, clean.spawnId);
    if (this.records.has(k)) throw new Error(`headless start ${clean.spawnId}: already recorded`);
    const next = new Map(this.records);
    // Full: the oldest ended start makes room (its worktree stays on disk, only no longer listed).
    if (next.size >= HEADLESS_STARTS_MAX) {
      const oldest = [...next.entries()].filter(([, r]) => r.phase === 'ended')
        .sort(([, a], [, b]) => Date.parse(a.endedAt ?? a.startedAt) - Date.parse(b.endedAt ?? b.startedAt))[0];
      if (!oldest) throw new Error(`headless starts: ${HEADLESS_STARTS_MAX} are recorded already`);
      next.delete(oldest[0]);
    }
    next.set(k, clean);
    this.save(next);
  }

  update(
    hostId: string,
    spawnId: string,
    patch: Partial<Pick<HeadlessStartRecordV1, 'phase' | 'worktreePath' | 'cwd' | 'linkId' | 'endedAt'>>,
  ): HeadlessStartRecordV1 {
    const k = key(hostId, spawnId);
    const rec = this.records.get(k);
    if (!rec) throw new Error(`headless start ${spawnId}: not recorded`);
    if (!this.writable) throw storeUnavailable(HEADLESS_STARTS_FILE);
    const updated = coerceHeadlessStart({ ...rec, ...patch });
    if (!updated) throw new Error('headless start: invalid update');
    const next = new Map(this.records);
    next.set(k, updated);
    this.save(next);
    return structuredClone(updated);
  }

  remove(hostId: string, spawnId: string): void {
    const k = key(hostId, spawnId);
    if (!this.records.has(k)) return;
    if (!this.writable) throw storeUnavailable(HEADLESS_STARTS_FILE);
    const next = new Map(this.records);
    next.delete(k);
    this.save(next);
  }

  /** Write first, then make it the live set: a failed write changes nothing. */
  private save(next: Map<string, HeadlessStartRecordV1>): void {
    this.write(this.filePath, { v: 1, starts: [...next.values()] });
    this.scheduleHarden(this.filePath);
    this.records.clear();
    for (const [k, v] of next) this.records.set(k, v);
  }
}

const optionalPath = (v: unknown): v is string | undefined => v === undefined || (typeof v === 'string' && v.length > 0 && v.length <= 4096);

/** A record as stored, or null when it is not one (also read by `wmux daemon headless status`). */
export function coerceHeadlessStart(raw: unknown): HeadlessStartRecordV1 | null {
  if (!isPlainObject(raw) || raw['v'] !== 1) return null;
  const { hostId, spawnId, agent, repoPath, sessionId, workspaceId, agentSessionId, lineage, runId, phase, worktreePath, cwd, linkId, startedAt, endedAt } = raw;
  if (!isHostId(hostId) || !isSpawnId(spawnId) || !isAgentSlug(agent)) return null;
  if (typeof repoPath !== 'string' || !repoPath || repoPath.length > 4096) return null;
  if (!isSafeId(sessionId) || !isSafeId(workspaceId) || !isSafeId(runId)) return null;
  if (typeof agentSessionId !== 'string' || !UUID_RE.test(agentSessionId)) return null;
  if (typeof lineage !== 'string' || lineage.length > 128) return null;
  if (typeof phase !== 'string' || !PHASES.has(phase)) return null;
  if (!optionalPath(worktreePath) || !optionalPath(cwd)) return null;
  if (linkId !== undefined && (typeof linkId !== 'string' || !UUID_RE.test(linkId))) return null;
  if (!isIsoString(startedAt) || (endedAt !== undefined && !isIsoString(endedAt))) return null;
  return {
    v: 1, hostId, spawnId, agent, repoPath, sessionId, workspaceId, agentSessionId, lineage, runId,
    phase: phase as HeadlessStartPhase,
    ...(worktreePath !== undefined ? { worktreePath } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(linkId !== undefined ? { linkId } : {}),
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}
