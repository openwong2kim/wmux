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
