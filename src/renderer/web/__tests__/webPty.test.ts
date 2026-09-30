// The browser build's terminal bridge (webPty.ts) and viewer parser hooks
// (viewerParser.ts): stream rationing and back-off, the snapshot → replay
// contract, tickets, the input queue (replay wait, failure halts, receipts),
// the grant re-read, and — with a REAL xterm parser (@xterm/headless) — that a
// viewer answers no terminal query and disarms a dead TUI's mouse mode without
// touching ?2004.
import { describe, it, expect, vi } from 'vitest';
import { Terminal } from '@xterm/headless';
import { createWebPty, snapshotTail, STREAM_FAIL_LIMIT, WEB_LIVE_STREAM_CAP, type WebPtyDeps } from '../webPty';
import { installViewerParser } from '../viewerParser';

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
  fail(): void { this.readyState = 2; this.onerror?.(new Event('error')); }
}

const openStreams = () => FakeEventSource.all.filter((e) => !e.closed);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const flush = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

type Reply = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

function make(opts: { operator?: boolean; reply?: Reply; deps?: Partial<WebPtyDeps> } = {}) {
  FakeEventSource.all = [];
  const calls: { url: string; method: string; body?: unknown; headers?: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body, headers: init?.headers as Record<string, string> });
    const custom = opts.reply?.(url, init);
    if (custom) return custom;
    if (url === '/api/stream-ticket') return new Response(JSON.stringify({ ticket: 'tk', expiresAt: Date.now() + 120_000 }), { status: 200 });
    return new Response('{}', { status: 200 });
  });
  const hub = createWebPty({
    token: opts.operator ? 'secret' : 'dev1.secret',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    createEventSource: (url) => new FakeEventSource(url),
    ...opts.deps,
  });
  const inputs = () => calls.filter((c) => c.url.startsWith('/api/input'));
  return { hub, calls, inputs };
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

    hub.activate('e');
    await flush();
    expect(hub.liveIds()).toEqual(['b', 'c', 'd', 'e']);
    expect(openStreams().some((e) => e.url.includes('session=a'))).toBe(false);

    hub.release('b');
    await flush();
    expect(hub.liveIds()).toContain('f');

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

  it('backs off after a refused stream and, past the limit, gives the slot up', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const { hub } = make({ deps: { setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => undefined } });
    await showLive(hub, 'a');
    const delays: number[] = [];
    for (let i = 0; i < STREAM_FAIL_LIMIT; i++) {
      const es = openStreams().find((e) => e.url.includes('session=a'));
      expect(es).toBeDefined();
      es!.fail();
      if (i < STREAM_FAIL_LIMIT - 1) {
        const retry = timers.filter((t) => t.ms >= 1000 && t.ms <= 30_000).pop()!;
        delays.push(retry.ms);
        retry.fn();
        await flush();
      }
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    expect(hub.isLive('a')).toBe(false);
    expect(hub.isUnavailable('a')).toBe(true);
    expect(openStreams()).toHaveLength(0);
    // The user asks again: it gets a fresh slot.
    hub.activate('a');
    await flush();
    expect(hub.isLive('a')).toBe(true);
    expect(openStreams()).toHaveLength(1);
  });
});

describe('credentials on the stream URL', () => {
  it('a device credential opens with a ticket, never itself', async () => {
    const { hub } = make();
    await showLive(hub, 'a');
    expect(FakeEventSource.all[0].url).toBe('/api/stream?session=a&ticket=tk');
  });

  it('no ticket → no stream: a device credential never falls back to ?token=', async () => {
    const { hub } = make({ reply: (url) => (url === '/api/stream-ticket' ? new Response('', { status: 503 }) : undefined) });
    await showLive(hub, 'a');
    await flush();
    expect(FakeEventSource.all).toHaveLength(0);
  });

  it('the operator token opens with ?token= and never asks for a ticket', async () => {
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

  it('decodes as one stream, so a character split across snapshot and data survives', async () => {
    const { hub } = make();
    const seen: string[] = [];
    hub.pty.onData((_id, data) => seen.push(data));
    await showLive(hub, 'a');
    const bytes = Buffer.from('ab한글', 'utf8');
    const es = FakeEventSource.all[0];
    es.emit('snapshot', bytes.subarray(0, 3).toString('base64'));
    es.emit('data', bytes.subarray(3, 6).toString('base64'));
    es.emit('data', bytes.subarray(6).toString('base64'));
    expect(seen.join('')).toBe('\x1bcab한글');
  });

  it('applies a mid-stream resize at once and keeps the snapshot gate', async () => {
    const applied: unknown[] = [];
    const { hub } = make({ deps: { applyGeometry: (id, g) => applied.push([id, g]) } });
    await showLive(hub, 'a');
    const es = FakeEventSource.all[0];
    es.emit('meta', JSON.stringify({ cols: 80, rows: 24, commandRunning: false }));
    es.emit('snapshot', b64('$ '));
    es.emit('meta', JSON.stringify({ cols: 100, rows: 30, resize: true }));
    expect(hub.geometryOf('a')).toEqual({ cols: 100, rows: 30 });
    expect(applied).toEqual([['a', { cols: 80, rows: 24 }], ['a', { cols: 100, rows: 30 }]]);
    expect(await hub.pty.list()).toEqual([{ id: 'a', commandRunning: false }]);
  });
});

describe('a viewer terminal (real parser)', () => {
  const armed = '\x1b[?2004h$ vim\r\n\x1b[?1000h\x1b[?1003h\x1b[?1006h\x1b[?1004h';
  const newTerm = (mayInput = true) => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    installViewerParser(term as unknown as Parameters<typeof installViewerParser>[0], { mayInput: () => mayInput });
    return term;
  };
  const write = (term: Terminal, data: string) => new Promise<void>((r) => term.write(data, r));

  it('answers no terminal query — replayed or live — so nothing reaches the shell', async () => {
    const term = newTerm();
    const answers: string[] = [];
    term.onData((d) => answers.push(d));
    // DA1, DA2, DA3, DSR, CPR, DECDSR, DECRQM (ANSI + DEC), XTVERSION, DECRQSS, OSC 10/11/12/4 queries.
    await write(term, '\x1b[c\x1b[0c\x1b[>c\x1b[=c\x1b[5n\x1b[6n\x1b[?6n\x1b[4$p\x1b[?2004$p\x1b[>q\x1bP$qm\x1b\\\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07\x1b]4;1;?\x07');
    expect(answers).toEqual([]);
    // Control: an unhooked terminal does answer the same bytes.
    const plain = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const plainAnswers: string[] = [];
    plain.onData((d) => plainAnswers.push(d));
    await write(plain, '\x1b[c\x1b[6n');
    expect(plainAnswers.length).toBe(2);
    term.dispose();
    plain.dispose();
  });

  it('still applies colour changes (only queries are absorbed)', async () => {
    const term = newTerm();
    await write(term, '\x1b]11;#102030\x07');
    const seen: string[] = [];
    term.onData((d) => seen.push(d));
    await write(term, '\x1b]11;?\x07');
    expect(seen).toEqual([]);
    term.dispose();
  });

  it('disarms a dead TUI\'s mouse mode on a prompt shell and leaves bracketed paste alone', async () => {
    const { hub } = make();
    const replays: string[] = [];
    hub.pty.onData((_id, data, replay) => { if (replay) replays.push(data); });
    await showLive(hub, 'a');
    const es = FakeEventSource.all[0];
    es.emit('meta', JSON.stringify({ cols: 80, rows: 24, commandRunning: false }));
    es.emit('snapshot', b64(armed));
    const term = newTerm();
    await write(term, replays[0]);
    expect(term.modes.mouseTrackingMode).toBe('none');
    expect(term.modes.sendFocusMode).toBe(false);
    expect(term.modes.bracketedPasteMode).toBe(true);
    expect(replays[0]).not.toContain('\x1b[?2004l');
    term.dispose();
  });

  it('a read-only viewer never arms mouse reporting (a live TUI\'s included)', async () => {
    const ro = newTerm(false);
    await write(ro, '\x1b[?1000h\x1b[?1006h');
    expect(ro.modes.mouseTrackingMode).toBe('none');
    await write(ro, '\x1b[?1049h');
    expect(ro.buffer.active.type).toBe('alternate');
    const rw = newTerm(true);
    await write(rw, '\x1b[?1000h');
    expect(rw.modes.mouseTrackingMode).toBe('vt200');
    ro.dispose();
    rw.dispose();
  });

  it('caps a recovered pane (resumeAgent) at the alive-shell set', async () => {
    expect(snapshotTail({ resumeAgent: 'claude' })).not.toContain('\x1b[?2004l');
    expect(snapshotTail({ resumeAgent: 'claude' })).toContain('\x1b[?1003l');
    expect(snapshotTail({ commandRunning: true })).toBe('');
    expect(snapshotTail({})).toBe('');
  });
});

describe('input', () => {
  it('keys typed during a replay parse wait for it, in order — none dropped', async () => {
    let replaying = true;
    const { hub, inputs } = make({ deps: { isReplaying: () => replaying } });
    hub.setAllowInput(true);
    const sent = ['e', 'c', 'h', 'o', '\x1b[200~multi\rline\x1b[201~'].map((k) => hub.pty.write('a', k));
    await new Promise((r) => setTimeout(r, 60));
    expect(inputs()).toEqual([]);
    replaying = false;
    await Promise.all(sent);
    expect(inputs().map((c) => c.body)).toEqual(['e', 'c', 'h', 'o', '\x1b[200~multi\rline\x1b[201~']);
  });

  it('keys typed before the grant is known wait for it', async () => {
    const { hub, inputs } = make();
    const p = hub.pty.write('a', 'x');
    await new Promise((r) => setTimeout(r, 40));
    expect(inputs()).toEqual([]);
    hub.setAllowInput(true);
    await p;
    expect(inputs().map((c) => c.body)).toEqual(['x']);
  });

  it('never sends the viewer\'s own focus reports', async () => {
    const { hub, inputs } = make();
    hub.setAllowInput(true);
    await hub.pty.write('a', '\x1b[I');
    await hub.pty.write('a', '\x1b[O');
    expect(inputs()).toEqual([]);
  });

  it('a read-only caller cannot send input', async () => {
    const { hub, inputs } = make();
    hub.setAllowInput(false);
    await showLive(hub, 'a');
    await hub.pty.write('a', 'rm -rf ~\r');
    expect(inputs()).toEqual([]);
  });

  it('a refused delivery stops the pane\'s input and counts what was not sent', async () => {
    const { hub, inputs } = make({ reply: (url) => (url.startsWith('/api/input') ? new Response(JSON.stringify({ error: 'terminal-prompt-active' }), { status: 409 }) : undefined) });
    hub.setAllowInput(true);
    await hub.pty.write('a', '1');
    await hub.pty.write('a', '\r');
    await hub.pty.write('a', 'y');
    expect(inputs()).toHaveLength(1);
    expect(hub.inputHaltOf('a')).toEqual({ reason: 'refused:terminal-prompt-active', dropped: 2 });
    hub.resumeInput('a');
    expect(hub.inputHaltOf('a')).toBeUndefined();
  });

  it('offline without receipts: stops at once instead of guessing (no silent loss, no double send)', async () => {
    const { hub, inputs } = make({ reply: (url) => (url.startsWith('/api/input') ? Promise.reject(new TypeError('offline')) : undefined) });
    hub.setAllowInput(true);
    for (const k of 'hello'.split('')) void hub.pty.write('a', k);
    await hub.pty.write('a', '!');
    expect(inputs()).toHaveLength(1);
    expect(hub.inputHaltOf('a')).toEqual({ reason: 'offline', dropped: 5 });
  });

  it('an unconfirmed keystroke is never re-sent (it may have arrived)', async () => {
    const { hub, inputs } = make({ reply: (url) => (url.startsWith('/api/input') ? new Response('', { status: 502 }) : undefined) });
    hub.setAllowInput(true);
    await hub.pty.write('a', 'x');
    expect(inputs()).toHaveLength(1);
    expect(hub.inputHaltOf('a')?.reason).toBe('offline');
  });

  it('keeps input in order per pane', async () => {
    const { hub, inputs } = make();
    hub.setAllowInput(true);
    await Promise.all(['1', '2', '3'].map((k) => hub.pty.write('a', k)));
    expect(inputs().map((c) => c.body)).toEqual(['1', '2', '3']);
  });
});

describe('the caller\'s grant', () => {
  it('re-reads /api/config: a failed first read and a 403 latch both recover', async () => {
    let answer: Response | Error = new TypeError('down');
    const { hub, inputs } = make({ reply: (url) => (url === '/api/config' ? (answer instanceof Error ? Promise.reject(answer) : answer.clone()) : undefined) });
    await hub.refreshConfig();
    expect(hub.inputState()).toBe('checking');
    answer = new Response(JSON.stringify({ allowInput: true, hostPlatform: 'win32' }), { status: 200 });
    await hub.refreshConfig();
    expect(hub.inputState()).toBe('allowed');
    expect(hub.pty.hostPlatform()).toBe('win32');
    // The server shut the door mid-session…
    answer = new Response(JSON.stringify({ allowInput: false }), { status: 200 });
    await hub.refreshConfig();
    expect(hub.inputState()).toBe('read-only');
    await hub.pty.write('a', 'x');
    expect(inputs()).toEqual([]);
    // …and opened it again.
    answer = new Response(JSON.stringify({ allowInput: true }), { status: 200 });
    await hub.refreshConfig();
    expect(hub.inputState()).toBe('allowed');
    await hub.pty.write('a', 'y');
    await until(() => inputs().length === 1);
    expect(inputs().map((c) => c.body)).toEqual(['y']);
  });

  it('a 403 on input turns input off until the grant is re-read', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 403 }));
    const ro = createWebPty({ token: 't', fetchImpl: fetchImpl as unknown as typeof fetch, createEventSource: (u) => new FakeEventSource(u) });
    ro.setAllowInput(true);
    await ro.pty.write('a', 'a');
    expect(ro.inputState()).toBe('read-only');
    await ro.pty.write('a', 'b');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
