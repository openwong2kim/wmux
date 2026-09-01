import * as path from 'path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { isUnsafeKey } from '../account/accountStore';
import {
  MAX_FILE_BYTES,
  applyRunOutcome,
  isValidTraceName,
  pruneTraces,
  sanitizeTraceRecord,
  stepsFingerprint,
  type RunOutcome,
  type TraceRecord,
} from '../../shared/browserReplay/actionTrace';

// ---------------------------------------------------------------------------
// Persistence for recorded browser action traces.
//
// The file lives in main, not in the MCP process, for one reason: the MCP
// process is per-connection and dies with the agent's session, so anything it
// owned would evaporate exactly when a trace becomes worth having (the NEXT
// session). Main is the one long-lived, single-writer process, and it is
// already the broker every browser RPC goes through — so the store hangs off
// the same topology instead of inventing a second one.
//
// One file for every workspace, keyed by workspaceId inside, mirroring
// ChromeSurfaceStore: the isolation is enforced by the RPC layer injecting the
// caller's workspaceId (sendScopedBrowserRpc), so a workspace cannot name
// another workspace's key even if it tries.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
/** Coalescing window for stats churn (every replay updates lastUsedAt). */
export const WRITE_DEBOUNCE_MS = 300;
/** Extra attempts after a failed write, doubling from WRITE_RETRY_BASE_MS. */
export const WRITE_RETRIES = 2;
export const WRITE_RETRY_BASE_MS = 200;

interface ActionCacheFile {
  version: number;
  workspaces: Record<string, TraceRecord[]>;
}

export function getActionCachePath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'browser-action-cache.json');
}

function emptyFile(): ActionCacheFile {
  return { version: SCHEMA_VERSION, workspaces: {} };
}

/**
 * Drop anything malformed; fail open.
 *
 * A torn cache must never brick browser automation — the whole feature is an
 * optimization, so the worst acceptable outcome of a bad file is that the agent
 * has no traces and does the work the slow way.
 */
function sanitizeFile(raw: unknown, now: number = Date.now()): ActionCacheFile {
  const file = emptyFile();
  if (!raw || typeof raw !== 'object') return file;
  const r = raw as Record<string, unknown>;
  if (!r.workspaces || typeof r.workspaces !== 'object') return file;
  for (const [workspaceId, list] of Object.entries(r.workspaces as Record<string, unknown>)) {
    if (isUnsafeKey(workspaceId)) continue; // prototype-pollution guard
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    const records: TraceRecord[] = [];
    for (const entry of list) {
      const record = sanitizeTraceRecord(entry, now);
      if (!record || seen.has(record.name)) continue;
      seen.add(record.name);
      records.push(record);
    }
    const kept = pruneTraces(records, now);
    if (kept.length > 0) file.workspaces[workspaceId] = kept;
  }
  return file;
}

/**
 * How the whole-file ceiling is enforced.
 *
 * Over MAX_FILE_BYTES the workspaces whose newest trace is oldest are dropped
 * WHOLE rather than trimmed one record at a time: a workspace holding half a
 * flow is worse than a workspace holding none, because a half flow still looks
 * runnable.
 */
function enforceFileBudget(file: ActionCacheFile): void {
  if (Buffer.byteLength(JSON.stringify(file), 'utf8') <= MAX_FILE_BYTES) return;
  const byRecency = Object.entries(file.workspaces).sort(
    (a, b) =>
      Math.max(...b[1].map((t) => t.lastUsedAt), 0) - Math.max(...a[1].map((t) => t.lastUsedAt), 0),
  );
  for (let i = byRecency.length - 1; i >= 0; i--) {
    if (Buffer.byteLength(JSON.stringify(file), 'utf8') <= MAX_FILE_BYTES) return;
    delete file.workspaces[byRecency[i][0]];
  }
}

export interface PutTraceResult {
  ok: boolean;
  reason?: string;
  trace?: TraceRecord;
}

/**
 * Read/modify/write store for browser action traces.
 *
 * Modeled on ChromeSurfaceStore: sync cache-backed reads, mutations serialized
 * through a write chain so overlapping read-modify-writes never race, fail-open
 * sanitize on load. Unlike that store, mutations here are per-RECORD rather
 * than whole-snapshot publishes — there is no in-memory authority to publish
 * from, since the recorder lives in another process.
 */
export class ActionCacheStore {
  private readonly filePath: string;
  private cache: ActionCacheFile | null = null;
  private writeChain: Promise<unknown> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set when a debounced write is owed for the current in-memory cache. */
  private dirty = false;
  /**
   * Bumped by every mutation. A write captures it before serialising and only
   * clears `dirty` if it still matches afterwards — a mutation that landed
   * while the write was in flight is NOT on disk, and clearing the flag for it
   * would send the next mutation back to stale bytes and silently drop it.
   */
  private revision = 0;
  /** A write is queued on the chain. Keeps the debounce from stacking more
   *  writes behind one that is already retrying. */
  private writePending = false;

  constructor(dir?: string) {
    this.filePath = getActionCachePath(dir);
  }

  load(): ActionCacheFile {
    let raw: unknown = null;
    try {
      raw = atomicReadJSONSync<unknown>(this.filePath);
    } catch {
      raw = null;
    }
    this.cache = sanitizeFile(raw);
    return this.cache;
  }

  private ensureCache(): ActionCacheFile {
    return this.cache ?? this.load();
  }

  /** Every trace for a workspace, most recently used first. */
  list(workspaceId: string): TraceRecord[] {
    if (isUnsafeKey(workspaceId) || !workspaceId) return [];
    const records = this.ensureCache().workspaces[workspaceId] ?? [];
    return [...records]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map((r) => ({ ...r, steps: r.steps.map((s) => ({ ...s })) }));
  }

  get(workspaceId: string, name: string): TraceRecord | null {
    if (!isValidTraceName(name)) return null;
    return this.list(workspaceId).find((t) => t.name === name) ?? null;
  }

  /**
   * Store a trace, replacing any same-named one in the workspace.
   *
   * A re-save under an existing name is one of two different things, and they
   * are told apart by the STEPS, not by the name:
   *
   *   same steps — the agent recorded the same flow again. Keep the id and the
   *     success history and bump observedCount, because losing the history on
   *     every re-save would put the serving threshold out of reach for any
   *     flow the agent repeats.
   *
   *   different steps — the name was reused for a different flow (or the flow
   *     was healed after a failure). Start the history over: the old steps'
   *     successes say nothing about these ones, and inheriting them would let
   *     a brand-new flow be volunteered as proven on its first save.
   *
   * The name still identifies the record either way — it is how the agent
   * refers to it — so the id is kept in both cases.
   */
  async put(workspaceId: string, raw: unknown): Promise<PutTraceResult> {
    if (isUnsafeKey(workspaceId) || !workspaceId) {
      return { ok: false, reason: 'workspace identity is unusable' };
    }
    const now = Date.now();
    const incoming = sanitizeTraceRecord(raw, now);
    if (!incoming) {
      return { ok: false, reason: 'the trace has no usable steps or an unusable name' };
    }
    let stored: TraceRecord | undefined;
    await this.mutate((file) => {
      const list = file.workspaces[workspaceId] ?? [];
      const previous = list.find((t) => t.name === incoming.name);
      const sameFlow =
        previous !== undefined &&
        stepsFingerprint(previous.steps) === stepsFingerprint(incoming.steps);
      stored = previous
        ? {
            ...incoming,
            id: previous.id,
            createdAt: previous.createdAt,
            observedCount: sameFlow ? previous.observedCount + 1 : 1,
            successCount: sameFlow ? previous.successCount : 0,
            failCount: sameFlow ? previous.failCount : 0,
            lastUsedAt: now,
            // Either way the quarantine goes: on the same flow because a
            // re-record is the agent asserting this is still the path, and on
            // a different flow because it was never these steps' quarantine.
            consecutiveFailsAtStep: 0,
          }
        : { ...incoming, observedCount: 1, createdAt: now, lastUsedAt: now };
      file.workspaces[workspaceId] = pruneTraces(
        [stored, ...list.filter((t) => t.name !== incoming.name)],
        now,
      );
    });
    // Under the cap the put always survives; over it, pruneTraces keeps the
    // most recently used, and `stored` was just touched — so it cannot be the
    // record that lost. Re-read anyway rather than assert it.
    const kept = this.get(workspaceId, incoming.name);
    return kept ? { ok: true, trace: kept } : { ok: false, reason: 'the trace did not survive the workspace cap' };
  }

  /** Fold a replay's result into a trace's counters. */
  async stats(workspaceId: string, name: string, outcome: RunOutcome): Promise<TraceRecord | null> {
    if (isUnsafeKey(workspaceId) || !isValidTraceName(name)) return null;
    await this.mutate((file) => {
      const list = file.workspaces[workspaceId];
      if (!list) return;
      const index = list.findIndex((t) => t.name === name);
      if (index === -1) return;
      list[index] = applyRunOutcome(list[index], outcome);
    });
    return this.get(workspaceId, name);
  }

  /** Forget one trace, or the workspace's whole cache when name is omitted. */
  async forget(workspaceId: string, name?: string): Promise<number> {
    if (isUnsafeKey(workspaceId) || !workspaceId) return 0;
    let removed = 0;
    await this.mutate((file) => {
      const list = file.workspaces[workspaceId] ?? [];
      if (name === undefined) {
        removed = list.length;
        delete file.workspaces[workspaceId];
        return;
      }
      const kept = list.filter((t) => t.name !== name);
      removed = list.length - kept.length;
      if (kept.length === 0) delete file.workspaces[workspaceId];
      else file.workspaces[workspaceId] = kept;
    });
    return removed;
  }

  /** Flush a pending debounced write synchronously (app teardown). */
  flushSync(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.dirty || !this.cache) return;
    try {
      atomicWriteJSONSync(this.filePath, this.cache, { durable: true });
      this.dirty = false;
    } catch (err) {
      console.warn('[ActionCacheStore] flushSync failed:', err);
    }
  }

  /** Test/teardown seam: settle every queued write. */
  async drain(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.queueWrite();
    await this.writeChain;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Apply one mutation to the on-disk file, serialized behind every earlier
   * one. The file is re-read inside the chain rather than mutated from the
   * published cache, so a failed write leaves the cache exactly as last
   * committed (accountStore idiom).
   */
  private mutate(apply: (file: ActionCacheFile) => void): Promise<void> {
    const run = this.writeChain.then(async () => {
      // A mutation whose predecessor's write is still sitting in the debounce
      // window must build on THAT result, not on the older bytes still on
      // disk — re-reading unconditionally would silently undo every mutation
      // the timer has not flushed yet.
      let file: ActionCacheFile;
      if (this.dirty && this.cache) {
        file = this.cache;
      } else {
        let raw: unknown = null;
        try {
          raw = atomicReadJSONSync<unknown>(this.filePath);
        } catch {
          raw = null;
        }
        file = sanitizeFile(raw);
      }
      apply(file);
      enforceFileBudget(file);
      this.cache = file;
      this.dirty = true;
      this.revision++;
      this.scheduleWrite();
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private scheduleWrite(): void {
    if (this.debounceTimer !== null || this.writePending) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.queueWrite();
    }, WRITE_DEBOUNCE_MS);
    (this.debounceTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Put the write ON the mutation chain rather than beside it.
   *
   * A write that ran independently could still be in flight when the next
   * mutation started, and that mutation would see `dirty` already cleared and
   * re-read the pre-write bytes from disk — losing every change the in-flight
   * write was carrying. Sharing the chain makes the ordering explicit.
   */
  private queueWrite(): void {
    if (this.writePending) return;
    this.writePending = true;
    const run = this.writeChain.then(async () => {
      try {
        await this.writeOnce();
      } finally {
        this.writePending = false;
      }
    });
    this.writeChain = run.catch(() => undefined);
  }

  /**
   * Serialise the cache to disk, retrying with a doubling backoff.
   *
   * On final failure the store stays dirty on purpose: the next mutation
   * writes it, and until then the in-memory cache is the truth this process
   * serves. Losing a write costs the agent a flow on the next launch — never a
   * page action, and never this session.
   */
  private async writeOnce(): Promise<void> {
    if (!this.dirty || !this.cache) return;
    const revision = this.revision;
    const snapshot = JSON.parse(JSON.stringify(this.cache)) as ActionCacheFile;
    for (let attempt = 0; ; attempt++) {
      try {
        await atomicWriteJSON(this.filePath, snapshot, { durable: true });
        // Only if nothing changed while we were writing: a later mutation is
        // not in `snapshot`, so the store still owes the disk a write.
        if (this.revision === revision) this.dirty = false;
        return;
      } catch (err) {
        if (attempt >= WRITE_RETRIES) {
          console.warn(
            `[ActionCacheStore] write to ${this.filePath} failed after ` +
              `${WRITE_RETRIES + 1} attempts; recorded flows are held in memory only:`,
            err,
          );
          return;
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, WRITE_RETRY_BASE_MS * 2 ** attempt);
          (timer as { unref?: () => void }).unref?.();
        });
      }
    }
  }
}

/**
 * The process-wide store.
 *
 * A singleton because main is by design the ONE writer: two instances over the
 * same file would each hold their own cache and each believe it was current,
 * and the later write would silently discard the other's flows. The RPC
 * handlers and the shutdown flush have to be looking at the same object for
 * the flush to mean anything.
 *
 * Tests construct the class directly against a temp directory instead.
 */
let sharedStore: ActionCacheStore | null = null;

export function getActionCacheStore(): ActionCacheStore {
  if (!sharedStore) sharedStore = new ActionCacheStore();
  return sharedStore;
}
