// The WorkLink store: one atomic JSON file (`work-links.json`) in the wmux data
// dir, cached in memory. Main is the only writer, so the cache is the truth and
// the file is its durable copy. Every mutation updates the cache synchronously,
// then queues a write of the whole cache; writes run one at a time, so the last
// one on disk is always the newest cache.
//
// Decisions live in another store (deck-decisions.json), so a link's stored
// state can lag them (a decision cleared by a loop reset, a crash between an
// answer and this write). Reads therefore re-derive against the decisions
// pending right now, every decision write re-derives the links that hold one,
// and the cache re-derives everything once when it loads.
//
// Never throws: a torn file loads as an empty store, a bad record is dropped on
// its own, and a failed write is logged and retried by the next mutation. The
// callers are delivery paths (A2A send, decisions) that must not fail because
// bookkeeping did. See docs/work-links.md.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { loadDeckDecisions, onDecisionsChanged } from '../deck/deckDecisionStore';
import {
  WORK_LINK_LIMITS,
  deriveLinkState,
  isWorkLinkId,
  matchesWorkLinkFilter,
  parseWorkLink,
  stateTakesReason,
  type WorkLink,
  type WorkLinkFilter,
  type WorkLinkReason,
  type WorkLinkState,
} from '../../shared/workLink';

/** The most links kept; past it the oldest done/abandoned ones go first. */
export const MAX_WORK_LINKS = 500;

/** Fields a producer may set. `id` or `a2aTaskId` finds an existing link;
 *  creating one needs `origin` and `owner`. `id` and `createdAt` never change;
 *  `origin` changes only from 'manual' to 'issue' (the work turned out to be
 *  about an issue). State is derived, never passed here (see setState). */
export type WorkLinkUpsert = Partial<
  Omit<WorkLink, 'state' | 'reason' | 'manualClose' | 'decisionIds' | 'createdAt' | 'updatedAt'>
>;

interface WorkLinkFile {
  version: 1;
  links: WorkLink[];
}

const isFileShape = (v: unknown): v is { links: unknown[] } =>
  !!v && typeof v === 'object' && Array.isArray((v as { links?: unknown }).links);

export function getWorkLinkPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'work-links.json');
}

/** Ids of every decision still pending, across workspaces. Never throws. */
function pendingDecisionIdsFromDeck(): Set<string> {
  try {
    return new Set(
      Object.values(loadDeckDecisions())
        .filter((d) => d.status === 'pending')
        .map((d) => d.id),
    );
  } catch {
    return new Set();
  }
}

export interface WorkLinkStoreOptions {
  dir?: string;
  pendingDecisionIds?: () => Set<string>;
  now?: () => number;
}

export class WorkLinkStore {
  private links: Map<string, WorkLink> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(ids: string[]) => void>();
  private readonly filePath: string;
  private readonly pendingDecisionIds: () => Set<string>;
  private readonly now: () => number;

  constructor(opts: WorkLinkStoreOptions = {}) {
    this.filePath = getWorkLinkPath(opts.dir);
    this.pendingDecisionIds = opts.pendingDecisionIds ?? pendingDecisionIdsFromDeck;
    this.now = opts.now ?? Date.now;
  }

  list(filter: WorkLinkFilter = {}): WorkLink[] {
    const pending = this.pendingFor([...this.cache().values()]);
    return [...this.cache().values()]
      .map((l) => this.rederive(l, pending))
      .filter((l) => matchesWorkLinkFilter(l, filter))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): WorkLink | null {
    const link = this.cache().get(id);
    return link ? this.rederive(link) : null;
  }

  getByTaskId(a2aTaskId: string): WorkLink | null {
    const link = this.rawByTask(a2aTaskId);
    return link ? this.rederive(link) : null;
  }

  /** Create or merge a link, then re-derive its state. Null when the input is
   *  invalid (nothing is written). */
  async upsert(input: WorkLinkUpsert): Promise<WorkLink | null> {
    try {
      const links = this.cache();
      const prev =
        (input.id ? links.get(input.id) : undefined) ?? (input.a2aTaskId ? this.rawByTask(input.a2aTaskId) : undefined);
      if (!prev && (!input.origin || !input.owner)) return null;
      const now = this.now();
      const origin = !prev
        ? input.origin
        : prev.origin === 'manual' && input.origin === 'issue'
          ? 'issue'
          : prev.origin;
      const merged = parseWorkLink({
        ...(prev ?? { state: 'queued', decisionIds: [], createdAt: now }),
        ...stripUndefined(input),
        id: prev?.id ?? input.id ?? randomUUID(),
        origin,
        updatedAt: now,
      });
      // A task id already held by another link would break one-link-per-task.
      if (!merged || (merged.a2aTaskId && this.taskHeldByOther(merged.a2aTaskId, merged.id))) return null;
      return await this.commit(this.rederive(merged));
    } catch (err) {
      console.warn('[workLinks] upsert failed:', err);
      return null;
    }
  }

  /** Set a state by hand. A hand close (`abandoned`) holds until a PR merges.
   *  Any other state holds only while the task and PR say nothing (a link not
   *  handed out yet); reads derive it from them otherwise. Returns what a
   *  reader now sees. */
  async setState(id: string, state: WorkLinkState, reason?: WorkLinkReason): Promise<WorkLink | null> {
    try {
      const prev = this.cache().get(id);
      if (!prev) return null;
      const next = parseWorkLink({
        ...prev,
        state,
        reason: stateTakesReason(state) ? reason ?? 'other' : undefined,
        manualClose: state === 'abandoned' ? true : undefined,
        updatedAt: this.now(),
      });
      if (!next) return null;
      await this.commit(next);
      return this.get(id);
    } catch (err) {
      console.warn('[workLinks] setState failed:', err);
      return null;
    }
  }

  /** Record that a decision is about this link's work, then re-derive. */
  async attachDecision(id: string, decisionId: string): Promise<WorkLink | null> {
    try {
      const prev = this.cache().get(id);
      if (!prev || !isWorkLinkId(decisionId)) return null;
      const decisionIds = [...prev.decisionIds.filter((d) => d !== decisionId), decisionId].slice(
        -WORK_LINK_LIMITS.MAX_DECISIONS,
      );
      return await this.commit(this.rederive({ ...prev, decisionIds, updatedAt: this.now() }));
    } catch (err) {
      console.warn('[workLinks] attachDecision failed:', err);
      return null;
    }
  }

  /**
   * Decisions changed (raised, replaced, answered, cleared): store the state
   * of every link that holds one again. One synchronous pass, then one write,
   * so a concurrent update cannot be overwritten by a stale copy. A store
   * nobody has read yet is skipped; its load re-derives everything anyway.
   * Never rejects.
   */
  async reconcileDecisions(): Promise<void> {
    try {
      if (!this.links) return;
      const holders = [...this.links.values()].filter((l) => l.decisionIds.length > 0);
      const pending = this.pendingFor(holders);
      const changed: string[] = [];
      for (const l of holders) {
        const next = this.rederive(l, pending);
        if (next.state === l.state && next.reason === l.reason) continue;
        this.links.set(l.id, { ...next, updatedAt: this.now() });
        changed.push(l.id);
      }
      if (changed.length === 0) return;
      this.emit(changed);
      await this.persist();
    } catch (err) {
      console.warn('[workLinks] reconcileDecisions failed:', err);
    }
  }

  /** Called with the changed link ids after every mutation. */
  onChange(fn: (ids: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolves once every queued write has landed (tests, shutdown). */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private cache(): Map<string, WorkLink> {
    if (this.links) return this.links;
    const links = new Map<string, WorkLink>();
    let raw: { links: unknown[] } | null = null;
    try {
      raw = atomicReadJSONSync(this.filePath, { validate: isFileShape });
    } catch (err) {
      console.warn('[workLinks] load failed, starting empty:', err);
    }
    const byTask = new Map<string, WorkLink>();
    for (const entry of raw?.links ?? []) {
      const link = parseWorkLink(entry);
      if (!link || links.has(link.id)) continue;
      // Two links for one task (a hand-edited file): keep the newer.
      const twin = link.a2aTaskId ? byTask.get(link.a2aTaskId) : undefined;
      if (twin && twin.updatedAt >= link.updatedAt) continue;
      if (twin) links.delete(twin.id);
      links.set(link.id, link);
      if (link.a2aTaskId) byTask.set(link.a2aTaskId, link);
    }
    this.links = links;
    // Decisions may have moved while the file was not being written (a crash
    // between an answer and its write): settle every stored state once.
    const pending = this.pendingFor([...links.values()]);
    let stale = false;
    for (const l of [...links.values()]) {
      const next = this.rederive(l, pending);
      if (next.state === l.state && next.reason === l.reason) continue;
      links.set(l.id, next);
      stale = true;
    }
    if (stale) void this.persist();
    return links;
  }

  private rawByTask(a2aTaskId: string): WorkLink | undefined {
    for (const l of this.cache().values()) if (l.a2aTaskId === a2aTaskId) return l;
    return undefined;
  }

  private taskHeldByOther(a2aTaskId: string, id: string): boolean {
    const holder = this.rawByTask(a2aTaskId);
    return !!holder && holder.id !== id;
  }

  /** Pending decision ids, read only when one of these links holds a decision. */
  private pendingFor(links: WorkLink[]): Set<string> {
    return links.some((l) => l.decisionIds.length > 0) ? this.pendingDecisionIds() : new Set<string>();
  }

  private rederive(link: WorkLink, pending: Set<string> = this.pendingFor([link])): WorkLink {
    const { state, reason } = deriveLinkState(link, link.decisionIds.some((d) => pending.has(d)));
    const next: WorkLink = { ...link, state };
    if (reason) next.reason = reason;
    else delete next.reason;
    if (state !== 'abandoned') delete next.manualClose;
    return next;
  }

  private async commit(link: WorkLink): Promise<WorkLink> {
    const links = this.cache();
    links.set(link.id, link);
    const evicted = this.evict(links, link.id);
    this.emit([link.id, ...evicted]);
    await this.persist();
    return link;
  }

  /** Drop the oldest links past the cap, ended ones first, never `keepId`. */
  private evict(links: Map<string, WorkLink>, keepId: string): string[] {
    if (links.size <= MAX_WORK_LINKS) return [];
    const ended = (l: WorkLink) => l.state === 'done' || l.state === 'abandoned';
    const order = [...links.values()]
      .filter((l) => l.id !== keepId)
      .sort((a, b) => Number(ended(b)) - Number(ended(a)) || a.updatedAt - b.updatedAt);
    const gone = order.slice(0, links.size - MAX_WORK_LINKS).map((l) => l.id);
    for (const id of gone) links.delete(id);
    return gone;
  }

  private persist(): Promise<void> {
    const run = this.writeChain.then(async () => {
      const file: WorkLinkFile = { version: 1, links: [...this.cache().values()] };
      try {
        await atomicWriteJSON(this.filePath, file);
      } catch (err) {
        console.warn('[workLinks] write failed (kept in memory):', err);
      }
    });
    this.writeChain = run;
    return run;
  }

  private emit(ids: string[]): void {
    for (const fn of this.listeners) {
      try {
        fn(ids);
      } catch {
        /* a listener never breaks a write */
      }
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

let shared: WorkLinkStore | null = null;

/** The process-wide store under the wmux data dir, kept in step with decisions. */
export function getWorkLinkStore(): WorkLinkStore {
  if (!shared) {
    const store = new WorkLinkStore();
    onDecisionsChanged(() => void store.reconcileDecisions());
    shared = store;
  }
  return shared;
}
