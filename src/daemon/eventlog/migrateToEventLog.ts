/**
 * migrateToEventLog — boot migration gate (pure logic) (envelope-design §6).
 *
 * PR2 scope: pure decision logic for detect→convert→validate→active + watermark verdict + reseed primitives.
 * Daemon wiring (index.ts insertion·service swap) is PR3/4 — here legacy state read·genesis validation·log
 * append are all **injected** with no service dependencies.
 *
 * Invariants (spec surface):
 *   - Conversion **READ-only** on legacy channels.json (§6.1-2). On failure manifest not written →
 *     next boot re-detects·retries (idempotent). **Zero data loss** (§6.1 failure rollback safe).
 *   - Order invariant (§6.1-2): genesis (durable) → machine-id (durable) → empty segment (+dir fsync)
 *     → validate → **manifest (durable) write = completion marker**. manifest references machineId so
 *     machine-id durable must precede.
 *   - genesis "immutable" contract (§6.2) takes effect after manifest active — pre-completion retry overwrite is not violation.
 *   - Downgrade detection via **watermark (lamport+stateHash)** (§6.4c). stateHash is canonical serialization hash
 *     excluding watermark field itself — old daemon load→save round-trip preserves lamport value so
 *     lamport alone cannot detect forward progress (old daemon cannot recalculate hash).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';

import {
  EMPTY_CHANNEL_STATE,
  type ChannelState,
} from '../../shared/channels';
import {
  makeEnvelope,
  type AuthContext,
  type EventOrigin,
  type EventEnvelopeDraft,
} from '../../shared/eventlog';
import {
  resolveMachineId,
  recoverMachineIdFromRecords,
} from '../../shared/machineId';
import {
  SnapshotStore,
  SNAPSHOT_DIRNAME,
  GENESIS_CHANNEL_REF,
  CHANNEL_PROJECTION_REF,
  reseedRef,
} from './SnapshotStore';
import {
  EVENTLOG_FORMAT_VERSION,
  readManifest,
  manifestFileExists,
  writeManifest,
  type EventLogManifest,
} from './EventLogManifest';

// Must match AppendOnlyLog (PR1) segment naming convention (boot scan recognizes this name).
const SEGMENT_RE = /^(\d{8})\.ndjson$/;

function segmentName(n: number): string {
  return `${String(n).padStart(8, '0')}.ndjson`;
}

// ── Watermark (§6.4c) ────────────────────────────────────────────────────

/** Watermark dual-write stamps into channels.json (§6.4c). Order-agnostic, downgrade detection only. */
export interface EventLogWatermark {
  /** Log hwm last reflected in this file. */
  lamport: number;
  /** Hash of state serialization excluding watermark field itself. */
  stateHash: string;
}

const WATERMARK_KEY = 'eventLogWatermark';

/**
 * Canonical serialization: recursively sort object keys (preserve array order). Hash depends on
 * **content only** regardless of key order from old daemon load→save round-trip.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(o).sort()) {
      out[key] = canonicalize(o[key]);
    }
    return out;
  }
  return value;
}

/** Copy of state with watermark field removed (for hash·reseed projection). */
function stripWatermark(state: unknown): unknown {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return state;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
    if (k === WATERMARK_KEY) continue;
    out[k] = v;
  }
  return out;
}

/** §6.4c: canonical serialization hash of state excluding watermark field itself. */
export function computeStateHash(state: unknown): string {
  const json = JSON.stringify(canonicalize(stripWatermark(state)));
  return crypto.createHash('sha256').update(json).digest('hex');
}

/**
 * Watermark stamp dual-write puts into channels.json (PR3 use, PR2 contract tests).
 * Returns new object — does not mutate input.
 */
export function stampWatermark<T extends object>(
  state: T,
  lamport: number,
): T & { eventLogWatermark: EventLogWatermark } {
  const stateHash = computeStateHash(state);
  return {
    ...state,
    eventLogWatermark: { lamport, stateHash },
  } as T & { eventLogWatermark: EventLogWatermark };
}

function extractWatermark(state: unknown): EventLogWatermark | null {
  if (state === null || typeof state !== 'object') return null;
  const wm = (state as Record<string, unknown>)[WATERMARK_KEY];
  if (wm === null || typeof wm !== 'object') return null;
  const w = wm as Record<string, unknown>;
  if (typeof w['lamport'] !== 'number' || typeof w['stateHash'] !== 'string') {
    return null;
  }
  return { lamport: w['lamport'], stateHash: w['stateHash'] };
}

/** Watermark boot verdict (§6.4c). */
export type WatermarkVerdict =
  | { kind: 'unchanged'; watermark: EventLogWatermark }
  | {
      kind: 'downgrade-write';
      reason: 'hash-mismatch' | 'absent';
      previous: EventLogWatermark | null;
    };

/**
 * §6.4c boot verdict: stateHash match → unchanged (normal restart, no reseed — zero false positives).
 * Mismatch or absent watermark (old daemon reverted before new format) → old-daemon write evidence → reseed.
 */
export function evaluateWatermark(state: unknown): WatermarkVerdict {
  const wm = extractWatermark(state);
  if (wm === null) {
    return { kind: 'downgrade-write', reason: 'absent', previous: null };
  }
  const actual = computeStateHash(state);
  if (actual === wm.stateHash) {
    return { kind: 'unchanged', watermark: wm };
  }
  return { kind: 'downgrade-write', reason: 'hash-mismatch', previous: wm };
}

// ── Detection (§6.1-1 three branches) ─────────────────────────────────────────────────

export type MigrationDetection =
  | { kind: 'active'; manifest: EventLogManifest }
  | { kind: 'migrate' } // (a) zero segments — first-boot or legacy migration
  | { kind: 'reconstruct-manifest' } // (b) empty segments + valid genesis — reconstruct only
  | { kind: 'quarantine-and-migrate'; segments: string[] }; // (c) other abnormal — quarantine then retry

export interface DetectOptions {
  eventsDir: string;
  /** genesis reload validation (§6.1-3). PR3: ChannelStateWriter.isChannelState. */
  validateProjection: (data: unknown) => boolean;
}

/**
 * When manifest exists → active (log mode). When absent §6.1-1 three branches:
 *   (a) zero segments → migrate
 *   (b) all segments empty + genesis validation success → reconstruct-manifest (no re-conversion)
 *   (c) otherwise (non-empty segment, or empty but genesis missing/corrupt) → quarantine then retry
 * fail-safe: do not silently proceed to log mode from inexplicable state (§6.1-1 (c) rationale).
 */
export function detectMigrationState(opts: DetectOptions): MigrationDetection {
  const manifest = readManifest(opts.eventsDir);
  if (manifest) return { kind: 'active', manifest };

  // corrupt ≠ absent (panel delta, Codex conf .94): manifest file exists but unreadable is
  // evidence of past log-mode active. Sending to three branches — especially (c) quarantine+re-migrate —
  // silently regresses log-only commits to stale legacy (quarantine preserves bytes only).
  // fail-closed: halt as manual recovery target (legacy·segments intact, next boot retry).
  if (manifestFileExists(opts.eventsDir)) {
    throw new MigrationError(
      'manifest corrupt (present but unreadable) — re-migration forbidden, manual recovery target under events/',
    );
  }

  const segFiles = listSegmentFiles(opts.eventsDir);
  if (segFiles.length === 0) {
    return { kind: 'migrate' };
  }
  const allEmpty = segFiles.every((f) =>
    isFileEmpty(path.join(opts.eventsDir, f)),
  );
  if (allEmpty && genesisValid(opts.eventsDir, opts.validateProjection)) {
    return { kind: 'reconstruct-manifest' };
  }
  return { kind: 'quarantine-and-migrate', segments: segFiles };
}

// ── Convert→validate→active (§6.1) ───────────────────────────────────────────────

export interface MigrateOptions {
  eventsDir: string;
  /** Legacy state read (PR3: () => channelStateWriter.load()). null = channels.json absent (first-boot). */
  readLegacyState: () => ChannelState | null;
  /** genesis reload validation (§6.1-3). PR3: ChannelStateWriter.isChannelState. */
  validateProjection: (data: unknown) => boolean;
  /**
   * A (3-model panel): after migration completion, hook to rewrite watermarked legacy state to channels.json.
   * **PR3 wiring contract: connect to ChannelStateWriter durable save.** Without this rewrite,
   * first boot before dual-write evaluateWatermark false-positives absent→downgrade
   * (pristine window). Even without hook (legacy callers), legacyStamped return conveys save obligation.
   * Hook failure does not undo completion (manifest already marker — warn only).
   */
  writeLegacyStamped?: (
    stamped: ChannelState & { eventLogWatermark: EventLogWatermark },
  ) => void;
  clock?: () => number;
}

export interface MigrateResult {
  detection: MigrationDetection['kind'];
  manifest: EventLogManifest;
  machineId: string;
  /** Segment paths quarantined in (c) branch (preserved, not deleted). */
  quarantined: string[];
  /**
   * A: watermarked legacy state (created on convert·reconstruct completion paths). Caller must
   * durable-save to channels.json to close pristine window (same value even if hook already ran).
   */
  legacyStamped?: ChannelState & { eventLogWatermark: EventLogWatermark };
}

/** Conversion failure = migration halt (legacy intact). manifest not written → next boot retries. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Boot migration gate (§6.1). Performs convert/reconstruct/quarantine+convert/no-op (active) per detection.
 * manifest durable write is completion marker so crash at any point before is idempotently absorbed on retry.
 */
export function runMigration(opts: MigrateOptions): MigrateResult {
  const detection = detectMigrationState({
    eventsDir: opts.eventsDir,
    validateProjection: opts.validateProjection,
  });

  if (detection.kind === 'active') {
    // §6.1-4 post-crash (manifest present, before first append) → no re-migration.
    return {
      detection: 'active',
      manifest: detection.manifest,
      machineId: detection.manifest.machineId,
      quarantined: [],
    };
  }
  if (detection.kind === 'reconstruct-manifest') {
    return reconstructManifest(opts);
  }
  if (detection.kind === 'quarantine-and-migrate') {
    const quarantined = quarantineSegments(opts.eventsDir, opts.clock ?? Date.now);
    // G② (§6.1-1(c)): quarantine is preservation not recovery — explicitly notify manual recovery target.
    console.warn(
      `[migrateToEventLog] committed segments quarantined — manual recovery target under events/quarantine/: ${quarantined.join(', ')}`,
    );
    return convertAndActivate(opts, quarantined);
  }
  // detection.kind === 'migrate'
  return convertAndActivate(opts, []);
}

/** (b) empty segments + valid genesis → complete by reconstructing manifest only, no re-conversion (§6.1-1 (b)). */
function reconstructManifest(opts: MigrateOptions): MigrateResult {
  const store = snapshotStoreFor(opts.eventsDir);
  const genesis = store.load<ChannelState>(
    GENESIS_CHANNEL_REF,
    opts.validateProjection,
    { preserveOnCorruption: true }, // G①: genesis must not move on read path either (§6.2)
  );
  if (!genesis) {
    // Extreme race after detection removed genesis — fail-safe re-convert.
    return convertAndActivate(opts, []);
  }
  const machineId = resolveMachineIdFor(opts.eventsDir); // reuse existing (§6.1-1 idempotent)
  const manifest: EventLogManifest = {
    formatVersion: EVENTLOG_FORMAT_VERSION,
    machineId,
    genesisRef: GENESIS_CHANNEL_REF,
    reseedRefs: [],
    snapshotLamport: genesis.snapshotLamport,
    activeSegment: highestSegmentNum(opts.eventsDir),
  };
  writeManifest(opts.eventsDir, manifest);
  // A: (b) is also completion path — close pristine window same way. No re-conversion so legacy read only
  // when hook present (READ for stamp purpose, separate axis from "no re-conversion" contract). Failure warn only
  // (manifest already completion marker — do not undo).
  let legacyStamped:
    | (ChannelState & { eventLogWatermark: EventLogWatermark })
    | undefined;
  if (opts.writeLegacyStamped) {
    try {
      const legacy = opts.readLegacyState() ?? EMPTY_CHANNEL_STATE;
      legacyStamped = stampWatermark(
        stripWatermark(legacy) as ChannelState,
        manifest.snapshotLamport,
      );
      opts.writeLegacyStamped(legacyStamped);
    } catch (err) {
      console.warn(
        '[migrateToEventLog] watermark stamp after reconstruct failed (completion holds, pristine window until first dual-write):',
        err,
      );
    }
  }
  return {
    detection: 'reconstruct-manifest',
    manifest,
    machineId,
    quarantined: [],
    legacyStamped,
  };
}

/** Steps 2~4: convert (genesis+machine-id+empty segment) → validate → active (manifest). */
function convertAndActivate(
  opts: MigrateOptions,
  quarantined: string[],
): MigrateResult {
  // Step 2 conversion — legacy READ only (legacy intact). Exceptions promoted to halt (manifest not written).
  let legacy: ChannelState | null;
  try {
    legacy = opts.readLegacyState();
  } catch (err) {
    throw new MigrationError(
      `legacy state read failed — migration halted (legacy intact): ${String(err)}`,
    );
  }
  const projection: ChannelState = legacy ?? EMPTY_CHANNEL_STATE;

  const store = snapshotStoreFor(opts.eventsDir);
  // 1. genesis durable write (snapshotLamport=0) — with projection content validation.
  store.writeDurableSync(
    GENESIS_CHANNEL_REF,
    projection,
    0,
    opts.validateProjection,
  );

  // 2. machine-id durable (reuse if exists) — **before manifest** (order invariant §6.1-2).
  const machineId = resolveMachineIdFor(opts.eventsDir);

  // 3. empty log segment + directory fsync (§6.1-2). On retry reuse existing segments (idempotent).
  const activeSegment = ensureEmptySegment(opts.eventsDir);

  // 4. Validate: reload genesis just written for round-trip (§6.1-3). failure=halt (legacy intact).
  const check = store.load<ChannelState>(
    GENESIS_CHANNEL_REF,
    opts.validateProjection,
    { preserveOnCorruption: true }, // G①: genesis must not move on read path (§6.2)
  );
  if (!check) {
    throw new MigrationError(
      'genesis reload validation failed — migration halted (manifest not written, legacy intact)',
    );
  }

  // 5. Active: manifest durable write = atomic "migration complete" marker (§6.1-4).
  const manifest: EventLogManifest = {
    formatVersion: EVENTLOG_FORMAT_VERSION,
    machineId,
    genesisRef: GENESIS_CHANNEL_REF,
    reseedRefs: [],
    snapshotLamport: 0,
    activeSegment,
  };
  writeManifest(opts.eventsDir, manifest);

  // 6. A (3-model panel): after completion stamp watermark on legacy (lamport 0 = genesis baseline) —
  // closes absent false-positive on boot before first dual-write (pristine window). Hook failure does not
  // undo completion (warn — next dual-write recovers stamp).
  const legacyStamped = stampWatermark(projection, 0);
  if (opts.writeLegacyStamped) {
    try {
      opts.writeLegacyStamped(legacyStamped);
    } catch (err) {
      console.warn(
        '[migrateToEventLog] watermark stamp after migration failed (completion holds, pristine window until first dual-write):',
        err,
      );
    }
  }

  return {
    detection: quarantined.length > 0 ? 'quarantine-and-migrate' : 'migrate',
    manifest,
    machineId,
    quarantined,
    legacyStamped,
  };
}

// ── reseed (§6.4c) ──────────────────────────────────────────────────────

export interface ReseedOptions {
  eventsDir: string;
  manifest: EventLogManifest;
  /** Current channels.json reflecting old-daemon write (may include watermark field). */
  downgradeState: ChannelState;
  /** Log append (PR3: AppendOnlyLog.append binding). Call first to issue marker lamport. */
  append: (draft: EventEnvelopeDraft) => Promise<boolean>;
  /** Read current lamport hwm (PR3: () => log.lamportHwm). Used for race assertion (D) and marker lamport. */
  lamportHwm: () => number;
  origin: Omit<EventOrigin, 'seq'>;
  authContext: AuthContext;
  validateProjection: (data: unknown) => boolean;
  /**
   * A (3-model panel): on reseed completion, hook to rewrite legacy stamped at markerLamport to channels.json
   * (PR3: ChannelStateWriter durable save). Without this stale watermark re-detects same hash-mismatch each boot
   * and reseed-{n} proliferates every boot.
   */
  writeLegacyStamped?: (
    stamped: ChannelState & { eventLogWatermark: EventLogWatermark },
  ) => void;
  /** Active projection snapshot ref to rewrite (§6.4c ③). Default channel.json. */
  activeProjectionRef?: string;
  clock?: () => number;
}

export interface ReseedResult {
  /** Completion (marker+snapshot+manifest all). false → zero snapshot·manifest side effects — next boot retry. */
  ok: boolean;
  /** ok=false reason. append-failed = marker uncommitted / lamport-race = boot-only premise violated (D). */
  failReason?: 'append-failed' | 'lamport-race';
  reseedRef: string;
  markerLamport: number;
  stateHash: string;
  manifest: EventLogManifest;
  /** A: legacy stamped at markerLamport — caller must save to close reseed re-detection loop. */
  legacyStamped?: ChannelState & { eventLogWatermark: EventLogWatermark };
}

/**
 * Downgrade re-seed (§6.4c). reseed **snapshot** carries state and log keeps **marker** only
 * (summary delta alone cannot recover old-daemon span when latest snapshot corrupt).
 *
 * Order (contract): marker lamport becomes snapshot snapshotLamport so **append marker first** to fix lamport,
 * then write reseed·active snapshot, **atomic complete via manifest write** (same shape as §6.1-4). Spec §6.4c
 * listed order (snapshot①/marker②) corrected to marker-first to satisfy lamport dependency.
 *
 * Premise (enforced in code — D): **boot-only execution**. Concurrent append makes hwm not marker lamport so
 * reseed snapshotLamport skips events after marker (replay loss) → halt on before+1 assertion violation
 * (failReason='lamport-race', snapshot·manifest not written — next boot retry).
 */
export async function performReseed(opts: ReseedOptions): Promise<ReseedResult> {
  const clock = opts.clock ?? Date.now;
  const store = snapshotStoreFor(opts.eventsDir);
  const activeRef = opts.activeProjectionRef ?? CHANNEL_PROJECTION_REF;

  // reseed projection = old-daemon write with watermark field removed (pure domain state).
  const cleanState = stripWatermark(opts.downgradeState) as ChannelState;
  const stateHash = computeStateHash(opts.downgradeState);

  const n = opts.manifest.reseedRefs.length + 1;
  const ref = reseedRef(n);
  const failResult = (
    failReason: 'append-failed' | 'lamport-race',
  ): ReseedResult => ({
    ok: false,
    failReason,
    reseedRef: ref,
    markerLamport: 0,
    stateHash,
    manifest: opts.manifest,
  });

  // Marker append first → fix lamport. Marker payload leaves auditable detection fact.
  const marker: EventEnvelopeDraft = makeEnvelope({
    domain: 'channel',
    payload: {
      kind: 'legacy-reseed',
      reseedNumber: n,
      stateHash,
      detectedAt: clock(),
    },
    origin: opts.origin,
    authContext: opts.authContext,
  });
  const before = opts.lamportHwm(); // D: race assertion baseline
  const appended = await opts.append(marker);
  if (!appended) {
    // Marker commit failure → canonical lacks detection fact = silent discard violation → halt reseed (retry target).
    return failResult('append-failed');
  }
  const markerLamport = opts.lamportHwm();
  if (markerLamport !== before + 1) {
    // D: boot-only premise violated (concurrent append) — guarantee that hwm is marker lamport broken.
    // Proceeding would make snapshotLamport skip events after marker (replay loss) → halt.
    console.warn(
      `[migrateToEventLog] reseed lamport race detected (before=${before}, after=${markerLamport}) — halted, retry next boot`,
    );
    return failResult('lamport-race');
  }

  // reseed snapshot (genesis-grade immutable) + active projection rewrite — both snapshotLamport=markerLamport.
  store.writeDurableSync(ref, cleanState, markerLamport, opts.validateProjection);
  store.writeDurableSync(
    activeRef,
    cleanState,
    markerLamport,
    opts.validateProjection,
  );

  // manifest update (durable) = completion marker. reseedRefs extend + snapshotLamport advance → replay applies only
  // lamport > markerLamport (no double-apply with pre-reseed events, §6.4c).
  const manifest: EventLogManifest = {
    ...opts.manifest,
    reseedRefs: [...opts.manifest.reseedRefs, ref],
    snapshotLamport: markerLamport,
  };
  writeManifest(opts.eventsDir, manifest);

  // A: refresh stale watermark — re-stamp at markerLamport and rewrite. Failure warn only (completion holds;
  // if not refreshed next boot reseeds once more then retries — observable residue distinct from infinite proliferation).
  const legacyStamped = stampWatermark(cleanState, markerLamport);
  if (opts.writeLegacyStamped) {
    try {
      opts.writeLegacyStamped(legacyStamped);
    } catch (err) {
      console.warn(
        '[migrateToEventLog] watermark re-stamp after reseed failed (completion holds, one re-detection residue next boot):',
        err,
      );
    }
  }

  return {
    ok: true,
    reseedRef: ref,
    markerLamport,
    stateHash,
    manifest,
    legacyStamped,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function snapshotStoreFor(eventsDir: string): SnapshotStore {
  return new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
}

function genesisValid(
  eventsDir: string,
  validateProjection: (d: unknown) => boolean,
): boolean {
  // G①: detection-stage genesis check also must not move on read path (§6.2 immutable contract).
  return (
    snapshotStoreFor(eventsDir).load(GENESIS_CHANNEL_REF, validateProjection, {
      preserveOnCorruption: true,
    }) !== null
  );
}

function resolveMachineIdFor(eventsDir: string): string {
  return resolveMachineId(eventsDir, {
    recoverFromRecords: () =>
      recoverMachineIdFromRecords(scanSegmentRecords(eventsDir)),
  });
}

/** §8 partial loss recovery: scrape records carrying machineId from surviving segments. */
function scanSegmentRecords(
  eventsDir: string,
): Array<{ origin?: { machineId?: unknown } }> {
  const out: Array<{ origin?: { machineId?: unknown } }> = [];
  for (const f of listSegmentFiles(eventsDir)) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(eventsDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as { origin?: { machineId?: unknown } });
      } catch {
        break; // stop at first bad (forward scan convention)
      }
    }
  }
  return out;
}

function listSegmentFiles(eventsDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(eventsDir);
  } catch {
    return [];
  }
  return entries.filter((n) => SEGMENT_RE.test(n)).sort();
}

function isFileEmpty(p: string): boolean {
  try {
    return fs.statSync(p).size === 0;
  } catch {
    return true;
  }
}

function highestSegmentNum(eventsDir: string): number {
  const files = listSegmentFiles(eventsDir);
  if (files.length === 0) return 1;
  return Math.max(...files.map((f) => Number(SEGMENT_RE.exec(f)![1])));
}

/**
 * Ensure empty segment exists (§6.1-2). Create 00000001 if none. Reuse existing segments **only when all empty**
 * (B③ defense-in-depth): adopting non-empty segment as active applies foreign events
 * (lamport>0) on top of genesis replay — (c) path quarantineSegments residual-0 check pre-blocks but
 * any abnormal reaching this point must halt.
 */
function ensureEmptySegment(eventsDir: string): number {
  fs.mkdirSync(eventsDir, { recursive: true });
  const files = listSegmentFiles(eventsDir);
  if (files.length > 0) {
    for (const f of files) {
      if (!isFileEmpty(path.join(eventsDir, f))) {
        throw new MigrationError(
          `non-empty segment (${f}) cannot be adopted as active — migration halted (legacy intact)`,
        );
      }
    }
    return highestSegmentNum(eventsDir);
  }
  const seg = path.join(eventsDir, segmentName(1));
  const fd = fs.openSync(seg, 'a'); // create + append open
  fs.closeSync(fd);
  fsyncDir(eventsDir); // directory entry durability (§6.1-2)
  return 1;
}

/**
 * (c) branch: **quarantine (preserve, not delete)** abnormal segments to events/quarantine/. Avoid name collision via
 * clock suffix. Follows §2.1 layout quarantine/ coordinate (distinct from read-time corrupted/ purpose).
 *
 * B (3-model panel): quarantine failure is **halt** (no best-effort) — swallowing failure and proceeding re-convert
 * adopts un-quarantined non-empty segment as active and applies foreign events on genesis replay
 * (validate step only reloads genesis and cannot catch). On halt legacy·segments intact,
 * manifest not written → next boot retry.
 */
function quarantineSegments(eventsDir: string, clock: () => number): string[] {
  const qdir = path.join(eventsDir, 'quarantine');
  try {
    fs.mkdirSync(qdir, { recursive: true });
  } catch (err) {
    throw new MigrationError(
      `quarantine directory creation failed — migration halted (legacy intact): ${String(err)}`,
    );
  }
  const moved: string[] = [];
  const ts = clock();
  for (const f of listSegmentFiles(eventsDir)) {
    const dest = path.join(qdir, `${f}.${ts}.bak`);
    try {
      fs.renameSync(path.join(eventsDir, f), dest);
    } catch (err) {
      throw new MigrationError(
        `segment quarantine failed (${f}) — migration halted (legacy·segment intact): ${String(err)}`,
      );
    }
    moved.push(dest);
  }
  fsyncDir(eventsDir);
  // B②: post-quarantine residual-0 check — residual breaks re-convert empty-segment premise.
  const residual = listSegmentFiles(eventsDir);
  if (residual.length > 0) {
    throw new MigrationError(
      `segments remain after quarantine (${residual.join(', ')}) — migration halted (legacy intact)`,
    );
  }
  return moved;
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return; // §2.3 win32 remainder
  let fd = -1;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // best-effort — filesystems without directory fsync are §2.3 accepted residue
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* noop */
      }
    }
  }
}
