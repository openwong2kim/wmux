// The stamp main sends the MCP broker it spawns (main's BrokerSupervisor), and
// the one call it goes on: `a2a.resolve.identity` from a session the broker
// verified (brokerPeer.ts), naming no pid but the one verified for it. Main
// takes a claim through the broker only on a call that carries it, over the
// broker's own connection (main/pipe/PipeServer.ts, peerPidShadow.ts).
//
// It is held in this process's memory only, never logged, and goes nowhere
// else. A broker started by hand, or a single-child MCP server, has none.

import { getConnectionScope } from './connectionScope';
import { parseBrokerStampMessage } from '../shared/mcpSessions';

let stamp: string | null = null;

/** Takes the stamp from main's message (the IPC channel); anything else is ignored. */
export function acceptBrokerStamp(message: unknown): void {
  const parsed = parseBrokerStampMessage(message);
  if (parsed !== null) stamp = parsed;
}

const CLAIM_KEYS = ['callerPid', 'codexCallerPid'] as const;

/**
 * The stamp for an outgoing call, or undefined: only `a2a.resolve.identity`,
 * only inside a session the broker verified, and only when the call claims a
 * pid and every pid it claims is that session's verified pid.
 */
export function brokerStampFor(method: string, params: Record<string, unknown>): string | undefined {
  if (stamp === null || method !== 'a2a.resolve.identity') return undefined;
  const verified = getConnectionScope()?.verifiedCallerPid;
  if (verified === undefined) return undefined;
  const claimed = CLAIM_KEYS.filter((key) => key in params);
  if (claimed.length === 0 || claimed.some((key) => params[key] !== verified)) return undefined;
  return stamp;
}

/** Test seam: forget the stamp. */
export function resetBrokerStampForTest(): void {
  stamp = null;
}
