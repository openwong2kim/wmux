import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as http from 'node:http';
import WebSocket from 'ws';
import { FakeBrowser, type Command } from './fakePipeBrowser';

// A protected profile on the debugging pipe: the launcher gives the pipe its
// rules (ProtectedPipePolicy) and forwards the download guard's events to
// them. Real launcher, real proxy and endpoint; a fake Chrome on the pipe that
// loads the route probe through the proxy, as the real one does.

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' }, autoUpdater: {}, ipcMain: {}, net: {}, shell: {} }));
vi.mock('node:fs', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    existsSync: () => true,
    mkdirSync: () => undefined,
    readFileSync: vi.fn(() => { throw new Error('ENOENT (unit test)'); }),
    writeFileSync: () => undefined,
    unlinkSync: () => undefined,
  };
});

import { ChromeLauncher, type ChromeProtectionPlan } from '../ChromeLauncher';

type FakeChild = EventEmitter & { kill: (signal?: string) => void; stdio: unknown[]; killed: boolean; exitCode: number | null; signalCode: string | null };

class ProtectedPipeChrome extends FakeBrowser {
  proxyPort = 0;

  constructor(private readonly child: FakeChild) {
    super();
  }

  protected override handle(c: Command): void {
    if (c.method === 'Browser.close') {
      this.reply(c, '"result":{}');
      setImmediate(() => this.exit());
      return;
    }
    if (c.method === 'Target.createBrowserContext') {
      this.reply(c, '"result":{"browserContextId":"CTX1"}');
      return;
    }
    if (c.method === 'Target.createTarget' && this.proxyPort && String(c.params.url).startsWith('http')) {
      const req = http.request({ host: '127.0.0.1', port: this.proxyPort, method: 'GET', path: String(c.params.url) }, (res) => res.resume());
      req.on('error', () => undefined);
      req.end();
    }
    super.handle(c);
  }

  exit(): void {
    this.toMux.end();
    this.child.exitCode = 0;
    this.child.emit('exit', 0, null);
  }
}

function spawnChrome(): ProtectedPipeChrome {
  const child = new EventEmitter() as FakeChild;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  const chrome = new ProtectedPipeChrome(child);
  child.stdio = [null, null, null, chrome.fromMux, chrome.toMux];
  child.kill = () => {
    child.killed = true;
    if (child.exitCode === null) chrome.exit();
  };
  spawnMock.mockImplementationOnce((_bin: string, args: string[]) => {
    const proxy = args.find((a) => a.startsWith('--proxy-server='));
    chrome.proxyPort = proxy ? Number(proxy.split(':').at(-1)) : 0;
    return child;
  });
  return chrome;
}

/** A raw CDP client on the endpoint: send, await a reply by id, collect events. */
async function client(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const inbox: Array<Record<string, unknown>> = [];
  const onReply = new Map<number, (m: Record<string, unknown>) => void>();
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString()) as Record<string, unknown>;
    inbox.push(m);
    if (typeof m.id === 'number') onReply.get(m.id)?.(m);
  });
  let next = 0;
  const send = (method: string, params: Record<string, unknown> = {}, seen?: () => void) => {
    const id = ++next;
    const reply = new Promise<Record<string, unknown>>((resolve) => onReply.set(id, (m) => { seen?.(); resolve(m); }));
    ws.send(JSON.stringify({ id, method, params }));
    return reply;
  };
  return { ws, inbox, send };
}

const denyAll: ChromeProtectionPlan = { matcher: () => ({ allows: () => false }) };

beforeEach(() => {
  spawnMock.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nothing listening'); }));
  vi.stubEnv('WMUX_CHROME_TRANSPORT', 'pipe');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ChromeLauncher: a protected profile on the pipe', () => {
  it('gives the pipe the profile\'s rules and forwards the download guard\'s events to them', async () => {
    const chrome = spawnChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-protected', { profileName: 'bank', protection: () => denyAll });
    const { wsEndpoint } = await launcher.endpoint();
    expect(launcher.isProtected()).toBe(true);
    const c = await client(wsEndpoint as string);
    const allows = () => chrome.received.filter((m) => m.method === 'Browser.setDownloadBehavior' && m.params.behavior !== 'deny');

    // A client's download setting is answered here and never reaches Chrome.
    expect(await c.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/x', eventsEnabled: true })).toEqual({ id: 1, result: {} });
    expect(allows()).toEqual([]);

    // Its new context is denied, on the guard's session, before it hears the id.
    let deniedFirst = false;
    const created = await c.send('Target.createBrowserContext', {}, () => {
      deniedFirst = chrome.received.some((m) => m.method === 'Browser.setDownloadBehavior' && m.params.behavior === 'deny' && m.params.browserContextId === 'CTX1');
    });
    expect(created).toEqual({ id: 2, result: { browserContextId: 'CTX1' } });
    expect(deniedFirst).toBe(true);

    // A download in a page it holds reaches it through the guard.
    await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const page = (await c.send('Target.createTarget', { url: 'about:blank' })).result as { targetId: string };
    await vi.waitFor(() => expect(c.inbox.some((m) => m.method === 'Target.attachedToTarget')).toBe(true), { timeout: 5_000 });
    const guardSession = chrome.received.find((m) => m.method === 'Browser.setDownloadBehavior' && m.params.behavior === 'deny' && m.params.browserContextId === undefined)?.sessionId;
    expect(guardSession).toEqual(expect.any(String));
    chrome.event(guardSession as string, 'Browser.downloadWillBegin', { frameId: page.targetId, guid: 'g1', url: 'http://a.test/f', suggestedFilename: 'f' });
    await vi.waitFor(() => expect(c.inbox.find((m) => m.method === 'Browser.downloadWillBegin')?.params).toMatchObject({ guid: 'g1' }), { timeout: 5_000 });

    c.ws.close();
    await launcher.dispose({ immediate: true });
  });
});
