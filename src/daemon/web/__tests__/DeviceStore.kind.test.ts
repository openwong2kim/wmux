/**
 * Device kind — an additive, display-only roster field.
 *
 * A roster written before the field existed must load unchanged and list as
 * `unknown`; a value outside the allowlist is dropped rather than trusted; and
 * the field never takes part in authentication.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceStore, getDeviceStatePath } from '../DeviceStore';

let dir: string;
const log = (): void => { /* silent */ };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-devices-kind-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const store = (): DeviceStore => new DeviceStore({ wmuxDir: dir, log });

function rewriteDisk(mutate: (rec: Record<string, unknown>) => void): void {
  const file = getDeviceStatePath(dir);
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { devices: Record<string, unknown>[] };
  for (const rec of state.devices) mutate(rec);
  fs.writeFileSync(file, JSON.stringify(state));
}

describe('DeviceStore — device kind', () => {
  it('persists an allowlisted kind and lists it after a reload', async () => {
    const s = store();
    const laptop = await s.mint({ name: 'Laptop', kind: 'computer' });
    const phone = await s.mint({ name: 'Phone', kind: 'phone' });
    const reloaded = store().list();
    expect(reloaded.find((d) => d.deviceId === laptop.deviceId)?.kind).toBe('computer');
    expect(reloaded.find((d) => d.deviceId === phone.deviceId)?.kind).toBe('phone');
  });

  it('loads a legacy roster with no kind field, listing it as unknown and still authenticating', async () => {
    const s = store();
    const legacy = await s.mint({ name: 'Old phone', kind: 'phone' });
    rewriteDisk((rec) => { delete rec['kind']; });
    const reloaded = store();
    expect(reloaded.list()).toEqual([
      expect.objectContaining({ deviceId: legacy.deviceId, name: 'Old phone', kind: 'unknown' }),
    ]);
    expect(reloaded.resolve(legacy.deviceId, legacy.deviceSecret)).toMatchObject({ ok: true });
  });

  it('drops a kind outside the allowlist instead of trusting it', async () => {
    const s = store();
    const d = await s.mint({ name: 'Tampered', kind: 'computer' });
    rewriteDisk((rec) => { rec['kind'] = 'admin'; });
    expect(store().list()[0]).toMatchObject({ deviceId: d.deviceId, kind: 'unknown' });
  });

  it('does not write a kind for an unknown mint, so older daemons see the record they always saw', async () => {
    const s = store();
    await s.mint({ name: 'Typed by hand', kind: 'unknown' });
    const file = getDeviceStatePath(dir);
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { devices: Record<string, unknown>[] };
    expect('kind' in state.devices[0]).toBe(false);
  });
});
