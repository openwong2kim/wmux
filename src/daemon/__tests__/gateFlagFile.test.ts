import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { GateFlagFile } from '../gateFlagFile';

function setup(initial = false) {
  let armed = initial;
  const io = { write: vi.fn(), remove: vi.fn() };
  const flag = new GateFlagFile('/x/gate-armed', () => armed, () => undefined, io);
  return { flag, io, set: (v: boolean) => { armed = v; } };
}

describe('GateFlagFile (#1730)', () => {
  it('clears a leftover file on the first sync, then writes only on change', () => {
    const { flag, io, set } = setup(false);
    flag.sync();
    expect(io.remove).toHaveBeenCalledOnce();
    flag.sync();
    expect(io.remove).toHaveBeenCalledOnce();
    set(true);
    flag.sync();
    flag.sync();
    expect(io.write).toHaveBeenCalledOnce();
    set(false);
    flag.sync();
    expect(io.remove).toHaveBeenCalledTimes(2);
  });

  it('retries after a failed write, and treats a throwing predicate as disarmed', () => {
    let armed: () => boolean = () => true;
    const io = { write: vi.fn().mockImplementationOnce(() => { throw new Error('EBUSY'); }), remove: vi.fn() };
    const log = vi.fn();
    const flag = new GateFlagFile('/x/gate-armed', () => armed(), log, io);
    flag.sync();
    flag.sync();
    expect(io.write).toHaveBeenCalledTimes(2);
    // The failure is reported once, and so is the recovery.
    expect(log.mock.calls.map(([m]) => String(m).split(' ')[0])).toEqual(['could', 'WSL']);
    armed = () => { throw new Error('boom'); };
    flag.sync();
    expect(io.remove).toHaveBeenCalledOnce();
  });

  it('stop removes the file and the next start re-syncs', () => {
    const { flag, io, set } = setup(true);
    flag.start(60_000);
    expect(io.write).toHaveBeenCalledOnce();
    flag.stop();
    expect(io.remove).toHaveBeenCalledOnce();
    set(true);
    flag.start(60_000);
    expect(io.write).toHaveBeenCalledTimes(2);
    flag.stop();
  });
});

describe('GateFlagFile default io', () => {
  it('creates a missing data dir, then removes the file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-gate-'));
    try {
      const file = path.join(root, 'not-yet', 'gate-armed');
      let armed = true;
      const flag = new GateFlagFile(file, () => armed);
      flag.sync();
      expect(fs.existsSync(file)).toBe(true);
      armed = false;
      flag.sync();
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
