// === wmux MetadataStore (M0-a) ===
//
// Authoritative store for PaneMetadata in the main process. Replaces the
// renderer paneSlice as the metadata source of truth (M0-d removes the
// renderer write path; M0-b re-points the RPC handlers here).
//
// This module is INTENTIONALLY isolated in M0-a — handler wiring, paneSlice
// mirror conversion, and SessionManager persistence integration land in
// later M0 PRs. M0-a ships the store + its unit tests; no call sites change.
//
// Design contract: docs/internal/m0-design.md
// Wire contract:   docs/PROTOCOL.md §1
//
// Concurrency model:
//   - Single-threaded JS = automatic serialization across set() calls
//     (race #5 in the design doc).
//   - The synchronous critical section (validate → check version → merge →
//     bump version → commit → emit) holds across one `set()` invocation,
//     so two concurrent callers observe a monotonic version sequence
//     without locking.
//   - Persistence is handled in M0-e via SessionManager.hydrate/serialize.
//     M0-a exposes the API (`hydrate`, `serialize`, `migrate`) but does
//     not yet wire it into the dump path.

import type { PaneMetadata } from '../../shared/types';
import {
  PANE_METADATA_MAX_BYTES,
  PANE_METADATA_LABEL_MAX,
  PANE_METADATA_ROLE_MAX,
  PANE_METADATA_STATUS_MAX,
  PANE_METADATA_CUSTOM_KEY_MAX,
  PANE_METADATA_CUSTOM_MAX_ENTRIES,
} from '../../shared/types';
import { eventBus as defaultEventBus, EventBus } from '../events/EventBus';
import {
  PaneLabelError,
  normalizePaneLabel,
  paneLabelRejectionMessage,
  paneLabelShapeError,
} from '../../shared/paneLabelRules';

// === Public types ===

export type MergeMode = 'merge' | 'replace' | 'replaceShared';

export interface SetOptions {
  mergeMode?: MergeMode;
  expectedVersion?: number;
  /**
   * Workspace this write is scoped to. Used as the `workspaceId` on the
   * emitted `pane.metadata.changed` event. If omitted, falls back to the
   * workspaceId remembered from a prior set() on this pane. If neither
   * is known, the event is skipped (the store still commits — this only
   * matters for the event surface).
   */
  workspaceId?: string;
  /**
   * Ids of every pane that currently exists (stashed panes included), as the
   * renderer reports them. Label uniqueness is checked only against these, so
   * an entry left behind by a pane that closed without a `pane.closed` (a
   * closed workspace, a crash) never blocks reusing its label. Omitted when
   * the caller could not learn the live set: then every labeled entry counts,
   * which can refuse a stale name but never admits a duplicate.
   */
  livePaneIds?: ReadonlySet<string>;
}

export type SetResult =
  | { ok: true; version: number; metadata: PaneMetadata }
  | { ok: false; error: 'VERSION_CONFLICT'; currentVersion: number };

export interface MetadataEntry {
  metadata: PaneMetadata;
  version: number;
}

export interface SnapshotEntry {
  paneId: string;
  workspaceId: string;
  metadata: PaneMetadata;
  version: number;
}

export interface Snapshot {
  asOfSeq: number;
  bootId: string;
  entries: SnapshotEntry[];
}

export const METADATA_SCHEMA_VERSION = 1 as const;

export interface PersistedShape {
  schema_version: typeof METADATA_SCHEMA_VERSION;
  entries: SnapshotEntry[];
}

// === Internal ===

interface InternalEntry {
  metadata: PaneMetadata;
  version: number;
  /** Remembered for event emission on subsequent set/clear/onPaneDeleted. */
  workspaceId: string;
}

function cloneMetadata(meta: PaneMetadata): PaneMetadata {
  const out: PaneMetadata = {};
  if (meta.label !== undefined) out.label = meta.label;
  if (meta.role !== undefined) out.role = meta.role;
  if (meta.status !== undefined) out.status = meta.status;
  if (meta.custom !== undefined) out.custom = { ...meta.custom };
  if (meta.updatedAt !== undefined) out.updatedAt = meta.updatedAt;
  return out;
}

function isEmptyMetadata(meta: PaneMetadata): boolean {
  return (
    meta.label === undefined &&
    meta.role === undefined &&
    meta.status === undefined &&
    (meta.custom === undefined || Object.keys(meta.custom).length === 0)
  );
}

// === Store ===

export class MetadataStore {
  private readonly bus: EventBus;
  private readonly map = new Map<string, InternalEntry>();
  /**
   * Persist callback wired in M0-e. Called inline from `set()`/`clear()`/
   * `onPaneDeleted()` BEFORE the event is emitted (persist-then-publish —
   * race spec #1). Synchronous to keep the critical section atomic.
   *
   * Optional: when undefined (M0-a/b/c/d test fixtures, or boot order
   * issues), set/clear behave exactly as before. The boot path in
   * `src/main/index.ts` wires this via `setPersist()` after both the
   * MetadataStore singleton and SessionManager exist.
   */
  private persist: ((shape: PersistedShape) => void) | undefined;

  constructor(opts?: {
    eventBus?: EventBus;
    persist?: (shape: PersistedShape) => void;
  }) {
    this.bus = opts?.eventBus ?? defaultEventBus;
    this.persist = opts?.persist;
  }

  /**
   * Late-bind the persist callback after construction. Lets the main-process
   * boot path create the MetadataStore singleton at import time and wire the
   * SessionManager-backed persister once both singletons exist (avoids a
   * module-init cycle: SessionManager → app.getPath('userData') requires
   * Electron's `app` to be ready, which is well after the metadata module
   * is first imported).
   */
  setPersist(persist: ((shape: PersistedShape) => void) | undefined): void {
    this.persist = persist;
  }

  /**
   * Reads the latest committed metadata + version for a pane.
   * Returns `{ metadata: {}, version: 0 }` when no metadata has ever been
   * set on this paneId — `version: 0` is the "never written" sentinel.
   */
  get(paneId: string): MetadataEntry {
    const entry = this.map.get(paneId);
    if (!entry) return { metadata: {}, version: 0 };
    return { metadata: cloneMetadata(entry.metadata), version: entry.version };
  }

  /**
   * Single synchronous critical section.
   *
   *   1. validate(patch)         → throws on invalid input (no version bump)
   *   2. concurrency check       → returns VERSION_CONFLICT on mismatch
   *   3. compute merged shape    → mergeMode semantics
   *   4. enforce MAX_BYTES       → throws if post-merge exceeds cap
   *   5. bump version            → currentVersion + 1
   *   6. commit in-memory        → map.set(paneId, ...)
   *   6.5 persist (M0-e)         → persist(this.serialize()) — synchronous;
   *                                on throw, suppress emit and return
   *                                early with the in-memory commit intact
   *   7. emit event              → EventBus.emit('pane.metadata.changed')
   *
   * Step 6.5 is wired by the boot path (`setPersist`). Test fixtures and
   * pre-boot writes skip it cleanly when no callback is registered.
   */
  set(
    paneId: string,
    patch: Partial<PaneMetadata>,
    opts: SetOptions = {},
  ): SetResult {
    const sanitized = this.sanitize(patch);
    const mode: MergeMode = opts.mergeMode ?? 'merge';

    const existing = this.map.get(paneId);
    if (sanitized.label !== undefined) {
      this.assertLabelAllowed(paneId, sanitized.label, existing?.metadata.label, opts.livePaneIds);
    }
    const currentVersion = existing?.version ?? 0;

    if (opts.expectedVersion !== undefined && opts.expectedVersion !== currentVersion) {
      return { ok: false, error: 'VERSION_CONFLICT', currentVersion };
    }

    const merged = this.merge(existing?.metadata ?? {}, sanitized, mode);
    merged.updatedAt = Date.now();

    // Validate the post-merge shape after every field that will be stored
    // is present. Two cumulative limits:
    //   1. custom entry count — sanitize() only sees the patch, so a chain
    //      of merge-mode writes could grow the stored custom past the cap.
    //   2. total byte cap — JSON.stringify the final committed shape
    //      (updatedAt + version-less metadata) to ensure boundary payloads
    //      that pass with just sanitized fields still fail once updatedAt
    //      is appended.
    if (merged.custom && Object.keys(merged.custom).length > PANE_METADATA_CUSTOM_MAX_ENTRIES) {
      throw new Error(`"custom" exceeds ${PANE_METADATA_CUSTOM_MAX_ENTRIES} entries`);
    }
    if (JSON.stringify(merged).length > PANE_METADATA_MAX_BYTES) {
      throw new Error(`metadata exceeds ${PANE_METADATA_MAX_BYTES} bytes`);
    }

    const newVersion = currentVersion + 1;
    const workspaceId = opts.workspaceId ?? existing?.workspaceId ?? '';

    this.map.set(paneId, {
      metadata: merged,
      version: newVersion,
      workspaceId,
    });

    // Step 6.5 — persist-then-publish (race spec #1).
    // If persist throws, we still committed in-memory but skip the emit
    // so subscribers never see a state we could not durably record. On
    // the next reconciliation pass, the on-disk snapshot is whatever was
    // last successfully persisted; subscribers re-derive via pane.list.
    if (!this.runPersist()) {
      return {
        ok: true,
        version: newVersion,
        metadata: cloneMetadata(merged),
      };
    }

    if (workspaceId) {
      this.bus.emit({
        type: 'pane.metadata.changed',
        workspaceId,
        paneId,
        metadata: cloneMetadata(merged),
        version: newVersion,
      });
    }

    return {
      ok: true,
      version: newVersion,
      metadata: cloneMetadata(merged),
    };
  }

  /**
   * Drops all metadata for a pane while keeping the version counter
   * monotonic. Always succeeds (no concurrency check — clear is idempotent).
   * Emits `pane.metadata.changed` with empty metadata + bumped version.
   *
   * If the pane has no prior entry, returns version 0 without bumping
   * (no event emitted — there was nothing to clear).
   */
  clear(paneId: string): SetResult {
    const existing = this.map.get(paneId);
    if (!existing) {
      return { ok: true, version: 0, metadata: {} };
    }

    const newVersion = existing.version + 1;
    const workspaceId = existing.workspaceId;
    const cleared: PaneMetadata = {};

    this.map.set(paneId, {
      metadata: cleared,
      version: newVersion,
      workspaceId,
    });

    // Step 6.5 — persist-then-publish (race spec #1). See `set()` for the
    // rationale; clear() uses the identical commit-but-no-publish path on
    // persist failure.
    if (!this.runPersist()) {
      return { ok: true, version: newVersion, metadata: {} };
    }

    if (workspaceId) {
      this.bus.emit({
        type: 'pane.metadata.changed',
        workspaceId,
        paneId,
        metadata: {},
        version: newVersion,
      });
    }

    return { ok: true, version: newVersion, metadata: {} };
  }

  /**
   * Atomic snapshot of the store + the EventBus seq watermark.
   * Used by `pane.list` (M0-c) so external clients can reconcile their
   * cached state against a known consistent point.
   *
   * Single-threaded JS guarantees that `latestSeq()` and the map iteration
   * happen in the same task — no concurrent emit() can land between them.
   */
  snapshot(): Snapshot {
    const entries: SnapshotEntry[] = [];
    for (const [paneId, entry] of this.map.entries()) {
      entries.push({
        paneId,
        workspaceId: entry.workspaceId,
        metadata: cloneMetadata(entry.metadata),
        version: entry.version,
      });
    }
    return {
      asOfSeq: this.bus.latestSeq(),
      bootId: this.bus.bootId,
      entries,
    };
  }

  /**
   * Replaces the in-memory store with the given persisted shape. Called by
   * SessionManager on app boot (M0-e). Drops any in-memory entries first.
   * Unknown schema versions throw — callers can catch and fall back to a
   * clean store.
   *
   * No events are emitted by hydrate(); subscribers learn about state via
   * the next pane.list call after boot.
   */
  hydrate(serialized: PersistedShape): void {
    const migrated = this.migrate(serialized, METADATA_SCHEMA_VERSION);
    this.map.clear();
    for (const entry of migrated.entries) {
      this.map.set(entry.paneId, {
        metadata: cloneMetadata(entry.metadata),
        version: entry.version,
        workspaceId: entry.workspaceId,
      });
    }
  }

  /**
   * Returns the persistable shape of the store. Cleared entries (metadata
   * with no fields set) are dropped to keep session.json compact —
   * race #4 (paneId recycle) is in-process only; once a session is dumped
   * and re-hydrated, a recycled paneId starts at version 0 again.
   * In practice this never triggers because wmux paneIds are random UUIDs.
   */
  serialize(): PersistedShape {
    const entries: SnapshotEntry[] = [];
    for (const [paneId, entry] of this.map.entries()) {
      if (isEmptyMetadata(entry.metadata)) continue;
      entries.push({
        paneId,
        workspaceId: entry.workspaceId,
        metadata: cloneMetadata(entry.metadata),
        version: entry.version,
      });
    }
    return {
      schema_version: METADATA_SCHEMA_VERSION,
      entries,
    };
  }

  /**
   * Migrates a persisted shape to a target schema version. Phase 1 ships
   * at schema 1 so this is currently identity-or-throw. Migration table
   * grows in v3.1+ as schema evolves.
   */
  migrate(input: PersistedShape, to: typeof METADATA_SCHEMA_VERSION): PersistedShape {
    if (input.schema_version === to) return input;
    throw new Error(`unsupported metadata schema_version: ${String(input.schema_version)}`);
  }

  /**
   * Called when a pane is destroyed (M0-e adds the IPC for the renderer
   * to signal this). Clears the metadata but keeps the entry slot so the
   * version counter remains monotonic — protects race #4 in case the same
   * paneId is ever recycled within one daemon run.
   *
   * Emits a final `pane.metadata.changed` event with empty metadata + the
   * bumped version so subscribers can drop their mirror entry cleanly.
   */
  onPaneDeleted(paneId: string): void {
    const existing = this.map.get(paneId);
    if (!existing) return;

    const newVersion = existing.version + 1;
    const workspaceId = existing.workspaceId;

    this.map.set(paneId, {
      metadata: {},
      version: newVersion,
      workspaceId,
    });

    // Step 6.5 — persist-then-publish (race spec #1). onPaneDeleted is the
    // tombstone write: serialize() drops empty entries so the on-disk
    // shape shrinks naturally, but the in-memory slot lingers to keep
    // versions monotonic for recycled paneIds within one daemon run.
    if (!this.runPersist()) return;

    if (workspaceId) {
      this.bus.emit({
        type: 'pane.metadata.changed',
        workspaceId,
        paneId,
        metadata: {},
        version: newVersion,
      });
    }
  }

  /** Test-only: drops all state. Not exposed via RPC or MCP. */
  reset(): void {
    this.map.clear();
  }

  // === Internals ===

  /**
   * Drives the persist-then-publish step.
   *
   * Returns true when persistence succeeded (or no callback is wired —
   * test fixtures and pre-boot writes), in which case the caller should
   * proceed with the emit. Returns false when persistence threw: the
   * in-memory commit is intact, but the event is suppressed so no
   * subscriber observes a state we couldn't durably record. The error
   * is logged here so every call site doesn't repeat the same swallow.
   */
  private runPersist(): boolean {
    if (this.persist === undefined) return true;
    try {
      this.persist(this.serialize());
      return true;
    } catch (err) {
      // commit-but-no-publish path — log and bail. The in-memory state
      // will be replaced by whatever is on disk on the next hydrate, and
      // live subscribers will reconcile via the next pane.list call.
      // eslint-disable-next-line no-console
      console.error('[MetadataStore] persist failed; suppressing event emit:', err);
      return false;
    }
  }

  /**
   * The pane label policy (src/shared/paneLabelRules.ts). Runs before any
   * mutation so a rejected label leaves the version untouched. An empty label
   * always clears, and re-setting the pane's own current label is always
   * allowed — labels persisted before the policy existed are left alone rather
   * than made impossible to keep.
   */
  private assertLabelAllowed(
    paneId: string,
    label: string,
    currentLabel: string | undefined,
    livePaneIds: ReadonlySet<string> | undefined,
  ): void {
    const trimmed = label.trim();
    if (trimmed.length === 0) return;
    if (currentLabel !== undefined && currentLabel.trim() === trimmed) return;
    const shape = paneLabelShapeError(trimmed);
    if (shape) throw new PaneLabelError(shape, paneLabelRejectionMessage(shape));
    const wanted = normalizePaneLabel(trimmed);
    for (const [otherId, entry] of this.map) {
      if (otherId === paneId) continue;
      if (livePaneIds && !livePaneIds.has(otherId)) continue;
      const other = entry.metadata.label;
      if (typeof other === 'string' && normalizePaneLabel(other) === wanted) {
        throw new PaneLabelError('duplicate', paneLabelRejectionMessage('duplicate'));
      }
    }
  }

  private sanitize(input: Partial<PaneMetadata>): Partial<PaneMetadata> {
    const out: Partial<PaneMetadata> = {};
    if (input.label !== undefined) {
      if (typeof input.label !== 'string') throw new Error('"label" must be a string');
      if (input.label.length > PANE_METADATA_LABEL_MAX) {
        throw new Error(`"label" exceeds ${PANE_METADATA_LABEL_MAX} chars`);
      }
      out.label = input.label;
    }
    if (input.role !== undefined) {
      if (typeof input.role !== 'string') throw new Error('"role" must be a string');
      if (input.role.length > PANE_METADATA_ROLE_MAX) {
        throw new Error(`"role" exceeds ${PANE_METADATA_ROLE_MAX} chars`);
      }
      out.role = input.role;
    }
    if (input.status !== undefined) {
      if (typeof input.status !== 'string') throw new Error('"status" must be a string');
      if (input.status.length > PANE_METADATA_STATUS_MAX) {
        throw new Error(`"status" exceeds ${PANE_METADATA_STATUS_MAX} chars`);
      }
      out.status = input.status;
    }
    if (input.custom !== undefined) {
      if (
        typeof input.custom !== 'object' ||
        input.custom === null ||
        Array.isArray(input.custom)
      ) {
        throw new Error('"custom" must be an object of string→string');
      }
      const entries = Object.entries(input.custom);
      if (entries.length > PANE_METADATA_CUSTOM_MAX_ENTRIES) {
        throw new Error(`"custom" exceeds ${PANE_METADATA_CUSTOM_MAX_ENTRIES} entries`);
      }
      const custom: Record<string, string> = {};
      for (const [k, v] of entries) {
        if (k.length === 0) throw new Error('"custom" key cannot be empty');
        if (k.length > PANE_METADATA_CUSTOM_KEY_MAX) {
          throw new Error(`"custom" key exceeds ${PANE_METADATA_CUSTOM_KEY_MAX} chars`);
        }
        if (typeof v !== 'string') throw new Error(`"custom.${k}" must be a string`);
        custom[k] = v;
      }
      out.custom = custom;
    }
    return out;
  }

  private merge(
    base: PaneMetadata,
    patch: Partial<PaneMetadata>,
    mode: MergeMode,
  ): PaneMetadata {
    if (mode === 'replace') {
      // Full overwrite: only patch fields survive.
      const result: PaneMetadata = {};
      if (patch.label !== undefined) result.label = patch.label;
      if (patch.role !== undefined) result.role = patch.role;
      if (patch.status !== undefined) result.status = patch.status;
      if (patch.custom !== undefined) result.custom = { ...patch.custom };
      return result;
    }

    if (mode === 'replaceShared') {
      // Replace top-level shared fields wholesale; preserve base.custom
      // wholesale. patch.custom is silently ignored — callers that need to
      // write custom should use 'merge' (additive) or 'replace' (full
      // overwrite). This is the substrate guarantee that lets one tool
      // claim the shared display vocabulary without touching another
      // tool's namespaced state. See docs/PROTOCOL.md §1.4.
      const result: PaneMetadata = {};
      if (base.custom !== undefined) result.custom = { ...base.custom };
      if (patch.label !== undefined) result.label = patch.label;
      if (patch.role !== undefined) result.role = patch.role;
      if (patch.status !== undefined) result.status = patch.status;
      return result;
    }

    // 'merge' — patch-style with one-level deep-merge on custom.
    const result: PaneMetadata = {
      ...(base.label !== undefined && { label: base.label }),
      ...(base.role !== undefined && { role: base.role }),
      ...(base.status !== undefined && { status: base.status }),
    };
    if (base.custom !== undefined) result.custom = { ...base.custom };

    if (patch.label !== undefined) result.label = patch.label;
    if (patch.role !== undefined) result.role = patch.role;
    if (patch.status !== undefined) result.status = patch.status;
    if (patch.custom !== undefined) {
      result.custom = { ...(result.custom ?? {}), ...patch.custom };
    }
    return result;
  }
}

// Module-level singleton — main process only.
export const metadataStore = new MetadataStore();
