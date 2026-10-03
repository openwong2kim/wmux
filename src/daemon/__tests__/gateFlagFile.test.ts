import { describe, expect, it, vi } from 'vitest';
import { GateFlagFile } from '../gateFlagFile';

function setup(initial = false) {
  let armed = initial;
  const io = { write: vi.fn(), remove: vi.fn() };
  const flag = new GateFlagFile('/x/gate-armed', () => armed, io);
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
    const flag = new GateFlagFile('/x/gate-armed', () => armed(), io);
    flag.sync();
    flag.sync();
    expect(io.write).toHaveBeenCalledTimes(2);
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
