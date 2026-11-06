import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The port transport must send exactly the requests ChromeLauncher used to
// send itself: same URLs, same methods, same error text, same body handling.

const { sockets } = vi.hoisted(() => ({ sockets: [] as Array<{ endpoint: () => string; opts: unknown }> }));
vi.mock('../CdpSocket', () => ({
  CdpSocket: class {
    constructor(endpoint: () => string, opts: unknown) {
      sockets.push({ endpoint, opts });
    }
  },
}));

import { portTransport } from '../ChromeTransport';

let fetchMock: ReturnType<typeof vi.fn>;

const answer = (status: number, body: string) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
  json: async () => JSON.parse(body),
});

/** Each request as [url, method, has a signal]. */
const requests = () =>
  fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit | undefined)?.method, !!(init as RequestInit | undefined)?.signal]);

beforeEach(() => {
  sockets.length = 0;
  fetchMock = vi.fn(async () => answer(200, '{}'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('portTransport requests', () => {
  it('sends the same requests the launcher sent', async () => {
    const t = portTransport(9222);
    const signal = new AbortController().signal;
    await t.ping();
    await t.listTargets();
    await t.listTargets(signal);
    await t.createTarget('https://a.test/x?y=1');
    await t.createTarget(undefined, signal);
    await t.closeTarget('T1');
    await t.closeTarget('T2', signal);
    await t.activateTarget('T3');
    expect(requests()).toEqual([
      ['http://127.0.0.1:9222/json/version', 'GET', false],
      ['http://127.0.0.1:9222/json/list', 'GET', false],
      ['http://127.0.0.1:9222/json/list', 'GET', true],
      [`http://127.0.0.1:9222/json/new?${encodeURIComponent('https://a.test/x?y=1')}`, 'PUT', false],
      ['http://127.0.0.1:9222/json/new', 'PUT', true],
      ['http://127.0.0.1:9222/json/close/T1', 'GET', false],
      ['http://127.0.0.1:9222/json/close/T2', 'GET', true],
      ['http://127.0.0.1:9222/json/activate/T3', 'GET', false],
    ]);
  });

  it('parses JSON, hands back plain text as it is, and names the path on an HTTP error', async () => {
    const t = portTransport(9222);
    fetchMock.mockResolvedValueOnce(answer(200, '[{"id":"P"}]'));
    expect(await t.listTargets()).toEqual([{ id: 'P' }]);
    fetchMock.mockResolvedValueOnce(answer(200, 'Target is closing'));
    expect(await t.closeTarget('P')).toBe('Target is closing');
    fetchMock.mockResolvedValueOnce(answer(500, 'nope'));
    await expect(t.ping()).rejects.toThrow('ChromeLauncher: /json/version → HTTP 500');
  });
});

describe('portTransport endpoint reads', () => {
  it('reads the browser endpoint, null when the answer names none', async () => {
    const t = portTransport(9222);
    fetchMock.mockResolvedValueOnce(answer(200, '{"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/u"}'));
    expect(await t.browserEndpoint()).toBe('ws://127.0.0.1:9222/devtools/browser/u');
    fetchMock.mockResolvedValueOnce(answer(200, '{"webSocketDebuggerUrl":"http://not-ws"}'));
    expect(await t.browserEndpoint()).toBeNull();
    fetchMock.mockResolvedValueOnce(answer(200, '{}'));
    expect(await t.browserEndpoint()).toBeNull();
  });

  it('rejects a non-2xx answer on the strict read', async () => {
    fetchMock.mockResolvedValueOnce(answer(404, '{"webSocketDebuggerUrl":"ws://x"}'));
    await expect(portTransport(9222).browserEndpoint()).rejects.toThrow('HTTP 404');
  });

  it('takes an endpoint from a non-2xx answer on the read that ignores status', async () => {
    fetchMock.mockResolvedValueOnce(answer(404, '{"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/old"}'));
    expect(await portTransport(9222).browserEndpointIgnoringStatus()).toBe('ws://127.0.0.1:9222/devtools/browser/old');
    expect(requests()).toEqual([['http://127.0.0.1:9222/json/version', undefined, false]]);
  });

  it('answers null, never throws, when that read gets nothing usable', async () => {
    const t = portTransport(9222);
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await t.browserEndpointIgnoringStatus()).toBeNull();
    fetchMock.mockResolvedValueOnce(answer(200, 'not json'));
    expect(await t.browserEndpointIgnoringStatus()).toBeNull();
  });
});

describe('portTransport liveness and connections', () => {
  it('counts any HTTP answer as alive, whatever its status, and only a failed request as gone', async () => {
    const t = portTransport(9222);
    fetchMock.mockResolvedValueOnce(answer(503, ''));
    expect(await t.answers()).toBe(true);
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await t.answers()).toBe(false);
    expect(requests()).toEqual([
      ['http://127.0.0.1:9222/json/version', undefined, false],
      ['http://127.0.0.1:9222/json/version', undefined, false],
    ]);
  });

  it('opens a CdpSocket on the endpoint it is given, with the options passed through', () => {
    const endpoint = () => 'ws://e';
    const opts = { label: 'L', timeoutMs: 3_000 };
    portTransport(9222).connect(endpoint, opts);
    expect(sockets).toEqual([{ endpoint, opts }]);
  });
});
