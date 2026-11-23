// The task port of a headless start: read from its worktree's wmux.json, never one another live start holds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearFanoutPortReservationsForTest } from '../../../main/worktask/fanoutEnvironment';
import { pickHeadlessTaskPort, worktreePortRange } from '../headlessTaskPort';

let wt: string;
beforeEach(() => {
  wt = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-port-'));
  clearFanoutPortReservationsForTest();
});
afterEach(() => fs.rmSync(wt, { recursive: true, force: true }));

const write = (body: unknown): void => fs.writeFileSync(path.join(wt, 'wmux.json'), JSON.stringify(body));

describe('headless task port', () => {
  it('reads fanout.portRange from the worktree; missing, invalid or oversized gives none', () => {
    expect(worktreePortRange(wt)).toBeUndefined();
    write({ fanout: { portRange: '4100-4103' } });
    expect(worktreePortRange(wt)).toEqual({ min: 4100, max: 4103 });
    write({ fanout: { portRange: '80-90' } });
    expect(worktreePortRange(wt)).toBeUndefined();
    fs.writeFileSync(path.join(wt, 'wmux.json'), '{not json');
    expect(worktreePortRange(wt)).toBeUndefined();
  });

  it('skips the ports other starts hold and the busy ones', async () => {
    write({ fanout: { portRange: '4100-4103' } });
    const busy = new Set([4101]);
    const probe = async (p: number): Promise<boolean> => !busy.has(p);
    expect(await pickHeadlessTaskPort(wt, new Set([4100]), probe)).toBe(4102);
    expect(await pickHeadlessTaskPort(wt, new Set([4100, 4102, 4103]), probe)).toBeUndefined();
  });

  it('no range declared: no port, and nothing probed', async () => {
    let probed = 0;
    expect(await pickHeadlessTaskPort(wt, new Set(), async () => { probed += 1; return true; })).toBeUndefined();
    expect(probed).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('a wmux.json that is not a regular file (a link to /dev/zero, a folder) is never read; a link to a regular file is', () => {
    const file = path.join(wt, 'wmux.json');
    fs.symlinkSync('/dev/zero', file);
    expect(worktreePortRange(wt)).toBeUndefined();
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(worktreePortRange(wt)).toBeUndefined();
    fs.rmdirSync(file);
    const real = path.join(wt, 'real.json');
    fs.writeFileSync(real, JSON.stringify({ fanout: { portRange: '4200-4201' } }));
    fs.symlinkSync(real, file);
    expect(worktreePortRange(wt)).toEqual({ min: 4200, max: 4201 });
  });
});
