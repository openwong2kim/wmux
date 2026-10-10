import * as fs from 'fs';
import * as path from 'path';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSON, BACKUP_SUFFIXES } from '../../daemon/util/atomicWrite';
import { isUnsafeKey } from '../account/accountStore';
import { isMemoryKey } from '../../shared/browserMemoryNamespace';
import {
  SITE_MEMORY_MAX_FILE_BYTES,
  bumpProvenFlowCount,
  decaySiteMemory,
  emptySiteMemoryRecord,
  isSiteMemoryEmpty,
  isSiteMemoryExpired,
  mergeFailure,
  mergeNote,
  sanitizeSiteMemoryRecord,
  toDomainSlug,
  type FailureEntry,
  type NoteEntry,
  type SiteMemoryRecord,
} from '../../shared/browserMemory/siteMemory';

// ---------------------------------------------------------------------------
// Persistence for per-site procedural memory.
//
// One file per domain, under `<wmuxDir>/site-memory/<workspaceId>/<slug>.json`
// — the same shape and the same reasoning as PromotedSkillStore: a torn write
// costs one domain's memory rather than every domain's, and a forget is an
// unlink rather than a rewrite of a shared document.
//
// getWmuxDir() folds in WMUX_DATA_SUFFIX, so an isolated instance gets its own
// tree for free and can neither read nor sweep the real one's memory.
//
// Every method is never-throw. This store is an optimization: the worst
// acceptable outcome of a broken tree is that the agent rediscovers a failure
// it had already paid for once. An exception here would cost it the navigation
// or the replay it was actually doing.
//
// There is NO archive ladder, unlike promoted flows. A promoted flow is
// something a person chose to keep, so it gets a stop in the archive before it
// disappears; a failure record is machine-written and re-acquired the moment
// the failure happens again, so expiry deletes outright.
// ---------------------------------------------------------------------------

export function getSiteMemoryDir(dir: string = getWmuxDir()): string {
  return path.join(dir, 'site-memory');
}

export interface SiteMemoryForgetResult {
  removed: number;
}

export class SiteMemoryStore {
  private readonly baseDir: string;
  /** Serialises writes so an overlapping record and sweep cannot interleave. */
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * Entries refused by the secret filter this process lifetime.
   *
   * Counted rather than merely dropped: a false positive — a hash inside an
   * error message — makes failure knowledge evaporate silently, and without a
   * number nobody would ever have a reason to look.
   */
  private refusedCount = 0;

  constructor(dir?: string) {
    this.baseDir = getSiteMemoryDir(dir);
  }

  /**
   * Resolve one domain's file path, or null if the identity is unusable.
   *
   * Both segments are validated rather than merely joined: workspaceId is the
   * RPC layer's verified scope but is still a directory name, and the domain
   * reaches us from a page. Refused here, once, so no caller has to remember.
   */
  private fileFor(workspaceId: string, slug: string): string | null {
    if (!workspaceId || isUnsafeKey(workspaceId) || !isMemoryKey(workspaceId)) {
      return null;
    }
    if (toDomainSlug(slug) !== slug) return null;
    const file = path.join(this.baseDir, workspaceId, `${slug}.json`);
    // Defence in depth: even with both segments validated, assert the result
    // is inside the tree, so a future change to either rule cannot silently
    // open a traversal.
    const root = path.resolve(this.baseDir, workspaceId);
    if (!path.resolve(file).startsWith(root + path.sep)) return null;
    return file;
  }

  /** How many entries the secret filter has refused this process lifetime. */
  refusedEntries(): number {
    return this.refusedCount;
  }

  /** Note a refusal. Called by the RPC layer, which knows the pattern kind. */
  noteRefusal(kind: string): void {
    this.refusedCount++;
    // The KIND only — never the text. Logging the refused string would defeat
    // the refusal it is reporting.
    console.log(
      `[SiteMemoryStore] refused an entry matching the ${kind} pattern ` +
        `(${this.refusedCount} refused this session)`,
    );
  }

  /** One domain's memory for one workspace, decayed. Never throws. */
  get(workspaceId: string, domain: string, now: number = Date.now()): SiteMemoryRecord | null {
    const slug = toDomainSlug(domain);
    if (!slug) return null;
    const file = this.fileFor(workspaceId, slug);
    if (!file) return null;
    const record = this.readFile(file);
    // A record whose stored workspaceId disagrees with the directory it was
    // found in is not this workspace's to serve — it was moved or copied.
    if (!record || record.workspaceId !== workspaceId) return null;
    if (isSiteMemoryExpired(record, now)) return null;
    const decayed = decaySiteMemory(record, now);
    return isSiteMemoryEmpty(decayed) ? null : decayed;
  }

  /** Every domain this workspace has memory for. Never throws. */
  list(workspaceId: string, now: number = Date.now()): SiteMemoryRecord[] {
    if (!workspaceId || isUnsafeKey(workspaceId)) return [];
    const dir = path.join(this.baseDir, workspaceId);
    const records: SiteMemoryRecord[] = [];
    for (const entry of this.jsonEntriesIn(dir)) {
      const record = this.readFile(path.join(dir, entry));
      if (!record || record.workspaceId !== workspaceId) continue;
      if (isSiteMemoryExpired(record, now)) continue;
      const decayed = decaySiteMemory(record, now);
      if (!isSiteMemoryEmpty(decayed)) records.push(decayed);
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Fold one failure into a domain's memory. */
  async recordFailure(
    workspaceId: string,
    domain: string,
    entry: FailureEntry,
    now: number = Date.now(),
  ): Promise<boolean> {
    return this.mutate(workspaceId, domain, now, (record) => mergeFailure(record, entry, now));
  }

  /** Fold one agent-authored note into a domain's memory. */
  async recordNote(
    workspaceId: string,
    domain: string,
    entry: NoteEntry,
    now: number = Date.now(),
  ): Promise<boolean> {
    return this.mutate(workspaceId, domain, now, (record) => mergeNote(record, entry, now));
  }

  /**
   * Fold one successful replay into a domain's counter.
   *
   * NOT allowed to create a file. A domain nothing has ever gone wrong on does
   * not need a record just to say so, and creating one would put a file on
   * disk for every site the agent has ever successfully used.
   */
  async recordSuccess(
    workspaceId: string,
    domain: string,
    now: number = Date.now(),
  ): Promise<boolean> {
    return this.mutate(
      workspaceId,
      domain,
      now,
      (record) => bumpProvenFlowCount(record, now),
      { createIfMissing: false },
    );
  }

  /**
   * Delete one entry, or the whole domain record when no entryId is given.
   *
   * There is no global wipe. Without an editing UI a wipe could only ever be
   * issued blind, and the only thing it reliably buys is the chance to destroy
   * every domain's memory with one mistyped call.
   */
  async forget(
    workspaceId: string,
    domain: string,
    entryId?: string,
  ): Promise<SiteMemoryForgetResult> {
    const slug = toDomainSlug(domain);
    if (!slug) return { removed: 0 };
    const file = this.fileFor(workspaceId, slug);
    if (!file) return { removed: 0 };
    return this.run(async () => {
      const current = this.readFile(file);
      if (!current || current.workspaceId !== workspaceId) return { removed: 0 };
      if (!entryId) {
        return { removed: this.unlinkWithSidecars(file) ? 1 : 0 };
      }
      const failures = current.failures.filter((e) => e.id !== entryId);
      const notes = current.notes.filter((e) => e.id !== entryId);
      const removed =
        current.failures.length - failures.length + (current.notes.length - notes.length);
      if (removed === 0) return { removed: 0 };
      const next: SiteMemoryRecord = { ...current, failures, notes };
      // A record with nothing left in it is a file, not a memory.
      if (isSiteMemoryEmpty(next)) {
        this.unlinkWithSidecars(file);
        return { removed };
      }
      await this.writeNow(file, next);
      return { removed };
    });
  }

  /**
   * Walk every workspace and delete records past the delete window.
   *
   * Registered on a timer in main/index.ts next to the promoted-flow sweep.
   * Without that registration the 180-day rung is unreachable: the per-read
   * decay drops stale ENTRIES in memory but never removes the FILE, so an
   * abandoned domain's record would sit on disk forever.
   */
  async sweep(now: number = Date.now()): Promise<{ removed: number }> {
    let removed = 0;
    for (const workspaceId of this.workspacesIn()) {
      const dir = path.join(this.baseDir, workspaceId);
      for (const entry of this.jsonEntriesIn(dir)) {
        const file = path.join(dir, entry);
        const record = this.readFile(file);
        // Unreadable files are left alone rather than deleted: this build
        // cannot tell a torn write from one a NEWER wmux wrote, and deleting
        // on that ambiguity means one launch of an old build destroys memory
        // the new one reads perfectly well.
        if (!record) continue;
        if (!isSiteMemoryExpired(record, now) && !isSiteMemoryEmpty(decaySiteMemory(record, now))) {
          continue;
        }
        console.log(
          `[SiteMemoryStore] deleting ${record.domain} (workspace ${record.workspaceId}, ` +
            `last written ${new Date(record.updatedAt).toISOString()})`,
        );
        const done = await this.run(() => this.unlinkWithSidecars(file));
        if (done) removed++;
      }
    }
    return { removed };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Read-modify-write one domain record on a single chain step.
   *
   * One step, not three: split across the chain a sweep could delete the file
   * between the read and the write, and the write would then resurrect a
   * record that had just been swept.
   */
  private async mutate(
    workspaceId: string,
    domain: string,
    now: number,
    apply: (record: SiteMemoryRecord) => SiteMemoryRecord,
    opts: { createIfMissing?: boolean } = {},
  ): Promise<boolean> {
    const createIfMissing = opts.createIfMissing !== false;
    const slug = toDomainSlug(domain);
    if (!slug) return false;
    const file = this.fileFor(workspaceId, slug);
    if (!file) return false;
    return this.run(async () => {
      const current = this.readFile(file);
      if (current && current.workspaceId !== workspaceId) return false;
      if (!current && !createIfMissing) return false;
      const base = current
        ? decaySiteMemory(current, now)
        : emptySiteMemoryRecord(workspaceId, slug, slug, now);
      const next = apply(base);
      const encoded = JSON.stringify(next);
      // The file cap is enforced on the ENCODED record, because that is what
      // the cap is about. Refusing the write keeps the record that is already
      // on disk, which is the better of the two outcomes: the new entry is
      // re-acquired next time the failure happens.
      if (Buffer.byteLength(encoded, 'utf8') > SITE_MEMORY_MAX_FILE_BYTES) {
        console.warn(`[SiteMemoryStore] refusing an oversized record for ${next.domain}`);
        return false;
      }
      return this.writeNow(file, next);
    });
  }

  private workspacesIn(): string[] {
    try {
      return fs.readdirSync(this.baseDir).filter((name) => !isUnsafeKey(name));
    } catch {
      return [];
    }
  }

  private jsonEntriesIn(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter((entry) => entry.endsWith('.json'));
    } catch {
      // ENOENT is the ordinary case: this workspace has recorded nothing.
      return [];
    }
  }

  /**
   * Read one record file, or null.
   *
   * Plain read + parse rather than atomicReadJSONSync, for the reason spelled
   * out in PromotedSkillStore: the `.bak` fallback would RESURRECT a record
   * that was forgotten a moment ago, and the forget would look as if it had
   * silently failed. Here too the primary file is the only truth.
   */
  private readFile(file: string): SiteMemoryRecord | null {
    try {
      return sanitizeSiteMemoryRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return null;
    }
  }

  /**
   * Every backup atomicWriteJSON may have left beside a record.
   *
   * `unlinkWithSidecars` is a PRIVATE method of PromotedSkillStore, not a
   * shared helper, so the same logic is written here against the same
   * BACKUP_SUFFIXES rather than imported. A forget that left the failure text
   * sitting in a sidecar would not be a forget.
   */
  private sidecarsFor(file: string): string[] {
    return BACKUP_SUFFIXES.map((suffix) => `${file}${suffix}`);
  }

  private unlinkWithSidecars(file: string): boolean {
    let ok = true;
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      console.warn(`[SiteMemoryStore] could not remove ${file}:`, err);
      ok = false;
    }
    for (const sidecar of this.sidecarsFor(file)) {
      try {
        fs.rmSync(sidecar, { force: true });
      } catch {
        /* a leftover backup is not worth failing the removal over */
      }
    }
    return ok;
  }

  /** Deliberately NOT chained: every caller is already inside a run() step. */
  private async writeNow(file: string, record: SiteMemoryRecord): Promise<boolean> {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await atomicWriteJSON(file, record, { durable: true });
      return true;
    } catch (err) {
      console.warn(`[SiteMemoryStore] could not write ${file}:`, err);
      return false;
    }
  }

  /** Serialise one filesystem mutation behind every earlier one. */
  private run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Test/teardown seam: settle every queued mutation. */
  async drain(): Promise<void> {
    await this.chain;
  }
}

/**
 * The process-wide store.
 *
 * Same reasoning as the other browser stores: main is the one writer, and the
 * RPC handlers and the sweep timer have to be looking at the same
 * serialisation chain for it to mean anything.
 */
let sharedStore: SiteMemoryStore | null = null;

export function getSiteMemoryStore(): SiteMemoryStore {
  if (!sharedStore) sharedStore = new SiteMemoryStore();
  return sharedStore;
}
