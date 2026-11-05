// Measurement for tying pipe calls to the process that sent them
// (shared/peerPid.ts). Where a call names a pid that should be its own, compare
// it with the pid the OS reports for the connection and log the outcome once
// per kind and client. Nothing decides on it.

import type { RpcContext } from '../../../shared/rpc';

const logged = new Set<string>();

export function notePeerPidClaim(
  kind: string,
  claimed: number | null | undefined,
  ctx: RpcContext | undefined,
  log: (line: string) => void = (line) => console.log(line),
): void {
  const peer = ctx?.peerPid;
  if (peer === undefined || claimed == null) return;
  const client = ctx?.clientName ?? 'unnamed';
  const same = claimed === peer;
  const key = `${kind}:${client}:${same ? 'same' : 'differs'}`;
  if (logged.has(key)) return;
  logged.add(key);
  log(same
    ? `[peer-pid] ${kind} matches the connection's peer (client ${client})`
    : `[peer-pid] ${kind} ${claimed} differs from the connection's peer ${peer} (client ${client})`);
}

/** Test seam: forget what was logged. */
export function resetPeerPidClaimLog(): void {
  logged.clear();
}
