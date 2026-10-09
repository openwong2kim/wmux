// Adapted from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (package/ego-browser/scripts/real-browser-e2e/cases/page-click-hit-target.mjs), MIT License, Copyright (c) 2026 CitroLabs, modified
//
// Where a click lands, against real Chrome: browser_click's ref lane
// (resolveRef + clickWithApproach) must hit the element it was asked for or
// refuse, never the element on top of it. The pointer walks to the target
// first, so an overlay that only appears on hover is part of the scenario.
//
// Not ported: the ambiguous-selector and visible-duplicate scenarios. A wmux
// ref names one element, so it never has duplicates to choose between.
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { MODES, harnessFor } from '../../../../test-utils/realBrowserHarness';
import { generateSnapshot, resolveRef } from '../../snapshot';
import { clickWithApproach } from '../../tools/interaction';
import { CASE_TIMEOUT_MS, openPage, refFor, serveCorpus } from './_support';

/** Bound on a click that is expected to be refused. */
const REFUSAL_TIMEOUT_MS = 500;

const read = (page: Page, key: string) =>
  page.evaluate((k) => (window as unknown as Record<string, unknown>)[k], key);

/** browser_click by ref, with Playwright's waits capped at `timeout`. */
async function clickByRef(page: Page, name: string, timeout: number): Promise<void> {
  const ref = refFor(await generateSnapshot(page), name);
  const el = await resolveRef(page, ref);
  if (!el) throw new Error(`ref=${ref} resolved to nothing`);
  page.setDefaultTimeout(timeout);
  try {
    await clickWithApproach(page, el, false);
  } finally {
    page.setDefaultTimeout(1_500);
  }
}

for (const mode of MODES) {
  const h = harnessFor(mode, { suiteName: 'egoCorpus/page-click-hit-target', serve: serveCorpus });

  describe(`page-click-hit-target (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('refuses a covered target, then lands once a temporary overlay is gone', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/no-frame');
      try {
        await page.evaluate(() => {
          document.body.innerHTML = '';
          const target = document.createElement('button');
          target.id = 'covered-target';
          target.textContent = 'Covered target';
          target.style.cssText = 'position:fixed;left:100px;top:100px;width:240px;height:80px;z-index:10';
          const overlay = document.createElement('button');
          overlay.id = 'click-overlay';
          overlay.textContent = 'Overlay';
          overlay.style.cssText =
            'position:fixed;left:80px;top:80px;width:280px;height:120px;z-index:20';
          const w = window as unknown as { __hitTargetClicks: { target: number; overlay: number } };
          w.__hitTargetClicks = { target: 0, overlay: 0 };
          target.addEventListener('click', () => w.__hitTargetClicks.target++);
          overlay.addEventListener('click', () => w.__hitTargetClicks.overlay++);
          document.body.append(target, overlay);
        });

        await expect(clickByRef(page, 'Covered target', REFUSAL_TIMEOUT_MS)).rejects.toThrow(
          /intercepts pointer events/,
        );
        expect(await read(page, '__hitTargetClicks')).toEqual({ target: 0, overlay: 0 });

        // A coordinate click is the escape hatch: it hits whatever is on top.
        const point = await page.evaluate(() => {
          const rect = document.querySelector('#covered-target')!.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });
        await page.mouse.click(point.x, point.y);
        expect(await read(page, '__hitTargetClicks')).toEqual({ target: 0, overlay: 1 });

        await page.evaluate(() => {
          setTimeout(() => document.querySelector('#click-overlay')?.remove(), 650);
        });
        await clickByRef(page, 'Covered target', 3_000);
        expect(await read(page, '__hitTargetClicks')).toEqual({ target: 1, overlay: 1 });
      } finally {
        await page.close();
      }
    });

    it('rechecks the hit target after the pointer arrives', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/no-frame');
      try {
        await page.evaluate(() => {
          document.body.innerHTML = '';
          const target = document.createElement('button');
          target.id = 'hover-covered-target';
          target.textContent = 'Covered after hover';
          target.style.cssText = 'position:fixed;left:100px;top:240px;width:240px;height:80px;z-index:10';
          const w = window as unknown as { __hoverCoveredClicks: { target: number; overlay: number } };
          w.__hoverCoveredClicks = { target: 0, overlay: 0 };
          target.addEventListener('mouseenter', () => {
            if (document.querySelector('#hover-overlay')) return;
            const overlay = document.createElement('button');
            overlay.id = 'hover-overlay';
            overlay.textContent = 'Appeared on hover';
            overlay.style.cssText =
              'position:fixed;left:80px;top:220px;width:280px;height:120px;z-index:20';
            overlay.addEventListener('click', () => w.__hoverCoveredClicks.overlay++);
            document.body.append(overlay);
          });
          target.addEventListener('click', () => w.__hoverCoveredClicks.target++);
          document.body.append(target);
        });
        await expect(clickByRef(page, 'Covered after hover', REFUSAL_TIMEOUT_MS)).rejects.toThrow();
        // The approach is what raised the overlay, and it received nothing.
        expect(await page.$('#hover-overlay')).not.toBeNull();
        expect(await read(page, '__hoverCoveredClicks')).toEqual({ target: 0, overlay: 0 });
      } finally {
        await page.close();
      }
    });

    it('accepts a descendant or an interactive ancestor at the action point', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/no-frame');
      try {
        await page.evaluate(() => {
          document.body.innerHTML = '';
          const w = window as unknown as { __descendantClicks: number; __ancestorHitClicks: number };
          const button = document.createElement('button');
          button.id = 'descendant-target';
          button.setAttribute('aria-label', 'Descendant target');
          button.style.cssText = 'position:fixed;left:100px;top:380px;width:240px;height:80px;z-index:10';
          button.innerHTML = '<span id="target-child">Child content</span>';
          w.__descendantClicks = 0;
          button.addEventListener('click', () => w.__descendantClicks++);

          const menuItem = document.createElement('li');
          menuItem.id = 'ancestor-hit-target';
          menuItem.setAttribute('role', 'menuitem');
          menuItem.style.cssText =
            'position:fixed;left:100px;top:500px;width:240px;height:80px;z-index:10;list-style:none';
          const label = document.createElement('span');
          label.textContent = 'Ancestor receives click';
          label.style.pointerEvents = 'none';
          menuItem.append(label);
          w.__ancestorHitClicks = 0;
          menuItem.addEventListener('click', () => w.__ancestorHitClicks++);
          document.body.append(button, menuItem);
        });
        await clickByRef(page, 'Descendant target', 1_500);
        expect(await read(page, '__descendantClicks')).toBe(1);
        await clickByRef(page, 'Ancestor receives click', 1_500);
        expect(await read(page, '__ancestorHitClicks')).toBe(1);
      } finally {
        await page.close();
      }
    });
  });
}
