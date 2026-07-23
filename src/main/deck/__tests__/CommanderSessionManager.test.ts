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
