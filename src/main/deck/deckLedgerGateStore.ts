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

/** Read the switch. Anything uncertain resolves to the default (OFF). */
export function loadLedgerGateEnabled(dir?: string): boolean {
  if (testOverride !== null) return testOverride;
  try {
    const raw = atomicReadJSONSync<unknown>(getDeckLedgerGatePath(dir));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_LEDGER_GATE_ENABLED;
    const enabled = (raw as Record<string, unknown>).enabled;
    return typeof enabled === 'boolean' ? enabled : DEFAULT_LEDGER_GATE_ENABLED;
  } catch {
    return DEFAULT_LEDGER_GATE_ENABLED;
  }
}

/** Persist the switch. Returns the value now in force. */
export async function setLedgerGateEnabled(enabled: boolean, dir?: string): Promise<boolean> {
  const next = enabled === true;
  await atomicWriteJSON(getDeckLedgerGatePath(dir), { enabled: next });
  return next;
}
