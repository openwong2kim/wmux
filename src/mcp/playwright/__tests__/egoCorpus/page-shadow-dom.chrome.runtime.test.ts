// Adapted from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (package/ego-browser/scripts/real-browser-e2e/cases/page-shadow-dom.mjs), MIT License, Copyright (c) 2026 CitroLabs, modified
//
// Open shadow roots, against real Chrome: controls inside one, and inside one
// nested in another, are listed by the snapshot and reachable through its refs.
import { describe, expect, it } from 'vitest';
import { MODES, harnessFor } from '../../../../test-utils/realBrowserHarness';
import { generateSnapshot } from '../../snapshot';
import { CASE_TIMEOUT_MS, clickRef, fillRef, openPage, refFor, serveCorpus } from './_support';

for (const mode of MODES) {
  const h = harnessFor(mode, { suiteName: 'egoCorpus/page-shadow-dom', serve: serveCorpus });

  describe(`page-shadow-dom (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('fills a field in an open shadow root and clicks a button in a nested one', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/no-frame');
      try {
        const snapshot = await generateSnapshot(page);
        expect(snapshot).toContain('Shadow field');

        await fillRef(page, refFor(snapshot, 'Shadow field'), 'shadow value');
        expect(
          await page.evaluate(
            () =>
              (document
                .querySelector('#shadow-fixture')!
                .shadowRoot!.querySelector('input[aria-label="Shadow field"]') as HTMLInputElement).value,
          ),
        ).toBe('shadow value');

        await clickRef(page, refFor(snapshot, 'Shadow action'));
        expect(
          await page.evaluate(
            () =>
              (document
                .querySelector('#shadow-fixture')!
                .shadowRoot!.querySelector('nested-shadow-fixture')!
                .shadowRoot!.querySelector('#shadow-action') as HTMLElement).dataset.clicked,
          ),
        ).toBe('true');
      } finally {
        await page.close();
      }
    });
  });
}
