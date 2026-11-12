// Tying a pipe call's claim to the process that sent it. A call that names a
// pid as its own (a2a.resolve.identity's callerPid and codexCallerPid) is taken
// only from that process, as the OS reports it for the connection
// (shared/peerPid.ts), when its start time still matches the one read at
// accept (shared/processStartTime.ts); or from the MCP broker main spawned,
// which checks the pid of each session it hosts (src/mcp/brokerPeer.ts).
// Windows reads no peer pid, so claims there are taken as sent.
//
// Every claim not taken is counted by reason for `wmux doctor`
// (identitySummary) and logged once per reason and client. Neither names a pid
// or a path.

import type { RpcContext } from '../../../shared/rpc';
import { processStartTime } from '../../../shared/processStartTime';
import { CLAIM_REFUSALS, type ClaimRefusal, type IdentityClaimsSummary } from '../../../shared/identityClaims';

export type ClaimVerdict =
  | { ok: true; via: 'same' | 'broker' | 'unchecked' }
  | { ok: false; reason: ClaimRefusal };

/** The broker main spawned: its pid and the start time read right after the spawn. */
type BrokerIdentity = { pid: number; startedAt: string | null } | null;

let brokerIdentity: () => BrokerIdentity = () => null;
let startTimeOf: (pid: number) => bigint | null = processStartTime;

/** Where the running MCP broker's identity comes from (main's BrokerSupervisor). */
export function setBrokerIdentitySource(source: () => BrokerIdentity): void {
  brokerIdentity = source;
}

/** Test seam: the start time reader (shared/processStartTime.ts). */
export function setClaimStartTimeSource(source: (pid: number) => bigint | null): void {
  startTimeOf = source;
}

/** The start time of the process that has `pid` now, as claims are checked against it. */
export function claimStartTime(pid: number): bigint | null {
  return startTimeOf(pid);
}

const refusals = new Map<ClaimRefusal, number>();
let tcpClaims = 0;
let peerRead: IdentityClaimsSummary['peerRead'] | null = null;

// The client name comes from the caller, so the log is capped.
const MAX_LOGGED = 64;
const logged = new Set<string>();

function refuse(
  kind: string,
  reason: ClaimRefusal,
  ctx: RpcContext | undefined,
  log: (line: string) => void,
): ClaimVerdict {
  refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
  const client = JSON.stringify(ctx?.clientName ?? 'unnamed').slice(0, 80);
  const key = `${kind}:${reason}:${client}`;
  if (!logged.has(key) && logged.size < MAX_LOGGED) {
    logged.add(key);
    log(`[peer-pid] ${kind} claim refused (${reason}) for client ${client}; counted in wmux doctor`);
  }
  return { ok: false, reason };
}

/**
 * Whether main takes `claimedPid` as the caller's own process.
 * - macOS, Linux: the connection's peer is that pid and its start time is the
 *   one read at accept, or the peer is the broker main spawned (pid and start
 *   time as recorded at the spawn); anything else is refused.
 * - Windows: no peer pid is read, so the claim stands as sent (a call that
 *   came over the TCP fallback is counted).
 */
export function checkClaim(
  kind: string,
  ctx: RpcContext | undefined,
  claimedPid: number,
  opts: { platform?: NodeJS.Platform; log?: (line: string) => void } = {},
): ClaimVerdict {
  const log = opts.log ?? ((line: string) => console.log(line));
  if ((opts.platform ?? process.platform) === 'win32') {
    if (ctx?.viaTcp) tcpClaims += 1;
    return { ok: true, via: 'unchecked' };
  }
  const peer = ctx?.peerPid;
  if (peer === undefined) return refuse(kind, 'no-peer', ctx, log);
  const broker = brokerIdentity();
  if (broker && peer === broker.pid) {
    return broker.startedAt !== null && ctx?.peerStartedAt === broker.startedAt
      ? { ok: true, via: 'broker' }
      : refuse(kind, 'broker-unverified', ctx, log);
  }
  if (peer !== claimedPid) return refuse(kind, 'other-pid', ctx, log);
  const now = startTimeOf(claimedPid);
  if (ctx?.peerStartedAt === undefined || now === null) return refuse(kind, 'start-unread', ctx, log);
  return String(now) === ctx.peerStartedAt ? { ok: true, via: 'same' } : refuse(kind, 'restarted', ctx, log);
}

/**
 * Whether a claim checkClaim took is still good when it is minted, after the
 * handler's awaits: a claim taken from the process itself needs that pid's
 * start time unchanged since accept (otherwise it is refused and counted).
 */
export function claimStillHeld(
  kind: string,
  ctx: RpcContext | undefined,
  claimedPid: number,
  verdict: ClaimVerdict,
  log: (line: string) => void = (line) => console.log(line),
): boolean {
  if (!verdict.ok || verdict.via !== 'same') return verdict.ok;
  const now = startTimeOf(claimedPid);
  if (now !== null && String(now) === ctx?.peerStartedAt) return true;
  refuse(kind, now === null ? 'start-unread' : 'restarted', ctx, log);
  return false;
}

/** main's startup peer read check (selfCheckPeerPid): null where the OS gives none. */
export function notePeerReadCheck(verdict: string | null): void {
  if (verdict === null) peerRead = { state: 'not-read' };
  else if (verdict === 'available') peerRead = { state: 'ok' };
  else peerRead = { state: 'unavailable', reason: verdict.replace(/^unavailable \((.*)\)$/, '$1').slice(0, 120) };
}

/** What `wmux doctor` shows in its identity section. */
export function identitySummary(platform: NodeJS.Platform = process.platform): IdentityClaimsSummary {
  const win = platform === 'win32';
  const counts = Object.fromEntries(CLAIM_REFUSALS.map((r) => [r, refusals.get(r) ?? 0])) as Record<ClaimRefusal, number>;
  return {
    peerRead: win ? { state: 'not-read' } : peerRead ?? { state: 'unknown' },
    startTimes: win ? 'not-read' : startTimeOf(process.pid) === null ? 'unavailable' : 'ok',
    refusals: counts,
    ...(win && { tcpClaims }),
  };
}

/** Test seam: forget the counts, the log, and every source. */
export function resetClaimChecks(): void {
  refusals.clear();
  logged.clear();
  tcpClaims = 0;
  peerRead = null;
  brokerIdentity = () => null;
  startTimeOf = processStartTime;
}
