import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveChromeClient, readLiveChromeEndpoint } from '../LiveChromeClient';

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
    expect(await listP).toEqual([{ targetId: 't1', url: 'https://a.test/', title: 'A' }]);

    const openP = client.openTab('https://b.test/');
    await tick();
    expect(ws.sent[1]).toMatchObject({ method: 'Target.createTarget', params: { url: 'https://b.test/' } });
    ws.reply({ targetId: 't9' });
    expect(await openP).toEqual({ targetId: 't9', url: 'https://b.test/' });

    const selP = client.selectTab('t1');
    await tick();
    expect(ws.sent[2]).toMatchObject({ method: 'Target.activateTarget', params: { targetId: 't1' } });
    ws.reply({});
    expect(await selP).toBe(true);

    // Every live tab is addressable; cdp.info seeds none (safe default).
    expect(client.hasTab()).toBe(true);
    expect(await client.cdpInfoTargets()).toEqual([]);
    expect((await client.endpoint()).wsEndpoint).toBe('ws://127.0.0.1:9333/devtools/browser/abc');
  });

  it('dispose closes the socket only and rejects in-flight calls', async () => {
    const client = new LiveChromeClient(dir);
    const p = client.listTargets();
    await tick();
    client.dispose();
    await expect(p).rejects.toThrow('disposed');
  });
});
