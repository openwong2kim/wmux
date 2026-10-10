// Adapted from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (package/ego-browser/scripts/real-browser-e2e/cases/page-actionability.mjs), MIT License, Copyright (c) 2026 CitroLabs, modified
//
// Which controls a click, fill, hover, drag or select may act on, against real
// Chrome, driven through the same calls the browser tools make on a live page:
// clickWithApproach for browser_click, a handle fill for browser_fill, a
// handle hover for browser_hover, mouseDragThrough for browser_drag and a
// handle selectOption for browser_select.
//
// Not ported: the `force` click scenarios, since no wmux browser tool exposes
// a force option; and the enabled-duplicate selector scenarios, since a wmux
// ref names one element and never has duplicates to choose between.
import type { ElementHandle, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { MODES, harnessFor } from '../../../../test-utils/realBrowserHarness';
import { generateSnapshot, resolveRef } from '../../snapshot';
import { clickWithApproach, mouseDragThrough } from '../../tools/interaction';
import { CASE_TIMEOUT_MS, expectKnownGap, openPage, serveCorpus } from './_support';

/**
 * How Playwright's selectOption refuses an option that is not enabled: it
 * waits for the option, then times out.
 */
const SELECT_OPTION_WAIT = /^TimeoutError: elementHandle\.selectOption: Timeout \d+ms exceeded/;

/**
 * Playwright's actionability reasons, as they appear in the call log of the
 * timeout it raises. A zero-size box is reported as not visible.
 */
const NOT_VISIBLE = /element is not visible/;
const NOT_ENABLED = /element is not enabled/;

/** Bound on a click that is expected to be refused. */
const REFUSAL_TIMEOUT_MS = 300;

const FIXTURE_HTML =
  '<style>.action-row { display: flex; gap: 12px; margin: 12px; min-height: 40px; }' +
  '.drag-box { width: 80px; height: 40px; background: #ddd; }</style>' +
  '<button id="hidden-action" hidden>Hidden action</button>' +
  '<button id="zero-size-action" style="width:0;height:0;padding:0;border:0">Zero-size action</button>' +
  '<div class="action-row">' +
  '<button id="nested-disabled" disabled><span>Nested disabled action</span></button>' +
  '<button id="native-disabled" disabled aria-disabled="false">Native disabled</button>' +
  '</div>' +
  '<div id="aria-container" aria-disabled="true" class="action-row">' +
  '<button id="aria-blocked">ARIA blocked</button>' +
  '<button id="aria-override" aria-disabled="false">ARIA override</button>' +
  '<input id="aria-fill-blocked">' +
  '</div>' +
  '<div class="action-row">' +
  '<button id="aria-owner" aria-disabled="true"><span aria-disabled="false">ARIA owner action</span></button>' +
  '<div id="unsupported-aria" aria-disabled="true">Unsupported ARIA action</div>' +
  '</div>' +
  '<fieldset id="disabled-fieldset" disabled>' +
  '<legend><button id="legend-action">Legend action</button></legend>' +
  '<input id="fieldset-input">' +
  '</fieldset>' +
  '<div class="action-row">' +
  '<button id="disabled-hover" disabled>Hover disabled</button>' +
  '<div id="disabled-drag-source" class="drag-box" role="button" aria-disabled="true">Drag source</div>' +
  '<div id="disabled-drag-target" class="drag-box" role="button" aria-disabled="true">Drag target</div>' +
  '</div>' +
  '<div class="action-row">' +
  '<select id="disabled-select" disabled><option value="value">Value</option></select>' +
  '<select id="option-states">' +
  '<option value="normal">Normal</option>' +
  '<option value="disabled" disabled>Disabled option</option>' +
  '<option value="aria-disabled" aria-disabled="true">ARIA disabled option</option>' +
  '<optgroup label="Disabled group" disabled><option value="grouped">Grouped option</option></optgroup>' +
  '</select>' +
  '</div>';

type State = Record<string, number | boolean>;

async function setUpFixture(page: Page): Promise<void> {
  await page.evaluate((html) => {
    document.body.innerHTML = html;
    const state: Record<string, number | boolean> = {
      nestedClicks: 0,
      nativeClicks: 0,
      ariaBlockedClicks: 0,
      ariaOverrideClicks: 0,
      ariaOwnerClicks: 0,
      unsupportedAriaClicks: 0,
      fieldsetInputBeforeEnabled: 0,
      ariaInputBeforeEnabled: 0,
      hoverEvents: 0,
      hoverTrusted: false,
      dragDown: 0,
      dragUp: 0,
      dragTrusted: false,
      fieldsetEnabled: false,
      ariaEnabled: false,
      shadowBlockedClicks: 0,
      shadowOverrideClicks: 0,
    };
    (window as unknown as { __actionability: typeof state }).__actionability = state;
    const on = (selector: string, type: string, fn: (event: Event) => void, root: ParentNode = document) =>
      root.querySelector(selector)!.addEventListener(type, fn);
    const count = (key: string) => () => {
      (state[key] as number)++;
    };
    on('#nested-disabled', 'click', count('nestedClicks'));
    on('#native-disabled', 'click', count('nativeClicks'));
    on('#aria-blocked', 'click', count('ariaBlockedClicks'));
    on('#aria-override', 'click', count('ariaOverrideClicks'));
    on('#aria-owner', 'click', count('ariaOwnerClicks'));
    on('#unsupported-aria', 'click', count('unsupportedAriaClicks'));
    on('#fieldset-input', 'input', () => {
      if (!state.fieldsetEnabled) (state.fieldsetInputBeforeEnabled as number)++;
    });
    on('#aria-fill-blocked', 'input', () => {
      if (!state.ariaEnabled) (state.ariaInputBeforeEnabled as number)++;
    });
    on('#disabled-hover', 'mouseover', (event) => {
      (state.hoverEvents as number)++;
      state.hoverTrusted ||= event.isTrusted;
    });
    on('#disabled-drag-source', 'mousedown', (event) => {
      (state.dragDown as number)++;
      state.dragTrusted ||= event.isTrusted;
    });
    on('#disabled-drag-target', 'mouseup', (event) => {
      (state.dragUp as number)++;
      state.dragTrusted ||= event.isTrusted;
    });

    const shadowHost = document.createElement('div');
    shadowHost.id = 'shadow-action-host';
    shadowHost.setAttribute('aria-disabled', 'true');
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<div class="action-row"><button id="shadow-blocked">Shadow blocked</button>' +
      '<button id="shadow-override" aria-disabled="false">Shadow override</button>' +
      '<input id="shadow-fill-blocked"></div>';
    document.body.append(shadowHost);
    on('#shadow-blocked', 'click', count('shadowBlockedClicks'), shadow);
    on('#shadow-override', 'click', count('shadowOverrideClicks'), shadow);
  }, FIXTURE_HTML);
}

const state = (page: Page) =>
  page.evaluate(() => (window as unknown as { __actionability: State }).__actionability);

async function handle(page: Page, selector: string): Promise<ElementHandle> {
  const el = await page.$(selector);
  if (!el) throw new Error(`fixture has no ${selector}`);
  return el;
}

/** browser_click on a live page, with Playwright's waits capped for a refusal. */
async function click(page: Page, el: ElementHandle, timeout = REFUSAL_TIMEOUT_MS): Promise<void> {
  page.setDefaultTimeout(timeout);
  try {
    await clickWithApproach(page, el, false);
  } finally {
    page.setDefaultTimeout(1_500);
  }
}

for (const mode of MODES) {
  const h = harnessFor(mode, { suiteName: 'egoCorpus/page-actionability', serve: serveCorpus });

  describe(`page-actionability (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('refuses hidden, zero-size and disabled targets, by handle and by ref', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/no-frame');
      try {
        await setUpFixture(page);
        await expect(click(page, await handle(page, '#hidden-action'))).rejects.toThrow(NOT_VISIBLE);
        await expect(click(page, await handle(page, '#zero-size-action'))).rejects.toThrow(NOT_VISIBLE);
        await expect(click(page, await handle(page, '#nested-disabled span'))).rejects.toThrow(NOT_ENABLED);
        expect((await state(page)).nestedClicks).toBe(0);

        // The ref lane runs the same final check.
        const snapshot = await generateSnapshot(page);
        const line = snapshot.split('\n').find((l) => l.includes('Nested disabled action'));
        const ref = line?.match(/ref="([^"]+)"/)?.[1];
        expect(ref, snapshot).toBeTruthy();
        const el = await resolveRef(page, ref!);
        await expect(click(page, el!)).rejects.toThrow(NOT_ENABLED);
        expect((await state(page)).nestedClicks).toBe(0);

        // A click waits for a control that becomes enabled within its bound.
        await page.evaluate(() => {
          setTimeout(() => {
            (document.querySelector('#nested-disabled') as HTMLButtonElement).disabled = false;
          }, 100);
        });
        await click(page, await handle(page, '#nested-disabled span'), 1_000);
        expect((await state(page)).nestedClicks).toBe(1);

        // aria-disabled="false" does not undo the native disabled state.
        await expect(click(page, await handle(page, '#native-disabled'))).rejects.toThrow(NOT_ENABLED);
        expect((await state(page)).nativeClicks).toBe(0);
      } finally {
        await page.close();
      }
    });

    it('follows aria-disabled through ancestors and shadow hosts', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/no-frame');
      try {
        await setUpFixture(page);
        await expect(click(page, await handle(page, '#aria-blocked'))).rejects.toThrow(NOT_ENABLED);
        await click(page, await handle(page, '#aria-override'), 1_000);
        await expect(click(page, await handle(page, '#aria-owner span'))).rejects.toThrow(NOT_ENABLED);
        // aria-disabled means nothing on an element without a role that supports it.
        await click(page, await handle(page, '#unsupported-aria'), 1_000);
        await expect(click(page, await handle(page, '#shadow-blocked'))).rejects.toThrow(NOT_ENABLED);
        await click(page, await handle(page, '#shadow-override'), 1_000);
        expect(await state(page)).toMatchObject({
          ariaBlockedClicks: 0,
          ariaOverrideClicks: 1,
          ariaOwnerClicks: 0,
          unsupportedAriaClicks: 1,
          shadowBlockedClicks: 0,
          shadowOverrideClicks: 1,
        });

        const shadowFill = await handle(page, '#shadow-fill-blocked');
        await expect(shadowFill.fill('must not appear', { timeout: REFUSAL_TIMEOUT_MS })).rejects.toThrow(NOT_ENABLED);
        expect(await shadowFill.inputValue()).toBe('');
      } finally {
        await page.close();
      }
    });

    it('a fill waits for a disabled fieldset or aria state to clear and types nothing before', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/no-frame');
      try {
        await setUpFixture(page);
        // The first legend of a disabled fieldset stays usable.
        await click(page, await handle(page, '#legend-action'), 1_000);

        const fieldsetInput = await handle(page, '#fieldset-input');
        await expect(fieldsetInput.fill('early', { timeout: REFUSAL_TIMEOUT_MS })).rejects.toThrow(NOT_ENABLED);
        expect(await fieldsetInput.inputValue()).toBe('');
        await page.evaluate(() => {
          setTimeout(() => {
            (window as unknown as { __actionability: State }).__actionability.fieldsetEnabled = true;
            (document.querySelector('#disabled-fieldset') as HTMLFieldSetElement).disabled = false;
          }, 100);
        });
        await fieldsetInput.fill('ready', { timeout: 1_000 });
        expect(await fieldsetInput.inputValue()).toBe('ready');

        const ariaInput = await handle(page, '#aria-fill-blocked');
        await expect(ariaInput.fill('early', { timeout: REFUSAL_TIMEOUT_MS })).rejects.toThrow(NOT_ENABLED);
        expect(await ariaInput.inputValue()).toBe('');
        await page.evaluate(() => {
          setTimeout(() => {
            (window as unknown as { __actionability: State }).__actionability.ariaEnabled = true;
            document.querySelector('#aria-fill-blocked')!.setAttribute('aria-disabled', 'false');
          }, 100);
        });
        await ariaInput.fill('ready', { timeout: 1_000 });
        expect(await state(page)).toMatchObject({ fieldsetInputBeforeEnabled: 0, ariaInputBeforeEnabled: 0 });
      } finally {
        await page.close();
      }
    });

    it('hover and drag reach disabled elements with trusted input; select honours the select only', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/no-frame');
      try {
        await setUpFixture(page);
        await (await handle(page, '#disabled-hover')).hover();
        const hovered = await state(page);
        expect(hovered.hoverEvents).toBeGreaterThan(0);
        expect(hovered.hoverTrusted).toBe(true);

        const centre = async (selector: string) => {
          const box = (await (await handle(page, selector)).boundingBox())!;
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        };
        await mouseDragThrough(page, [await centre('#disabled-drag-source'), await centre('#disabled-drag-target')]);
        const dragged = await state(page);
        expect(dragged.dragDown).toBeGreaterThan(0);
        expect(dragged.dragUp).toBeGreaterThan(0);
        expect(dragged.dragTrusted).toBe(true);

        await expect(
          (await handle(page, '#disabled-select')).selectOption('value', { timeout: REFUSAL_TIMEOUT_MS }),
        ).rejects.toThrow(NOT_ENABLED);
        const options = await handle(page, '#option-states');
        // A programmatic pick may choose a disabled option, and option ARIA
        // state does not disable an enabled select; the live-page lane of
        // browser_select hands the value to Playwright's selectOption, which
        // waits for the option itself to be enabled, ARIA state included.
        await expectKnownGap('browser_select cannot pick an aria-disabled option', SELECT_OPTION_WAIT, () =>
          options.selectOption('aria-disabled', { timeout: REFUSAL_TIMEOUT_MS }),
        );
        expect(await options.inputValue()).toBe('normal');
        await expectKnownGap('browser_select cannot pick a disabled option', SELECT_OPTION_WAIT, () =>
          options.selectOption('disabled', { timeout: REFUSAL_TIMEOUT_MS }),
        );
        expect(await options.inputValue()).toBe('normal');
        await expectKnownGap('browser_select cannot pick an option inside a disabled optgroup', SELECT_OPTION_WAIT, () =>
          options.selectOption('grouped', { timeout: REFUSAL_TIMEOUT_MS }),
        );
        expect(await options.inputValue()).toBe('normal');
      } finally {
        await page.close();
      }
    });
  });
}
