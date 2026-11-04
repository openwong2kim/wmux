import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { WebTerminalServer } from '../WebTerminalServer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';
import { handlePhoneBrowser } from '../../../main/phone/PhoneBrowser';
import type { RpcResponse } from '../../../shared/rpc';

/**
 * Stream input at the daemon: input from a phone that may see the stream is
 * marked `stream:true` for main, and only then do the stream's keys and
 * `history` reach it. The mark needs the desktop's `browser.stream`
 * announcement; without it the routes forward exactly what they did before.
 */

const STREAM_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'];
const page = { surfaceId: 'surf-1', expectedURL: 'https://a.example.com/' };
const geometry = { width: 1000, height: 728, scrollX: 0, scrollY: 0 };

describe('browser preview routes: stream input', () => {
  let server: WebTerminalServer | undefined;
  afterEach(async () => { if (server?.isRunning) await server.stop(); server = undefined; });

  /** A fake desktop that answers `reply` (default applied) and records what it was asked. */
  async function start(opts: { stream?: boolean; reply?: (command: string, payload: Record<string, unknown>) => unknown } = {}) {
    const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data: { requestId: string; command: string; payload: Record<string, unknown> } }).data;
      if (data.command !== 'workspaces.list') calls.push({ command: data.command, payload: data.payload });
      const result = data.command === 'workspaces.list' ? { workspaces: [{ id: 'ws-1', name: 'One', sessionId: null }] }
        : opts.reply ? opts.reply(data.command, data.payload) : { applied: true };
      queueMicrotask(() => bridge.complete(clientId, { requestId: data.requestId, ok: true, result }));
      return true;
    }, 500);
    bridge.register('main', opts.stream === false ? ['browser.chromePreview'] : ['browser.chromePreview', 'browser.stream']);
    const sessionManager = Object.assign(new EventEmitter(), { getSession: () => undefined, listLiveSessions: () => [] }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({ sessionManager, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir() });
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true });
    const base = `http://127.0.0.1:${server.status().port}`;
    const auth = { Authorization: `Bearer ${info.token as string}`, 'Content-Type': 'application/json' };
    const post = async (body: unknown) => {
      const res = await fetch(`${base}/api/desktop-workspaces/ws-1/browser`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    const get = async (route: string) => (await fetch(`${base}${route}`, { headers: auth })).status;
    return { calls, post, get };
  }

  it('with the desktop\'s announcement, input is marked stream:true, and only input', async () => {
    const r = await start();
    await r.post({ action: 'type', ...page, text: 'piece', stream: false });
    expect(r.calls.at(-1)).toEqual({ command: 'browser.type', payload: { ...page, text: 'piece', stream: true, workspaceId: 'ws-1' } });
    await r.post({ action: 'key', ...page, key: 'Enter' });
    expect(r.calls.at(-1)?.payload).toMatchObject({ stream: true });
    await r.post({ action: 'tap', ...page, geometry, x: 0.5, y: 0.5 });
    expect(r.calls.at(-1)?.payload).toMatchObject({ stream: true });
    await r.post({ action: 'scroll', ...page, geometry, x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5 });
    expect(r.calls.at(-1)?.payload).toMatchObject({ stream: true });
    // Capture, navigate, viewport and focus are not input: never marked.
    await r.get(`/api/desktop-workspaces/ws-1/browser?surfaceId=${page.surfaceId}`);
    await r.post({ action: 'navigate', surfaceId: page.surfaceId, url: 'https://b.example.com/', stream: true });
    await r.post({ action: 'viewport', surfaceId: page.surfaceId, mode: 'mobile', stream: true });
    await r.post({ action: 'focus', surfaceId: page.surfaceId, stream: true });
    expect(r.calls.slice(-4).map((c) => [c.command, 'stream' in c.payload])).toEqual([
      ['browser.capture', false], ['browser.navigate', false], ['browser.viewport', false], ['browser.focus', false],
    ]);
  });

  it.each(STREAM_KEYS)('forwards the stream key %s', async (key) => {
    const r = await start();
    expect((await r.post({ action: 'key', ...page, key })).status).toBe(200);
    expect(r.calls.at(-1)).toEqual({ command: 'browser.key', payload: { ...page, key, stream: true, workspaceId: 'ws-1' } });
  });

  it('forwards history back or forward, and nothing else of the body', async () => {
    const r = await start({ reply: () => ({ applied: false }) });
    expect(await r.post({ action: 'history', ...page, direction: 'back', url: 'https://x.example.com/' })).toEqual({ status: 200, body: { applied: false } });
    expect(r.calls.at(-1)).toEqual({ command: 'browser.history', payload: { ...page, direction: 'back', stream: true, workspaceId: 'ws-1' } });
    await r.post({ action: 'history', ...page, direction: 'forward' });
    expect(r.calls.at(-1)?.payload).toMatchObject({ direction: 'forward' });
    const count = r.calls.length;
    expect((await r.post({ action: 'history', ...page, direction: 'up' })).status).toBe(400);
    expect((await r.post({ action: 'history', surfaceId: page.surfaceId, direction: 'back' })).status).toBe(400);
    expect((await r.post({ action: 'history', ...page, expectedURL: 'x'.repeat(4097), direction: 'back' })).status).toBe(400);
    expect(r.calls).toHaveLength(count);
  });

  it.each(['browser-input-busy', 'browser-viewport-changed', 'browser-page-changed'] as const)('main\'s %s is answered 409', async (code) => {
    const r = await start({ reply: () => ({ error: code }) });
    expect(await r.post({ action: 'tap', ...page, geometry, x: 0.5, y: 0.5 })).toEqual({ status: 409, body: { error: code } });
  });

  it('without the announcement, input is forwarded exactly as before', async () => {
    const r = await start({ stream: false });
    await r.post({ action: 'type', ...page, text: 'piece', stream: true });
    expect(r.calls.at(-1)).toEqual({ command: 'browser.type', payload: { ...page, text: 'piece', workspaceId: 'ws-1' } });
    await r.post({ action: 'tap', ...page, geometry, x: 0.5, y: 0.5, stream: true });
    expect(r.calls.at(-1)).toEqual({ command: 'browser.tap', payload: { ...page, geometry, x: 0.5, y: 0.5, workspaceId: 'ws-1' } });
    await r.post({ action: 'key', ...page, key: 'PageDown', stream: true });
    expect(r.calls.at(-1)).toEqual({ command: 'browser.key', payload: { ...page, key: 'PageDown', workspaceId: 'ws-1' } });
    const count = r.calls.length;
    for (const key of STREAM_KEYS) {
      expect(await r.post({ action: 'key', ...page, key })).toEqual({ status: 400, body: { error: 'invalid-browser-request' } });
    }
    expect(await r.post({ action: 'history', ...page, direction: 'back', stream: true })).toEqual({ status: 400, body: { error: 'invalid-browser-request' } });
    expect(r.calls).toHaveLength(count);
  });
});

describe('stream input through main\'s preview', () => {
  let server: WebTerminalServer | undefined;
  afterEach(async () => { if (server?.isRunning) await server.stop(); server = undefined; });

  /** Main's real preview over a builtin pane, behind the real bridge and server. */
  async function rig(stream: boolean) {
    let live = { ...geometry };
    const invoke = vi.fn(async (method: string): Promise<RpcResponse> => ({ id: 'rpc', ok: true, result: method === 'browser.evaluate' ? { value: { ...live, scale: 1 } } : { ok: true } }));
    const preview = {
      backend: () => 'builtin',
      clearViewport: async () => undefined,
      nativeBounds: async () => ({ width: 1000, height: 728 }),
      scroll: async () => undefined,
      input: (_id: number, operation: () => Promise<RpcResponse>) => operation(),
      targets: () => [{ surfaceId: 'surf-1', workspaceId: 'ws-1', webContentsId: 1, targetId: 't', wsUrl: 'ws://private' }],
      page: () => ({ title: 'Pane', url: page.expectedURL }),
      invoke,
      historyEntry: () => null,
      validateNavigation: async () => undefined,
    };
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data: { requestId: string; command: string; payload: Record<string, unknown> } }).data;
      queueMicrotask(async () => {
        try {
          const result = data.command === 'workspaces.list'
            ? { workspaces: [{ id: 'ws-1', name: 'One', sessionId: null }] }
            : await handlePhoneBrowser(data.command, data.payload, preview);
          bridge.complete(clientId, { requestId: data.requestId, ok: true, result });
        } catch {
          bridge.complete(clientId, { requestId: data.requestId, ok: false });
        }
      });
      return true;
    }, 500);
    bridge.register('main', stream ? ['browser.stream'] : []);
    const sessionManager = Object.assign(new EventEmitter(), { getSession: () => undefined, listLiveSessions: () => [] }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({ sessionManager, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir() });
    const started = await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true });
    const base = `http://127.0.0.1:${server.status().port}`;
    const auth = { Authorization: `Bearer ${started.token as string}`, 'Content-Type': 'application/json' };
    const post = async (body: unknown) => {
      const res = await fetch(`${base}/api/desktop-workspaces/ws-1/browser`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    const dispatched = () => invoke.mock.calls.filter(([method]) => method !== 'browser.evaluate').length;
    return { post, dispatched, scrollTo: (scrollY: number) => { live = { ...live, scrollY }; } };
  }

  it('on: a moved viewport is 409 and a stream scroll ignores the offset; history with nowhere to go is applied:false', async () => {
    const r = await rig(true);
    r.scrollTo(300);
    expect(await r.post({ action: 'tap', ...page, geometry, x: 0.5, y: 0.5 })).toEqual({ status: 409, body: { error: 'browser-viewport-changed' } });
    expect(r.dispatched()).toBe(0);
    expect(await r.post({ action: 'scroll', ...page, geometry, x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5 })).toEqual({ status: 200, body: { applied: true } });
    expect(await r.post({ action: 'history', ...page, direction: 'back' })).toEqual({ status: 200, body: { applied: false } });
  });

  it('off: the same requests get exactly today\'s answers', async () => {
    const r = await rig(false);
    r.scrollTo(300);
    expect(await r.post({ action: 'tap', ...page, geometry, x: 0.5, y: 0.5 })).toEqual({ status: 503, body: { error: 'browser-preview-unavailable' } });
    expect(await r.post({ action: 'scroll', ...page, geometry, x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5 })).toEqual({ status: 503, body: { error: 'browser-preview-unavailable' } });
    expect(r.dispatched()).toBe(0);
    expect(await r.post({ action: 'history', ...page, direction: 'back' })).toEqual({ status: 400, body: { error: 'invalid-browser-request' } });
  });
});
