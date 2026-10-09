// Adapted from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (package/ego-browser/scripts/real-browser-e2e/fixture.mjs), MIT License, Copyright (c) 2026 CitroLabs, modified
//
// The fixture pages the egoCorpus suites run against, cut down to the elements
// those suites touch, plus the helpers every suite shares.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Page } from 'playwright-core';
import type { Harness } from '../../../../test-utils/realBrowserHarness';
import { resolveRef } from '../../snapshot';
import { clickWithApproach } from '../../tools/interaction';

/** Upper bound on any single Playwright wait inside a corpus case. */
export const ACTION_TIMEOUT_MS = 1_500;

function pageHtml(kind: 'home' | 'nav-target' | 'secondary' | 'frame', iframeUrl: string | null): string {
  const title = {
    'nav-target': 'fixture nav target',
    secondary: 'fixture secondary',
    frame: 'fixture iframe',
    home: 'fixture home',
  }[kind];
  const heading = {
    'nav-target': 'Navigation target',
    secondary: 'Secondary tab',
    frame: 'Iframe fixture',
    home: 'Helper e2e fixture',
  }[kind];
  const frameOnly =
    kind === 'frame'
      ? '<button id="iframe-action" type="button" aria-label="Run iframe action">Run iframe action</button>' +
        '<label>Iframe field <input id="iframe-field" aria-label="Iframe field"></label>' +
        '<span id="iframe-result">idle</span>'
      : '';
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>body { font-family: system-ui, sans-serif; margin: 24px; } button, input { font: inherit; }</style>
  </head>
  <body>
    <main>
      <h1>${heading}</h1>
      <p data-testid="status">ready</p>
      <button id="click-button" aria-label="Increment counter">Click counter</button>
      <button class="duplicate-action" type="button">Duplicate action</button>
      <button class="duplicate-action" type="button">Duplicate action</button>
      <a id="nav-link" href="/nav-target">Go to nav target</a>
      <span id="click-count">0</span>
      ${iframeUrl ? `<iframe id="fixture-frame" src="${iframeUrl}"></iframe>` : ''}
      <shadow-fixture id="shadow-fixture"></shadow-fixture>
      ${frameOnly}
    </main>
    <script>
      window.__fixtureState = { clicks: 0 };
      const iframeAction = document.querySelector("#iframe-action");
      iframeAction?.addEventListener("click", (event) => {
        document.querySelector("#iframe-result").textContent = "clicked:" + String(event.isTrusted);
      });
      const shadowHost = document.querySelector("#shadow-fixture");
      const shadowRoot = shadowHost.attachShadow({ mode: "open" });
      const nestedHost = document.createElement("nested-shadow-fixture");
      shadowRoot.append(nestedHost);
      const nestedShadowRoot = nestedHost.attachShadow({ mode: "open" });
      const shadowInput = document.createElement("input");
      shadowInput.setAttribute("aria-label", "Shadow field");
      shadowRoot.prepend(shadowInput);
      const shadowButton = document.createElement("button");
      shadowButton.id = "shadow-action";
      shadowButton.textContent = "Shadow action";
      shadowButton.addEventListener("click", () => { shadowButton.dataset.clicked = "true"; });
      nestedShadowRoot.append(shadowButton);
      const count = document.querySelector("#click-count");
      document.querySelector("#click-button").addEventListener("click", () => {
        window.__fixtureState.clicks += 1;
        count.textContent = String(window.__fixtureState.clicks);
      });
    </script>
  </body>
</html>`;
}

function subtreeFrameContent(url: URL): string {
  const mode = url.searchParams.get('mode') === 'cross-origin' ? 'cross-origin' : 'same-origin';
  const frameLabel = mode === 'cross-origin' ? 'Cross-origin OOPIF' : 'Same-origin iframe';
  return `<!doctype html>
<html>
  <head><title>${frameLabel} subtree fixture</title></head>
  <body>
    <main>
      <h1>${frameLabel} subtree content</h1>
      <button id="subtree-action" type="button" aria-label="Run ${frameLabel} subtree action">Run frame action</button>
      <p id="subtree-status">${frameLabel} idle</p>
    </main>
    <script>
      document.querySelector("#subtree-action").addEventListener("click", () => {
        document.querySelector("#subtree-status").textContent = ${JSON.stringify(frameLabel)} + " clicked";
      });
    </script>
  </body>
</html>`;
}

function subtreeFrameHost(url: URL, crossSite: string): string {
  const mode = url.searchParams.get('mode') === 'cross-origin' ? 'cross-origin' : 'same-origin';
  const origin = mode === 'cross-origin' ? crossSite : '';
  return `<!doctype html>
<html>
  <head><title>Snapshot iframe host</title></head>
  <body>
    <main>
      <h1>Snapshot iframe host</h1>
      <p>Host sibling marker</p>
      <iframe id="snapshot-subtree-frame" title="Deferred snapshot subtree frame" width="400" height="300"
        src="${origin}/snapshot-subtree-frame-content?mode=${mode}"></iframe>
    </main>
  </body>
</html>`;
}

/**
 * The fixture server. `crossSite` pages are served from `localhost` on the same
 * port, so an `127.0.0.1` page that frames one gets an out-of-process iframe.
 */
export function serveCorpus(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const port = (req.headers.host ?? '').split(':').pop() ?? '';
  const crossSite = `http://localhost:${port}`;
  const html = (body: string) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  switch (url.pathname) {
    case '/favicon.ico':
      res.writeHead(204);
      res.end();
      return;
    case '/api/slow': {
      const ms = Math.min(Number(url.searchParams.get('ms') || 250), 5_000);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }, ms);
      return;
    }
    case '/nav-target':
      return html(pageHtml('nav-target', '/frame.html'));
    case '/secondary':
      return html(pageHtml('secondary', '/frame.html'));
    case '/frame.html':
      return html(pageHtml('frame', null));
    case '/same-origin-frame':
      return html(pageHtml('home', '/frame.html'));
    case '/no-frame':
      return html(pageHtml('home', null));
    case '/snapshot-subtree-frame-host':
      return html(subtreeFrameHost(url, crossSite));
    case '/snapshot-subtree-frame-content':
      return html(subtreeFrameContent(url));
    default:
      return html(pageHtml('home', `${crossSite}/frame.html`));
  }
}

/** Open a fresh page on `path` with every Playwright wait capped. */
export async function openPage(h: Harness, path: string): Promise<Page> {
  const page = (await h.browser().newPage()) as Page;
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  await page.goto(new URL(path, h.origin()).href, { waitUntil: 'load', timeout: 10_000 });
  return page;
}

/**
 * The ref wmux printed on the first snapshot line naming `name`.
 * Throws with the whole snapshot when there is none, so a miss is readable.
 */
export function refFor(snapshot: string, name: string): string {
  const line = snapshot.split('\n').find((l) => l.includes(name) && /ref="[^"]+"/.test(l));
  const match = line?.match(/ref="([^"]+)"/);
  if (!match) throw new Error(`snapshot exposes no ref for ${JSON.stringify(name)}:\n${snapshot}`);
  return match[1];
}

/** Whether the snapshot prints a ref for `name` at all. */
export function hasRef(snapshot: string, name: string): boolean {
  return snapshot.split('\n').some((l) => l.includes(name) && /ref="[^"]+"/.test(l));
}

/** Per-test bound for a real-browser case: launches are in the hooks, not here. */
export const CASE_TIMEOUT_MS = 30_000;

/** browser_click's ref lane: resolve the ref, then approach and click. */
export async function clickRef(page: Page, ref: string): Promise<void> {
  const el = await resolveRef(page, ref);
  if (!el) throw new Error(`ref=${ref} resolved to nothing`);
  await clickWithApproach(page, el, false);
}

/**
 * browser_fill's ref lane: the typing tools resolve with allowTextEntrySwap
 * (#1466), then fill the handle.
 */
export async function fillRef(page: Page, ref: string, value: string, notes?: string[]): Promise<void> {
  const el = await resolveRef(page, ref, { allowTextEntrySwap: true, ...(notes && { notes }) });
  if (!el) throw new Error(`ref=${ref} resolved to nothing`);
  await el.fill(value);
}

/**
 * A scenario wmux does not pass today, kept running instead of skipped.
 *
 * The scenario must throw (a failed expectation, or wmux refusing the action);
 * the test then passes and the gap stays listed. When wmux starts passing it,
 * this fails so the case gets promoted to an ordinary assertion. Used instead
 * of `it.fails` so a harness error (Chrome missing on a runner that requires
 * it) is not mistaken for the expected failure.
 */
export async function expectKnownGap(gap: string, scenario: () => Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await scenario();
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) {
    throw new Error(`known gap now passes, promote it to a normal assertion: ${gap}`);
  }
  // eslint-disable-next-line no-console
  console.log(`[egoCorpus known gap] ${gap}: ${failure instanceof Error ? failure.message.split('\n')[0] : String(failure)}`);
}
