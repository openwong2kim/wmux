// The To hand out store: one atomic JSON file (`hand-out.json`) in the wmux
// data dir, cached in memory, kept the way the work link store is: main is the
// only writer, every mutation updates the cache and queues a write of the
// whole cache, and writes run one at a time.
//
// An item's state is never stored: it is derived from the work links whose
// `handOutId` names it (shared/handOut.ts handOutStateOf). The store follows
// the work link store, so a link change that touches an item is pushed on,
// and an item whose work is done leaves the list (on load too).
//
// A pick holds an in-memory reservation for its whole send, so two picks of
// one item never both send. A pick to a pane records its link before it
// sends; a link still waiting for its task when the list is first read
// belongs to a pick the app stopped in the middle of, so it is closed and the
// item is open again.
//
// Never throws: a torn file loads as an empty list, a bad record is dropped on
// its own, and a failed write is logged and retried by the next mutation. A
// file that is there but cannot be read (permissions, a lock) is never written
// over: changes stay in memory, every read tries the file again, and once it
// reads they are merged into what it holds.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import {
  HAND_OUT_LIMITS,
  handOutStateOf,
  parseHandOutItem,
  type HandOutAddRequest,
  type HandOutAddResult,
  type HandOutAddedBy,
  type HandOutEntry,
  type HandOutItem,
} from '../../shared/handOut';
import type { WorkLink, WorkLinkState } from '../../shared/workLink';
import { getWorkLinkStore } from '../workLink/workLinkStore';

interface HandOutFile {
  version: 1;
  items: HandOutItem[];
}

const isFileShape = (v: unknown): v is { items: unknown[] } =>
  !!v && typeof v === 'object' && Array.isArray((v as { items?: unknown }).items);

export function getHandOutPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'hand-out.json');
}

/** The work link reads the store follows. */
export interface HandOutLinks {
  list(): WorkLink[];
  get(id: string): WorkLink | null;
  setState(id: string, state: WorkLinkState): Promise<unknown>;
  onChange(fn: (ids: string[]) => void): () => void;
}

export interface HandOutStoreOptions {
  dir?: string;
  links?: HandOutLinks;
  now?: () => number;
}

export class HandOutStore {
  private items: Map<string, HandOutItem> | null = null;
  /** The file is there but could not be read: nothing is written over it. */
  private unreadable = false;
  private strandedClosed = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly reserved = new Set<string>();
  private readonly filePath: string;
  private readonly links: HandOutLinks;
  private readonly now: () => number;

  constructor(opts: HandOutStoreOptions = {}) {
    this.filePath = getHandOutPath(opts.dir);
    this.links = opts.links ?? getWorkLinkStore();
    this.now = opts.now ?? Date.now;
    this.links.onChange((ids) => this.onLinksChanged(ids));
  }

  /** Every item with its state, newest first. Work that is done is not listed. */
  list(): HandOutEntry[] {
    const links = this.handOutLinks();
    const out: HandOutEntry[] = [];
    for (const item of this.cache().values()) {
      const entry = entryOf(item, links);
      if (entry.state !== 'done') out.push(entry);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** One item with its state, or null. */
  get(id: string): HandOutEntry | null {
    const item = this.cache().get(id);
    return item ? entryOf(item, this.handOutLinks()) : null;
  }

  /** Put an item on the list. Refused when the input is invalid or the list is full. */
  add(req: HandOutAddRequest, addedBy: HandOutAddedBy): HandOutAddResult {
    const items = this.cache();
    const item = parseHandOutItem({ ...req, id: `ho-${randomUUID()}`, addedBy, createdAt: this.now() });
    if (!item) {
      return { ok: false, code: 'invalid', message: 'an item needs a one-line title and an absolute folder; agent is an agent slug such as claude' };
    }
    if (items.size >= HAND_OUT_LIMITS.MAX_ITEMS) {
      return { ok: false, code: 'full', message: `To hand out holds ${HAND_OUT_LIMITS.MAX_ITEMS} items; hand some out or remove some first` };
    }
    items.set(item.id, item);
    this.changed();
    return { ok: true, item };
  }

  /** Take an item off the list. False when there is no such item. */
  remove(id: string): boolean {
    if (!this.cache().delete(id)) return false;
    this.changed();
    return true;
  }

  /** Hold an open item for one pick. False when it is unknown, out, or held by another pick. */
  reserve(id: string): boolean {
    const entry = this.get(id);
    if (!entry || entry.state !== 'open' || this.reserved.has(id)) return false;
    this.reserved.add(id);
    return true;
  }

  release(id: string): void {
    this.reserved.delete(id);
  }

  /** Called after every change to the items or to the work their picks made. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolves once every queued write has landed (tests, shutdown). */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private cache(): Map<string, HandOutItem> {
    if (this.items && !this.unreadable) return this.items;
    // On the first read, readable or not: later, a link waiting for its task
    // is a pick of this process.
    if (!this.strandedClosed) {
      this.strandedClosed = true;
      this.closeStrandedPicks();
    }
    const loaded = this.load();
    if (!loaded) {
      if (!this.unreadable) console.warn('[handOut] hand-out.json is there but cannot be read; changes stay in memory until it can');
      this.unreadable = true;
      this.items ??= new Map();
      return this.items;
    }
    // Items added while the file could not be read join what it holds.
    for (const [id, item] of this.items ?? []) if (!loaded.has(id)) loaded.set(id, item);
    const recovered = this.unreadable;
    this.unreadable = false;
    this.items = loaded;
    // Work may have finished while the app was closed.
    if (this.dropDone() || recovered) void this.persist();
    return loaded;
  }

  /** The items on disk; null when the file is there but cannot be read. A
   *  torn file reads as empty, as a missing one does. */
  private load(): Map<string, HandOutItem> | null {
    let raw: { items: unknown[] } | null = null;
    try {
      raw = atomicReadJSONSync(this.filePath, { validate: isFileShape });
    } catch (err) {
      console.warn('[handOut] load failed:', err);
    }
    if (!raw && cannotRead(this.filePath)) return null;
    const items = new Map<string, HandOutItem>();
    for (const entry of raw?.items ?? []) {
      const item = parseHandOutItem(entry);
      if (item && !items.has(item.id)) items.set(item.id, item);
    }
    return items;
  }

  /** Close the links of picks that never sent. Runs once, on the first read,
   *  before any pick of this process can have recorded a link. */
  private closeStrandedPicks(): void {
    for (const link of this.handOutLinks()) {
      if (link.origin !== 'hand-out' || link.state !== 'queued' || link.a2aTaskId || link.worktree) continue;
      void this.links.setState(link.id, 'abandoned').catch((err: unknown) => {
        console.warn('[handOut] could not close a stranded pick:', err);
      });
    }
  }

  /** The links a pick made: the only ones an item's state reads. */
  private handOutLinks(): WorkLink[] {
    try {
      return this.links.list().filter((l) => !!l.handOutId);
    } catch (err) {
      console.warn('[handOut] work links unreadable:', err);
      return [];
    }
  }

  /** Drop the items whose work is done. Returns whether any went. */
  private dropDone(): boolean {
    const items = this.items;
    if (!items || items.size === 0) return false;
    const links = this.handOutLinks();
    let dropped = false;
    for (const item of [...items.values()]) {
      if (handOutStateOf(item.id, links).state !== 'done') continue;
      items.delete(item.id);
      dropped = true;
    }
    return dropped;
  }

  /** A link changed, or was evicted (it can no longer be read): an item's
   *  state may have moved. A pick's link changing loads a list nobody has
   *  read yet, so its item is dropped while the done link can still be read
   *  (the link store evicts ended links first). */
  private onLinksChanged(ids: string[]): void {
    try {
      if (!this.items) {
        if (ids.some((id) => !!this.links.get(id)?.handOutId)) this.cache();
        return;
      }
      if (this.items.size === 0) return;
      const touches = ids.some((id) => {
        const link = this.links.get(id);
        return !link || (!!link.handOutId && this.items?.has(link.handOutId) === true);
      });
      if (!touches) return;
      if (this.dropDone()) void this.persist();
      this.emit();
    } catch (err) {
      console.warn('[handOut] work link change failed:', err);
    }
  }

  private changed(): void {
    this.emit();
    void this.persist();
  }

  private persist(): Promise<void> {
    const run = this.writeChain.then(async () => {
      const items = this.cache();
      if (this.unreadable) return;
      const file: HandOutFile = { version: 1, items: [...items.values()] };
      try {
        await atomicWriteJSON(this.filePath, file);
      } catch (err) {
        console.warn('[handOut] write failed (kept in memory):', err);
      }
    });
    this.writeChain = run;
    return run;
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* a listener never breaks a write */
      }
    }
  }
}

/** The file exists, but reading it fails (permissions, a lock, a folder). */
function cannotRead(file: string): boolean {
  try {
    readFileSync(file);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

function entryOf(item: HandOutItem, links: readonly WorkLink[]): HandOutEntry {
  const { state, linkId } = handOutStateOf(item.id, links);
  return { ...item, state, ...(linkId ? { linkId } : {}) };
}

let shared: HandOutStore | null = null;

/** The process-wide list under the wmux data dir, following the work link store. */
export function getHandOutStore(): HandOutStore {
  if (!shared) shared = new HandOutStore();
  return shared;
}
