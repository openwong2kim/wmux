// A pane whose app pushed kitty flags gets Escape as `CSI 27 u`, Ctrl+C as
// `CSI 99;5u` and, with flag 2 (Codex), a release after every key. The
// daemon's input accounting reads those the way it reads the legacy bytes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { PromptEventLog } from '../PromptEventLog';
import { RingBuffer } from '../RingBuffer';

function fakePty(): IPty {
  return {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
}

describe('DaemonPTYBridge — kitty-encoded input', () => {
  let bridge: DaemonPTYBridge;
  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    bridge.setupDataForwarding(fakePty(), new RingBuffer(4096), 'sess-1', new PromptEventLog());
  });
  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('a kitty Escape is the lone Esc an interrupt is read from; its release is not input', () => {
    vi.advanceTimersByTime(1000);
    bridge.noteInput('\x1b[27u');
    const escAt = bridge.getLastEscAt();
    expect(escAt).toBe(Date.now());
    vi.advanceTimersByTime(1000);
    bridge.noteInput('\x1b[27;1:3u');
    expect(bridge.getLastEscAt()).toBe(escAt);
  });

  it('a kitty Ctrl+C empties the draft like 0x03 does', () => {
    bridge.noteInput('draft text');
    expect(bridge.hasDraft()).toBe(true);
    bridge.noteInput('\x1b[99;5u');
    expect(bridge.hasDraft()).toBe(false);
  });
});
