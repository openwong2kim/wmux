import { describe, expect, it, vi } from 'vitest';
import { createSheetTracker, SHEET_RETRIES, SHEET_RETRY_MS, type SheetPort } from '../dialogSheets';

interface FakeSheet { id: string; text: string }
interface FakeHost { name: string; sheets: FakeSheet[] }

function rig() {
  const ended: string[] = [];
  const retained: string[] = [];
  const released: string[] = [];
  const timers: Array<() => void> = [];
  const warn = vi.fn();
  const port: SheetPort<FakeHost, FakeSheet> = {
    list: (host) => [...host.sheets],
    texts: (sheet) => [sheet.text],
    same: (a, b) => a === b,
    retain: (sheet) => { retained.push(sheet.id); },
    release: (sheet) => { released.push(sheet.id); },
    endLater: (host, sheet) => {
      ended.push(sheet.id);
      host.sheets = host.sheets.filter((s) => s !== sheet);
    },
  };
  const tracker = createSheetTracker<FakeHost, FakeSheet>({
    port: () => port,
    schedule: (fn) => { timers.push(fn); },
    warn,
  });
  /** Run the retry timers that are due, as the event loop would. */
  const tick = () => { for (const fn of timers.splice(0)) fn(); };
  /** The same, with the later opening's retry running first. */
  const tickLatestFirst = () => { for (const fn of timers.splice(0).reverse()) fn(); };
  return { tracker, ended, retained, released, warn, tick, tickLatestFirst, port };
}

const host = (name = 'win'): FakeHost => ({ name, sheets: [] });

describe('dialog sheets: which box belongs to which dialog', () => {
  it('claims the sheet whose text is the message, and ends it when the dialog closes', () => {
    const { tracker, ended, retained, released } = rig();
    const win = host();
    const quit = { id: 'quit', text: 'Quit wmux?' };
    const mine = { id: 'mine', text: 'Delete it?' };
    win.sheets.push(quit, mine);

    tracker.trackOpening('s1', win, 'Delete it?');
    tracker.closeIfStale('s1');

    expect(retained).toEqual(['mine']);
    expect(ended).toEqual(['mine']);
    expect(released).toEqual(['mine']);
    expect(win.sheets).toEqual([quit]);
  });

  it('leaves the box alone when no sheet carries exactly that text', () => {
    const { tracker, ended, retained, tick } = rig();
    const win = host();
    win.sheets.push({ id: 'quit', text: 'Quit wmux?' }, { id: 'near', text: 'Delete it? ' });

    tracker.trackOpening('s1', win, 'Delete it?');
    for (let i = 0; i <= SHEET_RETRIES; i++) tick();
    tracker.closeIfStale('s1');

    expect(retained).toEqual([]);
    expect(ended).toEqual([]);
  });

  it('finds a sheet that appears a moment after the opening', () => {
    const { tracker, ended, tick } = rig();
    const win = host();

    tracker.trackOpening('s1', win, 'Go on?');
    win.sheets.push({ id: 'late', text: 'Go on?' });
    tick();
    tracker.closeIfStale('s1');

    expect(ended).toEqual(['late']);
    expect(SHEET_RETRY_MS * SHEET_RETRIES).toBeGreaterThanOrEqual(300);
  });

  it('ends the sheet as soon as it is found when the dialog closed first', () => {
    const { tracker, ended, released, tick } = rig();
    const win = host();

    tracker.trackOpening('s1', win, 'Go on?');
    tracker.closeIfStale('s1');
    win.sheets.push({ id: 'late', text: 'Go on?' });
    tick();

    expect(ended).toEqual(['late']);
    expect(released).toEqual(['late']);
  });

  it('a person who already clicked the box leaves nothing to end', () => {
    const { tracker, ended, released } = rig();
    const win = host();
    const box = { id: 'box', text: 'Sure?' };
    win.sheets.push(box);

    tracker.trackOpening('s1', win, 'Sure?');
    win.sheets = []; // the person clicked it
    tracker.closeIfStale('s1');

    expect(ended).toEqual([]);
    expect(released).toEqual(['box']);
  });

  it('compares identity at close, so a new box with the same text at the same place is left alone', () => {
    const { tracker, ended } = rig();
    const win = host();
    const first = { id: 'first', text: 'Sure?' };
    win.sheets.push(first);

    tracker.trackOpening('s1', win, 'Sure?');
    win.sheets = [{ id: 'other', text: 'Sure?' }]; // someone else's box now sits where it was
    tracker.closeIfStale('s1');

    expect(ended).toEqual([]);
  });

  it('pairs openings in order per window: two tabs with the same text never swap sheets', () => {
    // A person's tab opens "Are you sure?" first, before its sheet can be read.
    // An agent's tab then opens the same text, and its read runs while the
    // person's retry is still pending. The sheet it finds is the person's.
    const { tracker, ended, tick } = rig();
    const win = host();
    const personSheet = { id: 'person', text: 'Are you sure?' };
    const agentSheet = { id: 'agent', text: 'Are you sure?' };

    tracker.trackOpening('person-tab', win, 'Are you sure?');
    win.sheets.push(personSheet);
    tracker.trackOpening('agent-tab', win, 'Are you sure?');
    win.sheets.push(agentSheet);
    tick();
    tick();

    tracker.closeIfStale('agent-tab'); // the agent's dialog was answered
    expect(ended).toEqual(['agent']);
    expect(win.sheets).toEqual([personSheet]); // the person's box is still up
  });

  it('a later opening waits its turn instead of taking an earlier opening\'s sheet', () => {
    const { tracker, ended, tick, tickLatestFirst } = rig();
    const win = host();

    tracker.trackOpening('a', win, 'Same');
    tracker.trackOpening('b', win, 'Same');
    win.sheets.push({ id: 'first', text: 'Same' });
    tickLatestFirst(); // b reads before a does, and finds a's sheet
    win.sheets.push({ id: 'second', text: 'Same' });
    tick();
    tick();

    tracker.closeIfStale('b');
    tracker.closeIfStale('a');
    expect(ended).toEqual(['second', 'first']);
  });

  it('keeps windows apart', () => {
    const { tracker, ended } = rig();
    const one = host('one');
    const two = host('two');
    one.sheets.push({ id: 'on-one', text: 'Same' });
    two.sheets.push({ id: 'on-two', text: 'Same' });

    tracker.trackOpening('t2', two, 'Same');
    tracker.closeIfStale('t2');

    expect(ended).toEqual(['on-two']);
  });

  it('forgetting a surface or its window releases what it held, without ending it', () => {
    const { tracker, ended, released } = rig();
    const win = host();
    win.sheets.push({ id: 'x', text: 'A' }, { id: 'y', text: 'B' });

    tracker.trackOpening('s1', win, 'A');
    tracker.trackOpening('s2', win, 'B');
    tracker.forget('s1');
    tracker.forgetHost(win);
    tracker.closeIfStale('s2');

    expect(released).toEqual(['x', 'y']);
    expect(ended).toEqual([]);
  });

  it('a failing port warns once, turns itself off and never throws into the dialog path', () => {
    const warn = vi.fn();
    const tracker = createSheetTracker<FakeHost, FakeSheet>({
      port: () => { throw new Error('koffi missing'); },
      schedule: () => undefined,
      warn,
    });
    const win = host();

    expect(() => {
      tracker.trackOpening('s1', win, 'A');
      tracker.trackOpening('s2', win, 'B');
      tracker.closeIfStale('s1');
      tracker.forget('s2');
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('koffi missing');
  });
});
