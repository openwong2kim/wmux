import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';
import type { TerminalPty } from '../../shared/terminalPty';
import type { NativeOscBatch, NativeOutputChunk } from '../../shared/nativeTerminalCore';
import { nativeAllocError } from '../../shared/__tests__/_nativeAllocError';

/**
 * #3440: a recovered ring is read for its modes when the session starts. If
 * the native interpreter refuses that seed and its modes-only read fails as
 * well, the history is skipped and the session still starts.
 */
const fake = vi.hoisted(() => ({
  skipBytes: null as null | ((bytes: Uint8Array) => void),
  seeded: [] as Uint8Array[],
}));

vi.mock('../../shared/nativeTerminalCore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/nativeTerminalCore')>();
  class FakeInterpreter {
    altScreen = false;
    feed(text: string, _end: number, includeOsc: boolean): NativeOscBatch | null {
      if (!includeOsc) throw nativeAllocError('ALLOC_FAILED: could not allocate 4194305 bytes for output text to interpret');
      if (text.includes('\x1b[?1049h')) this.altScreen = true;
      return null;
    }
    feedChunk(chunk: NativeOutputChunk, end: number): NativeOscBatch | null { return this.feed(chunk.text, end, true); }
    skipChunk(): void { /* not reached here */ }
    skipBytes(bytes: Uint8Array): void {
      fake.seeded.push(bytes);
      fake.skipBytes?.(bytes);
      if (Buffer.from(bytes).includes('\x1b[?1049h')) this.altScreen = true;
    }
    isSet(): boolean { return false; }
    preamble(): string { return ''; }
    reset(): void { /* nothing tracked */ }
    dispose(): void { /* nothing held */ }
  }
  return {
    ...actual,
    loadNativeTerminalCore: vi.fn((capability: string) => (capability === 'output-interpreter-v1'
      ? { NativeOutputInterpreter: FakeInterpreter }
      : actual.loadNativeTerminalCore(capability as never))),
    reportNativeFallback: vi.fn(),
  };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  fake.skipBytes = null; fake.seeded = [];
  vi.restoreAllMocks();
});

function start(history: string) {
  let handler: ((chunk: NativeOutputChunk) => void) | undefined;
  const pty = { backend: 'rust', onData: vi.fn(), onNativeData: (cb: typeof handler) => {
    handler = cb; return { dispose: () => { handler = undefined; } };
  }, onExit: () => ({ dispose() { /* no process in this fixture */ } }), write: vi.fn() } as unknown as TerminalPty;
  const ring = new RingBuffer(4096, 'node');
  ring.write(Buffer.from(history));
  vi.spyOn(ring, 'writeNativeChunk').mockImplementation(chunk => ring.write(Buffer.from(chunk.text)));
  const bridge = new DaemonPTYBridge();
  expect(() => bridge.setupDataForwarding(pty, ring, 'seed-refused')).not.toThrow();
  cleanups.push(() => { bridge.cleanup(); ring.dispose(); });
  return { bridge, ring, feed(text: string) {
    handler?.({ text, byteLength: Buffer.byteLength(text), readBytes: () => Buffer.from(text), dispose: () => undefined });
  } };
}

describe('DaemonPTYBridge: a refused seed of the recovered ring', () => {
  it('reads the ring bytes it already holds for their modes, without encoding them again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = start('\x1b[?1049hrestored frame\r\n');
    expect(fake.seeded).toHaveLength(1);
    expect(Buffer.from(fake.seeded[0]).toString()).toBe('\x1b[?1049hrestored frame\r\n');
    expect(s.bridge.outputModes?.altScreen).toBe(true);
  });

  it('starts the session when the modes-only read throws as well, and keeps interpreting live output', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fake.skipBytes = () => { throw new RangeError('Array buffer allocation failed'); };
    const s = start('\x1b[?1049hrestored frame\r\n');
    expect(s.bridge.outputModes?.altScreen).toBe(false);
    expect(errors.mock.calls.map(c => String(c[0])).join('\n'))
      .toMatch(/session=seed-refused: ALLOC_FAILED: could not allocate 4194305 bytes.*recovered history not scanned for modes \(1 in all\)/);
    s.feed('\x1b[?1049h');
    expect(s.bridge.outputModes?.altScreen).toBe(true);
  });
});
