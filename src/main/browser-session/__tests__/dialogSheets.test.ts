import { describe, expect, it, vi } from 'vitest';
import { createSheetTracker, SHEET_RETRY_WINDOW_MS, type SheetPort } from '../dialogSheets';

// A fake window: sheets are records, listed in queue order. A page's alert box has
// the message, an empty detail and [OK]; a confirm adds Cancel. wmux's own boxes
// carry a detail and their own buttons.

interface FakeSheet { id: string; text: string; detail?: string; buttons: string[] }
interface FakeHost { name: string; sheets: FakeSheet[] }

const alertBox = (id: string, text: string): FakeSheet => ({ id, text, buttons: ['OK'] });
const confirmBox = (id: string, text: string): FakeSheet => ({ id, text, buttons: ['Cancel', 'OK'] });

function rig(options: { failOn?: (op: string) => boolean } = {}) {
  const ended: string[] = [];
  const retained: string[] = [];
  const released: string[] = [];
  const logs: string[] = [];
  const timers: Array<() => void> = [];
  const dying: Array<() => void> = [];
  let clock = 0;
  const fail = (op: string) => {
    if (options.failOn?.(op)) throw new Error(`${op} failed`);
  };
  const port: SheetPort<FakeHost, FakeSheet> & { texts: (s: FakeSheet) => string[]; same: (a: FakeSheet, b: FakeSheet) => boolean } = {
    list: (host) => { fail('list'); return [...host.sheets]; },
    key: (sheet) => sheet.id,
    shape: (sheet) => { fail('shape'); return { texts: [sheet.text, sheet.detail ?? ''], buttons: [...sheet.buttons] }; },
    // The previous port's members, so the same tests also run against it.
    texts: (sheet) => [sheet.text, ...(sheet.detail ? [sheet.detail] : [])],
    same: (a, b) => a === b,
    retain: (sheet) => { fail('retain'); retained.push(sheet.id); },
    release: (sheet) => { released.push(sheet.id); },
    endLater: (host, sheet) => {
      fail('endLater');
      ended.push(sheet.id);
      // Like performSelector afterDelay:0, the sheet leaves on the next turn.
      dying.push(() => { host.sheets = host.sheets.filter((s) => s !== sheet); });
    },
  };
  const tracker = createSheetTracker<FakeHost, FakeSheet>({
    port: () => port,
    schedule: (fn, ms) => { timers.push(() => { clock += ms; fn(); }); },
    now: () => clock,
    warn: (message) => logs.push(message),
  });
  /** Run the retries that are due, as the event loop would. */
  const tick = () => {
    for (const fn of dying.splice(0)) fn();
    for (const fn of timers.splice(0)) fn();
  };
  /** Let every retry run out. */
  const expire = () => { for (let i = 0; i < 100 && timers.length; i++) tick(); };
  return { tracker, ended, retained, released, logs, tick, expire };
}

const host = (name = 'win'): FakeHost => ({ name, sheets: [] });

describe('dialog sheets: which box belongs to which dialog', () => {
  it('pairs a box already listed when the opening arrives, and ends it when the dialog closes', () => {
    const { tracker, ended, released, logs } = rig();
    const win = host();
    const box = confirmBox('mine', 'Delete it?');
    win.sheets.push(box);

    tracker.trackOpening('s1', win, 'Delete it?', 'confirm');
    tracker.closeIfStale('s1');

    expect(ended).toEqual(['mine']);
    expect(released).toEqual(['mine']);
    expect(logs.filter((l) => l.includes('paired'))).toHaveLength(1);
  });

  it('pairs a box that is listed only on a retry', () => {
    const { tracker, ended, tick } = rig();
    const win = host();

    tracker.trackOpening('s1', win, 'Go on?', 'confirm');
    win.sheets.push(confirmBox('late', 'Go on?'));
    tick();
    tracker.closeIfStale('s1');

    expect(ended).toEqual(['late']);
  });

  it('keeps looking for about a second', () => {
    expect(SHEET_RETRY_WINDOW_MS).toBeGreaterThanOrEqual(900);
    expect(SHEET_RETRY_WINDOW_MS).toBeLessThanOrEqual(1500);
  });

  it('ends the box as soon as it is found when the dialog closed first', () => {
    const { tracker, ended, tick } = rig();
    const win = host();

    tracker.trackOpening('s1', win, 'Go on?', 'alert');
    tracker.closeIfStale('s1');
    win.sheets.push(alertBox('late', 'Go on?'));
    tick();

    expect(ended).toEqual(['late']);
  });

  it('P1-a: an expired agent opening, then a person\'s confirm, then the agent again: the person\'s box is never ended', () => {
    const { tracker, ended, expire, tick } = rig();
    const win = host();
    // (1) The agent's alert('X') is answered before its box is listed; its
    // opening runs out of retries, so the box is left unclaimed.
    tracker.trackOpening('agent', win, 'X', 'alert');
    tracker.closeIfStale('agent');
    expire();
    const agentStale = alertBox('agent-stale', 'X');
    win.sheets.push(agentStale);
    // (2) A person's confirm('X') on another tab.
    const personLive = confirmBox('person-live', 'X');
    win.sheets.push(personLive);
    tracker.trackOpening('person', win, 'X', 'confirm');
    tick();
    // (3) The agent's page loops alert('X'); the agent answers it.
    tracker.trackOpening('agent', win, 'X', 'alert');
    win.sheets.push(alertBox('agent-2', 'X'));
    tick();
    tracker.closeIfStale('agent');
    expire();

    expect(ended).not.toContain('person-live');
    expect(win.sheets).toContain(personLive);
  });

  it('a live box nobody paired, then a same-text agent dialog: the foreign box is never ended', () => {
    const { tracker, ended, tick, expire } = rig();
    const win = host();
    const foreign = confirmBox('foreign', 'Sure?');
    // Seen by an earlier scan (another dialog's), never paired.
    win.sheets.push(foreign);
    tracker.trackOpening('other', win, 'Different', 'alert');
    expire();
    tracker.trackOpening('agent', win, 'Sure?', 'confirm');
    tracker.closeIfStale('agent');
    tick();
    expire();

    expect(ended).not.toContain('foreign');
  });

  it('a foreign box and the agent\'s box first seen on the same scan: neither is claimed', () => {
    const { tracker, ended, logs } = rig();
    const win = host();
    win.sheets.push(confirmBox('foreign', 'Sure?'), confirmBox('agent', 'Sure?'));

    tracker.trackOpening('agent', win, 'Sure?', 'confirm');
    tracker.closeIfStale('agent');

    expect(ended).toEqual([]);
    expect(logs.some((l) => l.includes('no pair'))).toBe(true);
  });

  it('a wmux box with the page\'s message is never claimed: it has a detail and its own buttons', () => {
    const { tracker, ended, expire } = rig();
    const win = host();
    win.sheets.push(
      { id: 'quit', text: 'Quit wmux and stop all sessions?', detail: 'Agent sessions running: 0.', buttons: ['Quit and Stop Sessions', 'Cancel'] },
      { id: 'notice', text: 'Quit wmux and stop all sessions?', buttons: ['Quit and Stop Sessions', 'Cancel'] },
      { id: 'detailed', text: 'Quit wmux and stop all sessions?', detail: 'More.', buttons: ['OK'] },
    );

    tracker.trackOpening('agent', win, 'Quit wmux and stop all sessions?', 'alert');
    tracker.closeIfStale('agent');
    expire();

    expect(ended).toEqual([]);
  });

  it('two openings overlapping on one window track nothing, so nothing is ended wrongly', () => {
    const { tracker, ended, tick, expire } = rig();
    const win = host();

    tracker.trackOpening('a', win, 'Same', 'alert');
    tracker.trackOpening('b', win, 'Same', 'alert');
    win.sheets.push(alertBox('first', 'Same'), alertBox('second', 'Same'));
    tick();
    tracker.closeIfStale('b');
    tracker.closeIfStale('a');
    expire();

    expect(ended).toEqual([]);
  });

  it('two openings with different text on one window: both pair', () => {
    const { tracker, ended, tick, expire } = rig();
    const win = host();

    // 'loop 1' is answered before its box is listed; another tab opens 'other'.
    tracker.trackOpening('s1', win, 'loop 1', 'alert');
    tracker.closeIfStale('s1');
    tracker.trackOpening('s2', win, 'other', 'alert');
    win.sheets.push(alertBox('one', 'loop 1'), alertBox('two', 'other'));
    tick();
    tracker.closeIfStale('s2');
    expire();

    expect(ended).toEqual(['one', 'two']);
  });

  it('a page looping the same alert text: its openings pair in order', () => {
    const { tracker, ended, tick, expire } = rig();
    const win = host();

    tracker.trackOpening('s1', win, 'again', 'alert');
    tracker.closeIfStale('s1');
    tracker.trackOpening('s1', win, 'again', 'alert');
    win.sheets.push(alertBox('one', 'again'), alertBox('two', 'again'));
    tick();
    // The answered opening took the earliest box; the open one holds the next.
    expect(ended).toEqual(['one']);
    tracker.closeIfStale('s1');
    expire();

    expect(ended).toEqual(['one', 'two']);
  });

  it('a person who already clicked the box leaves nothing to end', () => {
    const { tracker, ended, released } = rig();
    const win = host();
    win.sheets.push(alertBox('box', 'Sure?'));

    tracker.trackOpening('s1', win, 'Sure?', 'alert');
    win.sheets = [];
    tracker.closeIfStale('s1');

    expect(ended).toEqual([]);
    expect(released).toEqual(['box']);
  });

  it('a box being ended is never claimed again while it is still listed', () => {
    const { tracker, ended, tick, expire } = rig();
    const win = host();
    const box = alertBox('box', 'Same');
    win.sheets.push(box);

    tracker.trackOpening('s1', win, 'Same', 'alert');
    tracker.closeIfStale('s1');
    // Ending runs on the next turn: the box is still listed when s2 opens.
    tracker.trackOpening('s2', win, 'Same', 'alert');
    tracker.closeIfStale('s2');
    tick();
    expire();

    expect(ended).toEqual(['box']);
  });

  it('a crashed or unregistered tab: a box it owns is ended, not just let go', () => {
    const { tracker, ended, released } = rig();
    const win = host();
    win.sheets.push(alertBox('box', 'Hi'));

    tracker.trackOpening('s1', win, 'Hi', 'alert');
    tracker.forget('s1');

    expect(ended).toEqual(['box']);
    expect(released).toEqual(['box']);
  });

  it('a failing end still releases what was retained, and the next dialog still works', () => {
    let failEnd = true;
    const { tracker, ended, released, logs } = rig({ failOn: (op) => op === 'endLater' && failEnd });
    const win = host();
    win.sheets.push(alertBox('one', 'A'));

    tracker.trackOpening('s1', win, 'A', 'alert');
    tracker.closeIfStale('s1');
    expect(released).toEqual(['one']);
    expect(logs.some((l) => l.includes('endLater failed'))).toBe(true);

    failEnd = false;
    win.sheets.push(alertBox('two', 'B'));
    tracker.trackOpening('s2', win, 'B', 'alert');
    tracker.closeIfStale('s2');
    expect(ended).toEqual(['two']);
  });

  it('a window closed while a retry is pending is not looked at again', () => {
    let closed = false;
    let lists = 0;
    // The closed window can't be listed: a look at it would warn.
    const { tracker, logs, tick } = rig({ failOn: (op) => op === 'list' && (lists++, closed) });
    const win = host();
    tracker.trackOpening('s1', win, 'Sure?', 'alert');
    tracker.forgetHost(win);
    closed = true;
    const before = lists;
    tick();

    expect(lists).toBe(before);
    expect(logs).toEqual([]);
  });

  it('keeps windows apart', () => {
    const { tracker, ended } = rig();
    const one = host('one');
    const two = host('two');
    one.sheets.push(alertBox('on-one', 'Same'));
    two.sheets.push(alertBox('on-two', 'Same'));

    tracker.trackOpening('t2', two, 'Same', 'alert');
    tracker.closeIfStale('t2');

    expect(ended).toEqual(['on-two']);
  });

  it('a port that cannot load warns once and never throws into the dialog path', () => {
    const warn = vi.fn();
    const tracker = createSheetTracker<FakeHost, FakeSheet>({
      port: () => { throw new Error('koffi missing'); },
      schedule: () => undefined,
      now: () => 0,
      warn,
    });
    const win = host();

    expect(() => {
      tracker.trackOpening('s1', win, 'A', 'alert');
      tracker.trackOpening('s2', win, 'B', 'confirm');
      tracker.closeIfStale('s1');
      tracker.forget('s2');
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('koffi missing');
  });
});
