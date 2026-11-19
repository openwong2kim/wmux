import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebTerminalServer } from '../WebTerminalServer';
import type { DaemonSessionManager } from '../../DaemonSessionManager';
import { DesktopPhoneBridge } from '../../phone/DesktopPhoneBridge';
import { handlePhoneBrowser } from '../../../main/phone/PhoneBrowser';
import { createPhoneChromeDeps, type PhoneChromeRegistry } from '../../../main/phone/PhoneBrowserChrome';
import { createPhoneBrowserStreams, type PhoneBrowserStreams } from '../../../main/phone/PhoneBrowserStream';
import type { ChromeBackendClient, ChromeStreamSession, ChromeTargetInfo } from '../../../main/browser-session/ChromeLauncher';

/**
 * A tab opened outside wmux, on a profile bound to one of the workspace's
 * panes, addressed by its `chrome-x-` id alone: the phone sends `?chrome=1`
 * only on the list, so capture, input and the stream must find the tab
 * without it. The real server, bridge and main preview, over a fake launcher.
 */

const WS = 'ws-1';
const ID = 'chrome-x-login';
const URL_ = 'https://login.example.com/';
const METRICS = { cssVisualViewport: { clientWidth: 1000, clientHeight: 700, pageX: 0, pageY: 0, scale: 1 } };

function answer(method: string): unknown {
  if (method === 'Page.getLayoutMetrics') return METRICS;
  if (method === 'Page.captureScreenshot') return { data: 'aGVsbG8=' };
  if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: URL_ } } };
  if (method === 'Runtime.evaluate') return { result: { value: 'visible' } };
  return {};
}

function launcher() {
  const pageSent: string[] = [];
  const streamSent: string[] = [];
  const outside: ChromeTargetInfo[] = [{ surfaceId: ID, targetId: 't-login', url: URL_, title: 'Log in' }];
  const stream = (): ChromeStreamSession => {
    let closed = false;
    return {
      send: async (method: string) => { streamSent.push(method); return answer(method); },
      on: () => undefined,
      onClosed: () => undefined,
      get closed() { return closed; },
      detach: async () => { closed = true; },
    };
  };
  const client = {
    endpoint: async () => ({}), cdpInfoTargets: async () => [], openTab: async () => { throw new Error('no'); },
    listTargets: async () => [], closeSurface: async () => false, hasSurface: () => false, dispose: () => undefined,
    pageSession: vi.fn(async () => { throw new Error('not a recorded tab'); }),
    isRunning: () => true,
    outsideTabs: vi.fn(async () => outside),
    hasOutside: (id: string) => outside.some((t) => t.surfaceId === id),
    outsidePageSession: vi.fn(async () => ({ send: async (method: string) => { pageSent.push(method); return answer(method); } })),
    outsideStreamSession: vi.fn(async () => stream()),
    releaseOutside: vi.fn(),
  } satisfies ChromeBackendClient;
  return { client, pageSent, streamSent };
}

describe('an outside tab addressed by its id alone (no ?chrome=1)', () => {
  let server: WebTerminalServer | undefined;
  let streams: PhoneBrowserStreams | undefined;
  const open: Array<{ destroy: () => void }> = [];
  afterEach(async () => {
    for (const o of open.splice(0)) o.destroy();
    streams?.stopAll();
    if (server?.isRunning) await server.stop();
    server = undefined;
  });

  async function rig() {
    const pane = launcher();
    const registry: PhoneChromeRegistry = {
      profileFor: () => 'default',
      isPaneBound: (p) => p === 'naver-blog',
      peekLauncher: (p) => (p === 'naver-blog' ? pane.client : undefined),
      paneProfiles: (ws) => ({ profiles: ws === WS ? ['naver-blog'] : [], unknown: false }),
    };
    const chrome = createPhoneChromeDeps({ registry, validateNavigation: async () => undefined });
    const preview = {
      backend: () => 'chrome',
      clearViewport: async () => undefined,
      nativeBounds: async () => ({ width: 1, height: 1 }),
      scroll: async () => undefined,
      input: async () => ({ id: 'x', ok: false as const, error: 'unused' }),
      targets: () => [],
      page: () => null,
      invoke: async () => ({ id: 'x', ok: false as const, error: 'unused' }),
      chrome,
    };
    const live = createPhoneBrowserStreams({
      push: async (params) => server?.browserStreamPush('main', params) ?? { ok: false, known: false },
      backend: () => 'chrome',
      chrome,
    });
    streams = live;
    const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const bridge = new DesktopPhoneBridge((clientId, event) => {
      const data = (event as { data?: { requestId: string; command: string; payload: Record<string, unknown> } }).data;
      if (!data?.command) return true;
      if (data.command !== 'workspaces.list') calls.push({ command: data.command, payload: data.payload });
      queueMicrotask(async () => {
        try {
          const result = data.command === 'workspaces.list' ? { workspaces: [{ id: WS, name: 'Blog', sessionId: null }] }
            : data.command.startsWith('browser.stream') ? await live.handle(data.command, data.payload)
              : await handlePhoneBrowser(data.command, data.payload, preview);
          bridge.complete(clientId, { requestId: data.requestId, ok: true, result });
        } catch {
          bridge.complete(clientId, { requestId: data.requestId, ok: false });
        }
      });
      return true;
    }, 2_000);
    bridge.register('main', ['browser.chromePreview', 'browser.stream']);
    const sessionManager = Object.assign(new EventEmitter(), { getSession: () => undefined, listLiveSessions: () => [] }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({ sessionManager, desktop: () => bridge, log: () => undefined, assetsDir: os.tmpdir() });
    const info = await server.start({ port: 0, host: '127.0.0.1', allowInput: true, allowUpload: false, allowTranscript: true });
    const port = server.status().port as number;
    const auth = { Authorization: `Bearer ${info.token as string}`, 'Content-Type': 'application/json' };
    const base = `http://127.0.0.1:${port}/api/desktop-workspaces/${WS}/browser`;
    return { pane, calls, base, auth, port };
  }

  it('capture: GET …/browser?surfaceId=chrome-x-… finds the tab', async () => {
    const r = await rig();
    const res = await fetch(`${r.base}?surfaceId=${ID}`, { headers: r.auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: 'aGVsbG8=', mimeType: 'image/jpeg', pageURL: URL_ });
    expect(r.calls.at(-1)).toEqual({ command: 'browser.capture', payload: { workspaceId: WS, surfaceId: ID } });
    expect(r.pane.client.outsidePageSession).toHaveBeenCalledWith(ID);
    expect(r.pane.pageSent).toContain('Page.captureScreenshot');
  });

  it('input: POST …/browser {action:"tap", surfaceId: chrome-x-…} reaches the tab', async () => {
    const r = await rig();
    const res = await fetch(r.base, {
      method: 'POST', headers: r.auth,
      body: JSON.stringify({ action: 'tap', surfaceId: ID, expectedURL: URL_, geometry: { width: 1000, height: 700, scrollX: 0, scrollY: 0 }, x: 0.5, y: 0.5 }),
    });
    expect(res.status).toBe(200);
    expect(r.calls.at(-1)?.payload).not.toHaveProperty('chrome');
    expect(r.pane.client.outsidePageSession).toHaveBeenCalledWith(ID);
    expect(r.pane.pageSent.filter((m) => m === 'Input.dispatchMouseEvent')).toHaveLength(3);
  });

  it('stream: GET …/browser/stream?surfaceId=chrome-x-… starts on the tab', async () => {
    const r = await rig();
    const res = await new Promise<{ status: number; text: () => string }>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: r.port, path: `/api/desktop-workspaces/${WS}/browser/stream?surfaceId=${ID}`, headers: { Authorization: r.auth.Authorization } }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { text += chunk; });
        open.push({ destroy: () => req.destroy() });
        resolve({ status: response.statusCode ?? 0, text: () => text });
      });
      req.on('error', reject);
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(res.text()).toContain('event: hello'), { timeout: 5_000 });
    const start = r.calls.find((c) => c.command === 'browser.streamStart');
    expect(start?.payload).toMatchObject({ workspaceId: WS, surfaceId: ID });
    expect(start?.payload).not.toHaveProperty('chrome');
    expect(r.pane.client.outsideStreamSession).toHaveBeenCalledWith(ID);
    expect(r.pane.streamSent).toContain('Page.startScreencast');
  });
});
