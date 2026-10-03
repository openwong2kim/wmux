/**
 * The device audit line for a file served because an agent sent it with
 * SendUserFile: device, pane, basename and size, never the directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceStore } from '../DeviceStore';
import { DeviceAuditLog, SENT_FILE_COALESCE_MS, getDeviceAuditPath } from '../deviceAudit';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-devices-sent-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DeviceStore.recordSentFile', () => {
  it('appends one sent-file line without the full path', () => {
    const store = new DeviceStore({ wmuxDir: dir, log: () => { /* silent */ } });
    store.recordSentFile({ deviceId: 'dev-1', sessionId: 'pane-1', file: 'shot.png', bytes: 67 });
    const raw = fs.readFileSync(getDeviceAuditPath(dir), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(1);
    const line = JSON.parse(raw[0]) as Record<string, unknown>;
    expect(line).toMatchObject({ event: 'sent-file', deviceId: 'dev-1', sessionId: 'pane-1', file: 'shot.png', bytes: 67 });
    expect(Object.keys(line).sort()).toEqual(['bytes', 'deviceId', 'event', 'file', 'sessionId', 'ts']);
    expect(raw[0]).not.toContain('/');
  });

  it('writes one line per device, pane and file while a phone re-fetches it', () => {
    const store = new DeviceStore({ wmuxDir: dir, log: () => { /* silent */ } });
    const entry = { deviceId: 'dev-1', sessionId: 'pane-1', file: 'shot.png', bytes: 67 };
    for (let i = 0; i < 500; i++) store.recordSentFile(entry);
    store.recordSentFile({ ...entry, file: 'other.png' });
    store.recordSentFile({ ...entry, deviceId: 'dev-2' });
    const lines = fs.readFileSync(getDeviceAuditPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
  });
});

describe('DeviceAuditLog sent-file coalescing', () => {
  it('writes the same line again once the window has passed', () => {
    let now = 1_000_000;
    const log = new DeviceAuditLog(dir, () => now);
    const line = { event: 'sent-file' as const, deviceId: 'd', sessionId: 'p', file: 'a.png', bytes: 1 };
    expect(log.append(line, { coalesceKey: 'd|p|a.png' })).toBe(true);
    now += SENT_FILE_COALESCE_MS - 1;
    expect(log.append(line, { coalesceKey: 'd|p|a.png' })).toBe(false);
    now += 2;
    expect(log.append(line, { coalesceKey: 'd|p|a.png' })).toBe(true);
    // A pair line is never coalesced.
    expect(log.append({ event: 'pair', deviceId: 'd' })).toBe(true);
    expect(log.append({ event: 'pair', deviceId: 'd' })).toBe(true);
  });
});
