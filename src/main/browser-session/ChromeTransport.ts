import { CdpSocket, type CdpConnection, type CdpSocketOptions } from './CdpSocket';

/**
 * How ChromeLauncher reaches a Chrome it launched or adopted.
 *
 * Every launcher call that used to go to `http://127.0.0.1:<port>/json/*`, or
 * opened a browser-level CDP socket, goes through this interface. The port is
 * the only transport today. The methods are the ones a Chrome started with
 * `--remote-debugging-pipe` could also serve, each named after the CDP command
 * that would carry it there:
 *  - ping / browserEndpoint ↔ Browser.getVersion
 *  - listTargets            ↔ Target.getTargets
 *  - createTarget           ↔ Target.createTarget
 *  - closeTarget            ↔ Target.closeTarget
 *  - activateTarget         ↔ Target.activateTarget
 *  - connect                ↔ a session on the pipe instead of a WebSocket
 */
export interface ChromeTransport {
  readonly kind: 'port';
  /** The DevTools HTTP port. */
  readonly port: number;
  /** Rejects unless the endpoint answers its version request with a 2xx. */
  ping(signal?: AbortSignal): Promise<void>;
  /** True when anything answers at all, whatever the status: liveness only. */
  answers(): Promise<boolean>;
  /** Every target the browser lists. */
  listTargets(signal?: AbortSignal): Promise<unknown>;
  /** Opens a tab, on `url` when one is given. */
  createTarget(url?: string, signal?: AbortSignal): Promise<unknown>;
  /** Starts closing a target. */
  closeTarget(targetId: string, signal?: AbortSignal): Promise<unknown>;
  /** Brings a target, and its window, to the front. */
  activateTarget(targetId: string, signal?: AbortSignal): Promise<unknown>;
  /**
   * The browser-level endpoint to connect to; null when the answer names none.
   * Rejects when the endpoint does not answer with a 2xx.
   */
  browserEndpoint(signal?: AbortSignal): Promise<string | null>;
  /**
   * The same read for a Chrome that may not be this launcher's — an old
   * instance being asked to quit. Any answer that names an endpoint counts,
   * whatever its status, and every failure is null: the caller only needs to
   * know whether there is something it can ask.
   */
  browserEndpointIgnoringStatus(): Promise<string | null>;
  /** A browser-level CDP connection to `endpoint` (re-read on every dial). */
  connect(endpoint: () => string, opts: CdpSocketOptions): CdpConnection;
}

/** The ws URL an answer to the version request names, or null. */
function wsEndpointOf(version: unknown): string | null {
  const url = (version as { webSocketDebuggerUrl?: unknown } | null)?.webSocketDebuggerUrl;
  return typeof url === 'string' && url.startsWith('ws') ? url : null;
}

/** The transport for the DevTools HTTP port `port`. */
export function portTransport(port: number): ChromeTransport {
  const base = `http://127.0.0.1:${port}`;
  const fetchJson = async (path: string, method: 'GET' | 'PUT' = 'GET', signal?: AbortSignal): Promise<unknown> => {
    const res = await fetch(`${base}${path}`, { method, ...(signal && { signal }) });
    if (!res.ok) throw new Error(`ChromeLauncher: ${path} → HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // /json/close answers with plain text ("Target is closing").
      return text;
    }
  };
  return {
    kind: 'port',
    port,
    ping: async (signal) => {
      await fetchJson('/json/version', 'GET', signal);
    },
    answers: async () => {
      let res: Response;
      try {
        res = await fetch(`${base}/json/version`);
      } catch {
        return false;
      }
      // Only the answer matters: the body is dropped so a poll of an endpoint
      // that keeps answering leaves no unread body or held socket behind.
      await res.body?.cancel().catch(() => undefined);
      return true;
    },
    listTargets: (signal) => fetchJson('/json/list', 'GET', signal),
    // Chrome 111+ requires PUT for /json/new.
    createTarget: (url, signal) =>
      fetchJson(url === undefined ? '/json/new' : `/json/new?${encodeURIComponent(url)}`, 'PUT', signal),
    closeTarget: (targetId, signal) => fetchJson(`/json/close/${targetId}`, 'GET', signal),
    activateTarget: (targetId, signal) => fetchJson(`/json/activate/${targetId}`, 'GET', signal),
    browserEndpoint: async (signal) => wsEndpointOf(await fetchJson('/json/version', 'GET', signal)),
    browserEndpointIgnoringStatus: async () => {
      try {
        const res = await fetch(`${base}/json/version`);
        return wsEndpointOf(await res.json());
      } catch {
        return null;
      }
    },
    connect: (endpoint, opts) => new CdpSocket(endpoint, opts),
  };
}
