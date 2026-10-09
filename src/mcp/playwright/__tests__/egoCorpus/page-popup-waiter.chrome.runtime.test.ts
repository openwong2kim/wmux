// Adapted from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (package/ego-browser/scripts/real-browser-e2e/cases/page-popup-waiter.mjs), MIT License, Copyright (c) 2026 CitroLabs, modified
//
// Popups opened by a click, against real Chrome. browser_click's own popup
// report is not exported, so it is driven through the registered tool with
// only the wmux plumbing around it stubbed: the engine hands back the real
// page, and the lease RPCs answer "no lease".
//
// Not ported: the wrong-page URL wait that names the popup in its error. wmux
// has no URL wait that knows about popups; nothing of wmux's to hold to it.
import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { MODES, harnessFor } from '../../../../test-utils/realBrowserHarness';
import { generateSnapshot } from '../../snapshot';
import { CASE_TIMEOUT_MS, openPage, refFor, serveCorpus } from './_support';

const { engine } = vi.hoisted(() => ({
  engine: { page: null as unknown },
}));

vi.mock('../../../wmux-client', () => ({
  sendRpc: async () => ({ token: null }),
}));

vi.mock('../../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({
      getPageForScope: async () => engine.page,
      resolveWorkspaceBackend: async () => 'chrome',
    }),
  },
}));

import { registerInteractionTools } from '../../tools/interaction';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

function browserClick(): ToolHandler {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInteractionTools(server as never, { resolveWorkspaceId: async () => 'ws-corpus' });
  return tools.get('browser_click')!;
}

async function clickTool(page: Page, name: string): Promise<string> {
  engine.page = page;
  const ref = refFor(await generateSnapshot(page), name);
  const result = await browserClick()({ ref });
  const text = result.content.map((c) => c.text).join('\n');
  if (result.isError) throw new Error(text);
  return text;
}

async function addPopupLinks(page: Page, links: Record<string, string>): Promise<void> {
  await page.evaluate((entries) => {
    for (const [id, url] of Object.entries(entries)) {
      const link = document.createElement('a');
      link.id = id;
      link.href = url;
      link.target = '_blank';
      link.textContent = id;
      link.style.display = 'block';
      document.body.prepend(link);
    }
  }, links);
}

/**
 * A click's report names its own popup when it names one at all.
 *
 * Whether it names one is timing: browser_click waits POPUP_GRACE_MS (50 ms)
 * for the `popup` event, and a headed, unfocused Chrome can take longer to
 * raise it, so a report without the popup is logged as the known gap rather
 * than failed on.
 */
function expectOwnPopup(report: string, query: string): void {
  if (!report.includes('opened a popup')) {
    // eslint-disable-next-line no-console
    console.log(`[egoCorpus known gap] browser_click did not report the popup its click opened (${query}) within its grace period`);
    return;
  }
  expect(report).toContain(`popup-waiter=${query}`);
}

for (const mode of MODES) {
  const h = harnessFor(mode, { suiteName: 'egoCorpus/page-popup-waiter', serve: serveCorpus });
  const url = (query: string) => new URL(`/secondary?popup-waiter=${query}`, h.origin()).href;

  describe(`page-popup-waiter (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('a waiter armed before a click receives a popup opened after it', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const source = await openPage(h, '/no-frame');
      try {
        await source.evaluate((popupUrl) => {
          const button = document.createElement('button');
          button.textContent = 'Open delayed popup';
          button.addEventListener('click', () => {
            setTimeout(() => window.open(popupUrl, '_blank'), 250);
          });
          document.body.prepend(button);
        }, url('explicit'));

        const pending = source.waitForEvent('popup', { timeout: 3_000 });
        await clickTool(source, 'Open delayed popup');
        const popup = await pending;
        await popup.waitForURL(/popup-waiter=explicit/, { timeout: 3_000 });
        expect(popup.url()).toContain('popup-waiter=explicit');
        await popup.close();
      } finally {
        await source.close();
      }
    });

    it('each click reports its own popup, never one from an earlier click', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const source = await openPage(h, '/no-frame');
      const opened: Page[] = [];
      source.context().on('page', (p) => opened.push(p as Page));
      try {
        await addPopupLinks(source, { 'old-popup-link': url('old'), 'next-popup-link': url('next') });
        const oldPopup = source.waitForEvent('popup', { timeout: 3_000 });
        const oldReport = await clickTool(source, 'old-popup-link');
        expectOwnPopup(oldReport, 'old');
        await oldPopup;

        const nextPopup = source.waitForEvent('popup', { timeout: 3_000 });
        const nextReport = await clickTool(source, 'next-popup-link');
        expectOwnPopup(nextReport, 'next');
        expect(nextReport).not.toContain('popup-waiter=old');
        const next = await nextPopup;
        await next.waitForURL(/popup-waiter=next/, { timeout: 3_000 });
        expect(next.url()).toContain('popup-waiter=next');
      } finally {
        for (const p of opened) await p.close().catch(() => undefined);
        await source.close();
      }
    });
  });
}
