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
    const p = getDeckLedgerGatePath(dir);
    fs.writeFileSync(p, JSON.stringify({ enabled: false }), 'utf8');
    // Stamp a distinctly newer mtime rather than trusting the filesystem to
    // give the rewrite one: Windows resolves mtime to 15 ms, so a same-tick
    // rewrite could otherwise carry the mtime the cache already holds and the
    // assertion would pass or fail on timing, not on behaviour.
    const bumped = new Date(Date.now() + 5_000);
    fs.utimesSync(p, bumped, bumped);
    expect(loadLedgerGateEnabled(dir)).toBe(false);
  });

  // The write publishes its own value into the mtime cache. Without that, two
  // toggles inside one mtime tick leave the second read serving the first
  // value — and the Settings switch and the Stop gate, which read the same
  // file, would disagree about what is in force.
  it('serves the value just written even when the mtime did not move', async () => {
    await setLedgerGateEnabled(true, dir);
    expect(loadLedgerGateEnabled(dir)).toBe(true);
    const p = getDeckLedgerGatePath(dir);
    const frozen = fs.statSync(p).mtime;
    await setLedgerGateEnabled(false, dir);
    // Force the coarse-clock case: same mtime, different content.
    fs.utimesSync(p, frozen, frozen);
    expect(loadLedgerGateEnabled(dir)).toBe(false);
  });
});
