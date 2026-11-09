import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hangDumpForPid, newestHangDump, pruneHangDumps } from '../hangEvidence';

let dir: string;
const touch = (name: string) => fs.writeFileSync(path.join(dir, name), 'x');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hang-evidence-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('hang dump files', () => {
  it('finds the newest dump, and none in a folder that is not there', () => {
    expect(newestHangDump(path.join(dir, 'missing'))).toBeNull();
    touch('daemon-hang-1-100.txt');
    touch('daemon-hang-2-300.txt');
    touch('daemon-hang-3-200.txt');
    touch('daemon-2026-11-09.log');
    expect(newestHangDump(dir)).toEqual({ path: path.join(dir, 'daemon-hang-2-300.txt'), pid: 2, writtenAt: 300 });
  });

  it('points main at the dump of the daemon it is giving up on, while it is recent', () => {
    const now = 100 * 60_000;
    touch(`daemon-hang-7-${now - 60_000}.txt`);
    touch(`daemon-hang-8-${now}.txt`);
    expect(hangDumpForPid(dir, 7, now)).toBe(path.join(dir, `daemon-hang-7-${now - 60_000}.txt`));
    expect(hangDumpForPid(dir, 9, now)).toBeNull();
    // A pid handed on long ago is another daemon's old dump.
    expect(hangDumpForPid(dir, 7, now + 31 * 60_000)).toBeNull();
  });

  it('keeps the newest five and touches nothing else', () => {
    for (let i = 1; i <= 8; i++) touch(`daemon-hang-1-${i}.txt`);
    touch('daemon-2026-11-09.log');
    pruneHangDumps(dir);
    expect(fs.readdirSync(dir).sort()).toEqual([
      'daemon-2026-11-09.log',
      'daemon-hang-1-4.txt', 'daemon-hang-1-5.txt', 'daemon-hang-1-6.txt', 'daemon-hang-1-7.txt', 'daemon-hang-1-8.txt',
    ]);
  });
});
