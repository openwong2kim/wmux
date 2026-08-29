import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { LiveChromeClient, readLiveChromeEndpoint, isLiveChromeReachable, probeTcpListening } from '../LiveChromeClient';

// Live-Chrome attach (Phase 3): DevToolsActivePort discovery + CDP-over-WS.

describe('readLiveChromeEndpoint', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmux-live-chrome-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses port + secret path into a ws endpoint', () => {
    writeFileSync(join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/abc-123\n');
    expect(readLiveChromeEndpoint(dir)).toBe('ws://127.0.0.1:9333/devtools/browser/abc-123');
  });

  it('missing or malformed file yields the chrome://inspect guidance', () => {
    expect(() => readLiveChromeEndpoint(dir)).toThrow('chrome://inspect');
    writeFileSync(join(dir, 'DevToolsActivePort'), 'not-a-port\n');
    expect(() => readLiveChromeEndpoint(dir)).toThrow('chrome://inspect');
  });
});

describe('isLiveChromeReachable', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmux-live-reach-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function openListener(): Promise<Server> {
    const s = createServer();
    await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
    return s;
  }
  function portOf(s: Server): number {
    const addr = s.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }
  function closeListener(s: Server): Promise<void> {
    return new Promise<void>((res) => (s.listening ? s.close(() => res()) : res()));
  }

  it('no DevToolsActivePort file → not reachable', async () => {
    expect(await isLiveChromeReachable(dir)).toBe(false);
  });

  it('a parseable file whose port is actually listening → reachable', async () => {
    const server = await openListener();
    try {
      writeFileSync(join(dir, 'DevToolsActivePort'), `${portOf(server)}\n/devtools/browser/abc\n`);
      expect(await isLiveChromeReachable(dir)).toBe(true);
    } finally {
      await closeListener(server);
    }
  });

  it('a parseable file pointing at a DEAD port → not reachable (the stale-file false positive)', async () => {
    const server = await openListener();
    const port = portOf(server);
    await closeListener(server); // kill the listener → the port is now dead
    writeFileSync(join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/abc\n`);
    // The file still parses cleanly — the exact shape a force-killed Chrome
    // leaves behind — but nothing listens, so reachability must be false.
    expect(readLiveChromeEndpoint(dir)).toBe(`ws://127.0.0.1:${port}/devtools/browser/abc`);
    expect(await isLiveChromeReachable(dir)).toBe(false);
  });

  it('a black-holed host trips the timeout → false, and stays bounded (the safety net)', async () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): never routed, so the SYN is dropped —
    // the connect neither lands nor is refused, which is the exact hang the
    // timeout guards. A tight budget keeps it fast; the result is false whether
    // it times out (normal) or the host errors as unreachable (locked-down box).
    const started = Date.now();
    expect(await probeTcpListening('192.0.2.1', 9222, 150)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000); // bounded, never hung
  });
});

// ── CDP over a stubbed global WebSocket ────────────────────────────────────

type Listener = (ev: { data?: string }) => void;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open', {});
    });
  }

  addEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  emit(type: string, ev: { data?: string }): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  /** Test helper: answer the most recent request. */
  reply(result: unknown): void {
    const last = this.sent[this.sent.length - 1];
    this.emit('message', { data: JSON.stringify({ id: last.id, result }) });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LiveChromeClient CDP', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmux-live-chrome-'));
    writeFileSync(join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/abc\n');
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('lists page targets only, opens/closes/activates tabs over CDP', async () => {
    const client = new LiveChromeClient(dir);

    const listP = client.listTargets();
    await tick(); // let the socket open + the request go out
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('ws://127.0.0.1:9333/devtools/browser/abc');
    expect(ws.sent[0]).toMatchObject({ method: 'Target.getTargets' });
    ws.reply({
      targetInfos: [
        { targetId: 't1', type: 'page', title: 'A', url: 'https://a.test/' },
        { targetId: 't2', type: 'service_worker', title: 'sw', url: 'https://a.test/sw.js' },
        { targetId: 't3', type: 'page', title: 'devtools', url: 'devtools://x' },
      ],
    });
    // Live keeps surfaceId ≡ targetId (the engine matches pre-existing user
    // tabs against Chrome's own target list by that id).
    expect(await listP).toEqual([{ surfaceId: 't1', targetId: 't1', url: 'https://a.test/', title: 'A' }]);

    const openP = client.openTab('https://b.test/');
    await tick();
    expect(ws.sent[1]).toMatchObject({ method: 'Target.createTarget', params: { url: 'https://b.test/' } });
    ws.reply({ targetId: 't9' });
    expect(await openP).toEqual({ surfaceId: 't9', targetId: 't9', url: 'https://b.test/' });

    const selP = client.selectSurface('t1');
    await tick();
    expect(ws.sent[2]).toMatchObject({ method: 'Target.activateTarget', params: { targetId: 't1' } });
    ws.reply({});
    expect(await selP).toBe(true);

    // Every live tab is addressable.
    expect(client.hasSurface('t1')).toBe(true);
    // cdp.info seeds ONLY wmux-opened tabs: t9 (opened above) is seeded, the
    // user's own t1 is not — a random user tab never becomes the default pin.
    const seedP = client.cdpInfoTargets();
    await tick();
    expect(ws.sent[3]).toMatchObject({ method: 'Target.getTargets' });
    ws.reply({
      targetInfos: [
        { targetId: 't1', type: 'page', title: 'A', url: 'https://a.test/' },
        { targetId: 't9', type: 'page', title: 'B', url: 'https://b.test/' },
      ],
    });
    expect(await seedP).toEqual([
      { surfaceId: 't9', targetId: 't9', workspaceId: undefined, url: 'https://b.test/', title: 'B' },
    ]);
    expect((await client.endpoint()).wsEndpoint).toBe('ws://127.0.0.1:9333/devtools/browser/abc');
  });

  it('cdpInfoTargets before any wmux-open seeds nothing and never dials the socket', async () => {
    const client = new LiveChromeClient(dir);
    expect(await client.cdpInfoTargets()).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('cdpInfoTargets filters by owning workspace and prunes dead tabs', async () => {
    const client = new LiveChromeClient(dir);
    const openA = client.openTab('https://a.test/', 'ws-a');
    await tick();
    const ws = FakeWebSocket.instances[0];
    ws.reply({ targetId: 'ta' });
    await openA;
    const openB = client.openTab('https://b.test/', 'ws-b');
    await tick();
    ws.reply({ targetId: 'tb' });
    await openB;

    // tb has died in Chrome; ta belongs to ws-a.
    const forA = client.cdpInfoTargets('ws-a');
    await tick();
    ws.reply({ targetInfos: [{ targetId: 'ta', type: 'page', title: 'A', url: 'https://a.test/' }] });
    expect(await forA).toEqual([
      { surfaceId: 'ta', targetId: 'ta', workspaceId: 'ws-a', url: 'https://a.test/', title: 'A' },
    ]);

    const forB = client.cdpInfoTargets('ws-b');
    await tick();
    ws.reply({ targetInfos: [{ targetId: 'ta', type: 'page', title: 'A', url: 'https://a.test/' }] });
    expect(await forB).toEqual([]); // tb pruned as dead; ta owned by ws-a
  });

  it('dispose closes the socket only and rejects in-flight calls', async () => {
    const client = new LiveChromeClient(dir);
    const p = client.listTargets();
    await tick();
    client.dispose();
    await expect(p).rejects.toThrow('disposed');
  });
});
