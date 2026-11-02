// #3004: a Codex pane redraws its window title with a new braille frame about
// every 100 ms. The tab gets a repeat never, a bare spinner frame at most once
// a second, and any other change at once; the bridge's own title readers (its
// running-turn and chat gates) still see every write.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { PromptEventLog } from '../PromptEventLog';
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

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇'];

describe('DaemonPTYBridge — window titles to the tab', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let titles: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    titles = [];
    bridge.on('title', (p: { title: string }) => titles.push(p.title));
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it("forwards Codex's spinner about once a second, while every frame reaches the title readers", () => {
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(100);
      const frame = `${BRAILLE[i % BRAILLE.length]} codex | ~/proj`;
      feed(`\x1b]0;${frame}\x07`);
      expect(bridge.getTitle()).toEqual({ title: frame, at: Date.now() });
    }
    // 100 ms (the spinner appearing), 1100 ms, 2100 ms.
    expect(titles).toEqual(['⠋ codex | ~/proj', '⠙ codex | ~/proj', '⠹ codex | ~/proj']);

    vi.advanceTimersByTime(100);
    feed('\x1b]0;codex | ~/proj\x07');
    expect(titles.at(-1)).toBe('codex | ~/proj');
  });

  it('forwards a repeated title once, and a new one at once', () => {
    feed('\x1b]2;✳ fix tests\x07');
    feed('\x1b]2;✳ fix tests\x07');
    vi.advanceTimersByTime(5000);
    feed('\x1b]0;✳ fix tests\x07');
    expect(bridge.getTitle().at).toBe(Date.now());
    feed('\x1b]0;◐ fix tests\x07');
    expect(titles).toEqual(['✳ fix tests', '◐ fix tests']);
  });
});
