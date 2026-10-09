// Adapted from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (package/ego-browser/scripts/real-browser-e2e/cases/task-space.mjs), MIT License, Copyright (c) 2026 CitroLabs, modified
//
// Isolation between two agents' pages, against real Chrome. The source case
// checks that two task spaces keep their requests and pages apart; the wmux
// unit of that separation is the page, whose snapshot owns its own ref
// numbering. So: two pages snapshotted and acted on in an interleaved order,
// and nothing one does may reach, renumber or retire the other's refs.
//
// Not ported: creating, switching, handing off, taking over and finishing
// named task spaces. Those are lifecycle calls of an API wmux does not have;
// wmux's workspace and surface lifecycle is owned by the app, not this lane.
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { MODES, harnessFor } from '../../../../test-utils/realBrowserHarness';
import { StaleRefError, generateSnapshot, listRefEntries, resolveRef } from '../../snapshot';
import { CASE_TIMEOUT_MS, clickRef, openPage, refFor, serveCorpus } from './_support';

const clicks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fixtureState: { clicks: number } }).__fixtureState.clicks);

for (const mode of MODES) {
  const h = harnessFor(mode, { suiteName: 'egoCorpus/task-space', serve: serveCorpus });

  describe(`task-space isolation (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('two pages keep their own refs through interleaved snapshots and actions', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const first = await openPage(h, '/no-frame?space=first');
      const second = await openPage(h, '/no-frame?space=second');
      try {
        const firstRef = refFor(await generateSnapshot(first), 'Increment counter');
        // Same fixture, so the second page prints the same number for its own node.
        const secondSnap = await generateSnapshot(second);
        const secondRef = refFor(secondSnap, 'Increment counter');
        expect(secondRef).toBe(firstRef);

        // The second page's snapshot did not replace the first page's ref map.
        await clickRef(first, firstRef);
        expect([await clicks(first), await clicks(second)]).toEqual([1, 0]);

        // A page navigating retires only its own refs.
        await second.goto(new URL('/secondary?space=second', h.origin()).href, { waitUntil: 'load' });
        await expect(clickRef(second, secondRef)).rejects.toBeInstanceOf(StaleRefError);
        await clickRef(first, firstRef);
        expect(await clicks(first)).toBe(2);

        expect(first.url()).toContain('space=first');
        expect(second.url()).toContain('space=second');
      } finally {
        await first.close();
        await second.close();
      }
    });

    it('a ref one page printed resolves nothing on a page that never printed it', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const first = await openPage(h, '/no-frame?space=first');
      const second = await openPage(h, '/no-frame?space=second');
      try {
        const ref = refFor(await generateSnapshot(first), 'Increment counter');
        expect(listRefEntries(second)).toHaveLength(0);
        expect(await resolveRef(second, ref)).toBeNull();
        expect(await clicks(second)).toBe(0);
      } finally {
        await first.close();
        await second.close();
      }
    });
  });
}
