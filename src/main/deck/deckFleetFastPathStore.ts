// ─── Command Deck — `deck.fleetFastPath` switch (local Fleet answers) ────────
//
// When ON, a short read-only Fleet question typed in the desktop Moa composer
// ("who needs me?", "작업 상태") is answered from the local Fleet board
// instead of starting a Moa turn (see fleetFastPath.ts). Default OFF until the
// owner decides otherwise. Same storage shape, mtime cache and never-throw
// posture as deck-ledger-gate.json.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';

export const DEFAULT_FLEET_FAST_PATH_ENABLED = false;

let testOverride: boolean | null = null;

/** Tests only: force the switch without touching the data dir (null = read the file). */
export function overrideFleetFastPathForTests(value: boolean | null): void {
  testOverride = value;
}

export function getDeckFleetFastPathPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-fleet-fast-path.json');
}

/** path → { mtimeMs, value }: re-parsed only when the file's mtime moves. */
const cache = new Map<string, { mtimeMs: number; value: boolean }>();

function parseFlag(p: string): boolean {
  const raw = atomicReadJSONSync<unknown>(p);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_FLEET_FAST_PATH_ENABLED;
  const enabled = (raw as Record<string, unknown>).enabled;
  return typeof enabled === 'boolean' ? enabled : DEFAULT_FLEET_FAST_PATH_ENABLED;
}

/** Read the switch. Anything uncertain resolves to the default (OFF). Runs
 *  on every desktop Moa send, so it is a stat until the file changes. */
export function loadFleetFastPathEnabled(dir?: string): boolean {
  if (testOverride !== null) return testOverride;
  const p = getDeckFleetFastPathPath(dir);
  try {
    const mtimeMs = fs.statSync(p).mtimeMs;
    const hit = cache.get(p);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    const value = parseFlag(p);
    cache.set(p, { mtimeMs, value });
    return value;
  } catch {
    cache.delete(p);
    return DEFAULT_FLEET_FAST_PATH_ENABLED;
  }
}

/** Persist the switch. Returns the value now in force. */
export async function setFleetFastPathEnabled(enabled: boolean, dir?: string): Promise<boolean> {
  const next = enabled === true;
  const p = getDeckFleetFastPathPath(dir);
  await atomicWriteJSON(p, { enabled: next });
  // Seed the cache with the value just written: two toggles inside one mtime
  // tick (15 ms on Windows) would otherwise serve the first value.
  try {
    cache.set(p, { mtimeMs: fs.statSync(p).mtimeMs, value: next });
  } catch {
    cache.delete(p);
  }
  return next;
}
