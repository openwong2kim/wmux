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

  // Claude Code's permission dialog takes a lone digit with no Enter after it.
  // That digit answered the dialog; it never reached the composer. Before the
  // fix it stayed a "draft" until the next Enter, so every later hand-off into
  // the idle pane waited out its budget and was refused as `user_typing`.
  it.each([['1'], ['2'], ['3']])('a lone %s answering a dialog is not a draft', (key) => {
    bridge.noteAgentStatus('awaiting_input');
    bridge.noteInput(key);
    expect(bridge.getAgentStatus()).not.toBe('awaiting_input');
    expect(bridge.hasDraft()).toBe(false);
  });

  it('an answer key keeps a draft that was already in the composer', () => {
    bridge.noteInput('half-typed');
    bridge.noteAgentStatus('awaiting_input');
    bridge.noteInput('1');
    expect(bridge.hasDraft()).toBe(true);
  });

  it('the same digit typed with no dialog up is still a draft', () => {
    bridge.noteInput('1');
    expect(bridge.hasDraft()).toBe(true);
  });
});
