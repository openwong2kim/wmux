/**
 * Live MCP session counts for `wmux doctor`: the broker reports its open
 * connections to its supervisor over the IPC channel, and each single-child
 * bundle server stamps a per-process id on its RPC envelopes. Shared so the
 * broker, the bundle, main and the CLI agree on the shapes.
 */

/** A tool name as a report may carry it: never arguments or paths. */
export const BROKER_TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Tool names one report carries at most. */
export const BROKER_INFLIGHT_CAP = 8;

/**
 * The only message the broker sends its supervisor: its open connections and
 * the names of the tool calls in flight, so a crash can say what it cut off.
 */
export interface BrokerConnectionsReport {
  wmuxBroker: 'connections';
  open: number;
  inflight?: string[];
}

export function brokerConnectionsReport(open: number, inflight: readonly string[] = []): BrokerConnectionsReport {
  const names = inflight.filter((n) => BROKER_TOOL_NAME_RE.test(n)).slice(0, BROKER_INFLIGHT_CAP);
  return names.length > 0 ? { wmuxBroker: 'connections', open, inflight: names } : { wmuxBroker: 'connections', open };
}

/** What an exact report says, or null for anything else. */
export function parseBrokerConnectionsReport(message: unknown): { open: number; inflight: string[] } | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const keys = Object.keys(message);
  const extra = keys.filter((k) => k !== 'wmuxBroker' && k !== 'open' && k !== 'inflight');
  if (extra.length > 0 || !keys.includes('wmuxBroker') || !keys.includes('open')) return null;
  const { wmuxBroker, open, inflight } = message as Record<string, unknown>;
  if (wmuxBroker !== 'connections') return null;
  if (typeof open !== 'number' || !Number.isSafeInteger(open) || open < 0) return null;
  if (inflight === undefined) return { open, inflight: [] };
  if (
    !Array.isArray(inflight) ||
    inflight.length > BROKER_INFLIGHT_CAP ||
    !inflight.every((n) => typeof n === 'string' && BROKER_TOOL_NAME_RE.test(n))
  ) {
    return null;
  }
  return { open, inflight: [...inflight] as string[] };
}

/** A bundle server's envelope id: 32 lowercase hex characters. */
export const MCP_SESSION_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Why no broker runs: the app stopped it (quit, update), this build has no
 * broker script, another instance's broker serves the pipe, a restart is
 * scheduled after an exit, it failed too often and is off until wmux
 * restarts, or it was never started.
 */
export type BrokerDownReason = 'stopped' | 'script-missing' | 'standing-down' | 'restarting' | 'crash-loop' | 'not-started';

export interface BrokerStatus {
  running: boolean;
  pid: number | null;
  uptimeS: number | null;
  connections: number;
  crashExits: number;
  spawnFailures: number;
  standDowns: number;
  standingDown: boolean;
  /** Null while a broker runs. */
  downReason: BrokerDownReason | null;
  /** Tool calls in flight when the broker last crashed (names only); absent from an older app. */
  lastCrashTools?: string[];
}

/** `mcp.sessions.summary` result. */
export interface McpSessionsSummary {
  broker: BrokerStatus & { enabled: boolean };
  bundle: { recent: number; capped: boolean; ttlS: number };
}
