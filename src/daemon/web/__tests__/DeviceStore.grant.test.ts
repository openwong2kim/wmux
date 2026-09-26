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
import { DeviceAuditLog } from '../deviceAudit';

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

  // ABSENT grandfathers; PRESENT-but-malformed does not. A persisted "false"
  // string that fell through to the grandfather branch would restore input
  // permission on the next boot — a corrupted or tampered record regaining the
  // one capability the field exists to withhold.
  it('fails closed on a malformed grant rather than grandfathering it', async () => {
    const s = store();
    const d = await s.mint({ name: 'tampered', allowInput: false });
    const file = path.join(dir, 'devices.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { devices: Record<string, unknown>[] };
    for (const rec of state.devices) rec['allowInput'] = 'false';
    fs.writeFileSync(file, JSON.stringify(state));

    const reloaded = store();
    expect(reloaded.list().find((x) => x.deviceId === d.deviceId)?.allowInput).toBe(false);
    expect(await reloaded.resolve(d.deviceId, d.deviceSecret)).toMatchObject({ ok: true, allowInput: false });
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

describe('DeviceStore — who changed the roster', () => {
  const audit = () => new DeviceAuditLog(dir).read();

  it('audits a grant change with its actor and the grant it set', async () => {
    const s = store();
    const d = await s.mint({ name: 'iPhone', allowInput: true });

    expect(s.setInput(d.deviceId, false, 'device-self')).toEqual({ ok: true });

    const grants = audit().filter((e) => e.event === 'input-grant');
    expect(grants).toEqual([
      expect.objectContaining({ deviceId: d.deviceId, name: 'iPhone', actor: 'device-self', allowInput: false }),
    ]);
  });

  // The desktop RPC calls the store with 'desktop'; callers that predate the
  // parameter land there too, so the desk is never an unattributed change.
  it('files the desktop as the actor by default, on both verbs', async () => {
    const s = store();
    const a = await s.mint({ name: 'A', allowInput: false });
    const b = await s.mint({ name: 'B', allowInput: false });

    s.setInput(a.deviceId, true);
    s.revoke(b.deviceId);

    expect(audit().find((e) => e.event === 'input-grant')).toMatchObject({ deviceId: a.deviceId, actor: 'desktop' });
    expect(audit().find((e) => e.event === 'revoke')).toMatchObject({ deviceId: b.deviceId, actor: 'desktop' });
  });

  it('writes the web actor on a revoke', async () => {
    const s = store();
    const d = await s.mint({ name: 'Lost phone' });

    expect(s.revoke(d.deviceId, 'operator-web')).toEqual({ ok: true });

    expect(audit().filter((e) => e.event === 'revoke')).toEqual([
      expect.objectContaining({ deviceId: d.deviceId, name: 'Lost phone', actor: 'operator-web' }),
    ]);
  });

  it('does not audit a grant that did not change', async () => {
    const s = store();
    const d = await s.mint({ name: 'iPhone', allowInput: false });

    expect(s.setInput(d.deviceId, false, 'operator-web')).toEqual({ ok: true });

    expect(audit().filter((e) => e.event === 'input-grant')).toEqual([]);
  });
});
