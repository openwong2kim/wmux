import { describe, expect, it } from 'vitest';
import { NativePipeSocket, type ClientTokenFacts, type NativePipeConn, type NativePipePeer } from '../nativePipeSocket';

// NativePipeSocket.tokenFacts() over a fake native connection: one native
// request at a time, the answer taken on a wake, and every way the wait can
// end without one (timeout, destroy, a module without the read, a native
// call that throws).

const PEER: NativePipePeer = {
  pid: 4242, sessionId: 1, sameSession: true, sameUser: true, integrityRid: 0x2000,
  created: 1_700_000_000_000, ppid: 4000, reason: null,
};
const FACTS: ClientTokenFacts = { ok: true, sameUser: true, integrityRid: 0x3000, elevated: true };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class FactsConn implements NativePipeConn {
  requests = 0;
  takes = 0;
  destroyCalls = 0;
  /** What takeTokenFacts() returns next (then null again). */
  ready: ClientTokenFacts | null = null;
  requestThrows: Error | null = null;
  peer(): NativePipePeer { return PEER; }
  requestRead(): void { /* never completes: these tests read nothing */ }
  takeRead(): null { return null; }
  write(): number { return 1; }
  takeWritten(): number[] { return []; }
  error(): null { return null; }
  end(): void { /* not used */ }
  closed(): boolean { return false; }
  destroy(): void { this.destroyCalls++; }
  requestTokenFacts(): void {
    if (this.requestThrows) throw this.requestThrows;
    this.requests++;
  }
  takeTokenFacts(): ClientTokenFacts | null {
    this.takes++;
    const facts = this.ready;
    this.ready = null;
    return facts;
  }
}

describe('NativePipeSocket.tokenFacts', () => {
  it('asks once, and settles with the answer taken on a wake', async () => {
    const conn = new FactsConn();
    const socket = new NativePipeSocket(conn);
    const pending = socket.tokenFacts(1000);
    expect(conn.requests).toBe(1);
    socket.pump();
    await tick();
    conn.ready = FACTS;
    socket.pump();
    expect(await pending).toEqual(FACTS);
    // Nothing outstanding any more: a later wake does not take again.
    const takes = conn.takes;
    socket.pump();
    expect(conn.takes).toBe(takes);
    socket.destroy();
  });

  it('callers that ask while a request is outstanding share one native request', async () => {
    const conn = new FactsConn();
    const socket = new NativePipeSocket(conn);
    const a = socket.tokenFacts(1000);
    const b = socket.tokenFacts(1000);
    expect(conn.requests).toBe(1);
    conn.ready = { ok: false, reason: 'no-read-yet' };
    socket.pump();
    expect(await a).toEqual({ ok: false, reason: 'no-read-yet' });
    expect(await b).toEqual({ ok: false, reason: 'no-read-yet' });
    // A new ask after the answer is a new request.
    void socket.tokenFacts(1000);
    expect(conn.requests).toBe(2);
    socket.destroy();
  });

  it('times out with timed-out; an answer that comes later is taken and dropped', async () => {
    const conn = new FactsConn();
    const socket = new NativePipeSocket(conn);
    expect(await socket.tokenFacts(10)).toEqual({ ok: false, reason: 'timed-out' });
    conn.ready = FACTS;
    socket.pump();
    expect(conn.ready).toBeNull();
    socket.destroy();
  });

  it('settles as closed when the socket is destroyed, and at once after', async () => {
    const conn = new FactsConn();
    const socket = new NativePipeSocket(conn);
    const pending = socket.tokenFacts(1000);
    socket.destroy();
    expect(await pending).toEqual({ ok: false, reason: 'closed' });
    expect(await socket.tokenFacts(1000)).toEqual({ ok: false, reason: 'closed' });
    expect(conn.requests).toBe(1);
  });

  it('a request that throws destroys the socket, and the wait settles as closed', async () => {
    const conn = new FactsConn();
    conn.requestThrows = new Error('native failure');
    const socket = new NativePipeSocket(conn);
    socket.on('error', () => undefined);
    expect(await socket.tokenFacts(1000)).toEqual({ ok: false, reason: 'closed' });
    expect(socket.destroyed).toBe(true);
    expect(conn.destroyCalls).toBe(1);
  });

  it('a module without the read (pipe-listener-v1) settles as unsupported', async () => {
    const conn = new FactsConn();
    // Shadows the method: the connection of a core without the read.
    Object.defineProperty(conn, 'requestTokenFacts', { value: undefined });
    const socket = new NativePipeSocket(conn);
    expect(await socket.tokenFacts(1000)).toEqual({ ok: false, reason: 'unsupported' });
    socket.destroy();
  });
});
