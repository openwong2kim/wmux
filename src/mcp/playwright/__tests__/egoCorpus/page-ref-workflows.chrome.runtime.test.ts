// Adapted from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (package/ego-browser/scripts/real-browser-e2e/cases/page-ref-workflows.mjs), MIT License, Copyright (c) 2026 CitroLabs, modified
//
// Multi-step workflows that act on several refs from ONE snapshot, against
// real Chrome: a dialog form, a failed lookup that must not disturb published
// refs, and a native file chooser opened through a ref.
//
// Not ported: the ambiguous-locator and missing-locator errors of the failed
// action workflow. wmux refs are never ambiguous by construction, so the
// equivalent failure is a ref that resolves to nothing, which is what runs.
import { rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { MODES, harnessFor } from '../../../../test-utils/realBrowserHarness';
import { generateScopedSnapshot, generateSnapshot, resolveRef } from '../../snapshot';
import { CASE_TIMEOUT_MS, clickRef, fillRef, openPage, refFor, serveCorpus } from './_support';

for (const mode of MODES) {
  const h = harnessFor(mode, { suiteName: 'egoCorpus/page-ref-workflows', serve: serveCorpus });

  describe(`page-ref-workflows (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('fills and saves a dialog form with refs from one snapshot', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/nav-target');
      try {
        await page.evaluate(() => {
          document.body.innerHTML =
            '<section role="dialog" tabindex="0" aria-label="Edit saved link">' +
            '<button id="category" aria-label="Choose category">Choose category</button>' +
            '<output id="category-result"></output>' +
            '<input id="name" aria-label="Link name"><input id="url" aria-label="Link URL">' +
            '<button id="save" aria-label="Save link">Save link</button></section>' +
            '<output id="result"></output>';
          const q = (s: string) => document.querySelector(s) as HTMLElement;
          q('#category').onclick = () => {
            q('#category').setAttribute('aria-pressed', 'true');
            q('#category-result').textContent = 'Category selected';
          };
          q('#save').onclick = () => {
            q('#result').textContent = JSON.stringify({
              name: (q('#name') as HTMLInputElement).value,
              url: (q('#url') as HTMLInputElement).value,
            });
            q('[role="dialog"]').remove();
          };
        });
        const snapshot = await generateSnapshot(page);
        const categoryRef = refFor(snapshot, 'Choose category');
        const nameRef = refFor(snapshot, 'Link name');
        const urlRef = refFor(snapshot, 'Link URL');
        const saveRef = refFor(snapshot, 'Save link');

        // A click inside the dialog leaves the dialog root in place.
        await clickRef(page, categoryRef);
        expect(await generateScopedSnapshot(page, '[role="dialog"]')).toContain('Category selected');

        const target = new URL('/nav-target', h.origin()).href;
        await fillRef(page, nameRef, 'agent-favorites');
        await fillRef(page, urlRef, target);
        await clickRef(page, saveRef);
        const result = await page.evaluate(() => ({
          saved: JSON.parse(document.querySelector('#result')!.textContent || '{}'),
          dialogOpen: Boolean(document.querySelector('[role="dialog"]')),
        }));
        expect(result.saved).toEqual({ name: 'agent-favorites', url: target });
        expect(result.dialogOpen).toBe(false);
      } finally {
        await page.close();
      }
    });

    it('a ref that fails to resolve leaves the published refs usable', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/nav-target');
      try {
        await page.evaluate(() => {
          document.body.innerHTML =
            '<button>Duplicate action</button><button>Duplicate action</button>' +
            '<input aria-label="Bookmark search"><button id="menu" aria-label="Result menu">Result menu</button>' +
            '<output id="query"></output><output id="hover"></output>';
          const w = window as unknown as { __duplicateClicks: number };
          w.__duplicateClicks = 0;
          for (const button of document.querySelectorAll('button:not(#menu)')) {
            (button as HTMLElement).onclick = () => w.__duplicateClicks++;
          }
          document.querySelector('input')!.oninput = (event) => {
            document.querySelector('#query')!.textContent = (event.target as HTMLInputElement).value;
          };
          (document.querySelector('#menu') as HTMLElement).onmouseenter = () => {
            document.querySelector('#hover')!.textContent = 'Menu ready';
          };
        });
        const snapshot = await generateSnapshot(page);
        const searchRef = refFor(snapshot, 'Bookmark search');
        const menuRef = refFor(snapshot, 'Result menu');

        // A ref no snapshot ever printed.
        expect(await resolveRef(page, '9999')).toBeNull();

        // No snapshot in between: the next actions use the refs published above.
        await (await resolveRef(page, searchRef))!.focus();
        await page.keyboard.type('agent-video-research-picks');
        await (await resolveRef(page, menuRef))!.hover();
        const result = await page.evaluate(() => ({
          query: document.querySelector('#query')!.textContent,
          hover: document.querySelector('#hover')!.textContent,
          duplicateClicks: (window as unknown as { __duplicateClicks: number }).__duplicateClicks,
        }));
        expect(result).toEqual({ query: 'agent-video-research-picks', hover: 'Menu ready', duplicateClicks: 0 });
      } finally {
        await page.close();
      }
    });

    it('a ref published before a native file chooser still works after the upload', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const uploadPath = join(tmpdir(), `egoCorpus-upload-${process.pid}.txt`);
      let page: Page | null = null;
      try {
        writeFileSync(uploadPath, 'fixture upload\n');
        page = await openPage(h, '/nav-target');
        await page.evaluate(() => {
          document.body.innerHTML =
            '<input aria-label="Cell address"><output id="address"></output>' +
            '<section id="upload-dialog" role="dialog" aria-label="Upload file">' +
            '<input id="file" type="file" hidden><button id="browse" aria-label="Browse file">Browse file</button>' +
            '</section><output id="uploaded"></output>';
          const q = (s: string) => document.querySelector(s) as HTMLInputElement;
          q('[aria-label="Cell address"]').onkeydown = (event) => {
            if (event.key === 'Enter') q('#address').textContent = (event.target as HTMLInputElement).value;
          };
          q('#browse').onclick = () => q('#file').click();
          q('#file').onchange = (event) => {
            q('#uploaded').textContent = (event.target as HTMLInputElement).files![0].name;
            q('#upload-dialog').remove();
          };
        });
        const snapshot = await generateSnapshot(page);
        const addressRef = refFor(snapshot, 'Cell address');
        const browseRef = refFor(snapshot, 'Browse file');

        const chooser = page.waitForEvent('filechooser', { timeout: 5_000 });
        await clickRef(page, browseRef);
        await (await chooser).setFiles(uploadPath);
        await page.waitForSelector('#upload-dialog', { state: 'detached', timeout: 5_000 });

        await fillRef(page, addressRef, 'M2');
        await (await resolveRef(page, addressRef))!.press('Enter');
        const result = await page.evaluate(() => ({
          address: document.querySelector('#address')!.textContent,
          uploaded: document.querySelector('#uploaded')!.textContent,
          dialogOpen: Boolean(document.querySelector('#upload-dialog')),
        }));
        expect(result).toEqual({ address: 'M2', uploaded: basename(uploadPath), dialogOpen: false });
      } finally {
        await page?.close();
        rmSync(uploadPath, { force: true });
      }
    });
  });
}
