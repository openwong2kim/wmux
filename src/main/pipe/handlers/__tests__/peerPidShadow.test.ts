// The measurement log for pids a call names against its connection's peer.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcContext } from '../../../../shared/rpc';
import { notePeerPidClaim, resetPeerPidClaimLog } from '../peerPidShadow';

const wire = (peerPid?: number, clientName = 'claude-code'): RpcContext => ({ origin: 'local', externalWire: true, clientName, ...(peerPid !== undefined ? { peerPid } : {}) });

beforeEach(() => resetPeerPidClaimLog());

describe('notePeerPidClaim', () => {
  it('logs a match and a mismatch once each per kind and client', () => {
    const log = vi.fn();
    notePeerPidClaim('callerPid', 100, wire(100), log);
    notePeerPidClaim('callerPid', 100, wire(100), log);
    notePeerPidClaim('callerPid', 101, wire(100), log);
    notePeerPidClaim('callerPid', 102, wire(100), log);
    notePeerPidClaim('callerPid', 101, wire(100, 'codex'), log);
    notePeerPidClaim('codexCallerPid', 101, wire(100), log);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[peer-pid] callerPid matches the connection\'s peer (client claude-code)',
      '[peer-pid] callerPid 101 differs from the connection\'s peer 100 (client claude-code)',
      '[peer-pid] callerPid 101 differs from the connection\'s peer 100 (client codex)',
      '[peer-pid] codexCallerPid 101 differs from the connection\'s peer 100 (client claude-code)',
    ]);
  });

  it('says nothing without a peer pid or a claimed pid', () => {
    const log = vi.fn();
    notePeerPidClaim('callerPid', 100, wire(), log);
    notePeerPidClaim('callerPid', null, wire(100), log);
    notePeerPidClaim('callerPid', 100, undefined, log);
    expect(log).not.toHaveBeenCalled();
  });
});
