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
});
