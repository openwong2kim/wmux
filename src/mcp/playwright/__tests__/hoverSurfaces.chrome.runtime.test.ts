import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HOVER_PROBE_LIMITS,
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

/** Fast pre-check only — the launch attempt below is the real gate. */
const WINDOWS_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/**
 * Upper bound on the launch attempt.
 *
 * A machine without Google Chrome is the ordinary case — every Linux and macOS
 * runner that has not installed it — and `launch({ channel: 'chrome' })` does
 * not always answer that by throwing: it can sit there. A `beforeAll` that
 * merely catches would then fail the suite on its own timeout, which is exactly
 * how the cross-platform Baseline job went red on this branch. So the attempt is
 * bounded, and anything but a prompt success means "skip", never "fail".
 */
const LAUNCH_TIMEOUT_MS = 30_000;

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

type Browser = { newPage: () => Promise<unknown>; close: () => Promise<void> };

let browser: Browser | null = null;
let server: Server | null = null;
let origin = '';
/** Null when Chrome is here and usable; otherwise why the suite is skipped. */
let skipReason: string | null = null;

function reason(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

/**
 * Launch Chrome, or say why not.
 *
 * Never throws and never hangs, so the suite cannot go red for want of a
 * browser; every test then asks `skipUnlessChrome` to mark itself SKIPPED with
 * the reason, rather than passing vacuously and reporting green for work it did
 * not do.
 */
async function setUpChrome(): Promise<void> {
  if (process.platform === 'win32' && !existsSync(WINDOWS_CHROME)) {
    skipReason = `Google Chrome is not installed at ${WINDOWS_CHROME}`;
    return;
  }

  let chromium: { launch: (o: unknown) => Promise<unknown> } | undefined;
  try {
    ({ chromium } = (await import('playwright-core')) as {
      chromium?: { launch: (o: unknown) => Promise<unknown> };
    });
  } catch (error) {
    skipReason = `playwright-core is not resolvable here: ${reason(error)}`;
    return;
  }
  if (!chromium) {
    skipReason = 'playwright-core exposes no chromium';
    return;
  }

  const launching = chromium.launch({ channel: 'chrome', headless: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    browser = (await Promise.race([
      launching,
      new Promise<never>((_resolve, rejectRace) => {
        timer = setTimeout(
          () => rejectRace(new Error(`launch did not answer within ${LAUNCH_TIMEOUT_MS} ms`)),
          LAUNCH_TIMEOUT_MS,
        );
      }),
    ])) as Browser;
  } catch (error) {
    skipReason = `Google Chrome would not launch: ${reason(error)}`;
    // A launch that only LOST the race is still going to produce a browser;
    // close it rather than leave the process behind.
    void launching.then((late) => (late as Browser | null)?.close?.()).catch(() => undefined);
    return;
  } finally {
    if (timer) clearTimeout(timer);
  }

  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    skipReason = 'could not bind a loopback port for the fixture';
    return;
  }
  origin = `http://127.0.0.1:${address.port}/`;
}

beforeAll(async () => {
  await setUpChrome();
  if (skipReason) {
    // eslint-disable-next-line no-console
    console.log(`[hoverSurfaces.chrome] skipping: ${skipReason}`);
  }
}, LAUNCH_TIMEOUT_MS + 30_000);

/**
 * Mark the running test skipped when there is no Chrome.
 *
 * `describe.skipIf` cannot serve here: the verdict is only known after the
 * launch attempt, which is `beforeAll`, and a skipIf condition is read at
 * collection time. Skipping from inside the test is what keeps a runner without
 * Chrome honest — SKIPPED with a reason, never a green tick for an assertion
 * that never ran.
 */
function skipUnlessChrome(ctx: { skip: (note?: string) => void }): boolean {
  if (!skipReason) return false;
  ctx.skip(skipReason);
  return true;
}

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
  it('marks only the nav item that has a submenu, on its link', async (ctx) => {
    if (skipUnlessChrome(ctx)) return;
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

  it('marks the aria-haspopup button, and no form field', async (ctx) => {
    if (skipUnlessChrome(ctx)) return;
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
  it('lists a CSS-revealed submenu and a JS-revealed sibling menu', async (ctx) => {
    if (skipUnlessChrome(ctx)) return;
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

      // The CSS case, and the exact shape it failed on live: the rule is
      // `nav li:hover > ul.sub`, so the hovered element is the `li` while the
      // marker — and the hover point — sit on the LINK inside it, and the
      // submenu is the link's SIBLING, not its descendant. Hovering the link
      // puts the `li` in `:hover`, and the reveal watch is scoped from the `li`.
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

  it('closes both surfaces again, so no line says "stays open"', async (ctx) => {
    if (skipUnlessChrome(ctx)) return;
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

  it('produces the whole snapshot the agent reads, marks and items included', async (ctx) => {
    if (skipUnlessChrome(ctx)) return;
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

  it('[CRITICAL] spends no more wall clock than the tool description promises', async (ctx) => {
    if (skipUnlessChrome(ctx)) return;
    const snap = await openAndScan();
    try {
      const started = Date.now();
      const outcome = await probeHoverSurfaces(snap.client, snap.candidates, {
        currentUrl: () => snap.url(),
        pointerStart: { x: 20, y: 20 },
        onPointerMoved: () => undefined,
      });
      const span = Date.now() - started;
      // eslint-disable-next-line no-console
      console.log(`[real-chrome probe span] ${span} ms for ${outcome.probed} trigger(s)`);

      // The promise in browser_snapshot's description, and the ceiling the code
      // now actually enforces: TOTAL_BUDGET_MS + RESTORE_GRACE_MS. Measured live
      // at 5.2 s before the restore and close checks were folded into it.
      const ceiling =
        HOVER_PROBE_LIMITS.TOTAL_BUDGET_MS + HOVER_PROBE_LIMITS.RESTORE_GRACE_MS;
      expect(ceiling).toBeLessThanOrEqual(2500);
      // One CDP round trip of slack past the ceiling: the race is checked
      // between calls, so the call in flight when the budget runs out still has
      // to come back.
      expect(span).toBeLessThan(ceiling + 500);
      // ...and it still got through both triggers. A budget kept by starving the
      // second trigger is the defect, not the fix.
      expect(outcome.probed).toBe(2);
      expect(outcome.revealed.size).toBe(2);
    } finally {
      await snap.release();
    }
  }, 120_000);
});
