import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutputInterpreter } from '../OutputInterpreter';
import type { NativeOscBatch, NativeOutputChunk } from '../../shared/nativeTerminalCore';

/**
 * #3440: a native interpreter feed that refuses an allocation throws
 * `ALLOC_FAILED: ...`. That chunk is skipped for this session only; the next
 * chunk is interpreted as usual and nothing escapes to the caller.
 */
const refusal = (what: string) => new Error(`ALLOC_FAILED: could not allocate 288216 bytes for ${what}`);
const fake = vi.hoisted(() => ({ refuse: [] as Array<Error | null>, seedRefusal: null as Error | null, feeds: 0 }));

vi.mock('../../shared/nativeTerminalCore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/nativeTerminalCore')>();
  class FakeInterpreter {
    altScreen = false;
    feed(text: string, _end: number, includeOsc: boolean): NativeOscBatch | null {
      if (!includeOsc) {
        if (fake.seedRefusal) throw fake.seedRefusal;
        return null;
      }
      fake.feeds++;
      const next = fake.refuse.shift();
      if (next) throw next;
      // eslint-disable-next-line no-control-regex -- matches the OSC 133 bytes the fake reports
      const m = /\x1b\]133;([^\x07]*)\x07/.exec(text);
      return m ? { codes: Float64Array.of(133), data: [m[1]] } : null;
    }
    feedChunk(chunk: NativeOutputChunk, end: number): NativeOscBatch | null { return this.feed(chunk.text, end, true); }
    isSet(): boolean { return false; }
    preamble(): string { return ''; }
    reset(): void { /* nothing tracked */ }
    dispose(): void { /* nothing held */ }
  }
  return {
    ...actual,
    loadNativeTerminalCore: vi.fn(() => ({ NativeOutputInterpreter: FakeInterpreter })),
    reportNativeFallback: vi.fn(),
  };
});

describe('OutputInterpreter: a refused native allocation', () => {
  afterEach(() => {
    fake.refuse = []; fake.seedRefusal = null; fake.feeds = 0;
    vi.restoreAllMocks();
  });

  it('skips the refused chunk, logs it once with the session, and interprets the next one', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = new OutputInterpreter('rust', 'session-a');
    expect(p.backend).toBe('rust');
    const events: unknown[] = [];
    p.onOsc((e) => events.push(e));
    fake.refuse = [refusal('osc batch'), refusal('osc batch')];
    expect(() => p.feed('\x1b]133;C\x07', 10)).not.toThrow();
    expect(() => p.feed('\x1b]133;C\x07', 20)).not.toThrow();
    p.feed('\x1b]133;D;0\x07', 30);
    expect(events).toEqual([{ code: 133, data: 'D;0' }]);
    expect(p.skippedChunks).toBe(2);
    // Rate-limited: two refusals in a row, one line.
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toMatch(/output-interpreter session=session-a: ALLOC_FAILED: could not allocate 288216 bytes/);
    p.dispose();
  });

  it('skips a refused native chunk feed the same way', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = new OutputInterpreter('rust');
    const events: unknown[] = [];
    p.onOsc((e) => events.push(e));
    const chunk = { text: '\x1b]133;A\x07', byteLength: 7, readBytes: () => Buffer.alloc(0), dispose: () => undefined };
    fake.refuse = [refusal('chunk')];
    expect(() => p.feed(chunk.text, 7, chunk)).not.toThrow();
    p.feed(chunk.text, 14, chunk);
    expect(events).toEqual([{ code: 133, data: 'A' }]);
    expect(p.skippedChunks).toBe(1);
  });

  it('does not throw when seeding recovered history is refused', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = new OutputInterpreter('rust', 'session-b');
    fake.seedRefusal = refusal('history');
    expect(() => p.seedModes('\x1b[?1049h', 8)).not.toThrow();
    expect(p.skippedChunks).toBe(1);
  });

  it('still throws any other native error', () => {
    const p = new OutputInterpreter('rust');
    fake.refuse = [new Error('PTY_CLOSED: gone')];
    expect(() => p.feed('x', 1)).toThrow('PTY_CLOSED');
    expect(p.skippedChunks).toBe(0);
  });
});
