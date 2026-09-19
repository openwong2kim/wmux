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
  .spinner { width: 24px; height: 24px; border: 3px solid #ccc; border-top-color: #333;
             border-radius: 50%; animation: spin 1s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .fader { opacity: 0; transition: opacity 6s linear; }
  .fader.on { opacity: 1; }
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
<!-- A spinner and a slow fade, so the compositor is never idle. -->
<span class="spinner" aria-label="loading"></span>
<p class="fader" id="fader">This paragraph fades in over 6 seconds.</p>
<ul id="long"></ul>
<script>
  // 1500 links: the shipped dogfood page's shape, and the reason the probe's
  // per-element sweeps and per-move round trips have to stay bounded.
  const long = document.getElementById('long');
  for (let i = 1; i <= 1500; i++) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = '#item-' + i;
    link.textContent = 'List item number ' + i + ' with a long enough label to cost bytes';
    li.appendChild(link);
    long.appendChild(li);
  }
  setTimeout(() => document.getElementById('fader').classList.add('on'), 500);
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
  /** Why phase 1 found what it found — a zero is never unexplained. */
  note: string;
  /** Close the page this scan ran on. */
  close: () => Promise<void>;
  /** backendNodeId -> `tag#id`, so an assertion can name what was marked. */
  label: Map<number, string>;
  candidates: HoverCandidate[];
  release: () => Promise<void>;
  client: CdpSession;
  url: () => string;
}


type Browser = { newPage: () => Promise<unknown>; close: () => Promise<void> };

/**
 * The two modes, and why both are here.
 *
 * Headless is what a CI runner can always do. HEADED is what the product
 * actually drives — wmux's chrome backend owns a dedicated, usually unfocused
 * Chrome window — and it is a different machine underneath: one
 * `Input.dispatchMouseEvent` costs ~100 ms there against ~15 ms headless, with
 * the first move of a run paying ~370 ms of compositor wake-up on top. A probe
 * tuned against headless numbers spent its whole budget on the first trigger and
 * silently listed nothing for the second (dogfood, 2026-09-18). So the mode the
 * product uses is a mode under test, and it is the one whose wall clock the
 * budget assertion has to hold in.
 */
const MODES = [
  { name: 'headless', headless: true },
  { name: 'headed', headless: false },
] as const;

function reason(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

interface Harness {
  browser: () => Browser;
  origin: () => string;
  /** Mark the running test SKIPPED, with the reason, when Chrome is absent. */
  skipUnless: (ctx: { skip: (note?: string) => void }) => boolean;
}

/**
 * Stand up one Chrome for one mode, or record why not.
 *
 * Never throws and never hangs, so the suite cannot go red for want of a
 * browser or a display: every failure mode — no Chrome on disk, no
 * playwright-core, a launch that throws, a launch that never answers, no
 * loopback port — becomes a reason string, and every test then marks itself
 * SKIPPED rather than passing vacuously and reporting green for work it did not
 * do. A machine with no display fails the HEADED launch and skips exactly those
 * tests, keeping the headless ones.
 */
function harnessFor(mode: (typeof MODES)[number]): Harness {
  let browser: Browser | null = null;
  let server: Server | null = null;
  let origin = '';
  let skipReason: string | null = null;

  async function setUp(): Promise<void> {
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

    const launching = chromium.launch({ channel: 'chrome', headless: mode.headless });
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
      skipReason = mode.headless
        ? `Google Chrome would not launch: ${reason(error)}`
        : `no display for a headed Chrome: ${reason(error)}`;
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

    if (!mode.headless) {
      // The shipped shape: the window the probe drives is NOT the focused one,
      // because the user is looking at something else. Chrome throttles input
      // and rendering for such a window, which is the whole reason this mode is
      // measured separately.
      //
      // Bounded and swallowed, like everything else in here: this is the last
      // await in setup, and an unbounded one would be the one way left for a
      // loaded machine to blow the hook timeout — which is a FAILURE, and this
      // whole gate exists so that a machine that cannot do headed Chrome skips
      // instead. Losing the spare window only costs the mode its unfocused
      // shape, so it is worth strictly less than the suite staying green.
      await Promise.race([
        (async () => {
          const spare = (await browser.newPage()) as { bringToFront: () => Promise<void> };
          await spare.bringToFront();
        })().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
  }

  beforeAll(async () => {
    await setUp();
    if (skipReason) {
      // eslint-disable-next-line no-console
      console.log(`[hoverSurfaces.chrome ${mode.name}] skipping: ${skipReason}`);
    }
  }, LAUNCH_TIMEOUT_MS + 30_000);

  // Vitest's default hook timeout is 10 s, which closing a real browser and a
  // real server does not always fit on a loaded CI runner — observed as
  // "Hook timed out in 10000ms" on #1424's macOS leg, in a suite whose own
  // tests had all passed. Teardown gets the same room `beforeAll` has.
  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
  }, 60_000);

  return {
    browser: () => browser!,
    origin: () => origin,
    skipUnless: (ctx) => {
      if (!skipReason) return false;
      ctx.skip(skipReason);
      return true;
    },
  };
}

for (const mode of MODES) {
  const h = harnessFor(mode);

  /** Open the fixture, run phase 1, and resolve every mark to a readable label. */
  const openAndScan = async (): Promise<Snap> => {
    const page = (await h.browser().newPage()) as {
      goto: (u: string, o?: unknown) => Promise<unknown>;
      url: () => string;
      close: () => Promise<void>;
      context: () => { newCDPSession: (p: unknown) => Promise<CdpSession> };
    };
    await page.goto(h.origin(), { waitUntil: 'load' });
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
    return {
      note: collection.note,
      label,
      candidates: collection.candidates,
      release: collection.release,
      client,
      url: () => page.url(),
      // Every test gets a fresh page and must give it back: this fixture carries
      // 1500 links and a running animation, and leaving four of them open turned a
      // 600 ms headed test into a 32 s one.
      close: () => page.close().catch(() => undefined),
    };
  };

  describe(`phase 1 against real Chrome (${mode.name})`, () => {
    it('marks only the nav item that has a submenu, on its link', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const snap = await openAndScan();
      try {
        const marked = [...snap.label.values()].sort();
        // Every assertion below carries what the browser actually did: a CI
        // failure that only says "expected [] to include …" cannot tell a page
        // with no hover menus from a scan that timed out or threw, and that is
        // exactly the question an ubuntu Baseline failure left open.
        const seen = `scan note=${snap.note}, marked=${JSON.stringify(marked)}, scores=${JSON.stringify(
          snap.candidates.map((c) => c.score),
        )}`;
        // The live defect was all three `li` marked, on the listitem line.
        expect(marked, seen).toContain('a#nav-products');
        expect(marked, seen).not.toContain('a#nav-about');
        expect(marked, seen).not.toContain('a#nav-contact');
        // Nothing is marked on the `li` itself: `a#…` means the anchor won.
        expect(marked.every((m) => !m.startsWith('li')), seen).toBe(true);
      } finally {
        await snap.release();
        await snap.close();
      }
    }, 60_000);

    it('marks the aria-haspopup button, and no form field', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const snap = await openAndScan();
      try {
        const marked = [...snap.label.values()];
        expect(marked).toContain('button#avatar');
        expect(marked).not.toContain('input#name');
        expect(marked).not.toContain('button#disabled');
      } finally {
        await snap.release();
        await snap.close();
      }
    }, 60_000);
  });

  describe(`phase 2 against real Chrome (${mode.name})`, () => {
    it('lists a CSS-revealed submenu and a JS-revealed sibling menu', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const snap = await openAndScan();
      try {
        let pointer = { x: 20, y: 20 };
        const outcome = await probeHoverSurfaces(snap.client, snap.candidates, {
          currentUrl: () => snap.url(),
          pointerStart: pointer,
          onPointerMoved: (point) => {
            pointer = point;
          },
          // This test is about WHAT the probe finds, so it buys time rather
          // than inheriting the shipped latency promise. TOTAL_BUDGET_MS is
          // tuned for a warm interactive machine; on a contended CI runner the
          // per-trigger slice goes to the approach, `waitUntil` collapses onto
          // it, and every trigger comes back unanswered — the degradation this
          // module is designed to do and to report, read here as a correctness
          // failure. Reproduced exactly by squeezing the budget to 600 ms
          // locally: `probed=2, unanswered=2, revealed=[]`, the same line CI
          // printed on #1423 and #1427. That the probe HOLDS the shipped
          // budget is pinned by the virtual clock in hoverSurfaces.probe.test.ts.
          budgetMs: 30_000,
        });
        expect(outcome.cancelled).toBe(false);

        const lines = new Map<string, string>();
        for (const [backendNodeId, mark] of outcome.revealed) {
          lines.set(snap.label.get(backendNodeId) ?? String(backendNodeId), formatHoverItems(mark));
        }
        // Printed so the run itself is the evidence for the dogfood report.
        // eslint-disable-next-line no-console
        console.log(`[real-chrome ${mode.name} probe]`, JSON.stringify([...lines], null, 2));

        // The CSS case, and the exact shape it failed on live: the rule is
        // `nav li:hover > ul.sub`, so the hovered element is the `li` while the
        // marker — and the hover point — sit on the LINK inside it, and the
        // submenu is the link's SIBLING, not its descendant. Hovering the link
        // puts the `li` in `:hover`, and the reveal watch is scoped from the `li`.
        const seen =
          `scan note=${snap.note}, probed=${outcome.probed}, unanswered=${outcome.unanswered}, ` +
          `revealed=${JSON.stringify([...lines])}`;

        // Whatever it DID list has to be right, in every mode: a wrong menu
        // under a trigger's name is the failure this feature must never have.
        for (const [who, line] of lines) {
          if (who === 'a#nav-products') {
            expect(line, seen).toBe(' [hover first: Shoes | Bags | Hats]');
          } else if (who === 'button#avatar') {
            expect(line, seen).toBe(' [hover first: Profile | Settings | Log out]');
          } else {
            throw new Error(`listed a menu for something with no menu: ${who} — ${seen}`);
          }
        }
        // Neither plain nav link opened anything, so neither earns a line.
        expect(lines.has('a#nav-about'), seen).toBe(false);
        expect(lines.has('a#nav-contact'), seen).toBe(false);
        // And every marked trigger is accounted for — listed, or reported as
        // unanswered. Nothing is silently bare.
        expect(lines.size + outcome.unanswered, seen).toBe(
          snap.candidates.filter((c) => c.backendNodeId !== undefined).length,
        );

        if (mode.headless) {
          // Headless is deterministic enough to require both menus. The CSS case
          // is the exact shape that failed live: the rule is
          // `nav li:hover > ul.sub`, so the hovered element is the `li` while the
          // marker — and the hover point — sit on the LINK inside it, and the
          // submenu is the link's SIBLING, not its descendant.
          expect(lines.get('a#nav-products'), seen).toBe(' [hover first: Shoes | Bags | Hats]');
          // The JS case: the revealed menu is a SIBLING of the button, so a
          // trigger-descendants-only watch saw nothing.
          expect(lines.get('button#avatar'), seen).toBe(
            ' [hover first: Profile | Settings | Log out]',
          );
          expect(outcome.unanswered, seen).toBe(0);
        }
        // Headed is NOT asserted to list any particular menu, and that is a
        // finding, not a convenience. Measured on this page in a headed window
        // that is not the focused one (Chrome 153): one trigger's `before` forces
        // the layout a throttled compositor has not done — ~1.0 s — and each
        // `Input.dispatchMouseEvent` is ~107 ms against ~30 ms headless, so a run
        // that answers both menus and a run that answers neither both happened
        // inside the shipped 5 s ceiling. The budget above is generous enough
        // that headless now answers on any runner, but headed stays unasserted
        // because background throttling has no upper bound to buy past: how
        // hard a hidden window is throttled is the compositor's call, not a
        // number this test can raise. Nothing in this module can make a
        // throttled renderer fast, so the probe is best-effort THERE and the
        // contract it does keep is the one asserted above for every mode: it is
        // bounded, what it lists is correct, and what it could not reach is
        // reported (`unanswered`, rendered as the `hover probe:` note) instead of
        // left as a bare marked line the agent would read as an empty menu.
      } finally {
        await snap.release();
        await snap.close();
      }
    }, 120_000);

    it('closes both surfaces again, so no line says "stays open"', async (ctx) => {
      if (h.skipUnless(ctx)) return;
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
        await snap.close();
      }
    }, 120_000);

    it('produces the whole snapshot the agent reads, marks and items included', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = (await h.browser().newPage()) as {
        goto: (u: string, o?: unknown) => Promise<unknown>;
        close: () => Promise<void>;
      };
      try {
        await page.goto(h.origin(), { waitUntil: 'load' });

        const plain = await generateSnapshot(page as never, { format: 'ai' });
        // eslint-disable-next-line no-console
        console.log(`[real-chrome ${mode.name} snapshot]\n` + plain);

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
        console.log(`[real-chrome ${mode.name} snapshot probeHover:true]\n` + probed);

        expect(probed).not.toContain('stays open');
        // The offer is not repeated once the items are on the lines themselves.
        expect(probed).not.toContain('hover menus:');
        if (mode.headless) {
          expect(probed).toContain('[hover first: Shoes | Bags | Hats]');
          expect(probed).toContain('[hover first: Profile | Settings | Log out]');
          expect(probed).not.toContain('hover probe:');
        } else {
          // Headed: whatever it could not reach is said out loud rather than left
          // as a bare marked line the agent would read as an empty menu. WHICH
          // menus it reaches is not guaranteed here — see the note above.
          const bare = probed.split('\n').filter((l) => /has-submenu$/.test(l)).length;
          if (bare > 0) expect(probed).toContain('hover probe: no items for');
        }
      } finally {
        await page.close().catch(() => undefined);
      }
    }, 120_000);

    it('[CRITICAL] spends no more wall clock than the tool description promises', async (ctx) => {
      if (h.skipUnless(ctx)) return;
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
        console.log(`[real-chrome ${mode.name} probe span] ${span} ms for ${outcome.probed} trigger(s)`);

        // The promise in browser_snapshot's description, and the ceiling the code
        // now actually enforces: TOTAL_BUDGET_MS + RESTORE_GRACE_MS. Measured live
        // at 5.2 s before the restore and close checks were folded into it.
        const ceiling =
          HOVER_PROBE_LIMITS.TOTAL_BUDGET_MS + HOVER_PROBE_LIMITS.RESTORE_GRACE_MS;
        expect(ceiling).toBeLessThanOrEqual(5000);
        // One CDP round trip of slack past the ceiling: the race is checked
        // between calls, so the call in flight when the budget runs out still has
        // to come back.
        expect(span, `span ${span} ms, probed ${outcome.probed}`).toBeLessThan(ceiling + 500);
        // At least one trigger got hovered in either mode, and headless gets
        // through both: a budget kept by starving every trigger is not a budget
        // kept, it is the feature switched off.
        expect(outcome.probed).toBeGreaterThanOrEqual(1);
        if (mode.headless) expect(outcome.revealed.size).toBe(2);
      } finally {
        await snap.release();
        await snap.close();
      }
    }, 120_000);
  });
}
