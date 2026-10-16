// Main's notices to one bot: one directed bot.notice fact and one wake per
// key; a worker that could not start also gets a card, in plain words.

import { describe, expect, it } from 'vitest';
import { factDedupeKey, type Fact, type FactDraft } from '../../../shared/facts';
import type { WakeEnqueueInput } from '../wakeQueue';
import { botNoticeDraft, noticeBot, noticeWorkerStarts, plainStartFailure, type BotNoticePorts } from '../botNotices';
import { systemCardForFact } from '../roomWriter';
import { WakeTaint } from '../wakeTaint';

function ports(): BotNoticePorts & { facts: Fact[]; queued: WakeEnqueueInput[] } {
  const facts: Fact[] = [];
  const queued: WakeEnqueueInput[] = [];
  return {
    facts,
    queued,
    now: () => 1000,
    log: () => undefined,
    factLog: () => ({
      append(d: FactDraft): Fact | null {
        const key = factDedupeKey(d);
        if (!key || facts.some((f) => f.dedupeKey === key)) return null;
        const f = { ...d, id: `f-${facts.length + 1}`, seq: facts.length + 1, dedupeKey: key } as Fact;
        facts.push(f);
        return f;
      },
    }),
    wakes: () => ({
      enqueue(input: WakeEnqueueInput) {
        queued.push(input);
        return null;
      },
    }),
  };
}

describe('bot notices', () => {
  it('one key is one directed fact and one priority-1 wake in its thread; a repeat wakes nobody', () => {
    const p = ports();
    const n = { botId: 'bot-0000000a', workspaceId: 'ws-1', key: 'pr.merged:github.com/o/r#1', topic: 'pr.merged' as const, title: 'PR #1 merged.', threadId: 'general' as const };
    const f = noticeBot(p, n);
    expect(f).toMatchObject({ kind: 'bot.notice', workspaceId: 'ws-1', ref: { botId: 'bot-0000000a', messageId: n.key }, payload: { topic: 'pr.merged', title: 'PR #1 merged.', threadId: 'general' } });
    expect(p.queued).toEqual([{ botId: 'bot-0000000a', workspaceId: 'ws-1', reason: { kind: 'facts', factIds: [f!.id], trigger: { kind: 'bot.notice' } }, priority: 1, threadId: 'general' }]);
    expect(noticeBot(p, n)).toBeNull();
    expect(p.queued).toHaveLength(1);
    // Another bot, same key: its own notice.
    expect(noticeBot(p, { ...n, botId: 'bot-0000000b' })).not.toBeNull();
  });

  it('a draft without a title or key is none; quoted error output marks it tainted', () => {
    expect(botNoticeDraft({ botId: 'b', workspaceId: 'w', key: '', topic: 'pr.merged', title: 'x' }, 1)).toBeNull();
    expect(botNoticeDraft({ botId: 'b', workspaceId: 'w', key: 'k', topic: 'pr.merged', title: '  ' }, 1)).toBeNull();
    expect(botNoticeDraft({ botId: 'b', workspaceId: 'w', key: 'k', topic: 'worker.start_failed', title: 't', detail: 'fatal: x' }, 1)?.payload).toMatchObject({ tainted: true, detail: 'fatal: x' });
    expect(botNoticeDraft({ botId: 'b', workspaceId: 'w', key: 'k', topic: 'pr.merged', title: 't' }, 1)?.payload.tainted).toBeUndefined();
    const notice = { id: 'f', seq: 1, kind: 'bot.notice', at: 1, dedupeKey: 'k', payload: { tainted: true } } as Fact;
    const taint = new WakeTaint({ facts: () => [], handoff: () => null, taskRow: () => null, runningWake: () => null });
    expect(taint.factTainted(notice)).toBe(true);
    expect(taint.factTainted({ ...notice, payload: {} })).toBe(false);
  });

  it('a worker start: started is recorded without a wake; could not start wakes the bot and posts a card, in plain words', () => {
    const p = ports();
    noticeWorkerStarts(p, 'bot-0000000a', {
      workspaceId: 'ws-1', threadId: 'general', key: 'wake:w-1:1', tainted: false,
      tasks: [
        { index: 0, title: 'Fix the README', taskId: 'wtask-a1', started: true },
        { index: 1, title: 'Verify PR #1', started: false, reason: plainStartFailure('fanout preflight failed: git fetch origin pull/1/head failed'), detail: 'git fetch origin pull/1/head failed' },
      ],
    });
    expect(p.facts.map((f) => [f.ref?.messageId, f.payload.topic, f.payload.card ?? false])).toEqual([
      ['worker.started:wtask-a1', 'worker.started', false],
      ['worker.start_failed:wake:w-1:1#1', 'worker.start_failed', true],
    ]);
    expect(p.facts[1].payload.title).toBe('Worker for "Verify PR #1" could not start: the code it was to check could not be fetched from the repository');
    // A started worker costs its bot no turn: only the failure wakes it.
    expect(p.queued.map((w) => (w.reason as { factIds: string[] }).factIds)).toEqual([[p.facts[1].id]]);
    // The started notice has no card; the failed one is a refusal card in the bot's thread, title only.
    expect(systemCardForFact(p.facts[0])).toBeNull();
    expect(systemCardForFact(p.facts[1])).toMatchObject({ workspaces: ['ws-1'], threadId: 'general', kind: 'refusal', title: p.facts[1].payload.title });
    expect(systemCardForFact(p.facts[1])).not.toHaveProperty('body');
  });

  it('start failures read as plain words', () => {
    expect(plainStartFailure('fanout preflight failed: could not fetch pull/3/head')).toBe('the code it was to check could not be fetched from the repository');
    expect(plainStartFailure('fanout preflight failed (task 1): not a git repository')).toBe('the repository was not ready for a new worker');
    expect(plainStartFailure('prompt file write failed: EACCES')).toBe('its instructions could not be written');
    expect(plainStartFailure('???')).toBe('its setup failed');
  });

  it('#2256: a Command Prompt path refusal reaches the card with its cause and remedy, not as an unopened pane', () => {
    const why = 'Command Prompt cannot pass its prompt file (the path contains "!"); use PowerShell (Settings › Terminal › Default shell) or move the wmux data folder';
    // As fan-out reports it: the renderer's spawn, the IPC wrapper, then pty:create's refusal.
    const error = `renderer spawn failed: fanout.spawnWorkspace: PTY create failed — Error invoking remote method 'pty:create': Error: PTY_CREATE: ${why}`;
    expect(plainStartFailure(error)).toBe(why);
    const p = ports();
    noticeWorkerStarts(p, 'bot-1', { workspaceId: 'ws-1', threadId: 'general', key: 'wake:w-1:1', tainted: false, tasks: [{ index: 0, title: 'Fix it', started: false, reason: plainStartFailure(error), detail: error }] });
    expect(p.facts[0].payload.title).toBe(`Worker for "Fix it" could not start: ${why}`);
    // A long task title gives way, so the reason reaches the card whole.
    noticeWorkerStarts(p, 'bot-1', { workspaceId: 'ws-1', threadId: 'general', key: 'wake:w-1:2', tainted: false, tasks: [{ index: 0, title: 'x'.repeat(120), started: false, reason: plainStartFailure(error) }] });
    expect(p.facts[1].payload.title).toMatch(/^Worker for "x+" could not start: /);
    expect(String(p.facts[1].payload.title).endsWith(why)).toBe(true);
  });
});
