import type { RpcRouter } from '../RpcRouter';
import type { McpSessionTracker } from '../../mcp/mcpSessionTracker';
import type { BrokerStatus, McpSessionsSummary } from '../../../shared/mcpSessions';

export interface McpSessionsRpcDeps {
  brokerEnabled: () => boolean;
  brokerStatus: () => BrokerStatus;
  tracker: McpSessionTracker;
}

export function registerMcpSessionsRpc(router: RpcRouter, deps: McpSessionsRpcDeps): void {
  /**
   * mcp.sessions.summary — read-only live MCP counts for `wmux doctor`: the
   * broker's own state and connection count, and how many single-child bundle
   * servers sent a request in the last TTL. Counts only, plus the broker's own
   * pid: no session ids, paths or tokens.
   */
  router.register('mcp.sessions.summary', () => {
    const summary: McpSessionsSummary = {
      broker: { enabled: deps.brokerEnabled(), ...deps.brokerStatus() },
      bundle: deps.tracker.summary(),
    };
    return Promise.resolve(summary);
  });
}
