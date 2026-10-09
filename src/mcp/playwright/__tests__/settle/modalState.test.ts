import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import {
  ARMED_DIALOG_TTL_MS,
  CAUSE_GRACE_MS,
  answerModal,
  assertNoPendingModal,
  attachModalTracking,
  beginAgentWindow,
  pendingModal,
  pendingModalForScope,
  renderModalBlock,
  takeFileChooser,
} from '../../modalState';
import { effectTagOf } from '../../resultTrailer';
import { fakeDialog, makeFakePage } from './fakePage';

let n = 0;
/** A tracked page on its own surface, with an agent call open on it. */
function trackedPage(opts: { fileChooser?: boolean; agentActive?: boolean } = {}) {
  const fake = makeFakePage();
  const surface = `s${++n}`;
  const page = fake.page as unknown as Page;
  attachModalTracking(page, { scopeKey: `ws:w:surf:${surface}`, fileChooser: opts.fileChooser ?? true });
  const end = opts.agentActive === false ? () => {} : beginAgentWindow('w', surface);
  return { fake, page, surface, end };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pending modal: block and answer', () => {
  it('an agent-caused alert is pending, shown in the [modal] block, and answerable', async () => {
    const { fake, page, surface, end } = trackedPage();
    const dialog = fakeDialog('confirm', 'Delete it?');
    fake.page.emit('dialog', dialog);
    end();

    expect(pendingModalForScope('w', surface)).toMatchObject({ type: 'confirm', causedByAgent: true });
    const block = renderModalBlock(pendingModal(page)!);
    expect(block).toContain('[modal]');
    expect(block).toContain('confirm: "Delete it?"');
    expect(block).toContain('browser_dialog({accept:true})');

    // Any other write is refused while it is open (the probe stalls: still open).
    const refusal = await assertNoPendingModal(page).catch((e) => e);
    expect(refusal).toBeInstanceOf(Error);
    expect(effectTagOf(refusal)).toEqual({ code: 'dialog_blocked', effect: 'none' });

    await expect(answerModal(page, false)).resolves.toMatchObject({ kind: 'answered' });
    expect(dialog.dismiss).toHaveBeenCalled();
    expect(pendingModal(page)).toBeUndefined();
    await expect(assertNoPendingModal(page)).resolves.toBeUndefined();
  });

  it('a prompt is answered with the given text', async () => {
    const { fake, page } = trackedPage();
    const dialog = fakeDialog('prompt', 'Name?', 'anon');
    fake.page.emit('dialog', dialog);
    expect(pendingModal(page)).toMatchObject({ type: 'prompt', defaultValue: 'anon' });
    await answerModal(page, true, 'wmux');
    expect(dialog.accept).toHaveBeenCalledWith('wmux');
  });

  it('a dialog closed by hand in the window does not refuse writes forever', async () => {
    const { fake, page } = trackedPage();
    fake.page.emit('dialog', fakeDialog('alert'));
    fake.state.evaluateStalls = false; // the page answers again: the dialog is gone
    await expect(assertNoPendingModal(page)).resolves.toBeUndefined();
    expect(pendingModal(page)).toBeUndefined();
  });

  it('a dialog that was already handled reports already_closed and clears', async () => {
    const { fake, page } = trackedPage();
    const dialog = fakeDialog('alert');
    dialog.accept.mockRejectedValue(new Error('Cannot accept dialog which is already handled!'));
    fake.page.emit('dialog', dialog);
    await expect(answerModal(page, true)).resolves.toMatchObject({ kind: 'already_closed' });
    expect(pendingModal(page)).toBeUndefined();
  });

  it('a main-frame navigation clears what was pending', () => {
    const { fake, page } = trackedPage();
    fake.page.emit('dialog', fakeDialog('alert'));
    fake.page.emit('framenavigated', fake.mainFrame);
    expect(pendingModal(page)).toBeUndefined();
  });
});

describe('only modals the agent raised are the agent’s to answer', () => {
  it('a dialog with no agent call in flight is refused, not consumed', async () => {
    const { fake, page } = trackedPage({ agentActive: false });
    const dialog = fakeDialog('confirm', 'Leave the meeting?');
    fake.page.emit('dialog', dialog);

    expect(pendingModal(page)).toMatchObject({ causedByAgent: false });
    expect(renderModalBlock(pendingModal(page)!)).toContain('left for the person');
    const refusal = await answerModal(page, true).catch((e) => e);
    expect(effectTagOf(refusal)?.code).toBe('dialog_blocked');
    expect(dialog.accept).not.toHaveBeenCalled();
    expect(dialog.dismiss).not.toHaveBeenCalled();
    expect(pendingModal(page)).toBeDefined();
  });

  it('a dialog just after the call ended still counts, one long after does not', () => {
    vi.useFakeTimers();
    const a = trackedPage();
    a.end();
    vi.advanceTimersByTime(CAUSE_GRACE_MS - 10);
    a.fake.page.emit('dialog', fakeDialog('alert'));
    expect(pendingModal(a.page)).toMatchObject({ causedByAgent: true });

    const b = trackedPage();
    b.end();
    vi.advanceTimersByTime(CAUSE_GRACE_MS + 10);
    b.fake.page.emit('dialog', fakeDialog('alert'));
    expect(pendingModal(b.page)).toMatchObject({ causedByAgent: false });
  });

  it('a file chooser the agent did not raise is not handed to browser_file_upload', () => {
    const { fake, page } = trackedPage({ agentActive: false });
    fake.page.emit('filechooser', { isMultiple: () => false });
    expect(() => takeFileChooser(page)).toThrow('did not open from an agent action');
  });

  it('an agent-raised file chooser is handed over once', () => {
    const { fake, page } = trackedPage();
    const chooser = { isMultiple: () => true };
    fake.page.emit('filechooser', chooser);
    expect(pendingModal(page)).toMatchObject({ type: 'filechooser', isMultiple: true });
    expect(takeFileChooser(page)).toBe(chooser);
    expect(takeFileChooser(page)).toBeUndefined();
  });
});

describe('defaults kept', () => {
  it('beforeunload is accepted at once and never becomes pending', () => {
    const { fake, page } = trackedPage();
    const dialog = fakeDialog('beforeunload', '');
    fake.page.emit('dialog', dialog);
    expect(dialog.accept).toHaveBeenCalled();
    expect(pendingModal(page)).toBeUndefined();
  });

  it('beforeunload is accepted even with no agent call in flight', () => {
    const { fake, page } = trackedPage({ agentActive: false });
    const dialog = fakeDialog('beforeunload', '');
    fake.page.emit('dialog', dialog);
    expect(dialog.accept).toHaveBeenCalled();
    expect(pendingModal(page)).toBeUndefined();
  });

  it('a pre-armed answer applies to the next dialog, and lapses after its TTL', async () => {
    vi.useFakeTimers();
    const a = trackedPage();
    await expect(answerModal(a.page, false)).resolves.toEqual({ kind: 'armed' });
    const first = fakeDialog('confirm');
    a.fake.page.emit('dialog', first);
    expect(first.dismiss).toHaveBeenCalled();
    expect(pendingModal(a.page)).toBeUndefined();

    const b = trackedPage();
    await answerModal(b.page, true);
    vi.advanceTimersByTime(ARMED_DIALOG_TTL_MS + 1);
    const late = fakeDialog('confirm');
    b.fake.page.emit('dialog', late);
    expect(late.accept).not.toHaveBeenCalled();
    expect(pendingModal(b.page)).toMatchObject({ type: 'confirm' });
  });

  it('on an untracked page (user or lent tab) the pre-arm is a one-shot listener that expires', async () => {
    vi.useFakeTimers();
    const fake = makeFakePage();
    const page = fake.page as unknown as Page;
    await expect(answerModal(page, true)).resolves.toEqual({ kind: 'armed' });
    expect(fake.page.listenerCount('dialog')).toBe(1);
    vi.advanceTimersByTime(ARMED_DIALOG_TTL_MS + 1);
    // Gone: Playwright's own default handling is back in charge of the page.
    expect(fake.page.listenerCount('dialog')).toBe(0);
    expect(pendingModal(page)).toBeUndefined();
  });
});
