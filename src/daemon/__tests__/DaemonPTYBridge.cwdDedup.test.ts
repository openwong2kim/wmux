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
    onExit: () => ({ dispose: () => { /* no-op */ } }),
  } as unknown as IPty;
  return { pty, feed: (data: string) => dataHandler?.(data) };
}

function osc7(cwd: string, host = 'localhost'): string {
  return `\x1b]7;file://${host}/${encodeURIComponent(cwd).replace(/%2F/gi, '/')}\x07`;
}

describe('DaemonPTYBridge OSC 7 cwd dedup (app-weight P1-4)', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let cwdEvents: Array<{ sessionId: string; cwd: string }>;

  beforeEach(() => {
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    // The bridge analyses a chunk after forwarding it (M3 A1); the flush runs
    // that analysis now, as it ran inside the call.
    feed = (data) => { fake.feed(data); bridge.flushPendingDetection(); };
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

  it('ignores a report from another host or of a network path; the cwd stays', () => {
    feed(osc7('C:/repo'));
    feed(osc7('C:/elsewhere', 'other-machine.example'));
    feed(osc7('//server/share/x'));
    feed(osc7('C:/repo', ''));
    expect(cwdEvents.map((e) => e.cwd)).toEqual(['C:\\repo']);
    feed(osc7('C:/next', ''));
    expect(cwdEvents.map((e) => e.cwd)).toEqual(['C:\\repo', 'C:\\next']);
  });

  it("takes a WSL distro's own hostname, but not its network paths", () => {
    bridge.markWslDistro();
    feed(osc7('home/me', 'ubuntu-dev'));
    feed(osc7('//server/share', 'ubuntu-dev'));
    expect(cwdEvents.map((e) => e.cwd)).toEqual(['/home/me']);
  });
});

// OSC 7-sticky (2026-07-21): once the shell has proven it runs the integration
// hook, prompt scraping must be permanently off for the session — screen text
// shaped like a prompt (agent TUI output printing "user@host:path$") was
// observed live overriding the hook's cwd with the literal token "path".
describe('DaemonPTYBridge OSC 7-sticky scrape disable', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void;
  let cwdEvents: Array<{ sessionId: string; cwd: string }>;

  beforeEach(() => {
    bridge = new DaemonPTYBridge();
    const fake = makeFakePty();
    // The bridge analyses a chunk after forwarding it (M3 A1); the flush runs
    // that analysis now, as it ran inside the call.
    feed = (data) => { fake.feed(data); bridge.flushPendingDetection(); };
    cwdEvents = [];
    bridge.on('cwd', (e) => cwdEvents.push(e));
    bridge.setupDataForwarding(fake.pty, new RingBuffer(4096), 'sess-1');
  });

  afterEach(() => {
    bridge.cleanup();
  });

  it('prompt scraping works before any OSC 7 (un-hooked shell fallback)', () => {
    feed('me@host:/home/me/work$');
    expect(cwdEvents.map((e) => e.cwd)).toEqual(['/home/me/work']);
  });

  it('after an OSC 7, prompt-shaped screen text no longer emits a cwd', () => {
    feed(osc7('C:/repo'));
    // Agent TUI prints something the bash-prompt regex would match.
    feed('me@host:/some/fake$');
    expect(cwdEvents.map((e) => e.cwd)).toEqual(['C:\\repo']);
  });

  it('the hook keeps reporting cwd changes after scraping is disabled', () => {
    feed(osc7('C:/repo'));
    feed('me@host:/some/fake$');
    feed(osc7('C:/other'));
    expect(cwdEvents.map((e) => e.cwd)).toEqual(['C:\\repo', 'C:\\other']);
  });
});
