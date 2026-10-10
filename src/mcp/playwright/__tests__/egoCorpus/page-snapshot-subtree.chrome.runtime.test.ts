// Adapted from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (package/ego-browser/scripts/real-browser-e2e/cases/page-snapshot-subtree.mjs), MIT License, Copyright (c) 2026 CitroLabs, modified
//
// Partial snapshots, against real Chrome. wmux scopes a snapshot by CSS
// selector (generateScopedSnapshot) rather than by a ref root, so the
// scenarios run with the selector of the element the ref root named.
//
// Not ported: the argument-validation errors (subtree without a root, a root
// on a full-page scope, a selector passed as a root). Those belong to a
// ref-root API wmux does not have; the nearest wmux contract, a selector that
// matches nothing returning null, is asserted instead. Also not ported: the
// lazy, sibling, nested, replaced and viewport iframe variants, which exercise
// the same frame-scoping path as the two iframe cases kept here.
import { describe, expect, it } from 'vitest';
import { MODES, harnessFor } from '../../../../test-utils/realBrowserHarness';
import { StaleRefError, generateScopedSnapshot, generateSnapshot } from '../../snapshot';
import { CASE_TIMEOUT_MS, GapObserved, clickRef, expectKnownGap, openPage, refFor, serveCorpus } from './_support';

const clicks = (page: import('playwright-core').Page) =>
  page.evaluate(() => (window as unknown as { __fixtureState: { clicks: number } }).__fixtureState.clicks);

for (const mode of MODES) {
  const h = harnessFor(mode, { suiteName: 'egoCorpus/page-snapshot-subtree', serve: serveCorpus });

  describe(`page-snapshot-subtree (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('a scoped snapshot holds its root and descendants and none of the siblings', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/no-frame');
      try {
        const full = await generateSnapshot(page);
        const rootRef = refFor(full, 'Increment counter');

        const subtree = await generateScopedSnapshot(page, '#click-button');
        expect(subtree).not.toBeNull();
        expect(subtree).toContain('Increment counter');
        expect(subtree).toContain('Click counter');
        expect(subtree).not.toContain('Helper e2e fixture');
        expect(subtree).not.toContain('Duplicate action');
        expect(refFor(subtree!, 'Increment counter')).toBe(rootRef);

        // The root's own ref: getByRole only searches below the scope root.
        await expectKnownGap(
          'the scope root of a selector-scoped snapshot resolves to nothing',
          /resolved to nothing/,
          () => clickRef(page, rootRef),
        );
        expect(await clicks(page)).toBe(0);
      } finally {
        await page.close();
      }
    });

    it('a ref printed by a scoped snapshot stays actionable', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/no-frame');
      try {
        const subtree = await generateScopedSnapshot(page, 'main');
        expect(subtree).not.toBeNull();
        await clickRef(page, refFor(subtree!, 'Increment counter'));
        expect(await clicks(page)).toBe(1);
      } finally {
        await page.close();
      }
    });

    it('a selector that matches nothing yields no snapshot, and navigation retires the refs', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/no-frame');
      try {
        expect(await generateScopedSnapshot(page, '#does-not-exist')).toBeNull();
        const subtree = await generateScopedSnapshot(page, 'main');
        const ref = refFor(subtree!, 'Increment counter');
        await page.goto(new URL('/nav-target', h.origin()).href, { waitUntil: 'load' });
        await expect(clickRef(page, ref)).rejects.toBeInstanceOf(StaleRefError);
      } finally {
        await page.close();
      }
    });

    for (const [frameMode, frameLabel] of [
      ['same-origin', 'Same-origin iframe'],
      ['cross-origin', 'Cross-origin OOPIF'],
    ] as const) {
      it(`an iframe's contents can be snapshotted and acted on (${frameMode})`, async (ctx) => {
        if (h.skipUnless(ctx)) return;
        const page = await openPage(h, `/snapshot-subtree-frame-host?mode=${frameMode}`);
        try {
          const actionName = `Run ${frameLabel} subtree action`;
          const frameMarker = `${frameLabel} subtree content`;
          await page
            .frameLocator('#snapshot-subtree-frame')
            .getByRole('button', { name: actionName })
            .waitFor({ state: 'visible', timeout: 10_000 });

          const initial = await generateSnapshot(page);
          expect(initial).toContain('Snapshot iframe host');
          expect(initial).toContain(frameMarker);

          // A selector scope cannot reach into a frame's document, so the
          // frame subtree is taken from the full snapshot's frame refs.
          const scoped = await generateScopedSnapshot(page, '#snapshot-subtree-frame');
          // Whatever it lists, a frame-scoped snapshot never lists the host's siblings.
          expect(scoped ?? '').not.toContain('Host sibling marker');
          await expectKnownGap('a snapshot scoped to an iframe element lists the frame contents', /^GapObserved/, async () => {
            if (!(scoped ?? '').includes(frameMarker)) throw new GapObserved('the frame contents are not listed');
          });

          const full = await generateSnapshot(page);
          await clickRef(page, refFor(full, actionName));
          expect(await generateSnapshot(page)).toContain(`${frameLabel} clicked`);
        } finally {
          await page.close();
        }
      });
    }
  });
}
