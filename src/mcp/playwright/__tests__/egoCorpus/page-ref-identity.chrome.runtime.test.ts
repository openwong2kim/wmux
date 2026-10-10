// Adapted from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (package/ego-browser/scripts/real-browser-e2e/cases/page-ref-identity.mjs), MIT License, Copyright (c) 2026 CitroLabs, modified
//
// Ref identity across snapshots, against real Chrome: a ref names one DOM node
// for as long as that node lives, whatever later snapshots looked like.
//
// Not ported: the `only_within_viewport` scope variant. wmux snapshots have no
// viewport-only scope; the selector-scoped snapshot is the partial snapshot
// that exists, so the scenario runs with that one.
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { MODES, harnessFor } from '../../../../test-utils/realBrowserHarness';
import { StaleRefError, generateScopedSnapshot, generateSnapshot, resolveRef } from '../../snapshot';
import {
  CASE_TIMEOUT_MS,
  clickRef,
  GapObserved,
  expectKnownGap,
  fillRef,
  openPage,
  refFor,
  serveCorpus,
} from './_support';

type Clicks = { first: number; second: number };

async function twoButtons(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.body.innerHTML =
      '<button id="first" aria-label="First ref action">First ref action</button>' +
      '<button id="second" aria-label="Second ref action">Second ref action</button>';
    const w = window as unknown as { __refClicks: Clicks };
    w.__refClicks = { first: 0, second: 0 };
    for (const id of ['first', 'second'] as const) {
      document.getElementById(id)!.onclick = () => w.__refClicks[id]++;
    }
  });
}

const clicks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __refClicks: Clicks }).__refClicks);

for (const mode of MODES) {
  const h = harnessFor(mode, { suiteName: 'egoCorpus/page-ref-identity', serve: serveCorpus });

  describe(`page-ref-identity (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('a scoped snapshot keeps the ref the full snapshot gave a node and omits the rest', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/nav-target');
      try {
        await twoButtons(page);
        const full = await generateSnapshot(page);
        const secondRef = refFor(full, 'Second ref action');
        const partial = await generateScopedSnapshot(page, '#second');
        expect(partial).not.toBeNull();
        expect(refFor(partial!, 'Second ref action')).toBe(secondRef);
        expect(partial).not.toContain('First ref action');

        // getByRole searches the descendants of the scope root, never the root
        // itself, so the ref of the element the snapshot was scoped TO has
        // nothing to resolve to while that snapshot is the latest one.
        await expectKnownGap(
          'the scope root of a selector-scoped snapshot resolves to nothing',
          /resolved to nothing/,
          () => clickRef(page, secondRef),
        );
        // The refused click reached neither button.
        expect(await clicks(page)).toEqual({ first: 0, second: 0 });
      } finally {
        await page.close();
      }
    });

    it('known gap: a ref the scoped snapshot omitted still clicks its own node', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/nav-target');
      try {
        await twoButtons(page);
        const full = await generateSnapshot(page);
        const firstRef = refFor(full, 'First ref action');
        const secondRef = refFor(full, 'Second ref action');
        await generateScopedSnapshot(page, '#second');
        // resolveRef answers from the LATEST snapshot's ref list, so a node a
        // narrower snapshot left out reads as gone (StaleRefError) even though
        // it is still on the page and its number was never reused.
        await expectKnownGap(
          'resolveRef refuses a ref the last scoped snapshot omitted',
          /^StaleRefError: .*no longer in the page snapshot/,
          () => clickRef(page, firstRef),
        );
        // Refused outright: nothing was clicked in its place.
        expect(await clicks(page)).toEqual({ first: 0, second: 0 });
        // A fresh full snapshot gives the same number back to the same node.
        expect(refFor(await generateSnapshot(page), 'First ref action')).toBe(firstRef);
        await clickRef(page, firstRef);
        await clickRef(page, secondRef);
        expect(await clicks(page)).toEqual({ first: 1, second: 1 });
      } finally {
        await page.close();
      }
    });

    it('refs survive a read-only evaluate and a later snapshot generation', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/nav-target');
      try {
        await page.evaluate(() => {
          document.body.innerHTML =
            '<button id="first" aria-label="First round action">First round action</button>' +
            '<button id="second" aria-label="Second round action">Second round action</button>' +
            '<input aria-label="Cell address"><output></output>' +
            '<select aria-label="Sort homes"><option value="recommended">Recommended</option>' +
            '<option value="list_price_asc">Price (low to high)</option></select>';
          const w = window as unknown as { __refClicks: Clicks };
          w.__refClicks = { first: 0, second: 0 };
          document.getElementById('second')!.onclick = () => w.__refClicks.second++;
          document.querySelector('input')!.onkeydown = (event) => {
            if (event.key === 'Enter') {
              document.querySelector('output')!.textContent = (event.target as HTMLInputElement).value;
            }
          };
          document.getElementById('first')!.onclick = () => {
            w.__refClicks.first++;
            const input = document.querySelector('input')!;
            input.replaceWith(input.cloneNode(true));
          };
        });
        const initial = await generateSnapshot(page);
        const secondRef = refFor(initial, 'Second round action');
        const inputRef = refFor(initial, 'Cell address');
        const sortRef = refFor(initial, 'Sort homes');

        // A read between snapshot and action changes nothing on the page.
        const options = await page.evaluate(() =>
          [...document.querySelector('select')!.options].map((option) => option.value),
        );
        expect(options).toContain('list_price_asc');

        const select = await resolveRef(page, sortRef);
        expect(await select!.selectOption('list_price_asc')).toEqual(['list_price_asc']);
        await clickRef(page, secondRef);
        await fillRef(page, inputRef, 'M2');
        await (await resolveRef(page, inputRef))!.press('Enter');
        expect(await clicks(page)).toEqual({ first: 0, second: 1 });
        expect(await page.evaluate(() => document.querySelector('output')!.textContent)).toBe('M2');

        // A new generation: the same refs still name the same nodes.
        await generateSnapshot(page);
        await clickRef(page, secondRef);
        expect((await clicks(page)).second).toBe(2);
      } finally {
        await page.close();
      }
    });

    it('known gap: a node replaced by a same-name clone does not inherit its ref', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/nav-target');
      try {
        await page.evaluate(() => {
          document.body.innerHTML =
            '<button id="replace" aria-label="Replace input">Replace input</button>' +
            '<input aria-label="Cell address" value="M2">';
          document.getElementById('replace')!.onclick = () => {
            const input = document.querySelector('input')!;
            input.replaceWith(input.cloneNode(true));
          };
        });
        const snap = await generateSnapshot(page);
        const inputRef = refFor(snap, 'Cell address');
        await clickRef(page, refFor(snap, 'Replace input'));

        // resolveRef locates by role + accessible name + position, so a clone
        // with the same role and name in the same place is the same element
        // to it, on the click lane as on the typing lane.
        await expectKnownGap('a same-role, same-name clone inherits the replaced node\'s ref', /^GapObserved/, async () => {
          const el = await resolveRef(page, inputRef, { timeout: 500 }).catch((error: unknown) => {
            if (error instanceof StaleRefError) return null; // the fixed behaviour
            throw error;
          });
          if (el) throw new GapObserved('the old ref resolved to the clone');
        });
        await expectKnownGap('a fill through the old ref lands in the replacement', /^GapObserved/, async () => {
          const filled = await fillRef(page, inputRef, 'wrong node').then(
            () => true,
            (error: unknown) => {
              if (error instanceof StaleRefError) return false; // the fixed behaviour
              throw error;
            },
          );
          if (filled) throw new GapObserved('the fill landed in the replacement');
        });
        // Exactly one input on the page, so the fill went nowhere else.
        expect(await page.locator('input').count()).toBe(1);
      } finally {
        await page.close();
      }
    });

    it('a navigation retires every ref from the previous document', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/nav-target');
      try {
        await twoButtons(page);
        const ref = refFor(await generateSnapshot(page), 'Second ref action');
        const destination = new URL('/nav-target?after-evaluate', h.origin()).href;
        await page.evaluate((url) => {
          location.href = url;
        }, destination);
        await page.waitForURL(destination);
        await expect(clickRef(page, ref)).rejects.toBeInstanceOf(StaleRefError);
      } finally {
        await page.close();
      }
    });
  });
}
