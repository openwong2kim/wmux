import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'node:stream';
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

import { ChromeLauncher, chromeSaid, chromeTransportKind, setPipeRelayForTests } from '../ChromeLauncher';
import { CdpPipeRelay, type RelayGrant } from '../CdpPipeRelay';
import { CDP_PIPE_COMMAND_TIMEOUT_MS } from '../CdpPipeMux';
import { CHROME_START_CEILING_MS } from '../../../shared/chromeStart';

type FakeChild = EventEmitter & { kill: (signal?: string) => void; stdio: unknown[]; stderr: PassThrough; killed: boolean; exitCode: number | null; signalCode: string | null; signals: string[] };

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
  child.stderr = new PassThrough();
  child.stdio = [null, null, child.stderr, chrome.fromMux, chrome.toMux];
  child.kill = (signal = 'SIGTERM') => {
    child.signals.push(signal);
    child.killed = true;
    if (exitsOn(signal) && child.exitCode === null) chrome.exit();
  };
  spawnMock.mockImplementationOnce(() => child);
  return { child, chrome };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  // Loopback TCP: no socket dir in any temp dir another wmux uses.
  await setPipeRelayForTests(new CdpPipeRelay({ roots: [] }));
  spawnMock.mockReset();
  state.portFiles = {};
  fetchMock = vi.fn(async () => { throw new Error('nothing listening'); });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('WMUX_CHROME_TRANSPORT', 'pipe');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await setPipeRelayForTests(null);
});

function dial(grant: RelayGrant): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(grant.endpoint, { headers: { ...grant.headers } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

describe('ChromeLauncher over a debugging pipe', () => {
  it('is off by default', () => {
    vi.unstubAllEnvs();
    expect(chromeTransportKind()).toBe('port');
    vi.stubEnv('WMUX_CHROME_TRANSPORT', 'pipe');
    expect(chromeTransportKind()).toBe('pipe');
  });

  it('starts Edge with implicit sign-in and sync off, and Chrome without those flags', async () => {
    for (const [binary, edge] of [['/opt/microsoft/msedge/msedge', true], ['/opt/google/chrome/chrome', false]] as const) {
      spawnMock.mockClear();
      vi.stubEnv('WMUX_CHROME_PATH', binary);
      spawnPipeChrome();
      const launcher = new ChromeLauncher('/tmp/pipe-profile');
      await launcher.endpoint();
      const [spawned, args] = spawnMock.mock.calls[0] as [string, string[]];
      expect(spawned).toBe(binary);
      expect(args.filter((a) => a.startsWith('--disable-features='))).toEqual(edge ? ['--disable-features=msImplicitSignin'] : []);
      expect(args.includes('--disable-sync')).toBe(edge);
      await launcher.dispose({ immediate: true });
    }
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
    // stderr is read, so a failed start can quote Chrome.
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe', 'pipe', 'pipe']);
    // No childEnv: the child inherits process.env, as before.
    expect(opts).not.toHaveProperty('env');
    expect(chrome.received.find((c) => c.method === 'Browser.getVersion')).toBeDefined();
    // Nothing went to a port.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(launcher.isRunning()).toBe(true);
    await launcher.dispose({ immediate: true });
  });

  it('names no port or endpoint for a pipe Chrome, and hands each caller its own relay token, good for that Chrome only', async () => {
    const { chrome } = spawnPipeChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    expect(await launcher.endpoint()).toEqual({ piped: true });
    const grant = await launcher.relayGrant({ workspaceId: 'ws-a' });
    const other = await launcher.relayGrant({ workspaceId: 'ws-a' });
    expect(other.headers.Authorization).not.toBe(grant.headers.Authorization);
    const ws = await dial(grant);
    const answer = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
      ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    });
    expect(answer).toEqual({ id: 1, result: { echo: 'Browser.getVersion' } });
    // Its connections and unused tokens go with the Chrome.
    const closed = new Promise((resolve) => ws.once('close', resolve));
    chrome.exit();
    await closed;
    await expect(dial(other)).rejects.toThrow('HTTP 401');
    await expect(launcher.relayGrant({})).rejects.toThrow('Chrome exited');
  });

  it('a token minted before the Chrome was restarted does not reach the new one', async () => {
    const first = spawnPipeChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    await launcher.endpoint();
    const stale = await launcher.relayGrant({});
    first.chrome.exit();
    spawnPipeChrome();
    await vi.waitFor(async () => expect(await launcher.endpoint()).toEqual({ piped: true }), { timeout: 5_000 });
    await expect(dial(stale)).rejects.toThrow('HTTP 401');
    (await dial(await launcher.relayGrant({}))).close();
    await launcher.dispose({ immediate: true });
  });

  it('names no port for a pipe Chrome', async () => {
    spawnPipeChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    await launcher.endpoint();
    expect(launcher.isRunning()).toBe(true);
    expect(launcher.currentPort()).toBeNull();
    await launcher.dispose({ immediate: true });
  });

  it('a relay that failed to listen is tried again on the next token', async () => {
    spawnPipeChrome();
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    await launcher.endpoint();
    vi.spyOn(CdpPipeRelay.prototype as unknown as { listen: () => Promise<unknown> }, 'listen').mockRejectedValueOnce(new Error('listen EACCES'));
    await expect(launcher.relayGrant({})).rejects.toThrow('listen EACCES');
    expect((await launcher.relayGrant({})).endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/);
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

  it('a start that fails says why: the last startup error and what Chrome wrote on stderr', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { child } = spawnPipeChrome(SlowPipeChrome);
    const launcher = new ChromeLauncher('/tmp/pipe-profile');
    const launched = launcher.endpoint();
    const outcome = launched.then(() => null, (err: Error) => err.message);
    // What Chrome on Windows says when it refuses remote debugging, then noise.
    child.stderr.write('DevTools remote debugging requires a non-default data directory. Specify this using --user-data-dir.\r\n');
    child.stderr.write('Created TensorFlow Lite XNNPACK delegate for CPU.\r\n');
    // Past the start ceiling, plus the last attempt's own command timeout.
    await vi.advanceTimersByTimeAsync(CHROME_START_CEILING_MS + CDP_PIPE_COMMAND_TIMEOUT_MS + 2_000);
    const message = await outcome;
    expect(message).toContain('ChromeLauncher: CDP endpoint did not become ready in time');
    expect(message).toContain('last error: ChromeLauncher: Browser.getVersion timed out');
    expect(message).toContain('Chrome said: DevTools remote debugging requires a non-default data directory. Specify this using --user-data-dir. | Created TensorFlow Lite');
    await launcher.dispose({ immediate: true });
  });

  it('gives Chrome the childEnv test seam as its whole environment', async () => {
    spawnPipeChrome();
    const env = { PATH: '/bin', USERPROFILE: 'C:\\Users\\someone' };
    const launcher = new ChromeLauncher('/tmp/pipe-profile', { childEnv: env });
    await launcher.endpoint();
    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(opts.env).toBe(env);
    await launcher.dispose({ immediate: true });
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

describe('chromeSaid', () => {
  it('keeps the last few non-empty lines, one each', () => {
    expect(chromeSaid('a\r\n\r\nb\nc\nd\n')).toBe('b | c | d');
    expect(chromeSaid('only\n')).toBe('only');
  });

  it('is null when Chrome said nothing', () => {
    expect(chromeSaid('')).toBeNull();
    expect(chromeSaid('\r\n  \n')).toBeNull();
  });

  it('keeps the newest part of a long line', () => {
    const said = chromeSaid(`${'x'.repeat(500)}END`, [], 3, 50) as string;
    expect(said).toHaveLength(51);
    expect(said.startsWith('…')).toBe(true);
    expect(said.endsWith('END')).toBe(true);
  });

  it('writes a home folder as ~ in its backslash, forward-slash, file URL and JSON-escaped spellings', () => {
    const home = 'C:\\Users\\someone';
    expect(chromeSaid('cannot open C:\\Users\\someone\\AppData\\x\n', [home])).toBe('cannot open ~\\AppData\\x');
    expect(chromeSaid('Failed to load file:///C:/Users/someone/a.html\n', [home])).toBe('Failed to load file:///~/a.html');
    expect(chromeSaid('{"path":"C:\\\\Users\\\\someone\\\\x"}\n', [home])).toBe('{"path":"~\\\\x"}');
    expect(chromeSaid('at /home/someone/.config and /home/someone\n', ['/home/someone/'])).toBe('at ~/.config and ~');
  });

  it('masks a home only where the path ends there', () => {
    expect(chromeSaid('C:\\Users\\someoneelse\\x\n', ['C:\\Users\\someone'])).toBe('C:\\Users\\someoneelse\\x');
  });

  it('skips a root-like or empty home', () => {
    const text = '/usr/lib/chromium/chrome: error while loading C:\\x\n';
    expect(chromeSaid(text, ['/', 'C:\\', 'C:', ''])).toBe('/usr/lib/chromium/chrome: error while loading C:\\x');
  });

  it('never splits a character outside the BMP when it cuts', () => {
    const said = chromeSaid(`${'😀'.repeat(60)}\n`, [], 3, 50) as string;
    expect(Array.from(said)).toHaveLength(51);
    expect(said).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
