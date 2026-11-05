// Tying pipe calls to the process that sent them (shared/peerPid.ts). Where a
// call names a pid that should be its own, compare it with the pid the OS
// reports for the connection and log the outcome once per kind and client.
// `effectivePeerPid` is the peer a2a.resolve.identity checks its claims against.

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

/**
 * The connection's peer pid a claim is checked against, or null when there is
 * none to check: none was read (Windows, an older build), or the peer is the
 * MCP broker, which relays other processes' calls.
 */
export function effectivePeerPid(ctx: RpcContext | undefined): number | null {
  const peer = ctx?.peerPid;
  return peer === undefined || peer === brokerPid() ? null : peer;
}

function logOnce(key: string, line: string, log: (line: string) => void): void {
  if (logged.has(key) || logged.size >= MAX_LOGGED) return;
  logged.add(key);
  log(line);
}

/**
 * A claim checked against the peer's pane: `refused` names another pane than
 * the peer's, `outside` was let through because the peer is in no pane.
 */
export function notePeerPidVerdict(
  kind: string,
  verdict: 'refused' | 'outside',
  ctx: RpcContext | undefined,
  log: (line: string) => void = (line) => console.log(line),
): void {
  const client = JSON.stringify(ctx?.clientName ?? 'unnamed').slice(0, 80);
  logOnce(`${kind}:${client}:${verdict}`, verdict === 'refused'
    ? `[peer-pid] ${kind} refused: it names another pane than the connection's peer ${ctx?.peerPid} (client ${client})`
    : `[peer-pid] ${kind} kept: the connection's peer ${ctx?.peerPid} is in no pane (client ${client})`, log);
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
  logOnce(`${kind}:${client}:${outcome}`, outcome === 'same'
    ? `[peer-pid] ${kind} matches the connection's peer (client ${client})`
    : outcome === 'via-broker'
      ? `[peer-pid] ${kind} ${claimed} came through the MCP broker ${peer} (client ${client})`
      : `[peer-pid] ${kind} ${claimed} differs from the connection's peer ${peer} (client ${client})`, log);
}

/** Test seam: forget what was logged. */
export function resetPeerPidClaimLog(): void {
  logged.clear();
  brokerPid = () => null;
}
