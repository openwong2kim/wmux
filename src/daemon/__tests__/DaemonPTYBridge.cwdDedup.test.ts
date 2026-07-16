// app-weight P1-4: OSC 7 cwd emission dedup at the daemon emit site.
// Shells re-emit OSC 7 on every prompt redraw; without dedup an idle pane
// spams identical cwd events across daemon → main → renderer.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    onExit: () => ({ dispose: () => {} }),
  } as unknown as IPty;
  return { pty, feed: (data: string) => dataHandler?.(data) };
}

function osc7(cwd: string): string {
  return `\x1b]7;file://host/${encodeURIComponent(cwd).replace(/%2F/gi, '/')}\x07`;
}

describe('DaemonPTYBridge OSC 7 cwd dedup (app-weight P1-4)', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let cwdEvents: Array<{ sessionId: string; cwd: string }>;

  beforeEach(() => {
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    feed = fake.feed;
    cwdEvents = [];
    bridge.on('cwd', (e) => cwdEvents.push(e));
    bridge.setupDataForwarding(fake.pty, new RingBuffer(4096), 'sess-1');
  });

  afterEach(() => {
    bridge.cleanup();
  });

  it('emits the first OSC 7 after spawn', () => {
    feed(osc7('C:/repo'));
    expect(cwdEvents).toHaveLength(1);
    expect(cwdEvents[0]).toEqual({ sessionId: 'sess-1', cwd: 'C:\\repo' });
  });

  it('suppresses a repeated identical cwd (prompt redraw)', () => {
    feed(osc7('C:/repo'));
    feed(osc7('C:/repo'));
    expect(cwdEvents).toHaveLength(1);
  });

  it('emits again when the cwd changes', () => {
    feed(osc7('C:/repo'));
    feed(osc7('C:/other'));
    expect(cwdEvents.map((e) => e.cwd)).toEqual(['C:\\repo', 'C:\\other']);
  });

  it('emits three times for alternating A → B → A', () => {
    feed(osc7('C:/a'));
    feed(osc7('C:/b'));
    feed(osc7('C:/a'));
    expect(cwdEvents.map((e) => e.cwd)).toEqual(['C:\\a', 'C:\\b', 'C:\\a']);
  });
});
