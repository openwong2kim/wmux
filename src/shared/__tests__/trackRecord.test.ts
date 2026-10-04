import { describe, it, expect } from 'vitest';
import {
  MISSED_STALL_AFTER_MS,
  STALL_AFTER_MS,
  TRACK_RETENTION_WEEKS,
  addWeeks,
  agentSlug,
  buildRetro,
  bumpRow,
  emptyTrackRecord,
  moveItem,
  noteDecisionAsked,
  noteHumanApproval,
  openItem,
  pruneTrackRecord,
  questionPrint,
  repeatedQuestions,
  retroDueWeek,
  retroRunAt,
  rollupRows,
  sweepOpenItems,
  weekStartOf,
} from '../trackRecord';

const H = 60 * 60 * 1000;
// Wednesday 2026-09-30 12:00 local.
const WED = new Date(2026, 8, 30, 12, 0, 0).getTime();
const MON = new Date(2026, 8, 28, 0, 0, 0).getTime();

describe('weeks', () => {
  it('keys a week by its local Monday 00:00', () => {
    expect(weekStartOf(WED)).toBe(MON);
    expect(weekStartOf(MON)).toBe(MON);
    // Sunday belongs to the week that started six days earlier.
    expect(weekStartOf(new Date(2026, 9, 4, 23, 0).getTime())).toBe(MON);
    expect(addWeeks(MON, 1)).toBe(new Date(2026, 9, 5).getTime());
  });

  it('drops weeks past retention', () => {
    const d = emptyTrackRecord();
    for (let i = 0; i < TRACK_RETENTION_WEEKS + 3; i += 1) bumpRow(d, addWeeks(WED, -i), 'ws', 'claude', { delegations: 1 });
    pruneTrackRecord(d, WED);
    expect(d.weeks).toHaveLength(TRACK_RETENTION_WEEKS);
    expect(d.weeks[0].weekStart).toBe(addWeeks(MON, -(TRACK_RETENTION_WEEKS - 1)));
  });
});

describe('rollups', () => {
  it('counts a delegation, its time to done and the slowest list', () => {
    const d = emptyTrackRecord();
    openItem(d, 'link:aaaaaaaa-1', { workspaceId: 'ws', agent: 'claude', createdAt: WED }, WED);
    moveItem(d, 'link:aaaaaaaa-1', 'done', WED + 3 * H);
    const [row] = rollupRows(d, WED, 4);
    expect(row).toMatchObject({ workspaceId: 'ws', agent: 'claude', delegations: 1, done: 1, doneMs: 3 * H });
    expect(d.weeks[0].slowest[0]).toMatchObject({ ref: 'aaaaaaaa', ms: 3 * H });
    expect(d.open).toEqual({});
  });

  it('counts a needs-you wait as a stall only past the threshold, once', () => {
    const d = emptyTrackRecord();
    openItem(d, 'k', { workspaceId: 'ws', agent: 'claude', createdAt: WED }, WED);
    moveItem(d, 'k', 'needs-you', WED);
    sweepOpenItems(d, WED + STALL_AFTER_MS - 1);
    expect(rollupRows(d, WED, 1)[0].stalls).toBe(0);
    sweepOpenItems(d, WED + STALL_AFTER_MS);
    sweepOpenItems(d, WED + STALL_AFTER_MS + H);
    expect(rollupRows(d, WED, 1)[0].stalls).toBe(1);
  });

  it('counts blocked as a stall at once and a long silent wait as missed', () => {
    const d = emptyTrackRecord();
    openItem(d, 'fan:wtask-zz9', { workspaceId: 'ws', agent: 'codex', createdAt: WED }, WED);
    moveItem(d, 'fan:wtask-zz9', 'blocked', WED);
    sweepOpenItems(d, WED + 1);
    expect(rollupRows(d, WED, 1)[0].stalls).toBe(1);
    sweepOpenItems(d, WED + MISSED_STALL_AFTER_MS);
    expect(d.weeks[0].missedStalls).toEqual([
      { workspaceId: 'ws', agent: 'codex', ref: 'zz9', ms: MISSED_STALL_AFTER_MS, state: 'blocked' },
    ]);
  });

  it('a reaction ends the wait: answered in time is no stall', () => {
    const d = emptyTrackRecord();
    openItem(d, 'k', { workspaceId: 'ws', agent: 'claude', createdAt: WED }, WED);
    moveItem(d, 'k', 'needs-you', WED);
    moveItem(d, 'k', 'active', WED + 10 * 60 * 1000);
    sweepOpenItems(d, WED + 10 * H);
    expect(rollupRows(d, WED, 1)[0].stalls).toBe(0);
  });

  it('a cancelled delegation is neither done nor slow', () => {
    const d = emptyTrackRecord();
    openItem(d, 'k', { workspaceId: 'ws', agent: 'claude', createdAt: WED }, WED);
    moveItem(d, 'k', 'gone', WED + H);
    expect(rollupRows(d, WED, 1)[0]).toMatchObject({ delegations: 1, done: 0 });
    expect(d.weeks[0].slowest).toEqual([]);
  });
});

describe('questions', () => {
  it('keeps hashed words only, never the text', () => {
    const print = questionPrint('Should I merge PR #42 into main now?');
    expect(print.every((p) => /^[0-9a-f]{8}$/.test(p))).toBe(true);
    expect(JSON.stringify(print)).not.toMatch(/merge|main/);
  });

  it('groups similar questions asked twice or more', () => {
    const q = (text: string, at: number) => ({ workspaceId: 'ws', at, print: questionPrint(text) });
    const groups = repeatedQuestions([
      q('Merge PR 42 into main after CI is green?', 1),
      q('Merge PR 43 into main after CI is green?', 2),
      q('Which icon set should the settings page use?', 3),
    ]);
    expect(groups).toEqual([{ workspaceId: 'ws', count: 2, lastAt: 2 }]);
  });
});

describe('retro', () => {
  const lastWeek = addWeeks(MON, -1);
  const inLastWeek = lastWeek + 2 * 24 * H;

  it('summarises interruptions versus the week before, repeats, missed stalls and the slowest', () => {
    const d = emptyTrackRecord();
    noteDecisionAsked(d, 'ws', 'Release 3.68 today?', addWeeks(inLastWeek, -1));
    noteDecisionAsked(d, 'ws', 'Ship release 3.68 now?', inLastWeek);
    noteDecisionAsked(d, 'ws', 'Ship release 3.68 today?', inLastWeek + H);
    noteHumanApproval(d, 'ws', 'claude', inLastWeek);
    bumpRow(d, inLastWeek, 'ws', 'claude', { approvalsLane: 4 });
    openItem(d, 'link:slow0001', { workspaceId: 'ws', agent: 'claude', createdAt: inLastWeek }, inLastWeek);
    moveItem(d, 'link:slow0001', 'needs-you', inLastWeek);
    sweepOpenItems(d, inLastWeek + MISSED_STALL_AFTER_MS);
    moveItem(d, 'link:slow0001', 'done', inLastWeek + 10 * H);

    const card = buildRetro(d, lastWeek, WED);
    expect(card).not.toBeNull();
    expect(card?.interruptions).toEqual({ decisions: 2, approvals: 1, total: 3, prevTotal: 1 });
    expect(card?.approvalsLane).toBe(4);
    expect(card?.repeated).toEqual([{ workspaceId: 'ws', count: 2, lastAt: inLastWeek + H }]);
    expect(card?.missedStalls).toHaveLength(1);
    expect(card?.slowest[0]).toMatchObject({ ref: 'slow0001', ms: 10 * H });
    expect(card?.suggestions).toEqual(['precedent', 'stalls']);
    expect(JSON.stringify(card)).not.toMatch(/release|ship/i);
  });

  it('makes no card for a week with no activity', () => {
    const d = emptyTrackRecord();
    bumpRow(d, WED, 'ws', 'claude', { delegations: 1 }); // this week, not last
    expect(buildRetro(d, lastWeek, WED)).toBeNull();
  });
});

describe('retro schedule', () => {
  const sched = { enabled: true, day: 1, hour: 9 };

  it('runs on the scheduled local day and hour, once a week', () => {
    expect(retroRunAt(sched, MON)).toBe(new Date(2026, 8, 28, 9).getTime());
    expect(retroDueWeek(sched, undefined, new Date(2026, 8, 28, 8, 59).getTime())).toBeNull();
    expect(retroDueWeek(sched, undefined, new Date(2026, 8, 28, 9).getTime())).toBe(MON);
    expect(retroDueWeek(sched, MON, WED)).toBeNull();
  });

  it('catches up later in the week when the app was closed at the time', () => {
    expect(retroDueWeek(sched, addWeeks(MON, -1), WED)).toBe(MON);
  });

  it('treats Sunday as the last day of the week and honours off', () => {
    expect(retroRunAt({ enabled: true, day: 0, hour: 18 }, MON)).toBe(new Date(2026, 9, 4, 18).getTime());
    expect(retroDueWeek({ ...sched, enabled: false }, undefined, WED)).toBeNull();
  });
});

describe('agentSlug', () => {
  it('reduces a display name to its first word', () => {
    expect(agentSlug('Claude Code')).toBe('claude');
    expect(agentSlug('Codex')).toBe('codex');
    expect(agentSlug(null)).toBe('-');
  });
});
