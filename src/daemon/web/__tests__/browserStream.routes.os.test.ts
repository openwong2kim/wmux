import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebTerminalServer, type WebDeviceResolver } from '../WebTerminalServer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';

/**
 * `GET …/browser/stream` over real sockets: the flag, the route's checks, the
 * caps, what a slow reader is sent, and the three ways a stream is closed
 * from the daemon's side (revoke, owner lost, main's end). A fake main answers
 * the bridge; its pushes go through `browserStreamPush` as the RPC's would.
 */

type Event = { event: string; data?: Record<string, unknown> };

/** Parses SSE text into events; comments come back as `:`. */
function parse(text: string): Event[] {
  return text.split('\n\n').filter((block) => block.trim()).map((block) => {
    if (block.startsWith(':')) return { event: ':' };
    const lines = block.split('\n');
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? 'message';
    const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
    return { event, ...(data ? { data: JSON.parse(data) as Record<string, unknown> } : {}) };
  });
}

/** A frame's base64 payload of about `kib` KiB. */
const image = (kib: number) => Buffer.alloc(Math.floor((kib * 1024 * 3) / 4), 7).toString('base64');

describe('GET …/browser/stream', () => {
  let server: WebTerminalServer | undefined;
  const open: Array<{ destroy: () => void }> = [];
  afterEach(async () => {
    for (const o of open.splice(0)) o.destroy();
    if (server?.isRunning) await server.stop();
    server = undefined;
  });

  async function start(opts: { announce?: string[]; allowTranscript?: boolean; startReply?: (p: Record<string, unknown>) => unknown } = {}) {
    const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data?: { requestId: string; command: string; payload: Record<string, unknown> } }).data;
      if (!data?.command) return true;
      calls.push({ command: data.command, payload: data.payload });
      const result = data.command === 'workspaces.list' ? { workspaces: [{ id: 'ws-1', name: 'One', sessionId: null }] }
        : data.command === 'browser.streamStart'
          ? (opts.startReply ?? ((p) => ({ backend: 'chrome', maxWidth: p.maxWidth, maxHeight: p.maxHeight, quality: p.quality })))(data.payload)
          : {};
      queueMicrotask(() => bridge.complete(clientId, { requestId: data.requestId, ok: true, result }));
      return true;
    }, 2_000);
    bridge.register('main', opts.announce ?? ['browser.chromePreview', 'browser.stream']);
    const roster: Record<string, { allowInput: boolean; revoked?: boolean }> = { d1: { allowInput: true }, d2: { allowInput: false } };
    const devices: WebDeviceResolver = {
      async mint() { throw new Error('unused'); },
      async resolve(deviceId, secret) {
        const d = roster[deviceId];
        if (d?.revoked) return { ok: false, reason: 'revoked' };
        return d && secret === 'secret' ? { ok: true, deviceId, allowInput: d.allowInput } : { ok: false, reason: 'unknown' };
      },
      list: () => Object.entries(roster).map(([deviceId, d]) => ({ deviceId, name: deviceId, createdAt: 0, lastSeenAt: 0, allowInput: d.allowInput, ...(d.revoked ? { revokedAt: 1 } : {}) })),
    };
    const pane = { meta: { env: { WMUX_WORKSPACE_ID: 'ws-1' }, state: 'attached' } };
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: (id: string) => (id === 'pane-1' ? pane : undefined),
      listLiveSessions: () => [],
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({ sessionManager, devices, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir() });
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: opts.allowTranscript ?? true });
    const port = server.status().port as number;
    const operator = `Bearer ${info.token as string}`;
    const json = async (route: string, auth = operator) => {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { Authorization: auth } });
      return { status: res.status, body: await res.json() as Record<string, unknown>, headers: res.headers };
    };
    const streamId = () => calls.find((c) => c.command === 'browser.streamStart')?.payload.streamId as string;
    const push = (params: Record<string, unknown>) => server!.browserStreamPush('main', { streamId: streamId(), ...params });
    /** An SSE GET that collects its body; resolves on the 200 head. */
    const stream = (route: string, auth = operator) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; events: () => Event[]; closed: Promise<void>; destroy: () => void }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: route, headers: { Authorization: auth } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { text += chunk; });
        const closed = new Promise<void>((done) => { res.on('close', () => done()); res.on('end', () => done()); });
        const handle = { status: res.statusCode ?? 0, headers: res.headers, events: () => parse(text), closed, destroy: () => req.destroy() };
        open.push(handle);
        resolve(handle);
      });
      req.on('error', reject);
    });
    return { bridge, calls, json, stream, push, streamId, port, operator, roster };
  }

  const until = async (check: () => boolean, ms = 3_000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const frame = (extra: Record<string, unknown> = {}) => ({ kind: 'frame', data: 'QUJD', capturedAt: 1, imageWidth: 10, imageHeight: 10, ...extra });

  it('advertises browserStream only with the consent and a desktop that announced it; otherwise the route is today\'s 404', async () => {
    let r = await start();
    expect((await r.json('/api/config')).body.browserStream).toBe(true);
    await server!.stop();
    r = await start({ announce: ['browser.chromePreview'] });
    expect((await r.json('/api/config')).body).not.toHaveProperty('browserStream');
    expect((await r.json('/api/desktop-workspaces/ws-1/browser/stream?surfaceId=chrome-a')).status).toBe(404);
    await server!.stop();
    r = await start({ allowTranscript: false });
    expect((await r.json('/api/config')).body).not.toHaveProperty('browserStream');
  });

  it('refuses bad parameters, and a read-only device for the workspace route and for the mobile viewport', async () => {
    const r = await start();
    expect((await r.json('/api/desktop-workspaces/ws-1/browser/stream')).body).toEqual({ error: 'invalid-browser-surface' });
    expect((await r.json('/api/desktop-workspaces/ws-1/browser/stream?surfaceId=chrome-a&maxFps=fast')).body).toEqual({ error: 'invalid-browser-stream' });
    expect((await r.json('/api/desktop-workspaces/ws-1/browser/stream?surfaceId=chrome-a&viewport=tablet')).status).toBe(400);
    expect((await r.json('/api/desktop-workspaces/ws-1/browser/stream?surfaceId=chrome-a', 'Bearer d2.secret'))).toMatchObject({ status: 403, body: { error: 'workspace-browser-disabled' } });
    const mobile = await r.json('/api/sessions/pane-1/browser/stream?surfaceId=chrome-a&viewport=mobile', 'Bearer d2.secret');
    expect(mobile.status).toBe(403);
    expect(String(mobile.body.error)).toMatch(/^read-only:/);
    expect(r.calls.filter((c) => c.command === 'browser.streamStart')).toEqual([]);
    // The session route needs only the transcript consent.
    const s = await r.stream('/api/sessions/pane-1/browser/stream?surfaceId=chrome-a', 'Bearer d2.secret');
    expect(s.status).toBe(200);
    expect(r.calls.find((c) => c.command === 'browser.streamStart')?.payload).toMatchObject({ workspaceId: 'ws-1', surfaceId: 'chrome-a' });
  });

  it('answers 200 SSE, no-store: hello, then the latest frame; the fifth subscriber of a tab gets 429', async () => {
    const r = await start();
    const route = '/api/desktop-workspaces/ws-1/browser/stream?surfaceId=chrome-a&maxFps=5';
    const first = await r.stream(route);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(first.headers['cache-control']).toBe('no-store');
    await until(() => first.events().length >= 1);
    expect(first.events()[0]).toEqual({ event: 'hello', data: { v: 1, surfaceId: 'chrome-a', backend: 'chrome', maxWidth: 1280, maxHeight: 1280, quality: 60, maxFps: 5 } });
    expect(r.push(frame({ pageURL: 'https://a.example.com/' }))).toEqual({ ok: true, known: true });
    await until(() => first.events().length >= 2);
    for (let i = 0; i < 3; i++) {
      const s = await r.stream(route);
      await until(() => s.events().length >= 2);
      expect(s.events()[1]).toMatchObject({ event: 'frame', data: { seq: 1, pageURL: 'https://a.example.com/' } });
    }
    const fifth = await r.json(route);
    expect(fifth.status).toBe(429);
    expect(fifth.body).toEqual({ error: 'too-many-streams' });
    expect(fifth.headers.get('retry-after')).toBe('1');
    expect(r.calls.filter((c) => c.command === 'browser.streamStart')).toHaveLength(1);
  });

  it('a reader that stops reading keeps its stream and gets the latest frame when it reads again', async () => {
    const r = await start();
    const socket = net.connect(r.port, '127.0.0.1');
    open.push(socket);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(`GET /api/desktop-workspaces/ws-1/browser/stream?surfaceId=chrome-a&maxFps=15 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${r.operator}\r\n\r\n`);
    let text = '';
    socket.setEncoding('utf8');
    const onData = (chunk: string) => { text += chunk; };
    socket.on('data', onData);
    await until(() => text.includes('event: hello'));
    // The phone stops reading; main keeps pushing 500 KiB frames.
    socket.pause();
    const data = image(500);
    const pushed = 24;
    for (let i = 1; i <= pushed; i++) {
      expect(r.push(frame({ data, capturedAt: i }))).toEqual({ ok: true, known: true });
      await new Promise((res) => setTimeout(res, 70));
    }
    socket.resume();
    await until(() => text.includes(`"capturedAt":${pushed},`), 10_000);
    const frames = parse(text.slice(text.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, '\n').replace(/^[0-9a-f]+\n/gm, ''))
      .filter((e) => e.event === 'frame');
    const seqs = frames.map((f) => f.data?.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    // Frames were dropped while it did not read, never queued past the limit…
    expect(frames.length).toBeLessThan(pushed);
    expect(frames.at(-1)?.data?.capturedAt).toBe(pushed);
    // …and the stream is still open: a later frame arrives.
    expect(r.push(frame({ capturedAt: 99 }))).toEqual({ ok: true, known: true });
    await until(() => text.includes('"capturedAt":99,'));
  }, 20_000);

  it('a revoked device\'s stream closes with no end; the operator\'s stays', async () => {
    const r = await start();
    const phone = await r.stream('/api/desktop-workspaces/ws-1/browser/stream?surfaceId=chrome-a', 'Bearer d1.secret');
    const desk = await r.stream('/api/desktop-workspaces/ws-1/browser/stream?surfaceId=chrome-a');
    await until(() => phone.events().length >= 1 && desk.events().length >= 1);
    r.roster.d1.revoked = true;
    expect(server!.disconnectDevice('d1')).toBeGreaterThanOrEqual(1);
    await phone.closed;
    expect(phone.events().map((e) => e.event)).toEqual(['hello']);
    r.push(frame());
    await until(() => desk.events().length >= 2);
  });

  it('when main goes away every stream ends with browser-backend-unavailable', async () => {
    const r = await start();
    const s = await r.stream('/api/sessions/pane-1/browser/stream?surfaceId=chrome-a');
    await until(() => s.events().length >= 1);
    r.bridge.disconnect('main');
    await s.closed;
    expect(s.events().at(-1)).toEqual({ event: 'end', data: { error: 'browser-backend-unavailable' } });
    expect(server!.browserStreamPush('main', { streamId: r.streamId(), kind: 'ping' })).toEqual({ ok: false, known: false });
  });

  it('main\'s refusal at start is the status, before any stream', async () => {
    const r = await start({ startReply: () => ({ error: 'browser-tab-gone' }) });
    expect(await r.json('/api/desktop-workspaces/ws-1/browser/stream?surfaceId=chrome-gone')).toMatchObject({ status: 404, body: { error: 'browser-tab-gone' } });
  });
});
