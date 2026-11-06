import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { FakeBrowser, type Command } from './fakePipeBrowser';

// WMUX_CHROME_TRANSPORT=pipe: the dedicated Chrome is spawned with a debugging
// pipe instead of a port, reached through the pipe transport, and keeps the
// launcher's ready state. Same fakes as ChromeLauncher.readyState.test.ts.

const { spawnMock, state } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  state: { portFiles: {} as Record<string, string> },
}));
vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' }, autoUpdater: {}, ipcMain: {}, net: {}, shell: {} }));
vi.mock('node:fs', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    existsSync: () => true,
    mkdirSync: () => undefined,
    readFileSync: vi.fn((p: unknown) => {
      const s = String(p).replace(/\\/g, '/');
      if (s.endsWith('DevToolsActivePort')) {
        for (const [dir, content] of Object.entries(state.portFiles)) if (s.startsWith(dir)) return content;
      }
      throw new Error('ENOENT (unit test)');
    }),
    writeFileSync: () => undefined,
    unlinkSync: vi.fn((p: unknown) => {
      const s = String(p).replace(/\\/g, '/');
      for (const dir of Object.keys(state.portFiles)) if (s.startsWith(dir) && s.endsWith('DevToolsActivePort')) delete state.portFiles[dir];
    }),
  };
});

import { ChromeLauncher, chromeTransportKind } from '../ChromeLauncher';
import { CdpPipeEndpoint } from '../CdpPipeEndpoint';

type FakeChild = EventEmitter & { kill: (signal?: string) => void; stdio: unknown[]; killed: boolean; exitCode: number | null; signalCode: string | null; signals: string[] };

/** A browser that exits (and closes its pipe) on Browser.close. */
class PipeChrome extends FakeBrowser {
  constructor(private readonly child: FakeChild) {
    super();
  }

  protected override handle(c: Command): void {
    if (c.method === 'Browser.close') {
      this.reply(c, '"result":{}');
      setImmediate(() => this.exit());
      return;
    }
    super.handle(c);
  }

  exit(): void {
    this.toMux.end();
    this.child.exitCode = 0;
    this.child.emit('exit', 0, null);
  }
}

/** A browser on a cold start: it reads its commands but answers none until start(). */
class SlowPipeChrome extends PipeChrome {
  private held: Command[] | null = [];

  protected override handle(c: Command): void {
    if (this.held) this.held.push(c);
    else super.handle(c);
  }

  start(): void {
    const held = this.held ?? [];
    this.held = null;
    for (const c of held) super.handle(c);
  }

  /** Answer nothing from now on, while still running. */
  stall(): void {
    this.held ??= [];
  }
}

/** `exitsOn`: the signals the fake process exits on (any, by default). */
function spawnPipeChrome<T extends PipeChrome = PipeChrome>(
  Kind: new (child: FakeChild) => T = PipeChrome as new (child: FakeChild) => T,
  exitsOn: (signal: string) => boolean = () => true,
): { child: FakeChild; chrome: T } {
  const child = new EventEmitter() as FakeChild;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  const chrome = new Kind(child);
  child.stdio = [null, null, null, chrome.fromMux, chrome.toMux];
  child.kill = (signal = 'SIGTERM') => {
    child.signals.push(signal);
    child.killed = true;
    if (exitsOn(signal) && child.exitCode === null) chrome.exit();
  };
  spawnMock.mockImplementationOnce(() => child);
  return { child, chrome };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  spawnMock.mockReset();
  state.portFiles = {};
  fetchMock = vi.fn(async () => { throw new Error('nothing listening'); });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('WMUX_CHROME_TRANSPORT', 'pipe');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ChromeLauncher over a debugging pipe', () => {
  it('is off by default', () => {
    vi.unstubAllEnvs();
    expect(chromeTransportKind()).toBe('port');
    vi.stubEnv('WMUX_CHROME_TRANSPORT', 'pipe');
    expect(chromeTransportKind()).toBe('pipe');
  });

  it('spawns Chrome with the pipe on fds 3 and 4 and no port, probes it with Browser.getVersion, and reports it running', async () => {
    const { chrome } = spawnPipeChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    await launcher.endpoint();
    const [, args, opts] = spawnMock.mock.calls[0] as [string, string[], { stdio: unknown }];
    expect(args).toContain('--remote-debugging-pipe');
    expect(args.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
    expect(args).not.toContain('--remote-allow-origins=*');
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'ignore', 'pipe', 'pipe']);
    expect(chrome.received.find((c) => c.method === 'Browser.getVersion')).toBeDefined();
    // Nothing went to a port.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(launcher.isRunning()).toBe(true);
    await launcher.dispose({ immediate: true });
  });

  it('hands external clients a loopback endpoint on the pipe, which goes with the Chrome', async () => {
    const { chrome } = spawnPipeChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    const { wsEndpoint, cdpPort } = await launcher.endpoint();
    expect(cdpPort).toBeUndefined();
    expect(wsEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f]{64}$/);
    // The same endpoint on every call while that Chrome lives.
    expect((await launcher.endpoint()).wsEndpoint).toBe(wsEndpoint);
    const ws = new WebSocket(wsEndpoint as string);
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.once('error', reject);
      ws.once('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })));
      ws.on('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
    });
    expect(answer).toEqual({ id: 1, result: { echo: 'Browser.getVersion' } });
    const closed = new Promise((resolve) => ws.once('close', resolve));
    chrome.exit();
    await closed;
    await expect(new Promise((resolve, reject) => {
      const again = new WebSocket(wsEndpoint as string);
      again.once('open', resolve);
      again.once('error', reject);
    })).rejects.toThrow();
  });

  it('refuses a protected profile on the pipe, naming it, before anything is spawned or dialed', async () => {
    const launcher = new ChromeLauncher('/tmp/pipe-protected', { profileName: 'bank', protection: () => ({ matcher: () => ({ allows: () => false }) }) });
    await expect(launcher.endpoint()).rejects.toThrow('policy_denied: the protected browser profile "bank" can\'t start with WMUX_CHROME_TRANSPORT=pipe');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(launcher.isRunning()).toBe(false);
  });

  it('names no port for a pipe Chrome', async () => {
    spawnPipeChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    await launcher.endpoint();
    expect(launcher.isRunning()).toBe(true);
    expect(launcher.currentPort()).toBeNull();
    await launcher.dispose({ immediate: true });
  });

  it('a loopback endpoint that failed to open is opened again on the next call', async () => {
    spawnPipeChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    vi.spyOn(CdpPipeEndpoint, 'open').mockRejectedValueOnce(new Error('listen EACCES'));
    await expect(launcher.endpoint()).rejects.toThrow('listen EACCES');
    expect((await launcher.endpoint()).wsEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/);
    await launcher.dispose({ immediate: true });
  });

  describe('a pipe Chrome that stops answering', () => {
    async function stalled(exitsOn?: (signal: string) => boolean) {
      const { chrome, child } = spawnPipeChrome(SlowPipeChrome, exitsOn);
      chrome.start();
      const launcher = new ChromeLauncher('/tmp/pipe-profile');
      await launcher.endpoint();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      chrome.stall();
      return { chrome, child, launcher };
    }
    /** One liveness check that times out; `sleepMs` of wall clock jumps by while it waits. */
    async function failedCheck(launcher: ChromeLauncher, sleepMs = 0) {
      const call = launcher.endpoint();
      const settled = call.then(() => 'ok', (err: Error) => err.message);
      if (sleepMs) vi.setSystemTime(Date.now() + sleepMs);
      await vi.advanceTimersByTimeAsync(10_500);
      return settled;
    }

    it('is stopped at the third failed check in a row, not before, and a new one is started', async () => {
      const { chrome, child, launcher } = await stalled();
      expect(await failedCheck(launcher)).toBe('ChromeLauncher: Chrome is not answering');
      expect(await failedCheck(launcher)).toBe('ChromeLauncher: Chrome is not answering');
      expect(child.killed).toBe(false);
      expect(launcher.isRunning()).toBe(true);
      const next = spawnPipeChrome();
      const third = launcher.endpoint();
      for (let i = 0; i < 100 && spawnMock.mock.calls.length < 2; i++) await vi.advanceTimersByTimeAsync(250);
      expect(child.killed).toBe(true);
      expect(chrome.fromMux.writableEnded).toBe(true);
      for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(250);
      await third;
      expect(next.child.killed).toBe(false);
      await launcher.dispose({ immediate: true });
    });

    it('one that ignores SIGTERM gets SIGKILL after the grace, and the new start waits for it to exit', async () => {
      const { child, launcher } = await stalled((signal) => signal === 'SIGKILL');
      await failedCheck(launcher);
      await failedCheck(launcher);
      const next = spawnPipeChrome();
      const third = launcher.endpoint();
      await vi.advanceTimersByTimeAsync(10_500);
      expect(child.signals).toEqual(['SIGTERM']);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
      for (let i = 0; i < 60 && spawnMock.mock.calls.length < 2; i++) await vi.advanceTimersByTimeAsync(250);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(250);
      await third;
      expect(next.child.killed).toBe(false);
      await launcher.dispose({ immediate: true });
    });

    it('one that never exits fails the new start with a clear error instead of starting another on its profile', async () => {
      const { child, launcher } = await stalled(() => false);
      await failedCheck(launcher);
      await failedCheck(launcher);
      const third = launcher.endpoint().then(() => 'started', (err: Error) => err.message);
      // The check's 10 s, the 2 s grace, the 3 s wait after SIGKILL, and the launch's own 3 s more.
      await vi.advanceTimersByTimeAsync(10_500 + 2_000 + 3_000 + 3_000 + 500);
      expect(await third).toBe('ChromeLauncher: the previous Chrome on this profile has not exited');
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL']);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      await launcher.dispose({ immediate: true });
      expect(child.signals.at(-1)).toBe('SIGKILL');
    });

    it('a check whose wait spans a sleep does not count, and checks running at once count once', async () => {
      const { child, launcher } = await stalled();
      expect(await failedCheck(launcher, 60_000)).toBe('ChromeLauncher: Chrome is not answering');
      // Two at once, then one more: two misses in all.
      const both = Promise.all([launcher.endpoint().catch((e: Error) => e.message), launcher.endpoint().catch((e: Error) => e.message)]);
      await vi.advanceTimersByTimeAsync(10_500);
      expect(await both).toEqual(['ChromeLauncher: Chrome is not answering', 'ChromeLauncher: Chrome is not answering']);
      expect(await failedCheck(launcher)).toBe('ChromeLauncher: Chrome is not answering');
      expect(child.killed).toBe(false);
      await launcher.dispose({ immediate: true });
    });

    it('a check that is answered starts the count again', async () => {
      const { chrome, child, launcher } = await stalled();
      expect(await failedCheck(launcher)).toBe('ChromeLauncher: Chrome is not answering');
      expect(await failedCheck(launcher)).toBe('ChromeLauncher: Chrome is not answering');
      chrome.start();
      expect(await failedCheck(launcher)).toBe('ok');
      chrome.stall();
      expect(await failedCheck(launcher)).toBe('ChromeLauncher: Chrome is not answering');
      expect(await failedCheck(launcher)).toBe('ChromeLauncher: Chrome is not answering');
      expect(child.killed).toBe(false);
      await launcher.dispose({ immediate: true });
    });
  });

  it('opens and lists tabs on the pipe', async () => {
    const { chrome } = spawnPipeChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    const tab = await launcher.openTab('http://127.0.0.1:1/page');
    expect(tab.targetId).toMatch(/^T/);
    expect(chrome.received.some((c) => c.method === 'Target.createTarget' && c.params.url === 'http://127.0.0.1:1/page')).toBe(true);
    const listed = await launcher.listTargets();
    expect(listed.map((t) => t.targetId)).toEqual([tab.targetId]);
    await launcher.dispose({ immediate: true });
  });

  it('does not adopt a Chrome recorded on the profile: one still answering is closed first', async () => {
    state.portFiles['/tmp/pipe-old'] = '9444\n/devtools/browser/old\n';
    // The recorded port answers once (the eviction's liveness check), then is gone.
    let answered = false;
    fetchMock.mockImplementation(async () => {
      if (answered) throw new Error('gone');
      answered = true;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}', body: { cancel: async () => undefined } };
    });
    spawnPipeChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-old');
    await launcher.endpoint();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(launcher.isRunning()).toBe(true);
    // The record is dropped: the next start never dials that port again, whatever took it since.
    expect(state.portFiles['/tmp/pipe-old']).toBeUndefined();
    await launcher.dispose({ immediate: true });
    const dialed = fetchMock.mock.calls.length;
    spawnPipeChrome();
    await launcher.endpoint().catch(() => undefined);
    expect(fetchMock.mock.calls.length).toBe(dialed);
  });

  it('a Chrome that exits leaves the launcher stopped', async () => {
    const { chrome } = spawnPipeChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    await launcher.endpoint();
    chrome.exit();
    expect(launcher.isRunning()).toBe(false);
  });

  // A first start after the install changed reads it from a cold disk before it
  // answers: 21.8 s for the first headless Chrome on a windows-latest runner.
  it('waits on a cold start that answers within the start ceiling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { chrome, child } = spawnPipeChrome(SlowPipeChrome);
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    let ready = false;
    const launched = launcher.endpoint().then(() => { ready = true; });
    await vi.advanceTimersByTimeAsync(22_000);
    expect(ready).toBe(false);
    expect(child.killed).toBe(false);
    chrome.start();
    // Then the launch's restored-tab settle, as on the port.
    for (let i = 0; i < 40 && !ready; i++) await vi.advanceTimersByTimeAsync(250);
    await launched;
    // The attempts that timed out shared the one browser session still being attached.
    expect(chrome.received.filter((c) => c.method === 'Target.attachToBrowserTarget')).toHaveLength(1);
    expect(launcher.isRunning()).toBe(true);
    await launcher.dispose({ immediate: true });
  });

  it('gives up on a Chrome that never answers once the start ceiling passes, and stops it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { child } = spawnPipeChrome(SlowPipeChrome);
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    const launched = launcher.endpoint();
    const failed = expect(launched).rejects.toThrow('ChromeLauncher: CDP endpoint did not become ready in time');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(child.killed).toBe(false);
    // Past the 30 s ceiling; the last attempt may still hold its own 10 s.
    await vi.advanceTimersByTimeAsync(12_000);
    await failed;
    expect(child.killed).toBe(true);
    expect(launcher.isRunning()).toBe(false);
  });

  it('quits through Browser.close on the pipe', async () => {
    const { chrome, child } = spawnPipeChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    await launcher.endpoint();
    await launcher.dispose();
    expect(chrome.received.some((c) => c.method === 'Browser.close')).toBe(true);
    expect(child.killed).toBe(false);
  });
});
