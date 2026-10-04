/**
 * The device audit line for a phone send to the Moa (HQ brain) pane: device,
 * pane and route, never what was sent; coalesced like `sent-file`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceStore } from '../DeviceStore';
import { DeviceAuditLog, MOA_SEND_COALESCE_MS, getDeviceAuditPath } from '../deviceAudit';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-devices-moa-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const lines = () => fs.readFileSync(getDeviceAuditPath(dir), 'utf8').trim().split('\n');

describe('DeviceStore.recordMoaSend', () => {
  it('appends one moa-send line with the device, the pane and the route only', () => {
    const store = new DeviceStore({ wmuxDir: dir, log: () => { /* silent */ } });
    store.recordMoaSend({ deviceId: 'dev-1', sessionId: 'brain-hq', route: 'chat' });
    const raw = lines();
    expect(raw).toHaveLength(1);
    const line = JSON.parse(raw[0]) as Record<string, unknown>;
    expect(line).toMatchObject({ event: 'moa-send', deviceId: 'dev-1', sessionId: 'brain-hq', reason: 'chat' });
    expect(Object.keys(line).sort()).toEqual(['deviceId', 'event', 'reason', 'sessionId', 'ts']);
  });

  it('writes one line per device, pane and route while a phone keeps typing', () => {
    const store = new DeviceStore({ wmuxDir: dir, log: () => { /* silent */ } });
    const entry = { deviceId: 'dev-1', sessionId: 'brain-hq', route: 'input' as const };
    for (let i = 0; i < 500; i++) store.recordMoaSend(entry);
    store.recordMoaSend({ ...entry, route: 'chat' });
    store.recordMoaSend({ ...entry, deviceId: 'dev-2' });
    store.recordMoaSend({ ...entry, sessionId: 'brain-next' });
    expect(lines()).toHaveLength(4);
  });
});

describe('DeviceAuditLog moa-send coalescing', () => {
  it('writes the same line again once the window has passed, and keeps its own buckets', () => {
    let now = 1_000_000;
    const log = new DeviceAuditLog(dir, () => now);
    const line = { event: 'moa-send' as const, deviceId: 'd', sessionId: 'brain-hq', reason: 'chat' };
    expect(log.append(line, { coalesceKey: 'k' })).toBe(true);
    now += MOA_SEND_COALESCE_MS - 1;
    expect(log.append(line, { coalesceKey: 'k' })).toBe(false);
    // A sent-file with the same key is a different bucket.
    expect(log.append({ event: 'sent-file', deviceId: 'd', sessionId: 'p', file: 'a.png', bytes: 1 }, { coalesceKey: 'k' })).toBe(true);
    now += 2;
    expect(log.append(line, { coalesceKey: 'k' })).toBe(true);
  });
});
