import { describe, it, expect } from 'vitest';
import { isPhantomExit, isPidAlive, shouldReconcileTombstone } from '../phantomExit';

// Issue #646: node-pty's ConPTY conout-socket-close path emits `exit` with
// `_agent.exitCode === undefined` (null on our side) while powershell.exe is
// still running. Tombstoning that exit orphaned the live shell + agent. The
// guard must fire ONLY on the code-less, signal-less, still-alive shape —
// everything else is a real death and keeps the normal flow.
describe('isPhantomExit', () => {
  const alwaysAlive = () => true;
  const alwaysDead = () => false;

  it('matches the observed incident signature: null exitCode, no signal, pid alive', () => {
    expect(isPhantomExit(null, undefined, 20516, alwaysAlive)).toBe(true);
  });

  it('treats an undefined exitCode the same as null (node-pty passes through undefined)', () => {
    expect(isPhantomExit(undefined, undefined, 20516, alwaysAlive)).toBe(true);
  });

  it('a null exitCode whose pid is GONE is a real death, not a phantom', () => {
    expect(isPhantomExit(null, undefined, 20516, alwaysDead)).toBe(false);
  });

  it('any recorded exit code is a real death even if the pid still answers', () => {
    expect(isPhantomExit(0, undefined, 20516, alwaysAlive)).toBe(false); // `exit`
    expect(isPhantomExit(1, undefined, 20516, alwaysAlive)).toBe(false); // error exit
    expect(isPhantomExit(1073807364, undefined, 20516, alwaysAlive)).toBe(false); // shutdown kill
  });

  it('a signal is a death report — the process was killed, not disconnected', () => {
    expect(isPhantomExit(null, 9, 20516, alwaysAlive)).toBe(false);
    expect(isPhantomExit(null, 15, 20516, alwaysAlive)).toBe(false);
  });

  it('an unknown or nonsensical pid can never be proven alive', () => {
    expect(isPhantomExit(null, undefined, undefined, alwaysAlive)).toBe(false);
    expect(isPhantomExit(null, undefined, 0, alwaysAlive)).toBe(false);
    expect(isPhantomExit(null, undefined, -1, alwaysAlive)).toBe(false); // would be a process GROUP on posix
    expect(isPhantomExit(null, undefined, 1.5, alwaysAlive)).toBe(false);
  });

  it('consults liveness only for the code-less shape (no needless syscalls)', () => {
    const seen: number[] = [];
    const spy = (pid: number) => {
      seen.push(pid);
      return true;
    };
    isPhantomExit(0, undefined, 20516, spy);
    isPhantomExit(null, 9, 20516, spy);
    expect(seen).toEqual([]);
    isPhantomExit(null, undefined, 20516, spy);
    expect(seen).toEqual([20516]);
  });
});

describe('isPidAlive', () => {
  it('reports our own process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('rejects pids that cannot exist rather than throwing', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
  });
});

// Boot-time reconciliation: a `dead` record holding a live pid is the
// persisted residue of the same bug, and it hid orphans from every census.
describe('shouldReconcileTombstone', () => {
  const alive = { rebooted: false, alive: () => true };
  const dead = { rebooted: false, alive: () => false };

  it('reconciles a dead record whose pid is still alive within the same boot', () => {
    expect(shouldReconcileTombstone({ state: 'dead', pid: 20516 }, alive)).toBe(true);
  });

  it('leaves a dead record alone once its pid is really gone', () => {
    expect(shouldReconcileTombstone({ state: 'dead', pid: 20516 }, dead)).toBe(false);
  });

  it('never reconciles after a reboot — the pid may have been recycled', () => {
    expect(
      shouldReconcileTombstone({ state: 'dead', pid: 20516 }, { rebooted: true, alive: () => true }),
    ).toBe(false);
  });

  it('only tombstones qualify — live and suspended sessions are not orphans', () => {
    expect(shouldReconcileTombstone({ state: 'attached', pid: 20516 }, alive)).toBe(false);
    expect(shouldReconcileTombstone({ state: 'detached', pid: 20516 }, alive)).toBe(false);
    expect(shouldReconcileTombstone({ state: 'suspended', pid: 20516 }, alive)).toBe(false);
  });

  it('old state files without a pid are skipped, not guessed at', () => {
    expect(shouldReconcileTombstone({ state: 'dead' }, alive)).toBe(false);
    expect(shouldReconcileTombstone({ state: 'dead', pid: 0 }, alive)).toBe(false);
  });
});
