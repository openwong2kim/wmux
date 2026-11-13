import type { RpcRouter } from '../RpcRouter';
import type { McpSessionTracker } from '../../mcp/mcpSessionTracker';
import type { BrokerStatus, McpSessionsSummary } from '../../../shared/mcpSessions';
import type { IdentityClaimsSummary } from '../../../shared/identityClaims';
import type { BrokerFlag } from '../../../shared/mcpBroker';

export interface McpSessionsRpcDeps {
  brokerEnabled: () => boolean;
  /** WMUX_MCP_BROKER as the app read it, so doctor can say why the broker is on or off. */
  brokerFlag?: () => BrokerFlag;
  brokerStatus: () => BrokerStatus;
  tracker: McpSessionTracker;
  /** How main takes pid claims (peerPidShadow.identitySummary). */
  identity?: () => IdentityClaimsSummary;
}

export function registerMcpSessionsRpc(router: RpcRouter, deps: McpSessionsRpcDeps): void {
  /**
   * mcp.sessions.summary — read-only live MCP counts for `wmux doctor`: the
   * broker's own state and connection count, and how many single-child bundle
   * servers sent a request in the last TTL, and how main takes pid claims.
   * Counts only, plus the broker's own pid: no session ids, paths or tokens.
   */
  router.register('mcp.sessions.summary', () => {
    const summary: McpSessionsSummary = {
      broker: { enabled: deps.brokerEnabled(), ...(deps.brokerFlag && { flag: deps.brokerFlag() }), ...deps.brokerStatus() },
      bundle: deps.tracker.summary(),
      ...(deps.identity && { identity: deps.identity() }),
    };
    return Promise.resolve(summary);
  });
}
