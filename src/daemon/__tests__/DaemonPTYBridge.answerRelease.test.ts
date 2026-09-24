// Answering the dialog releases "needs you".
//
// Claude Code's permission dialog takes `1` / `2` / `3` and ESC without a CR.
// `awaitingHuman` used to clear only on a submitted CR/LF, so a pane answered
// with the digit shortcut kept reading "needs you" — measured live at 18.8 s,
// the whole rest of the turn — and `getAgentStatus()` kept reporting
// awaiting_input after the turn's Stop, so a reconnect restored it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';

function makeFakePty(): { pty: IPty; feed: (data: string) => void } {
  let dataHandler: ((data: string) => void) | null = null;
  const pty = {
    onData: (cb: (data: string) => void) => {
      dataHandler = cb;
      return { dispose: () => { dataHandler = null; } };
    },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
  return { pty, feed: (data: string) => dataHandler?.(data) };
}

describe('DaemonPTYBridge — answering a dialog', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let answered: string[];
  let active: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    answered = [];
    active = [];
    bridge.on('answered', (e: { sessionId: string }) => answered.push(e.sessionId));
    bridge.on('active', (e: { sessionId: string }) => active.push(e.sessionId));
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1');
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it.each([
    ['option 1', '1'],
    ['option 2', '2'],
    ['option 3', '3'],
    ['ESC (cancel)', '\x1b'],
    ['Enter', '\r'],
  ])('%s releases the pane and reports the answer', (_label, key) => {
    bridge.noteAgentStatus('awaiting_input');
    expect(bridge.getAgentStatus()).toBe('awaiting_input');

    bridge.noteInput(key);

    expect(bridge.getAgentStatus()).not.toBe('awaiting_input');
    expect(answered).toEqual(['sess-1']);
    // The approved tool's output is the turn running again.
    active.length = 0;
    feed('.');
    expect(active).toEqual(['sess-1']);
  });

  it.each([
    ['an arrow key', '\x1b[B'],
    ['a letter', 'a'],
    ['a pasted digit', '\x1b[200~1\x1b[201~'],
  ])('%s is not an answer', (_label, key) => {
    bridge.noteAgentStatus('awaiting_input');
    bridge.noteInput(key);
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
    expect(answered).toEqual([]);
  });

  it('a digit typed while nothing is pending is ordinary typing', () => {
    bridge.noteInput('1');
    bridge.noteInput('\r');
    expect(answered).toEqual([]);
  });

  it('the Stop hook (authoritative) clears it, so a reconnect does not restore it', () => {
    bridge.noteAgentStatus('awaiting_input');
    bridge.noteAgentStatus('complete', true);
    expect(bridge.getAgentStatus()).toBe('complete');
  });

  it('the detector footer under the box (not authoritative) does not clear it', () => {
    bridge.noteAgentStatus('awaiting_input');
    bridge.noteAgentStatus('waiting');
    bridge.noteAgentStatus('complete');
    expect(bridge.getAgentStatus()).toBe('awaiting_input');
  });
});
