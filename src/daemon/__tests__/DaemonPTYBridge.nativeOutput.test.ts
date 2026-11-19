import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';
import type { TerminalPty } from '../../shared/terminalPty';
import type { NativeOutputChunk } from '../../shared/nativeTerminalCore';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function harness(shellMarks?: 'exec' | 'integrated' | 'plain') {
  let handler: ((chunk: NativeOutputChunk) => void) | undefined;
  const legacy = vi.fn();
  const pty = { onData: legacy, onNativeData: (cb: typeof handler) => {
    handler = cb; return { dispose: () => { handler = undefined; } };
  }, onExit: () => ({ dispose() { /* no process in this fixture */ } }), write: vi.fn() } as unknown as TerminalPty;
  const ring = new RingBuffer(1024, 'node');
  const nativeWrites = vi.spyOn(ring, 'writeNativeChunk').mockImplementation(chunk => ring.write(Buffer.from(chunk.text)));
  const bridge = new DaemonPTYBridge();
  bridge.setupDataForwarding(pty, ring, 'native-output', undefined, shellMarks);
  cleanups.push(() => { bridge.cleanup(); ring.dispose(); });
  return { bridge, ring, legacy, nativeWrites, feed(text: string) {
    const chunk = { text, byteLength: Buffer.byteLength(text), readBytes: vi.fn(() => Buffer.from(text)), dispose: vi.fn() };
    handler?.(chunk); return chunk;
  }, feedChunk(chunk: NativeOutputChunk) { handler?.(chunk); } };
}

describe('native PTY output capture', () => {
  it('retains detached output without creating a JS byte copy and tracks modes after the write', () => {
    const h = harness(); const activity = vi.fn(); h.bridge.on('outputActivity', activity);
    const chunk = h.feed('\x1b[?1049h한글🙂');
    expect(activity).toHaveBeenCalledOnce();
    expect(h.legacy).not.toHaveBeenCalled();
    expect(h.nativeWrites).toHaveBeenCalledWith(chunk);
    expect(chunk.readBytes).not.toHaveBeenCalled();
    expect(h.ring.readAll().toString()).toBe(chunk.text);
    expect(h.ring.totalBytesWritten).toBe(Buffer.byteLength(chunk.text));
    expect(h.bridge.outputModes?.altScreen).toBe(true);
  });
  it('materializes one delivery buffer shared by all data subscribers', () => {
    const h = harness(); const first = vi.fn(), second = vi.fn();
    h.bridge.on('data', first); h.bridge.on('data', second);
    const chunk = h.feed('hello 한글');
    expect(chunk.readBytes).toHaveBeenCalledOnce();
    expect(first.mock.calls[0][0]).toBe(second.mock.calls[0][0]);
    expect(first.mock.calls[0][0].toString()).toBe(chunk.text);
  });
  it('holds muted recovery output without native writes, then replays it exactly once', () => {
    const h = harness(); h.ring.write(Buffer.from('restored\r\n'));
    h.bridge.setMuted(true);
    const chunk = h.feed('held 한글\x1b[c');
    expect(h.nativeWrites).not.toHaveBeenCalled(); expect(chunk.readBytes).not.toHaveBeenCalled();
    expect(h.ring.readAll().toString()).toBe('restored\r\n');
    const data = vi.fn(); h.bridge.on('data', data);
    h.bridge.setMuted(false, { replayHeld: true });
    expect(h.ring.readAll().toString()).toBe('restored\r\nheld 한글');
    expect(data).toHaveBeenCalledOnce();
    h.bridge.setMuted(false, { replayHeld: true }); expect(data).toHaveBeenCalledOnce();
  });
  it('a chunk with a program-written OSC 133 mark is rewritten from its text and leaves the zero-copy path', () => {
    const h = harness('integrated'); const data = vi.fn(); h.bridge.on('data', data);
    h.feed('\x1b]133;C\x07'); // the shell starts a command
    h.nativeWrites.mockClear(); data.mockClear();
    const chunk = h.feed('한글\x1b]133;A\x07kimi> ');
    expect(chunk.readBytes).not.toHaveBeenCalled();
    expect(h.nativeWrites).not.toHaveBeenCalled();
    const rewritten = '한글\x1b]133;a\x07kimi> ';
    expect(data.mock.calls[0][0].toString()).toBe(rewritten);
    expect(h.ring.readAll().toString()).toBe('\x1b]133;C\x07' + rewritten);
  });
  it('a chunk whose marks are all the shell\'s keeps the native ring write', () => {
    const h = harness('integrated'); const data = vi.fn(); h.bridge.on('data', data);
    const chunk = h.feed('\x1b]133;D;0\x07\x1b]133;A\x07PS> ');
    expect(h.nativeWrites).toHaveBeenCalledWith(chunk);
    expect(chunk.readBytes).toHaveBeenCalledOnce(); // the delivery, as for any chunk
    expect(data.mock.calls[0][0].toString()).toBe(chunk.text);
  });
  it('a plain pane\'s chunk with marks is passed through: it keeps the native ring write', () => {
    const h = harness('plain');
    h.feed('\x1b]133;C\x07');
    const chunk = h.feed('\x1b]133;A\x07kimi> ');
    expect(h.nativeWrites).toHaveBeenCalledWith(chunk);
    expect(chunk.readBytes).not.toHaveBeenCalled();
    expect(h.ring.readAll().toString()).toBe('\x1b]133;C\x07\x1b]133;A\x07kimi> ');
  });
  it('a refused delivery copy sends the chunk text instead, and the session goes on', () => {
    const h = harness(); const data = vi.fn(), activity = vi.fn();
    h.bridge.on('data', data); h.bridge.on('outputActivity', activity);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const text = 'out 한글';
      const chunk = { text, byteLength: Buffer.byteLength(text), dispose: vi.fn(),
        readBytes: vi.fn(() => { throw new Error('ALLOC_FAILED: could not allocate 10 bytes for an output chunk copy'); }) };
      // The ring keeps its own copy (the fixture writes the text); only the viewer's copy is refused.
      h.feedChunk(chunk as unknown as NativeOutputChunk);
      expect(h.ring.readAll().toString()).toBe(text);
      expect(activity).toHaveBeenCalledOnce();
      expect(data).toHaveBeenCalledOnce();
      expect(data.mock.calls[0][0].toString()).toBe(text);
      expect(log.mock.calls.flat().join('\n')).toContain('pty-bridge session=native-output: ALLOC_FAILED');
    } finally { log.mockRestore(); }
  });
  it('restarts the ring after a chunk it refused, so the preamble carries that chunk\'s modes and no older output is replayed without them', () => {
    const h = harness();
    h.feed('x'.repeat(100));
    h.nativeWrites.mockImplementationOnce(chunk => {
      (h.ring as unknown as { dropRefused(e: unknown, n: number): void })
        .dropRefused(new Error('ALLOC_FAILED: could not allocate 8 bytes for ring growth'), chunk.byteLength);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try { h.feed('\x1b[?2004h'); } finally { log.mockRestore(); }
    expect(h.ring.droppedBytes).toBe(8);
    expect(h.ring.readAll().toString()).toBe('');
    expect(h.ring.totalBytesWritten).toBe(100);
    expect(h.bridge.outputModes?.preamble(h.ring.totalBytesWritten - h.ring.size)).toContain('\x1b[?2004h');
    // Output after the hole is stored and replayed after the preamble.
    h.feed('after');
    expect(h.ring.readAll().toString()).toBe('after');
    expect(h.bridge.outputModes?.preamble(h.ring.totalBytesWritten - h.ring.size)).toContain('\x1b[?2004h');
  });
  it('discards muted output when replay was not requested', () => {
    const h = harness(); h.bridge.setMuted(true); h.feed('discard'); h.bridge.setMuted(false);
    expect(h.ring.size).toBe(0); expect(h.nativeWrites).not.toHaveBeenCalled();
    h.bridge.cleanup(); h.feed('late'); expect(h.ring.size).toBe(0);
  });
});
