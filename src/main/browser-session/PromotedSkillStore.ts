import * as fs from 'fs';
import * as path from 'path';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSON, BACKUP_SUFFIXES } from '../../daemon/util/atomicWrite';
import { isUnsafeKey } from '../account/accountStore';
import {
  PROMOTED_DELETE_MS,
  PROMOTED_SCHEMA_VERSION,
  peekPromotedVersion,
  sanitizePromotedRecord,
  sweepPromoted,
  toPromotedSlug,
  type PromotedRecord,
} from '../../shared/browserReplay/promotedSkill';

// ---------------------------------------------------------------------------
// Persistence for promoted browser flows.
//
// One file per flow, under `<wmuxDir>/promoted-skills/<workspaceId>/<slug>.json`,
// rather than one file holding them all like ActionCacheStore does. The two
// stores look similar and are shaped differently on purpose:
//
//   The action cache is high-churn — every replay updates a counter — so it
//   pays for a debounced single-file write and an in-memory authority.
//
//   Promoted flows are the opposite: written once when an agent promotes,
//   deleted once when it demotes, and otherwise touched only by a run counter.
//   A file each means a torn write can cost at most ONE flow instead of all of
//   them, and it means the sweep can move a file to the archive by renaming it
//   rather than by rewriting a shared document.
//
// getWmuxDir() already folds in WMUX_DATA_SUFFIX, so an isolated instance gets
// its own tree for free and cannot see or sweep the real one's flows.
//
// Every method is never-throw. Promotion is an optimization layered on an
// optimization: the worst acceptable outcome of a broken tree is that the
// agent has no promoted flows and replays them by name the ordinary way.
// ---------------------------------------------------------------------------

/** Archived flows live OUTSIDE the live tree, so a sweep can never serve one. */
export function getPromotedSkillsDir(dir: string = getWmuxDir()): string {
  return path.join(dir, 'promoted-skills');
}

export function getPromotedArchiveDir(dir: string = getWmuxDir()): string {
  return path.join(dir, 'promoted-archive');
}

export interface PromoteResult {
  ok: boolean;
  reason?: string;
  record?: PromotedRecord;
}

export interface SweepResult {
  archived: number;
  removed: number;
}

export class PromotedSkillStore {
  private readonly liveDir: string;
  private readonly archiveDir: string;
  /** Serialises writes so an overlapping promote and sweep cannot interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dir?: string) {
    this.liveDir = getPromotedSkillsDir(dir);
    this.archiveDir = getPromotedArchiveDir(dir);
  }

  /**
   * Resolve one flow's file path, or null if the identity is unusable.
   *
   * Both segments are validated rather than merely joined: workspaceId is the
   * RPC layer's verified scope but is still a directory name, and the slug is
   * agent-derived. A path that escapes the store is refused here, once, so no
   * caller has to remember to.
   */
  private fileFor(workspaceId: string, slug: string, base: string): string | null {
    if (!workspaceId || isUnsafeKey(workspaceId) || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) {
      return null;
    }
    if (toPromotedSlug(slug) !== slug) return null;
    const file = path.join(base, workspaceId, `${slug}.json`);
    // Defence in depth: even with both segments validated, assert the result
    // is inside the tree. A future change to either rule cannot silently open
    // a traversal.
    const root = path.resolve(base, workspaceId);
    if (!path.resolve(file).startsWith(root + path.sep)) return null;
    return file;
  }

  /** Every live promoted flow for one workspace. Never throws. */
  list(workspaceId: string): PromotedRecord[] {
    return this.listIn(this.liveDir, workspaceId);
  }

  /** Records under one base directory. Shared by the live and archive walks. */
  private listIn(base: string, workspaceId: string): PromotedRecord[] {
    if (!workspaceId || isUnsafeKey(workspaceId)) return [];
    const dir = path.join(base, workspaceId);
    const records: PromotedRecord[] = [];
    for (const entry of this.jsonEntriesIn(dir)) {
      const record = this.readFile(path.join(dir, entry));
      // A record whose stored workspaceId disagrees with the directory it was
      // found in is not this workspace's to serve — it was moved or copied.
      if (record && record.workspaceId === workspaceId) records.push(record);
    }
    return records.sort((a, b) => b.lastRunAt - a.lastRunAt);
  }

  /** Workspace directory names under a base. Missing base is simply empty. */
  private workspacesIn(base: string): string[] {
    try {
      return fs.readdirSync(base).filter((name) => !isUnsafeKey(name));
    } catch {
      return [];
    }
  }

  /** `*.json` entries in one directory. Missing directory is simply empty. */
  private jsonEntriesIn(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter((entry) => entry.endsWith('.json'));
    } catch {
      // ENOENT is the ordinary case: this workspace has promoted nothing.
      return [];
    }
  }

  /** Live promoted flows for one workspace filed under one page. */
  listForUrlKey(workspaceId: string, urlKey: string): PromotedRecord[] {
    if (!urlKey) return [];
    return this.list(workspaceId).filter((r) => r.urlKey === urlKey);
  }

  get(workspaceId: string, slug: string): PromotedRecord | null {
    const file = this.fileFor(workspaceId, slug, this.liveDir);
    if (!file) return null;
    const record = this.readFile(file);
    return record && record.workspaceId === workspaceId ? record : null;
  }

  /** Find a live promoted flow by the trace name the agent knows it by. */
  getByName(workspaceId: string, name: string): PromotedRecord | null {
    return this.list(workspaceId).find((r) => r.name === name) ?? null;
  }

  /**
   * Write one promoted flow.
   *
   * Refuses to overwrite a DIFFERENT flow that already holds the slug. Two
   * trace names can fold to one slug ("Invoice Export" and "invoice-export"),
   * and silently replacing the resident one would delete a proven flow the
   * agent never asked to touch. Same fingerprint is a re-promote of the same
   * steps and is allowed — it refreshes the record and keeps the counters.
   */
  async put(record: PromotedRecord): Promise<PromoteResult> {
    const file = this.fileFor(record.workspaceId, record.slug, this.liveDir);
    if (!file) return { ok: false, reason: 'the flow name or workspace identity is unusable' };
    // The existence check, the fingerprint comparison, the merge, and the
    // write are ONE step on the chain. Split across the chain, a sweep could
    // archive the resident file between the check and the write — and the
    // merge would then carry counters from a record that is no longer there,
    // resurrecting a flow that had just been swept.
    return this.run(async () => {
      const existing = this.readFile(file);
      if (existing && existing.fingerprint !== record.fingerprint) {
        return {
          ok: false,
          reason:
            `"${existing.name}" is already promoted under the same short name and its steps ` +
            'are different. Demote it first, or save this flow under another name',
        };
      }
      // A re-promote keeps the usage history: the flow did not become new just
      // because it was promoted again, and resetting would restart its idle
      // clock and its run count for no reason the agent would expect.
      const merged: PromotedRecord = existing
        ? {
            ...record,
            promotedAt: existing.promotedAt,
            lastRunAt: existing.lastRunAt,
            runCount: existing.runCount,
          }
        : record;
      const written = await this.writeNow(file, merged);
      return written
        ? { ok: true, record: merged }
        : { ok: false, reason: 'the flow could not be written to disk' };
    });
  }

  /**
   * Delete one promoted flow, but only if this workspace owns it.
   *
   * The ownership check is not ceremony: the slug is agent-supplied, and
   * without it a workspace could name a path that happens to resolve into
   * another workspace's directory through a symlink and delete its flows.
   */
  async remove(workspaceId: string, slug: string): Promise<boolean> {
    const file = this.fileFor(workspaceId, slug, this.liveDir);
    if (!file) return false;
    // Ownership check and delete on one chain step, so a concurrent put
    // cannot land between them and have its brand-new record deleted by a
    // demote that was authorised against the record it replaced.
    return this.run(() => {
      const existing = this.readFile(file);
      if (!existing || existing.workspaceId !== workspaceId) return false;
      return this.unlinkWithSidecars(file);
    });
  }

  /**
   * Fold one run into a flow's usage counters. Best-effort by design.
   *
   * Re-reads inside the chain step and merges ONLY the two counter fields,
   * rather than writing the caller's whole record. The caller resolved that
   * record before the replay ran — seconds to minutes earlier — and writing it
   * back wholesale would silently revert a re-promote that landed in between,
   * restoring the old steps under the new fingerprint. Counters are the only
   * thing a run is entitled to change.
   */
  async touch(workspaceId: string, slug: string, next: PromotedRecord): Promise<void> {
    const file = this.fileFor(workspaceId, slug, this.liveDir);
    if (!file) return;
    await this.run(async () => {
      const current = this.readFile(file);
      // Only touch a record that is actually there: a run of a flow that was
      // demoted mid-session must not recreate its file.
      if (!current || current.workspaceId !== workspaceId) return false;
      return this.writeNow(file, {
        ...current,
        lastRunAt: next.lastRunAt,
        runCount: next.runCount,
      });
    });
  }

  /**
   * Walk every workspace and apply the idle ladder.
   *
   * Archiving is a MOVE, not a delete, and the archive lives outside the live
   * tree so a swept flow can never be listed or hinted again while still being
   * recoverable by hand for the 60 days before deletion.
   */
  async sweep(now: number = Date.now()): Promise<SweepResult> {
    const result: SweepResult = { archived: 0, removed: 0 };

    // The archive is swept FIRST, and this is where deletion actually happens.
    //
    // First, so that a flow archived by the live walk below gets a real stop
    // in the archive rather than passing through it inside one call. The
    // ladder's promise is a rung, not a formality: anything archived now is
    // considered for deletion on the NEXT sweep, never this one.
    //
    // The walk itself is what makes the 90-day rung reachable at all.
    // Without this pass the 90-day rung was unreachable: archiving MOVES the
    // file out of the live tree, so the next sweep's live walk could never see
    // it again and an archived flow would sit there forever.
    for (const workspaceId of this.workspacesIn(this.archiveDir)) {
      for (const record of this.listIn(this.archiveDir, workspaceId)) {
        if (now - record.lastRunAt < PROMOTED_DELETE_MS) continue;
        const file = this.fileFor(record.workspaceId, record.slug, this.archiveDir);
        if (!file) continue;
        console.log(
          `[PromotedSkillStore] deleting archived flow "${record.name}" ` +
            `(workspace ${record.workspaceId}, unused since ` +
            `${new Date(record.lastRunAt).toISOString()})`,
        );
        const done = await this.run(() => this.unlinkWithSidecars(file));
        if (done) result.removed++;
      }
    }

    for (const workspaceId of this.workspacesIn(this.liveDir)) {
      const records = this.list(workspaceId);
      await this.quarantineUnreadable(workspaceId);
      const decision = sweepPromoted(records, now);
      for (const record of decision.archive) {
        if (await this.archiveOne(record)) result.archived++;
      }
      // A live record already past the delete threshold is archived FIRST and
      // deleted on a later sweep, never deleted straight from the live tree.
      // The ladder's whole promise is that nothing disappears without a stop
      // in the archive, and a machine that was off for three months would
      // otherwise skip that rung for every flow it holds.
      for (const record of decision.remove) {
        if (await this.archiveOne(record)) result.archived++;
      }
    }

    return result;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Read one record file, or null.
   *
   * Plain read + parse rather than atomicReadJSONSync, for two reasons that
   * both matter here and not in the action cache.
   *
   * atomicReadJSONSync falls back through BACKUP_SUFFIXES on a failed parse.
   * For a store where the FILE is the record's existence, that fallback is a
   * resurrection: a flow demoted or archived a moment ago would come back from
   * its own `.bak` on the next read, and the delete would appear to have
   * silently failed. Here the primary file is the only truth.
   *
   * And it logs the parse error with a stack. A corrupt record is an expected,
   * handled condition on this path — the sweep quarantines it and says so in
   * one line — so a stack trace per read is noise that buries the line that
   * matters.
   */
  private readFile(file: string): PromotedRecord | null {
    try {
      return sanitizePromotedRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return null;
    }
  }

  /**
   * Every backup atomicWriteJSON may have left beside a record.
   *
   * These have to be dealt with explicitly on every removal path. A backup is
   * a full copy of the record — including the steps, and so including whatever
   * the agent typed — and promotion's documented remedy for a value that
   * should not have been made permanent is to demote. A demote that left the
   * values sitting in a sidecar would not be that remedy. They are also what
   * the read fallback above would resurrect the record from.
   */
  private sidecarsFor(file: string): string[] {
    return BACKUP_SUFFIXES.map((suffix) => `${file}${suffix}`);
  }

  /** Delete a record file and every backup beside it. Best-effort. */
  private unlinkWithSidecars(file: string): boolean {
    let ok = true;
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      console.warn(`[PromotedSkillStore] could not remove ${file}:`, err);
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

  /**
   * Write one record. Deliberately NOT chained itself — every caller is
   * already inside a this.run() step, and re-entering the chain from within it
   * would deadlock on a promise that cannot settle until the caller returns.
   */
  private async writeNow(file: string, record: PromotedRecord): Promise<boolean> {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await atomicWriteJSON(file, record, { durable: true });
      return true;
    } catch (err) {
      console.warn(`[PromotedSkillStore] could not write ${file}:`, err);
      return false;
    }
  }

  private async archiveOne(record: PromotedRecord): Promise<boolean> {
    const from = this.fileFor(record.workspaceId, record.slug, this.liveDir);
    const to = this.fileFor(record.workspaceId, record.slug, this.archiveDir);
    if (!from || !to) return false;
    console.log(
      `[PromotedSkillStore] archiving promoted flow "${record.name}" ` +
        `(workspace ${record.workspaceId}, unused since ${new Date(record.lastRunAt).toISOString()})`,
    );
    return this.run(() => {
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        // The backups stay behind and are deleted, not carried over. Left in
        // the live tree they would be a record the sweep just archived, ready
        // to be read back; copied to the archive they would be stale duplicates
        // of a file that is already there.
        for (const sidecar of this.sidecarsFor(from)) {
          try {
            fs.rmSync(sidecar, { force: true });
          } catch {
            /* best-effort */
          }
        }
        return true;
      } catch (err) {
        console.warn(`[PromotedSkillStore] could not archive ${from}:`, err);
        return false;
      }
    });
  }

  /**
   * Deal with files in the live tree that this build cannot read.
   *
   * Two cases that sanitizePromotedRecord cannot tell apart — it returns null
   * for both — and they must NOT be treated the same:
   *
   *   a FUTURE schema version. The file was written by a newer wmux and is
   *     left strictly alone. Deleting it would mean that launching an older
   *     build once — a downgrade, a rollback, an old copy on a shared home
   *     directory — silently destroyed flows the newer build wrote and could
   *     still read perfectly well. Skipped, with one log line so the state is
   *     not invisible.
   *
   *   anything else (a torn write, a hand-edit that broke the shape, a past
   *     version with no migration). Nothing can ever serve it, so it is moved
   *     to the archive — not deleted. The ladder's promise is that a flow gets
   *     a stop in the archive before it is gone, and a corrupt file is exactly
   *     the case where a human might still want to look at what was in it.
   */
  private async quarantineUnreadable(workspaceId: string): Promise<void> {
    const dir = path.join(this.liveDir, workspaceId);
    for (const entry of this.jsonEntriesIn(dir)) {
      const file = path.join(dir, entry);
      if (this.readFile(file)) continue;
      let raw: unknown = null;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        raw = null;
      }
      const version = peekPromotedVersion(raw);
      if (version !== null && version > PROMOTED_SCHEMA_VERSION) {
        console.log(
          `[PromotedSkillStore] leaving ${file} alone: schema version ${version} is newer ` +
            `than this build understands (${PROMOTED_SCHEMA_VERSION})`,
        );
        continue;
      }
      const to = path.join(this.archiveDir, workspaceId, entry);
      console.log(`[PromotedSkillStore] archiving unreadable promoted flow file ${file}`);
      await this.run(() => {
        try {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.renameSync(file, to);
          for (const sidecar of this.sidecarsFor(file)) {
            try {
              fs.rmSync(sidecar, { force: true });
            } catch {
              /* best-effort */
            }
          }
        } catch (err) {
          console.warn(
            `[PromotedSkillStore] could not archive ${file}: ${(err as Error)?.message ?? err}`,
          );
        }
        return true;
      });
    }
  }

  /**
   * Serialise one filesystem mutation behind every earlier one.
   *
   * A promote and a sweep can arrive together — the sweep runs on a timer, the
   * promote on an agent's call — and without this the sweep could archive a
   * file between the promote's existence check and its write.
   */
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
 * Same reasoning as ActionCacheStore's singleton: main is the one writer, and
 * the RPC handlers, the run counter, and the sweep timer all have to be
 * looking at the same serialisation chain for it to mean anything.
 */
let sharedStore: PromotedSkillStore | null = null;

export function getPromotedSkillStore(): PromotedSkillStore {
  if (!sharedStore) sharedStore = new PromotedSkillStore();
  return sharedStore;
}
