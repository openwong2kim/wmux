import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createSessionDataDispatcher,
  type SessionDataEmitter,
  type SessionDataPayload,
} from '../sessionDataDispatcher';

/**
 * Runtime tests for the single-dispatch `session:data` fan-out (perf: scale to
 * 30 sessions). The real consumer (pty.handler.ts) can't be imported under
 * vitest — it pulls in electron — so, exactly like the renderer extracted
 * createPtyDispatcher for its own tests, the dispatch core lives in an
 * electron-free module and is exercised here against a bare EventEmitter (which
 * satisfies SessionDataEmitter, the same surface DaemonClient exposes).
 */
describe('createSessionDataDispatcher', () => {
  function mkEmitter(): EventEmitter & SessionDataEmitter {
    // A bare EventEmitter is a structural SessionDataEmitter (on / removeListener
    // / listenerCount). Cast keeps the typed 'session:data' overload.
    return new EventEmitter() as EventEmitter & SessionDataEmitter;
  }
  function frame(sessionId: string, text = 'x'): SessionDataPayload {
    return { sessionId, data: Buffer.from(text) };
  }

  it('routes each session frame to only its own handler', () => {
    const emitter = mkEmitter();
    const dispatcher = createSessionDataDispatcher(emitter);

    const received = new Map<string, string[]>();
    const ids = ['a', 'b', 'c'];
    for (const id of ids) {
      received.set(id, []);
      dispatcher.set(id, (p) => received.get(id)!.push(p.data.toString()));
    }

    emitter.emit('session:data', frame('a', 'A1'));
    emitter.emit('session:data', frame('b', 'B1'));
    emitter.emit('session:data', frame('a', 'A2'));
    emitter.emit('session:data', frame('c', 'C1'));

    // Each handler saw ONLY its own session's bytes — no cross-delivery.
    expect(received.get('a')).toEqual(['A1', 'A2']);
    expect(received.get('b')).toEqual(['B1']);
    expect(received.get('c')).toEqual(['C1']);
  });

  it('drops frames for unknown session ids without throwing', () => {
    const emitter = mkEmitter();
    const dispatcher = createSessionDataDispatcher(emitter);
    let hits = 0;
    dispatcher.set('known', () => { hits++; });

    expect(() => emitter.emit('session:data', frame('ghost'))).not.toThrow();
    emitter.emit('session:data', frame('known'));
    expect(hits).toBe(1);
  });

  it('keeps a single shared listener no matter how many sessions register (>10)', () => {
    const emitter = mkEmitter();
    const dispatcher = createSessionDataDispatcher(emitter);

    // Well past EventEmitter's default 10-listener warning ceiling — the exact
    // regime that used to storm MaxListenersExceededWarning at boot.
    for (let i = 0; i < 30; i++) {
      dispatcher.set(`s${i}`, () => {});
    }

    // One shared listener on the event; the 30 sessions live in the map instead.
    expect(emitter.listenerCount('session:data')).toBe(1);
    expect(dispatcher.listenerCount()).toBe(1);
    expect(dispatcher.size()).toBe(30);
  });

  it('reports whether set() replaced an existing handler (replace semantics)', () => {
    const emitter = mkEmitter();
    const dispatcher = createSessionDataDispatcher(emitter);

    const seen: string[] = [];
    expect(dispatcher.set('a', () => seen.push('first'))).toBe(false);
    // A repeat register (e.g. PTY_RECONNECT re-firing) replaces, not stacks —
    // the id still has exactly one live handler and one shared listener.
    expect(dispatcher.set('a', () => seen.push('second'))).toBe(true);

    emitter.emit('session:data', frame('a'));
    expect(seen).toEqual(['second']);
    expect(dispatcher.size()).toBe(1);
    expect(emitter.listenerCount('session:data')).toBe(1);
  });

  it('detach removes the map entry — no delivery after delete, no leak', () => {
    const emitter = mkEmitter();
    const dispatcher = createSessionDataDispatcher(emitter);

    let hits = 0;
    dispatcher.set('a', () => { hits++; });
    emitter.emit('session:data', frame('a'));
    expect(hits).toBe(1);

    expect(dispatcher.delete('a')).toBe(true);
    expect(dispatcher.has('a')).toBe(false);
    expect(dispatcher.size()).toBe(0);

    // No handler runs after detach; the shared listener is still installed but
    // routes the frame nowhere.
    emitter.emit('session:data', frame('a'));
    expect(hits).toBe(1);

    // Deleting an already-absent id is a no-op false.
    expect(dispatcher.delete('a')).toBe(false);
  });

  it('dispose detaches the shared listener and clears all handlers', () => {
    const emitter = mkEmitter();
    const dispatcher = createSessionDataDispatcher(emitter);

    let hits = 0;
    dispatcher.set('a', () => { hits++; });
    expect(emitter.listenerCount('session:data')).toBe(1);

    dispatcher.dispose();
    expect(emitter.listenerCount('session:data')).toBe(0);
    expect(dispatcher.size()).toBe(0);

    // After dispose the emitter has no listener — a stray frame reaches nobody.
    emitter.emit('session:data', frame('a'));
    expect(hits).toBe(0);
  });

  it('a new dispatcher on a fresh emitter is independent (daemon-respawn rewire)', () => {
    // Models the respawn lifecycle: cleanup disposes the old generation's
    // dispatcher, then registerPTYHandlers builds a new one on the NEW
    // DaemonClient. The two must never cross-wire.
    const oldEmitter = mkEmitter();
    const oldDispatcher = createSessionDataDispatcher(oldEmitter);
    let oldHits = 0;
    oldDispatcher.set('a', () => { oldHits++; });
    oldDispatcher.dispose(); // generation torn down

    const newEmitter = mkEmitter();
    const newDispatcher = createSessionDataDispatcher(newEmitter);
    let newHits = 0;
    newDispatcher.set('a', () => { newHits++; });

    // Emitting on the OLD client reaches nobody; only the live generation fires.
    oldEmitter.emit('session:data', frame('a'));
    newEmitter.emit('session:data', frame('a'));
    expect(oldHits).toBe(0);
    expect(newHits).toBe(1);
    expect(newEmitter.listenerCount('session:data')).toBe(1);
  });
});
