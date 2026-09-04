// ─── Command Deck — `deck.ledgerGate` switch (Stop gate on the task ledger) ──
//
// When ON, the orchestrator's Stop gate holds a turn open while the task
// ledger still lists OPEN tasks (working / input_required / review_requested)
// owned by that brain — the ledger is the one state the brain, the workers and
// the gate share, so a "delegated, done" turn cannot end while a worker's row
// says otherwise. Default OFF (owner decision, orchestrator track 2026-09):
// the snapshot-inferred gate (stopGate.ts) stays the shipped behaviour until
// the ledger has run in dogfood. Same storage shape and never-throw posture as
// deck-autowake.json.
//
// EXPERIMENTAL / JSON-ONLY: nothing in the app calls `setLedgerGateEnabled`
// yet — there is no Settings toggle. Flip the flag by writing
// `{"enabled": true}` to deck-ledger-gate.json in the wmux data dir. The
// loader caches by file mtime, so the read that runs on every Stop and every
// deck_ask_decision is a stat, not a parse, until the file changes.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';

export const DEFAULT_LEDGER_GATE_ENABLED = false;

let testOverride: boolean | null = null;

/** Tests only: force the switch without touching the data dir (null = off). */
export function overrideLedgerGateForTests(value: boolean | null): void {
  testOverride = value;
}

export function getDeckLedgerGatePath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-ledger-gate.json');
}

/** path → { mtimeMs, value }: re-parsed only when the file's mtime moves. */
const cache = new Map<string, { mtimeMs: number; value: boolean }>();

function parseFlag(p: string): boolean {
  const raw = atomicReadJSONSync<unknown>(p);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_LEDGER_GATE_ENABLED;
  const enabled = (raw as Record<string, unknown>).enabled;
  return typeof enabled === 'boolean' ? enabled : DEFAULT_LEDGER_GATE_ENABLED;
}

/** Read the switch. Anything uncertain resolves to the default (OFF). A
 *  stat per call; the parse only when the mtime changed. */
export function loadLedgerGateEnabled(dir?: string): boolean {
  if (testOverride !== null) return testOverride;
  const p = getDeckLedgerGatePath(dir);
  try {
    const mtimeMs = fs.statSync(p).mtimeMs;
    const hit = cache.get(p);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    const value = parseFlag(p);
    cache.set(p, { mtimeMs, value });
    return value;
  } catch {
    cache.delete(p);
    return DEFAULT_LEDGER_GATE_ENABLED;
  }
}

/** Persist the switch. Returns the value now in force. */
export async function setLedgerGateEnabled(enabled: boolean, dir?: string): Promise<boolean> {
  const next = enabled === true;
  const p = getDeckLedgerGatePath(dir);
  await atomicWriteJSON(p, { enabled: next });
  // Publish the write into the mtime cache instead of leaving the reader to
  // notice it. mtime resolution is coarse (15 ms on Windows), so two toggles
  // inside one tick produce the SAME mtime and the second read would serve the
  // first value — the switch and the Stop gate reading the same file would
  // then disagree about what is in force. Seeding it with the value we just
  // wrote makes that impossible; a failed stat drops the entry so the next
  // read re-parses from disk.
  try {
    cache.set(p, { mtimeMs: fs.statSync(p).mtimeMs, value: next });
  } catch {
    cache.delete(p);
  }
  return next;
}
