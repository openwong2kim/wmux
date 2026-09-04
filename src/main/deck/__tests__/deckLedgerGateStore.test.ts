import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_LEDGER_GATE_ENABLED,
  loadLedgerGateEnabled,
  setLedgerGateEnabled,
  getDeckLedgerGatePath,
} from '../deckLedgerGateStore';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-deck-ledger-gate-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('deckLedgerGateStore', () => {
  it('defaults to OFF on a missing or corrupt file', () => {
    expect(DEFAULT_LEDGER_GATE_ENABLED).toBe(false);
    expect(loadLedgerGateEnabled(dir)).toBe(false);
    fs.writeFileSync(getDeckLedgerGatePath(dir), 'CORRUPT{', 'utf8');
    expect(loadLedgerGateEnabled(dir)).toBe(false);
  });

  it('round-trips ON and back OFF', async () => {
    expect(await setLedgerGateEnabled(true, dir)).toBe(true);
    expect(loadLedgerGateEnabled(dir)).toBe(true);
    expect(await setLedgerGateEnabled(false, dir)).toBe(false);
    expect(loadLedgerGateEnabled(dir)).toBe(false);
  });

  // The Settings toggle is a renderer surface: whatever crosses the IPC is
  // untrusted. A truthy non-boolean must land as OFF, never as "enabled".
  it('stores a non-boolean write as OFF', async () => {
    expect(await setLedgerGateEnabled('yes' as unknown as boolean, dir)).toBe(false);
    expect(loadLedgerGateEnabled(dir)).toBe(false);
  });

  // The toggle writes the same file the Stop gate reads, and the reader caches
  // by mtime — a write from anywhere else must still be seen, or the switch and
  // the gate would disagree about what is in force.
  it('re-reads a file rewritten behind the mtime cache', async () => {
    await setLedgerGateEnabled(true, dir);
    expect(loadLedgerGateEnabled(dir)).toBe(true);
    fs.writeFileSync(getDeckLedgerGatePath(dir), JSON.stringify({ enabled: false }), 'utf8');
    expect(loadLedgerGateEnabled(dir)).toBe(false);
  });
});
