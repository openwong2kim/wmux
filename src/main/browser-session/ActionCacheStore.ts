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
   * A re-save is an OBSERVATION of the same flow, not a new trace: the name is
   * how the agent refers to it, so re-recording keeps the id and the success
   * history and bumps observedCount. Losing the history on every re-save would
   * make the serving threshold unreachable for any flow the agent refines.
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
      stored = previous
        ? {
            ...incoming,
            id: previous.id,
            createdAt: previous.createdAt,
            observedCount: previous.observedCount + 1,
            successCount: previous.successCount,
            failCount: previous.failCount,
            lastUsedAt: now,
            // A re-record is the agent asserting this is the current path, so
            // the quarantine that the OLD steps earned must not outlive them.
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
      this.scheduleWrite();
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private scheduleWrite(): void {
    if (this.debounceTimer !== null) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const snapshot = this.cache;
      if (!snapshot) return;
      this.dirty = false;
      void atomicWriteJSON(this.filePath, snapshot, { durable: true }).catch(() => {
        // Losing a write costs the agent a trace, never a page action.
        this.dirty = true;
      });
    }, WRITE_DEBOUNCE_MS);
    (this.debounceTimer as { unref?: () => void }).unref?.();
  }
}
