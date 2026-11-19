import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as http from 'node:http';
import WebSocket from 'ws';
import { PassThrough } from 'node:stream';
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
    readFileSync: vi.fn(() => { throw Object.assign(new Error('ENOENT (unit test)'), { code: 'ENOENT' }); }),
    writeFileSync: () => undefined,
    unlinkSync: () => undefined,
  };
});

import { readFileSync } from 'node:fs';
import { ChromeLauncher, PROTECTION_NOT_READY, setPipeRelayForTests, transportFor, transportLabel, type ChromeProtectionPlan } from '../ChromeLauncher';
import { CdpPipeRelay, type RelayGrant } from '../CdpPipeRelay';

type FakeChild = EventEmitter & { kill: (signal?: string) => void; stdio: unknown[]; killed: boolean; exitCode: number | null; signalCode: string | null };

class ProtectedPipeChrome extends FakeBrowser {
  proxyPort = 0;

  constructor(readonly child: FakeChild) {
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

/** A Chrome that exits during startup with `code`, before it answers anything. */
function spawnFailing(code: number): void {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as FakeChild;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
    child.kill = () => { child.killed = true; };
    setImmediate(() => {
      child.exitCode = code;
      child.emit('exit', code, null);
    });
    return child;
  });
}

const spawnArgs = (n: number) => spawnMock.mock.calls[n]?.[1] as string[];
const PORT_FLAGS = /^--remote-(debugging-port|debugging-address|allow-origins)/;

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
async function client(grant: RelayGrant) {
  const ws = new WebSocket(grant.endpoint, { headers: { ...grant.headers } });
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

beforeEach(async () => {
  // Loopback TCP: no socket dir in any temp dir another wmux uses.
  await setPipeRelayForTests(new CdpPipeRelay({ roots: [] }));
  spawnMock.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nothing listening'); }));
  vi.stubEnv('WMUX_CHROME_TRANSPORT', 'pipe');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await setPipeRelayForTests(null);
});

describe('ChromeLauncher: a protected profile on the pipe', () => {
  it('gives the pipe the profile\'s rules and forwards the download guard\'s events to them', async () => {
    const chrome = spawnChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-protected', { profileName: 'bank', protection: () => denyAll });
    await launcher.endpoint();
    expect(launcher.isProtected()).toBe(true);
    const c = await client(await launcher.relayGrant({ workspaceId: 'ws-bank' }));
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

  it('a protected launch on the pipe opens no port, whatever the pinned env or extra flags ask for', async () => {
    vi.stubEnv('WMUX_CHROME_CDP_PORT', '9333');
    spawnChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-protected-argv', {
      profileName: 'default',
      protection: () => denyAll,
      extraArgs: ['--remote-debugging-port=9222', '--remote-allow-origins=*', '--remote-debugging-address=0.0.0.0', '--lang=en'],
    });
    await launcher.endpoint();
    const args = spawnArgs(0);
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).toContain('--lang=en');
    expect(args.filter((a) => PORT_FLAGS.test(a))).toEqual([]);
    expect(launcher.launchedTransport()).toEqual({ kind: 'pipe', weaker: false });
    await launcher.dispose({ immediate: true });
  });

  it('a protected start that fails on the pipe says why under PROTECTION_NOT_READY, and the next start is on the pipe again', async () => {
    spawnFailing(1);
    const launcher = new ChromeLauncher('/tmp/pipe-protected-fail', { profileName: 'bank', protection: () => denyAll });
    const first = await launcher.endpoint().then(() => null, (e: unknown) => e as Error);
    expect(first?.message.startsWith(PROTECTION_NOT_READY)).toBe(true);
    expect(first?.message).toContain('Chrome exited during startup');
    spawnFailing(1);
    await launcher.endpoint().catch(() => undefined);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const n of [0, 1]) {
      expect(spawnArgs(n)).toContain('--remote-debugging-pipe');
      expect(spawnArgs(n).filter((a) => PORT_FLAGS.test(a))).toEqual([]);
    }
    await launcher.dispose({ immediate: true });
  });

  it('a protected start handed to a Chrome already on the profile says so', async () => {
    // Chrome's process singleton: a windowed start hands over and exits 0.
    spawnFailing(0);
    const launcher = new ChromeLauncher('/tmp/pipe-protected-handoff', { profileName: 'bank', protection: () => denyAll });
    const err = await launcher.endpoint().then(() => null, (e: unknown) => e as Error);
    expect(err?.message.startsWith(PROTECTION_NOT_READY)).toBe(true);
    expect(err?.message).toContain('another Chrome is still running on this profile');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await launcher.dispose({ immediate: true });
  });

  it('a DevToolsActivePort that appears under a protected pipe Chrome closes it, and the next call is told why', async () => {
    const chrome = spawnChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-protected-portfile', { profileName: 'bank', protection: () => denyAll });
    await launcher.endpoint();
    const read = vi.mocked(readFileSync);
    read.mockImplementation(((file: unknown) => {
      if (String(file).endsWith('DevToolsActivePort')) return '9222\n/devtools/browser/x';
      throw Object.assign(new Error('ENOENT (unit test)'), { code: 'ENOENT' });
    }) as typeof readFileSync);
    try {
      await vi.waitFor(() => expect(chrome.child.exitCode).not.toBeNull(), { timeout: 5_000 });
      const err = await launcher.endpoint().then(() => null, (e: unknown) => e as Error);
      expect(err?.message.startsWith(PROTECTION_NOT_READY)).toBe(true);
      expect(err?.message).toContain('a debugging port opened in the protected browser');
    } finally {
      read.mockImplementation((() => { throw Object.assign(new Error('ENOENT (unit test)'), { code: 'ENOENT' }); }) as typeof readFileSync);
    }
    await launcher.dispose({ immediate: true });
  });
});

describe('ChromeLauncher: the download guard on a protected pipe profile', () => {
  /** The guard's own browser session: the one that set deny with no context. */
  const guardSession = (chrome: ProtectedPipeChrome) =>
    chrome.received.find((m) => m.method === 'Browser.setDownloadBehavior' && m.params.behavior === 'deny' && m.params.browserContextId === undefined)?.sessionId as string;

  it('denies a new browser context the moment a target in it appears, before any tick lists it', async () => {
    const chrome = spawnChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-protected-newctx', { profileName: 'bank', protection: () => denyAll });
    await launcher.endpoint();
    await vi.waitFor(() => expect(chrome.discover.has(guardSession(chrome))).toBe(true), { timeout: 5_000 });
    // A context no list names (the fake's getBrowserContexts never lists it).
    chrome.announce({ targetId: 'INCOG', type: 'page', browserContextId: 'CTX-NEW', url: 'about:blank' });
    await vi.waitFor(() => expect(chrome.received.some((m) => m.method === 'Browser.setDownloadBehavior' && m.params.browserContextId === 'CTX-NEW' && m.params.behavior === 'deny')).toBe(true), { timeout: 5_000 });
    await launcher.dispose({ immediate: true });
  });

  it('cancels a stray download in every context it knows at once, without waiting for a list', async () => {
    const chrome = spawnChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-protected-cancel', { profileName: 'bank', protection: () => denyAll });
    await launcher.endpoint();
    const session = guardSession(chrome);
    await vi.waitFor(() => expect(chrome.discover.has(session)).toBe(true), { timeout: 5_000 });
    chrome.announce({ targetId: 'INCOG', type: 'page', browserContextId: 'CTX-NEW', url: 'about:blank' });
    await vi.waitFor(() => expect(chrome.received.some((m) => m.params.browserContextId === 'CTX-NEW')).toBe(true), { timeout: 5_000 });
    // The list answer is held: only what the guard already knew can be used.
    chrome.holdReplies.add('Target.getBrowserContexts');
    chrome.event(session, 'Browser.downloadWillBegin', { frameId: 'INCOG', guid: 'g-new', url: 'http://a.test/f', suggestedFilename: 'f' });
    await vi.waitFor(() => expect(chrome.received.some((m) => m.method === 'Browser.cancelDownload' && m.params.guid === 'g-new' && m.params.browserContextId === 'CTX-NEW')).toBe(true), { timeout: 5_000 });
    chrome.holdReplies.delete('Target.getBrowserContexts');
    chrome.releaseHeld();
    await launcher.dispose({ immediate: true });
  });
});

describe('transportFor', () => {
  const plan = denyAll;
  it.each([
    // env, protected, setting, transport
    [undefined, false, false, 'port'],
    [undefined, true, false, 'pipe'],
    [undefined, true, true, 'port (weaker)'],
    ['auto', false, false, 'port'],
    ['auto', true, false, 'pipe'],
    ['auto', true, true, 'port (weaker)'],
    ['pipe', false, false, 'pipe'],
    ['pipe', true, false, 'pipe'],
    ['pipe', true, true, 'pipe'],
    ['port', false, false, 'port'],
    ['port', true, false, 'pipe'],
    ['port', true, true, 'port (weaker)'],
  ] as const)('WMUX_CHROME_TRANSPORT=%s, protected %s, setting %s: %s', (env, isProtected, setting, label) => {
    if (env === undefined) delete process.env.WMUX_CHROME_TRANSPORT;
    else vi.stubEnv('WMUX_CHROME_TRANSPORT', env);
    expect(transportLabel(transportFor(isProtected ? plan : null, setting))).toBe(label);
  });
});
