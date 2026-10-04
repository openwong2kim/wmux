// The WorkLink store: one atomic JSON file (`work-links.json`) in the wmux data
// dir, cached in memory. Main is the only writer, so the cache is the truth and
// the file is its durable copy. Every mutation updates the cache synchronously,
// then queues a write of the whole cache; writes run one at a time, so the last
// one on disk is always the newest cache.
//
// Never throws: a torn file loads as an empty store, a bad record is dropped on
// its own, and a failed write is logged and retried by the next mutation. The
// callers are delivery paths (A2A send, decisions) that must not fail because
// bookkeeping did. See docs/work-links.md.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { loadDeckDecisions } from '../deck/deckDecisionStore';
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
 *  creating one needs `origin` and `owner`. `origin`, `id` and `createdAt`
 *  never change once set. State is derived, never passed here (see setState). */
export type WorkLinkUpsert = Partial<
  Omit<WorkLink, 'state' | 'reason' | 'decisionIds' | 'createdAt' | 'updatedAt'>
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
    return [...this.cache().values()]
      .filter((l) => matchesWorkLinkFilter(l, filter))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): WorkLink | null {
    return this.cache().get(id) ?? null;
  }

  getByTaskId(a2aTaskId: string): WorkLink | null {
    for (const l of this.cache().values()) if (l.a2aTaskId === a2aTaskId) return l;
    return null;
  }

  /** Create or merge a link, then re-derive its state. Null when the input is
   *  invalid (nothing is written). */
  async upsert(input: WorkLinkUpsert): Promise<WorkLink | null> {
    try {
      const prev =
        (input.id ? this.get(input.id) : null) ?? (input.a2aTaskId ? this.getByTaskId(input.a2aTaskId) : null);
      if (!prev && (!input.origin || !input.owner)) return null;
      const now = this.now();
      const merged = parseWorkLink({
        ...(prev ?? { state: 'queued', decisionIds: [], createdAt: now }),
        ...stripUndefined(input),
        id: prev?.id ?? input.id ?? randomUUID(),
        origin: prev?.origin ?? input.origin,
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

  /** Set a state by hand (a person or an owner closing the work out). The next
   *  derivation overrides it, except `abandoned`, which only a merged PR undoes. */
  async setState(id: string, state: WorkLinkState, reason?: WorkLinkReason): Promise<WorkLink | null> {
    try {
      const prev = this.get(id);
      if (!prev) return null;
      const next = parseWorkLink({
        ...prev,
        state,
        reason: stateTakesReason(state) ? reason ?? 'other' : undefined,
        updatedAt: this.now(),
      });
      return next ? await this.commit(next) : null;
    } catch (err) {
      console.warn('[workLinks] setState failed:', err);
      return null;
    }
  }

  /** Record that a decision is about this link's work, then re-derive. */
  async attachDecision(id: string, decisionId: string): Promise<WorkLink | null> {
    try {
      const prev = this.get(id);
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

  /** Re-derive the links holding this decision (after it was answered). */
  async refreshDecision(decisionId: string): Promise<void> {
    try {
      for (const l of [...this.cache().values()]) {
        if (!l.decisionIds.includes(decisionId)) continue;
        const next = this.rederive(l);
        if (next.state !== l.state || next.reason !== l.reason) {
          await this.commit({ ...next, updatedAt: this.now() });
        }
      }
    } catch (err) {
      console.warn('[workLinks] refreshDecision failed:', err);
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
    return links;
  }

  private taskHeldByOther(a2aTaskId: string, id: string): boolean {
    const holder = this.getByTaskId(a2aTaskId);
    return !!holder && holder.id !== id;
  }

  private rederive(link: WorkLink): WorkLink {
    const pending = link.decisionIds.length > 0 ? this.pendingDecisionIds() : new Set<string>();
    const { state, reason } = deriveLinkState(link, link.decisionIds.some((d) => pending.has(d)));
    const next: WorkLink = { ...link, state };
    if (reason) next.reason = reason;
    else delete next.reason;
    return next;
  }

  private async commit(link: WorkLink): Promise<WorkLink> {
    const links = this.cache();
    links.set(link.id, link);
    const evicted = this.evict(links);
    this.emit([link.id, ...evicted]);
    await this.persist();
    return link;
  }

  private evict(links: Map<string, WorkLink>): string[] {
    if (links.size <= MAX_WORK_LINKS) return [];
    const ended = (l: WorkLink) => l.state === 'done' || l.state === 'abandoned';
    const order = [...links.values()].sort(
      (a, b) => Number(ended(b)) - Number(ended(a)) || a.updatedAt - b.updatedAt,
    );
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

/** The process-wide store under the wmux data dir. */
export function getWorkLinkStore(): WorkLinkStore {
  shared ??= new WorkLinkStore();
  return shared;
}
