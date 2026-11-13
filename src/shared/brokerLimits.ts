/**
 * Limits on the shared MCP broker, set in config.json under `mcp.broker`.
 * Every limit is off unless the user sets it. The app reads them when it
 * starts the broker and passes them in its environment, so a change applies
 * from the next broker start (the next wmux start).
 *
 * A session the broker refuses is closed before its ack, so the agent's
 * launcher runs its own full MCP server instead: a limit costs memory, never
 * the agent's tools.
 */

export interface BrokerLimits {
  /** Sessions hosted at once; null = no limit. */
  maxSessions: number | null;
  /** The broker's resident memory, in MiB, above which new sessions are refused; null = no limit. */
  maxRssMb: number | null;
  /** browser_repl runners across every agent at once; null = no limit (each agent still has its own 16). */
  maxBrowserReplRunners: number | null;
}

export const NO_BROKER_LIMITS: BrokerLimits = Object.freeze({ maxSessions: null, maxRssMb: null, maxBrowserReplRunners: null });

/** The environment variable the app passes the limits in. */
export const BROKER_LIMITS_ENV = 'WMUX_MCP_BROKER_LIMITS';

const KEYS = ['maxSessions', 'maxRssMb', 'maxBrowserReplRunners'] as const;

/**
 * The limits in `raw` (the `mcp.broker` object). A key that is absent, null
 * or 0 sets no limit; any other value that is not a positive integer is
 * ignored, and named in `ignored` so doctor can say so.
 */
export function parseBrokerLimits(raw: unknown): { limits: BrokerLimits; ignored: string[] } {
  const limits: BrokerLimits = { ...NO_BROKER_LIMITS };
  const ignored: string[] = [];
  if (raw === undefined || raw === null) return { limits, ignored };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { limits, ignored: ['mcp.broker'] };
  const rec = raw as Record<string, unknown>;
  for (const key of KEYS) {
    const v = rec[key];
    if (v === undefined || v === null || v === 0) continue;
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) limits[key] = v;
    else ignored.push(`mcp.broker.${key}`);
  }
  return { limits, ignored };
}

/** The limits from the WMUX_MCP_BROKER_LIMITS value; none when it is absent or unreadable. */
export function brokerLimitsFromEnv(value: string | undefined): BrokerLimits {
  if (!value) return { ...NO_BROKER_LIMITS };
  try {
    return parseBrokerLimits(JSON.parse(value)).limits;
  } catch {
    return { ...NO_BROKER_LIMITS };
  }
}

/** Why a new session is refused, naming the setting; null when it may be hosted. */
export function admissionRefusal(limits: BrokerLimits, state: { sessions: number; rssBytes: number }): string | null {
  if (limits.maxSessions !== null && state.sessions >= limits.maxSessions) {
    return `mcp.broker.maxSessions (${limits.maxSessions}) reached`;
  }
  if (limits.maxRssMb !== null && state.rssBytes >= limits.maxRssMb * 1024 * 1024) {
    return `mcp.broker.maxRssMb (${limits.maxRssMb}) reached: the broker uses ${Math.round(state.rssBytes / (1024 * 1024))} MiB`;
  }
  return null;
}

/**
 * New connections the broker takes in one second. A protection, not a cap on
 * agents: each connection costs a token-file read and a handshake parse before
 * it is authenticated, so a local process opening connections in a loop could
 * otherwise keep the broker busy. 120 matches the app's own pipe
 * (PipeServer.MAX_NEW_CONNECTIONS_PER_SEC). It is six times the 20 agents
 * measured starting at once, and an agent opens one connection per session.
 * A connection over it is closed at once, and its launcher runs its own server.
 */
export const BROKER_MAX_NEW_CONNECTIONS_PER_SEC = 120;

/** A fixed one-second window of new connections. */
export class ConnectionRate {
  private count = 0;
  private resetAt = 0;

  constructor(
    private readonly max: number = BROKER_MAX_NEW_CONNECTIONS_PER_SEC,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one new connection; false when it is over the window's limit. */
  admit(): boolean {
    const t = this.now();
    if (t >= this.resetAt) {
      this.count = 0;
      this.resetAt = t + 1000;
    }
    this.count++;
    return this.count <= this.max;
  }
}
