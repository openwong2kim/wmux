import { describe, it, expect } from 'vitest';
import {
  classifyReapIdentity,
  dmtfToUtcMicros,
  fileTimeToUtcMicros,
  isPhantomExit,
  sameProcessStartTime,
  isPidAlive,
  isSameBootProven,
  mayReap,
  shouldReconcileTombstone,
} from '../phantomExit';

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

// Both reaping paths kill a whole process TREE, and Windows recycles pids
// aggressively while a tombstone can outlive its shell by deadTtlHours. The
// creation time is what separates "our orphan" from "a stranger's shell".
describe('classifyReapIdentity', () => {
  const T1 = '20260727142800.123456+540';
  const T2 = '20260727150000.000000+540';

  it('a matching recorded creation time is proof', () => {
    expect(
      classifyReapIdentity({ storedStartTime: T1, currentStartTime: T1, looksLikeOurShell: true }),
    ).toBe('start-time');
  });

  it('a recorded time overrides the executable-name match when it disagrees', () => {
    // The recycled-pid case: a brand new powershell.exe wearing our old pid
    // passes the name check, so the name check must not get a vote here.
    expect(
      classifyReapIdentity({ storedStartTime: T1, currentStartTime: T2, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
  });

  it('an unreadable current creation time never counts as a match', () => {
    expect(
      classifyReapIdentity({ storedStartTime: T1, currentStartTime: null, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
  });

  it('falls back to the executable-name heuristic only when nothing was recorded', () => {
    // Pre-fix tombstones have no creation time; accepting the weaker evidence
    // is what lets existing orphans be cleaned up at all.
    expect(
      classifyReapIdentity({ storedStartTime: undefined, currentStartTime: T1, looksLikeOurShell: true }),
    ).toBe('heuristic');
  });

  it('an unreadable process never passes the heuristic, even when its executable matched (#2416)', () => {
    // The two reads behind a reap can disagree: the start-time read fails and
    // the executable read succeeds. Unknown must not authorize a kill.
    expect(
      classifyReapIdentity({ storedStartTime: null, currentStartTime: null, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
    expect(
      classifyReapIdentity({ currentCreatedAtFt: null, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
  });

  it('no recorded time and not our shell means no evidence at all', () => {
    expect(
      classifyReapIdentity({ storedStartTime: undefined, currentStartTime: T1, looksLikeOurShell: false }),
    ).toBe('unconfirmed');
  });

  it('only an unconfirmed identity blocks the kill', () => {
    expect(mayReap('start-time')).toBe(true);
    expect(mayReap('heuristic')).toBe(true);
    expect(mayReap('unconfirmed')).toBe(false);
  });

  it('a pid the OS reports gone is neither a kill nor a refusal', () => {
    // An exited pid used to read as "unknown" and was logged as an
    // unconfirmed identity, inflating the refusal count.
    expect(
      classifyReapIdentity({ storedCreatedAtFt: '134296036801234567', currentCreatedAtFt: null, currentGone: true, looksLikeOurShell: false }),
    ).toBe('gone');
    expect(
      classifyReapIdentity({ storedStartTime: T1, currentStartTime: null, currentGone: true, looksLikeOurShell: false }),
    ).toBe('gone');
    expect(classifyReapIdentity({ currentGone: true, looksLikeOurShell: false })).toBe('gone');
    expect(mayReap('gone')).toBe(false);
  });
});

// #2398: Windows records the FILETIME read natively. Records written before
// that hold a DMTF string, which must keep authorizing against a FILETIME.
describe('classifyReapIdentity with a native FILETIME', () => {
  // 2026-07-27T05:28:00.1234567Z
  const FT = 134296036801234567n;
  const OTHER_FT = FT + 10_000_000n;

  it('a stored FILETIME equal to the current one is proof', () => {
    expect(
      classifyReapIdentity({ storedCreatedAtFt: FT.toString(), currentCreatedAtFt: FT, looksLikeOurShell: false }),
    ).toBe('start-time');
  });

  it('a stored FILETIME that differs refuses, even when the executable looks like our shell', () => {
    expect(
      classifyReapIdentity({ storedCreatedAtFt: FT.toString(), currentCreatedAtFt: OTHER_FT, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
    // Exact: 100 ns apart is another process.
    expect(
      classifyReapIdentity({ storedCreatedAtFt: FT.toString(), currentCreatedAtFt: FT + 1n, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
  });

  it('a stored FILETIME wins over a legacy DMTF on the same record', () => {
    expect(
      classifyReapIdentity({
        storedCreatedAtFt: OTHER_FT.toString(),
        storedStartTime: '20260727142800.123456+540',
        currentCreatedAtFt: FT,
        looksLikeOurShell: true,
      }),
    ).toBe('unconfirmed');
  });

  it('a legacy DMTF in the same offset matches the FILETIME truncated to microseconds', () => {
    expect(
      classifyReapIdentity({ storedStartTime: '20260727142800.123456+540', currentCreatedAtFt: FT, looksLikeOurShell: false }),
    ).toBe('start-time');
    expect(
      classifyReapIdentity({ storedStartTime: '20260727142800.123457+540', currentCreatedAtFt: FT, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
  });

  it('a legacy DMTF written under another (DST) offset still matches the same instant', () => {
    // Pacific daylight time: 22:28 the day before, seven hours behind UTC.
    expect(
      classifyReapIdentity({ storedStartTime: '20260726222800.123456-420', currentCreatedAtFt: FT, looksLikeOurShell: false }),
    ).toBe('start-time');
    // The same wall-clock time under standard time is an hour later in UTC.
    expect(
      classifyReapIdentity({ storedStartTime: '20260726222800.123456-480', currentCreatedAtFt: FT, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
  });

  it('a stored value that is not DMTF never matches a FILETIME', () => {
    expect(
      classifyReapIdentity({ storedStartTime: 'Mon Jul 27 14:28:00 2026', currentCreatedAtFt: FT, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
  });

  it('nothing stored falls back to the executable-name heuristic', () => {
    expect(classifyReapIdentity({ currentCreatedAtFt: FT, looksLikeOurShell: true })).toBe('heuristic');
    expect(classifyReapIdentity({ currentCreatedAtFt: FT, looksLikeOurShell: false })).toBe('unconfirmed');
  });

  it('an unreadable current FILETIME never counts as a match', () => {
    expect(
      classifyReapIdentity({ storedCreatedAtFt: FT.toString(), currentCreatedAtFt: null, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
    expect(
      classifyReapIdentity({ storedStartTime: '20260727142800.123456+540', currentCreatedAtFt: null, looksLikeOurShell: true }),
    ).toBe('unconfirmed');
  });
});

describe('sameProcessStartTime', () => {
  it('equal readings match, whatever their format', () => {
    expect(sameProcessStartTime('134296036801234567', '134296036801234567')).toBe(true);
    expect(sameProcessStartTime('Mon Jul 27 14:28:00 2026', 'Mon Jul 27 14:28:00 2026')).toBe(true);
  });

  it('a stored DMTF matches the FILETIME of the same instant, and only that one', () => {
    expect(sameProcessStartTime('20260727142800.123456+540', '134296036801234567')).toBe(true);
    expect(sameProcessStartTime('20260726222800.123456-420', '134296036801234567')).toBe(true);
    expect(sameProcessStartTime('20260727142800.123457+540', '134296036801234567')).toBe(false);
  });

  it('nothing else matches', () => {
    expect(sameProcessStartTime('134296036801234567', '134296036801234568')).toBe(false);
    expect(sameProcessStartTime('20260727142800.123456+540', null)).toBe(false);
    expect(sameProcessStartTime('20260727142800.123456+540', 'Mon Jul 27 14:28:00 2026')).toBe(false);
    expect(sameProcessStartTime('Mon Jul 27 14:28:00 2026', '134296036801234567')).toBe(false);
  });
});

describe('DMTF and FILETIME normalization', () => {
  it('reduces both to UTC microseconds', () => {
    const us = BigInt(Date.UTC(2026, 6, 27, 5, 28, 0)) * 1000n + 123456n;
    expect(fileTimeToUtcMicros(134296036801234567n)).toBe(us);
    expect(dmtfToUtcMicros('20260727142800.123456+540')).toBe(us);
    expect(dmtfToUtcMicros('20260727052800.123456+000')).toBe(us);
    expect(dmtfToUtcMicros('20260726222800.123456-420')).toBe(us);
  });

  it('is null for anything that is not DMTF', () => {
    expect(dmtfToUtcMicros('')).toBeNull();
    expect(dmtfToUtcMicros('134296036801234567')).toBeNull();
    expect(dmtfToUtcMicros('20260727142800+540')).toBeNull();
  });
});

describe('isSameBootProven', () => {
  it('proves the same boot only when the stored id exists and matches', () => {
    expect(isSameBootProven('boot-a', 'boot-a')).toBe(true);
  });

  it('a different boot id is a reboot', () => {
    expect(isSameBootProven('boot-a', 'boot-b')).toBe(false);
  });

  it('a state file with no boot id proves nothing — never reconcile', () => {
    // The original `rebooted` flag read this case as "no reboot happened",
    // which would authorize killing a recycled pid across a real reboot.
    expect(isSameBootProven(undefined, 'boot-a')).toBe(false);
    expect(isSameBootProven(null, 'boot-a')).toBe(false);
    expect(isSameBootProven('', 'boot-a')).toBe(false);
  });

  it('an unknown current boot id proves nothing either', () => {
    expect(isSameBootProven('boot-a', null)).toBe(false);
    expect(isSameBootProven(null, null)).toBe(false);
  });
});

// Boot-time reconciliation: a `dead` record holding a live pid is the
// persisted residue of the same bug, and it hid orphans from every census.
describe('shouldReconcileTombstone', () => {
  const alive = { sameBootProven: true, alive: () => true };
  const dead = { sameBootProven: true, alive: () => false };

  it('reconciles a dead record whose pid is still alive within the same boot', () => {
    expect(shouldReconcileTombstone({ state: 'dead', pid: 20516 }, alive)).toBe(true);
  });

  it('leaves a dead record alone once its pid is really gone', () => {
    expect(shouldReconcileTombstone({ state: 'dead', pid: 20516 }, dead)).toBe(false);
  });

  it('never reconciles without proof of the same boot — the pid may have been recycled', () => {
    // Covers both a detected reboot AND a state file carrying no bootId at
    // all: absence of evidence must not read as evidence of no reboot.
    expect(
      shouldReconcileTombstone({ state: 'dead', pid: 20516 }, { sameBootProven: false, alive: () => true }),
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
