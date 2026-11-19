import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutputInterpreter } from '../OutputInterpreter';
import type { NativeOscBatch, NativeOutputChunk } from '../../shared/nativeTerminalCore';
import { nativeAllocError } from '../../shared/__tests__/_nativeAllocError';

/**
 * #3440: a native interpreter feed that refuses an allocation throws an error
 * with `code: 'ALLOC_FAILED'` and changes nothing, so the chunk is fed once
 * more. A second refusal reads the chunk for its modes only (skipChunk /
 * skipBytes): its mode changes still reach `modes`, its OSC events are not
 * read. The chunk is counted as skipped for this session only; the next chunk
 * is interpreted as usual and nothing escapes to the caller.
 */
const refusal = (what: string) => nativeAllocError(`ALLOC_FAILED: could not allocate 288216 bytes for ${what}`);
const fake = vi.hoisted(() => ({
  refuse: [] as Array<Error | null>,
  seedRefusal: null as Error | null,
  feeds: 0,
  skips: [] as Array<{ via: 'chunk' | 'bytes'; text: string; end: number }>,
  withoutSkip: false,
}));

vi.mock('../../shared/nativeTerminalCore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/nativeTerminalCore')>();
  class FakeInterpreter {
    altScreen = false;
    // A module built before skipChunk / skipBytes lacks them.
    skipChunk?: (chunk: NativeOutputChunk, end: number) => void = fake.withoutSkip ? undefined : (chunk, end) => {
      fake.skips.push({ via: 'chunk', text: chunk.text, end });
      this.scanModes(chunk.text);
    };
    skipBytes?: (bytes: Uint8Array, end: number) => void = fake.withoutSkip ? undefined : (bytes, end) => {
      const text = Buffer.from(bytes).toString('utf8');
      fake.skips.push({ via: 'bytes', text, end });
      this.scanModes(text);
    };
    private scanModes(text: string): void {
      if (text.includes('\x1b[?1049h')) this.altScreen = true;
      if (text.includes('\x1b[?1049l')) this.altScreen = false;
    }
    feed(text: string, _end: number, includeOsc: boolean): NativeOscBatch | null {
      if (!includeOsc) {
        if (fake.seedRefusal) throw fake.seedRefusal;
        this.scanModes(text);
        return null;
      }
      fake.feeds++;
      const next = fake.refuse.shift();
      if (next) throw next;
      this.scanModes(text);
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

const chunkOf = (text: string): NativeOutputChunk => ({
  text,
  byteLength: Buffer.byteLength(text),
  readBytes: () => Buffer.alloc(0),
  dispose: () => undefined,
});

describe('OutputInterpreter: a refused native allocation', () => {
  afterEach(() => {
    fake.refuse = []; fake.seedRefusal = null; fake.feeds = 0; fake.skips = []; fake.withoutSkip = false;
    vi.restoreAllMocks();
  });

  it('feeds a refused chunk once more: a refusal then a success interprets it once, nothing skipped', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = new OutputInterpreter('rust', 'session-a');
    expect(p.backend).toBe('rust');
    const events: unknown[] = [];
    p.onOsc((e) => events.push(e));
    fake.refuse = [refusal('osc batch')];
    expect(() => p.feed('\x1b]133;C\x07', 10)).not.toThrow();
    expect(events).toEqual([{ code: 133, data: 'C' }]);
    expect(fake.feeds).toBe(2);
    expect(fake.skips).toEqual([]);
    expect(p.skippedChunks).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('two refusals read the chunk for its modes only and skip its OSC events; the next one is interpreted', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = new OutputInterpreter('rust', 'session-a');
    const events: unknown[] = [];
    p.onOsc((e) => events.push(e));
    fake.refuse = [refusal('osc batch'), refusal('osc batch')];
    expect(() => p.feed('\x1b]133;C\x07', 10)).not.toThrow();
    expect(fake.feeds).toBe(2);
    // The text path hands the chunk's UTF-8 bytes over.
    expect(fake.skips).toEqual([{ via: 'bytes', text: '\x1b]133;C\x07', end: 10 }]);
    expect(events).toEqual([]);
    expect(p.skippedChunks).toBe(1);
    p.feed('\x1b]133;D;0\x07', 20);
    expect(events).toEqual([{ code: 133, data: 'D;0' }]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toMatch(
      /output-interpreter session=session-a: ALLOC_FAILED: could not allocate 288216 bytes.*read for its modes only; its OSC events were not read/,
    );
    p.dispose();
  });

  it('a twice-refused alternate-screen switch still reaches modes, on the same object, with no OSC callback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = new OutputInterpreter('rust');
    const modes = p.modes;
    const events: unknown[] = [];
    p.onOsc((e) => events.push(e));
    const chunk = chunkOf('\x1b[?1049h\x1b]133;A\x07');
    fake.refuse = [refusal('chunk'), refusal('chunk')];
    p.feed(chunk.text, 15, chunk);
    expect(fake.skips).toEqual([{ via: 'chunk', text: chunk.text, end: 15 }]);
    expect(p.modes).toBe(modes);
    expect(p.modes.altScreen).toBe(true);
    expect(events).toEqual([]);
    expect(p.skippedChunks).toBe(1);
  });

  it('logs skipped chunks rate-limited: two in a row, one line', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = new OutputInterpreter('rust', 'session-a');
    fake.refuse = [refusal('a'), refusal('a'), refusal('b'), refusal('b')];
    p.feed('x', 1);
    p.feed('y', 2);
    expect(p.skippedChunks).toBe(2);
    expect(fake.skips).toHaveLength(2);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('handles a native chunk feed the same way', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = new OutputInterpreter('rust');
    const events: unknown[] = [];
    p.onOsc((e) => events.push(e));
    const chunk = chunkOf('\x1b]133;A\x07');
    fake.refuse = [refusal('chunk')];
    p.feed(chunk.text, 7, chunk);
    expect(events).toEqual([{ code: 133, data: 'A' }]);
    fake.refuse = [refusal('chunk'), refusal('chunk')];
    expect(() => p.feed(chunk.text, 14, chunk)).not.toThrow();
    expect(events).toHaveLength(1);
    expect(fake.skips).toEqual([{ via: 'chunk', text: chunk.text, end: 14 }]);
    expect(p.skippedChunks).toBe(1);
  });

  it('a refusal with an empty message is one too', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = new OutputInterpreter('rust');
    fake.refuse = [nativeAllocError(''), nativeAllocError('')];
    expect(() => p.feed('x', 1)).not.toThrow();
    expect(p.skippedChunks).toBe(1);
    expect(fake.skips).toHaveLength(1);
  });

  it('only skips on a module built before skipChunk', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fake.withoutSkip = true;
    const p = new OutputInterpreter('rust');
    fake.refuse = [refusal('x'), refusal('x')];
    expect(() => p.feed('x', 1)).not.toThrow();
    expect(p.skippedChunks).toBe(1);
    expect(fake.skips).toEqual([]);
    // The log line does not claim a modes read that did not happen.
    expect(String(errors.mock.calls[0]?.[0])).toMatch(/output chunk not interpreted \(1 in all\)$/);
  });

  it('reads refused recovered history for its modes only', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = new OutputInterpreter('rust', 'session-b');
    fake.seedRefusal = refusal('history');
    expect(() => p.seedModes('\x1b[?1049h', 8)).not.toThrow();
    expect(fake.skips).toEqual([{ via: 'bytes', text: '\x1b[?1049h', end: 8 }]);
    expect(p.modes.altScreen).toBe(true);
    expect(p.skippedChunks).toBe(1);
  });

  it('still throws any other native error, on the first feed or the retry, without a modes read', () => {
    const p = new OutputInterpreter('rust');
    fake.refuse = [new Error('PTY_CLOSED: gone')];
    expect(() => p.feed('x', 1)).toThrow('PTY_CLOSED');
    fake.refuse = [refusal('x'), new Error('PTY_CLOSED: gone')];
    expect(() => p.feed('x', 2)).toThrow('PTY_CLOSED');
    // An "ALLOC_FAILED:" message without the code is no refusal either.
    fake.refuse = [new Error('ALLOC_FAILED: could not allocate 8 bytes')];
    expect(() => p.feed('x', 3)).toThrow('ALLOC_FAILED');
    expect(p.skippedChunks).toBe(0);
    expect(fake.skips).toEqual([]);
  });
});
