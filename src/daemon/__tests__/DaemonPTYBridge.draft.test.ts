// The composer draft the usage-limit continue must never append to: typed or
// pasted text with no submit after it.
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

describe('DaemonPTYBridge — composer draft', () => {
  let bridge: DaemonPTYBridge;
  let submitted: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    submitted = [];
    bridge.on('inputSubmitted', (e: { sessionId: string }) => submitted.push(e.sessionId));
    bridge.setupDataForwarding(makeFakePty(), new RingBuffer(65536), 'sess-1');
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('marks typed or pasted text as a draft until Enter, and reports the submit', () => {
    bridge.noteInput('fix the te');
    expect(bridge.hasDraft()).toBe(true);
    bridge.noteInput('\r');
    expect(bridge.hasDraft()).toBe(false);
    expect(submitted).toEqual(['sess-1']);

    bridge.noteInput('\x1b[200~pasted\nlines\x1b[201~');
    expect(bridge.hasDraft()).toBe(true);
    expect(submitted).toHaveLength(1); // a newline inside a paste is not a submit
  });

  it('ignores keys that carry no text, and Ctrl+C / Ctrl+U empty the composer', () => {
    bridge.noteInput('\x1b[A\x1bOB\x1b[I');
    expect(bridge.hasDraft()).toBe(false);
    bridge.noteInput('half');
    bridge.noteInput('\x15');
    expect(bridge.hasDraft()).toBe(false);
    bridge.noteInput('again');
    bridge.noteInput('\x03');
    expect(bridge.hasDraft()).toBe(false);
  });
});
