// How the relay hands a client's messages to its WebSocket: whole and at once
// everywhere but a Windows named pipe, where one write is in flight at a time
// (relayOutbound).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayOutbound, RELAY_CLOSE_DRAIN_MS, RELAY_FRAGMENT_BYTES } from '../CdpPipeRelay';

interface Call { data: string | Buffer; opts?: { binary?: boolean; fin?: boolean; compress?: boolean }; cb?: (err?: Error) => void; write: number }

/**
 * A WebSocket that only records what it is given, over a socket that only
 * counts its writes: everything sent while it is corked is one write, as Node
 * hands it to the handle.
 */
function fakeWs() {
  const calls: Call[] = [];
  let corked = 0;
  let writes = 0;
  let corkedWrite = false;
  const socket = {
    cork() { corked++; },
    uncork() {
      corked--;
      if (!corked) corkedWrite = false;
    },
  };
  const ws = {
    send(data: string | Buffer, opts?: Call['opts'] | ((err?: Error) => void), cb?: (err?: Error) => void) {
      if (!corked || !corkedWrite) writes++;
      if (corked) corkedWrite = true;
      const write = writes;
      if (typeof opts === 'function') calls.push({ data, cb: opts, write });
      else calls.push({ data, opts, cb, write });
    },
  };
  return { ws: ws as unknown as Parameters<typeof relayOutbound>[0], socket, calls, writes: () => writes };
}

/** Completes the write in flight (its callback is on its last send), as the socket would. */
const complete = (calls: Call[], err?: Error) => calls.findLast((c) => c.cb)?.cb?.(err);

const text = (bytes: number, tag = 'a') => tag.repeat(bytes);

afterEach(() => { vi.useRealTimers(); });

describe('relayOutbound', () => {
  it('bytes passed on as Chrome wrote them leave as text, whole or as fragments of those same bytes', () => {
    const small = Buffer.from('{"method":"Page.screencastFrame","params":{}}');
    const large = Buffer.from(text(RELAY_FRAGMENT_BYTES * 2 + 3));
    const plain = fakeWs();
    relayOutbound(plain.ws, null).send(large);
    expect(plain.calls.map(({ data, opts }) => ({ data, opts }))).toEqual([{ data: large, opts: { binary: false } }]);
    const paced = fakeWs();
    const out = relayOutbound(paced.ws, paced.socket);
    out.send(small);
    expect(paced.calls[0]).toMatchObject({ data: small, opts: { binary: false } });
    complete(paced.calls);
    out.send(large);
    complete(paced.calls);
    complete(paced.calls);
    const fragments = paced.calls.slice(1);
    expect(fragments.map((c) => c.opts?.binary)).toEqual([false, false, false]);
    expect(fragments.map((c) => (c.data as Buffer).buffer === large.buffer)).toEqual([true, true, true]);
    expect(Buffer.concat(fragments.map((c) => c.data as Buffer)).equals(large)).toBe(true);
    expect(out.queued).toBe(0);
  });

  it('not paced (a Unix socket, TCP): every message goes to ws whole and at once, as it does today', () => {
    const { ws, calls } = fakeWs();
    const out = relayOutbound(ws, null);
    const big = text(RELAY_FRAGMENT_BYTES * 4 + 7);
    out.send(big);
    out.send('{"id":1}');
    expect(calls.map(({ data, opts, cb }) => ({ data, opts, cb }))).toEqual([
      { data: big, opts: undefined, cb: undefined },
      { data: '{"id":1}', opts: undefined, cb: undefined },
    ]);
    expect(out.paced).toBe(false);
    expect(out.queued).toBe(0);
    const close = vi.fn();
    out.end(close, () => undefined);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('paced: a message up to one fragment goes whole, at once when nothing is in flight', () => {
    const { ws, socket, calls } = fakeWs();
    const out = relayOutbound(ws, socket);
    const small = text(RELAY_FRAGMENT_BYTES);
    out.send(small);
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toBe(small);
    expect(calls[0].opts).toBeUndefined();
    expect(out.queued).toBe(0);
  });

  it('paced: a larger message leaves as fragments, the next only once the previous one is written', () => {
    const { ws, socket, calls } = fakeWs();
    const out = relayOutbound(ws, socket);
    const big = text(RELAY_FRAGMENT_BYTES * 3 + 5);
    out.send(big);
    expect(calls).toHaveLength(1);
    expect(out.queued).toBe(RELAY_FRAGMENT_BYTES * 2 + 5);
    for (let n = 2; n <= 4; n++) {
      complete(calls);
      expect(calls).toHaveLength(n);
    }
    complete(calls);
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => (c.data as Buffer).length)).toEqual([RELAY_FRAGMENT_BYTES, RELAY_FRAGMENT_BYTES, RELAY_FRAGMENT_BYTES, 5]);
    expect(calls.map((c) => c.opts)).toEqual([
      { binary: false, fin: false, compress: false },
      { binary: false, fin: false, compress: false },
      { binary: false, fin: false, compress: false },
      { binary: false, fin: true, compress: false },
    ]);
    expect(Buffer.concat(calls.map((c) => c.data as Buffer)).toString()).toBe(big);
    expect(out.queued).toBe(0);
  });

  it('paced: a burst of small messages leaves one write at a time, each of at most one fragment\'s bytes', () => {
    const { ws, socket, calls, writes } = fakeWs();
    const out = relayOutbound(ws, socket);
    const each = 32 << 10;
    for (let i = 0; i < 200; i++) out.send(text(each, String.fromCharCode(97 + (i % 26))));
    // The first goes at once; the other 199 wait for its write.
    expect(writes()).toBe(1);
    expect(out.queued).toBe(199 * each);
    for (let w = 2; w <= 100; w++) {
      complete(calls);
      expect(writes()).toBe(w);
      const bytes = calls.filter((c) => c.write === w).reduce((n, c) => n + (c.data as string).length, 0);
      expect(bytes).toBeLessThanOrEqual(RELAY_FRAGMENT_BYTES);
    }
    complete(calls);
    expect(calls).toHaveLength(200);
    expect(writes()).toBe(101);
    expect(calls.map((c) => (c.data as string)[0]).join('')).toBe(Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(''));
    expect(out.queued).toBe(0);
  });

  it('paced: a small message too big to join a write goes in the next one, whole', () => {
    const { ws, socket, calls, writes } = fakeWs();
    const out = relayOutbound(ws, socket);
    out.send('{"id":0}');
    out.send(text(40 << 10, 'b'));
    out.send(text(40 << 10, 'c'));
    complete(calls);
    expect(writes()).toBe(2);
    expect(calls.at(-1)?.data).toBe(text(40 << 10, 'b'));
    complete(calls);
    expect(writes()).toBe(3);
    expect(calls.at(-1)?.data).toBe(text(40 << 10, 'c'));
  });

  it('paced: a message sent while a fragmented one is going waits behind it, and counts as queued', () => {
    const { ws, socket, calls } = fakeWs();
    const out = relayOutbound(ws, socket);
    out.send(text(RELAY_FRAGMENT_BYTES + 1));
    out.send('{"id":2}');
    expect(calls).toHaveLength(1);
    expect(out.queued).toBe(1 + 8);
    complete(calls); // the first fragment
    expect(calls).toHaveLength(2);
    expect(calls[1].opts?.fin).toBe(true);
    complete(calls); // the last one
    expect(calls).toHaveLength(3);
    expect(calls[2].data).toBe('{"id":2}');
    expect(out.queued).toBe(0);
  });

  it('paced: a close waits until everything taken has gone to ws', () => {
    const { ws, socket, calls } = fakeWs();
    const out = relayOutbound(ws, socket);
    out.send(text(RELAY_FRAGMENT_BYTES * 2));
    out.send('{"method":"Target.targetDestroyed"}');
    const close = vi.fn();
    const cut = vi.fn();
    out.end(close, cut);
    expect(close).not.toHaveBeenCalled();
    complete(calls);
    expect(close).not.toHaveBeenCalled();
    complete(calls);
    expect(calls.at(-1)?.data).toBe('{"method":"Target.targetDestroyed"}');
    expect(close).toHaveBeenCalledTimes(1);
    expect(cut).not.toHaveBeenCalled();
  });

  it('paced: a close with nothing waiting is at once', () => {
    const { ws, socket } = fakeWs();
    const out = relayOutbound(ws, socket);
    const close = vi.fn();
    out.end(close, () => undefined);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it(`paced: a client that does not take what waits is cut after ${RELAY_CLOSE_DRAIN_MS} ms`, () => {
    vi.useFakeTimers();
    const { ws, socket } = fakeWs();
    const out = relayOutbound(ws, socket);
    out.send(text(RELAY_FRAGMENT_BYTES * 2));
    const close = vi.fn();
    const cut = vi.fn();
    out.end(close, cut);
    vi.advanceTimersByTime(RELAY_CLOSE_DRAIN_MS - 1);
    expect(cut).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cut).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('paced: a client still there after its close is cut on the same clock; one that left is not', () => {
    vi.useFakeTimers();
    const { ws, socket } = fakeWs();
    const stuck = relayOutbound(ws, socket);
    const left = relayOutbound(ws, socket);
    const close = vi.fn();
    const cutStuck = vi.fn();
    const cutLeft = vi.fn();
    stuck.end(close, cutStuck);
    left.end(close, cutLeft);
    expect(close).toHaveBeenCalledTimes(2);
    left.drop(); // its WebSocket closed
    vi.advanceTimersByTime(RELAY_CLOSE_DRAIN_MS);
    expect(cutStuck).toHaveBeenCalledTimes(1);
    expect(cutLeft).not.toHaveBeenCalled();
  });

  it('paced: a failed write or a dropped client sends nothing more', () => {
    const { ws, socket, calls } = fakeWs();
    const out = relayOutbound(ws, socket);
    out.send(text(RELAY_FRAGMENT_BYTES * 3));
    complete(calls, new Error('socket closed'));
    expect(calls).toHaveLength(1);
    out.drop();
    expect(out.queued).toBe(0);
    complete(calls);
    out.send('{"id":4}');
    expect(calls).toHaveLength(1);
  });

  it('paced: 100k queued messages go out in time linear in their number', () => {
    const { ws, socket, calls } = fakeWs();
    const out = relayOutbound(ws, socket);
    out.send(text(RELAY_FRAGMENT_BYTES * 2));
    for (let i = 0; i < 100_000; i++) out.send('{}');
    const started = performance.now();
    complete(calls); // the second fragment
    complete(calls); // then every small one, in batches
    while (out.queued > 0) complete(calls);
    const ms = performance.now() - started;
    expect(calls).toHaveLength(2 + 100_000);
    // Linear is a few ms; a queue that shifts its array head costs ~0.5 s here.
    expect(ms).toBeLessThan(150);
  });
});
