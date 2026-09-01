import * as fs from 'fs';
import * as path from 'path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { isUnsafeKey } from '../account/accountStore';
import {
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
    if (!workspaceId || isUnsafeKey(workspaceId)) return [];
    const dir = path.join(this.liveDir, workspaceId);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      // ENOENT is the ordinary case: this workspace has promoted nothing.
      return [];
    }
    const records: PromotedRecord[] = [];
    for (const entry of names) {
      if (!entry.endsWith('.json')) continue;
      const record = this.readFile(path.join(dir, entry));
      // A record whose stored workspaceId disagrees with the directory it was
      // found in is not this workspace's to serve — it was moved or copied.
      if (record && record.workspaceId === workspaceId) records.push(record);
    }
    return records.sort((a, b) => b.lastRunAt - a.lastRunAt);
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
      ? { ...record, promotedAt: existing.promotedAt, lastRunAt: existing.lastRunAt, runCount: existing.runCount }
      : record;
    const written = await this.write(file, merged);
    return written
      ? { ok: true, record: merged }
      : { ok: false, reason: 'the flow could not be written to disk' };
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
    const existing = this.readFile(file);
    if (!existing || existing.workspaceId !== workspaceId) return false;
    return this.run(() => {
      try {
        fs.rmSync(file, { force: true });
        return true;
      } catch (err) {
        console.warn(`[PromotedSkillStore] could not remove ${file}:`, err);
        return false;
      }
    });
  }

  /** Fold one run into a flow's usage counters. Best-effort by design. */
  async touch(workspaceId: string, slug: string, next: PromotedRecord): Promise<void> {
    const file = this.fileFor(workspaceId, slug, this.liveDir);
    if (!file) return;
    // Only touch a record that is actually there: a run of a flow that was
    // demoted mid-session must not recreate its file.
    if (!this.readFile(file)) return;
    await this.write(file, next);
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
    let workspaces: string[];
    try {
      workspaces = fs.readdirSync(this.liveDir);
    } catch {
      return result;
    }
    for (const workspaceId of workspaces) {
      if (isUnsafeKey(workspaceId)) continue;
      const records = this.list(workspaceId);
      // Orphans: a file in the tree that no longer parses as a record at all.
      // Nothing can ever serve one, so leaving it costs a slug forever.
      await this.removeUnparseable(workspaceId);
      const decision = sweepPromoted(records, now);
      for (const record of decision.archive) {
        if (await this.archiveOne(record)) result.archived++;
      }
      for (const record of decision.remove) {
        console.log(
          `[PromotedSkillStore] deleting promoted flow "${record.name}" ` +
            `(workspace ${record.workspaceId}, unused since ${new Date(record.lastRunAt).toISOString()})`,
        );
        if (await this.remove(record.workspaceId, record.slug)) result.removed++;
      }
    }
    return result;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private readFile(file: string): PromotedRecord | null {
    try {
      return sanitizePromotedRecord(atomicReadJSONSync<unknown>(file));
    } catch {
      return null;
    }
  }

  private async write(file: string, record: PromotedRecord): Promise<boolean> {
    return this.run(async () => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await atomicWriteJSON(file, record, { durable: true });
        return true;
      } catch (err) {
        console.warn(`[PromotedSkillStore] could not write ${file}:`, err);
        return false;
      }
    });
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
        return true;
      } catch (err) {
        console.warn(`[PromotedSkillStore] could not archive ${from}:`, err);
        return false;
      }
    });
  }

  /** Drop files that no longer parse as records — they can never be served. */
  private async removeUnparseable(workspaceId: string): Promise<void> {
    const dir = path.join(this.liveDir, workspaceId);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of names) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(dir, entry);
      if (this.readFile(file)) continue;
      console.log(`[PromotedSkillStore] dropping unreadable promoted flow file ${file}`);
      await this.run(() => {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* best-effort */
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
