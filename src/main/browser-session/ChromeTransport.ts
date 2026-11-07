import { CdpSocket, type CdpConnection, type CdpSocketOptions } from './CdpSocket';
import type { CdpPipeMux } from './CdpPipeMux';

/**
 * How ChromeLauncher reaches a Chrome it launched or adopted.
 *
 * Every launcher call that used to go to `http://127.0.0.1:<port>/json/*`, or
 * opened a browser-level CDP socket, goes through this interface. Two
 * transports serve it: the DevTools port (the default), and a debugging pipe
 * (`--remote-debugging-pipe`, off by default), where each method is the CDP
 * command named here:
 *  - ping / browserEndpoint ↔ Browser.getVersion
 *  - listTargets            ↔ Target.getTargets
 *  - createTarget           ↔ Target.createTarget
 *  - closeTarget            ↔ Target.closeTarget
 *  - activateTarget         ↔ Target.activateTarget
 *  - connect                ↔ a session on the pipe instead of a WebSocket
 */
export interface ChromeTransport {
  readonly kind: 'port' | 'pipe';
  /** The DevTools HTTP port; 0 for a pipe, which has none. */
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

/**
 * What a pipe transport names as its browser endpoint. A pipe has no address:
 * its connections are made on the pipe, whatever endpoint they are given.
 */
export const PIPE_ENDPOINT = 'pipe:';

/**
 * The transport for a Chrome started with `--remote-debugging-pipe`, through
 * the multiplexer on its pipe. The launcher's requests go out on one
 * connection of its own; `connect` gives each caller another.
 */
export function pipeTransport(mux: CdpPipeMux): ChromeTransport {
  const own = mux.connect({ label: 'ChromeLauncher' });
  const call = (method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    if (signal?.aborted) return Promise.reject(new Error(`ChromeLauncher: ${method} aborted`));
    const sent = own.send(method, params);
    if (!signal) return sent;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error(`ChromeLauncher: ${method} aborted`));
      signal.addEventListener('abort', onAbort, { once: true });
      sent.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
        (err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err); },
      );
    });
  };
  // The fields the launcher reads from a /json/list or /json/new entry.
  const entry = (t: { targetId?: unknown; type?: unknown; title?: unknown; url?: unknown }) => ({ id: t.targetId, type: t.type, title: t.title, url: t.url });
  return {
    kind: 'pipe',
    port: 0,
    ping: async (signal) => {
      await call('Browser.getVersion', {}, signal);
    },
    answers: async () => mux.isOpen(),
    listTargets: async (signal) => {
      const { targetInfos } = (await call('Target.getTargets', {}, signal)) as { targetInfos?: Array<Record<string, unknown>> };
      return (targetInfos ?? []).map(entry);
    },
    createTarget: async (url, signal) => {
      const target = url ?? 'about:blank';
      const { targetId } = (await call('Target.createTarget', { url: target }, signal)) as { targetId?: unknown };
      return entry({ targetId, type: 'page', title: '', url: target });
    },
    closeTarget: (targetId, signal) => call('Target.closeTarget', { targetId }, signal),
    activateTarget: (targetId, signal) => call('Target.activateTarget', { targetId }, signal),
    browserEndpoint: async (signal) => {
      await call('Browser.getVersion', {}, signal);
      return PIPE_ENDPOINT;
    },
    browserEndpointIgnoringStatus: async () => (mux.isOpen() ? PIPE_ENDPOINT : null),
    connect: (_endpoint, opts) => mux.connect({ ...(opts.label && { label: opts.label }), ...(opts.timeoutMs && { timeoutMs: opts.timeoutMs }), ...(opts.onDisconnect && { onDisconnect: opts.onDisconnect }) }),
  };
}
