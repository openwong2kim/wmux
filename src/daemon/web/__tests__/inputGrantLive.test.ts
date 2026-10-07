/**
 * #1844: a paired device's input grant changed on the desktop must reach an
 * already-open `/classic` viewer without a reload — both ways.
 *
 * Runs the shipped index.html + app.js verbatim in jsdom (no bundler exists for
 * the frontend), with a stub xterm and a scripted /api/config answer.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

interface JsdomWindow extends Window {
  eval(src: string): unknown;
  close(): void;
}
const { JSDOM } = createRequire(__filename)('jsdom') as {
  JSDOM: new (html: string, opts: Record<string, unknown>) => { window: JsdomWindow };
};

const FRONTEND = join(__dirname, '..', 'frontend');
const noop = (): void => undefined;
const read = (name: string): string => readFileSync(join(FRONTEND, name), 'utf8');

interface StubTerm {
  options: { disableStdin?: boolean };
  dataHandlers: Array<(d: string) => void>;
}

async function load() {
  const html = read('index.html').replace(/<script[\s\S]*?<\/script>/gi, '');
  const dom = new JSDOM(html, { url: 'https://desk.example/classic?token=t0k', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window as unknown as Record<string, unknown>;
  // `holdConfig` parks the next /api/config answer until `release()`;
  // `inputStatus` is what /api/input answers.
  const state = { allowInput: false, holdConfig: false, inputStatus: 200 };
  let release: (() => void) | null = null;
  const inputs: string[] = [];
  const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
  win['fetch'] = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.startsWith('/api/config')) {
      const body = { allowInput: state.allowInput };
      if (state.holdConfig) return new Promise((r) => { release = () => r(json(body)); });
      return json(body);
    }
    if (url.startsWith('/api/sessions')) return json({ sessions: [{ id: 'p1', name: 'pane', cols: 80, rows: 24 }] });
    if (url.startsWith('/api/input')) {
      if (state.inputStatus === 200) inputs.push(String(init?.body));
      return json({}, state.inputStatus);
    }
    return json({}, 403);
  });
  const intervals = new Map<number, () => void>();
  const realSetInterval = dom.window.setInterval.bind(dom.window);
  win['setInterval'] = (fn: () => void, ms: number) => {
    intervals.set(ms, fn);
    return realSetInterval(() => undefined, 1 << 30);
  };
  const streams: Array<{ url: string; fire(type: string, data: string): void }> = [];
  win['EventSource'] = class {
    readyState = 1;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private handlers = new Map<string, (e: { data: string }) => void>();
    constructor(public url: string) { streams.push(this); }
    addEventListener(type: string, fn: (e: { data: string }) => void) { this.handlers.set(type, fn); }
    fire(type: string, data: string) { this.handlers.get(type)?.({ data }); }
    close() { this.readyState = 2; }
  };
  const terms: StubTerm[] = [];
  win['Terminal'] = function Terminal(this: Record<string, unknown>, opts: Record<string, unknown>) {
    const t: StubTerm & Record<string, unknown> = {
      options: { ...opts },
      dataHandlers: [],
      element: { offsetWidth: 640, offsetHeight: 384 },
      open: noop, focus: noop, reset: noop, resize: noop, write: noop,
      hasSelection: () => false, getSelection: () => '',
      attachCustomKeyEventHandler: noop, onSelectionChange: noop,
      onData(fn: (d: string) => void) { t.dataHandlers.push(fn); },
    };
    terms.push(t);
    return t;
  };
  win['wmuxAttentionFormat'] = {};
  win['wmuxTouchScroll'] = { attachTouchScroll: noop };
  win['wmuxInlineImages'] = { sync: noop };
  win['wmuxWebKeys'] = { decideWebKey: () => null };
  dom.window.eval(read('pairQuery.js'));
  dom.window.eval(read('app.js'));
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  // The pane stream's first `meta` creates the 1-up terminal.
  streams.find((s) => s.url.startsWith('/api/stream'))?.fire('meta', JSON.stringify({ cols: 80, rows: 24 }));
  await settle();
  const banner = () => dom.window.document.getElementById('banner')?.textContent;
  const type = async (d: string) => { terms[0]?.dataHandlers.forEach((fn) => fn(d)); await settle(); };
  const tick = async () => { intervals.get(10000)?.(); await settle(); };
  const releaseConfig = async () => { release?.(); await settle(); };
  return { dom, state, inputs, terms, banner, type, tick, releaseConfig };
}

describe('/classic follows a live input-grant change (#1844)', () => {
  it('a grant enabled on the desktop makes an open read-only viewer typable', async () => {
    const page = await load();
    expect(page.banner()).toBe('read-only');
    expect(page.terms[0]?.options.disableStdin).toBe(true);
    await page.type('x');
    expect(page.inputs).toEqual([]);

    page.state.allowInput = true;
    await page.tick();

    expect(page.banner()).toBe('input enabled');
    expect(page.terms[0]?.options.disableStdin).toBe(false);
    await page.type('y');
    expect(page.inputs).toEqual(['y']);
    page.dom.window.close();
  });

  it('a revoked grant turns the open viewer read-only again', async () => {
    const page = await load();
    page.state.allowInput = true;
    await page.tick();
    await page.type('a');
    expect(page.inputs).toEqual(['a']);

    page.state.allowInput = false;
    await page.tick();

    expect(page.banner()).toBe('read-only');
    expect(page.terms[0]?.options.disableStdin).toBe(true);
    await page.type('b');
    expect(page.inputs).toEqual(['a']);
    page.dom.window.close();
  });

  it('a revoke that lands while a poll is in flight is not undone by that poll', async () => {
    const page = await load();
    page.state.allowInput = true;
    await page.tick();
    expect(page.banner()).toBe('input enabled');

    // A poll leaves while input is still allowed and its answer is held.
    page.state.holdConfig = true;
    await page.tick();
    // Meanwhile the grant is revoked and a keystroke is refused.
    page.state.inputStatus = 403;
    await page.type('z');
    expect(page.banner()).toBe('read-only');

    // The stale answer arrives last.
    await page.releaseConfig();

    expect(page.banner()).toBe('read-only');
    expect(page.terms[0]?.options.disableStdin).toBe(true);
    page.dom.window.close();
  });
});
