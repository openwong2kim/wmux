// The typed-input signal workspace settle reads: a key from any input path,
// never a mouse report or a terminal reply, at most once per throttle window.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';

function makeFakePty(): IPty {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
}

describe('DaemonPTYBridge — typedInput', () => {
  let bridge: DaemonPTYBridge;
  let typed: string[];

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    bridge = new DaemonPTYBridge();
    typed = [];
    bridge.on('typedInput', (e: { sessionId: string }) => typed.push(e.sessionId));
    bridge.setupDataForwarding(makeFakePty(), new RingBuffer(65536), 'sess-1');
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('ignores mouse reports, focus and terminal replies', () => {
    bridge.noteInput('\x1b[<0;10;5M\x1b[<0;10;5m');
    bridge.noteInput('\x1b[<64;3;3M');
    bridge.noteInput('\x1b[M !!');
    bridge.noteInput('\x1b[I');
    bridge.noteInput('\x1b[?1;2c');
    expect(typed).toEqual([]);
  });

  it('fires for a key, once per throttle window', () => {
    bridge.noteInput('l');
    bridge.noteInput('s\r');
    expect(typed).toEqual(['sess-1']);
    vi.advanceTimersByTime(DaemonPTYBridge.TYPED_INPUT_THROTTLE_MS);
    bridge.noteInput('\x1b[A');
    expect(typed).toEqual(['sess-1', 'sess-1']);
  });

  it('does not fire for the approval driver\'s own keys', () => {
    bridge.noteInput('1', { selfWrite: true });
    expect(typed).toEqual([]);
  });
});
