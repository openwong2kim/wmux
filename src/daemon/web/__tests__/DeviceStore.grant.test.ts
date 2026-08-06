/**
 * Per-device input grants — the roster half.
 *
 * The grandfather rule is the load-bearing part: `allowInput` is optional on
 * disk and an ABSENT value means granted, because every record written before
 * the field existed belongs to a device that has been typing under the server
 * flag all along. Defaulting those to read-only would silently mute every
 * paired phone on upgrade.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceStore } from '../DeviceStore';

let dir: string;
const log = (): void => { /* silent */ };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-devices-grant-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function store(): DeviceStore {
  return new DeviceStore({ wmuxDir: dir, log });
}

function readDevices(file: string): Record<string, unknown>[] {
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { devices?: Record<string, unknown>[] };
  return state.devices ?? [];
}

/** Rewrite the roster as a build that predated per-device grants would have. */
function stripGrantFromDisk(file: string): void {
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { devices?: Record<string, unknown>[] };
  for (const rec of state.devices ?? []) delete rec['allowInput'];
  fs.writeFileSync(file, JSON.stringify(state));
}

describe('DeviceStore — input grants', () => {
  it('mints with the grant it was given and reports it on the roster', async () => {
    const s = store();
    const typer = await s.mint({ name: 'iPhone', allowInput: true });
    const viewer = await s.mint({ name: 'Wall display', allowInput: false });

    expect(typer.allowInput).toBe(true);
    expect(viewer.allowInput).toBe(false);

    const roster = s.list();
    expect(roster.find((d) => d.deviceId === typer.deviceId)?.allowInput).toBe(true);
    expect(roster.find((d) => d.deviceId === viewer.deviceId)?.allowInput).toBe(false);
  });

  it('defaults a grantless mint to read-only — the recoverable mistake', async () => {
    const s = store();
    const d = await s.mint({ name: 'unspecified' });
    expect(d.allowInput).toBe(false);
  });

  it('carries the grant onto the auth result', async () => {
    const s = store();
    const d = await s.mint({ name: 'iPhone', allowInput: true });
    const auth = await s.resolve(d.deviceId, d.deviceSecret);
    expect(auth).toMatchObject({ ok: true, allowInput: true });
  });

  // The upgrade path. A roster written before this field existed must not have
  // every device silently muted by the read.
  it('grandfathers a record with no grant field to ALLOWED', async () => {
    const s = store();
    const d = await s.mint({ name: 'legacy', allowInput: true });
    const file = path.join(dir, 'devices.json');

    stripGrantFromDisk(file);

    const reloaded = store();
    expect(reloaded.list().find((x) => x.deviceId === d.deviceId)?.allowInput).toBe(true);
    const auth = await reloaded.resolve(d.deviceId, d.deviceSecret);
    expect(auth).toMatchObject({ ok: true, allowInput: true });
  });

  it('setInput flips the grant and survives a reload', async () => {
    const s = store();
    const d = await s.mint({ name: 'iPhone', allowInput: true });

    expect(s.setInput(d.deviceId, false)).toEqual({ ok: true });
    expect(s.list().find((x) => x.deviceId === d.deviceId)?.allowInput).toBe(false);
    expect(store().list().find((x) => x.deviceId === d.deviceId)?.allowInput).toBe(false);
  });

  // Touching a legacy record must PIN its grant, so it stops depending on the
  // grandfather rule the moment the operator has an opinion about it.
  it('setInput writes the field even when the resolved value already matches', async () => {
    const s = store();
    const d = await s.mint({ name: 'legacy', allowInput: true });
    const file = path.join(dir, 'devices.json');
    stripGrantFromDisk(file);

    const reloaded = store();
    expect(reloaded.setInput(d.deviceId, true)).toEqual({ ok: true });

    const after = readDevices(file);
    expect(after.find((r) => r['deviceId'] === d.deviceId)?.['allowInput']).toBe(true);
  });

  it('refuses to adjust a revoked device rather than claiming a power it cannot use', async () => {
    const s = store();
    const d = await s.mint({ name: 'iPhone', allowInput: false });
    expect(s.revoke(d.deviceId).ok).toBe(true);
    expect(s.setInput(d.deviceId, true)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses an unknown device', () => {
    expect(store().setInput('nope', true)).toEqual({ ok: false, reason: 'not-found' });
  });
});
