// The measurement log for pids a call names against its connection's peer.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcContext } from '../../../../shared/rpc';
import { notePeerPidClaim, resetPeerPidClaimLog, setBrokerPidSource } from '../peerPidShadow';

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
      '[peer-pid] callerPid matches the connection\'s peer (client "claude-code")',
      '[peer-pid] callerPid 101 differs from the connection\'s peer 100 (client "claude-code")',
      '[peer-pid] callerPid 101 differs from the connection\'s peer 100 (client "codex")',
      '[peer-pid] codexCallerPid 101 differs from the connection\'s peer 100 (client "claude-code")',
    ]);
  });

  it('tells a call the MCP broker relayed apart from a mismatch', () => {
    const log = vi.fn();
    setBrokerPidSource(() => 500);
    notePeerPidClaim('callerPid', 101, wire(500), log);
    notePeerPidClaim('callerPid', 102, wire(600), log);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[peer-pid] callerPid 101 came through the MCP broker 500 (client "claude-code")',
      '[peer-pid] callerPid 102 differs from the connection\'s peer 600 (client "claude-code")',
    ]);
  });

  it('caps what it logs and keeps a client name on one line', () => {
    const log = vi.fn();
    for (let i = 0; i < 100; i++) notePeerPidClaim('callerPid', 1, wire(2, `client-${i}`), log);
    expect(log).toHaveBeenCalledTimes(64);
    resetPeerPidClaimLog();
    log.mockClear();
    notePeerPidClaim('callerPid', 1, wire(2, 'a\nb'), log);
    expect(log.mock.calls[0][0]).not.toContain('\n');
  });

  it('says nothing without a peer pid or a claimed pid', () => {
    const log = vi.fn();
    notePeerPidClaim('callerPid', 100, wire(), log);
    notePeerPidClaim('callerPid', null, wire(100), log);
    notePeerPidClaim('callerPid', 100, undefined, log);
    expect(log).not.toHaveBeenCalled();
  });
});
