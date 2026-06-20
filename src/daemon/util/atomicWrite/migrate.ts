/**
 * T7 — Lazy migration framework.
 *
 * This module plugs into `atomicReadJSON`'s `opts.migrator` hook. The
 * design is deliberately narrow:
 *
 *   - A `MigrationRegistry` is per-schema (e.g. sessionData,
 *     daemonState). It names the schema's current on-disk version and
 *     an ordered list of `MigrationStep`s that move payloads between
 *     consecutive versions.
 *   - On load we detect `data.version`, diff against
 *     `registry.currentVersion`, and walk the step chain in order.
 *     Any step that throws aborts the chain; the caller decides how
 *     to react (return original, fall through to `.bak`, or hand off
 *     to T6 quarantine).
 *   - Right before the first step runs we drop a one-time
 *     `{targetPath}.v{fromVersion}.premigrate.bak` snapshot so
 *     operators can recover the pre-migration payload out-of-band.
 *     The snapshot is write-once: if it exists we leave it alone.
 *
 * This is explicitly NOT a registry of every schema change in the
 * project. Registries live with the code that owns the schema; this
 * module just provides the engine.
 *
 * Scope guard: Node stdlib only, no Electron, no daemon-specific
 * state. Mirrors `core.ts`.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ── Public types ─────────────────────────────────────────────────────

/**
 * A single migration step. Pure function. Idempotency is NOT required —
 * the engine guarantees each step runs at most once per load cycle.
 */
export interface MigrationStep<In = unknown, Out = unknown> {
  fromVersion: number;
  toVersion: number;
  migrate: (input: In) => Out;
}

/**
 * Ordered list of steps forming a migration path. Registries are
 * per-schema (e.g. sessionData, daemonState).
 */
export interface MigrationRegistry {
  currentVersion: number;
  steps: MigrationStep[];
}

// ── Internal helpers ─────────────────────────────────────────────────

function premigratePathFor(targetPath: string, fromVersion: number): string {
  return `${targetPath}.v${fromVersion}.premigrate.bak`;
}

function ensureDirSync(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
}

function serialise(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ── Core engine ──────────────────────────────────────────────────────

/**
 * Apply migration steps in order from `fromVersion` up to
 * `registry.currentVersion`.
 *
 * Guarantees:
 *   - Steps execute in the order they appear in `registry.steps`.
 *   - A step is only considered if `step.fromVersion === <cursor>`;
 *     this means the chain cannot silently skip a version. If no
 *     step advances from the current cursor we throw rather than
 *     return a half-migrated payload.
 *   - If `fromVersion >= registry.currentVersion` the input is
 *     returned unchanged with the input version — this is the
 *     no-op/already-up-to-date path.
 *   - Identity-registry short-circuit: when the registry has no
 *     registered steps AND `fromVersion === 0` AND
 *     `registry.currentVersion === 1` we treat this as an identity
 *     no-op and return the payload with `version: currentVersion`.
 *     This covers legacy on-disk payloads that predate the version
 *     marker (SessionData shipped without a `version` field before
 *     this release). Without this branch the call would throw at
 *     step lookup because no v0→v1 step exists.
 *   - On any step throw we rethrow with context so the caller can
 *     attribute the failure.
 */
export function applyMigrations<T>(
  data: unknown,
  fromVersion: number,
  registry: MigrationRegistry,
): { data: T; version: number } {
  if (fromVersion >= registry.currentVersion) {
    return { data: data as T, version: fromVersion };
  }

  // Identity-registry short-circuit. An empty `steps` array combined
  // with `currentVersion === 1` means the schema has never had a
  // real migration attached — the registry is effectively identity.
  // Legacy payloads that arrive here carry `fromVersion === 0` (no
  // on-disk version marker); treating them as already-current keeps
  // the load path working for upgraders without forcing the caller
  // to special-case missing version fields upstream.
  if (
    registry.steps.length === 0 &&
    registry.currentVersion === 1 &&
    fromVersion === 0
  ) {
    return { data: data as T, version: registry.currentVersion };
  }

  let cursor = fromVersion;
  let current: unknown = data;

  // Each iteration must advance `cursor` by exactly one registered
  // step. We walk `registry.steps` in order and pick the first step
  // whose fromVersion matches the cursor. Missing links throw.
  while (cursor < registry.currentVersion) {
    const step = registry.steps.find((s) => s.fromVersion === cursor);
    if (!step) {
      throw new Error(
        `applyMigrations: no migration step registered from v${cursor} ` +
          `(target v${registry.currentVersion}). Chain broken.`,
      );
    }
    if (step.toVersion !== cursor + 1) {
      // The engine enforces strict +1 hops so we can reason about
      // ordering and so premigrate snapshots stay meaningful.
      throw new Error(
        `applyMigrations: step from v${step.fromVersion} must target ` +
          `v${cursor + 1}, got v${step.toVersion}.`,
      );
    }

    try {
      current = step.migrate(current);
    } catch (err) {
      throw new Error(
        `applyMigrations: step v${step.fromVersion}->v${step.toVersion} ` +
          `failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    cursor = step.toVersion;
  }

  return { data: current as T, version: cursor };
}

// ── Premigrate snapshot ──────────────────────────────────────────────

/**
 * Take a one-time premigrate snapshot at
 * `${targetPath}.v${fromVersion}.premigrate.bak`.
 *
 * Write-once semantics: if the snapshot already exists we do nothing.
 * This keeps the snapshot pinned to the first time we ever attempted
 * to migrate away from `fromVersion`, which is what operators want
 * for recovery. It also means repeated restarts don't keep rewriting
 * the snapshot with post-migration payloads.
 *
 * We intentionally use `fs.writeFile` directly rather than reusing
 * `atomicWriteJSON`: that path runs its own migrator/validator hooks,
 * which would be nonsensical (or recursive) for the snapshot itself.
 * The snapshot is a one-shot diagnostic artifact, not a managed
 * rotation target, so a plain write is enough.
 */
export async function writePremigrateSnapshot(
  targetPath: string,
  data: unknown,
  fromVersion: number,
): Promise<void> {
  const snapshotPath = premigratePathFor(targetPath, fromVersion);

  // Skip if already written — snapshot is pinned to the first attempt.
  try {
    await fsp.access(snapshotPath, fs.constants.F_OK);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Unexpected stat error — surface it so we don't mask disk
      // problems behind a silent "already exists" path.
      throw err;
    }
  }

  await ensureDir(snapshotPath);
  await fsp.writeFile(snapshotPath, serialise(data), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/** Sync counterpart for emergency save paths. */
export function writePremigrateSnapshotSync(
  targetPath: string,
  data: unknown,
  fromVersion: number,
): void {
  const snapshotPath = premigratePathFor(targetPath, fromVersion);

  if (fs.existsSync(snapshotPath)) return;

  ensureDirSync(snapshotPath);
  fs.writeFileSync(snapshotPath, serialise(data), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

// ── Migrator factory ─────────────────────────────────────────────────

/**
 * Convenience builder. Returns a function matching the
 * `AtomicReadOptions.migrator` signature so callers can pass it
 * straight through:
 *
 *   atomicReadJSON(file, {
 *     migrator: createMigrator(MY_REGISTRY, file),
 *   });
 *
 * Behaviour:
 *   - If `fromVersion >= registry.currentVersion`: return data as-is,
 *     no snapshot (the payload is already current — nothing to
 *     preserve).
 *   - Otherwise: write the premigrate snapshot (best-effort; failure
 *     to snapshot is logged via thrown error, not swallowed, because
 *     losing the pre-migration state silently would defeat the
 *     point), then apply the chain.
 *
 * The returned function is synchronous because `AtomicReadOptions`
 * expects a sync hook. The snapshot is written synchronously here;
 * async callers can wire in `writePremigrateSnapshot` by hand if
 * they need non-blocking I/O.
 */
export function createMigrator<T>(
  registry: MigrationRegistry,
  snapshotPath: string,
): (data: unknown, fromVersion: number) => { data: T; version: number } {
  return (data: unknown, fromVersion: number) => {
    if (fromVersion >= registry.currentVersion) {
      // Already current — no snapshot, no-op migration.
      return { data: data as T, version: fromVersion };
    }

    // Identity-registry short-circuit (mirrors `applyMigrations`):
    // legacy payloads without a version marker reach the migrator as
    // `fromVersion = 0`. If the registry ships as identity
    // (`currentVersion = 1`, no steps) there is nothing to
    // preserve or apply — skip the premigrate snapshot and return the
    // payload untouched with its notional upgraded version. This is
    // the safe wiring that lets production load paths opt into the
    // migrator hook without the snapshot-every-legacy-load side
    // effect.
    if (
      registry.steps.length === 0 &&
      registry.currentVersion === 1 &&
      fromVersion === 0
    ) {
      return { data: data as T, version: registry.currentVersion };
    }

    writePremigrateSnapshotSync(snapshotPath, data, fromVersion);
    return applyMigrations<T>(data, fromVersion, registry);
  };
}

// ── Production registries (identity — intentionally empty) ───────────

/**
 * Session data schema. Current on-disk shape is v1. No migrations
 * are registered because T7's release scope is the engine itself —
 * actual schema rewrites land in follow-up work that appends steps
 * here.
 */
export const SESSION_DATA_REGISTRY: MigrationRegistry = {
  currentVersion: 1,
  steps: [],
};

/**
 * Daemon state schema. Same posture as SESSION_DATA_REGISTRY: the
 * engine is live, but no steps are registered in this release.
 */
export const DAEMON_STATE_REGISTRY: MigrationRegistry = {
  currentVersion: 1,
  steps: [],
};

/**
 * Channel state schema (channels.json). Identity registry — no
 * migrations registered yet. The Channels subsystem (see
 * `src/shared/channels.ts` and `src/daemon/channels/`) registers
 * this registry with the migrator factory in the same way that
 * StateWriter registers `DAEMON_STATE_REGISTRY`: pass-through with
 * the identity-registry short-circuit for legacy v0 payloads
 * missing the version marker.
 */
export const CHANNEL_STATE_REGISTRY: MigrationRegistry = {
  currentVersion: 1,
  steps: [],
};
