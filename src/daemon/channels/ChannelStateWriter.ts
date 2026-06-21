// ─── ChannelStateWriter ────────────────────────────────────────────────────
// Persists ChannelState (channels.json) to disk using the shared atomic-write
// helpers in `../util/atomicWrite`. The public API mirrors `StateWriter`
// (saveImmediate / saveDebounced / load / flush / flushSync / dispose) so
// future waves can layer behaviour without changing call sites.
//
// Concurrency model is identical to StateWriter's:
//   - `saveImmediate` is synchronous and remains so — emergency-exit
//     paths (SIGINT/SIGTERM/etc.) rely on it running inline. Before
//     writing it clears any queued async write so a stale debounced
//     snapshot cannot overwrite the newer immediate one.
//   - `saveDebounced` funnels through an AsyncQueue keyed
//     `'channel-state'` so only one async write is ever in flight.
//     Repeated debounced calls coalesce to the latest snapshot.
//   - `flushSync` drains the queue by invoking the registered sync
//     fallback (used by process-exit handlers where the event loop
//     has stopped).
//
// Plan reference: U1 (channel domain types and persistence layer).

import path from 'node:path';
import {
  atomicReadJSONSync,
  atomicWriteJSON,
  atomicWriteJSONSync,
  createMigrator,
  CHANNEL_STATE_REGISTRY,
} from '../util/atomicWrite';
import { AsyncQueue } from '../util/AsyncQueue';
import {
  CHANNEL_EMPTY_TTL_HOURS_DEFAULT,
  EMPTY_CHANNEL_STATE,
  type ChannelState,
} from '../../shared/channels';

const DEBOUNCE_MS = 30_000;
const QUEUE_KEY = 'channel-state';

/**
 * Persists ChannelState to `channels.json`. Channel-specific concerns:
 *   - On `load()`, channels with zero members for `emptyChannelTtlHours`
 *     (default 7d) are pruned. The 7-day bound mirrors StateWriter's
 *     suspended-session retention so a stale empty channel doesn't
 *     accumulate forever.
 *   - The migration registry is identity today; future schema rewrites
 *     append steps to `CHANNEL_STATE_REGISTRY` without touching this
 *     call site.
 *   - The on-disk file is `channels.json` (NOT `sessions.json`) —
 *     channels and sessions share the base directory but not the
 *     persistence file, so a channel-loss event cannot cascade into
 *     session failure.
 */
export class ChannelStateWriter {
  private filePath: string;
  private readonly emptyChannelTtlHours: number;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingState: ChannelState | null = null;
  private readonly queue = new AsyncQueue();
  private immediateEpoch = 0;
  private lastImmediateState: ChannelState | null = null;

  /**
   * Construct a `ChannelStateWriter` rooted at `baseDir`. The on-disk
   * file is `<baseDir>/channels.json` (NOT `sessions.json`) so a channel
   * loss event cannot cascade into session-state failure. Registers the
   * synchronous fallback used by `flushSync` to drain pending writes
   * from the per-channel queue during process exit.
   *
   * @param baseDir - Directory where `channels.json` lives.
   * @param emptyChannelTtlHours - Hours an empty channel can survive
   *   before the load-time reaper evicts it. Defaults to
   *   `CHANNEL_EMPTY_TTL_HOURS_DEFAULT` (7d).
   */
  constructor(
    baseDir: string,
    emptyChannelTtlHours: number = CHANNEL_EMPTY_TTL_HOURS_DEFAULT,
  ) {
    this.filePath = path.join(baseDir, 'channels.json');
    this.emptyChannelTtlHours = emptyChannelTtlHours;

    this.queue.setSyncFallback(QUEUE_KEY, () => {
      if (this.pendingState !== null) {
        atomicWriteJSONSync(this.filePath, this.pendingState, {
          validate: ChannelStateWriter.isChannelState,
          rotationEnabled: true,
        });
        this.pendingState = null;
      }
    });
  }

  /** Immediately write state to disk (channel create/destroy/post). */
  saveImmediate(state: ChannelState): void {
    this.immediateEpoch++;
    this.lastImmediateState = state;
    this.queue.clear();
    try {
      atomicWriteJSONSync(this.filePath, state, {
        validate: ChannelStateWriter.isChannelState,
        rotationEnabled: true,
      });
      this.pendingState = null;
    } catch (err) {
      console.error('[ChannelStateWriter] Failed to save state:', err);
    }
  }

  /** Debounced save — coalesces frequent updates over 30s. */
  saveDebounced(state: ChannelState): void {
    this.pendingState = state;

    if (this.debounceTimer !== null) {
      return;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const snapshot = this.pendingState;
      if (snapshot === null) return;

      void this.queue.enqueue(QUEUE_KEY, async () => {
        const payload = this.pendingState;
        if (payload === null) return;
        const epochAtStart = this.immediateEpoch;
        try {
          await atomicWriteJSON(this.filePath, payload, {
            validate: ChannelStateWriter.isChannelState,
            rotationEnabled: true,
          });
          // Race recovery: if saveImmediate bumped the epoch while we
          // were between awaits, restore the latest immediate payload
          // synchronously so disk matches the latest in-memory state.
          if (
            this.immediateEpoch !== epochAtStart &&
            this.lastImmediateState !== null
          ) {
            try {
              atomicWriteJSONSync(this.filePath, this.lastImmediateState, {
                validate: ChannelStateWriter.isChannelState,
                rotationEnabled: true,
              });
            } catch (err) {
              console.error(
                '[ChannelStateWriter] Failed to restore superseded immediate save:',
                err,
              );
            }
          }
          if (this.pendingState === payload) {
            this.pendingState = null;
          }
        } catch (err) {
          console.error(
            '[ChannelStateWriter] Failed to save state (async):',
            err,
          );
        }
      });
    }, DEBOUNCE_MS);
  }

  /**
   * Load state from disk and run the load-time reaper. Steps:
   *   1. Read `channels.json` through the migrator + validator. A
   *      parse failure or validator rejection falls through to `.bak`;
   *      a `.bak` failure falls through to `EMPTY_CHANNEL_STATE`.
   *   2. Reject prototype-chain keys (`__proto__`, `constructor`,
   *      `prototype`) on both channel ids and map keys — defense in
   *      depth on top of the JSON.parse reviver.
   *   3. Prune channels whose empty-period has exceeded
   *      `emptyChannelTtlHours`. The empty-period is `emptySince` if
   *      set, otherwise `createdAt` (the "lost emptySince" recovery
   *      case). Channels with members are never pruned here.
   *   4. Prune members / messages / idempotency entries whose channel
   *      did not survive. The pruned result is a null-prototype object
   *      built with own-key checks so a corrupt entry cannot pollute
   *      `Object.prototype`.
   *
   * @returns The loaded state, possibly empty.
   */
  load(): ChannelState {
    const migrator = createMigrator<ChannelState>(
      CHANNEL_STATE_REGISTRY,
      this.filePath,
    );

    let state: ChannelState | null = null;
    try {
      state = atomicReadJSONSync<ChannelState>(this.filePath, {
        validate: ChannelStateWriter.isChannelState,
        migrator,
      });
    } catch (err) {
      console.error('[ChannelStateWriter] Failed to load state:', err);
    }

    if (!state) {
      return { ...EMPTY_CHANNEL_STATE, channels: [], members: {}, messages: {}, idempotency: {} };
    }

    // Prune channels that have been empty longer than the TTL.
    // Prune rules (applied per channel):
    //   - Has members: keep (always).
    //   - 0 members AND emptySince set AND within TTL: keep.
    //   - 0 members AND emptySince set AND older than TTL: prune.
    //   - 0 members AND no emptySince AND `now - createdAt < TTL`: keep
    //     (the never-joined case AND the recently-orphaned case).
    //   - 0 members AND no emptySince AND `now - createdAt >= TTL`:
    //     prune. The fallback to `createdAt` catches a channel that had
    //     members, went empty, and lost its `emptySince` through a
    //     crash-between-leave-and-persist window — without the
    //     fallback, that channel would be immortal. The 7-day bound
    //     applies from creation in that case, which is conservative.
    // Archived channels with zero members follow the same rule.
    const now = Date.now();
    const cutoffMs = this.emptyChannelTtlHours * 60 * 60 * 1000;
    const survivingIds = new Set<string>();
    for (const ch of state.channels) {
      const memberCount = (state.members[ch.id] ?? []).length;
      if (memberCount > 0) {
        survivingIds.add(ch.id);
        continue;
      }
      const effectiveEmptyStart = ch.emptySince ?? ch.createdAt;
      if (now - effectiveEmptyStart < cutoffMs) {
        survivingIds.add(ch.id);
      }
      // else: prune.
    }
    state.channels = state.channels.filter((c) => survivingIds.has(c.id));
    state.members = pruneKeys(state.members, survivingIds);
    state.messages = pruneKeys(state.messages, survivingIds);
    state.idempotency = pruneKeys(state.idempotency, survivingIds);

    return state;
  }

  /** Flush pending debounce — if there is pending state, write it immediately. */
  flush(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pendingState !== null) {
      this.saveImmediate(this.pendingState);
    }
  }

  /**
   * Process-exit friendly drain. Mirrors StateWriter.flushSync order
   * (queue first, then inline fallback for staged-but-unenqueued
   * pending state).
   */
  flushSync(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.queue.flushSync();
    if (this.pendingState !== null) {
      const state = this.pendingState;
      this.pendingState = null;
      try {
        atomicWriteJSONSync(this.filePath, state, {
          validate: ChannelStateWriter.isChannelState,
          rotationEnabled: true,
        });
      } catch (err) {
        console.error(
          '[ChannelStateWriter] flushSync immediate write failed:',
          err,
        );
      }
    }
  }

  /**
   * Clean up timers (daemon shutdown). Flushes any pending debounced
   * state first so the on-disk file reflects the latest in-memory
   * snapshot before the writer is released. Mirrors `StateWriter.dispose`.
   */
  dispose(): void {
    this.flush();
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /**
   * Type guard. Mirrors the minimum-shape contract from StateWriter:
   * validate version + top-level containers (rejecting top-level arrays),
   * then spot-check one row per nested map. A malformed row fails the
   * whole validator, triggering `.bak` recovery. Full schema validation
   * lands when the schema stabilises.
   */
  private static isChannelState(parsed: unknown): parsed is ChannelState {
    if (typeof parsed !== 'object' || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;

    if (typeof obj['version'] !== 'number') return false;
    if (!Array.isArray(obj['channels'])) return false;
    if (!isRecordOfArrays(obj['members'])) return false;
    if (!isRecordOfArrays(obj['messages'])) return false;
    if (!isRecordOfRecords(obj['idempotency'])) return false;

    for (const ch of obj['channels'] as unknown[]) {
      if (typeof ch !== 'object' || ch === null) return false;
      const c = ch as Record<string, unknown>;
      if (typeof c['id'] !== 'string') return false;
      if (!isSafeObjectKey(c['id'])) return false;
      if (typeof c['companyId'] !== 'string') return false;
      if (typeof c['name'] !== 'string') return false;
      if (c['visibility'] !== 'public' && c['visibility'] !== 'private') {
        return false;
      }
      if (c['status'] !== 'active' && c['status'] !== 'archived') {
        return false;
      }
    }

    // Spot-check nested row shapes — one non-empty row per map. Catches
    // realistic corruption modes (e.g. someone hand-edited the JSON and
    // broke a row's shape) without paying for full schema validation on
    // every load.
    const memberLists = Object.values(
      obj['members'] as Record<string, unknown[]>,
    );
    for (const list of memberLists) {
      if (list.length === 0) continue;
      if (!isValidChannelMemberRow(list[0])) return false;
      break;
    }
    const messageLists = Object.values(
      obj['messages'] as Record<string, unknown[]>,
    );
    for (const list of messageLists) {
      if (list.length === 0) continue;
      if (!isValidChannelMessageRow(list[0])) return false;
      break;
    }
    // Reject members/messages/idempotency keys that name the prototype
    // chain. The JSON.parse guard upstream normally strips these, but we
    // double-check so a custom-parsed file (e.g. from a future migration
    // step) cannot smuggle `__proto__` past validation.
    for (const key of Object.keys(obj['members'] as Record<string, unknown>)) {
      if (!isSafeObjectKey(key)) return false;
    }
    for (const key of Object.keys(obj['messages'] as Record<string, unknown>)) {
      if (!isSafeObjectKey(key)) return false;
    }
    for (const key of Object.keys(
      obj['idempotency'] as Record<string, unknown>,
    )) {
      if (!isSafeObjectKey(key)) return false;
    }

    return true;
  }
}

/**
 * Type guard: `v` is a non-array object whose values are arrays. Rejects
 * arrays at the top level (since `typeof [] === 'object'`) so a corrupt
 * `channels.json` with `members: []` cannot slip past validation.
 */
function isRecordOfArrays(v: unknown): v is Record<string, unknown[]> {
  if (typeof v !== 'object' || v === null) return false;
  if (Array.isArray(v)) return false;
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (!Array.isArray(value)) return false;
  }
  return true;
}

/**
 * Type guard: `v` is a non-array object whose values are non-array objects
 * whose values are numbers. Used for the idempotency map (channelId →
 * clientMsgId → seq). Rejects arrays at any level.
 */
function isRecordOfRecords(
  v: unknown,
): v is Record<string, Record<string, number>> {
  if (typeof v !== 'object' || v === null) return false;
  if (Array.isArray(v)) return false;
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) return false;
    if (Array.isArray(value)) return false;
    for (const inner of Object.values(value as Record<string, unknown>)) {
      if (typeof inner !== 'number') return false;
    }
  }
  return true;
}

/**
 * Spot-check: does `row` have the minimum required shape of a
 * `ChannelMember`? Used as a sanity check on the members map during
 * load-time validation.
 */
function isValidChannelMemberRow(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const m = row as Record<string, unknown>;
  return (
    typeof m['workspaceId'] === 'string' &&
    typeof m['memberId'] === 'string' &&
    typeof m['joinedAt'] === 'number' &&
    typeof m['historyFromSeq'] === 'number'
  );
}

/**
 * Spot-check: does `row` have the minimum required shape of a
 * `ChannelMessage`? `data` and `clientMsgId` are optional and not checked
 * here. Used as a sanity check on the messages map during load-time
 * validation.
 */
function isValidChannelMessageRow(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const m = row as Record<string, unknown>;
  return (
    typeof m['channelId'] === 'string' &&
    typeof m['seq'] === 'number' &&
    typeof m['workspaceId'] === 'string' &&
    typeof m['memberId'] === 'string' &&
    typeof m['memberName'] === 'string' &&
    typeof m['text'] === 'string' &&
    typeof m['postedAt'] === 'number' &&
    (m['deliveryStatus'] === 'pending' ||
      m['deliveryStatus'] === 'delivered' ||
      m['deliveryStatus'] === 'target_gone')
  );
}

/**
 * Returns false for object keys that name the well-known JS prototype
 * chain — `__proto__`, `constructor`, `prototype`. Used to guard
 * `pruneKeys` and validator map lookups against a corrupt file that
 * could otherwise leak prototype references into the running process.
 */
function isSafeObjectKey(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s !== '__proto__' &&
    s !== 'constructor' &&
    s !== 'prototype'
  );
}

/**
 * Build a new record containing only the keys in `survivors`. Returns a
 * null-prototype object and reads with own-key checks, so a corrupt
 * `rec` with `__proto__` as a literal own property cannot pollute
 * `Object.prototype`.
 */
function pruneKeys<T>(
  rec: Record<string, T>,
  survivors: Set<string>,
): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const id of survivors) {
    if (
      Object.prototype.hasOwnProperty.call(rec, id) &&
      isSafeObjectKey(id)
    ) {
      out[id] = rec[id];
    }
  }
  return out;
}
