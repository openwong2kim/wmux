// This PC's setting for a menu's labels in a worker's status (statusLabelsStore.ts):
// its own file, the default when it is missing or garbled, hardened when written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATUS_LABELS_FILE, StatusLabelsStore } from '../statusLabelsStore';

let dir: string;
let logs: Array<[string, string]>;
let hardened: string[];
const store = (): StatusLabelsStore => new StatusLabelsStore({
  dir,
  log: (level, msg) => { logs.push([level, msg]); },
  scheduleHarden: (p) => { hardened.push(p); },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-labels-'));
  logs = [];
  hardened = [];
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the status labels setting', () => {
  it('no file: send, and nothing logged', () => {
    expect(store().get()).toBe('send');
    expect(logs).toEqual([]);
  });

  it('keep is saved to its own file, hardened, and read back by the next daemon', () => {
    const s = store();
    expect(s.set('keep')).toEqual({ ok: true, labels: 'keep' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, STATUS_LABELS_FILE), 'utf8'))).toEqual({ v: 1, labels: 'keep' });
    expect(hardened).toEqual([path.join(dir, STATUS_LABELS_FILE)]);
    expect(store().get()).toBe('keep');
  });

  it('a garbled file fails closed: keep, one log line, the original kept aside and keep written in its place', () => {
    fs.writeFileSync(path.join(dir, STATUS_LABELS_FILE), '{"v":1,"labels":"maybe"}');
    expect(store().get()).toBe('keep');
    expect(logs.filter(([level]) => level === 'warn')).toHaveLength(1);
    expect(fs.readdirSync(dir).some((f) => f.startsWith(STATUS_LABELS_FILE) && f !== STATUS_LABELS_FILE)).toBe(true);
    // The next start reads the same.
    expect(store().get()).toBe('keep');
    for (const text of ['not json', '[]', '{"v":2,"labels":"send"}']) {
      fs.writeFileSync(path.join(dir, STATUS_LABELS_FILE), text);
      expect(store().get()).toBe('keep');
    }
  });

  it('a file that is there but cannot be read: keep, and nothing written over it', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const file = path.join(dir, STATUS_LABELS_FILE);
    fs.writeFileSync(file, '{"v":1,"labels":"send"}');
    fs.chmodSync(file, 0o000);
    try {
      const s = store();
      expect(s.get()).toBe('keep');
      expect(s.set('send')).toMatchObject({ ok: false });
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });
});
