// Adapted from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (package/ego-browser/scripts/real-browser-e2e/cases/event-isolation.mjs), MIT License, Copyright (c) 2026 CitroLabs, modified
//
// Network traffic on one page must not keep another page busy, against real
// Chrome. browser_wait's `networkidle` lane on a live page waits with
// page.waitForLoadState('networkidle') on the surface's own page
// (tools/wait.ts); this pins that the wait is per page: a neighbour firing a
// slow request every 50 ms does not stop a static page from reaching idle.
import { describe, expect, it } from 'vitest';
import { MODES, harnessFor } from '../../../../test-utils/realBrowserHarness';
import { CASE_TIMEOUT_MS, openPage, serveCorpus } from './_support';

for (const mode of MODES) {
  const h = harnessFor(mode, { suiteName: 'egoCorpus/event-isolation', serve: serveCorpus });

  describe(`event-isolation (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it("a neighbour page's background requests do not hold off a static page's network idle", async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const pulse = await openPage(h, '/no-frame?event-isolation=pulse');
      try {
        await pulse.evaluate(() => {
          (window as unknown as { __pulse: ReturnType<typeof setInterval> }).__pulse = setInterval(
            () => fetch('/api/slow?ms=2000&pulse=' + Date.now()).catch(() => undefined),
            50,
          );
        });
        await pulse.waitForTimeout(400);

        const staticPage = await openPage(h, `/no-frame?event-isolation=${Date.now()}`);
        try {
          // The pulse never goes quiet, so a wait that counted its requests
          // could not finish at all; the bound only has to leave room for the
          // 500 ms quiet window on a loaded runner.
          await expect(staticPage.waitForLoadState('networkidle', { timeout: 5_000 })).resolves.toBeUndefined();
        } finally {
          await staticPage.close();
        }
      } finally {
        await pulse.evaluate(() => clearInterval((window as unknown as { __pulse: ReturnType<typeof setInterval> }).__pulse)).catch(() => undefined);
        await pulse.close();
      }
    });
  });
}
