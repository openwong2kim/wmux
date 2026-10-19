import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkLink } from '../../../shared/workLink';
import type { LedgerTransition } from '../../../daemon/ledger/TaskLedger';
import type { WorkspaceDecision } from '../deckDecisionStore';
import { TrackRecordStore, getTrackRecordKeyPath, getTrackRecordPath, parseTrackRecord } from '../trackRecordStore';
import {
  createTrackRecordFeed,
  laneOwner,
  type TrackApprovalRecord,
} from '../trackRecordFeed';
import { addWeeks, buildRetro, moveItem, rollupRows, weekStartOf, TRACK_RETENTION_WEEKS } from '../../../shared/trackRecord';

const H = 60 * 60 * 1000;
const NOW = new Date(2026, 8, 30, 12).getTime(); // Wednesday

function link(id: string, state: WorkLink['state'], extra: Partial<WorkLink> = {}): WorkLink {
  return {
    id, origin: 'moa', a2aTaskId: `task-${id}`, owner: { workspaceId: 'ws-a' }, requester: { workspaceId: 'ws-hq' },
    state, decisionIds: [], createdAt: NOW - H, updatedAt: NOW, ...extra,
  } as WorkLink;
}

function harness(opts: { moa?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'track-record-'));
  const store = new TrackRecordStore(dir);
  const state = { moa: opts.moa ?? true, now: NOW };
  const links = new Map<string, WorkLink>();
  const linkListeners = new Set<(ids: string[]) => void>();
  const decisionListeners = new Set<() => void>();
  const ledgerListeners = new Set<(t: LedgerTransition) => void>();
  const ledgerEntries = new Map<string, { status: LedgerTransition['to']; updatedAt: number }>();
  let decisions: Record<string, WorkspaceDecision> = {};
  let resolved: TrackApprovalRecord[] = [];
  const intervals: unknown[] = [];
  let retroSignals = 0;
  const feed = createTrackRecordFeed({
    store,
    isMoaEnabled: () => state.moa,
    workLinks: {
      get: (id) => links.get(id) ?? null,
      getByTaskId: (taskId) => [...links.values()].find((l) => l.a2aTaskId === taskId) ?? null,
      onChange: (fn) => { linkListeners.add(fn); return () => linkListeners.delete(fn); },
    },
    decisions: { load: () => decisions, onChanged: (fn) => { decisionListeners.add(fn); return () => decisionListeners.delete(fn); } },
    ledger: {
      onTransition: (fn) => { ledgerListeners.add(fn); return () => ledgerListeners.delete(fn); },
      get: (id) => ledgerEntries.get(id) ?? null,
    },
    listResolvedApprovals: async () => resolved,
    agentOf: (ws) => (ws === 'task-ws-1' ? 'codex' : 'claude'),
    taskOfWorkspace: (ws) => (ws === 'task-ws-1' ? { id: 'wtask-abc123', ownerWorkspaceId: 'ws-a' } : null),
    onRetroChanged: () => { retroSignals += 1; },
    now: () => state.now,
    setInterval: () => { const h = { unref: () => undefined }; intervals.push(h); return h; },
    clearInterval: (h) => { intervals.splice(intervals.indexOf(h), 1); },
  });
  return {
    dir, store, state, feed, intervals,
    retroSignals: () => retroSignals,
    listeners: () => linkListeners.size + decisionListeners.size + ledgerListeners.size,
    setLink: (l: WorkLink) => { links.set(l.id, l); for (const fn of linkListeners) fn([l.id]); },
    /** Change a link without telling anyone (it moved while the feed was off). */
    putLink: (l: WorkLink) => { links.set(l.id, l); },
    setDecisions: (d: Record<string, WorkspaceDecision>) => { decisions = d; for (const fn of decisionListeners) fn(); },
    ledger: (t: Partial<LedgerTransition> & { to: LedgerTransition['to'] }) => {
      ledgerEntries.set('wtask-abc123', { status: t.to, updatedAt: state.now });
      for (const fn of ledgerListeners) {
        fn({ from: null, by: { kind: 'system' }, entry: { id: 'wtask-abc123', taskWorkspaceId: 'task-ws-1', ownerWorkspaceId: 'ws-a' }, ...t } as unknown as LedgerTransition);
      }
    },
    setResolved: (r: TrackApprovalRecord[]) => { resolved = r; },
  };
}

const row = (h: ReturnType<typeof harness>, ws = 'ws-a', agent = 'claude') =>
  rollupRows(h.store.read(), h.state.now, 4).find((r) => r.workspaceId === ws && r.agent === agent);

describe('track record feed', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

  describe('Moa off', () => {
    beforeEach(() => { h = harness({ moa: false }); });

    it('subscribes to nothing, runs no timer, counts nothing', async () => {
      h.feed.sync();
      expect(h.feed.running()).toBe(false);
      expect(h.listeners()).toBe(0);
      expect(h.intervals).toHaveLength(0);
      h.setResolved([{ id: 'ap1', state: 'resolved', resolvedBy: 'desktop', workspaceId: 'ws-a', agent: 'claude' }]);
      await h.feed.onApprovalsChanged();
      h.feed.noteReply('task-x', 'ws-hq');
      h.feed.tick();
      expect(h.store.read().weeks).toEqual([]);
      expect(fs.existsSync(getTrackRecordPath(h.dir))).toBe(false);
    });

    it('turning Moa off stops a running feed', () => {
      h.state.moa = true;
      h.feed.sync();
      expect(h.feed.running()).toBe(true);
      h.state.moa = false;
      h.feed.sync();
      expect(h.feed.running()).toBe(false);
      expect(h.listeners()).toBe(0);
      expect(h.intervals).toHaveLength(0);
    });
  });

  describe('Moa on', () => {
    beforeEach(async () => {
      h = harness();
      h.feed.sync();
      await new Promise((r) => setTimeout(r, 0)); // the start's approval baseline
    });

    it('follows a work link from delegation to done, with a nudge and a linked decision', () => {
      h.setLink(link('l1', 'queued'));
      h.setLink(link('l1', 'running'));
      h.feed.noteReply('task-l1', 'ws-hq');
      h.feed.noteReply('task-l1', 'ws-a'); // the owner's own reply is no nudge
      h.setLink(link('l1', 'needs-you', { decisionIds: ['d1'] }));
      h.state.now += 2 * H;
      h.setLink(link('l1', 'done', { decisionIds: ['d1'] }));
      expect(row(h)).toMatchObject({ delegations: 1, done: 1, nudges: 1, decisions: 1, stalls: 1, doneMs: 3 * H });
    });

    it('does not count a link first seen already finished', () => {
      h.setLink(link('old', 'done'));
      expect(row(h)).toBeUndefined();
    });

    it('counts each new decision once as an interruption, never storing its text', () => {
      const d = (id: string): WorkspaceDecision => ({ id, question: 'Ship release 3.68 now?', options: [], context: '', status: 'pending', raisedAt: NOW });
      h.setDecisions({ 'ws-hq': d('d1') });
      h.setDecisions({ 'ws-hq': d('d1') });
      h.setDecisions({ 'ws-hq': d('d2') });
      const week = h.store.read().weeks[0];
      expect(week.interruptions.decisions).toBe(2);
      expect(week.questions).toHaveLength(2);
      expect(JSON.stringify(h.store.read())).not.toMatch(/release|ship/i);
    });

    it('drops a malformed lane label instead of crediting its owner', async () => {
      expect(laneOwner('hq:ws-hq;owner:ws-a;lane:hq')).toBe('ws-a');
      expect(laneOwner('hq:ws-hq;owner:../x y;lane:hq')).toBeNull();
      expect(laneOwner('hq:ws-hq;owner:ws-a;lane:hq;owner:ws-b')).toBeNull();
      h.setResolved([{ id: 'bad', state: 'resolved', resolvedBy: 'hq:ws-hq;owner:ws a;lane:hq', agent: 'claude', workspaceId: 'ws-a' }]);
      await h.feed.onApprovalsChanged();
      expect(h.store.read().weeks.flatMap((w) => w.rows)).toEqual([]);
    });

    it('tells lane presses from people and ignores brain presses and expiries', async () => {
      h.setResolved([
        { id: 'a1', state: 'resolved', resolvedBy: 'hq:ws-hq;owner:ws-a;lane:hq', agent: 'claude', workspaceId: 'task-ws-1' },
        { id: 'a2', state: 'resolved', resolvedBy: 'desktop', agent: 'codex', workspaceId: 'task-ws-1' },
        { id: 'a3', state: 'resolved', resolvedBy: 'brain:ws-a', agent: 'claude', workspaceId: 'ws-a' },
        { id: 'a4', state: 'expired', agent: 'claude', workspaceId: 'ws-a' },
      ]);
      await h.feed.onApprovalsChanged();
      await h.feed.onApprovalsChanged(); // the same list again counts nothing
      expect(row(h)?.approvalsLane).toBe(1);
      expect(row(h, 'ws-a', 'codex')?.approvalsHuman).toBe(1);
      expect(h.store.read().weeks[0].interruptions.approvals).toBe(1);
    });

    it('counts fan-out workers from the ledger under the owner', () => {
      h.ledger({ from: null, to: 'working' });
      h.ledger({ from: null, to: 'working' }); // a re-register is not a new delegation
      h.ledger({ from: 'working', to: 'failed' });
      h.ledger({ from: 'failed', to: 'working' });
      h.ledger({ from: 'review_requested', to: 'completed' });
      expect(row(h, 'ws-a', 'codex')).toMatchObject({ delegations: 1, done: 1, stalls: 1 });
    });

    it('counts a person\'s touches on each task, never an agent\'s, into the retro median', async () => {
      const decided = (id: string, resolvedBy: WorkspaceDecision['resolvedBy']): WorkspaceDecision =>
        ({ id, question: 'q', options: [], context: '', status: 'resolved', resolvedBy, raisedAt: NOW });
      h.ledger({ from: null, to: 'working' }); // fan:wtask-abc123, working in task-ws-1
      h.setLink(link('l5', 'running', { decisionIds: ['d5', 'd6', 'd7'] })); // working in ws-a
      h.feed.noteOwnerMessage('wtask-abc123');
      h.feed.noteOwnerMessage('wtask-abc123');
      h.feed.noteOwnerMessage('wtask-unknown');
      h.setResolved([
        { id: 'p1', state: 'resolved', resolvedBy: 'desktop', agent: 'codex', workspaceId: 'task-ws-1' },
        { id: 'p2', state: 'resolved', resolvedBy: 'hq:ws-hq;owner:ws-a;lane:hq', agent: 'codex', workspaceId: 'task-ws-1' },
        { id: 'p3', state: 'resolved', resolvedBy: 'brain:ws-a', agent: 'claude', workspaceId: 'ws-a' },
        { id: 'p4', state: 'resolved', resolvedBy: 'phone', agent: 'claude', workspaceId: 'ws-a' },
      ]);
      await h.feed.onApprovalsChanged();
      h.setDecisions({ 'ws-hq': decided('d5', 'human') });
      h.setDecisions({ 'ws-hq': decided('d5', 'human') }); // seen once
      h.setDecisions({ 'ws-hq': decided('d6', 'brain') });
      h.setDecisions({ 'ws-hq': decided('d7', undefined) }); // who answered is unknown
      const open = h.store.read().open;
      expect(open['fan:wtask-abc123'].touches).toEqual({ messages: 2, decisions: 0, approvals: 1 });
      expect(open['link:l5'].touches).toEqual({ messages: 0, decisions: 1, approvals: 1 });
      h.ledger({ from: 'review_requested', to: 'completed' });
      h.setLink(link('l5', 'done', { decisionIds: ['d5', 'd6', 'd7'] }));
      expect(h.store.read().weeks[0].doneTouches).toEqual([3, 2]);
      expect(buildRetro(h.store.read(), weekStartOf(NOW), NOW)?.ownerTouches).toEqual({ median: 2.5, tasks: 2 });
    });

    it('puts a hand-off\'s touches on its fan-out task once, and leaves items from before the count out', () => {
      h.store.mutate((d) => {
        d.open['link:old'] = { workspaceId: 'ws-b', agent: 'claude', createdAt: NOW - H, state: 'active', since: NOW - H };
      });
      h.ledger({ from: null, to: 'working' });
      // The Git page's hand-off link on the same task workspace.
      h.setLink(link('l6', 'running', { owner: { workspaceId: 'task-ws-1' }, decisionIds: ['d8'] }));
      h.setDecisions({ 'ws-hq': { id: 'd8', question: 'q', options: [], context: '', status: 'resolved', resolvedBy: 'human', raisedAt: NOW } });
      // A linkless decision raised in the task's own workspace is about that task.
      h.setDecisions({ 'task-ws-1': { id: 'd9', question: 'q', options: [], context: '', status: 'resolved', resolvedBy: 'human', raisedAt: NOW } });
      expect(h.store.read().open['fan:wtask-abc123'].touches?.decisions).toBe(2);
      h.setLink(link('l6', 'done', { owner: { workspaceId: 'task-ws-1' }, decisionIds: ['d8'] }));
      h.ledger({ from: 'review_requested', to: 'completed' });
      h.store.mutate((d) => moveItem(d, 'link:old', 'done', NOW));
      expect(h.store.read().weeks[0].doneTouches).toEqual([2]);
    });

    it('makes the retro card on schedule and records a quiet week without one', () => {
      // Activity last week, then the tick on Monday after 09:00.
      h.state.now = addWeeks(NOW, -1);
      h.setLink(link('l2', 'queued'));
      h.setLink(link('l2', 'done'));
      // sync() already ran this week's (empty) retro at the harness clock.
      h.store.mutate((d) => { delete d.retro.lastRunWeek; });
      h.state.now = new Date(2026, 8, 28, 9, 5).getTime();
      h.feed.tick();
      const retro = h.store.read().retro;
      expect(retro.lastRunWeek).toBe(weekStartOf(h.state.now));
      expect(retro.card?.delegations).toBe(1);
      expect(h.retroSignals()).toBe(2); // sync()'s empty run, then this one
      // The next week had nothing: the run is recorded and the old card goes.
      h.state.now = new Date(2026, 9, 5, 10).getTime();
      h.feed.tick();
      expect(h.store.read().retro.card).toBeUndefined();
      expect(h.store.read().retro.lastRunWeek).toBe(weekStartOf(h.state.now));
      h.feed.tick(); // already run this week: no signal
      expect(h.retroSignals()).toBe(3);
    });

    it('makes no retro while the retro is off', () => {
      h.store.mutate((d) => { d.retro.schedule.enabled = false; delete d.retro.lastRunWeek; });
      h.state.now = new Date(2026, 8, 28, 10).getTime();
      h.feed.tick();
      expect(h.store.read().retro.lastRunWeek).toBeUndefined();
    });
  });
});

describe('Moa off, then on again', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

  it('settles work that finished while off, without a missed stall', () => {
    h = harness();
    h.feed.sync();
    h.setLink(link('l3', 'needs-you'));
    h.state.moa = false;
    h.feed.sync();
    h.state.now += 10 * H;
    h.putLink(link('l3', 'done', { updatedAt: NOW + H }));
    h.state.moa = true;
    h.feed.sync();
    const d = h.store.read();
    expect(d.open).toEqual({});
    expect(row(h)).toMatchObject({ delegations: 1, done: 1, stalls: 0, doneMs: 2 * H });
    expect(d.weeks.flatMap((w) => w.missedStalls)).toEqual([]);
  });

  it('does not count the time it was off as waiting', () => {
    h = harness();
    h.feed.sync();
    h.setLink(link('l4', 'needs-you'));
    h.state.moa = false;
    h.feed.sync();
    h.state.now += 10 * H;
    h.state.moa = true;
    h.feed.sync();
    expect(row(h)?.stalls).toBe(0);
    h.state.now += H;
    h.feed.tick();
    expect(row(h)?.stalls).toBe(1);
  });

  it('takes approvals answered while off as a baseline, not as interruptions', async () => {
    h = harness();
    h.feed.sync();
    await new Promise((r) => setTimeout(r, 0));
    h.state.moa = false;
    h.feed.sync();
    h.setResolved([{ id: 'off1', state: 'resolved', resolvedBy: 'desktop', agent: 'claude', workspaceId: 'ws-a' }]);
    h.state.moa = true;
    h.feed.sync();
    await new Promise((r) => setTimeout(r, 0));
    await h.feed.onApprovalsChanged();
    expect(h.store.read().weeks.reduce((n, w) => n + w.interruptions.approvals, 0)).toBe(0);
    h.setResolved([
      { id: 'on1', state: 'resolved', resolvedBy: 'desktop', agent: 'claude', workspaceId: 'ws-a' },
      { id: 'off1', state: 'resolved', resolvedBy: 'desktop', agent: 'claude', workspaceId: 'ws-a' },
    ]);
    await h.feed.onApprovalsChanged();
    expect(h.store.read().weeks.reduce((n, w) => n + w.interruptions.approvals, 0)).toBe(1);
  });
});

describe('track record store', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'track-store-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('persists, reloads and clears counts while keeping the schedule', async () => {
    const a = new TrackRecordStore(dir);
    a.mutate((d) => {
      d.retro.schedule = { enabled: false, day: 5, hour: 17 };
      d.weeks.push({ weekStart: weekStartOf(NOW), rows: [], interruptions: { decisions: 3, approvals: 1 }, slowest: [], missedStalls: [], questions: [] });
    });
    await a.flush();
    const b = new TrackRecordStore(dir);
    expect(b.read().weeks[0].interruptions.decisions).toBe(3);
    b.clear();
    await b.flush();
    const c = new TrackRecordStore(dir).read();
    expect(c.weeks).toEqual([]);
    expect(c.retro.schedule).toEqual({ enabled: false, day: 5, hour: 17 });
  });

  it('clears without leaving the old stats in a backup, and replaces the question key', async () => {
    const a = new TrackRecordStore(dir);
    const before = a.questionPrint('Ship release 3.68 now?');
    expect(new TrackRecordStore(dir).questionPrint('Ship release 3.68 now?')).toEqual(before); // the key survives a restart
    if (process.platform !== 'win32') expect(fs.statSync(getTrackRecordKeyPath(dir)).mode & 0o777).toBe(0o600);
    a.mutate((d) => { d.weeks.push({ weekStart: weekStartOf(NOW), rows: [], interruptions: { decisions: 7, approvals: 0 }, slowest: [], missedStalls: [], questions: [] }); });
    a.mutate((d) => { d.weeks[0].interruptions.decisions = 8; }); // a second write leaves a .bak
    await a.flush();
    a.clear();
    await a.flush();
    for (const suffix of ['.bak', '.bak.1', '.bak.2', '.bak.3']) expect(fs.existsSync(`${getTrackRecordPath(dir)}${suffix}`)).toBe(false);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(getTrackRecordPath(dir), 'utf8')).weeks)).toBe('[]');
    expect(a.questionPrint('Ship release 3.68 now?')).not.toEqual(before);
    expect(before.every((p) => /^[0-9a-f]{8}$/.test(p))).toBe(true);
  });

  it('drops a stored retro card that is not the shape the renderer reads', () => {
    const card = { weekStart: 1, builtAt: 2, approvalsLane: 0, delegations: 1, done: 1, missedStalls: [], repeated: [], slowest: [], suggestions: ['precedent', 'nope'] };
    expect(parseTrackRecord({ version: 1, retro: { card } }).retro.card).toBeUndefined();
    const ok = parseTrackRecord({ version: 1, retro: { card: { ...card, interruptions: { decisions: 1, approvals: 0, total: 1, prevTotal: 0 } } } });
    expect(ok.retro.card?.suggestions).toEqual(['precedent']);
  });

  it('loads an unreadable or foreign file as empty', () => {
    fs.writeFileSync(getTrackRecordPath(dir), '{"version":2,"weeks":"x"}');
    expect(new TrackRecordStore(dir).read().weeks).toEqual([]);
  });

  it('keeps 12 weeks on the tick', () => {
    const h2 = harness();
    for (let i = 0; i < TRACK_RETENTION_WEEKS + 2; i += 1) {
      h2.store.mutate((d) => { d.weeks.push({ weekStart: addWeeks(weekStartOf(NOW), -i), rows: [], interruptions: { decisions: 1, approvals: 0 }, slowest: [], missedStalls: [], questions: [] }); });
    }
    h2.feed.sync();
    expect(h2.store.read().weeks).toHaveLength(TRACK_RETENTION_WEEKS);
    fs.rmSync(h2.dir, { recursive: true, force: true });
  });
});
