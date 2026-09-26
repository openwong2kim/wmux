// The shared answered path, and the input shapes that must still count as an
// answer.
//
// A pane answered in Terminal kept reading "awaiting" for the rest of the turn
// when the answer key arrived glued to SGR mouse reports (mouse reporting on,
// unframed stdin), because the lone-key test saw a 20-byte chunk instead of
// `1`. `clearAwaiting` is the screen-verified release for whatever shape still
// slips past; it has to leave the bridge exactly where a recognised key does.
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

interface Harness {
  bridge: DaemonPTYBridge;
  feed: (data: string) => void;
  answered: Array<{ sessionId: string; reason: string }>;
  active: string[];
  activity: Array<Record<string, unknown>>;
}

function makeHarness(): Harness {
  const bridge = new DaemonPTYBridge();
  const fake = makeFakePty();
  const h: Harness = { bridge, feed: fake.feed, answered: [], active: [], activity: [] };
  bridge.on('answered', (e: { sessionId: string; reason: string }) => h.answered.push(e));
  bridge.on('active', (e: { sessionId: string }) => h.active.push(e.sessionId));
  bridge.on('awaitingActivity', (e: Record<string, unknown>) => h.activity.push(e));
  bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1');
  return h;
}

// An SGR mouse report (motion, button 35) at column 40 row 12.
const MOUSE = '\x1b[<35;40;12M';

describe('DaemonPTYBridge — shared answered path', () => {
  let harnesses: Harness[];

  beforeEach(() => {
    vi.useFakeTimers();
    harnesses = [];
  });

  afterEach(() => {
    for (const h of harnesses) h.bridge.cleanup();
    vi.useRealTimers();
  });

  const fresh = (): Harness => {
    const h = makeHarness();
    harnesses.push(h);
    return h;
  };

  it('clearAwaiting leaves the bridge exactly where an answer key does', () => {
    const byKey = fresh();
    const byScreen = fresh();
    for (const h of [byKey, byScreen]) h.bridge.noteAgentStatus('awaiting_input');

    byKey.bridge.noteInput('1');
    expect(byScreen.bridge.clearAwaiting('screen-cleared')).toBe(true);

    expect(byScreen.bridge.getAgentStatus()).toBe(byKey.bridge.getAgentStatus());
    for (const h of [byKey, byScreen]) {
      // settledStatus is cleared too, so no terminal status is left behind.
      expect(h.bridge.isAwaitingHuman()).toBe(false);
      expect(['idle', 'running']).toContain(h.bridge.getAgentStatus());
      expect(h.bridge.getLastTurnStartedAt()).toBeGreaterThan(0);
      // The next output is the turn running again, on both.
      h.feed('.');
      expect(h.active).toEqual(['sess-1']);
    }
    expect(byKey.answered).toEqual([{ sessionId: 'sess-1', reason: 'input' }]);
    expect(byScreen.answered).toEqual([{ sessionId: 'sess-1', reason: 'screen-cleared' }]);
  });

  it('clearAwaiting on a pane that is not awaiting does nothing', () => {
    const h = fresh();
    h.bridge.noteAgentStatus('complete', true);
    expect(h.bridge.clearAwaiting('screen-cleared')).toBe(false);
    expect(h.bridge.getAgentStatus()).toBe('complete');
    expect(h.answered).toEqual([]);
  });

  it.each([
    ['before', `${MOUSE}${MOUSE}1`],
    ['after', `1${MOUSE}`],
    ['around', `${MOUSE}1\x1b[<35;41;12m`],
  ])('a digit with SGR mouse reports glued %s it is an answer', (_where, chunk) => {
    const h = fresh();
    h.bridge.noteAgentStatus('awaiting_input');
    h.bridge.noteInput(chunk);
    expect(h.bridge.getAgentStatus()).not.toBe('awaiting_input');
    expect(h.answered).toEqual([{ sessionId: 'sess-1', reason: 'input' }]);
  });

  it('focus in/out reports are stripped before the lone-key test', () => {
    const h = fresh();
    h.bridge.noteAgentStatus('awaiting_input');
    h.bridge.noteInput('\x1b[O');
    h.bridge.noteInput('\x1b[I');
    expect(h.bridge.getAgentStatus()).toBe('awaiting_input');
    h.bridge.noteInput('\x1b[I\x1b');
    expect(h.bridge.getAgentStatus()).not.toBe('awaiting_input');
    expect(h.answered).toHaveLength(1);
  });

  it('mouse reports alone, or an arrow key with them, are not an answer', () => {
    const h = fresh();
    h.bridge.noteAgentStatus('awaiting_input');
    h.bridge.noteInput(`${MOUSE}${MOUSE}`);
    h.bridge.noteInput(`\x1b[B${MOUSE}`);
    expect(h.bridge.getAgentStatus()).toBe('awaiting_input');
    expect(h.answered).toEqual([]);
  });

  it('reports input and output on an awaiting pane by size, never by text', () => {
    const h = fresh();
    h.bridge.noteInput('x');
    h.feed('before');
    expect(h.activity).toEqual([]);

    h.bridge.noteAgentStatus('awaiting_input');
    h.bridge.noteInput(`${MOUSE}q`);
    h.feed('frame');
    expect(h.activity).toEqual([
      { sessionId: 'sess-1', cause: 'input', bytes: MOUSE.length + 1, nonKeyBytes: MOUSE.length, answered: false },
      { sessionId: 'sess-1', cause: 'output' },
    ]);
    expect(JSON.stringify(h.activity)).not.toContain('q');
  });
});

describe('DaemonPTYBridge — fence input revision', () => {
  // SGR button codes: 0 = left press (M) / release (m), 35 = motion with no
  // button (32 motion + 3 none), 32 = drag with the left button, 64 = wheel up.
  it('pointer motion and focus reports do not advance it', () => {
    const bridge = new DaemonPTYBridge();
    bridge.noteInput('\x1b[<35;40;12M\x1b[<35;41;12M');
    bridge.noteInput('\x1b[I\x1b[O');
    expect(bridge.getKeyInputRevision()).toBe(0);
    expect(bridge.getInputRevision()).toBe(2);
    bridge.cleanup();
  });

  it.each([
    ['a click (press)', '\x1b[<0;6;13M'],
    ['a release', '\x1b[<0;6;13m'],
    ['a drag with a button held', '\x1b[<32;6;13M'],
    ['a wheel turn', '\x1b[<64;6;13M'],
    ['a key glued to motion', '\x1b[<35;40;12Mx'],
  ])('%s advances it', (_label, chunk) => {
    const bridge = new DaemonPTYBridge();
    bridge.noteInput(chunk);
    expect(bridge.getKeyInputRevision()).toBe(1);
    bridge.cleanup();
  });
});

describe('DaemonPTYBridge — fenceInput event', () => {
  it('fires for a key or click, never for motion or focus', () => {
    const h = makeHarness();
    const seen: string[] = [];
    h.bridge.on('fenceInput', (e: { sessionId: string }) => seen.push(e.sessionId));
    h.bridge.noteInput('\x1b[<35;40;12M');
    h.bridge.noteInput('\x1b[I');
    expect(seen).toEqual([]);
    h.bridge.noteInput('\x1b[B');
    h.bridge.noteInput('\x1b[<0;6;13M');
    expect(seen).toEqual(['sess-1', 'sess-1']);
    h.bridge.cleanup();
  });
});
