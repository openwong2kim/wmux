/**
 * EventLogManifest — event log manifest read/write (envelope-design §2.1·§6.1).
 *
 * Contract summary (spec wording):
 *   - manifest is **durable-only**(§2.3 D13). write sits only on core.ts durable option —
 *     non-fsync rename is non-durable on power loss, reboot re-detects legacy and re-migrates,
 *     orphaning migration-committed events committed via fsync in between (panel A1).
 *   - manifest write = atomic marker of "migration complete"(§6.1-4). boot uses manifest as
 *     **hint** only; segment scan is canonical (D15) — double defense.
 *   - additive-only: field additions only (optional). No remove/rename/semantic change (disk contract).
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJSONSync, atomicReadJSONSync } from '../util/atomicWrite';

/** Current manifest format generation. Bump only on schema migration (invariant per boot). */
export const EVENTLOG_FORMAT_VERSION = 1;

/**
 * additive `eventLogFormatVersion` field on daemon.ping (§6.4a). When log is durably active
 * (active = active manifest.formatVersion), include field; when inactive (active=undefined —
 * legacy fallback / migration incomplete, channelEventLogDeps null path), omit field.
 * **Field absence = pre-envelope daemon = legacy generation**: input to B′(#342) auto-replace
 * logic "on unknown formatVersion daemon, do not reuse/replace — fail-closed"
 * (B′ decision logic itself is outside PR5 — PR5 scope is exposing the value via ping).
 */
export function pingFormatVersionField(
  active: number | undefined,
): { eventLogFormatVersion?: number } {
  return active !== undefined ? { eventLogFormatVersion: active } : {};
}

const MANIFEST_FILE = 'manifest.json';

/**
 * Event log manifest (§2.1). Boot hint and migration-complete marker.
 *
 * additive-only convention: future fields added as optional only (avoid breaking old manifest parse).
 */
export interface EventLogManifest {
  /** Format generation (§6.4a: value daemon.ping exposes additively). */
  formatVersion: number;
  /** §8: install-lifetime immutable machineId. machine-id durable must precede manifest referencing it. */
  machineId: string;
  /** §6.2 D14: genesis snapshot ref name (relative to snapshot/). Permanently immutable. */
  genesisRef: string;
  /** §6.4c: reseed snapshot ref names (genesis-grade immutable). additive expand on downgrade detect. */
  reseedRefs: string[];
  /** §5: baseline lamport of active projection snapshot. boot replay applies only above this value. */
  snapshotLamport: number;
  /** §2.8·§3: active segment number. **Hint only** — if wrong vs reality, rewrite from scan (D15). */
  activeSegment: number;
}

/** Path to `events/manifest.json`. */
export function manifestPath(eventsDir: string): string {
  return path.join(eventsDir, MANIFEST_FILE);
}

/**
 * manifest structure guard. Checks required field presence/types only; **does not reject extra fields**
 * (additive-only — old code must silently pass fields written by future generations).
 */
export function isEventLogManifest(v: unknown): v is EventLogManifest {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o['formatVersion'] !== 'number') return false;
  if (typeof o['machineId'] !== 'string' || o['machineId'].length === 0) {
    return false;
  }
  if (typeof o['genesisRef'] !== 'string' || o['genesisRef'].length === 0) {
    return false;
  }
  if (!Array.isArray(o['reseedRefs'])) return false;
  for (const r of o['reseedRefs']) {
    if (typeof r !== 'string') return false;
  }
  if (typeof o['snapshotLamport'] !== 'number') return false;
  if (typeof o['activeSegment'] !== 'number') return false;
  return true;
}

/**
 * Load manifest (primary→.bak fallback built into atomicReadJSONSync). null on absence/corruption.
 * Does **not move** files on corruption (quarantineOnCorruption:false) — manifest is the
 * log-mode-active completion marker; read-time quarantine would make next boot misclassify as
 * "absent" and re-migrate (log-only commit regression). Distinguish absence vs corruption via
 * manifestFileExists (panel delta).
 */
export function readManifest(eventsDir: string): EventLogManifest | null {
  return atomicReadJSONSync<EventLogManifest>(manifestPath(eventsDir), {
    validate: isEventLogManifest,
    quarantineOnCorruption: false,
  });
}

/**
 * Whether manifest file exists (primary or .bak) — regardless of parse success. Physical proof
 * to distinguish "exists but unreadable"(corrupt) from "absent": corrupt manifest is evidence
 * of past log-mode active, so not re-migration target but fail-closed / manual recovery.
 */
export function manifestFileExists(eventsDir: string): boolean {
  const p = manifestPath(eventsDir);
  return fs.existsSync(p) || fs.existsSync(`${p}.bak`);
}

/**
 * manifest durable write (§2.3·§6.1-4). tmp write→tmp fsync→rename→dir fsync.
 * validate re-checks structure so broken manifest cannot remain as completion marker.
 */
export function writeManifest(
  eventsDir: string,
  manifest: EventLogManifest,
): void {
  atomicWriteJSONSync(manifestPath(eventsDir), manifest, {
    durable: true,
    validate: isEventLogManifest,
  });
}
