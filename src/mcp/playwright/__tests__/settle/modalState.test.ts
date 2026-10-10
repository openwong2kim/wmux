import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import {
  ARMED_DIALOG_TTL_MS,
  armDialogAnswer,
  attachModalTracking,
  beginDispatch,
  drainDialogNotes,
  modalScopeKey,
  renderModalBlock,
} from '../../modalState';
import { settleAfterAction } from '../../actionSettle';
import { effectTagOf } from '../../resultTrailer';
import { fakeDialog, makeFakePage } from './fakePage';

let n = 0;
/** A tracked page on its own surface. */
function trackedPage() {
  const fake = makeFakePage();
  const surface = `s${++n}`;
  const page = fake.page as unknown as Page;
  const key = modalScopeKey('w', surface);
  attachModalTracking(page, key);
  return { fake, page, surface, key };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('dialogs keep today’s handling and are reported', () => {
  it('a confirm is dismissed at once and noted for the surface', () => {
    const { fake, surface } = trackedPage();
    const dialog = fakeDialog('confirm', 'Delete it?');
    fake.page.emit('dialog', dialog);

    expect(dialog.dismiss).toHaveBeenCalled();
    expect(dialog.accept).not.toHaveBeenCalled();
    const notes = drainDialogNotes('w', surface);
    expect(notes).toMatchObject([{ type: 'confirm', message: 'Delete it?', answer: 'dismissed' }]);
    const block = renderModalBlock(notes);
    expect(block).toMatch(/^\[modal\]\n- a confirm appeared and was dismissed/);
    expect(block).toContain('page text: "Delete it?"');
    expect(block).toContain('browser_dialog({accept:true}) before the action');
    // Drained: the next result does not repeat it.
    expect(drainDialogNotes('w', surface)).toEqual([]);
  });

  it('beforeunload is accepted and not noted', () => {
    const { fake, surface } = trackedPage();
    const dialog = fakeDialog('beforeunload', '');
    fake.page.emit('dialog', dialog);
    expect(dialog.accept).toHaveBeenCalled();
    expect(drainDialogNotes('w', surface)).toEqual([]);
  });

  it('page text is capped', () => {
    const { fake, surface } = trackedPage();
    fake.page.emit('dialog', fakeDialog('alert', 'x'.repeat(5000)));
    const [note] = drainDialogNotes('w', surface);
    expect(note.message.length).toBeLessThanOrEqual(201);
  });

  it('a closed context drops the scope index', () => {
    const { fake, surface } = trackedPage();
    fake.page.emit('dialog', fakeDialog('alert'));
    fake.page.closeContext();
    expect(drainDialogNotes('w', surface)).toEqual([]);
  });
});

describe('browser_dialog pre-arm', () => {
  it('applies to a dialog raised during the agent’s own dispatch, once', async () => {
    const { fake, page, key, surface } = trackedPage();
    armDialogAnswer(page, key, 'agent', true, 'yes');

    const first = fakeDialog('prompt', 'Name?');
    const end = beginDispatch(page);
    fake.page.emit('dialog', first);
    end();
    expect(first.accept).toHaveBeenCalledWith('yes');

    const second = fakeDialog('prompt', 'Again?');
    const end2 = beginDispatch(page);
    fake.page.emit('dialog', second);
    end2();
    expect(second.dismiss).toHaveBeenCalled();
    expect(drainDialogNotes('w', surface).map((x) => x.answer)).toEqual([
      'accepted (pre-armed)',
      'dismissed',
    ]);
  });

  it('a dispatch through settleAfterAction counts as the agent’s action', async () => {
    const { fake, page, key } = trackedPage();
    armDialogAnswer(page, key, 'agent', true);
    const dialog = fakeDialog('confirm');
    vi.useFakeTimers();
    const run = settleAfterAction(page, async () => {
      fake.page.emit('dialog', dialog);
    });
    await vi.advanceTimersByTimeAsync(100);
    await run;
    expect(dialog.accept).toHaveBeenCalled();
  });

  it('a dialog with no dispatch in flight does not spend it (no time-proximity rule)', () => {
    const { fake, page, key } = trackedPage();
    armDialogAnswer(page, key, 'agent', true);
    const spontaneous = fakeDialog('confirm');
    fake.page.emit('dialog', spontaneous);
    expect(spontaneous.dismiss).toHaveBeenCalled();

    const later = fakeDialog('confirm');
    const end = beginDispatch(page);
    fake.page.emit('dialog', later);
    end();
    expect(later.accept).toHaveBeenCalled();
  });

  it('beforeunload never consumes it', () => {
    const { fake, page, key } = trackedPage();
    armDialogAnswer(page, key, 'agent', false);
    const end = beginDispatch(page);
    const leave = fakeDialog('beforeunload', '');
    fake.page.emit('dialog', leave);
    expect(leave.accept).toHaveBeenCalled();
    const confirm = fakeDialog('confirm');
    fake.page.emit('dialog', confirm);
    end();
    expect(confirm.dismiss).toHaveBeenCalled();
  });

  it('lapses after its TTL', () => {
    vi.useFakeTimers();
    const { fake, page, key } = trackedPage();
    armDialogAnswer(page, key, 'agent', true);
    vi.advanceTimersByTime(ARMED_DIALOG_TTL_MS + 1);
    const end = beginDispatch(page);
    const late = fakeDialog('confirm');
    fake.page.emit('dialog', late);
    end();
    expect(late.accept).not.toHaveBeenCalled();
    expect(late.dismiss).toHaveBeenCalled();
  });

  it.each(['user', 'borrowed', 'unknown'] as const)('is refused on a %s tab', (owner) => {
    const fake = makeFakePage();
    const page = fake.page as unknown as Page;
    let error: unknown;
    try {
      armDialogAnswer(page, modalScopeKey('w', `x${++n}`), owner, true);
    } catch (e) {
      error = e;
    }
    expect(effectTagOf(error)).toEqual({ code: 'scope_refused', effect: 'none' });
    // Nothing attached: that tab keeps Playwright's own handling.
    expect(fake.page.listenerCount('dialog')).toBe(0);
  });
});
