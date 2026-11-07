import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcContext } from '../../../../shared/rpc';
import {
  checkClaim,
  identitySummary,
  notePeerReadCheck,
  resetClaimChecks,
  setBrokerIdentitySource,
  setClaimStartTimeSource,
} from '../peerPidShadow';

const wire = (peerPid?: number, peerStartedAt?: string, clientName = 'claude-code'): RpcContext => ({
  externalWire: true,
  clientName,
  ...(peerPid !== undefined && { peerPid }),
  ...(peerStartedAt !== undefined && { peerStartedAt }),
}) as RpcContext;
const quiet = { platform: 'darwin' as const, log: () => undefined };

beforeEach(() => {
  resetClaimChecks();
  setClaimStartTimeSource((pid) => (pid === 100 ? 10n : pid === 500 ? 50n : null));
});

describe('checkClaim', () => {
  it('takes the pid the connection came from, with its start time unchanged', () => {
    expect(checkClaim('callerPid', wire(100, '10'), 100, quiet)).toEqual({ ok: true, via: 'same' });
  });

  it('takes any pid from the broker main spawned, by its pid and start time', () => {
    setBrokerIdentitySource(() => ({ pid: 500, startedAt: '50' }));
    expect(checkClaim('callerPid', wire(500, '50'), 4242, quiet)).toEqual({ ok: true, via: 'broker' });
  });

  it('names the reason for each claim it refuses', () => {
    setBrokerIdentitySource(() => ({ pid: 500, startedAt: '50' }));
    const cases: Array<[RpcContext, number, string]> = [
      [wire(), 100, 'no-peer'],
      [wire(101, '10'), 100, 'other-pid'],
      [wire(100), 100, 'start-unread'],
      [wire(100, '9'), 100, 'restarted'],
      [wire(500, '51'), 4242, 'broker-unverified'],
    ];
    for (const [ctx, pid, reason] of cases) expect(checkClaim('callerPid', ctx, pid, quiet), reason).toEqual({ ok: false, reason });
    setClaimStartTimeSource(() => null);
    expect(checkClaim('callerPid', wire(100, '10'), 100, quiet)).toEqual({ ok: false, reason: 'start-unread' });
  });

  it('takes every claim as sent on Windows, and counts those that came over TCP', () => {
    const win = { platform: 'win32' as const, log: () => undefined };
    expect(checkClaim('callerPid', wire(), 100, win)).toEqual({ ok: true, via: 'unchecked' });
    expect(checkClaim('callerPid', { ...wire(), viaTcp: true }, 100, win)).toEqual({ ok: true, via: 'unchecked' });
    expect(identitySummary('win32').tcpClaims).toBe(1);
  });

  it('logs a refusal once per reason and client, with no pid in it, under a cap', () => {
    const log = vi.fn();
    checkClaim('callerPid', wire(60001, '1'), 39876, { platform: 'darwin', log });
    checkClaim('callerPid', wire(60001, '1'), 39876, { platform: 'darwin', log });
    checkClaim('codexCallerPid', wire(60001, '1'), 39876, { platform: 'darwin', log });
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      '[peer-pid] callerPid claim refused (other-pid) for client "claude-code"; counted in wmux doctor',
      '[peer-pid] codexCallerPid claim refused (other-pid) for client "claude-code"; counted in wmux doctor',
    ]);
    for (const [line] of log.mock.calls) expect(line).not.toMatch(/39876|60001/);
    for (let i = 0; i < 100; i++) checkClaim('callerPid', wire(1), 2, { platform: 'darwin', log: (l) => log(l) });
    expect(log.mock.calls.length).toBeLessThanOrEqual(64);
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

  it('reads nothing on Windows', () => {
    notePeerReadCheck('available');
    expect(identitySummary('win32')).toMatchObject({ peerRead: { state: 'not-read' }, startTimes: 'not-read', tcpClaims: 0 });
  });
});
