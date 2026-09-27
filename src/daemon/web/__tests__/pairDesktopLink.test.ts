/**
 * The computer pairing link opened in a BROWSER must not pair that browser.
 *
 * `<origin>/pair#wmux-desktop-code=XXXXXXXX` is for the wmux app on another
 * computer. Runs the shipped index.html + pairQuery.js + app.js verbatim in
 * jsdom (no bundler exists for the frontend) and watches every fetch.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { DESKTOP_PAIR_FRAGMENT_KEY, buildDesktopPairLink } from '../../../shared/web';

// jsdom ships no type declarations here; only the handful of members used below.
interface JsdomWindow extends Window {
  eval(src: string): unknown;
  close(): void;
}
interface JSDOM {
  window: JsdomWindow;
}
const { JSDOM } = createRequire(__filename)('jsdom') as {
  JSDOM: new (html: string, opts: Record<string, unknown>) => JSDOM;
};

const FRONTEND = join(__dirname, '..', 'frontend');
const read = (name: string): string => readFileSync(join(FRONTEND, name), 'utf8');

interface Loaded {
  dom: JSDOM;
  fetchCalls: string[];
}

async function load(url: string): Promise<Loaded> {
  // The markup without its script tags: this test injects the two scripts
  // itself, in the order build-daemon-web.mjs inlines them.
  const html = read('index.html').replace(/<script[\s\S]*?<\/script>/gi, '');
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const fetchCalls: string[] = [];
  const win = dom.window as unknown as Record<string, unknown>;
  win['fetch'] = vi.fn((input: unknown) => {
    fetchCalls.push(String(input));
    // Never resolves: nothing below depends on an answer, only on the call.
    return new Promise(() => undefined);
  });
  // Top-level globals app.js expects from its other inlined bundles.
  win['Terminal'] = function Terminal() { /* unused on the pairing screen */ };
  win['wmuxAttentionFormat'] = {};
  win['wmuxTouchScroll'] = {};
  dom.window.eval(read('pairQuery.js'));
  dom.window.eval(read('app.js'));
  await new Promise((r) => setTimeout(r, 20));
  return { dom, fetchCalls };
}

describe('computer pairing link opened in a browser', () => {
  it('never calls /api/pair, never fills the form, and drops the fragment', async () => {
    // Not the form's placeholder (ABCD2345), so "nowhere in the page" means it.
    const link = buildDesktopPairLink('https://desk.tail.ts.net', 'QWXZ7K9M');
    const { dom, fetchCalls } = await load(link);
    const doc = dom.window.document;

    expect(fetchCalls.filter((u) => u.includes('/api/pair'))).toEqual([]);
    expect((doc.getElementById('ov-code') as HTMLInputElement).value).toBe('');
    expect(doc.getElementById('overlay')?.getAttribute('data-show')).toBe('info');
    expect(doc.getElementById('ov-body')?.textContent).toContain('Paste this link into the wmux app');
    // Gone from the address bar; the code is nowhere in the page.
    expect(dom.window.location.hash).toBe('');
    expect(dom.window.location.href).toBe('https://desk.tail.ts.net/pair');
    expect(doc.documentElement.outerHTML).not.toContain('QWXZ7K9M');
    dom.window.close();
  });

  it('★ REGRESSION: the phone QR link (?code=) still redeems exactly as before', async () => {
    const { dom, fetchCalls } = await load('https://desk.tail.ts.net/pair?code=ABCD2345');
    expect(fetchCalls).toContain('/api/pair?code=ABCD2345');
    expect(dom.window.location.search).toBe('');
    dom.window.close();
  });

  it('keeps the fragment key identical on both sides of the no-bundler seam', () => {
    const sandbox: Record<string, unknown> = { URLSearchParams };
    runInNewContext(read('pairQuery.js'), sandbox);
    const mod = (sandbox as { pairQuery: { DESKTOP_FRAGMENT_KEY: string; hasDesktopCode: (h: string) => boolean } })
      .pairQuery;
    expect(mod.DESKTOP_FRAGMENT_KEY).toBe(DESKTOP_PAIR_FRAGMENT_KEY);
    expect(mod.hasDesktopCode(`#${DESKTOP_PAIR_FRAGMENT_KEY}=ABCD2345`)).toBe(true);
    expect(mod.hasDesktopCode('#WMUX-DESKTOP-CODE=abcd2345')).toBe(true);
    expect(mod.hasDesktopCode('#code=ABCD2345')).toBe(false);
    expect(mod.hasDesktopCode('')).toBe(false);
  });
});
