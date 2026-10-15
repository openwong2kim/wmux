// Each ingest mapping with fakes, plus the subscribe/dispose wiring and the
// merge-effect watcher following a replaced delegate service.
import { describe, expect, it, vi } from 'vitest';
import {
  factFromBotRefusal,
  factFromBusEvent,
  factFromLedgerTransition,
  factFromMergeEffect,
  factFromVerdict,
  startFactIngest,
  watchMergeEffects,
  type MergeEffectSource,
} from '../factIngest';
import { factDedupeKey, type FactDraft } from '../../../shared/facts';
import type { WmuxEvent } from '../../../shared/events';
import type { LedgerEntry, LedgerStatus } from '../../../shared/ledger';
import type { LedgerTransition } from '../../../daemon/ledger/TaskLedger';
import type { MergeEffect } from '../../../shared/moaDecision';
import type { PrVerdictRecord } from '../../../shared/prVerdict';

const SHA = 'a'.repeat(40);

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  schemaVersion: 1, id: 'wtask-1', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-owner', title: 'Fix it',
  status: 'working', rev: 1, updatedAt: 5_000, updatedBy: { kind: 'worker', workspaceId: 'ws-task' }, ...over,
});

const transition = (from: LedgerStatus | null, to: LedgerStatus, over: Partial<LedgerEntry> = {}): LedgerTransition => ({
  entry: entry({ status: to, ...over }), from, to, by: { kind: 'worker', workspaceId: 'ws-task' },
});

const lifecycle = (over: Record<string, unknown> = {}): WmuxEvent => ({
  seq: 1, ts: 7_000, workspaceId: 'ws-task', type: 'agent.lifecycle', ptyId: 'pty-1',
  kind: 'agent.awaiting_input', source: 'detector', agent: 'claude', decision: 'emit', ...over,
} as WmuxEvent);

const prCi = (over: Record<string, unknown> = {}): WmuxEvent => ({
  seq: 2, ts: 8_000, workspaceId: 'ws-1', type: 'pr.ci', ptyId: 'pty-2', prNumber: 12,
  url: 'https://github.com/Owner/Repo/pull/12', checks: 'failing', headSha: SHA, ...over,
} as WmuxEvent);

const effect = (over: Partial<MergeEffect> = {}): MergeEffect => ({
  id: `lane:github.com/o/r#3:${SHA}`, kind: 'pr.merge', repoKey: 'github.com/o/r', repoPath: '/r', prNumber: 3,
  expectHead: SHA, approvedBy: 'lane', status: 'done', attempt: 1, createdAt: 1, updatedAt: 9_000, ...over,
});

const keyOf = (d: FactDraft | null): string | null => (d ? factDedupeKey(d) : null);

const BOT_DISPATCH = { dispatch: { origin: { kind: 'bot', botId: 'bot-lead1' }, preset: 'default' } } as const;

describe('factFromBusEvent', () => {
  const task = (status: LedgerStatus = 'working', over: Partial<LedgerEntry> = BOT_DISPATCH) =>
    (ws: string) => (ws === 'ws-task' ? entry({ status, ...over }) : null);

  it('agent.awaiting_input on an open bot task pane → pane.needs_input for the owner workspace', () => {
    const d = factFromBusEvent(lifecycle(), task());
    expect(d).toMatchObject({ kind: 'pane.needs_input', workspaceId: 'ws-owner', ref: { ptyId: 'pty-1', taskId: 'wtask-1', botId: 'bot-lead1' } });
    expect(keyOf(d)).toBe(`pane.needs_input:pty-1:${Math.floor(7_000 / 60_000)}`);
  });

  it('pane.needs_input carries the thread the task was started from', () => {
    const find = task('working', { dispatch: { origin: { kind: 'bot', botId: 'bot-lead1' }, threadId: 'pr:github.com/acme/app#4' } });
    expect(factFromBusEvent(lifecycle(), find)?.payload.threadId).toBe('pr:github.com/acme/app#4');
    expect(factFromBusEvent(lifecycle(), task())?.payload).not.toHaveProperty('threadId');
  });

  it('a task no bot started (a human fan-out, or a row from before dispatch existed) → no fact', () => {
    expect(factFromBusEvent(lifecycle(), task('working', {}))).toBeNull();
    expect(factFromBusEvent(lifecycle(), task('working', { dispatch: { origin: { kind: 'pane' } } }))).toBeNull();
    expect(factFromBusEvent(lifecycle(), task('working', { dispatch: { origin: { kind: 'bot' } } }))).toBeNull();
  });

  it('ignores other kinds, dedup/internal decisions, non-task panes and closed tasks', () => {
    expect(factFromBusEvent(lifecycle({ kind: 'agent.stop' }), task())).toBeNull();
    expect(factFromBusEvent(lifecycle({ decision: 'dedup' }), task())).toBeNull();
    expect(factFromBusEvent(lifecycle({ workspaceId: 'ws-human' }), task())).toBeNull();
    expect(factFromBusEvent(lifecycle(), task('completed'))).toBeNull();
  });

  it('pr.ci is not a source (the repo watch owns ci.* facts with their author)', () => {
    expect(factFromBusEvent(prCi(), () => null)).toBeNull();
  });

  it('other event types → no fact', () => {
    expect(factFromBusEvent({ seq: 1, ts: 1, workspaceId: 'w', type: 'pane.focused', paneId: 'p' } as WmuxEvent, () => null)).toBeNull();
  });
});

describe('factFromLedgerTransition', () => {
  it.each([
    [null, 'working', null],
    ['working', 'review_requested', 'task.done'],
    ['review_requested', 'completed', 'task.done'],
    ['working', 'failed', 'task.failed'],
    ['working', 'cancelled', 'task.failed'],
    ['input_required', 'cancelled', 'task.failed'],
    ['review_requested', 'cancelled', null],
    ['working', 'input_required', 'task.input_required'],
    ['input_required', 'working', null],
    ['working', 'working', null],
  ] as const)('%s → %s = %s', (from, to, kind) => {
    const d = factFromLedgerTransition(transition(from, to));
    expect(d?.kind ?? null).toBe(kind);
  });

  it('a task in review that the owner\'s stop cancelled → task.failed (stopped by owner); a plain close stays silent', () => {
    const stop = { ...transition('review_requested', 'cancelled', { summary: 'stopped by owner' }), by: { kind: 'system', workspaceId: 'ws-daemon' } } as LedgerTransition;
    expect(factFromLedgerTransition(stop)).toMatchObject({ kind: 'task.failed', payload: { status: 'cancelled', from: 'review_requested', by: 'system', summary: 'stopped by owner' } });
    expect(factFromLedgerTransition({ ...stop, entry: { ...stop.entry, summary: 'closed' } })).toBeNull();
    expect(factFromLedgerTransition({ ...stop, by: { kind: 'worker', workspaceId: 'ws-task' } } as LedgerTransition)).toBeNull();
  });

  it('scopes to the owner workspace, keys on the task, and caps text', () => {
    const d = factFromLedgerTransition({
      ...transition('working', 'review_requested', {
        title: 't'.repeat(500), gate: { exitCode: 0, tail: 'x'.repeat(8_000), at: 1, command: 'npm test', headSha: SHA },
      }),
      summary: 's'.repeat(2_000),
    });
    expect(d?.workspaceId).toBe('ws-owner');
    expect(keyOf(d)).toBe('task.done:wtask-1');
    expect(String(d?.payload.title).length).toBeLessThanOrEqual(200);
    expect(String(d?.payload.summary).length).toBeLessThanOrEqual(500);
    expect(d?.payload).toMatchObject({ gateExit: 0, gateHeadSha: SHA });
    expect(JSON.stringify(d?.payload)).not.toContain('xxxx');
    expect(d?.ref?.botId).toBeUndefined();
  });

  it('a task a bot started names that bot', () => {
    const d = factFromLedgerTransition(transition('working', 'review_requested', BOT_DISPATCH));
    expect(d?.ref).toEqual({ taskId: 'wtask-1', botId: 'bot-lead1' });
    // A row with no recorded thread (or one written before it existed) carries none.
    expect(d?.payload).not.toHaveProperty('threadId');
  });

  it('a task started from a wake thread carries that thread; general or a bad value carries none', () => {
    const withThread = (threadId: string) => ({ dispatch: { ...BOT_DISPATCH.dispatch, threadId } });
    expect(factFromLedgerTransition(transition('working', 'failed', withThread('issue:Acme/App#21')))?.payload.threadId)
      .toBe('issue:github.com/acme/app#21');
    expect(factFromLedgerTransition(transition('working', 'review_requested', withThread('general')))?.payload).not.toHaveProperty('threadId');
    expect(factFromLedgerTransition(transition('working', 'review_requested', withThread('x')))?.payload).not.toHaveProperty('threadId');
  });
});

describe('factFromVerdict / factFromMergeEffect / factFromBotRefusal', () => {
  const verdict = (over: Partial<PrVerdictRecord> = {}): PrVerdictRecord => ({
    version: 2, repoKey: 'github.com/o/r', prNumber: 3, headSha: SHA, verdict: 'pass',
    principal: { workspaceId: 'ws-v', botId: 'bot-v', agent: 'claude' }, evidence: { taskId: 'wtask-9', gateHeadSha: SHA },
    summary: 'green', at: 4_000, ...over,
  });

  it('a bot verdict → verdict.recorded keyed on the bot', () => {
    const d = factFromVerdict(verdict());
    expect(d).toMatchObject({ workspaceId: 'ws-v', actor: { kind: 'bot', id: 'bot-v' }, ref: { taskId: 'wtask-9' } });
    expect(keyOf(d)).toBe(`verdict.recorded:github.com/o/r#3:${SHA}:bot-v`);
  });

  it('a pane verdict keys on its workspace', () => {
    const d = factFromVerdict(verdict({ version: 1, principal: { workspaceId: 'ws-p', ptyId: 'pty', agent: 'codex' }, evidence: undefined }));
    expect(keyOf(d)).toBe(`verdict.recorded:github.com/o/r#3:${SHA}:ws-p`);
  });

  it('only finished merge effects are facts', () => {
    expect(keyOf(factFromMergeEffect(effect()))).toBe('merge.done:github.com/o/r#3');
    const refused = factFromMergeEffect(effect({ status: 'refused', reason: 'no-required-checks' }));
    expect(refused).toMatchObject({ kind: 'merge.refused', payload: { reason: 'no-required-checks' } });
    expect(keyOf(refused)).toBe(`merge.refused:github.com/o/r#3:${SHA}`);
    for (const status of ['pending', 'inFlight', 'uncertain'] as const) expect(factFromMergeEffect(effect({ status }))).toBeNull();
  });

  it('a role-gate refusal → bot.refused in the bot workspace', () => {
    const d = factFromBotRefusal({ at: 60_000, bot: { workspaceId: 'ws-b', botId: 'bot-b', role: 'lead' }, method: 'pane.close', reason: 'teardown' });
    expect(d).toMatchObject({ workspaceId: 'ws-b', payload: { role: 'lead', reason: 'teardown' } });
    expect(keyOf(d)).toBe('bot.refused:bot-b:pane.close:1');
  });
});

describe('startFactIngest', () => {
  function source<T>() {
    const fns = new Set<(v: T) => void>();
    return {
      sub: (fn: (v: T) => void) => { fns.add(fn); return () => { fns.delete(fn); }; },
      fire: (v: T) => { for (const fn of fns) fn(v); },
      size: () => fns.size,
    };
  }

  it('appends what each source maps, and stops on dispose', () => {
    const bus = source<WmuxEvent>();
    const ledger = source<LedgerTransition>();
    const verdicts = source<PrVerdictRecord>();
    const merges = source<MergeEffect>();
    const append = vi.fn(() => null);
    const ingest = startFactIngest({ append }, {
      subscribeBus: bus.sub, onLedgerTransition: ledger.sub, onVerdictRecorded: verdicts.sub, onMergeEffect: merges.sub,
      findTaskByWorkspace: (ws) => (ws === 'ws-task' ? entry(BOT_DISPATCH) : null),
    });
    bus.fire(prCi()); // not a source
    bus.fire(lifecycle({ workspaceId: 'ws-task' }));
    ledger.fire(transition('working', 'failed'));
    merges.fire(effect());
    ingest.noteBotRefused({ at: 1, bot: { workspaceId: 'w', botId: 'b', role: 'triage' }, method: 'x.y', reason: 'surface' });
    expect(append.mock.calls.map((c) => (c as unknown as [FactDraft])[0].kind)).toEqual(['pane.needs_input', 'task.failed', 'merge.done', 'bot.refused']);
    ingest.dispose();
    expect([bus.size(), ledger.size(), verdicts.size(), merges.size()]).toEqual([0, 0, 0, 0]);
    ledger.fire(transition('working', 'failed'));
    ingest.noteBotRefused({ at: 1, bot: { workspaceId: 'w', botId: 'b', role: 'triage' }, method: 'x.y', reason: 'surface' });
    expect(append).toHaveBeenCalledTimes(4);
  });

  it('a throwing sink or source never escapes', () => {
    const bus = source<WmuxEvent>();
    const log = vi.fn();
    startFactIngest({ append: () => { throw new Error('disk'); } }, {
      subscribeBus: bus.sub,
      findTaskByWorkspace: () => entry(BOT_DISPATCH),
      onLedgerTransition: () => { throw new Error('no ledger'); },
      log,
    });
    expect(() => bus.fire(lifecycle())).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe('watchMergeEffects', () => {
  it('follows the registered service as it is set and replaced, from its first outcome', () => {
    const make = () => {
      const listeners = new Set<Parameters<MergeEffectSource['subscribe']>[0]>();
      return {
        subscribe: (l: Parameters<MergeEffectSource['subscribe']>[0]) => { listeners.add(l); return () => { listeners.delete(l); }; },
        emit: (e: MergeEffect) => { for (const l of listeners) l.effect({ effect: e }); },
        size: () => listeners.size,
      };
    };
    let current: ReturnType<typeof make> | null = null;
    const changes = new Set<() => void>();
    const set = (next: ReturnType<typeof make> | null) => { current = next; for (const fn of changes) fn(); };
    const onChange = (fn: () => void) => { changes.add(fn); return () => { changes.delete(fn); }; };
    const seen: string[] = [];
    const off = watchMergeEffects(() => current, onChange)((e) => seen.push(e.status));
    const first = make();
    set(first);
    first.emit(effect());
    const second = make();
    set(second);
    expect(first.size()).toBe(0);
    second.emit(effect({ status: 'refused' }));
    set(null);
    expect(second.size()).toBe(0);
    off();
    expect(changes.size).toBe(0);
    expect(seen).toEqual(['done', 'refused']);
  });
});

describe('startFactIngest while the log cannot write (review fixes, PR #2164)', () => {
  it('keeps a fact the log could not write and writes it, in order, once the log can', () => {
    let writable = false;
    const written: string[] = [];
    let fire: (t: LedgerTransition) => void = () => undefined;
    const timers: Array<() => void> = [];
    const sink = {
      append: vi.fn(() => null),
      appendResult: vi.fn((d: FactDraft) => {
        if (!writable) return { ok: false as const, code: 'write_failed' as const };
        written.push(String(d.ref?.taskId));
        return { ok: true as const, fact: { ...d, id: 'f', seq: written.length, dedupeKey: 'k' } as never };
      }),
    };
    const log = vi.fn();
    const ingest = startFactIngest(sink, {
      onLedgerTransition: (fn) => { fire = fn; return () => undefined; },
      log,
      setTimer: (fn) => { timers.push(fn); return { cancel: () => undefined }; },
    });
    fire(transition('working', 'failed', { id: 'wtask-1' }));
    fire(transition('working', 'failed', { id: 'wtask-2' }));
    expect(written).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    writable = true;
    // The next draft waits behind the kept ones.
    fire(transition('working', 'failed', { id: 'wtask-3' }));
    expect(written).toEqual(['wtask-1', 'wtask-2', 'wtask-3']);
    // A kept draft is also written by the retry timer alone.
    writable = false;
    fire(transition('working', 'failed', { id: 'wtask-4' }));
    writable = true;
    for (const t of timers.splice(0)) t();
    expect(written).toEqual(['wtask-1', 'wtask-2', 'wtask-3', 'wtask-4']);
    expect(sink.append).not.toHaveBeenCalled();
    ingest.dispose();
  });

  it('a duplicate is not kept, and another refusal is logged', () => {
    let fire: (t: LedgerTransition) => void = () => undefined;
    let code: 'duplicate' | 'too_large' = 'duplicate';
    const sink = { append: vi.fn(() => null), appendResult: vi.fn(() => ({ ok: false as const, code })) };
    const log = vi.fn();
    startFactIngest(sink, { onLedgerTransition: (fn) => { fire = fn; return () => undefined; }, log, setTimer: () => ({ cancel: () => undefined }) });
    fire(transition('working', 'failed'));
    expect(log).not.toHaveBeenCalled();
    code = 'too_large';
    fire(transition('working', 'failed'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('too_large'));
    expect(sink.appendResult).toHaveBeenCalledTimes(2);
  });
});
