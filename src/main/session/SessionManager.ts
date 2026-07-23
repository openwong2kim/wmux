import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionData } from '../../shared/types';
import type { PersistedShape } from '../metadata/MetadataStore';
import { METADATA_SCHEMA_VERSION } from '../metadata/MetadataStore';
import {
  atomicReadJSONSync,
  atomicWriteJSON,
  atomicWriteJSONSync,
  createMigrator,
  SESSION_DATA_REGISTRY,
} from '../../daemon/util/atomicWrite';
import { AsyncQueue } from '../../daemon/util/AsyncQueue';

const DEBOUNCE_MS = 30_000;
const QUEUE_KEY = 'session';

export class SessionManager {
  /**
   * Resolved LAZILY (first use), never in the constructor. This class is
   * instantiated as a module-level singleton (session.handler.ts) — module
   * evaluation runs BEFORE index.ts applies WMUX_DATA_SUFFIX via
   * app.setPath('userData', …), so a constructor-captured path pins
   * session.json/metadata.json to the UN-suffixed userData dir. Every other
   * suffixed surface (pipes, daemon home, logs, tokens) is isolated, so a
   * suffixed instance (dev '-dev', bench/probe isolation, multi-instance)
   * silently reads/writes ANOTHER instance's session state — the same
   * hardcoded-shared-path class as the daemon auth-token bug fixed in #325.
   * First use is always an IPC handler or save path, well after the suffix
   * is applied, so lazy resolution is sufficient (no re-resolve needed).
   */
  private filePathCached: string | null = null;
  private get filePath(): string {
    return (this.filePathCached ??= path.join(app.getPath('userData'), 'session.json'));
  }
  /**
   * Separate file for the MetadataStore's `PersistedShape` (M0-e).
   *
   * Keeping metadata out of `session.json` is deliberate:
   *   - session.json is a large payload (workspaces + surfaces + scrollback
   *     refs) coalesced via a 30s debounce. Writing it inline on every
   *     metadata mutation would burn IO and stall the renderer.
   *   - metadata.json is small (paneId → PaneMetadata + version) and tied
   *     to a per-write sync atomic write, which is what the persist-then-
   *     publish race spec demands (#1: no subscriber may observe a state
   *     we have not durably recorded).
   *   - Corruption isolation: a torn write on metadata.json never poisons
   *     the workspace tree, and vice versa.
   *   - schema_version (M0-a + M0-f) lives inside the metadata envelope,
   *     so its evolution does not pull session.json migrations along.
   */
  /** Lazy for the same suffix-isolation reason as {@link filePath}. */
  private metadataFilePathCached: string | null = null;
  private get metadataFilePath(): string {
    return (this.metadataFilePathCached ??= path.join(app.getPath('userData'), 'metadata.json'));
  }
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingData: SessionData | null = null;
  private readonly queue = new AsyncQueue();
  // A4: monotonically increasing epoch for save-order guarantee. Event-driven sync save()
  // bumps lastCommittedEpoch on each commit. Async writes (saveAsync/saveDebounced) capture
  // epoch at staging time and skip writing their stale snapshot if a newer sync commit
  // occurred before the actual write (epoch ahead).
  //
  // Review fix (wave 0 panel — in-flight reversal): pre-write check alone cannot stop an
  // async write already inside `await atomicWriteJSON` from overwriting a sync commit that
  // happened in between via a late rename. So we keep sync commits in `lastSyncCommit` and,
  // right after async write completes, if "my epoch < latest sync epoch", immediately
  // re-write that sync data to restore (same queue task — serialized). Final disk state
  // matches latest commit under any interleaving.
  private writeEpoch = 0;
  private lastCommittedEpoch = 0;
  private lastSyncCommit: { epoch: number; data: SessionData } | null = null;

  constructor() {
    // Paths deliberately NOT captured here — see the filePath getter.

    // Sync fallback for `flushSync()` on emergency exit paths
    // (Windows session-end, process crash handlers, etc.).
    this.queue.setSyncFallback(QUEUE_KEY, () => {
      if (this.pendingData !== null) {
        atomicWriteJSONSync(this.filePath, this.pendingData, {
          validate: SessionManager.isSessionData,
          rotationEnabled: true,
        });
        this.pendingData = null;
      }
    });
  }

  /**
   * Atomic save: delegates to the shared atomic-write helper which
   * writes to .tmp, backs up the existing file to .bak, then renames
   * .tmp → session.json. If the process crashes mid-write, only the
   * .tmp file is corrupted; the original session.json (or .bak)
   * remains intact.
   *
   * Synchronous — used by IPC handlers and the Windows session-end
   * emergency path, both of which require the write to complete
   * inline. T2 keeps this signature frozen.
   */
  save(data: SessionData): void {
    // If a debounced write is queued, drop it — we're about to
    // persist a newer snapshot synchronously and do not want the
    // older async payload to overwrite it on completion.
    this.queue.clear();
    // A4: mark this sync commit as newer than any prior async staging via epoch.
    const epoch = ++this.writeEpoch;
    try {
      atomicWriteJSONSync(this.filePath, data, {
        validate: SessionManager.isSessionData,
        rotationEnabled: true,
      });
      this.pendingData = null;
      this.lastCommittedEpoch = epoch;
      // Keep for in-flight async reversal restore (see field comment above).
      this.lastSyncCommit = { epoch, data };
      // v2 RCA fix (axis A ③): log exactly which ptyIds this snapshot commits so
      // a fossil-vs-fresh persistence question is answerable from the log alone.
      console.log(`[SessionManager] save: ${SessionManager.summarizePtyIds(data)}`);
    } catch (err) {
      console.error('[SessionManager] Failed to save session:', err);
    }
  }

  /**
   * A4 (NB2 wave 0) — async periodic save. Renderer's 5-second crash-safety tick uses
   * this path. Same atomicity as `save()` (tmp+rename+.bak) but main-side write is async
   * so it does not block the main event loop.
   *
   * Loss window unchanged: no debounce on this path — each 5s tick enqueues an async write
   * immediately, so max crash loss window equals the legacy sync 5s tick (≤5s).
   * Reason we do not use `saveDebounced` (30s) — it would widen the window to 30s.
   *
   * Source-of-truth priority: event-driven sync `save()` (ptyId change — reboot survival
   * path) clears the queue and pendingData=null so newer snapshot wins. Exit paths
   * (flush/flushSync) sync-flush pendingData so last async staging also hits disk.
   */
  saveAsync(data: SessionData): void {
    this.pendingData = data;
    const epoch = ++this.writeEpoch;
    void this.queue.enqueue(QUEUE_KEY, async () => {
      await this.writeStagedAsync(epoch, 'saveAsync');
    });
  }

  /**
   * Shared async staging write path (saveAsync·saveDebounced).
   *  1) pre-write: skip stale snapshot if a newer sync commit already exists.
   *  2) write: atomic (tmp+rename+.bak) async write.
   *  3) post-write restore (review fix): if a sync commit snuck in during await and our
   *     rename overwrote it, immediately re-write the kept sync commit. Loop catches newer
   *     syncs during restore (monotonic epoch — finite termination).
   */
  private async writeStagedAsync(epoch: number, tag: string): Promise<void> {
    const payload = this.pendingData;
    if (payload === null) return;
    if (this.lastCommittedEpoch > epoch) {
      if (this.pendingData === payload) this.pendingData = null;
      return;
    }
    try {
      await atomicWriteJSON(this.filePath, payload, {
        validate: SessionManager.isSessionData,
        rotationEnabled: true,
      });
      this.lastCommittedEpoch = Math.max(this.lastCommittedEpoch, epoch);
      if (this.pendingData === payload) {
        this.pendingData = null;
        console.log(`[SessionManager] ${tag}: ${SessionManager.summarizePtyIds(payload)}`);
      }
      // post-write restore loop: we (epoch) may have overwritten a newer sync commit
      // (epoch > epoch) via rename — re-commit that sync data to bring disk current.
      let restoredEpoch = epoch;
      while (this.lastSyncCommit && this.lastSyncCommit.epoch > restoredEpoch) {
        const sync = this.lastSyncCommit;
        await atomicWriteJSON(this.filePath, sync.data, {
          validate: SessionManager.isSessionData,
          rotationEnabled: true,
        });
        restoredEpoch = sync.epoch;
        console.log(
          `[SessionManager] ${tag}: restored newer sync commit (epoch ${sync.epoch}) over stale async write`,
        );
      }
    } catch (err) {
      console.error(`[SessionManager] Failed to save session (${tag}):`, err);
    }
  }

  /**
   * Debounced save — coalesces frequent updates (periodic scrollback
   * timestamp refreshes, etc.) over 30s. Funnels through an
   * `AsyncQueue` so overlapping debounced writes serialize safely
   * against the shared `.bak`/`.tmp` rotation.
   */
  saveDebounced(data: SessionData): void {
    this.pendingData = data;

    if (this.debounceTimer !== null) {
      return;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const snapshot = this.pendingData;
      if (snapshot === null) return;

      // Review fix: debounce path shares same epoch guard·post-write restore as saveAsync
      // (same race where in-flight reversal could overwrite sync commit).
      const epoch = ++this.writeEpoch;
      void this.queue.enqueue(QUEUE_KEY, async () => {
        await this.writeStagedAsync(epoch, 'saveDebounced');
      });
    }, DEBOUNCE_MS);
  }

  /** Await any queued async writes. Also cancels the pending debounce timer. */
  async flush(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      if (this.pendingData !== null) {
        this.save(this.pendingData);
      }
    }
    await this.queue.flush();
  }

  /**
   * Process-exit friendly drain. Cancels the debounce timer and runs
   * any registered sync fallbacks for queued async writes.
   *
   * Order (T14 fix — matches StateWriter.flushSync):
   *   1. Cancel the debounce timer.
   *   2. Drive the queue's sync fallback first so a currently-running
   *      async task does not race us on `pendingData`.
   *   3. If `pendingData` is still staged after the drain, persist it
   *      inline (normal case: debounce timer had not fired yet).
   */
  flushSync(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.queue.flushSync();

    if (this.pendingData !== null) {
      const data = this.pendingData;
      this.pendingData = null;
      try {
        atomicWriteJSONSync(this.filePath, data, {
          validate: SessionManager.isSessionData,
          rotationEnabled: true,
        });
        // v2 RCA fix (axis A ③): session-end's LAST write must be observable too
        // — same ptyId summary as save()/load() so a reboot postmortem can see
        // exactly what hit disk last.
        console.log(`[SessionManager] flushSync: ${SessionManager.summarizePtyIds(data)}`);
      } catch (err) {
        console.error('[SessionManager] flushSync immediate write failed:', err);
      }
    }
  }

  load(): SessionData | null {
    // v2 RCA fix (adversarial review): distinguish "no session file" (true
    // first launch → null) from "file exists but unreadable" (transient AV/
    // indexer lock at boot). The old catch collapsed both to null; the renderer
    // treats null as FIRST LAUNCH, sets sessionLoadedRef=true, and the very
    // next event-driven save would overwrite the user's good session.json with
    // the default empty workspace. Rethrowing instead makes the IPC reject →
    // the renderer's startup catch runs the clearAllPtyState fallback with
    // sessionLoadedRef=false, which gates ALL saves — the on-disk layout
    // survives for the next boot.
    const hadFile = fs.existsSync(this.filePath);
    try {
      // T7: wire the lazy-migration hook. Production registry ships
      // as identity (v1, no steps) and `createMigrator` safely
      // short-circuits legacy payloads without a `version` marker
      // (SessionData historically shipped without one). Wiring this
      // here makes future schema revisions land without further
      // call-site changes.
      const migrator = createMigrator<SessionData>(
        SESSION_DATA_REGISTRY,
        this.filePath,
      );
      const loaded = atomicReadJSONSync<SessionData>(this.filePath, {
        validate: SessionManager.isSessionData,
        migrator,
      });
      // The atomic-read helper swallows read/validate failures internally
      // (falls through the .bak chain, then returns null) — so a locked or
      // fully-corrupt-with-backups file surfaces as null, indistinguishable
      // from first launch. Promote that to an error when the file EXISTS:
      // refusing to load is recoverable (next boot retries; the file is
      // preserved for salvage), silently treating it as first launch is not
      // (the next save overwrites the user's layout with the default).
      if (loaded === null && hadFile) {
        throw new Error('session.json exists but could not be read/validated — refusing to treat as first launch');
      }
      // v2 RCA fix (axis A ③): log which ptyIds we actually loaded. Correlated
      // with the daemon's recovery log, a mismatch here is the fossil-reattach
      // signature (session.json holds a ptyId the daemon no longer has).
      console.log(`[SessionManager] load from ${path.basename(this.filePath)}: ${loaded ? SessionManager.summarizePtyIds(loaded) : '(no session file)'}`);
      return loaded;
    } catch (err) {
      console.error('[SessionManager] Failed to load session:', err);
      if (hadFile) throw err;
      return null;
    }
  }

  /** Truncation caps for the ptyId log summary — one knob, three call sites
   *  (save/load/flushSync) so the correlated log lines can never drift. */
  private static readonly LOG_MAX_IDS = 6;
  private static readonly LOG_ID_PREFIX = 16;

  /** One-line ptyId summary shared by save()/load()/flushSync() logging. */
  private static summarizePtyIds(data: SessionData): string {
    const ids = SessionManager.collectPtyIds(data);
    const shown = ids.slice(0, SessionManager.LOG_MAX_IDS).map((i) => i.slice(0, SessionManager.LOG_ID_PREFIX)).join(', ');
    return `${ids.length} pty [${shown}${ids.length > SessionManager.LOG_MAX_IDS ? ', …' : ''}]`;
  }

  /**
   * v2 RCA fix (axis A ③): enumerate every persisted surface ptyId in a
   * SessionData snapshot. Used only for save/load logging so fossil-ptyId
   * persistence and `.bak`-fallback resurrection are observable in the log.
   */
  private static collectPtyIds(data: SessionData): string[] {
    const ids: string[] = [];
    const walk = (pane: unknown): void => {
      if (!pane || typeof pane !== 'object') return;
      const p = pane as { type?: string; surfaces?: Array<{ ptyId?: string }>; children?: unknown[] };
      if (p.type === 'leaf') {
        for (const s of p.surfaces ?? []) if (s.ptyId) ids.push(s.ptyId);
      } else if (Array.isArray(p.children)) {
        for (const c of p.children) walk(c);
      }
    };
    for (const ws of data.workspaces ?? []) {
      walk((ws as { rootPane?: unknown }).rootPane);
    }
    return ids;
  }

  /**
   * Type guard passed to the shared atomic-read helper. Mirrors the
   * validation previously inlined in this module.
   */
  private static isSessionData(parsed: unknown): parsed is SessionData {
    if (typeof parsed !== 'object' || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj['workspaces'])) return false;
    if (typeof obj['activeWorkspaceId'] !== 'string') return false;
    return true;
  }

  // ── Metadata persistence (M0-e) ────────────────────────────────────
  //
  // Public surface kept minimal:
  //   - saveMetadataSync(shape) — called from `MetadataStore.set/clear/
  //     onPaneDeleted` via the persist callback wired in boot. Sync so
  //     it can run inside the store's atomic critical section.
  //   - loadMetadata() — called once on boot, before any pane.list /
  //     pane.setMetadata RPCs land. Returns null on missing / corrupt /
  //     schema-mismatch; the caller falls back to a clean store.
  //
  // Atomic semantics are inherited from `atomicWriteJSONSync` / `atomicRead
  // JSONSync`: tmp + rename + .bak fallback. Validation is enforced on
  // both write (so a malformed shape never lands on disk) and read (so a
  // tampered file rejects cleanly without crashing the daemon).

  /** Sync atomic write of MetadataStore's `PersistedShape`. */
  saveMetadataSync(shape: PersistedShape): void {
    atomicWriteJSONSync(this.metadataFilePath, shape, {
      validate: SessionManager.isPersistedShape,
      rotationEnabled: true,
    });
  }

  /**
   * Read `metadata.json` from disk on boot. Returns null on missing,
   * corrupt, or schema-mismatched payload (the atomic-read helper logs
   * a warning and quarantines the file in those cases).
   */
  loadMetadata(): PersistedShape | null {
    try {
      return atomicReadJSONSync<PersistedShape>(this.metadataFilePath, {
        validate: SessionManager.isPersistedShape,
      });
    } catch (err) {
      console.error('[SessionManager] Failed to load metadata:', err);
      return null;
    }
  }

  /**
   * Type guard for the metadata envelope. Mirrors the public shape
   * exported from `MetadataStore` — duplicated here so the type guard
   * stays in lockstep with the validator the atomic-write helper runs.
   *
   * Phase 1 ships at schema_version === 1. Newer envelopes are rejected
   * at the validation layer; the caller's `MetadataStore.migrate` would
   * have been the right hook, but on-disk format changes also require
   * an explicit migration registry (M0-f / v3.1+) which has not landed.
   *
   * Codex P2 (M0-e): the inner `metadata` field is validated strictly
   * against the `PaneMetadata` runtime contract. Previously this guard
   * accepted any non-null object, so a corrupt or tampered entry such
   * as `{ label: 123 }` or `{ custom: [] }` passed validation and
   * `MetadataStore.hydrate()` cloned the invalid fields into the
   * authoritative store, leaking them to clients. We now reject the
   * envelope (return false → atomicReadJSONSync returns null → boot
   * falls back to the clean-slate path) if any field violates its
   * declared type.
   */
  private static isPersistedShape(parsed: unknown): parsed is PersistedShape {
    if (typeof parsed !== 'object' || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;
    if (obj['schema_version'] !== METADATA_SCHEMA_VERSION) return false;
    if (!Array.isArray(obj['entries'])) return false;
    // Final-review follow-up (P1-8): the on-disk envelope is an `entries`
    // array, not a map. A tampered or torn-write file with two entries for
    // the same paneId would silently let `MetadataStore.hydrate()`'s
    // `map.set(paneId, …)` loop keep the *last* one, dropping the prior
    // entry's version + workspaceId without warning. We reject the whole
    // envelope here — the helper returns null, and the boot path falls
    // back to the legacy-migration / clean-slate branch in main/index.ts.
    const seenPaneIds = new Set<string>();
    for (const entry of obj['entries']) {
      if (typeof entry !== 'object' || entry === null) return false;
      const e = entry as Record<string, unknown>;
      if (typeof e['paneId'] !== 'string') return false;
      if (typeof e['workspaceId'] !== 'string') return false;
      if (typeof e['version'] !== 'number') return false;
      if (!SessionManager.isPaneMetadataShape(e['metadata'])) return false;
      const paneId = e['paneId'] as string;
      if (seenPaneIds.has(paneId)) return false;
      seenPaneIds.add(paneId);
    }
    return true;
  }

  /**
   * Strict shape check for the `PaneMetadata` runtime contract
   * (shared/types.ts). Per-field byte caps are re-enforced when the
   * store hydrates and re-sanitises — here we only gate type identity
   * so corrupt fields never reach `MetadataStore.hydrate()`.
   */
  private static isPaneMetadataShape(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    if (Array.isArray(value)) return false;
    const m = value as Record<string, unknown>;

    if (m['label'] !== undefined && typeof m['label'] !== 'string') return false;
    if (m['role'] !== undefined && typeof m['role'] !== 'string') return false;
    if (m['status'] !== undefined && typeof m['status'] !== 'string') return false;
    if (m['updatedAt'] !== undefined && typeof m['updatedAt'] !== 'number') return false;

    if (m['custom'] !== undefined) {
      const custom = m['custom'];
      if (typeof custom !== 'object' || custom === null || Array.isArray(custom)) {
        return false;
      }
      // PaneMetadata.custom is Record<string, string> — every value
      // must be a string. A tampered file with non-string values would
      // otherwise hydrate into the store as-is and break clients that
      // index `custom[k]` expecting a string.
      for (const v of Object.values(custom as Record<string, unknown>)) {
        if (typeof v !== 'string') return false;
      }
    }

    return true;
  }
}
