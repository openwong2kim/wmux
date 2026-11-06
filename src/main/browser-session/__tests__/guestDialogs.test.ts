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

  it("answers at once a dialog raised just after an input, when the input's lease has already ended", async () => {
    dialogs.arm('s', true);
    dialogs.beginDispatch('s')();
    clock += 100;
    dialogs.opening('s', 'confirm', 'deferred by the handler', false);
    await settled();
    expect(answers).toEqual([{ surfaceId: 's', accept: true }]);
    expect(notes[0]).toMatchObject({ answer: 'accepted (pre-armed)' });
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

    clock += 60_000;
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

  describe('with the delay held', () => {
    let deferred: Array<{ fn: () => void; ms: number }>;
    let local: GuestDialogs;

    beforeEach(() => {
      deferred = [];
      local = new GuestDialogs({
        answer: async (surfaceId, accept) => { answers.push({ surfaceId, accept }); },
        note: () => undefined,
        now: () => clock,
        defer: (fn, ms) => deferred.push({ fn, ms }),
      });
    });
    const runDeferred = () => deferred.splice(0).forEach(({ fn }) => fn());

    it("answers an RPC-lane input's dialog at once, and waits on any other", () => {
      const end = local.beginDispatch('s');
      local.opening('s', 'confirm', 'from the click', true);
      expect(answers).toHaveLength(1);
      end();
      runDeferred();

      clock += 1_000;
      local.opening('s', 'confirm', 'a timer, or a Playwright-lane click', true);
      expect(answers).toHaveLength(1);
      expect(deferred[0].ms).toBe(500);
      runDeferred();
      expect(answers).toHaveLength(2);
    });

    it('gives a dialog that has only just opened the rest of its delay when a lease starts', () => {
      local.opening('s', 'confirm', 'a timer during a wait poll', true);
      clock += 20;
      local.leaseStarted('s');
      clock += 20;
      local.leaseStarted('s');
      expect(answers).toHaveLength(0);
      expect(deferred.map(({ ms }) => ms)).toEqual([500, 480, 460]);
      runDeferred();
      expect(answers).toHaveLength(1);

      local.opening('s', 'alert', 'waited on its box', false);
      clock += 500;
      local.leaseStarted('s');
      expect(answers).toHaveLength(2);
    });

    it('stands down when something else answers during the wait', () => {
      local.opening('s', 'confirm', 'answered by Playwright', true);
      local.closed('s');
      runDeferred();
      expect(answers).toEqual([]);
    });

    it('does not count a dialog raised after the input started as that input unless it was in flight', () => {
      local.arm('s', true);
      local.opening('s', 'confirm', 'raised by a timer', true);
      const late = local.beginDispatch('s');
      runDeferred();
      expect(answers.at(-1)?.accept).toBe(false);
      late();
    });

    it('lets a handler raise its dialog just after the input returns', () => {
      local.arm('s', true);
      const end = local.beginDispatch('s');
      end();
      clock += 100;
      local.opening('s', 'confirm', 'setTimeout 0 in the click handler', true);
      expect(answers.at(-1)?.accept).toBe(true);
    });

    it('ends that tail: a dialog well after the input is not its own', () => {
      local.arm('s', true);
      const end = local.beginDispatch('s');
      end();
      clock += 600;
      local.opening('s', 'confirm', 'much later', true);
      runDeferred();
      expect(answers.at(-1)?.accept).toBe(false);
    });
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

  it('caps answers across all tabs, says so once per dialog, and resumes after the window', async () => {
    dialogs.opening('a', 'alert', 'n0', true);
    dialogs.opening('b', 'alert', 'n1', true);
    dialogs.opening('a', 'alert', 'n2', true);
    expect(answers).toHaveLength(3);

    dialogs.opening('b', 'alert', 'n3', true);
    dialogs.leaseStarted('b');
    expect(answers).toHaveLength(3);
    await settled();
    expect(notes.filter((n) => n.answer.startsWith('left open'))).toHaveLength(1);

    clock += 60_000;
    dialogs.leaseStarted('b');
    expect(answers).toHaveLength(4);
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

describe('GuestDialogs and the boxes dialogs leave', () => {
  it('ties every dialog to its box when it opens, and ends the box when it closes, whoever answered', async () => {
    const calls: string[] = [];
    const dialogs = new GuestDialogs({
      answer: async () => undefined,
      note: () => undefined,
      defer: (fn) => fn(),
      sheets: {
        trackOpening: (surfaceId, message) => calls.push(`open ${surfaceId} ${message.length}`),
        closeIfStale: (surfaceId) => calls.push(`closed ${surfaceId}`),
        forget: (surfaceId) => calls.push(`forget ${surfaceId}`),
      },
    });

    dialogs.opening('person', 'confirm', 'sure?', false); // nobody driving: still tracked
    dialogs.opening('agent', 'alert', 'y'.repeat(300), true); // the full text, not the note's copy
    dialogs.opening('agent', 'beforeunload', '', true); // Electron settles these itself
    dialogs.closed('agent');
    dialogs.closed('person');
    dialogs.forget('agent');
    await settled();

    expect(calls).toEqual(['open person 5', 'open agent 300', 'closed agent', 'closed person', 'forget agent']);
  });
});
