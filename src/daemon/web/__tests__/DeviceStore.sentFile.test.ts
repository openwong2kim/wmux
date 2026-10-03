/**
 * The device audit line for a file served because an agent sent it with
 * SendUserFile: device, pane, basename and size, never the directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceStore } from '../DeviceStore';
import { getDeviceAuditPath } from '../deviceAudit';

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
});
