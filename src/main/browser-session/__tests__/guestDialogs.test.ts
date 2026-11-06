import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ARMED_DIALOG_TTL_MS, GuestDialogs, type GuestDialogNote } from '../guestDialogs';

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

  it('dismisses at once while driven, and reports it with the page text capped', () => {
    dialogs.opening('s', 'alert', 'x'.repeat(300), true);
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

  it('spends an armed answer only on a dialog raised during an input dispatch, once', () => {
    dialogs.arm('s', true, 'typed');
    dialogs.opening('s', 'confirm', 'timer, not the agent', true);
    expect(answers.at(-1)).toEqual({ surfaceId: 's', accept: false });

    const end = dialogs.beginDispatch('s');
    dialogs.opening('s', 'confirm', 'from the click', true);
    expect(answers.at(-1)).toEqual({ surfaceId: 's', accept: true, text: 'typed' });
    expect(notes.at(-1)?.answer).toBe('accepted (pre-armed)');

    clock += 10_000;
    dialogs.opening('s', 'confirm', 'spent', true);
    expect(answers.at(-1)).toEqual({ surfaceId: 's', accept: false });
    end();
    end();
  });

  it('reports a pre-armed dismissal as such, and lets an armed answer lapse', () => {
    const end = dialogs.beginDispatch('s');
    dialogs.arm('s', false);
    dialogs.opening('s', 'confirm', 'a', true);
    expect(notes.at(-1)?.answer).toBe('dismissed (pre-armed)');

    dialogs.arm('s', true);
    clock += ARMED_DIALOG_TTL_MS;
    dialogs.opening('s', 'confirm', 'late', true);
    expect(answers.at(-1)?.accept).toBe(false);
    expect(notes.at(-1)?.answer).toBe('dismissed');
    end();
  });

  it('stops answering a page that loops dialogs, says so once, and resumes after the window', () => {
    for (let i = 0; i < 3; i++) dialogs.opening('s', 'alert', `n${i}`, true);
    expect(answers).toHaveLength(3);

    dialogs.opening('s', 'alert', 'n3', true);
    dialogs.leaseStarted('s');
    expect(answers).toHaveLength(3);
    expect(notes.filter((n) => n.answer.startsWith('left open'))).toHaveLength(1);

    clock += 10_000;
    dialogs.leaseStarted('s');
    expect(answers).toHaveLength(4);
  });

  it('survives an answer that fails because the dialog is already gone', async () => {
    const failing = new GuestDialogs({
      answer: vi.fn(async () => { throw new Error('No dialog is showing'); }),
      note: vi.fn(),
      defer: (fn) => fn(),
    });
    expect(() => failing.opening('s', 'alert', 'x', true)).not.toThrow();
    await Promise.resolve();
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
