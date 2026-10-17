// Main's notices to one bot: one directed bot.notice fact and one wake per
// key; a worker that could not start also gets a card, in plain words.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withBotWorkerMergeGuard } from '../../agents/botWorkerMergeGuard';
import { factDedupeKey, type Fact, type FactDraft } from '../../../shared/facts';
import type { WakeEnqueueInput } from '../wakeQueue';
import { BOT_NOTICE_LIMITS, botNoticeDraft, noticeBot, noticeWorkerStarts, plainStartFailure, startFailureCode, type BotNoticePorts } from '../botNotices';
import { cmdLaunchPathRefusal, promptFileArgument } from '../../../shared/promptFileArgument';
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
    // ... with the code the reader's language words it by (full title, cause code).
    expect(systemCardForFact(p.facts[1])?.notice).toEqual({ code: 'worker.startFailed', args: { title: 'Verify PR #1', cause: 'fetch' } });
  });

  it('start failures read as plain words', () => {
    expect(plainStartFailure('fanout preflight failed: could not fetch pull/3/head')).toBe('the code it was to check could not be fetched from the repository');
    expect(plainStartFailure('fanout preflight failed (task 1): not a git repository')).toBe('the repository was not ready for a new worker');
    expect(plainStartFailure('prompt file write failed: EACCES')).toBe('its instructions could not be written');
    expect(plainStartFailure('???')).toBe('its setup failed');
    expect(startFailureCode(plainStartFailure('prompt file write failed: EACCES'))).toBe('promptFile');
    expect(startFailureCode(plainStartFailure('???'))).toBe('setup');
    expect(startFailureCode('Command Prompt cannot pass the wmux data folder')).toBeNull();
  });

  it('#2256: a Command Prompt path refusal reaches the card with its cause and remedy, not as an unopened pane', () => {
    const why = cmdLaunchPathRefusal(`claude ${promptFileArgument('C:\\Users\\me\\.wmux-wE9!\\worktrees\\.meta\\t-1\\prompt.md', 'win32')}`, 'C:\\Users\\me\\.wmux-wE9!', true) ?? '';
    expect(why).toBe('Command Prompt cannot pass the wmux data folder (its path contains "!"), and no other shell can either; move the folder');
    // As fan-out reports it: the renderer's spawn, the IPC wrapper, then pty:create's refusal.
    const wrap = (reason: string) => `renderer spawn failed: fanout.spawnWorkspace: PTY create failed — Error invoking remote method 'pty:create': Error: PTY_CREATE: ${reason}`;
    expect(plainStartFailure(wrap(why))).toBe(why);
    const p = ports();
    noticeWorkerStarts(p, 'bot-1', { workspaceId: 'ws-1', threadId: 'general', key: 'wake:w-1:1', tainted: false, tasks: [{ index: 0, title: 'Fix it', started: false, reason: plainStartFailure(wrap(why)), detail: wrap(why) }] });
    expect(p.facts[0].payload.title).toBe(`Worker for "Fix it" could not start: ${why}`);
    // Words plainStartFailure did not choose have no code: the card keeps its English.
    expect(p.facts[0].payload).not.toHaveProperty('notice');
  });

  it('#2268: a PowerShell worker refused for the data folder reaches the card with the same words as a Command Prompt one', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-notice-'));
    try {
      const dataDir = path.join(tmp, '.wmux-wE9!');
      const line = `claude ${promptFileArgument(path.join(dataDir, 'worktrees', '.meta', 't-1', 'prompt.md'), 'win32')}`;
      let thrown = '';
      try {
        withBotWorkerMergeGuard({ initialCommand: line, cwd: tmp }, { workspaceId: 'ws-task', strict: true }, { dir: dataDir, mcpEntry: () => '/opt/wmux/mcp/index.js', registeredLevel: () => null, isolatedBridge: () => null });
      } catch (err) {
        thrown = (err as Error).message;
      }
      const why = 'Command Prompt cannot pass the wmux data folder (its path contains "!"), and no other shell can either; move the folder';
      expect(thrown).toBe(`PTY_CREATE: ${why}`);
      // As fan-out reports it: the renderer's spawn, the IPC wrapper, then the guard's refusal.
      const wrapped = `renderer spawn failed: fanout.spawnWorkspace: PTY create failed — Error invoking remote method 'pty:create': Error: ${thrown}`;
      expect(plainStartFailure(wrapped)).toBe(why);
      const p = ports();
      for (const title of ['Fix it', 'x'.repeat(120)]) {
        noticeWorkerStarts(p, 'bot-1', { workspaceId: 'ws-1', threadId: 'general', key: `wake:w-1:${title.length}`, tainted: false, tasks: [{ index: 0, title, started: false, reason: plainStartFailure(wrapped), detail: wrapped }] });
        const card = String(p.facts[p.facts.length - 1].payload.title);
        expect(card.endsWith(`could not start: ${why}`), card).toBe(true);
        expect(card.length).toBeLessThanOrEqual(BOT_NOTICE_LIMITS.TITLE_MAX);
        expect(card).not.toMatch(/its pane could not be opened/);
      }
      expect(p.facts[0].payload.title).toBe(`Worker for "Fix it" could not start: ${why}`);
      expect(p.facts[0].payload).not.toHaveProperty('notice');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('#2256: every Command Prompt path reason reaches the card whole, the task title giving way', () => {
    const okDir = 'C:\\Users\\me\\.wmux';
    const line = (prompt: string) => `claude ${promptFileArgument(prompt, 'win32')}`;
    const reasons = [
      // The prompt file: each kind of flaw.
      ...['C:\\a!\\prompt.md', '\\\\server\\share\\prompt.md', 'C:\\a\nb\\prompt.md', 'C:\\a\u201cb\\prompt.md'].map((prompt) => cmdLaunchPathRefusal(line(prompt), okDir, true)),
      // The data folder: each kind of flaw, the longest (UNC, control character) included.
      ...['C:\\Tom&Jerry', '\\\\server\\share\\.wmux', 'C:\\a\tb'].map((dir) => cmdLaunchPathRefusal(line('D:\\out\\prompt.md'), dir, true)),
    ];
    const p = ports();
    reasons.forEach((reason, i) => {
      expect(reason, String(i)).not.toBeNull();
      for (const title of ['Fix it', 'x'.repeat(120)]) {
        noticeWorkerStarts(p, 'bot-1', { workspaceId: 'ws-1', threadId: 'general', key: `wake:w-1:${i}:${title.length}`, tainted: false, tasks: [{ index: 0, title, started: false, reason: plainStartFailure(`PTY_CREATE: ${reason}`) }] });
        const card = String(p.facts[p.facts.length - 1].payload.title);
        expect(card.endsWith(`could not start: ${reason}`), card).toBe(true);
        expect(card.length).toBeLessThanOrEqual(BOT_NOTICE_LIMITS.TITLE_MAX);
        expect(card).toMatch(/^Worker for "(Fix it|x+…)" could not start: /);
      }
    });
    // A reason with no room left for any title still arrives whole.
    const long = `Command Prompt cannot pass ${'y'.repeat(145)}`;
    noticeWorkerStarts(p, 'bot-1', { workspaceId: 'ws-1', threadId: 'general', key: 'wake:w-1:long', tainted: false, tasks: [{ index: 0, title: 'Fix it', started: false, reason: plainStartFailure(`PTY_CREATE: ${long}`) }] });
    expect(p.facts[p.facts.length - 1].payload.title).toBe(`Worker could not start: ${long}`);
  });
});
