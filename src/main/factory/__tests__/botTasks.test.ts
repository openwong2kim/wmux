// A bot's tasks with their stage: coded (reported), checked (system gate
// passed → completed), waiting to merge (its branch's PR is open), merged;
// from the ledger row, the mission's branch and repo-watch PR facts.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import type { Fact } from '../../../shared/facts';
import type { LedgerEntry, LedgerGateResult } from '../../../shared/ledger';
import { BOT_TASK_SUMMARY_MAX, botTaskStage, isSystemGatePass } from '../../../shared/botTask';
import { BOT_TASK_VIEW_MAX, TaskBranchCache, botTaskViews, indexPrFacts, prOfBranch, type BotTaskSources } from '../botTasks';
import { factoryBotRowsWithTasks, type FactoryBotRow } from '../../ipc/handlers/factory.handler';

const BOT = 'bot-0000000a';
const REPO = 'github.com/acme/app';
const PASS: LedgerGateResult = { exitCode: 0, tail: '', at: 1, command: 'npm test', recordedBy: 'system', headSha: 'a'.repeat(40) };

function row(id: string, status: LedgerEntry['status'], over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    schemaVersion: 1, id, taskWorkspaceId: `${id}-ws`, ownerWorkspaceId: 'ws-1', title: id, status, rev: 1, updatedAt: 10,
    updatedBy: { kind: 'worker', workspaceId: `${id}-ws` },
    dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'default' },
    ...over,
  };
}

let seq = 0;
function prFact(kind: 'pr.opened' | 'pr.merged' | 'pr.closed', n: number, branch?: string, repoKey = REPO, isCrossRepository = false): Fact {
  seq++;
  return { id: `f${seq}`, seq, kind, at: seq, dedupeKey: `${kind}:${n}:${seq}`, repoKey, ref: { pr: n }, payload: branch ? { headRefName: branch, isCrossRepository } : {} };
}

describe('botTaskStage', () => {
  it('coded → checked → waiting to merge → merged; a completion without a passing system gate is closed', () => {
    expect(botTaskStage(row('t', 'working'), null)).toBe('working');
    expect(botTaskStage(row('t', 'input_required'), null)).toBe('needs_input');
    expect(botTaskStage(row('t', 'review_requested', { gate: { ...PASS, exitCode: 1 } }), { number: 3, state: 'open' })).toBe('coded');
    expect(botTaskStage(row('t', 'completed', { gate: PASS }), null)).toBe('checked');
    expect(botTaskStage(row('t', 'completed', { gate: PASS }), { number: 3, state: 'open' })).toBe('waiting_to_merge');
    expect(botTaskStage(row('t', 'completed', { gate: PASS }), { number: 3, state: 'merged' })).toBe('merged');
    expect(botTaskStage(row('t', 'completed', { gate: PASS }), { number: 3, state: 'closed' })).toBe('checked');
    expect(botTaskStage(row('t', 'completed', { gate: { ...PASS, skipped: 'no_gate_command' } }), null)).toBe('closed');
    expect(botTaskStage(row('t', 'completed', { gate: { ...PASS, recordedBy: 'brain' } }), null)).toBe('closed');
    expect(botTaskStage(row('t', 'completed'), null)).toBe('closed');
    expect(botTaskStage(row('t', 'failed'), null)).toBe('failed');
    expect(botTaskStage(row('t', 'cancelled'), null)).toBe('cancelled');
    expect(isSystemGatePass(undefined)).toBe(false);
  });
});

describe('PR facts', () => {
  it('a branch\'s newest PR on the bot\'s repo, and how it ended', () => {
    const index = indexPrFacts([
      prFact('pr.opened', 1, 'wtask/a-1'),
      prFact('pr.closed', 1),
      prFact('pr.opened', 2, 'wtask/a-1'),
      prFact('pr.opened', 3, 'wtask/b-2'),
      prFact('pr.merged', 3),
      prFact('pr.opened', 4, 'wtask/c-3', 'github.com/other/repo'),
      // A fork's PR with the task's branch name is not the task's.
      prFact('pr.opened', 5, 'wtask/a-1', REPO, true),
      prFact('pr.merged', 5),
    ]);
    expect(prOfBranch(index, REPO, 'wtask/a-1')).toEqual({ number: 2, state: 'open' });
    expect(prOfBranch(index, 'GitHub.com/Acme/App', 'wtask/b-2')).toEqual({ number: 3, state: 'merged' });
    expect(prOfBranch(index, REPO, 'wtask/c-3')).toBeNull();
    expect(prOfBranch(index, REPO, null)).toBeNull();
    expect(prOfBranch(index, null, 'wtask/a-1')).toBeNull();
  });
});

describe('TaskBranchCache', () => {
  it('reads each owner\'s mission list for tasks whose branch is not known; keeps only found branches; a detached checkout has none', async () => {
    let fail = true;
    const list = vi.fn(async (owner: string) => {
      if (fail) throw new Error('daemon down');
      return { ok: true, tasks: [{ id: 'a', branch: 'wtask/a-1', owner }, { id: 'b' }, { id: 'other', branch: 'x' }] };
    });
    const cache = new TaskBranchCache(list);
    const detached = row('v', 'working', { dispatch: { origin: { kind: 'bot', botId: BOT }, preset: 'verify', checkout: { sha: 'a'.repeat(40), detached: true } } });
    const rows = [row('a', 'working'), row('b', 'working'), detached];
    expect([...(await cache.branches(rows))]).toEqual([['v', null]]);
    fail = false;
    expect([...(await cache.branches(rows))]).toEqual([['a', 'wtask/a-1'], ['v', null]]);
    expect(list).toHaveBeenCalledTimes(2);
    // 'b' has no branch yet: asked again; 'a' is not.
    await cache.branches([row('a', 'working')]);
    expect(list).toHaveBeenCalledTimes(2);
    await cache.branches([row('b', 'working')]);
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe('botTaskViews / FactoryBotRow.tasks', () => {
  const sources = (rows: LedgerEntry[], facts: Fact[] = []): BotTaskSources => ({
    rows: () => rows,
    branches: async (shown) => new Map(shown.map((r) => [r.id, `wtask/${r.id}`])),
    prFacts: () => facts,
  });

  it('each bot\'s tasks newest first with their stage and PR; other bots\' and pane tasks are not shown', async () => {
    const rows = [
      row('old', 'completed', { gate: PASS, updatedAt: 1, updatedBy: { kind: 'brain', workspaceId: 'ws-1' } }),
      row('new', 'review_requested', { updatedAt: 9 }),
      row('theirs', 'working', { dispatch: { origin: { kind: 'bot', botId: 'bot-0000000b' } } }),
      row('pane', 'working', { dispatch: { origin: { kind: 'pane' } } }),
    ];
    const views = await botTaskViews([{ id: BOT, repo: { repoKey: REPO } }], sources(rows, [prFact('pr.opened', 7, 'wtask/old')]));
    expect(views.get(BOT)).toEqual([
      { taskId: 'new', taskWorkspaceId: 'new-ws', ownerWorkspaceId: 'ws-1', botId: BOT, title: 'new', status: 'review_requested', stage: 'coded', preset: 'default', updatedAt: 9 },
      {
        taskId: 'old', taskWorkspaceId: 'old-ws', ownerWorkspaceId: 'ws-1', botId: BOT, title: 'old', status: 'completed', stage: 'waiting_to_merge', preset: 'default',
        gate: { exitCode: 0, at: 1, headSha: 'a'.repeat(40) }, pr: { number: 7, state: 'open' }, updatedAt: 1,
      },
    ]);
    expect(views.has('bot-0000000b')).toBe(false);
  });

  it('an ended task whose folder was kept for uncommitted changes says so', async () => {
    const rows = [row('kept', 'cancelled', { updatedAt: 2 }), row('gone', 'completed', { updatedAt: 1 })];
    const views = await botTaskViews([{ id: BOT }], { ...sources(rows), folderKept: (id) => id === 'kept' });
    expect(views.get(BOT)?.map((v) => [v.taskId, v.folder])).toEqual([['kept', 'kept_dirty'], ['gone', undefined]]);
  });

  it('caps a bot\'s list', async () => {
    const rows = Array.from({ length: BOT_TASK_VIEW_MAX + 5 }, (_, i) => row(`t${i}`, 'working', { updatedAt: i }));
    const views = await botTaskViews([{ id: BOT }], sources(rows));
    expect(views.get(BOT)).toHaveLength(BOT_TASK_VIEW_MAX);
    expect(views.get(BOT)?.[0].taskId).toBe(`t${BOT_TASK_VIEW_MAX + 4}`);
  });

  it('rows keep their shape; tasks are added only when there are some, and a failing source leaves the rows as they were', async () => {
    const bot = { id: BOT, workspaceId: 'ws-1' } as FactoryBotRow['bot'];
    const base: FactoryBotRow[] = [{ bot, status: null }];
    expect(await factoryBotRowsWithTasks(undefined, () => base, () => null)).toBe(base);
    const withTasks = await factoryBotRowsWithTasks(undefined, () => base, () => sources([row('t', 'working')]));
    expect(withTasks[0]).toMatchObject({ bot, status: null, tasks: [{ taskId: 't', stage: 'working' }] });
    const none = await factoryBotRowsWithTasks(undefined, () => base, () => sources([]));
    expect(none[0]).toEqual({ bot, status: null });
    const broken = await factoryBotRowsWithTasks(undefined, () => base, () => ({ ...sources([row('t', 'working')]), branches: async () => { throw new Error('x'); }, prFacts: () => { throw new Error('y'); } }));
    expect(broken[0].tasks?.[0]).toMatchObject({ taskId: 't', stage: 'working' });
  });
});

describe('the task\'s summary on the Bots page (B2 contract)', () => {
  it('carries the row\'s latest summary on one line, capped', async () => {
    const waiting = row('wtask-s1', 'input_required', { summary: 'push to origin HEAD was refused:\n which branch should I push?' });
    const long = row('wtask-s2', 'working', { summary: 'x'.repeat(BOT_TASK_SUMMARY_MAX + 50) });
    const views = await botTaskViews([{ id: 'bot-0000000a' }], { rows: () => [waiting, long, row('wtask-s3', 'working')], branches: async () => new Map(), prFacts: () => [] });
    const byId = new Map((views.get('bot-0000000a') ?? []).map((v) => [v.taskId, v]));
    expect(byId.get('wtask-s1')).toMatchObject({ stage: 'needs_input', summary: 'push to origin HEAD was refused: which branch should I push?' });
    expect(byId.get('wtask-s2')?.summary).toHaveLength(BOT_TASK_SUMMARY_MAX);
    expect(byId.get('wtask-s3')).not.toHaveProperty('summary');
  });
});
