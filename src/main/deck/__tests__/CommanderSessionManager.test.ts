// Unit tests for CommanderSessionManager (Command Deck P2c). Drives a FAKE
// BrainAdapter — no SDK, no Electron: verifies stream relay, one-turn-at-a-time
// rejection, interrupt gating, and dispose.

import { describe, it, expect, vi } from 'vitest';
import { CommanderSessionManager } from '../CommanderSessionManager';
import type { BrainAdapter, BrainEvent, BrainStartOptions } from '../BrainAdapter';

/** A fake adapter whose send() yields a scripted event list, with hooks to hold
 *  a turn open (for the busy-rejection test) and to observe start/interrupt. */
class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  started: BrainStartOptions | null = null;
  interruptCount = 0;
  disposed = false;
  private script: BrainEvent[] = [];
  private gate: Promise<void> | null = null;

  setScript(events: BrainEvent[]): void {
    this.script = events;
  }
  hold(gate: Promise<void>): void {
    this.gate = gate;
  }
  start(opts: BrainStartOptions): void {
    this.started = opts;
  }
  async *send(): AsyncIterable<BrainEvent> {
    if (this.gate) await this.gate;
    for (const ev of this.script) {
      if (ev.type === 'turn-end' && ev.sessionId) this.sessionId = ev.sessionId;
      yield ev;
    }
  }
  interrupt(): void {
    this.interruptCount++;
  }
  dispose(): void {
    this.disposed = true;
  }
}

describe('CommanderSessionManager', () => {
  it('relays the adapter stream to the sink and starts the adapter once', async () => {
    const adapter = new FakeAdapter();
    adapter.setScript([
      { type: 'text-delta', text: 'hi' },
      { type: 'turn-end', sessionId: 'sess-1' },
    ]);
    const sink = vi.fn();
    const mgr = new CommanderSessionManager({ adapter, sink, startOptions: { systemPrompt: 'SYS' } });

    const res = await mgr.send('go');
    expect(res).toEqual({ ok: true });
    expect(adapter.started).toEqual({ systemPrompt: 'SYS' });
    expect(sink.mock.calls.map((c) => (c[0] as BrainEvent).type)).toEqual(['text-delta', 'turn-end']);
    expect(mgr.getStatus()).toEqual({ status: 'idle', sessionId: 'sess-1' });

    // Second turn does NOT re-start the adapter.
    adapter.started = null;
    adapter.setScript([{ type: 'turn-end', sessionId: 'sess-1' }]);
    await mgr.send('again');
    expect(adapter.started).toBeNull();
  });

  it('rejects a concurrent send while a turn is in flight (busy)', async () => {
    const adapter = new FakeAdapter();
    let release!: () => void;
    adapter.hold(new Promise<void>((r) => (release = r)));
    adapter.setScript([{ type: 'turn-end', sessionId: 's' }]);
    const sink = vi.fn();
    const mgr = new CommanderSessionManager({ adapter, sink });

    const first = mgr.send('one');
    await Promise.resolve(); // let the first turn enter busy
    expect(mgr.getStatus().status).toBe('busy');

    const second = await mgr.send('two');
    expect(second).toEqual({ ok: false, code: 'busy' });
    expect(sink).toHaveBeenCalledWith({
      type: 'error',
      message: expect.stringContaining('already running'),
    });

    release();
    await first;
    expect(mgr.getStatus().status).toBe('idle');
  });

  it('rejects empty text without touching the adapter', async () => {
    const adapter = new FakeAdapter();
    const startSpy = vi.spyOn(adapter, 'start');
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn() });
    expect(await mgr.send('   ')).toEqual({ ok: false, code: 'empty' });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('interrupt() only forwards while busy', async () => {
    const adapter = new FakeAdapter();
    let release!: () => void;
    adapter.hold(new Promise<void>((r) => (release = r)));
    adapter.setScript([{ type: 'turn-end', sessionId: 's' }]);
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn() });

    mgr.interrupt(); // idle — no-op
    expect(adapter.interruptCount).toBe(0);

    const turn = mgr.send('x');
    await Promise.resolve();
    mgr.interrupt();
    expect(adapter.interruptCount).toBe(1);
    release();
    await turn;
  });

  it('fires onSessionId once per NEW session id (P3a persistence hook)', async () => {
    const adapter = new FakeAdapter();
    const onSessionId = vi.fn();
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn(), onSessionId });

    adapter.setScript([{ type: 'turn-end', sessionId: 'sess-1' }]);
    await mgr.send('one');
    expect(onSessionId).toHaveBeenCalledTimes(1);
    expect(onSessionId).toHaveBeenCalledWith('sess-1');

    // Same id again → deduped, no redundant persist.
    await mgr.send('two');
    expect(onSessionId).toHaveBeenCalledTimes(1);

    // A rotated id → fires again.
    adapter.setScript([{ type: 'turn-end', sessionId: 'sess-2' }]);
    await mgr.send('three');
    expect(onSessionId).toHaveBeenCalledTimes(2);
    expect(onSessionId).toHaveBeenLastCalledWith('sess-2');
  });

  it('does not re-persist the seed id it was constructed with', async () => {
    const adapter = new FakeAdapter();
    const onSessionId = vi.fn();
    const mgr = new CommanderSessionManager({
      adapter,
      sink: vi.fn(),
      startOptions: { resumeSessionId: 'sess-disk' },
      onSessionId,
    });
    adapter.setScript([{ type: 'turn-end', sessionId: 'sess-disk' }]);
    await mgr.send('resumed turn');
    expect(onSessionId).not.toHaveBeenCalled();
  });

  it('a throwing onSessionId never breaks the live turn', async () => {
    const adapter = new FakeAdapter();
    adapter.setScript([
      { type: 'turn-end', sessionId: 'sess-1' },
    ]);
    const sink = vi.fn();
    const mgr = new CommanderSessionManager({
      adapter,
      sink,
      onSessionId: () => {
        throw new Error('disk full');
      },
    });
    const res = await mgr.send('go');
    expect(res).toEqual({ ok: true });
    expect(sink.mock.calls.map((c) => (c[0] as BrainEvent).type)).toEqual(['turn-end']);
  });

  it('fires onIdle on a LATER tick after a turn flips busy→idle (never synchronously)', async () => {
    const adapter = new FakeAdapter();
    adapter.setScript([{ type: 'turn-end', sessionId: 's' }]);
    const onIdle = vi.fn();
    const deferred: Array<() => void> = [];
    const mgr = new CommanderSessionManager({
      adapter,
      sink: vi.fn(),
      onIdle,
      deferIdle: (fn) => deferred.push(fn), // capture instead of setTimeout(0)
    });

    await mgr.send('go');
    // The turn is done and idle, but onIdle has NOT fired — it was deferred.
    expect(mgr.getStatus().status).toBe('idle');
    expect(onIdle).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);

    // Draining the deferred queue (the "later tick") fires it exactly once.
    deferred.forEach((fn) => fn());
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('a dispose() before the deferred tick cancels the onIdle wake', async () => {
    const adapter = new FakeAdapter();
    adapter.setScript([{ type: 'turn-end', sessionId: 's' }]);
    const onIdle = vi.fn();
    const deferred: Array<() => void> = [];
    const mgr = new CommanderSessionManager({
      adapter,
      sink: vi.fn(),
      onIdle,
      deferIdle: (fn) => deferred.push(fn),
    });
    await mgr.send('go');
    mgr.dispose();
    deferred.forEach((fn) => fn());
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('notifyForeignTurnEnd wakes the coalescer on a later tick when idle', () => {
    const adapter = new FakeAdapter();
    const onIdle = vi.fn();
    const deferred: Array<() => void> = [];
    const mgr = new CommanderSessionManager({
      adapter,
      sink: vi.fn(),
      onIdle,
      deferIdle: (fn) => deferred.push(fn),
    });
    // The human's TUI turn ended. The manager ran no turn of its own, so this
    // is the only thing that can flush what the coalescer buffered meanwhile.
    mgr.notifyForeignTurnEnd();
    expect(onIdle).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
    deferred.forEach((fn) => fn());
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('notifyForeignTurnEnd is ignored once disposed', () => {
    const adapter = new FakeAdapter();
    const onIdle = vi.fn();
    const deferred: Array<() => void> = [];
    const mgr = new CommanderSessionManager({
      adapter,
      sink: vi.fn(),
      onIdle,
      deferIdle: (fn) => deferred.push(fn),
    });
    mgr.dispose();
    mgr.notifyForeignTurnEnd();
    expect(deferred).toHaveLength(0);
  });

  it('a throwing onIdle never surfaces', async () => {
    const adapter = new FakeAdapter();
    adapter.setScript([{ type: 'turn-end', sessionId: 's' }]);
    const deferred: Array<() => void> = [];
    const mgr = new CommanderSessionManager({
      adapter,
      sink: vi.fn(),
      onIdle: () => {
        throw new Error('coalescer blew up');
      },
      deferIdle: (fn) => deferred.push(fn),
    });
    await mgr.send('go');
    expect(() => deferred.forEach((fn) => fn())).not.toThrow();
  });

  it('dispose() tears down the adapter and rejects further sends', async () => {
    const adapter = new FakeAdapter();
    const sink = vi.fn();
    const mgr = new CommanderSessionManager({ adapter, sink });
    mgr.dispose();
    expect(adapter.disposed).toBe(true);
    expect(mgr.getStatus().status).toBe('disposed');
    const res = await mgr.send('x');
    expect(res).toEqual({ ok: false, code: 'disposed' });
  });
});

// Round-4 review P1: a mid-stream adapter throw must be distinguishable from a
// completed turn — ok:true (the turn RAN; do not retry it) + code:'errored'
// (it died mid-turn; a self-resolution created during it may never have been
// acted on, so the re-examine consume must NOT delete it).
describe('send — mid-stream adapter error', () => {
  class ThrowingAdapter extends (class {} as new () => Record<string, unknown>) {
    started: unknown = null;
    start(opts: unknown): void {
      this.started = opts;
    }
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<never> {
      throw new Error('adapter died mid-turn');
    }
    interrupt(): void {
      /* no-op fake */
    }
    dispose(): void {
      /* no-op fake */
    }
  }

  it('returns ok:true with code:errored, sinks the error, and goes back to idle', async () => {
    const events: unknown[] = [];
    const mgr = new CommanderSessionManager({
      adapter: new ThrowingAdapter() as never,
      sink: (ev) => events.push(ev),
    });
    const verdict = await mgr.send('do the thing');
    expect(verdict).toEqual({ ok: true, code: 'errored' });
    expect(events.some((e) => (e as { type: string }).type === 'error')).toBe(true);
    expect(mgr.getStatus().status).toBe('idle');
  });
});

describe('CommanderSessionManager — turn origin (the no-click hand-off gate)', () => {
  it('records the origin only for an accepted turn; a refused request leaves it alone', async () => {
    const adapter = new FakeAdapter();
    adapter.setScript([{ type: 'turn-end', sessionId: null }]);
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn() });
    expect(mgr.turnOrigin).toBeNull();

    // A wake that was queued behind an operator turn: refused while busy, so it
    // must not mark the running operator turn as a wake…
    let release: () => void = () => undefined;
    adapter.hold(new Promise<void>((r) => { release = r; }));
    const human = mgr.send('operator prompt', { origin: 'human' });
    expect(mgr.turnOrigin).toBe('human');
    expect(await mgr.send('wake prompt', { origin: 'automation' })).toEqual({ ok: false, code: 'busy' });
    expect(mgr.turnOrigin).toBe('human');
    release();
    await human;

    // …and once the wake does run, a later operator request that is refused
    // cannot make it read as the operator's.
    adapter.hold(new Promise<void>((r) => { release = r; }));
    const wake = mgr.send('wake prompt', { origin: 'automation' });
    expect(mgr.turnOrigin).toBe('automation');
    expect(await mgr.send('operator prompt', { origin: 'human' })).toEqual({ ok: false, code: 'busy' });
    expect(mgr.turnOrigin).toBe('automation');
    release();
    await wake;

    // A turn the operator typed straight into the TUI.
    mgr.notifyForeignTurnStart();
    expect(mgr.turnOrigin).toBe('human');
  });
});

// The local read-only lane shares the normal reservation and stream without
// creating, resuming, or modifying a provider conversation.
describe('CommanderSessionManager — local-first answers', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  it('streams a local answer and its original prompt without starting or persisting the adapter', async () => {
    const adapter = new FakeAdapter();
    adapter.sessionId = 'existing-session';
    const start = vi.spyOn(adapter, 'start');
    const send = vi.spyOn(adapter, 'send');
    const sink = vi.fn();
    const onSessionId = vi.fn();
    const mgr = new CommanderSessionManager({ adapter, sink, onSessionId });
    const lookup = deferred<{ text: string }>();
    const turn = mgr.send('Who needs me?', { origin: 'human' }, () => lookup.promise);
    expect(mgr.getStatus()).toEqual({ status: 'busy', sessionId: 'existing-session' });
    expect(mgr.turnOrigin).toBeNull();
    lookup.resolve({ text: 'Two panes need your input.' });
    expect(await turn).toEqual({ ok: true, localAnswer: { text: 'Two panes need your input.' } });
    expect(sink.mock.calls.map(([event]) => event)).toEqual([
      { type: 'text-delta', text: 'Two panes need your input.' },
      {
        type: 'turn-end', sessionId: 'existing-session',
        localAnswer: { prompt: 'Who needs me?', text: 'Two panes need your input.' },
      },
    ]);
    expect(start).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(onSessionId).not.toHaveBeenCalled();
    expect(mgr.getStatus().status).toBe('idle');
  });

  it('reserves before awaiting local lookup and rejects concurrent provider and local turns', async () => {
    const adapter = new FakeAdapter();
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn() });
    const lookup = deferred<{ text: string }>();
    const secondLookup = vi.fn(async () => ({ text: 'must not run' }));
    const first = mgr.send('first', { origin: 'human' }, () => lookup.promise);
    expect(await mgr.send('wake', { origin: 'automation' })).toEqual({ ok: false, code: 'busy' });
    expect(await mgr.send('second', {}, secondLookup)).toEqual({ ok: false, code: 'busy' });
    expect(secondLookup).not.toHaveBeenCalled();
    expect(mgr.turnOrigin).toBeNull();
    lookup.resolve({ text: 'first answer' });
    await first;
  });

  it.each(['miss', 'reject', 'throw', 'empty'] as const)('falls through exactly once on a local %s with the original turn options', async (outcome) => {
    const adapter = new FakeAdapter();
    adapter.setScript([{ type: 'turn-end', sessionId: 'provider-session' }]);
    const start = vi.spyOn(adapter, 'start');
    const send = vi.spyOn(adapter, 'send');
    const sink = vi.fn();
    const mgr = new CommanderSessionManager({ adapter, sink, startOptions: { systemPrompt: 'rules' } });
    const localFirst = () => {
      if (outcome === 'throw') throw new Error('local sync failure');
      if (outcome === 'reject') return Promise.reject(new Error('renderer timed out'));
      return Promise.resolve(outcome === 'empty' ? { text: ' ' } : null);
    };
    expect(await mgr.send(' original prompt ', { origin: 'automation' }, localFirst)).toEqual({ ok: true });
    expect(start).toHaveBeenCalledExactlyOnceWith({ systemPrompt: 'rules' });
    expect(send).toHaveBeenCalledExactlyOnceWith('original prompt', { origin: 'automation' });
    expect(sink.mock.calls.map(([event]) => event)).toEqual([{ type: 'turn-end', sessionId: 'provider-session' }]);
    expect(mgr.getStatus().status).toBe('idle');
  });

  it('permits lazy fallback context without adding it to a local answer prompt', async () => {
    const adapter = new FakeAdapter();
    adapter.setScript([{ type: 'turn-end', sessionId: null }]);
    const send = vi.spyOn(adapter, 'send');
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn() });
    const turn = mgr.send('human prompt', { origin: 'human' }, async () => ({ fallbackText: '[rules]\n\nhuman prompt' }));
    expect(mgr.getStatus().status).toBe('busy');
    expect(await turn).toEqual({ ok: true });
    expect(send).toHaveBeenCalledExactlyOnceWith('[rules]\n\nhuman prompt', { origin: 'human' });
  });

  it('does not consume lazy provider startup when the first turn is local', async () => {
    const adapter = new FakeAdapter();
    const start = vi.spyOn(adapter, 'start');
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn(), startOptions: { resumeSessionId: 'saved' } });
    await mgr.send('local', {}, async () => ({ text: 'answer' }));
    expect(start).not.toHaveBeenCalled();
    adapter.setScript([{ type: 'turn-end', sessionId: 'saved' }]);
    await mgr.send('provider');
    await mgr.send('provider again');
    expect(start).toHaveBeenCalledExactlyOnceWith({ resumeSessionId: 'saved' });
  });

  it('finishes an interrupted local lookup even if its transport never settles, without provider fallback', async () => {
    const adapter = new FakeAdapter();
    const start = vi.spyOn(adapter, 'start');
    const send = vi.spyOn(adapter, 'send');
    const sink = vi.fn();
    const mgr = new CommanderSessionManager({ adapter, sink });
    let signal!: AbortSignal;
    const turn = mgr.send('local', {}, (s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    mgr.interrupt();
    expect(signal.aborted).toBe(true);
    expect(await turn).toEqual({ ok: true, code: 'errored' });
    expect(sink).toHaveBeenCalledExactlyOnceWith({ type: 'error', message: 'command interrupted' });
    expect(mgr.getStatus().status).toBe('idle');
    expect(start).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(adapter.interruptCount).toBe(0);
  });

  it.each(['answer', 'miss', 'reject'] as const)('suppresses a late local %s after interrupt and permits the next turn', async (outcome) => {
    const adapter = new FakeAdapter();
    const sink = vi.fn();
    const mgr = new CommanderSessionManager({ adapter, sink });
    const lookup = deferred<{ text: string } | null>();
    const oldTurn = mgr.send('old', {}, () => lookup.promise);
    mgr.interrupt();
    await oldTurn;
    const next = await mgr.send('new', {}, async () => ({ text: 'new answer' }));
    const eventsBefore = sink.mock.calls.length;
    if (outcome === 'reject') lookup.reject(new Error('late failure'));
    else lookup.resolve(outcome === 'answer' ? { text: 'stale answer' } : null);
    await Promise.resolve();
    await Promise.resolve();
    expect(next).toEqual({ ok: true, localAnswer: { text: 'new answer' } });
    expect(sink.mock.calls).toHaveLength(eventsBefore);
    expect(adapter.started).toBeNull();
  });

  it('aborts a disposed local turn, emits no late events, and never wakes on idle', async () => {
    const adapter = new FakeAdapter();
    const sink = vi.fn();
    const onIdle = vi.fn();
    const deferredIdle: Array<() => void> = [];
    const mgr = new CommanderSessionManager({ adapter, sink, onIdle, deferIdle: (fn) => deferredIdle.push(fn) });
    const lookup = deferred<{ text: string }>();
    let signal!: AbortSignal;
    const turn = mgr.send('local', {}, (s) => { signal = s; return lookup.promise; });
    mgr.dispose();
    expect(signal.aborted).toBe(true);
    expect(await turn).toEqual({ ok: true, code: 'errored' });
    lookup.resolve({ text: 'late answer' });
    await Promise.resolve();
    expect(sink).not.toHaveBeenCalled();
    expect(deferredIdle).toHaveLength(0);
    expect(onIdle).not.toHaveBeenCalled();
    expect(mgr.getStatus().status).toBe('disposed');
    expect(adapter.disposed).toBe(true);
  });

  it('rechecks foreign adapter activity before fallback', async () => {
    const adapter = Object.assign(new FakeAdapter(), { busy: false });
    const start = vi.spyOn(adapter, 'start');
    const send = vi.spyOn(adapter, 'send');
    const sink = vi.fn();
    const mgr = new CommanderSessionManager({ adapter, sink });
    const lookup = deferred<null>();
    const turn = mgr.send('local', {}, () => lookup.promise);
    adapter.busy = true;
    lookup.resolve(null);
    expect(await turn).toEqual({ ok: true, code: 'errored' });
    expect(start).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledWith({ type: 'error', message: expect.stringContaining('already running') });
    expect(mgr.getStatus().status).toBe('busy');
    adapter.busy = false;
    expect(mgr.getStatus().status).toBe('idle');
  });

  it('routes interrupt to the adapter once a miss has fallen through', async () => {
    const adapter = new FakeAdapter();
    const provider = deferred<void>();
    adapter.hold(provider.promise);
    adapter.setScript([{ type: 'turn-end', sessionId: null }]);
    const send = vi.spyOn(adapter, 'send');
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn() });
    const turn = mgr.send('local miss', {}, async () => null);
    // The local promise and race settle on separate microtasks.
    while (send.mock.calls.length === 0) await Promise.resolve();
    mgr.interrupt();
    expect(adapter.interruptCount).toBe(1);
    provider.resolve();
    await turn;
  });

  it('defers the normal idle wake after a local answer', async () => {
    const onIdle = vi.fn();
    const queue: Array<() => void> = [];
    const mgr = new CommanderSessionManager({ adapter: new FakeAdapter(), sink: vi.fn(), onIdle, deferIdle: (fn) => queue.push(fn) });
    await mgr.send('local', {}, async () => ({ text: 'answer' }));
    expect(mgr.getStatus().status).toBe('idle');
    expect(onIdle).not.toHaveBeenCalled();
    expect(queue).toHaveLength(1);
    queue[0]();
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});

describe('CommanderSessionManager — lazy fallback preparation', () => {
  it('prepares the provider context once, while the turn is still reserved', async () => {
    const adapter = new FakeAdapter();
    adapter.setScript([{ type: 'turn-end', sessionId: null }]);
    const send = vi.spyOn(adapter, 'send');
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn() });
    const prepare = vi.fn(() => {
      expect(mgr.getStatus().status).toBe('busy');
      expect(adapter.started).toBeNull();
      return 'context\noriginal';
    });
    expect(await mgr.send('original', {}, async () => ({ fallbackText: prepare }))).toEqual({ ok: true });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledExactlyOnceWith('context\noriginal', {});
  });

  it.each(['local answer', 'fallback'] as const)('a foreign turn suppresses a %s, including lazy work mutations', async (outcome) => {
    const adapter = Object.assign(new FakeAdapter(), { busy: false });
    const sink = vi.fn();
    const mgr = new CommanderSessionManager({ adapter, sink });
    const prepare = vi.fn(() => 'must not prepare');
    const turn = mgr.send('original', {}, async () => {
      adapter.busy = true;
      return outcome === 'fallback' ? { fallbackText: prepare } : { text: 'local answer' };
    });
    expect(await turn).toEqual({ ok: true, code: 'errored' });
    expect(prepare).not.toHaveBeenCalled();
    expect(adapter.started).toBeNull();
    expect(sink.mock.calls.map(([event]) => event.type)).toEqual(['error']);
  });

  // Review P2: a short TUI turn can start and end while the board read is
  // pending, so `adapterBusy` alone reads false again by the time it settles.
  it.each(['local answer', 'fallback'] as const)('a foreign turn that ends before the lookup suppresses a %s', async (outcome) => {
    const adapter = Object.assign(new FakeAdapter(), { busy: false });
    const send = vi.spyOn(adapter, 'send');
    const sink = vi.fn();
    const onIdle = vi.fn();
    const mgr = new CommanderSessionManager({ adapter, sink, onIdle, deferIdle: (fn) => fn() });
    const prepare = vi.fn(() => 'must not prepare');
    let resolve!: (value: { text: string } | { fallbackText: () => string }) => void;
    const turn = mgr.send('Who needs me?', { origin: 'human' }, () => new Promise((yes) => { resolve = yes; }));
    adapter.busy = true;
    mgr.notifyForeignTurnStart();
    adapter.busy = false;
    mgr.notifyForeignTurnEnd();
    expect(onIdle).not.toHaveBeenCalled();
    resolve(outcome === 'fallback' ? { fallbackText: prepare } : { text: 'stale answer' });
    expect(await turn).toEqual({ ok: true, code: 'errored' });
    expect(prepare).not.toHaveBeenCalled();
    expect(adapter.started).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(sink.mock.calls.map(([event]) => event)).toEqual([
      { type: 'error', message: 'a terminal turn ran during this lookup — ask again' },
    ]);
    // The TUI turn itself was the operator's, so its origin stands.
    expect(mgr.turnOrigin).toBe('human');
    expect(mgr.getStatus().status).toBe('idle');
    // The next question is not poisoned by the earlier foreign turn.
    expect(await mgr.send('Who needs me?', {}, async () => ({ text: 'fresh answer' })))
      .toEqual({ ok: true, localAnswer: { text: 'fresh answer' } });
  });

  it('does not run lazy preparation after an interrupt inside lookup', async () => {
    const adapter = new FakeAdapter();
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn() });
    const prepare = vi.fn(() => 'must not prepare');
    const turn = mgr.send('original', {}, async () => {
      mgr.interrupt();
      return { fallbackText: prepare };
    });
    expect(await turn).toEqual({ ok: true, code: 'errored' });
    expect(prepare).not.toHaveBeenCalled();
    expect(adapter.started).toBeNull();
  });
});

// The hand-off gate reads turnOrigin together with existing live work. A
// read-only question must never lend operator authority to that old work.
describe('CommanderSessionManager — local reads preserve provider authority', () => {
  it.each(['answer', 'interrupt', 'dispose', 'foreign-busy'] as const)(
    'preserves automation origin during lookup and after %s', async (outcome) => {
      const adapter = Object.assign(new FakeAdapter(), { busy: false });
      adapter.setScript([{ type: 'turn-end', sessionId: 'automation-session' }]);
      const sink = vi.fn();
      const mgr = new CommanderSessionManager({ adapter, sink });
      await mgr.send('prior autonomous work', { origin: 'automation' });
      expect(mgr.turnOrigin).toBe('automation');
      let resolve!: (value: { text: string }) => void;
      const local = mgr.send('Who needs me?', { origin: 'human' }, () => new Promise((yes) => { resolve = yes; }));
      expect(mgr.getStatus().status).toBe('busy');
      expect(mgr.turnOrigin).toBe('automation');
      if (outcome === 'interrupt') mgr.interrupt();
      else if (outcome === 'dispose') mgr.dispose();
      else if (outcome === 'foreign-busy') adapter.busy = true;
      resolve({ text: 'Two tasks need input.' });
      const result = await local;
      expect(result).toEqual(outcome === 'answer'
        ? { ok: true, localAnswer: { text: 'Two tasks need input.' } }
        : { ok: true, code: 'errored' });
      expect(mgr.turnOrigin).toBe('automation');
      if (outcome === 'foreign-busy') expect(mgr.getStatus().status).toBe('busy');
    },
  );

  it('changes automation origin to human only when a local miss reaches provider send', async () => {
    const adapter = new FakeAdapter();
    adapter.setScript([{ type: 'turn-end', sessionId: 'existing' }]);
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn() });
    await mgr.send('autonomous work', { origin: 'automation' });
    const originalSend = adapter.send.bind(adapter);
    vi.spyOn(adapter, 'send').mockImplementation(() => {
      expect(mgr.turnOrigin).toBe('human');
      return originalSend();
    });
    const prepare = vi.fn(() => {
      expect(mgr.turnOrigin).toBe('automation');
      return 'provider context\nWho needs me?';
    });
    const local = mgr.send('Who needs me?', { origin: 'human' }, async () => ({ fallbackText: prepare }));
    expect(mgr.turnOrigin).toBe('automation');
    expect(await local).toEqual({ ok: true });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(mgr.turnOrigin).toBe('human');
  });

  it('sets fallback origin immediately before the first provider startup', async () => {
    const adapter = new FakeAdapter();
    adapter.setScript([{ type: 'turn-end', sessionId: null }]);
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn() });
    const originalStart = adapter.start.bind(adapter);
    vi.spyOn(adapter, 'start').mockImplementation((opts) => {
      expect(mgr.turnOrigin).toBe('human');
      originalStart(opts);
    });
    expect(await mgr.send('Who needs me?', {}, async () => null)).toEqual({ ok: true });
    expect(mgr.turnOrigin).toBe('human');
  });

  it('does not change authority when lazy provider preparation throws', async () => {
    const adapter = new FakeAdapter();
    adapter.setScript([{ type: 'turn-end', sessionId: null }]);
    const mgr = new CommanderSessionManager({ adapter, sink: vi.fn() });
    await mgr.send('autonomous work', { origin: 'automation' });
    expect(await mgr.send('Who needs me?', { origin: 'human' }, async () => ({ fallbackText: () => {
      throw new Error('context unavailable');
    } }))).toEqual({ ok: true, code: 'errored' });
    expect(mgr.turnOrigin).toBe('automation');
  });
});
