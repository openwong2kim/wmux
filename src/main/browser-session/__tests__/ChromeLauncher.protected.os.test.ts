import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// Protected profiles in ChromeLauncher: launch behind the proxy, never adopt,
// restart when protection changes, arm the download guard — and, with no
// protection, launch with exactly the arguments it always had.

const { spawnMock, state, sockets } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  // proxyPort: the --proxy-server port of the latest spawn. routeViaProxy:
  // whether the fake Chrome's traffic reaches it (false = a profile whose
  // proxy setting is overridden).
  state: { portFiles: {} as Record<string, string>, proxyPort: 0, routeViaProxy: true, probeDelayMs: 0, reportErrorPage: false },
  sockets: [] as Array<{ sent: Array<{ method: string; params: unknown }>; closed: boolean }>,
}));
vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    existsSync: () => true,
    mkdirSync: () => undefined,
    readFileSync: vi.fn((p: unknown) => {
      const s = String(p).replace(/\\/g, '/');
      if (s.endsWith('DevToolsActivePort')) {
        for (const [dir, content] of Object.entries(state.portFiles)) {
          if (s.startsWith(dir)) return content;
        }
      }
      throw new Error('ENOENT (unit test)');
    }),
    writeFileSync: () => undefined,
  };
});
vi.mock('../CdpSocket', () => ({
  CdpSocket: class {
    rec = { sent: [] as Array<{ method: string; params: unknown }>, closed: false };
    handlers = new Map<string, (p: Record<string, unknown>) => void>();
    constructor() {
      sockets.push(this.rec);
    }
    isOpen() {
      return !this.rec.closed;
    }
    on(method: string, h: (p: Record<string, unknown>) => void) {
      this.handlers.set(method, h);
      return () => this.handlers.delete(method);
    }
    async send(method: string, params: unknown = {}) {
      this.rec.sent.push({ method, params });
      if (method === 'Target.createTarget' && !state.routeViaProxy && state.reportErrorPage) {
        // Not routed: `.invalid` fails to resolve and Chrome shows its error page.
        setTimeout(() => this.handlers.get('Target.targetInfoChanged')?.({
          targetInfo: { targetId: 'probe-target', url: 'chrome-error://chromewebdata/' },
        }), 20);
        return { targetId: 'probe-target' };
      }
      if (method === 'Target.createTarget' && state.routeViaProxy && state.proxyPort) {
        // The fake Chrome loads the URL through its proxy, as the real one does
        // (after `probeDelayMs`, like a cold Chrome on a busy runner).
        const http = await import('node:http');
        const delay = state.probeDelayMs;
        const go = (done: () => void = () => undefined) => {
          const req = http.request(
            { host: '127.0.0.1', port: state.proxyPort, method: 'GET', path: (params as { url: string }).url },
            (res) => {
              res.resume();
              res.on('end', () => done());
            },
          );
          req.on('error', () => done());
          req.end();
        };
        await new Promise<void>((resolve) => {
          if (delay) { setTimeout(() => go(), delay); resolve(); return; }
          go(resolve);
        });
        return { targetId: 'probe-target' };
      }
      return {};
    }
    close() {
      this.rec.closed = true;
    }
  },
}));

import { ChromeLauncher, type ChromeProtectionPlan } from '../ChromeLauncher';

function makeChild() {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn(() => child.emit('exit'));
  return child;
}

let nextPort = 18001;
function spawnWritesPortFile(child: EventEmitter): number {
  const port = nextPort++;
  spawnMock.mockImplementationOnce((_bin: string, args: string[]) => {
    const dir = (args.find((a) => a.startsWith('--user-data-dir=')) ?? '').slice('--user-data-dir='.length);
    state.portFiles[dir] = `${port}\n/devtools/browser/uuid-${port}\n`;
    const proxy = args.find((a) => a.startsWith('--proxy-server='));
    state.proxyPort = proxy ? Number(proxy.split(':').at(-1)) : 0;
    return child;
  });
  return port;
}

const dead = new Set<number>();
const fetchMock = vi.fn(async (url: string): Promise<{ ok: boolean; text: () => Promise<string>; json: () => Promise<unknown> }> => {
  const port = Number(/:(\d+)\//.exec(String(url))?.[1]);
  if (dead.has(port)) throw new Error('ECONNREFUSED');
  const body = { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` };
  return { ok: true, text: async () => JSON.stringify(body), json: async () => body };
});

const denyAll: ChromeProtectionPlan = { matcher: () => ({ allows: () => false }) };

beforeEach(() => {
  spawnMock.mockReset();
  state.portFiles = {};
  state.proxyPort = 0;
  state.routeViaProxy = true;
  state.probeDelayMs = 0;
  state.reportErrorPage = false;
  sockets.length = 0;
  dead.clear();
  nextPort = 18001;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChromeLauncher — protected profiles', () => {
  it('legacy: a protection hook answering null leaves the launch arguments untouched', async () => {
    spawnWritesPortFile(makeChild());
    await new ChromeLauncher('/tmp/legacy-a').ensureRunning();
    spawnWritesPortFile(makeChild());
    await new ChromeLauncher('/tmp/legacy-b', { protection: () => null }).ensureRunning();
    const [a, b] = spawnMock.mock.calls.map((c) => (c[1] as string[]).filter((x) => !x.startsWith('--user-data-dir=')));
    expect(b).toEqual(a);
    expect(sockets).toHaveLength(0); // no download guard, no CDP session of main's own
  });

  it('launches behind the proxy and arms the download guard before answering', async () => {
    spawnWritesPortFile(makeChild());
    const launcher = new ChromeLauncher('/tmp/prot-a', { protection: () => denyAll });
    await launcher.ensureRunning();
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args.some((a) => /^--proxy-server=127\.0\.0\.1:\d+$/.test(a))).toBe(true);
    expect(args).toContain('--proxy-bypass-list=<-loopback>');
    expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(args).toContain('--disable-quic');
    expect(launcher.isProtected()).toBe(true);
    expect(sockets.find((x) => x.sent[0]?.method === 'Browser.setDownloadBehavior')?.sent[0]).toEqual({
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'deny', eventsEnabled: true },
    });
    // The route was proven: a probe tab was opened through the proxy and closed.
    const probe = sockets.find((x) => x.sent.some((m) => m.method === 'Target.createTarget'));
    expect(probe?.sent.map((x) => x.method)).toEqual(['Target.setDiscoverTargets', 'Target.createTarget', 'Target.closeTarget']);
    expect(probe?.closed).toBe(true);
    launcher.dispose();
  });

  it('never adopts a running Chrome: closes it, waits for it to go, then launches', async () => {
    state.portFiles['/tmp/prot-b'] = '17999\n/devtools/browser/old\n';
    fetchMock.mockImplementationOnce(async () => ({ ok: true, text: async () => '{}', json: async () => ({}) }));
    // Browser.close lands: the endpoint dies after the evict asks.
    fetchMock.mockImplementationOnce(async () => {
      const body = { webSocketDebuggerUrl: 'ws://127.0.0.1:17999/devtools/browser/old' };
      dead.add(17999);
      return { ok: true, text: async () => JSON.stringify(body), json: async () => body };
    });
    spawnWritesPortFile(makeChild());
    const launcher = new ChromeLauncher('/tmp/prot-b', { protection: () => denyAll });
    await launcher.ensureRunning();
    expect(sockets[0].sent.map((s) => s.method)).toContain('Browser.close');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(launcher.currentPort()).toBe(18001);
    launcher.dispose();
  });

  it('never hands out a launch that was in flight when protection turned on', async () => {
    let plan: ChromeProtectionPlan | null = null;
    const first = makeChild();
    const firstPort = spawnWritesPortFile(first);
    // A killed Chrome stops answering.
    first.kill = vi.fn(() => {
      dead.add(firstPort);
      first.emit('exit');
    });
    const launcher = new ChromeLauncher('/tmp/prot-d', { protection: () => plan });
    const legacy = launcher.ensureRunning(); // starts unprotected
    plan = denyAll; // protection lands mid-launch
    spawnWritesPortFile(makeChild());
    const protectedCall = launcher.ensureRunning();
    await Promise.all([legacy, protectedCall]);
    expect(first.kill).toHaveBeenCalled();
    expect((spawnMock.mock.calls[1][1] as string[]).some((a) => a.startsWith('--proxy-server='))).toBe(true);
    expect(launcher.isProtected()).toBe(true);
    launcher.dispose();
  });

  it('restarts a running Chrome when protection turns on', async () => {
    let plan: ChromeProtectionPlan | null = null;
    const first = makeChild();
    spawnWritesPortFile(first);
    const launcher = new ChromeLauncher('/tmp/prot-c', { protection: () => plan });
    const p1 = await launcher.ensureRunning();
    expect(launcher.isProtected()).toBe(false);
    plan = denyAll;
    dead.add(p1); // the killed Chrome stops answering
    spawnWritesPortFile(makeChild());
    await launcher.ensureRunning();
    expect(first.kill).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect((spawnMock.mock.calls[1][1] as string[]).some((a) => a.startsWith('--proxy-server='))).toBe(true);
    expect(launcher.isProtected()).toBe(true);
    launcher.dispose();
  });

  it('refuses a Chrome whose traffic does not reach the proxy, and stops it', async () => {
    state.routeViaProxy = false; // e.g. a managed proxy policy overrides --proxy-server
    const child = makeChild();
    spawnWritesPortFile(child);
    const launcher = new ChromeLauncher('/tmp/prot-e', { protection: () => denyAll, proxyProbeTimeoutMs: 100 });
    await expect(launcher.ensureRunning()).rejects.toThrow(/policy_denied/);
    expect(child.kill).toHaveBeenCalled();
    expect(launcher.isProtected()).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1); // refused at once, not polled to the deadline
    launcher.dispose();
  });

  it('refuses at once when Chrome reports the probe failed to load (not routed), without waiting out a clock', async () => {
    state.routeViaProxy = false;
    state.reportErrorPage = true;
    const child = makeChild();
    spawnWritesPortFile(child);
    const launcher = new ChromeLauncher('/tmp/prot-g', { protection: () => denyAll });
    const t0 = Date.now();
    await expect(launcher.ensureRunning()).rejects.toThrow(/policy_denied/);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(child.kill).toHaveBeenCalled();
    launcher.dispose();
  });

  it('accepts a routed Chrome that is slow to issue the probe (cold start past the old 5 s cutoff)', async () => {
    state.probeDelayMs = 5_500;
    spawnWritesPortFile(makeChild());
    const launcher = new ChromeLauncher('/tmp/prot-h', { protection: () => denyAll });
    await expect(launcher.ensureRunning()).resolves.toBeGreaterThan(0);
    expect(launcher.isProtected()).toBe(true);
    launcher.dispose();
  }, 15_000);

  it('concurrent callers re-arm one download guard, not two', async () => {
    spawnWritesPortFile(makeChild());
    const launcher = new ChromeLauncher('/tmp/prot-f', { protection: () => denyAll });
    await launcher.ensureRunning();
    const guards = () => sockets.filter((x) => x.sent[0]?.method === 'Browser.setDownloadBehavior');
    guards()[0].closed = true; // the guard's socket dropped
    await Promise.all([launcher.ensureRunning(), launcher.ensureRunning(), launcher.ensureRunning()]);
    expect(guards()).toHaveLength(2);
    expect(guards().filter((g) => !g.closed)).toHaveLength(1);
    launcher.dispose();
  });

  it('closes the proxy when protection turns off', async () => {
    let plan: ChromeProtectionPlan | null = denyAll;
    const first = makeChild();
    const firstPort = spawnWritesPortFile(first);
    first.kill = vi.fn(() => {
      dead.add(firstPort);
      first.emit('exit');
    });
    const launcher = new ChromeLauncher('/tmp/prot-g', { protection: () => plan });
    await launcher.ensureRunning();
    const proxyPort = state.proxyPort;
    plan = null;
    spawnWritesPortFile(makeChild());
    await launcher.ensureRunning();
    expect(launcher.isProtected()).toBe(false);
    const net = await import('node:net');
    const refused = await new Promise<boolean>((resolve) => {
      const sock = net.connect(proxyPort, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(false); });
      sock.once('error', () => resolve(true));
    });
    expect(refused).toBe(true);
    launcher.dispose();
  });

  it('force-stops a Chrome that will not exit when protection turns on', async () => {
    let plan: ChromeProtectionPlan | null = null;
    const first = makeChild();
    const firstPort = spawnWritesPortFile(first);
    // A polite kill is ignored; only SIGKILL takes it down.
    first.kill = vi.fn((signal?: string) => {
      if (signal !== 'SIGKILL') return true;
      dead.add(firstPort);
      first.emit('exit');
      return true;
    });
    const launcher = new ChromeLauncher('/tmp/prot-h', { protection: () => plan });
    await launcher.ensureRunning();
    plan = denyAll;
    spawnWritesPortFile(makeChild());
    await launcher.ensureRunning();
    expect(first.kill).toHaveBeenCalledWith('SIGKILL');
    expect(launcher.isProtected()).toBe(true);
    launcher.dispose();
  }, 20_000);
});

describe('ChromeLauncher — recently blocked hosts (#2063)', () => {
  /** What the fake Chrome's CONNECT through the profile's proxy gets back. */
  async function connectViaProxy(authority: string): Promise<string> {
    const net = await import('node:net');
    return new Promise((resolve) => {
      const s = net.connect(state.proxyPort, '127.0.0.1', () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
      s.once('data', (d) => {
        resolve(d.toString().split('\r\n')[0]);
        s.destroy();
      });
      s.on('error', () => resolve('error'));
    });
  }

  it("records the proxy's refusals of real hosts, and starts over when Chrome launches again", async () => {
    const first = makeChild();
    const firstPort = spawnWritesPortFile(first);
    const launcher = new ChromeLauncher('/tmp/blocked-a', { protection: () => denyAll });
    await launcher.ensureRunning();
    expect(await connectViaProxy('cdn.blocked.test:443')).toContain('403');
    expect(await connectViaProxy('cdn.blocked.test:443')).toContain('403');
    expect(await connectViaProxy('localhost:3000')).toContain('403');
    expect(launcher.blockedHosts()).toEqual([
      expect.objectContaining({ host: 'cdn.blocked.test', port: 443, count: 2 }),
    ]);
    // The probe that proved the route is never on the list.
    expect(launcher.blockedHosts().some((b) => b.host.endsWith('.invalid'))).toBe(false);

    // Chrome goes away and is launched again on demand.
    dead.add(firstPort);
    first.emit('exit');
    spawnWritesPortFile(makeChild());
    await launcher.ensureRunning();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(launcher.blockedHosts()).toEqual([]);
    expect(await connectViaProxy('api.blocked.test:8443')).toContain('403');
    expect(launcher.blockedHosts().map((b) => `${b.host}:${b.port}`)).toEqual(['api.blocked.test:8443']);
    launcher.dispose();
  });

  it('the registry answers per profile and clears every list on a policy change', async () => {
    const { ChromeLauncherRegistry } = await import('../ChromeLauncher');
    // The 'default' profile runs in `defaultDir` as given, which the fake
    // DevToolsActivePort reader matches on every platform.
    const registry = new ChromeLauncherRegistry({
      defaultDir: '/tmp/blocked-default',
      profilesDir: '/tmp/blocked-profiles',
      store: { profileFor: () => 'default', hasPaneBindings: () => true, isPaneBound: () => true },
      protection: () => denyAll,
    });
    expect(registry.blockedHostsFor('default')).toEqual([]); // no launcher yet, none created
    expect(registry.peekLauncher('default')).toBeUndefined();
    spawnWritesPortFile(makeChild());
    const launcher = registry.forProfile('default') as ChromeLauncher;
    await launcher.ensureRunning();
    expect(await connectViaProxy('login.blocked.test:443')).toContain('403');
    expect(registry.blockedHostsFor('default').map((b) => b.host)).toEqual(['login.blocked.test']);
    expect(registry.blockedHostsFor('other')).toEqual([]);
    registry.clearBlockedHosts();
    expect(registry.blockedHostsFor('default')).toEqual([]);
    launcher.dispose();
  });
});
