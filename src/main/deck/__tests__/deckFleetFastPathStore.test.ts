import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_FLEET_FAST_PATH_ENABLED,
  loadFleetFastPathEnabled,
  setFleetFastPathEnabled,
  getDeckFleetFastPathPath,
  overrideFleetFastPathForTests,
} from '../deckFleetFastPathStore';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-deck-fleet-fast-path-'));
});
afterEach(() => {
  overrideFleetFastPathForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deckFleetFastPathStore', () => {
  it('defaults to OFF on a missing or corrupt file', () => {
    expect(DEFAULT_FLEET_FAST_PATH_ENABLED).toBe(false);
    expect(loadFleetFastPathEnabled(dir)).toBe(false);
    fs.writeFileSync(getDeckFleetFastPathPath(dir), 'CORRUPT{', 'utf8');
    expect(loadFleetFastPathEnabled(dir)).toBe(false);
  });

  it('round-trips ON and back OFF', async () => {
    expect(await setFleetFastPathEnabled(true, dir)).toBe(true);
    expect(loadFleetFastPathEnabled(dir)).toBe(true);
    expect(await setFleetFastPathEnabled(false, dir)).toBe(false);
    expect(loadFleetFastPathEnabled(dir)).toBe(false);
  });

  // The Settings toggle crosses IPC: a truthy non-boolean must land as OFF.
  it('stores a non-boolean write as OFF', async () => {
    expect(await setFleetFastPathEnabled('yes' as unknown as boolean, dir)).toBe(false);
    expect(loadFleetFastPathEnabled(dir)).toBe(false);
  });

  it('serves the value just written even when the mtime did not move', async () => {
    await setFleetFastPathEnabled(true, dir);
    expect(loadFleetFastPathEnabled(dir)).toBe(true);
    const p = getDeckFleetFastPathPath(dir);
    const frozen = fs.statSync(p).mtime;
    await setFleetFastPathEnabled(false, dir);
    fs.utimesSync(p, frozen, frozen);
    expect(loadFleetFastPathEnabled(dir)).toBe(false);
  });

  it('honours the test override without reading the file', async () => {
    await setFleetFastPathEnabled(false, dir);
    overrideFleetFastPathForTests(true);
    expect(loadFleetFastPathEnabled(dir)).toBe(true);
    overrideFleetFastPathForTests(null);
    expect(loadFleetFastPathEnabled(dir)).toBe(false);
  });
});
