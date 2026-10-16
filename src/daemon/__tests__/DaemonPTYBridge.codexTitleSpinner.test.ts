// A hookless Codex turn that reasons for minutes barely changes the screen and
// runs no tool, so neither the byte-rate heuristic nor the transcript watcher
// reports it. Its braille title spinner does: the bridge reports `active` on
// the spinner's first frame and again every 30 s while it keeps spinning, so
// the renderer's two-minute activity stamp never runs out mid-turn.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';

const BANNER = '\x1b[9;1H│ >_ OpenAI Codex (v0.149.1)            │\r\n';
const title = (t: string) => `\x1b]0;${t}\x07`;

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

describe('DaemonPTYBridge — a Codex title spinner reports running', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let active: Array<{ likelyRepaint?: boolean }>;

  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    bridge.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-1');
    feed(BANNER);
    feed('ready\r\n'); // spends the cycle the banner armed
    vi.advanceTimersByTime(6_000); // past any boot burst and its idle
    active = [];
    bridge.on('active', (e: { likelyRepaint?: boolean }) => active.push(e));
  });

  afterEach(() => {
    bridge.cleanup();
    vi.useRealTimers();
  });

  it('reports running on the first spinner frame, then every 30 s while it spins', () => {
    const frames = ['⠋', '⠙', '⠹', '⠸'];
    for (let i = 0; i < 10; i++) {
      feed(title(`${frames[i % 4]} AAA quality pass | Heartbound`));
      vi.advanceTimersByTime(100);
    }
    expect(active).toHaveLength(1);
    expect(active[0].likelyRepaint).toBe(false);

    for (let s = 0; s < 31; s++) {
      feed(title(`${frames[s % 4]} AAA quality pass | Heartbound`));
      vi.advanceTimersByTime(1_000);
    }
    expect(active).toHaveLength(2);
  });

  it('a title without the spinner reports nothing, and the next spinner reports again at once', () => {
    feed(title('⠋ AAA quality pass | Heartbound'));
    expect(active).toHaveLength(1);
    feed(title('AAA quality pass | Heartbound'));
    vi.advanceTimersByTime(1_000);
    feed(title('Heartbound'));
    expect(active).toHaveLength(1);
    feed(title('⠙ next turn | Heartbound'));
    expect(active).toHaveLength(2);
  });

  it('a Claude Code spinner title is left to its hooks', () => {
    const claude = new DaemonPTYBridge();
    const fake = makeFakePty();
    claude.setupDataForwarding(fake.pty, new RingBuffer(65536), 'sess-2');
    const seen: unknown[] = [];
    claude.on('active', (e) => seen.push(e));
    fake.feed(title('⠋ Thinking'));
    expect(seen).toHaveLength(0);
    claude.cleanup();
  });
});
