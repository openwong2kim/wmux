// Measurement for tying pipe calls to the process that sent them
// (shared/peerPid.ts). Where a call names a pid that should be its own, compare
// it with the pid the OS reports for the connection and log the outcome once
// per kind and client. Nothing decides on it.

import type { RpcContext } from '../../../shared/rpc';

const logged = new Set<string>();
// The client name comes from the caller, so the log is capped.
const MAX_LOGGED = 64;
// The MCP broker relays every shim's call over its own connection, so for
// those calls the peer is the broker and the claimed pid is the shim's.
let brokerPid: () => number | null = () => null;

/** Where the running MCP broker's pid comes from (main's BrokerSupervisor). */
export function setBrokerPidSource(source: () => number | null): void {
  brokerPid = source;
}

export function notePeerPidClaim(
  kind: string,
  claimed: number | null | undefined,
  ctx: RpcContext | undefined,
  log: (line: string) => void = (line) => console.log(line),
): void {
  const peer = ctx?.peerPid;
  if (peer === undefined || claimed == null) return;
  const client = JSON.stringify(ctx?.clientName ?? 'unnamed').slice(0, 80);
  const outcome = claimed === peer ? 'same' : peer === brokerPid() ? 'via-broker' : 'differs';
  const key = `${kind}:${client}:${outcome}`;
  if (logged.has(key) || logged.size >= MAX_LOGGED) return;
  logged.add(key);
  log(outcome === 'same'
    ? `[peer-pid] ${kind} matches the connection's peer (client ${client})`
    : outcome === 'via-broker'
      ? `[peer-pid] ${kind} ${claimed} came through the MCP broker ${peer} (client ${client})`
      : `[peer-pid] ${kind} ${claimed} differs from the connection's peer ${peer} (client ${client})`);
}

/** Test seam: forget what was logged. */
export function resetPeerPidClaimLog(): void {
  logged.clear();
  brokerPid = () => null;
}
