// Adapted from citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e (package/ego-browser/scripts/real-browser-e2e/cases/page-dialogs.mjs), MIT License, Copyright (c) 2026 CitroLabs, modified
//
// JavaScript dialogs opened by a click, against real Chrome. The click goes
// through browser_click's ref lane (resolveRef + clickWithApproach) and the
// dialog is answered by a page-level `dialog` handler, the mechanism every
// wmux dialog answer is built on. A click that opens a dialog must return,
// and the page must resume with the answer it was given.
//
// Not ported: the per-action receipts and the CDP event log. wmux reports a
// click without a dialog receipt, so the scenario asserts what the handler
// saw (type, message, default) and what the page did with the answer.
// Answering through the registered browser_dialog tool is left to the tests
// of that tool, which is being reworked separately.
import { rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Dialog, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { MODES, harnessFor } from '../../../../test-utils/realBrowserHarness';
import { generateSnapshot } from '../../snapshot';
import { CASE_TIMEOUT_MS, clickRef, openPage, refFor, serveCorpus } from './_support';

async function setUpFixture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const result = document.createElement('output');
    result.id = 'dialog-result';
    result.textContent = 'idle';
    const button = (id: string, label: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.id = id;
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    };
    document.body.prepend(
      button('no-dialog-action', 'Run without dialog', () => {
        result.dataset.noDialogClicks = String(Number(result.dataset.noDialogClicks || '0') + 1);
      }),
      button('dialog-prompt', 'Prompt', () => {
        const value = prompt('Name from real E2E', 'guest');
        result.textContent = 'prompt:' + String(value);
        result.dataset.prompt = String(value);
      }),
      button('dialog-confirm', 'Confirm', () => {
        result.dataset.confirm = String(confirm('Continue real E2E?'));
      }),
      button('dialog-alert', 'Alert', () => {
        alert('Alert from real E2E');
        result.dataset.alert = 'closed';
      }),
      button('dialog-upload', 'Upload project', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.addEventListener('change', () => {
          result.dataset.uploadAccepted = String(confirm('Replace the current project?'));
          result.dataset.uploadFile = input.files?.[0]?.name || '';
        });
        document.body.append(input);
        input.click();
      }),
      result,
    );
  });
}

const resultData = (page: Page) =>
  page.evaluate(() => ({ ...(document.querySelector('#dialog-result') as HTMLElement).dataset }));

/** How long a test waits for the dialog its click should have opened. */
const DIALOG_WAIT_MS = 5_000;

/**
 * Answers dialogs on one page, one `next()` at a time.
 *
 * Every wait is bounded, an answer that fails rejects the wait instead of
 * leaving it pending, and `dispose()` (run in each test's finally) removes
 * whatever listener and timer are still armed, so a failing test leaves
 * nothing attached to the page and no timer running.
 */
function dialogAnswers(page: Page) {
  const armed = new Set<{ listener: (d: Dialog) => void; timer: ReturnType<typeof setTimeout> }>();
  const disarm = (entry: { listener: (d: Dialog) => void; timer: ReturnType<typeof setTimeout> }) => {
    clearTimeout(entry.timer);
    page.off('dialog', entry.listener);
    armed.delete(entry);
  };
  return {
    /** Answer the next dialog with `answer`, and hand back what it was. */
    next(answer: (dialog: Dialog) => Promise<void>): Promise<Dialog> {
      const waiting = new Promise<Dialog>((resolve, reject) => {
        const entry = {
          listener: (dialog: Dialog) => {
            disarm(entry);
            answer(dialog).then(() => resolve(dialog), reject);
          },
          timer: setTimeout(() => {
            disarm(entry);
            reject(new Error(`no dialog opened within ${DIALOG_WAIT_MS} ms`));
          }, DIALOG_WAIT_MS),
        };
        armed.add(entry);
        page.on('dialog', entry.listener);
      });
      // A test that fails before it awaits this must not also raise an
      // unhandled rejection; awaiting it still sees the rejection.
      waiting.catch(() => undefined);
      return waiting;
    },
    dispose(): void {
      for (const entry of [...armed]) disarm(entry);
    },
  };
}

for (const mode of MODES) {
  const h = harnessFor(mode, { suiteName: 'egoCorpus/page-dialogs', serve: serveCorpus });

  describe(`page-dialogs (${mode.name})`, { timeout: CASE_TIMEOUT_MS }, () => {
    it('prompt, confirm and alert are answered and the page resumes with the answer', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const page = await openPage(h, '/no-frame');
      const dialogs = dialogAnswers(page);
      try {
        await setUpFixture(page);
        const snapshot = await generateSnapshot(page);

        await clickRef(page, refFor(snapshot, 'Run without dialog'));
        expect((await resultData(page)).noDialogClicks).toBe('1');

        const prompted = dialogs.next((d) => d.accept('agent'));
        await clickRef(page, refFor(snapshot, 'Prompt'));
        const prompt = await prompted;
        expect([prompt.type(), prompt.message(), prompt.defaultValue()]).toEqual([
          'prompt',
          'Name from real E2E',
          'guest',
        ]);
        await page.waitForFunction(() => (document.querySelector('#dialog-result') as HTMLElement).dataset.prompt === 'agent');
        expect(await page.evaluate(() => document.querySelector('#dialog-result')!.textContent)).toBe('prompt:agent');

        const confirmed = dialogs.next((d) => d.dismiss());
        await clickRef(page, refFor(snapshot, 'Confirm'));
        expect((await confirmed).type()).toBe('confirm');
        await page.waitForFunction(() => (document.querySelector('#dialog-result') as HTMLElement).dataset.confirm === 'false');

        const alerted = dialogs.next((d) => d.accept());
        await clickRef(page, refFor(snapshot, 'Alert'));
        const alert = await alerted;
        expect([alert.type(), alert.message()]).toEqual(['alert', 'Alert from real E2E']);
        await page.waitForFunction(() => (document.querySelector('#dialog-result') as HTMLElement).dataset.alert === 'closed');

        // The refs from before the dialogs still act.
        await clickRef(page, refFor(snapshot, 'Run without dialog'));
        expect((await resultData(page)).noDialogClicks).toBe('2');
      } finally {
        dialogs.dispose();
        await page.close();
      }
    });

    it('a confirm raised by an upload change handler is answered and keeps the file', async (ctx) => {
      if (h.skipUnless(ctx)) return;
      const uploadPath = join(tmpdir(), `fixture-upload-${process.pid}.txt`);
      let page: Page | null = null;
      let dialogs: ReturnType<typeof dialogAnswers> | null = null;
      try {
        writeFileSync(uploadPath, 'fixture upload\n');
        page = await openPage(h, '/no-frame');
        dialogs = dialogAnswers(page);
        await setUpFixture(page);
        const chooser = page.waitForEvent('filechooser', { timeout: 5_000 });
        await clickRef(page, refFor(await generateSnapshot(page), 'Upload project'));
        const confirmed = dialogs.next((d) => d.accept());
        await (await chooser).setFiles(uploadPath);
        const dialog = await confirmed;
        expect([dialog.type(), dialog.message()]).toEqual(['confirm', 'Replace the current project?']);
        await page.waitForFunction(
          () => (document.querySelector('#dialog-result') as HTMLElement).dataset.uploadAccepted === 'true',
        );
        expect((await resultData(page)).uploadFile).toBe(basename(uploadPath));
      } finally {
        dialogs?.dispose();
        await page?.close();
        rmSync(uploadPath, { force: true });
      }
    });
  });
}
