// main's record of a person's fenced panes, as the daemon's launch routes read it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paneFenceOnInRecord } from '../paneFenceRecord';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pane-fence-record-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('paneFenceOnInRecord', () => {
  it('reads the switch per session; no file is no fenced pane, an unreadable one fences', () => {
    expect(paneFenceOnInRecord(dir, 'daemon-1')).toBe(false);
    fs.mkdirSync(path.join(dir, 'factory'));
    const file = path.join(dir, 'factory', 'pane-fence-sessions.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: { 'daemon-1': { on: true, at: 1 }, 'daemon-2': { on: false, at: 1 } } }));
    expect(paneFenceOnInRecord(dir, 'daemon-1')).toBe(true);
    expect(paneFenceOnInRecord(dir, 'daemon-2')).toBe(false);
    expect(paneFenceOnInRecord(dir, 'daemon-3')).toBe(false);
    fs.writeFileSync(file, '{not json');
    expect(paneFenceOnInRecord(dir, 'daemon-2')).toBe(true);
  });
});
