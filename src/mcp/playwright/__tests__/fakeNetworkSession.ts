import { EventEmitter } from 'node:events';

// A stand-in for the CDP session pageNetwork opens: the Network events a test
// fires, and the bodies Network.getResponseBody answers with.

export const FAKE_MAIN_FRAME_ID = 'main-frame';

export interface FakeNetwork {
  /** Resolves once the tap's session is listening (session open is async). */
  ready: () => Promise<void>;
  request: (
    url: string,
    opts?: { method?: string; type?: string; navigation?: boolean; frameId?: string; id?: string },
  ) => string;
  respond: (id: string, status: number, opts?: { contentType?: string; body?: string; url?: string }) => void;
  /** `encodedDataLength` defaults to the body's length (an uncompressed response). */
  finish: (id: string, encodedDataLength?: number) => void;
  fail: (id: string) => void;
  /** Chrome let the body go (navigation, buffer pressure). */
  dropBody: (id: string) => void;
  /** One request, answered and finished. */
  exchange: (
    url: string,
    status: number,
    opts?: { method?: string; contentType?: string; body?: string; type?: string },
  ) => string;
  sent: Array<{ method: string; params?: unknown }>;
  detached: () => boolean;
  session: EventEmitter;
}

let seq = 0;

export function fakeNetwork(): { newCDPSession: () => Promise<unknown>; net: FakeNetwork } {
  const session = new EventEmitter();
  const bodies = new Map<string, string>();
  const urls = new Map<string, string>();
  const sent: FakeNetwork['sent'] = [];
  let detached = false;
  const cdp = {
    on: (event: string, fn: (...a: unknown[]) => void) => session.on(event, fn),
    off: (event: string, fn: (...a: unknown[]) => void) => session.off(event, fn),
    send: async (method: string, params?: { requestId?: string }) => {
      sent.push({ method, params });
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'tab-1' } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: FAKE_MAIN_FRAME_ID } } };
      if (method === 'Network.getResponseBody') {
        const body = params?.requestId !== undefined ? bodies.get(params.requestId) : undefined;
        if (body === undefined) throw new Error('No resource with given identifier found');
        return { body, base64Encoded: false };
      }
      return {};
    },
    detach: async () => {
      detached = true;
    },
  };
  const net: FakeNetwork = {
    ready: async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    request: (url, opts = {}) => {
      const id = opts.id ?? `req-${++seq}`;
      urls.set(id, url);
      session.emit('Network.requestWillBeSent', {
        requestId: id,
        loaderId: opts.navigation ? id : `loader-${seq}`,
        frameId: opts.frameId ?? FAKE_MAIN_FRAME_ID,
        type: opts.type ?? 'Fetch',
        request: { url, method: opts.method ?? 'GET' },
      });
      return id;
    },
    respond: (id, status, opts = {}) => {
      if (opts.body !== undefined) bodies.set(id, opts.body);
      session.emit('Network.responseReceived', {
        requestId: id,
        response: {
          url: opts.url ?? urls.get(id) ?? '',
          status,
          headers: { 'Content-Type': opts.contentType ?? 'application/json' },
        },
      });
    },
    finish: (id, encodedDataLength) =>
      session.emit('Network.loadingFinished', {
        requestId: id,
        encodedDataLength: encodedDataLength ?? bodies.get(id)?.length ?? 0,
      }),
    fail: (id) => session.emit('Network.loadingFailed', { requestId: id }),
    dropBody: (id) => bodies.delete(id),
    exchange: (url, status, opts = {}) => {
      const id = net.request(url, { method: opts.method, type: opts.type });
      net.respond(id, status, { contentType: opts.contentType, body: opts.body });
      net.finish(id);
      return id;
    },
    sent,
    detached: () => detached,
    session,
  };
  return { newCDPSession: async () => cdp, net };
}
