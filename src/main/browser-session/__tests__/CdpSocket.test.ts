import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CdpSocket } from '../CdpSocket';

// The shared CDP transport. Same FakeWebSocket shape as
// LiveChromeClient.test.ts — this file covers what the extraction ADDED:
// event dispatch (id-less frames used to be dropped) and flattened sessions.

type Listener = (ev: { data?: string }) => void;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  /** When set, the socket errors instead of opening. */
  static failConnect = false;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (FakeWebSocket.failConnect) {
        this.emit('error', {});
        return;
      }
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
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit('close', {});
  }

  /** Answer the most recent request. */
  reply(result: unknown): void {
    const last = this.sent[this.sent.length - 1];
    this.emit('message', { data: JSON.stringify({ id: last.id, result }) });
  }

  /** Push an id-less CDP event frame. */
  event(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.emit('message', {
      data: JSON.stringify({ method, params, ...(sessionId !== undefined && { sessionId }) }),
    });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.failConnect = false;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CdpSocket', () => {
  it('dispatches id-less frames to on() handlers (they used to be dropped)', async () => {
    const socket = new CdpSocket(() => 'ws://127.0.0.1:1/devtools/browser/a');
    const seen: Array<[Record<string, unknown>, string | undefined]> = [];
    const off = socket.on('Target.attachedToTarget', (params, sessionId) => seen.push([params, sessionId]));

    const pending = socket.send('Target.getTargets');
    await tick();
    const ws = FakeWebSocket.instances[0];
    ws.event('Target.attachedToTarget', { targetInfo: { targetId: 'page-1', type: 'page' } }, 'tab-session');
    // An unsubscribed method is simply ignored, not an error.
    ws.event('Target.targetCreated', { targetInfo: { targetId: 'tab-9', type: 'tab' } });

    expect(seen).toEqual([[{ targetInfo: { targetId: 'page-1', type: 'page' } }, 'tab-session']]);

    // Request/reply still works alongside the event stream.
    ws.reply({ targetInfos: [] });
    expect(await pending).toEqual({ targetInfos: [] });

    off();
    ws.event('Target.attachedToTarget', { targetInfo: { targetId: 'page-2', type: 'page' } }, 'tab-session');
    expect(seen).toHaveLength(1);
  });

  it('carries sessionId as a top-level frame field, and omits it when absent', async () => {
    const socket = new CdpSocket(() => 'ws://127.0.0.1:1/devtools/browser/a');
    const scoped = socket.send('Target.setAutoAttach', { autoAttach: true }, 'sess-1');
    await tick();
    const ws = FakeWebSocket.instances[0];
    expect(ws.sent[0]).toEqual({
      id: 1,
      method: 'Target.setAutoAttach',
      params: { autoAttach: true },
      sessionId: 'sess-1',
    });
    ws.reply({});
    await scoped;

    const browserWide = socket.send('Target.getTargets');
    await tick();
    expect(ws.sent[1]).not.toHaveProperty('sessionId');
    ws.reply({});
    await browserWide;
  });

  it('re-dials when the resolved endpoint changes', async () => {
    let endpoint = 'ws://127.0.0.1:1/devtools/browser/a';
    const socket = new CdpSocket(() => endpoint);

    const first = socket.send('Target.getTargets');
    await tick();
    FakeWebSocket.instances[0].reply({});
    await first;

    endpoint = 'ws://127.0.0.1:2/devtools/browser/b';
    const second = socket.send('Target.getTargets');
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    expect(FakeWebSocket.instances[1].url).toBe(endpoint);
    FakeWebSocket.instances[1].reply({});
    await second;
  });

  it('close rejects everything in flight but keeps subscriptions for the next dial', async () => {
    const socket = new CdpSocket(() => 'ws://127.0.0.1:1/devtools/browser/a', { label: 'W' });
    const seen: string[] = [];
    socket.on('Target.targetDestroyed', (params) => seen.push(String(params.targetId)));

    const pending = socket.send('Target.getTargets');
    await tick();
    expect(socket.isOpen()).toBe(true);
    socket.close();
    await expect(pending).rejects.toThrow('W: disposed');
    expect(socket.isOpen()).toBe(false);

    const again = socket.send('Target.getTargets');
    await tick();
    const ws = FakeWebSocket.instances[1];
    ws.event('Target.targetDestroyed', { targetId: 'tab-1' });
    expect(seen).toEqual(['tab-1']);
    ws.reply({});
    await again;
  });

  it('a reply that never arrives times out, naming the method', async () => {
    const socket = new CdpSocket(() => 'ws://127.0.0.1:1/devtools/browser/a', { label: 'W', timeoutMs: 5 });
    await expect(socket.send('Target.getTargets')).rejects.toThrow('W: Target.getTargets timed out');
  });

  it('a socket that will not open rejects with the caller-supplied remedy', async () => {
    FakeWebSocket.failConnect = true;
    const socket = new CdpSocket(() => 'ws://127.0.0.1:1/devtools/browser/a', {
      label: 'W',
      connectError: 'ENABLE_IT: turn the thing on',
    });
    await expect(socket.send('Target.getTargets')).rejects.toThrow('ENABLE_IT');
  });

  it('a CDP error reply rejects with the labelled message', async () => {
    const socket = new CdpSocket(() => 'ws://127.0.0.1:1/devtools/browser/a', { label: 'W' });
    const pending = socket.send('Target.attachToTarget', { targetId: 'nope' });
    await tick();
    const ws = FakeWebSocket.instances[0];
    ws.emit('message', { data: JSON.stringify({ id: 1, error: { message: 'No target with given id' } }) });
    await expect(pending).rejects.toThrow('W: No target with given id');
  });
});
