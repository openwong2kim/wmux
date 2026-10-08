import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { A2A_REMOTE_RECORD_V, isHostId, type A2aExposureV1, type HostId } from '../../shared/a2aRemote';
import { isIsoString, isPlainObject, loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * Layer 2 of cross-host A2A: per paired host, which workspaces/panes it may
 * see (`exposure.json`). The default for every host and every pane is NOT
 * exposed — an absent record, an absent workspace, or a pane missing from an
 * explicit allow-list all answer false.
 *
 * Corrupt file: start empty (nothing exposed) and keep the original as
 * `exposure.json.corrupt-<ts>` for the operator. An UNREADABLE file (or one
 * that could not be moved aside) leaves the store unavailable: nothing is
 * exposed and every mutation throws, so the original is never overwritten.
 *
 * Write failure: `set` rolls memory back and throws. `clear`, `forgetWorkspace`
 * and `forgetPane` only ever NARROW what is visible, so — like a revoke (#658)
 * — they keep their in-memory effect and still throw: un-narrowing on a disk
 * error would re-expose panes the operator just hid.
 */

export const EXPOSURE_FILE = 'exposure.json';

interface ExposureFileV1 {
  v: 1;
  exposures: A2aExposureV1[];
}

export interface ExposureStoreOptions {
  /** Directory holding the store, e.g. `<wmux data dir>/a2a/`. */
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seam; defaults to `atomicWriteJSONSync`. */
  write?: (filePath: string, data: unknown) => void;
  /** Test seam; defaults to the deferred owner-only re-harden. */
  scheduleHarden?: (filePath: string) => void;
}

export class ExposureStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly exposures = new Map<HostId, A2aExposureV1>();
  private writable = true;

  constructor(opts: ExposureStoreOptions) {
    this.filePath = path.join(opts.dir, EXPOSURE_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    this.load();
  }

  get(hostId: HostId): A2aExposureV1 | undefined {
    const rec = this.exposures.get(hostId);
    return rec ? structuredClone(rec) : undefined;
  }

  list(): A2aExposureV1[] {
    return [...this.exposures.values()].map((r) => structuredClone(r));
  }

  /**
   * Replace what `hostId` may see. `paneIds` keys for workspaces not in
   * `workspaceIds` are dropped (they could never match). An empty pane list
   * means "no pane of that workspace", NOT "every pane".
   */
  set(hostId: HostId, input: { workspaceIds: string[]; paneIds?: Record<string, string[]>; brain?: boolean }): A2aExposureV1 {
    this.assertWritable();
    if (!isHostId(hostId)) throw new Error('exposure: invalid hostId');
    const workspaceIds = uniqueStrings(input.workspaceIds);
    if (!workspaceIds) throw new Error('exposure: workspaceIds must be an array of non-empty strings');
    const rec: A2aExposureV1 = {
      v: A2A_REMOTE_RECORD_V,
      hostId,
      workspaceIds,
      updatedAt: new Date(this.now()).toISOString(),
    };
    if (input.paneIds !== undefined) {
      if (!isPlainObject(input.paneIds)) throw new Error('exposure: paneIds must be an object');
      const paneIds: Record<string, string[]> = {};
      for (const [ws, panes] of Object.entries(input.paneIds)) {
        const list = uniqueStrings(panes);
        if (!list) throw new Error('exposure: paneIds values must be arrays of non-empty strings');
        if (workspaceIds.includes(ws)) paneIds[ws] = list;
      }
      rec.paneIds = paneIds;
    }
    if (input.brain !== undefined && typeof input.brain !== 'boolean') throw new Error('exposure: brain must be boolean');
    if (input.brain === true) rec.brain = true;

    const previous = this.exposures.get(hostId);
    this.exposures.set(hostId, rec);
    try {
      this.persist();
    } catch (err) {
      if (previous) this.exposures.set(hostId, previous);
      else this.exposures.delete(hostId);
      throw err;
    }
    return structuredClone(rec);
  }

  /** Expose nothing to `hostId`. Returns false when nothing was exposed. */
  clear(hostId: HostId): boolean {
    this.assertWritable();
    if (!this.exposures.delete(hostId)) return false;
    this.persist();
    return true;
  }

  /**
   * Default false: absent record, absent workspace, or pane not in an explicit
   * list. An ABSENT `paneIds` key exposing every pane of that workspace is the
   * contract's meaning (A2aExposureV1), not a store choice; the UI is meant to
   * always write an explicit list (PR2b).
   */
  isPaneExposed(hostId: HostId, workspaceId: string, paneId: string): boolean {
    const rec = this.exposures.get(hostId);
    if (!rec || !rec.workspaceIds.includes(workspaceId)) return false;
    if (!rec.paneIds || !Object.hasOwn(rec.paneIds, workspaceId)) return true;
    return rec.paneIds[workspaceId].includes(paneId);
  }

  /** Is this host's Moa visible to `hostId`? Default false. */
  isBrainExposed(hostId: HostId): boolean {
    return this.exposures.get(hostId)?.brain === true;
  }

  /** The peer for `hostId` was revoked: drop everything exposed to it. Entry point of the revoke cascade. */
  forgetHost(hostId: HostId): boolean {
    return this.clear(hostId);
  }

  /** Drop a closed workspace from every exposure. */
  forgetWorkspace(workspaceId: string): void {
    this.assertWritable();
    let changed = false;
    for (const rec of this.exposures.values()) {
      if (rec.workspaceIds.includes(workspaceId)) {
        rec.workspaceIds = rec.workspaceIds.filter((w) => w !== workspaceId);
        changed = true;
      }
      if (rec.paneIds && Object.hasOwn(rec.paneIds, workspaceId)) {
        delete rec.paneIds[workspaceId];
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /**
   * Drop a closed pane from every explicit allow-list. A list that becomes
   * empty STAYS (empty = no pane), so forgetting the last listed pane never
   * widens to "every pane of the workspace".
   */
  forgetPane(paneId: string): void {
    this.assertWritable();
    let changed = false;
    for (const rec of this.exposures.values()) {
      if (!rec.paneIds) continue;
      for (const ws of Object.keys(rec.paneIds)) {
        if (rec.paneIds[ws].includes(paneId)) {
          rec.paneIds[ws] = rec.paneIds[ws].filter((p) => p !== paneId);
          changed = true;
        }
      }
    }
    if (changed) this.persist();
  }

  private assertWritable(): void {
    if (!this.writable) throw storeUnavailable(EXPOSURE_FILE);
  }

  private persist(): void {
    const file: ExposureFileV1 = { v: A2A_REMOTE_RECORD_V, exposures: [...this.exposures.values()] };
    this.write(this.filePath, file);
    this.scheduleHarden(this.filePath);
  }

  private load(): void {
    const { value, writable } = loadStore({
      filePath: this.filePath,
      fileName: EXPOSURE_FILE,
      coerce: coerceFile,
      now: this.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'nothing is exposed',
    });
    this.writable = writable;
    for (const rec of value ?? []) this.exposures.set(rec.hostId, rec);
  }
}

function uniqueStrings(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && s.length > 0)) return null;
  return [...new Set(v as string[])];
}

/** Whole-file validation: any bad record rejects the file (no partial trust). */
function coerceFile(raw: unknown): A2aExposureV1[] | null {
  if (!isPlainObject(raw) || raw['v'] !== 1 || !Array.isArray(raw['exposures'])) return null;
  const out: A2aExposureV1[] = [];
  const seen = new Set<string>();
  for (const r of raw['exposures']) {
    if (!isPlainObject(r) || r['v'] !== 1 || !isHostId(r['hostId']) || seen.has(r['hostId'])) return null;
    const workspaceIds = uniqueStrings(r['workspaceIds']);
    if (!workspaceIds || !isIsoString(r['updatedAt'])) return null;
    const rec: A2aExposureV1 = { v: 1, hostId: r['hostId'], workspaceIds, updatedAt: r['updatedAt'] };
    if (r['paneIds'] !== undefined) {
      if (!isPlainObject(r['paneIds'])) return null;
      const paneIds: Record<string, string[]> = {};
      for (const [ws, panes] of Object.entries(r['paneIds'])) {
        const list = uniqueStrings(panes);
        if (!list) return null;
        paneIds[ws] = list;
      }
      rec.paneIds = paneIds;
    }
    if (r['brain'] !== undefined) {
      if (typeof r['brain'] !== 'boolean') return null;
      if (r['brain']) rec.brain = true;
    }
    seen.add(rec.hostId);
    out.push(rec);
  }
  return out;
}
