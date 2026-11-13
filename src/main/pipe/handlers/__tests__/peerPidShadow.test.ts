// @wmux-lane unit
// The platform is passed in: "win32" here selects a branch of pure decisions,
// so running on Windows cannot change the result.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcContext } from '../../../../shared/rpc';
import {
  brokerStampHolds,
  checkClaim,
  claimStillHeld,
  identitySummary,
  notePeerReadCheck,
  resetClaimChecks,
  setBrokerIdentitySource,
  setBrokerStampSource,
  setClaimStartTimeSource,
  setUnownedBrokerSource,
} from '../peerPidShadow';

const wire = (peerPid?: number, peerStartedAt?: string, clientName = 'claude-code'): RpcContext => ({
  externalWire: true,
  clientName,
  ...(peerPid !== undefined && { peerPid }),
  ...(peerStartedAt !== undefined && { peerStartedAt }),
}) as RpcContext;
const stamped = (ctx: RpcContext): RpcContext => ({ ...ctx, brokerStamped: true });
const quiet = { platform: 'darwin' as const, log: () => undefined };

beforeEach(() => {
  resetClaimChecks();
  setClaimStartTimeSource((pid) => (pid === 100 ? 10n : pid === 500 ? 50n : null));
});

describe('checkClaim', () => {
  it('takes the pid the connection came from, with its start time unchanged', () => {
    expect(checkClaim('callerPid', wire(100, '10'), 100, quiet)).toEqual({ ok: true, via: 'same' });
  });

  it('takes any pid from the broker main spawned, by its pid and start time, on a stamped call', () => {
    setBrokerIdentitySource(() => ({ pid: 500, startedAt: '50' }));
    expect(checkClaim('callerPid', stamped(wire(500, '50')), 4242, quiet)).toEqual({ ok: true, via: 'broker' });
  });

  it('refuses a call from the broker\'s pid and start time that carries no stamp', () => {
    setBrokerIdentitySource(() => ({ pid: 500, startedAt: '50' }));
    expect(checkClaim('callerPid', wire(500, '50'), 4242, quiet)).toEqual({ ok: false, reason: 'broker-unverified' });
    // Nor its own pid: a connection from the broker is never taken as the process itself.
    expect(checkClaim('callerPid', wire(500, '50'), 500, quiet)).toEqual({ ok: false, reason: 'broker-unverified' });
  });

  it('names the reason for each claim it refuses', () => {
    setBrokerIdentitySource(() => ({ pid: 500, startedAt: '50' }));
    const cases: Array<[RpcContext, number, string]> = [
      [wire(), 100, 'no-peer'],
      [wire(101, '10'), 100, 'other-pid'],
      [wire(100), 100, 'start-unread'],
      [wire(100, '9'), 100, 'restarted'],
      [stamped(wire(500, '51')), 4242, 'broker-unverified'],
    ];
    for (const [ctx, pid, reason] of cases) expect(checkClaim('callerPid', ctx, pid, quiet), reason).toEqual({ ok: false, reason });
    setClaimStartTimeSource(() => null);
    expect(checkClaim('callerPid', wire(100, '10'), 100, quiet)).toEqual({ ok: false, reason: 'start-unread' });
  });

  it('counts a claim from another process as other-pid while a broker main did not start serves the agents', () => {
    setUnownedBrokerSource(() => true);
    expect(checkClaim('callerPid', wire(888, '1'), 100, quiet)).toEqual({ ok: false, reason: 'other-pid' });
    // The process itself is still taken.
    expect(checkClaim('callerPid', wire(100, '10'), 100, quiet)).toEqual({ ok: true, via: 'same' });
  });

  it('takes every claim as sent on Windows, and counts those that came over TCP', () => {
    const win = { platform: 'win32' as const, log: () => undefined };
    expect(checkClaim('callerPid', wire(), 100, win)).toEqual({ ok: true, via: 'unchecked' });
    expect(checkClaim('callerPid', { ...wire(), viaTcp: true }, 100, win)).toEqual({ ok: true, via: 'unchecked' });
    expect(identitySummary('win32').tcpClaims).toBe(1);
  });

  it('logs a refusal once per reason and client, with no pid in it', () => {
    const log = vi.fn();
    checkClaim('callerPid', wire(60001, '1'), 39876, { platform: 'darwin', log });
    checkClaim('callerPid', wire(60001, '1'), 39876, { platform: 'darwin', log });
    checkClaim('codexCallerPid', wire(60001, '1'), 39876, { platform: 'darwin', log });
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      '[peer-pid] callerPid claim refused (other-pid) for client "claude-code"; counted in wmux doctor',
      '[peer-pid] codexCallerPid claim refused (other-pid) for client "claude-code"; counted in wmux doctor',
    ]);
    for (const [line] of log.mock.calls) expect(line).not.toMatch(/39876|60001/);
  });

  it('logs at most 64 distinct refusals, and still counts every one', () => {
    const log = vi.fn();
    for (let i = 0; i < 100; i++) checkClaim('callerPid', wire(1, '1', `client-${i}`), 2, { platform: 'darwin', log });
    expect(log).toHaveBeenCalledTimes(64);
    expect(new Set(log.mock.calls.map(([line]) => line)).size).toBe(64);
    expect(identitySummary('darwin').refusals['other-pid']).toBe(100);
  });
});

describe('claimStillHeld', () => {
  it('holds a claim from the process itself only while its start time is unchanged', () => {
    const verdict = checkClaim('callerPid', wire(100, '10'), 100, quiet);
    expect(claimStillHeld('callerPid', wire(100, '10'), 100, verdict, () => undefined)).toBe(true);
    setClaimStartTimeSource(() => 11n);
    expect(claimStillHeld('callerPid', wire(100, '10'), 100, verdict, () => undefined)).toBe(false);
    setClaimStartTimeSource(() => null);
    expect(claimStillHeld('callerPid', wire(100, '10'), 100, verdict, () => undefined)).toBe(false);
    expect(identitySummary('darwin').refusals).toMatchObject({ restarted: 1, 'start-unread': 1 });
  });

  it('holds a broker claim only while that broker is still the one main runs, and never a refused one', () => {
    const broker = { ok: true, via: 'broker' } as const;
    setBrokerIdentitySource(() => ({ pid: 500, startedAt: '50' }));
    expect(claimStillHeld('callerPid', wire(500, '50'), 4242, broker, () => undefined)).toBe(true);
    // The broker was replaced (or is gone) during the handler's awaits.
    setBrokerIdentitySource(() => ({ pid: 501, startedAt: '51' }));
    expect(claimStillHeld('callerPid', wire(500, '50'), 4242, broker, () => undefined)).toBe(false);
    setBrokerIdentitySource(() => null);
    expect(claimStillHeld('callerPid', wire(500, '50'), 4242, broker, () => undefined)).toBe(false);
    expect(identitySummary('darwin').refusals['broker-unverified']).toBe(2);
    expect(claimStillHeld('callerPid', wire(), 100, { ok: false, reason: 'no-peer' }, () => undefined)).toBe(false);
  });
});

describe('identitySummary (wmux doctor)', () => {
  it('counts every refusal by reason, starting from zero', () => {
    expect(identitySummary('darwin').refusals).toEqual({ 'no-peer': 0, 'other-pid': 0, 'start-unread': 0, restarted: 0, 'broker-unverified': 0 });
    checkClaim('callerPid', wire(), 100, quiet);
    checkClaim('callerPid', wire(), 100, quiet);
    checkClaim('callerPid', wire(101, '10'), 100, quiet);
    checkClaim('callerPid', wire(100, '9'), 100, quiet);
    checkClaim('callerPid', wire(100, '10'), 100, quiet);
    expect(identitySummary('darwin').refusals).toEqual({ 'no-peer': 2, 'other-pid': 1, 'start-unread': 0, restarted: 1, 'broker-unverified': 0 });
  });

  it('says whether main reads peers and start times, and why not', () => {
    expect(identitySummary('linux').peerRead).toEqual({ state: 'unknown' });
    notePeerReadCheck('available');
    expect(identitySummary('linux').peerRead).toEqual({ state: 'ok' });
    notePeerReadCheck('unavailable (koffi unavailable: cannot find module)');
    expect(identitySummary('linux').peerRead).toEqual({ state: 'unavailable', reason: 'koffi unavailable: cannot find module' });
    expect(identitySummary('linux').startTimes).toBe('unavailable');
    setClaimStartTimeSource(() => 1n);
    expect(identitySummary('linux').startTimes).toBe('ok');
    expect(identitySummary('linux')).not.toHaveProperty('tcpClaims');
  });

  it('says while a broker main did not start serves the agents, on macOS and Linux only', () => {
    expect(identitySummary('darwin')).not.toHaveProperty('brokerNotOurs');
    setUnownedBrokerSource(() => true);
    expect(identitySummary('darwin').brokerNotOurs).toBe(true);
    expect(identitySummary('win32')).not.toHaveProperty('brokerNotOurs');
  });

  it('reads nothing on Windows', () => {
    notePeerReadCheck('available');
    expect(identitySummary('win32')).toMatchObject({ peerRead: { state: 'not-read' }, startTimes: 'not-read', tcpClaims: 0 });
  });
});

describe('brokerStampHolds', () => {
  beforeEach(() => {
    setBrokerIdentitySource(() => ({ pid: 500, startedAt: '50' }));
    setBrokerStampSource((stamp) => stamp === 'a'.repeat(64));
  });

  it('holds for the stamp main sent, on the spawned broker\'s connection', () => {
    expect(brokerStampHolds(500, '50', 'a'.repeat(64))).toBe(true);
  });

  it('does not hold for another stamp, or for no stamp', () => {
    expect(brokerStampHolds(500, '50', 'b'.repeat(64))).toBe(false);
    expect(brokerStampHolds(500, '50', undefined)).toBe(false);
    expect(brokerStampHolds(500, '50', 7)).toBe(false);
  });

  it('does not hold for the right stamp on any other connection', () => {
    const right = 'a'.repeat(64);
    expect(brokerStampHolds(501, '50', right)).toBe(false);
    expect(brokerStampHolds(500, '51', right)).toBe(false);
    expect(brokerStampHolds(500, undefined, right)).toBe(false);
    expect(brokerStampHolds(undefined, undefined, right)).toBe(false);
    setBrokerIdentitySource(() => ({ pid: 500, startedAt: null }));
    expect(brokerStampHolds(500, '50', right)).toBe(false);
    setBrokerIdentitySource(() => null);
    expect(brokerStampHolds(500, '50', right)).toBe(false);
  });
});
