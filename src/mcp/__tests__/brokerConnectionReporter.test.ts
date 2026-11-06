import { describe, expect, it, vi } from 'vitest';
import { createConnectionReporter, trackConnection, trackToolCalls, type ReportChannel } from '../brokerConnectionReporter';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function channel(over: Partial<ReportChannel> = {}): ReportChannel & { send: ReturnType<typeof vi.fn> } {
  return { connected: true, send: vi.fn(), ...over } as ReportChannel & { send: ReturnType<typeof vi.fn> };
}

describe('broker connection reporter', () => {
  it('sends one exact report per burst, with the final count', async () => {
    const ch = channel();
    const r = createConnectionReporter(ch);
    r.opened();
    r.opened();
    r.opened();
    r.closed();
    await flush();
    expect(ch.send).toHaveBeenCalledTimes(1);
    expect(ch.send.mock.calls[0][0]).toEqual({ wmuxBroker: 'connections', open: 2 });
  });

  it('never reports below zero', async () => {
    const ch = channel();
    const r = createConnectionReporter(ch);
    r.closed();
    await flush();
    expect(ch.send.mock.calls[0][0]).toEqual({ wmuxBroker: 'connections', open: 0 });
  });

  it('does nothing without a channel or with a disconnected one', async () => {
    const none = createConnectionReporter({ connected: false });
    none.opened();
    const ch = channel({ connected: false });
    createConnectionReporter(ch).opened();
    await flush();
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('swallows a channel that closes under it, sync or async', async () => {
    const sync = channel({
      send: vi.fn(() => {
        throw Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
      }) as never,
    });
    createConnectionReporter(sync).opened();
    await expect(flush()).resolves.toBeUndefined();
    const asyncErr = channel();
    createConnectionReporter(asyncErr).opened();
    await flush();
    // The callback form keeps an async failure off the process 'error' event.
    const cb = asyncErr.send.mock.calls[0][1] as (err: Error | null) => void;
    expect(typeof cb).toBe('function');
    expect(() => cb(new Error('Channel closed'))).not.toThrow();
  });
});

describe('trackConnection', () => {
  function fakeSocket(destroyed = false) {
    const handlers: Array<() => void> = [];
    return {
      destroyed,
      once: (_event: 'close', fn: () => void) => { handlers.push(fn); },
      close() { this.destroyed = true; for (const fn of handlers.splice(0)) fn(); },
    };
  }

  it('counts a connection open until its socket closes, once', async () => {
    const ch = channel();
    const r = createConnectionReporter(ch);
    const socket = fakeSocket();
    trackConnection(socket, r);
    await flush();
    expect(ch.send.mock.calls.at(-1)?.[0]).toEqual({ wmuxBroker: 'connections', open: 1 });
    socket.close();
    socket.close();
    await flush();
    expect(ch.send.mock.calls.at(-1)?.[0]).toEqual({ wmuxBroker: 'connections', open: 0 });
  });

  it('does not leave a socket that closed before tracking counted as open', async () => {
    const ch = channel();
    const r = createConnectionReporter(ch);
    trackConnection(fakeSocket(true), r);
    await flush();
    expect(ch.send.mock.calls.at(-1)?.[0]).toEqual({ wmuxBroker: 'connections', open: 0 });
  });
});

describe('tool calls in flight', () => {
  it('names the tool calls in flight in the report, names only, until each answers', async () => {
    const ch = channel();
    const r = createConnectionReporter(ch);
    r.opened();
    r.toolStarted('browser_click');
    r.toolStarted('browser_click');
    r.toolStarted('../not a tool');
    await flush();
    expect(ch.send.mock.calls.at(-1)?.[0]).toEqual({ wmuxBroker: 'connections', open: 1, inflight: ['browser_click'] });
    r.toolEnded('browser_click');
    await flush();
    expect(ch.send.mock.calls.at(-1)?.[0]).toEqual({ wmuxBroker: 'connections', open: 1, inflight: ['browser_click'] });
    r.toolEnded('browser_click');
    await flush();
    expect(ch.send.mock.calls.at(-1)?.[0]).toEqual({ wmuxBroker: 'connections', open: 1 });
  });

  it('follows tools/call requests to their responses on a transport, and ends what is left on dispose', async () => {
    const ch = channel();
    const r = createConnectionReporter(ch);
    const sent: unknown[] = [];
    const transport = {
      onmessage: vi.fn() as ((message: unknown) => void) | undefined,
      send: vi.fn(async (message: unknown) => { sent.push(message); }),
    };
    const inner = transport.onmessage;
    const dispose = trackToolCalls(transport, r);
    transport.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_click', arguments: { ref: '1' } } });
    transport.onmessage?.({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'terminal_send' } });
    transport.onmessage?.({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(inner).toHaveBeenCalledTimes(3);
    await flush();
    expect(ch.send.mock.calls.at(-1)?.[0]).toMatchObject({ inflight: ['browser_click', 'terminal_send'] });
    await transport.send({ jsonrpc: '2.0', id: 1, result: {} });
    expect(sent).toHaveLength(1);
    await flush();
    expect(ch.send.mock.calls.at(-1)?.[0]).toMatchObject({ inflight: ['terminal_send'] });
    dispose();
    await flush();
    expect(ch.send.mock.calls.at(-1)?.[0]).toEqual({ wmuxBroker: 'connections', open: 0 });
  });
});
