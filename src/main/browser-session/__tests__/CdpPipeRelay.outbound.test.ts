// How the relay hands a client's messages to its WebSocket: whole everywhere
// but a Windows named pipe, where a large message leaves as fragments, one
// write in flight at a time (relayOutbound).
import { describe, expect, it } from 'vitest';
import { relayOutbound, RELAY_FRAGMENT_BYTES } from '../CdpPipeRelay';

interface Call { data: string | Buffer; opts?: { binary?: boolean; fin?: boolean; compress?: boolean }; cb?: (err?: Error) => void }

/** A WebSocket that only records what it is given. */
function fakeWs() {
  const calls: Call[] = [];
  const ws = {
    send(data: string | Buffer, opts?: Call['opts'] | ((err?: Error) => void), cb?: (err?: Error) => void) {
      if (typeof opts === 'function') calls.push({ data, cb: opts });
      else calls.push({ data, opts, cb });
    },
  };
  return { ws: ws as unknown as Parameters<typeof relayOutbound>[0], calls };
}

/** Completes the write of the last call, as the socket would. */
const complete = (calls: Call[], err?: Error) => calls.at(-1)?.cb?.(err);

const big = (bytes: number) => Array.from({ length: bytes }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');

describe('relayOutbound', () => {
  it('not paced (a Unix socket, TCP): every message goes to ws whole, as it does today', () => {
    const { ws, calls } = fakeWs();
    const out = relayOutbound(ws, false);
    const text = big(RELAY_FRAGMENT_BYTES * 4 + 7);
    out.send(text);
    out.send('{"id":1}');
    expect(calls).toEqual([{ data: text, opts: undefined, cb: undefined }, { data: '{"id":1}', opts: undefined, cb: undefined }]);
    expect(out.queued).toBe(0);
  });

  it('paced: a message up to one fragment goes whole and at once', () => {
    const { ws, calls } = fakeWs();
    const out = relayOutbound(ws, true);
    const text = big(RELAY_FRAGMENT_BYTES);
    out.send(text);
    expect(calls).toEqual([{ data: text, opts: undefined, cb: undefined }]);
    expect(out.queued).toBe(0);
  });

  it('paced: a larger message leaves as fragments, the next only once the previous one is written', () => {
    const { ws, calls } = fakeWs();
    const out = relayOutbound(ws, true);
    const text = big(RELAY_FRAGMENT_BYTES * 3 + 5);
    out.send(text);
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
    expect(Buffer.concat(calls.map((c) => c.data as Buffer)).toString()).toBe(text);
    expect(out.queued).toBe(0);
  });

  it('paced: a message sent while a fragmented one is going waits behind it, and counts as queued', () => {
    const { ws, calls } = fakeWs();
    const out = relayOutbound(ws, true);
    out.send(big(RELAY_FRAGMENT_BYTES + 1));
    out.send('{"id":2}');
    expect(calls).toHaveLength(1);
    expect(out.queued).toBe(1 + 8);
    complete(calls); // the first fragment
    expect(calls).toHaveLength(2);
    expect(calls[1].opts?.fin).toBe(true);
    complete(calls); // the last one
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({ data: '{"id":2}', opts: undefined, cb: undefined });
    expect(out.queued).toBe(0);
    // Idle again: the next message goes at once.
    out.send('{"id":3}');
    expect(calls).toHaveLength(4);
  });

  it('paced: a failed write or a dropped client sends nothing more', () => {
    const { ws, calls } = fakeWs();
    const out = relayOutbound(ws, true);
    out.send(big(RELAY_FRAGMENT_BYTES * 3));
    complete(calls, new Error('socket closed'));
    expect(calls).toHaveLength(1);
    out.drop();
    expect(out.queued).toBe(0);
    complete(calls);
    out.send('{"id":4}');
    expect(calls).toHaveLength(1);
  });
});
