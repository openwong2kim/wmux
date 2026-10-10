// Adapted from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (package/ego-browser/scripts/real-browser-e2e/cases/page-oopif.mjs), MIT License, Copyright (c) 2026 CitroLabs, modified
//
// Acting inside iframes through snapshot refs, against real Chrome: a
// cross-site frame that Chrome's site isolation puts in its own process (an
// OOPIF) below the fold, and a same-process frame sitting over a top-document
// look-alike.
//
// Not ported: the assertion that the outer document receives trusted wheel
// events. wmux brings a frame into view with scrollIntoViewIfNeeded, not with
// wheel input, and the scenario's point — the owner scrolls into view and the
// action lands — is asserted directly.
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { MODES, harnessFor, type Harness } from '../../../../test-utils/realBrowserHarness';
import { generateSnapshot } from '../../snapshot';
import { CASE_TIMEOUT_MS, clickRef, fillRef, openPage, refFor, serveCorpus } from './_support';

type BrowserCdp = { newBrowserCDPSession: () => Promise<{ send: (m: string) => Promise<unknown> }> };

/** The iframe targets Chrome runs out of process, by URL. */
async function oopifUrls(h: Harness): Promise<string[]> {
  const cdp = await (h.browser() as unknown as BrowserCdp).newBrowserCDPSession();
  const { targetInfos } = (await cdp.send('Target.getTargets')) as {
    targetInfos: Array<{ type: string; url: string }>;
  };
  return targetInfos.filter((t) => t.type === 'iframe').map((t) => t.url);
}

function frameOf(page: Page) {
  const frame = page.frames().find((f) => f.url().includes('/frame.html'));
  if (!frame) throw new Error('fixture frame is not attached');
  return frame;
}

async function frameReady(page: Page): Promise<void> {
  await page
    .frameLocator('#fixture-frame')
    .getByRole('button', { name: 'Run iframe action' })
    .waitFor({ state: 'attached', timeout: 10_000 });
}

for (const mode of MODES) {
  const h = harnessFor(mode, { suiteName: 'egoCorpus/page-oopif', serve: serveCorpus });

  describe(`page-oopif (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('clicks and fills inside a cross-site iframe below the viewport', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/');
      try {
        await frameReady(page);
        // Out of process, or this is not the scenario it claims to be.
        expect((await oopifUrls(h)).some((url) => url.startsWith(h.crossSiteOrigin()))).toBe(true);

        const initial = await page.evaluate(() => {
          const frame = document.querySelector('#fixture-frame') as HTMLIFrameElement;
          frame.style.cssText = 'display:block;margin-top:1600px;width:500px;height:300px';
          return { frameTop: frame.getBoundingClientRect().top, viewportHeight: innerHeight };
        });
        expect(initial.frameTop).toBeGreaterThan(initial.viewportHeight);

        const snapshot = await generateSnapshot(page);
        expect(snapshot).toContain('Run iframe action');
        expect(snapshot).toContain('Iframe field');
        await clickRef(page, refFor(snapshot, 'Run iframe action'));
        await fillRef(page, refFor(snapshot, 'Iframe field'), 'filled through Page');

        expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
        const frame = frameOf(page);
        expect(await frame.evaluate(() => document.querySelector('#iframe-result')?.textContent)).toBe(
          'clicked:true',
        );
        expect(await frame.evaluate(() => (document.querySelector('#iframe-field') as HTMLInputElement).value)).toBe(
          'filled through Page',
        );

        // A later snapshot round still reaches the frame.
        await frame.evaluate(() => {
          document.querySelector('#iframe-result')!.textContent = 'idle';
        });
        const again = await generateSnapshot(page);
        expect(again).toContain('Run iframe action');
        await clickRef(page, refFor(again, 'Run iframe action'));
        expect(await frameOf(page).evaluate(() => document.querySelector('#iframe-result')?.textContent)).toBe(
          'clicked:true',
        );
      } finally {
        await page.close();
      }
    });

    it('a frame ref acts in the frame, not on a covered top-document look-alike', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/same-origin-frame');
      try {
        await frameReady(page);
        await page.evaluate(() => {
          const frame = document.querySelector('#fixture-frame') as HTMLIFrameElement;
          frame.style.cssText = 'position:fixed;left:20px;top:80px;width:500px;height:300px;z-index:20';
          const covered = document.createElement('button');
          covered.id = 'covered-frame-duplicate';
          covered.textContent = 'Run iframe action';
          covered.style.cssText = 'position:fixed;left:100px;top:120px;width:220px;height:60px;z-index:10';
          covered.addEventListener('click', () => {
            covered.dataset.clicked = 'true';
          });
          document.body.append(covered);
        });
        const snapshot = await generateSnapshot(page);
        // The frame is walked inside `main`; the look-alike comes after it.
        const frameLines = snapshot.slice(snapshot.indexOf('- Iframe'));
        await clickRef(page, refFor(frameLines, 'Run iframe action'));
        await fillRef(page, refFor(frameLines, 'Iframe field'), 'same process');
        const result = await page.evaluate(() => {
          const frame = document.querySelector('#fixture-frame') as HTMLIFrameElement;
          return {
            coveredClicked: (document.querySelector('#covered-frame-duplicate') as HTMLElement).dataset.clicked,
            result: frame.contentDocument?.querySelector('#iframe-result')?.textContent,
            value: (frame.contentDocument?.querySelector('#iframe-field') as HTMLInputElement | null)?.value,
          };
        });
        expect(result).toEqual({ coveredClicked: undefined, result: 'clicked:true', value: 'same process' });
      } finally {
        await page.close();
      }
    });

    it('a frame ref from a closed page resolves nothing', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/');
      await frameReady(page);
      const ref = refFor(await generateSnapshot(page), 'Run iframe action');
      await page.close();
      await expect(clickRef(page, ref)).rejects.toThrow(/has been closed/);
    });
  });
}
