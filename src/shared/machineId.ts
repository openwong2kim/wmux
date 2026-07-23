/**
 * origin.machineId — mint·load·record-recovery pure logic (envelope-design §8).
 *
 * Lifetime·substrate contract (§8, panel C8):
 *   - machineId is **permanently immutable** for install lifetime. Not replaced even in Q4
 *     (lineage continuity). Pairing identity layers via separate origin.keyId (additive).
 *   - Substrate is `events/machine-id`, **same fate as the log**. If the log is lost, this
 *     file is lost too → remint → new origin lineage → `(machineId, seq)` reuse is structurally
 *     impossible. Placing it outside the log (e.g. ~/.wmux/machine-id) leaves old machineId
 *     alive when only the log is lost, allowing lost seq values to be reused (global uniqueness
 *     collapse).
 *   - Partial-loss recovery: if machine-id file is missing but segments survive, recover the
 *     value from any record's origin.machineId and rewrite (no remint — segments are evidence).
 *
 * Shared-layer file — no dependency on daemon/util. machine-id is a raw UUID string, not JSON,
 * so §2.3 durable sequence (tmp write→tmp fsync→rename→dir fsync) is implemented here
 * (same contract as atomicWrite core.ts JSON durable path).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const MACHINE_ID_FILE = 'machine-id';

/** §8: mint new install identity. */
export function mintMachineId(): string {
  return randomUUID();
}

/** Path to `events/machine-id`. */
export function machineIdPath(eventsDir: string): string {
  return path.join(eventsDir, MACHINE_ID_FILE);
}

/** Load from file. null if missing/blank. */
export function readMachineId(eventsDir: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(machineIdPath(eventsDir), 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Durable write (§2.3): tmp write → tmp fsync → rename → parent dir fsync.
 * win32 lacks directory fsync — skip step 4 (§2.3 win32 residual).
 */
export function writeMachineId(eventsDir: string, id: string): void {
  fs.mkdirSync(eventsDir, { recursive: true });
  const target = machineIdPath(eventsDir);
  const tmp = `${target}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, id);
    fs.fsyncSync(fd); // durabilize content before rename (§2.3-2)
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  fsyncDir(eventsDir); // durabilize rename (directory entry) (§2.3-4)
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return; // §2.3 win32 residual
  let dirFd = -1;
  try {
    dirFd = fs.openSync(dir, 'r');
    fs.fsyncSync(dirFd);
  } catch {
    // best-effort — filesystems without directory fsync are §2.3 accepted residual
  } finally {
    if (dirFd >= 0) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* noop */
      }
    }
  }
}

/** Recover machineId from record array (§8 no-remint basis). Returns first valid value. */
export function recoverMachineIdFromRecords(
  records: ReadonlyArray<{ origin?: { machineId?: unknown } }>,
): string | undefined {
  for (const rec of records) {
    const mid = rec.origin?.machineId;
    if (typeof mid === 'string' && mid.length > 0) return mid;
  }
  return undefined;
}

export interface ResolveMachineIdOptions {
  /**
   * Hook to recover machineId from surviving segment records when file is missing (§8).
   * If a value is returned, remint is skipped and that value is rewritten.
   */
  recoverFromRecords?: () => string | undefined;
}

/**
 * Resolve machineId: load → (if missing) record recovery → (if still missing) mint (§8).
 * Either way, durably write the result so the next boot reuses it.
 */
export function resolveMachineId(
  eventsDir: string,
  opts: ResolveMachineIdOptions = {},
): string {
  const existing = readMachineId(eventsDir);
  if (existing) return existing;

  const recovered = opts.recoverFromRecords?.();
  if (recovered) {
    // Segments are evidence — no remint, rewrite recovered value (§8 partial-loss recovery).
    writeMachineId(eventsDir, recovered);
    return recovered;
  }

  const minted = mintMachineId();
  writeMachineId(eventsDir, minted);
  return minted;
}
