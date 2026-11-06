import { beforeEach, describe, expect, it } from 'vitest';
import { ARMED_DIALOG_TTL_MS, GuestDialogs, type GuestDialogNote } from '../guestDialogs';

const settled = () => new Promise((resolve) => setImmediate(resolve));

describe('GuestDialogs', () => {
  let clock: number;
  let answers: Array<{ surfaceId: string; accept: boolean; text?: string }>;
  let notes: GuestDialogNote[];
  let dialogs: GuestDialogs;

  beforeEach(() => {
    clock = 1_000;
    answers = [];
    notes = [];
    dialogs = new GuestDialogs({
      answer: async (surfaceId, accept, text) => { answers.push({ surfaceId, accept, ...(text !== undefined && { text }) }); },
      note: (_surfaceId, note) => notes.push(note),
      now: () => clock,
      defer: (fn) => fn(),
    });
  });

  it("leaves a dialog to the person when nobody is driving", () => {
    dialogs.opening('s', 'confirm', 'sure?', false);
    expect(answers).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('dismisses at once while driven, and reports it with the page text capped', async () => {
    dialogs.opening('s', 'alert', 'x'.repeat(300), true);
    await settled();
    expect(answers).toEqual([{ surfaceId: 's', accept: false }]);
    expect(notes[0]).toMatchObject({ type: 'alert', answer: 'dismissed', at: 1_000 });
    expect(notes[0].message).toHaveLength(201);
  });

  it('answers a dialog left open when a lease starts, unless the person already closed it', () => {
    dialogs.opening('s', 'alert', 'timer', false);
    dialogs.leaseStarted('s');
    expect(answers).toHaveLength(1);
    dialogs.leaseStarted('s');
    expect(answers).toHaveLength(1);

    dialogs.opening('s', 'alert', 'again', false);
    dialogs.closed('s');
    dialogs.leaseStarted('s');
    expect(answers).toHaveLength(1);
  });

  it('never touches beforeunload', () => {
    dialogs.opening('s', 'beforeunload', '', true);
    dialogs.leaseStarted('s');
    expect(answers).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('spends an armed answer only on a dialog raised during an input dispatch, once', async () => {
    dialogs.arm('s', true, 'typed');
    dialogs.opening('s', 'confirm', 'timer, not the agent', true);
    expect(answers.at(-1)).toEqual({ surfaceId: 's', accept: false });

    const end = dialogs.beginDispatch('s');
    dialogs.opening('s', 'confirm', 'from the click', true);
    await settled();
    expect(answers.at(-1)).toEqual({ surfaceId: 's', accept: true, text: 'typed' });
    expect(notes.at(-1)?.answer).toBe('accepted (pre-armed)');

    clock += 10_000;
    dialogs.opening('s', 'confirm', 'spent', true);
    expect(answers.at(-1)).toEqual({ surfaceId: 's', accept: false });
    end();
    end();
  });

  it('reports a pre-armed dismissal as such, and lets an armed answer lapse', async () => {
    const end = dialogs.beginDispatch('s');
    dialogs.arm('s', false);
    dialogs.opening('s', 'confirm', 'a', true);
    await settled();
    expect(notes.at(-1)?.answer).toBe('dismissed (pre-armed)');
    end();

    const again = dialogs.beginDispatch('s');
    dialogs.arm('s', true);
    clock += ARMED_DIALOG_TTL_MS;
    dialogs.opening('s', 'confirm', 'late', true);
    await settled();
    expect(answers.at(-1)?.accept).toBe(false);
    expect(notes.at(-1)?.answer).toBe('dismissed');
    again();
  });

  it('decides whether input raised a dialog when it opens, not when it is answered', () => {
    const deferred: Array<() => void> = [];
    const local = new GuestDialogs({
      answer: async (surfaceId, accept) => { answers.push({ surfaceId, accept }); },
      note: () => undefined,
      now: () => clock,
      defer: (fn) => deferred.push(fn),
    });
    local.arm('s', true);
    const end = local.beginDispatch('s');
    local.opening('s', 'confirm', 'raised during the click', true);
    end();
    deferred.splice(0).forEach((fn) => fn());
    expect(answers.at(-1)?.accept).toBe(true);

    local.arm('s', true);
    local.opening('s', 'confirm', 'raised by a timer', true);
    const late = local.beginDispatch('s');
    deferred.splice(0).forEach((fn) => fn());
    expect(answers.at(-1)?.accept).toBe(false);
    late();
  });

  it('stops counting a hung input call after its limit', () => {
    dialogs.beginDispatch('s');
    dialogs.arm('s', true);
    clock += ARMED_DIALOG_TTL_MS;
    dialogs.arm('s', true);
    dialogs.opening('s', 'confirm', 'from a timer, long after', true);
    expect(answers.at(-1)?.accept).toBe(false);
  });

  it('reports nothing when the answer fails: something else got there first', async () => {
    const local = new GuestDialogs({
      answer: async () => { throw new Error('No dialog is showing'); },
      note: (_surfaceId, note) => notes.push(note),
      defer: (fn) => fn(),
    });
    local.opening('s', 'alert', 'x', true);
    await settled();
    expect(notes).toEqual([]);
  });

  it('stops answering a page that loops dialogs, says so once, and resumes after the window', async () => {
    for (let i = 0; i < 3; i++) dialogs.opening('s', 'alert', `n${i}`, true);
    expect(answers).toHaveLength(3);

    dialogs.opening('s', 'alert', 'n3', true);
    dialogs.leaseStarted('s');
    expect(answers).toHaveLength(3);
    await settled();
    expect(notes.filter((n) => n.answer.startsWith('left open'))).toHaveLength(1);

    clock += 10_000;
    dialogs.leaseStarted('s');
    expect(answers).toHaveLength(4);
  });

  it('stands down when something else answers during the delay', () => {
    const deferred: Array<() => void> = [];
    const local = new GuestDialogs({
      answer: async (surfaceId, accept) => { answers.push({ surfaceId, accept }); },
      note: (_surfaceId, note) => notes.push(note),
      defer: (fn) => deferred.push(fn),
    });
    local.opening('s', 'confirm', 'answered by Playwright', true);
    local.closed('s');
    deferred.forEach((fn) => fn());
    expect(answers).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('keeps surfaces apart and forgets one', () => {
    dialogs.opening('a', 'alert', 'x', false);
    dialogs.leaseStarted('b');
    expect(answers).toEqual([]);
    dialogs.forget('a');
    dialogs.leaseStarted('a');
    expect(answers).toEqual([]);
  });
});
