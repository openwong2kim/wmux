// The browser build's terminal bridge (webPty.ts): stream rationing, the
// snapshot → replay contract, the device-reply guard, the stale-mode cap and
// the input grant. The replay-parse cases run a REAL xterm parser
// (@xterm/headless) with the renderer's own replay mute, so "zero input" means
// the answers xterm actually produced were dropped, not that none were made.
import { describe, it, expect, vi } from 'vitest';
import { Terminal } from '@xterm/headless';
import { createWebPty, snapshotTail, WEB_LIVE_STREAM_CAP } from '../webPty';
import { beginReplayWrite, createReplayMute, isReplayMuted } from '../../terminal/replayMute';

type Listener = (ev: MessageEvent) => void;

class FakeEventSource {
  static all: FakeEventSource[] = [];
  readyState = 1;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  private listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) { FakeEventSource.all.push(this); }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close(): void { this.closed = true; this.readyState = 2; }
  emit(type: string, data: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data } as MessageEvent);
  }
}

const openStreams = () => FakeEventSource.all.filter((e) => !e.closed);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const flush = () => new Promise((r) => setTimeout(r, 0));

function make(opts: { operator?: boolean; isReplaying?: (id: string) => boolean } = {}) {
  FakeEventSource.all = [];
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    if (url === '/api/stream-ticket') {
      return opts.operator
        ? new Response('{}', { status: 403 })
        : new Response(JSON.stringify({ ticket: 'tk', expiresAt: Date.now() + 120_000 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  const hub = createWebPty({
    token: opts.operator ? 'secret' : 'dev1.secret',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    createEventSource: (url) => new FakeEventSource(url),
    isReplaying: opts.isReplaying,
  });
  return { hub, calls };
}

async function showLive(hub: ReturnType<typeof createWebPty>, id: string): Promise<boolean> {
  const granted = hub.request(id);
  hub.pty.setViewerVisibility(id, true);
  await flush();
  return granted;
}

describe('live stream rationing', () => {
  it('never holds more than the cap open, across shows, hides, swaps and repeats', async () => {
    const { hub } = make();
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const id of ids) await showLive(hub, id);
    expect(openStreams()).toHaveLength(WEB_LIVE_STREAM_CAP);
    expect(hub.liveIds()).toEqual(['a', 'b', 'c', 'd']);

    // Activating a waiting pane retires the least recently activated one.
    hub.activate('e');
    await flush();
    expect(hub.liveIds()).toEqual(['b', 'c', 'd', 'e']);
    expect(openStreams().map((e) => e.url).some((u) => u.includes('session=a'))).toBe(false);
    expect(openStreams()).toHaveLength(WEB_LIVE_STREAM_CAP);

    // A pane that goes away hands its slot to the longest waiter.
    hub.release('b');
    await flush();
    expect(hub.liveIds()).toContain('f');

    // Churn: tab switches (release/request) and visibility flips in any order.
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 400; i++) {
      const id = ids[Math.floor(rnd() * ids.length)];
      const op = rnd();
      if (op < 0.3) hub.release(id);
      else if (op < 0.6) hub.request(id);
      else if (op < 0.8) hub.activate(id);
      else hub.pty.setViewerVisibility(id, rnd() < 0.5);
      await flush();
      expect(openStreams().length).toBeLessThanOrEqual(WEB_LIVE_STREAM_CAP);
      expect(hub.openStreamCount()).toBeLessThanOrEqual(WEB_LIVE_STREAM_CAP);
    }
  });

  it('opens a stream only for a live pane the terminal reports visible, and closes it on hide', async () => {
    const { hub } = make();
    hub.request('a');
    await flush();
    expect(openStreams()).toHaveLength(0);
    hub.pty.setViewerVisibility('a', true);
    await flush();
    expect(openStreams()).toHaveLength(1);
    hub.pty.setViewerVisibility('a', false);
    expect(openStreams()).toHaveLength(0);
  });

  it('opens device streams with a ticket, never the durable credential', async () => {
    const { hub } = make();
    await showLive(hub, 'a');
    expect(FakeEventSource.all[0].url).toBe('/api/stream?session=a&ticket=tk');
  });

  it('opens operator streams with ?token=, without asking for a ticket it would be refused', async () => {
    const { hub, calls } = make({ operator: true });
    await showLive(hub, 'a');
    expect(FakeEventSource.all[0].url).toBe('/api/stream?session=a&token=secret');
    expect(calls.some((c) => c.url === '/api/stream-ticket')).toBe(false);
  });
});

describe('snapshot → replay contract', () => {
  it('replays the snapshot as one reset-prefixed write, then reports the flush', async () => {
    const { hub } = make();
    const seen: Array<[string, string, boolean | undefined]> = [];
    const flushes: Array<[string, number]> = [];
    hub.pty.onData((id, data, replay) => seen.push([id, data, replay]));
    hub.pty.onFlushComplete((id, n) => flushes.push([id, n]));
    await showLive(hub, 'a');
    const es = FakeEventSource.all[0];
    es.emit('meta', JSON.stringify({ cols: 120, rows: 40 }));
    es.emit('snapshot', b64('hello'));
    expect(hub.geometryOf('a')).toEqual({ cols: 120, rows: 40 });
    expect(seen).toEqual([['a', '\x1bchello', true]]);
    expect(flushes).toEqual([['a', 5]]);
  });

  it('decodes live bytes as a stream, so a split multi-byte character survives', async () => {
    const { hub } = make();
    const seen: string[] = [];
    hub.pty.onData((_id, data, replay) => { if (!replay) seen.push(data); });
    await showLive(hub, 'a');
    const bytes = Buffer.from('한글', 'utf8');
    const es = FakeEventSource.all[0];
    es.emit('data', bytes.subarray(0, 2).toString('base64'));
    es.emit('data', bytes.subarray(2).toString('base64'));
    expect(seen.join('')).toBe('한글');
  });

  it('a mid-stream resize meta updates the geometry without touching the gate', async () => {
    const { hub } = make();
    await showLive(hub, 'a');
    const es = FakeEventSource.all[0];
    es.emit('meta', JSON.stringify({ cols: 80, rows: 24, commandRunning: false }));
    es.emit('snapshot', b64('$ '));
    es.emit('meta', JSON.stringify({ cols: 100, rows: 30, resize: true }));
    expect(hub.geometryOf('a')).toEqual({ cols: 100, rows: 30 });
    expect(await hub.pty.list()).toEqual([{ id: 'a', commandRunning: false }]);
  });
});

describe('stale input modes on a prompt shell', () => {
  const armed = '\x1b[?2004h$ vim\r\n\x1b[?1000h\x1b[?1003h\x1b[?1006h\x1b[?1004h';

  it('disarms mouse and focus reporting and leaves bracketed paste alone', async () => {
    const { hub } = make();
    const replays: string[] = [];
    hub.pty.onData((_id, data, replay) => { if (replay) replays.push(data); });
    await showLive(hub, 'a');
    const es = FakeEventSource.all[0];
    es.emit('meta', JSON.stringify({ cols: 80, rows: 24, commandRunning: false }));
    es.emit('snapshot', b64(armed));

    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((r) => term.write(replays[0], r));
    expect(term.modes.mouseTrackingMode).toBe('none');
    expect(term.modes.sendFocusMode).toBe(false);
    // ?2004 belongs to the live shell: clearing it would turn a multi-line
    // paste into N executed commands.
    expect(term.modes.bracketedPasteMode).toBe(true);
    expect(replays[0]).not.toContain('\x1b[?2004l');
    term.dispose();
  });

  it('caps a recovered pane (resumeAgent) at the same alive-shell set', async () => {
    expect(snapshotTail({ resumeAgent: 'claude' })).not.toContain('\x1b[?2004l');
    expect(snapshotTail({ resumeAgent: 'claude' })).toContain('\x1b[?1003l');
    const { hub } = make();
    await showLive(hub, 'a');
    const es = FakeEventSource.all[0];
    es.emit('meta', JSON.stringify({ cols: 80, rows: 24, resumeAgent: 'claude' }));
    es.emit('snapshot', b64(armed));
    // What useTerminal's own reset reads: never enough to earn the 'full' set.
    expect(await hub.pty.list()).toEqual([{ id: 'a', commandRunning: false }]);
  });

  it('leaves a live command (a TUI that owns the modes) untouched', async () => {
    expect(snapshotTail({ commandRunning: true })).toBe('');
    expect(snapshotTail({})).toBe('');
  });
});

describe('input', () => {
  it('replayed device queries produce zero input', async () => {
    const mute = createReplayMute();
    const { hub, calls } = make({ isReplaying: () => isReplayMuted(mute) });
    hub.setAllowInput(true);
    await showLive(hub, 'a');
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const answers: string[] = [];
    term.onData((d) => { answers.push(d); void hub.pty.write('a', d); });
    hub.pty.onData((_id, data, replay) => {
      if (!replay) { term.write(data); return; }
      const release = beginReplayWrite(mute);
      term.write(data, release);
    });
    const es = FakeEventSource.all[0];
    es.emit('meta', JSON.stringify({ cols: 80, rows: 24 }));
    // DA1, DA2, cursor-position report and a DECRQM, all from the pane's past.
    es.emit('snapshot', b64('old output\x1b[c\x1b[>c\x1b[6n\x1b[?2004$p'));
    await new Promise<void>((r) => term.write('', r));
    await flush();
    expect(answers.length).toBeGreaterThan(0); // xterm did answer…
    expect(calls.filter((c) => c.url.startsWith('/api/input'))).toEqual([]); // …and none of it was typed

    // A live keystroke after the replay still goes through.
    await hub.pty.write('a', 'x');
    expect(calls.filter((c) => c.url.startsWith('/api/input'))).toEqual([
      { url: '/api/input?session=a', method: 'POST', body: 'x' },
    ]);
    term.dispose();
  });

  it('a read-only caller cannot send input', async () => {
    const { hub, calls } = make();
    hub.setAllowInput(false);
    await showLive(hub, 'a');
    await hub.pty.write('a', 'rm -rf ~\r');
    expect(calls.filter((c) => c.url.startsWith('/api/input'))).toEqual([]);
  });

  it('stops typing once the server says the door is shut (403)', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 403 }));
    const ro = createWebPty({ token: 't', fetchImpl: fetchImpl as unknown as typeof fetch, createEventSource: (u) => new FakeEventSource(u) });
    ro.setAllowInput(true);
    await ro.pty.write('a', 'a');
    expect(ro.allowsInput()).toBe(false);
    await ro.pty.write('a', 'b');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps input in order per pane', async () => {
    const { hub, calls } = make();
    hub.setAllowInput(true);
    await Promise.all(['1', '2', '3'].map((k) => hub.pty.write('a', k)));
    expect(calls.filter((c) => c.url.startsWith('/api/input')).map((c) => c.body)).toEqual(['1', '2', '3']);
  });
});
