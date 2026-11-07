// How main takes a call's claim to be a given process (a2a.resolve.identity's
// callerPid and codexCallerPid; src/main/pipe/handlers/peerPidShadow.ts), as
// `wmux doctor` reads it from mcp.sessions.summary.

/**
 * Why a claim was not taken:
 * - `no-peer`: the connection has no OS peer pid to compare with;
 * - `other-pid`: the peer is another process than the one claimed;
 * - `start-unread`: the claimed process's start time could not be read;
 * - `restarted`: the claimed pid now belongs to a process that started later;
 * - `broker-unverified`: the peer has the MCP broker's pid but not the start
 *   time recorded when main spawned it.
 */
export type ClaimRefusal = 'no-peer' | 'other-pid' | 'start-unread' | 'restarted' | 'broker-unverified';

export const CLAIM_REFUSALS: readonly ClaimRefusal[] = ['no-peer', 'other-pid', 'start-unread', 'restarted', 'broker-unverified'];

export interface IdentityClaimsSummary {
  /**
   * Whether main reads the OS peer of its pipe connections: `ok`,
   * `unavailable` (with `reason`), `unknown` before the startup check ends, or
   * `not-read` where the OS gives none (Windows).
   */
  peerRead: { state: 'ok' | 'unavailable' | 'unknown' | 'not-read'; reason?: string };
  /** Whether main reads process start times (macOS, Linux). */
  startTimes: 'ok' | 'unavailable' | 'not-read';
  /** Claims not taken since the app started, by reason. */
  refusals: Record<ClaimRefusal, number>;
  /** Windows only: claims that came over the loopback TCP fallback. */
  tcpClaims?: number;
}
