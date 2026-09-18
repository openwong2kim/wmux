import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectHoverTriggers,
  formatHoverItems,
  probeHoverSurfaces,
  type HoverCandidate,
} from '../hoverSurfaces';
import { generateSnapshot } from '../snapshot';

// ---------------------------------------------------------------------------
// Phase 1 and phase 2 against REAL Chrome.
//
// Everything else about this feature is pinned against stubs: jsdom for the
// in-page rules (no layout, so every geometry veto is faked) and a recording
// fake for the CDP lane (no renderer, so no `:hover` ever actually fires). Both
// were green while the live behaviour was wrong in three separate ways — a nav
// whose every item got marked, a marker on a line with no ref, and a probe that
// reported nothing on a page whose menus opened fine (dogfood, 2026-09-18). A
// hover is a layout-and-cascade effect; the only honest test of one runs in a
// browser.
//
// Skipped, not failed, where Chrome is absent: this is the runtime suite, and it
// must stay runnable on a machine without a browser installed.
// ---------------------------------------------------------------------------

/** The page under test: the two shapes a hover menu comes in. */
const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hover fixture</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; }
  nav > ul { display: flex; gap: 24px; list-style: none; padding: 0; }
  nav li { position: relative; }
  /* Phase-1 detectable: a :hover rule revealing a DIFFERENT element. */
  nav li > ul.sub { display: none; position: absolute; top: 100%; left: 0; background: #fff;
                    border: 1px solid #999; padding: 8px; list-style: none; min-width: 160px; }
  nav li:hover > ul.sub { display: block; }
  .menu-btn { cursor: pointer; }
  #jsmenu { display: none; border: 1px solid #999; padding: 8px; }
  #jsmenu.open { display: block; }
</style></head>
<body>
<h1>Dogfood fixture</h1>
<nav aria-label="Main"><ul>
  <li><a href="#products" id="nav-products">Products</a>
    <ul class="sub">
      <li><a href="#shoes">Shoes</a></li>
      <li><a href="#bags">Bags</a></li>
      <li><a href="#hats">Hats</a></li>
    </ul></li>
  <li><a href="#about" id="nav-about">About</a></li>
  <li><a href="#contact" id="nav-contact">Contact</a></li>
</ul></nav>
<!-- Phase-1 detectable via aria-haspopup; revealed by JS, as a SIBLING. -->
<button class="menu-btn" id="avatar" aria-haspopup="menu" aria-expanded="false">Account</button>
<div id="jsmenu" role="menu">
  <a role="menuitem" href="#profile">Profile</a>
  <a role="menuitem" href="#settings">Settings</a>
  <a role="menuitem" href="#logout">Log out</a>
</div>
<p><input id="name" placeholder="your name"><button id="disabled" disabled>Disabled</button></p>
<script>
  const avatar = document.getElementById('avatar');
  const jsmenu = document.getElementById('jsmenu');
  avatar.addEventListener('mouseenter', () => {
    jsmenu.classList.add('open');
    avatar.setAttribute('aria-expanded', 'true');
  });
  avatar.addEventListener('mouseleave', () => {
    jsmenu.classList.remove('open');
    avatar.setAttribute('aria-expanded', 'false');
  });
</script>
</body></html>`;

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** Chrome, and a Playwright to drive it with. Null means "skip these tests". */
async function loadChromium(): Promise<{ launch: (o: unknown) => Promise<unknown> } | null> {
  if (process.platform === 'win32' && !existsSync(CHROME)) return null;
  try {
    const playwright = (await import('playwright-core')) as {
      chromium?: { launch: (o: unknown) => Promise<unknown> };
    };
    return playwright.chromium ?? null;
  } catch {
    return null;
  }
}

interface CdpSession {
  send: (method: string, params?: unknown) => Promise<unknown>;
}

interface Snap {
  /** backendNodeId -> `tag#id`, so an assertion can name what was marked. */
  label: Map<number, string>;
  candidates: HoverCandidate[];
  release: () => Promise<void>;
  client: CdpSession;
  url: () => string;
}

let browser: { newPage: () => Promise<unknown>; close: () => Promise<void> } | null = null;
let server: Server | null = null;
let origin = '';
let available = false;

beforeAll(async () => {
  const chromium = await loadChromium();
  if (!chromium) return;
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') return;
  origin = `http://127.0.0.1:${address.port}/`;
  try {
    browser = (await chromium.launch({ channel: 'chrome', headless: true })) as typeof browser;
  } catch {
    browser = null;
    return;
  }
  available = true;
}, 120_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
});

/** Open the fixture, run phase 1, and resolve every mark to a readable label. */
async function openAndScan(): Promise<Snap> {
  const page = (await browser!.newPage()) as {
    goto: (u: string, o?: unknown) => Promise<unknown>;
    url: () => string;
    context: () => { newCDPSession: (p: unknown) => Promise<CdpSession> };
  };
  await page.goto(origin, { waitUntil: 'load' });
  const client = await page.context().newCDPSession(page);
  await client.send('DOM.enable');

  const collection = await collectHoverTriggers(client);
  const label = new Map<number, string>();
  for (const candidate of collection.candidates) {
    if (candidate.backendNodeId === undefined) continue;
    const described = (await client.send('DOM.describeNode', {
      objectId: candidate.anchorObjectId,
    })) as { node?: { nodeName?: string; attributes?: string[] } };
    const attrs = described.node?.attributes ?? [];
    let id = '';
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id') id = attrs[i + 1];
    label.set(
      candidate.backendNodeId,
      `${String(described.node?.nodeName ?? '?').toLowerCase()}${id ? `#${id}` : ''}`,
    );
  }
  return { label, candidates: collection.candidates, release: collection.release, client, url: () => page.url() };
}

describe('phase 1 against real Chrome', () => {
  it('marks only the nav item that has a submenu, on its link', async () => {
    if (!available) return;
    const snap = await openAndScan();
    try {
      const marked = [...snap.label.values()].sort();
      // The live defect was all three `li` marked, on the listitem line.
      expect(marked).toContain('a#nav-products');
      expect(marked).not.toContain('a#nav-about');
      expect(marked).not.toContain('a#nav-contact');
      // Nothing is marked on the `li` itself: `a#…` means the anchor won.
      expect(marked.every((m) => !m.startsWith('li'))).toBe(true);
    } finally {
      await snap.release();
    }
  }, 60_000);

  it('marks the aria-haspopup button, and no form field', async () => {
    if (!available) return;
    const snap = await openAndScan();
    try {
      const marked = [...snap.label.values()];
      expect(marked).toContain('button#avatar');
      expect(marked).not.toContain('input#name');
      expect(marked).not.toContain('button#disabled');
    } finally {
      await snap.release();
    }
  }, 60_000);
});

describe('phase 2 against real Chrome', () => {
  it('lists a CSS-revealed submenu and a JS-revealed sibling menu', async () => {
    if (!available) return;
    const snap = await openAndScan();
    try {
      let pointer = { x: 20, y: 20 };
      const outcome = await probeHoverSurfaces(snap.client, snap.candidates, {
        currentUrl: () => snap.url(),
        pointerStart: pointer,
        onPointerMoved: (point) => {
          pointer = point;
        },
      });
      expect(outcome.cancelled).toBe(false);

      const lines = new Map<string, string>();
      for (const [backendNodeId, mark] of outcome.revealed) {
        lines.set(snap.label.get(backendNodeId) ?? String(backendNodeId), formatHoverItems(mark));
      }
      // Printed so the run itself is the evidence for the dogfood report.
      // eslint-disable-next-line no-console
      console.log('[real-chrome probe]', JSON.stringify([...lines], null, 2));

      // The CSS case: hovering the Products LINK triggers the `li:hover` rule.
      expect(lines.get('a#nav-products')).toBe(' [hover first: Shoes | Bags | Hats]');
      // The JS case, which returned nothing live: the revealed menu is a
      // SIBLING of the button, so a trigger-descendants-only watch saw nothing.
      expect(lines.get('button#avatar')).toBe(' [hover first: Profile | Settings | Log out]');
      // Neither plain nav link opened anything, so neither earns a line.
      expect(lines.has('a#nav-about')).toBe(false);
      expect(lines.has('a#nav-contact')).toBe(false);
    } finally {
      await snap.release();
    }
  }, 120_000);

  it('closes both surfaces again, so no line says "stays open"', async () => {
    if (!available) return;
    const snap = await openAndScan();
    try {
      let pointer = { x: 20, y: 20 };
      const outcome = await probeHoverSurfaces(snap.client, snap.candidates, {
        currentUrl: () => snap.url(),
        pointerStart: pointer,
        onPointerMoved: (point) => {
          pointer = point;
        },
      });
      for (const mark of outcome.revealed.values()) expect(mark.staysOpen).toBe(false);

      // And the page really is back as it was: the JS menu is closed and the
      // button's aria-expanded is false again.
      const after = (await snap.client.send('Runtime.evaluate', {
        expression:
          "[document.getElementById('jsmenu').classList.contains('open')," +
          "document.getElementById('avatar').getAttribute('aria-expanded')].join(',')",
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      expect(after.result?.value).toBe('false,false');
    } finally {
      await snap.release();
    }
  }, 120_000);

  it('produces the whole snapshot the agent reads, marks and items included', async () => {
    if (!available) return;
    const page = (await browser!.newPage()) as {
      goto: (u: string, o?: unknown) => Promise<unknown>;
      close: () => Promise<void>;
    };
    try {
      await page.goto(origin, { waitUntil: 'load' });

      const plain = await generateSnapshot(page as never, { format: 'ai' });
      // eslint-disable-next-line no-console
      console.log('[real-chrome snapshot]\n' + plain);

      // Defect 3: a leading note, so windowing a long page cannot lose it.
      expect(plain.split('\n')[0]).toBe(
        'hover menus: 2 triggers marked has-submenu; pass probeHover:true to list their items',
      );
      // Defects 1 and 2: the marker is on the ref-bearing link of the ONE nav
      // item that has a submenu, and on the account button.
      const marked = plain
        .split('\n')
        .filter((l) => l.includes('has-submenu') && l.trimStart().startsWith('-'));
      expect(marked.length).toBe(2);
      expect(marked.some((l) => /link "Products" ref="\d+" has-submenu/.test(l))).toBe(true);
      expect(marked.some((l) => /button "Account".*has-submenu/.test(l))).toBe(true);
      expect(plain).toMatch(/- link "About" ref="\d+"$/m);
      expect(plain).toMatch(/- link "Contact" ref="\d+"$/m);
      // And never a form field.
      expect(plain).not.toMatch(/textbox.*has-submenu/);

      const probed = await generateSnapshot(page as never, { format: 'ai', probeHover: true });
      // eslint-disable-next-line no-console
      console.log('[real-chrome snapshot probeHover:true]\n' + probed);

      expect(probed).toContain('[hover first: Shoes | Bags | Hats]');
      expect(probed).toContain('[hover first: Profile | Settings | Log out]');
      expect(probed).not.toContain('stays open');
      // The offer is not repeated once the items are on the lines themselves.
      expect(probed).not.toContain('hover menus:');
    } finally {
      await page.close().catch(() => undefined);
    }
  }, 120_000);

  it('stays inside its budget on a real renderer', async () => {
    if (!available) return;
    const snap = await openAndScan();
    try {
      const started = Date.now();
      await probeHoverSurfaces(snap.client, snap.candidates, {
        currentUrl: () => snap.url(),
        pointerStart: { x: 20, y: 20 },
        onPointerMoved: () => undefined,
      });
      // TOTAL_BUDGET_MS plus the restore's own budget, with room for the round
      // trips a cold renderer adds.
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally {
      await snap.release();
    }
  }, 120_000);
});
