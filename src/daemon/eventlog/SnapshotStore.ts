/**
 * SnapshotStore — projection snapshot save/load + fallback chain + compaction planning
 * (envelope-design §5·§9). PR2 scope: pure library. Service wiring is PR3.
 *
 * Contract summary (spec surface):
 *   - All snapshot writes are durable (§2.3 D13) — projection snapshots are referenced by manifest.snapshotLamport
 *     and §9 compaction "truncate only after durable confirmed" so non-fsync writes cause double loss.
 *   - genesis (immutable)·reseed (genesis-grade immutable)·projection snapshots share one SnapshotEnvelope
 *     format — snapshotLamport marker must live **in the file itself** so fallback chain knows exact replay
 *     floor when descending to .bak/reseed (manifest.snapshotLamport is latest-snapshot basis so
 *     inaccurate on fallen-back older snapshot → data loss). Each snapshot is self-contained.
 *   - Fallback chain (§5): latest snapshot → .bak → reseed (newest first) → genesis. On corruption, next step.
 *     ".bak" step handled by atomicReadJSONSync primary→.bak fallback.
 *   - Compaction trigger is **planning function only** (planCompaction) — execution (truncate) is future (PR3+). Guards:
 *     no truncate before durable snapshot confirmed, genesis·reseed never truncated (§9 trap, D14).
 */

import path from 'node:path';
import {
  atomicWriteJSON,
  atomicWriteJSONSync,
  atomicReadJSONSync,
} from '../util/atomicWrite';
import { AsyncQueue } from '../util/AsyncQueue';

/**
 * Envelope for one snapshot file (§5). Carries projection (domain state) and snapshotLamport marker together so
 * fallback chain is self-contained from files alone.
 *
 * additive-only: add fields only, no remove·rename of existing fields (disk persistence contract).
 */
export interface SnapshotEnvelope<T> {
  version: number;
  /** Max lamport reflected in this snapshot. Boot replay applies only `lamport > snapshotLamport` (§5). */
  snapshotLamport: number;
  /** Domain projection (ChannelState etc.). Log layer does not interpret. */
  projection: T;
}

export const SNAPSHOT_ENVELOPE_VERSION = 1;

/** `events/snapshot/` subdirectory name (§2.1). */
export const SNAPSHOT_DIRNAME = 'snapshot';

/** genesis channel snapshot ref name (§2.1, D14 immutable). */
export const GENESIS_CHANNEL_REF = 'genesis-channel.json';
/** Active channel projection snapshot ref name (§2.1·§5). */
export const CHANNEL_PROJECTION_REF = 'channel.json';
/** Active A2A projection snapshot ref name (§2.1·§5). */
export const A2A_PROJECTION_REF = 'a2a.json';

/** reseed snapshot ref name builder (§6.4c, genesis-grade immutable). */
export function reseedRef(n: number): string {
  return `reseed-${n}.json`;
}

/** SnapshotEnvelope structure guard (projection content checked by separate validator). */
export function isSnapshotEnvelope(v: unknown): v is SnapshotEnvelope<unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['version'] === 'number' &&
    typeof o['snapshotLamport'] === 'number' &&
    'projection' in o
  );
}

/** Fallback chain load result. source tells which step for audit·tests. */
export interface FallbackLoad<T> {
  projection: T;
  snapshotLamport: number;
  source: 'snapshot' | 'reseed' | 'genesis';
  ref: string;
}

/** Segment meta for planCompaction input. */
export interface SegmentMeta {
  num: number;
  /** Max lamport in segment. Empty segment is 0. */
  maxLamport: number;
  empty: boolean;
}

/** planCompaction planning result (no execution — truncate candidate list + protected snapshot list). */
export interface CompactionPlan {
  /** Segment numbers safe to truncate (delete). Empty if durable unconfirmed. */
  truncatableSegments: number[];
  /** Never-truncate snapshots (§9 D14) — genesis + all reseed. Explicit·verifiable contract. */
  protectedSnapshots: string[];
  /** Planning rationale (audit·tests). */
  reason: string;
}

const DEFAULT_DEBOUNCE_MS = 30_000;

interface DebounceSlot<T> {
  timer: NodeJS.Timeout | null;
  pending: SnapshotEnvelope<T> | null;
  /**
   * Generation guard (panel E): monotonically increases on each sync write (writeDurableSync·flushSync).
   * In-flight async write captures start generation; on completion if generation advanced (= its rename
   * overwrote fresher sync content) restore lastSync — same pattern as ChannelStateWriter
   * immediateEpoch race recovery (:142-160).
   */
  epoch: number;
  /** Last sync write content (generation guard restore source). */
  lastSync: SnapshotEnvelope<T> | null;
}

/**
 * Projection snapshot store. Writes files under `snapshotDir` (= `events/snapshot`) durably.
 * Debounced path for boot-acceleration active projection snapshots (channel.json etc.); writeDurableSync for
 * ordered migration sequences (genesis·reseed).
 */
export class SnapshotStore {
  private readonly dir: string;
  private readonly debounceMs: number;
  private readonly queue = new AsyncQueue();
  // Independent debounce per ref (channel.json·a2a.json do not delay each other).
  private readonly slots = new Map<string, DebounceSlot<unknown>>();

  constructor(
    snapshotDir: string,
    opts: { debounceMs?: number } = {},
  ) {
    this.dir = snapshotDir;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /** Absolute snapshot file path. */
  snapshotPath(ref: string): string {
    return path.join(this.dir, ref);
  }

  /** Acquire debounce slot per ref. */
  private getSlot(ref: string): DebounceSlot<unknown> {
    let slot = this.slots.get(ref);
    if (!slot) {
      slot = { timer: null, pending: null, epoch: 0, lastSync: null };
      this.slots.set(ref, slot);
    }
    return slot;
  }

  /**
   * Durable sync write (§2.3). For ordered points like migration sequence (genesis)·reseed.
   * If validateProjection present, validates projection content too (genesis integrity guarantee).
   * Generation guard (panel E): sync write bumps epoch so in-flight async on same ref that overwrites
   * this content gets restored.
   */
  writeDurableSync<T>(
    ref: string,
    projection: T,
    snapshotLamport: number,
    validateProjection?: (data: unknown) => boolean,
  ): void {
    const envelope: SnapshotEnvelope<T> = {
      version: SNAPSHOT_ENVELOPE_VERSION,
      snapshotLamport,
      projection,
    };
    atomicWriteJSONSync(this.snapshotPath(ref), envelope, {
      durable: true,
      validate: validateProjection
        ? (d) => isSnapshotEnvelope(d) && validateProjection(d.projection)
        : isSnapshotEnvelope,
    });
    // Bump epoch only after successful write (do not use failed sync as restore source).
    const slot = this.getSlot(ref);
    slot.epoch++;
    slot.lastSync = envelope;
  }

  /**
   * Debounced durable write (§5). Coalesces frequent updates in debounceMs window.
   * Not commit path (canonical is log) — boot-acceleration cache only; loss recoverable via replay.
   */
  saveDebounced<T>(
    ref: string,
    projection: T,
    snapshotLamport: number,
  ): void {
    const envelope: SnapshotEnvelope<T> = {
      version: SNAPSHOT_ENVELOPE_VERSION,
      snapshotLamport,
      projection,
    };
    const slot = this.getSlot(ref);
    slot.pending = envelope;
    if (slot.timer !== null) return;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      const snap = slot.pending;
      if (snap === null) return;
      void this.queue.enqueue(ref, async () => {
        const payload = slot.pending;
        if (payload === null) return;
        // Generation guard (panel E): sync write (flushSync·writeDurableSync) during await window means
        // this async rename overwrites fresher content as stale → restore after completion via epoch compare.
        const epochAtStart = slot.epoch;
        try {
          await atomicWriteJSON(this.snapshotPath(ref), payload, {
            durable: true,
            validate: isSnapshotEnvelope,
          });
          if (slot.epoch !== epochAtStart && slot.lastSync !== null) {
            // Stale rename overwrote latest sync — restore (durable sync).
            try {
              atomicWriteJSONSync(this.snapshotPath(ref), slot.lastSync, {
                durable: true,
                validate: isSnapshotEnvelope,
              });
            } catch (err) {
              console.error(
                '[SnapshotStore] generation-guard restore write failed:',
                err,
              );
            }
          }
          if (slot.pending === payload) slot.pending = null;
        } catch (err) {
          // Snapshot is cache — failure does not affect canonical (log). Log and continue.
          console.error('[SnapshotStore] debounced snapshot write failed:', err);
        }
      });
    }, this.debounceMs);
  }

  /** Expire debounce timer immediately (durable sync write). For process shutdown path (§6.4b PR3). */
  flushSync(): void {
    for (const [ref, slot] of this.slots) {
      if (slot.timer !== null) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      if (slot.pending !== null) {
        const snap = slot.pending;
        slot.pending = null;
        try {
          atomicWriteJSONSync(this.snapshotPath(ref), snap, {
            durable: true,
            validate: isSnapshotEnvelope,
          });
          // Epoch advance (panel E): in-flight async that overwrites gets restored.
          slot.epoch++;
          slot.lastSync = snap;
        } catch (err) {
          console.error('[SnapshotStore] flushSync snapshot write failed:', err);
        }
      }
    }
    this.queue.flushSync();
  }

  /** Timer cleanup (daemon shutdown). Remaining pending drained via flushSync. */
  dispose(): void {
    this.flushSync();
  }

  /**
   * Load one snapshot (primary→.bak fallback built into atomicReadJSONSync). Validates envelope structure +
   * projection together; corrupt snapshot returns null (fallback chain proceeds to next step).
   *
   * preserveOnCorruption (panel G①): when true, validate reject does not **move** file to isolation —
   * genesis·reseed are §6.2 immutable contract ("no path modifies·deletes") so even read path must not move files.
   * Active projection snapshot (rewrite cache) defaults false (preserve existing isolation evidence behavior).
   */
  load<T>(
    ref: string,
    validateProjection: (data: unknown) => boolean,
    opts: { preserveOnCorruption?: boolean } = {},
  ): SnapshotEnvelope<T> | null {
    return atomicReadJSONSync<SnapshotEnvelope<T>>(this.snapshotPath(ref), {
      validate: (d): d is SnapshotEnvelope<T> =>
        isSnapshotEnvelope(d) && validateProjection(d.projection),
      quarantineOnCorruption: opts.preserveOnCorruption ? false : undefined,
    });
  }

  /**
   * Fallback chain load (§5): latest snapshot → .bak → reseed (newest first) → genesis.
   * Each step carries self-contained snapshotLamport so caller replays only log beyond that value.
   * null if all steps corrupt (catastrophe — upper layer handles).
   */
  loadWithFallback<T>(opts: {
    activeRef: string;
    genesisRef: string;
    reseedRefs: string[];
    validateProjection: (data: unknown) => boolean;
  }): FallbackLoad<T> | null {
    const { activeRef, genesisRef, reseedRefs, validateProjection } = opts;

    const active = this.load<T>(activeRef, validateProjection);
    if (active) {
      return {
        projection: active.projection,
        snapshotLamport: active.snapshotLamport,
        source: 'snapshot',
        ref: activeRef,
      };
    }

    // reseed from newest (highest number) — prioritize most recent old-daemon span recovery.
    // preserveOnCorruption: reseed·genesis are §6.2 immutable artifacts — no move even when corrupt (G①).
    for (const ref of [...reseedRefs].reverse()) {
      const rs = this.load<T>(ref, validateProjection, {
        preserveOnCorruption: true,
      });
      if (rs) {
        return {
          projection: rs.projection,
          snapshotLamport: rs.snapshotLamport,
          source: 'reseed',
          ref,
        };
      }
    }

    const genesis = this.load<T>(genesisRef, validateProjection, {
      preserveOnCorruption: true,
    });
    if (genesis) {
      return {
        projection: genesis.projection,
        snapshotLamport: genesis.snapshotLamport,
        source: 'genesis',
        ref: genesisRef,
      };
    }

    return null;
  }

  /**
   * Compaction trigger planning (§9) — **plan only, no truncate execution** (PR2 scope). Guards:
   *   - durable snapshot unconfirmed (durableSnapshotConfirmed=false) → zero truncate candidates —
   *     truncating assuming non-fsync snapshot causes double loss on total loss (§9 trap, D13 closes it).
   *   - Non-empty segments at or below protectedFloorLamport are candidates but **most recent candidate
   *     kept one for audit** (§9 "keep one version for audit").
   *   - Active segment never a candidate.
   *   - genesis·reseed are snapshots not segments so structurally absent from segment candidates —
   *     contract made explicit·verifiable via protectedSnapshots (D14).
   */
  static planCompaction(input: {
    segments: SegmentMeta[];
    /**
     * Truncate protection floor (panel F). **Caller contract: pass min of snapshotLamport among surviving
     * snapshots in fallback chain (primary·`.bak` etc.)** — truncating by manifest latest lamport (Y) alone
     * when primary corrupt and falling back to .bak (older X) truncates (X, Y] events making recovery impossible.
     * min closes that window.
     */
    protectedFloorLamport: number;
    durableSnapshotConfirmed: boolean;
    activeSegment: number;
    genesisRef: string;
    reseedRefs: string[];
  }): CompactionPlan {
    const protectedSnapshots = [input.genesisRef, ...input.reseedRefs];

    if (!input.durableSnapshotConfirmed) {
      return {
        truncatableSegments: [],
        protectedSnapshots,
        reason: 'durable snapshot unconfirmed — truncate forbidden (§9 trap)',
      };
    }

    // Candidates = non-empty, all at or below protection floor, not active.
    const candidates = input.segments
      .filter(
        (s) =>
          !s.empty &&
          s.maxLamport <= input.protectedFloorLamport &&
          s.num !== input.activeSegment,
      )
      .map((s) => s.num)
      .sort((a, b) => a - b);

    if (candidates.length === 0) {
      return {
        truncatableSegments: [],
        protectedSnapshots,
        reason: 'no segments at or below protectedFloorLamport',
      };
    }

    // Keep most recent candidate (highest number) for audit → only earlier ones truncatable.
    const truncatableSegments = candidates.slice(0, candidates.length - 1);
    return {
      truncatableSegments,
      protectedSnapshots,
      reason:
        truncatableSegments.length > 0
          ? `durable confirmed — truncate segments at or below protectedFloorLamport ${input.protectedFloorLamport} (keep 1 for audit)`
          : 'only one candidate — audit retention yields zero truncations',
    };
  }
}
