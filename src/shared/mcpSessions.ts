/**
 * Live MCP session counts for `wmux doctor`: the broker reports its open
 * connections to its supervisor over the IPC channel, and each single-child
 * bundle server stamps a per-process id on its RPC envelopes. Shared so the
 * broker, the bundle, main and the CLI agree on the shapes.
 */

/** The only message the broker sends its supervisor. */
export interface BrokerConnectionsReport {
  wmuxBroker: 'connections';
  open: number;
}

export function brokerConnectionsReport(open: number): BrokerConnectionsReport {
  return { wmuxBroker: 'connections', open };
}

/** The open count from an exact report, or null for anything else. */
export function parseBrokerConnectionsReport(message: unknown): number | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const keys = Object.keys(message);
  if (keys.length !== 2 || !keys.includes('wmuxBroker') || !keys.includes('open')) return null;
  const { wmuxBroker, open } = message as Record<string, unknown>;
  if (wmuxBroker !== 'connections') return null;
  return typeof open === 'number' && Number.isSafeInteger(open) && open >= 0 ? open : null;
}

/** A bundle server's envelope id: 32 lowercase hex characters. */
export const MCP_SESSION_ID_RE = /^[0-9a-f]{32}$/;

export interface BrokerStatus {
  running: boolean;
  pid: number | null;
  uptimeS: number | null;
  connections: number;
  crashExits: number;
  spawnFailures: number;
  standDowns: number;
  standingDown: boolean;
}

/** `mcp.sessions.summary` result. */
export interface McpSessionsSummary {
  broker: BrokerStatus & { enabled: boolean };
  bundle: { recent: number; capped: boolean; ttlS: number };
}
