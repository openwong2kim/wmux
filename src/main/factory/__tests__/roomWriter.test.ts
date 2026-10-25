import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotProfile } from '../../../shared/bot';
import type { Fact, FactKind } from '../../../shared/facts';
import { ROOM_LIMITS, type RoomCard } from '../../../shared/room';
import { STOPPED_BY_OWNER } from '../factoryStop';
import {
  RoomWriter,
  WakeOrdinals,
  factRooms,
  parseCardLine,
  sanitizeRefs,
  setFactGuestProbe,
  setGuestTurnProbe,
  expectGuestProbes,
  systemCardForFact,
  writeFactCards,
  formatHeldUntil,
  writeBotHookCard,
  writeInterruptedWakeCard,
  type RoomEventPayload,
} from '../roomWriter';

let dir = '';
let now = 1_000_000_000_000;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wp5-rooms-'));
  now = 1_000_000_000_000;
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function writer(extra: Partial<ConstructorParameters<typeof RoomWriter>[0]> = {}): RoomWriter {
  return new RoomWriter({ dir, now: () => now, log: () => undefined, ...extra });
}

const SYS = { kind: 'system' } as const;

function bot(id: string, ws: string, role: BotProfile['role'], repoKey?: string): BotProfile {
  return {
    version: 1, id, workspaceId: ws, role, name: role, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: { maxTurnsPerHour: 1, maxTurnsPerDay: 1, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 },
    ...(repoKey ? { repo: { repoKey, repoPath: '/r' } } : {}),
    enabled: true, createdAt: 1, updatedAt: 1,
  };
}

function directory(bots: BotProfile[]) {
  return { listEnabled: () => bots.filter((b) => b.enabled), get: (id: string) => bots.find((b) => b.id === id) ?? null };
}

let factSeq = 0;
function fact(kind: FactKind, extra: Partial<Fact> = {}): Fact {
  factSeq += 1;
  return { id: `f-${factSeq}`, seq: factSeq, kind, at: now, dedupeKey: `${kind}:${factSeq}`, payload: {}, ...extra };
}

describe('RoomWriter store', () => {
  it('appends cards with a per-room arrival seq and survives a restart', () => {
    const w = writer();
    const a = w.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'one' })!;
    const b = w.append({ workspaceId: 'ws1', threadId: 'task:t1', kind: 'status', actor: SYS, title: 'two' })!;
    w.append({ workspaceId: 'ws2', kind: 'status', actor: SYS, title: 'other room' });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    const again = writer();
    expect(again.read('ws1').cards.map((c) => c.title)).toEqual(['one', 'two']);
    expect(again.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'three' })!.seq).toBe(3);
  });

  it('a system card keeps its notice code and values across a restart; a bot card or a malformed notice keeps none', () => {
    const w = writer();
    const card = w.append({
      workspaceId: 'ws1', threadId: 'task:t1', kind: 'fact', actor: SYS, title: 'Worker done',
      notice: { code: 'worker.done', args: { status: 'cancelled', exit: 1, 'bad key': 'x', nested: { a: 1 } as never } },
    })!;
    expect(card.notice).toEqual({ code: 'worker.done', args: { status: 'cancelled', exit: 1 } });
    expect(writer().read('ws1').cards[0].notice).toEqual({ code: 'worker.done', args: { status: 'cancelled', exit: 1 } });
    const botCard = w.append({ workspaceId: 'ws1', kind: 'status', actor: { kind: 'bot', workspaceId: 'ws1', botId: 'bot-0a1b2c3d' }, title: 'b', notice: { code: 'worker.done' } })!;
    expect(botCard).not.toHaveProperty('notice');
    expect(w.append({ workspaceId: 'ws1', kind: 'fact', actor: SYS, title: 'c', notice: { code: 'Not A Code' } })).not.toHaveProperty('notice');
  });

  it('refuses a workspace id that is not filename-safe and an invalid thread', () => {
    const w = writer();
    expect(w.append({ workspaceId: '../x', kind: 'status', actor: SYS, title: 't' })).toBeNull();
    expect(w.append({ workspaceId: 'ws1', threadId: 'nope' as never, kind: 'status', actor: SYS, title: 't' })).toBeNull();
    expect(w.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: '   ' })).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('caps title and body', () => {
    const c = writer().append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'x'.repeat(500), body: 'y'.repeat(20_000) })!;
    expect(c.title.length).toBe(ROOM_LIMITS.TITLE_MAX);
    expect(c.body!.length).toBe(ROOM_LIMITS.CARD_BODY_MAX);
  });

  it('read: omitted thread = every card, general = the general thread only, a thread = that thread', () => {
    const w = writer();
    w.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'g' });
    w.append({ workspaceId: 'ws1', threadId: 'task:t1', kind: 'status', actor: SYS, title: 't' });
    expect(w.read('ws1').cards.map((c) => c.title)).toEqual(['g', 't']);
    expect(w.read('ws1', { threadId: 'general' }).cards.map((c) => c.title)).toEqual(['g']);
    expect(w.read('ws1', { threadId: 'task:t1' }).cards.map((c) => c.title)).toEqual(['t']);
  });

  it('pages by seq with nextSinceSeq and hasMore', () => {
    const w = writer();
    for (let i = 1; i <= 5; i += 1) w.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: `c${i}` });
    const p1 = w.read('ws1', { sinceSeq: 0, limit: 2 });
    expect(p1.cards.map((c) => c.seq)).toEqual([1, 2]);
    expect(p1).toMatchObject({ nextSinceSeq: 2, hasMore: true });
    const p3 = w.read('ws1', { sinceSeq: 4, limit: 2 });
    expect(p3.cards.map((c) => c.seq)).toEqual([5]);
    expect(p3).toMatchObject({ nextSinceSeq: 5, hasMore: false });
    expect(w.read('ws1', { sinceSeq: 5 })).toMatchObject({ cards: [], nextSinceSeq: 5, hasMore: false });
    expect(w.read('ws1', { limit: 2 }).cards.map((c) => c.seq)).toEqual([4, 5]);
  });

  it('a post with a used clientPostId returns the first card as a duplicate', () => {
    const w = writer();
    const first = w.post({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'a', clientPostId: 'wake:w1:1' });
    const second = w.post({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'a again', clientPostId: 'wake:w1:1' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.duplicate).toBe(true);
    expect(second.card.id).toBe(first.card.id);
    expect(w.read('ws1').cards).toHaveLength(1);
    const reloaded = writer().post({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'after restart', clientPostId: 'wake:w1:1' });
    expect(reloaded).toMatchObject({ ok: true, duplicate: true });
  });

  it('a guest card\'s clientPostId returns it only to another guest post', () => {
    const w = writer();
    const guest = { workspaceId: 'ws1', kind: 'guest' as const, actor: SYS, title: 'External guest: G', body: 'GUEST-WORDS', guest: { guestId: '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b', name: 'G' }, clientPostId: 'guest:g:m1' };
    expect(w.post(guest)).toMatchObject({ ok: true });
    const reused = w.post({ workspaceId: 'ws1', kind: 'status', actor: { kind: 'bot', workspaceId: 'ws1', botId: 'bot-0000aaaa' }, title: 'x', clientPostId: 'guest:g:m1' });
    expect(reused).toMatchObject({ ok: false, code: 'invalid' });
    expect(JSON.stringify(reused)).not.toContain('GUEST-WORDS');
    expect(w.post(guest)).toMatchObject({ ok: true, duplicate: true });
  });

  it('openCards leaves out a guest-sourced card, as find and read do', () => {
    const w = writer();
    const bot = { kind: 'bot' as const, workspaceId: 'ws1', botId: 'bot-0000aaaa' };
    expect(w.post({ workspaceId: 'ws1', kind: 'question', actor: bot, title: 'From a guest turn', state: 'open', origin: 'guest' })).toMatchObject({ ok: true });
    expect(w.post({ workspaceId: 'ws1', kind: 'question', actor: bot, title: 'Clean', state: 'open', origin: 'clean' })).toMatchObject({ ok: true });
    expect(w.openCards('ws1', new Set(['question'])).map((c) => c.title)).toEqual(['Clean']);
  });

  it('replyTo must name a card of the same thread', () => {
    const w = writer();
    const parent = w.append({ workspaceId: 'ws1', threadId: 'task:t1', kind: 'dispatch', actor: SYS, title: 'p' })!;
    expect(w.post({ workspaceId: 'ws1', threadId: 'task:t1', kind: 'status', actor: SYS, title: 'ok', replyTo: parent.id })).toMatchObject({ ok: true });
    expect(w.post({ workspaceId: 'ws1', threadId: 'general', kind: 'status', actor: SYS, title: 'x', replyTo: parent.id })).toMatchObject({ ok: false, code: 'reply_to' });
    expect(w.post({ workspaceId: 'ws1', threadId: 'task:t1', kind: 'status', actor: SYS, title: 'x', replyTo: 'c-missing' })).toMatchObject({ ok: false, code: 'reply_to' });
  });

  it('a state change keeps id and seq, persists and is pushed', () => {
    const pushed: RoomEventPayload[] = [];
    const w = writer({ emit: (p) => pushed.push(p) });
    const q = w.append({ workspaceId: 'ws1', threadId: 'task:t1', kind: 'question', actor: SYS, title: 'q', state: 'open' })!;
    expect(w.summary('ws1', 'task:t1').openQuestions).toBe(1);
    const closed = w.setState('ws1', q.id, 'resolved')!;
    expect(closed).toMatchObject({ id: q.id, seq: q.seq, state: 'resolved' });
    expect(w.setState('ws1', q.id, 'resolved')).toBeNull();
    expect(pushed.map((p) => p.card.state)).toEqual(['open', 'resolved']);
    expect(pushed[1].threadSummary.openQuestions).toBe(0);
    const again = writer();
    expect(again.read('ws1').cards).toHaveLength(1);
    expect(again.get('ws1', q.id)!.state).toBe('resolved');
  });

  it('drops expired closed cards on load but keeps open ones', () => {
    const w = writer();
    w.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'old' });
    w.append({ workspaceId: 'ws1', kind: 'question', actor: SYS, title: 'old open', state: 'open' });
    now += (ROOM_LIMITS.RETAIN_DAYS + 1) * 24 * 3600_000;
    const later = writer();
    expect(later.read('ws1').cards.map((c) => c.title)).toEqual(['old open']);
    // The seq mark and the one card left.
    expect(fs.readFileSync(path.join(dir, 'ws1.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('a room emptied by retention never reuses a seq, across restarts', () => {
    const w = writer();
    w.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'a' });
    w.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'b' });
    now += (ROOM_LIMITS.RETAIN_DAYS + 1) * 24 * 3600_000;
    expect(writer().read('ws1').cards).toEqual([]);
    expect(writer().append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'c' })!.seq).toBe(3);
  });

  it('a torn last line does not swallow the next card', () => {
    const w = writer();
    w.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'a' });
    fs.appendFileSync(path.join(dir, 'ws1.jsonl'), '{"version":1,"id":"torn');
    const again = writer();
    again.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'b' });
    expect(writer().read('ws1').cards.map((c) => c.title)).toEqual(['a', 'b']);
  });

  it('a card that cannot be stored is not written in memory either', () => {
    const w = writer();
    fs.mkdirSync(path.join(dir, 'ws1.jsonl'), { recursive: true });
    expect(w.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'a' })).toBeNull();
    expect(w.post({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 'a' })).toMatchObject({ ok: false });
    expect(w.read('ws1').cards).toEqual([]);
  });

  it('keeps at most maxCards, open ones first, and compacts superseded lines', () => {
    const w = writer({ limits: { maxCards: 3, compactSlack: 4 } });
    const open = w.append({ workspaceId: 'ws1', kind: 'question', actor: SYS, title: 'open', state: 'open' })!;
    for (let i = 0; i < 5; i += 1) w.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: `s${i}` });
    expect(w.read('ws1').cards.map((c) => c.title)).toEqual(['open', 's3', 's4']);
    expect(writer({ limits: { maxCards: 3 } }).read('ws1').cards.map((c) => c.id)).toContain(open.id);
    // Next seq never goes back after a cap.
    expect(w.append({ workspaceId: 'ws1', kind: 'status', actor: SYS, title: 's5' })!.seq).toBe(7);
  });

  it('skips torn and foreign lines on load', () => {
    fs.writeFileSync(path.join(dir, 'ws1.jsonl'), [
      '{not json',
      JSON.stringify({ version: 1, id: 'c-1', seq: 1, workspaceId: 'other', threadId: 'general', kind: 'status', at: now, actor: SYS, title: 'foreign' }),
      JSON.stringify({ version: 1, id: 'c-2', seq: 2, workspaceId: 'ws1', threadId: 'general', kind: 'status', at: now, actor: SYS, title: 'mine' }),
    ].join('\n'));
    expect(writer().read('ws1').cards.map((c) => c.title)).toEqual(['mine']);
    expect(parseCardLine({ version: 1, id: 'x', seq: 1, workspaceId: 'ws1', threadId: 'general', kind: 'nope', at: 1, actor: SYS, title: 't' }, 'ws1')).toBeNull();
  });
});

describe('thread summaries', () => {
  it('unread is null until a read position exists, then counts cards after it', () => {
    const w = writer();
    w.append({ workspaceId: 'ws1', threadId: 'task:t1', kind: 'status', actor: SYS, title: 'a' });
    const b = w.append({ workspaceId: 'ws1', threadId: 'task:t1', kind: 'status', actor: SYS, title: 'b' })!;
    w.append({ workspaceId: 'ws1', threadId: 'task:t1', kind: 'status', actor: SYS, title: 'c' });
    expect(w.summary('ws1', 'task:t1').unread).toBeNull();
    expect(w.markRead('ws1', 'task:t1', b.seq)).toBe(true);
    expect(w.summary('ws1', 'task:t1').unread).toBe(1);
    expect(w.markRead('ws1', 'task:t1', 1)).toBe(false);
    expect(writer().summary('ws1', 'task:t1').unread).toBe(1);
    // A thread position never moves another.
    expect(w.summary('ws1', 'general').unread).toBeNull();
  });

  it('status is derived: closed after a closing card with nothing open, quiet after QUIET_DAYS, else open', () => {
    const w = writer();
    w.append({ workspaceId: 'ws1', threadId: 'task:t1', kind: 'status', actor: SYS, title: 'working' });
    expect(w.summary('ws1', 'task:t1').status).toBe('open');
    w.append({ workspaceId: 'ws1', threadId: 'task:t1', kind: 'fact', actor: SYS, title: 'done', closes: true });
    expect(w.summary('ws1', 'task:t1').status).toBe('closed');
    const q = w.append({ workspaceId: 'ws1', threadId: 'task:t1', kind: 'question', actor: SYS, title: 'q', state: 'open' })!;
    expect(w.summary('ws1', 'task:t1').status).toBe('open');
    w.setState('ws1', q.id, 'resolved');
    w.append({ workspaceId: 'ws1', threadId: 'task:t2', kind: 'status', actor: SYS, title: 'other' });
    now += (ROOM_LIMITS.QUIET_DAYS + 1) * 24 * 3600_000;
    expect(w.summary('ws1', 'task:t2').status).toBe('quiet');
    const listed = Object.fromEntries(w.threads('ws1').map((t) => [t.threadId, t.status]));
    expect(listed).toEqual({ 'task:t1': 'closed', 'task:t2': 'quiet', general: 'open' });
    const order = w.threads('ws1').map((t) => t.threadId);
    expect(order[order.length - 1]).toBe('task:t1');
  });

  it('open questions sort first', () => {
    const w = writer();
    w.append({ workspaceId: 'ws1', threadId: 'task:a', kind: 'question', actor: SYS, title: 'q', state: 'open' });
    now += 1000;
    w.append({ workspaceId: 'ws1', threadId: 'task:b', kind: 'status', actor: SYS, title: 'newer' });
    expect(w.threads('ws1')[0]).toMatchObject({ threadId: 'task:a', openQuestions: 1 });
  });
});

describe('facts → system cards', () => {
  const bots = directory([bot('bot-00000001', 'ws1', 'lead', 'github.com/acme/app'), bot('bot-00000002', 'ws2', 'verifier', 'Acme/App')]);

  it('writes the card kind each fact kind maps to, in the right thread', () => {
    const cases: Array<[FactKind, Partial<Fact>, string, string, boolean]> = [
      ['handoff.received', { workspaceId: 'ws1', ref: { handoffId: 'h-1', botId: 'bot-00000001' }, payload: { handoffKind: 'dispatch', title: 'do it', threadId: 'handoff:h-1', toWorkspaceId: 'ws1' } }, 'fact', 'handoff:h-1', false],
      ['handoff.received', { workspaceId: 'ws1', ref: { handoffId: 'h-2' }, payload: { handoffKind: 'answer', title: 'q?', answer: 'yes', threadId: 'task:t1', toWorkspaceId: 'ws1' } }, 'fact', 'task:t1', false],
      ['handoff.refused', { workspaceId: 'ws1', ref: { handoffId: 'h-3' }, payload: { handoffKind: 'dispatch', title: 'x', code: 'max_depth', detail: 'too deep', threadId: 'handoff:h-3', fromWorkspaceId: 'ws1' } }, 'refusal', 'handoff:h-3', false],
      ['task.done', { workspaceId: 'ws1', ref: { taskId: 'wt-1' }, payload: { title: 'fix', summary: 'done', gateExit: 0 } }, 'fact', 'task:wt-1', true],
      ['task.failed', { workspaceId: 'ws1', ref: { taskId: 'wt-2' }, payload: { title: 'fix' } }, 'fact', 'task:wt-2', false],
      ['task.input_required', { workspaceId: 'ws1', ref: { taskId: 'wt-3' }, payload: { title: 'fix' } }, 'fact', 'task:wt-3', false],
      // A task started from an issue / PR wake reports in that thread, and its end does not close it.
      ['task.done', { workspaceId: 'ws1', ref: { taskId: 'wt-4' }, payload: { title: 'repro', threadId: 'issue:github.com/acme/app#21' } }, 'fact', 'issue:github.com/acme/app#21', false],
      ['task.failed', { workspaceId: 'ws1', ref: { taskId: 'wt-5' }, payload: { title: 'verify', threadId: 'pr:Acme/App#4' } }, 'fact', 'pr:github.com/acme/app#4', false],
      // Its own task thread named explicitly still closes; another task's thread does not.
      ['task.done', { workspaceId: 'ws1', ref: { taskId: 'wt-6' }, payload: { title: 'x', threadId: 'task:wt-6' } }, 'fact', 'task:wt-6', true],
      ['task.done', { workspaceId: 'ws1', ref: { taskId: 'wt-7' }, payload: { title: 'x', threadId: 'task:wt-1' } }, 'fact', 'task:wt-1', false],
      // general or a value that is no thread: the task's own thread.
      ['task.done', { workspaceId: 'ws1', ref: { taskId: 'wt-8' }, payload: { title: 'x', threadId: 'general' } }, 'fact', 'task:wt-8', true],
      ['task.input_required', { workspaceId: 'ws1', ref: { taskId: 'wt-9' }, payload: { title: 'x', threadId: 'nope:1' } }, 'fact', 'task:wt-9', false],
      ['verdict.recorded', { workspaceId: 'ws1', repoKey: 'github.com/acme/app', ref: { pr: 4, headSha: 'abcdef1234', botId: 'bot-00000002' }, payload: { verdict: 'pass' } }, 'fact', 'pr:github.com/acme/app#4', false],
      ['merge.done', { repoKey: 'github.com/acme/app', ref: { pr: 4, headSha: 'abcdef1234' }, payload: {} }, 'fact', 'pr:github.com/acme/app#4', true],
      ['merge.refused', { repoKey: 'github.com/acme/app', ref: { pr: 4, headSha: 'abcdef1234' }, payload: { reason: 'no-required-checks' } }, 'refusal', 'pr:github.com/acme/app#4', false],
      ['pr.merged', { repoKey: 'github.com/acme/app', ref: { pr: 5 }, payload: {} }, 'fact', 'pr:github.com/acme/app#5', true],
      ['issue.closed', { repoKey: 'github.com/acme/app', ref: { issue: 9 }, payload: {} }, 'fact', 'issue:github.com/acme/app#9', true],
      ['bot.refused', { workspaceId: 'ws1', ref: { botId: 'bot-00000001', method: 'terminal.send' }, payload: { reason: 'surface' } }, 'refusal', 'general', false],
      ['bot.budget_exhausted', { workspaceId: 'ws1', ref: { botId: 'bot-00000001' }, payload: { reason: 'turns_hour' } }, 'budget', 'general', false],
    ];
    for (const [kind, extra, cardKind, thread, closes] of cases) {
      const w = writer();
      const cards = writeFactCards(w, fact(kind, extra), bots);
      expect(cards.length, kind).toBeGreaterThan(0);
      expect(cards[0], kind).toMatchObject({ kind: cardKind, threadId: thread, actor: SYS });
      expect(cards[0].closes === true, kind).toBe(closes);
      expect(cards[0].refs?.factId, kind).toBeDefined();
    }
  });

  it('a merge.refused card says each lane reason in plain words, never a raw code', () => {
    const reason = 'required-checks-green:no-required-checks, not-release-pr:no-files, gate-definition-changed:no-files, author-trusted:external-author, weird:new-code';
    const card = systemCardForFact(fact('merge.refused', { repoKey: 'github.com/acme/app', ref: { pr: 4, headSha: 'abcdef1234' }, payload: { approvedBy: 'lane', reason } }), bots);
    expect(card?.body).toBe([
      '- The repository has no required checks',
      '- GitHub listed no changed files',
      '- The author isn\'t trusted',
      '- Another merge check did not pass',
    ].join('\n'));
    // Held by the lane host (auto-merge off): no card from the fact.
    expect(systemCardForFact(fact('merge.refused', { repoKey: 'github.com/acme/app', ref: { pr: 4, headSha: 'abcdef1234' }, payload: { approvedBy: 'lane', reason, cardHeld: true } }), bots)).toBeNull();
    expect(card?.title).toBe('Merge refused for #4 at abcdef1');
    const bare = systemCardForFact(fact('merge.refused', { repoKey: 'github.com/acme/app', ref: { pr: 4, headSha: 'abcdef1234' }, payload: {} }), bots);
    expect(bare?.body).toBeUndefined();
  });

  it('shows no card for PR / CI edges and human messages', () => {
    for (const kind of ['pr.opened', 'ci.green', 'ci.failed', 'issue.opened', 'human.message', 'schedule.fired'] as FactKind[]) {
      expect(systemCardForFact(fact(kind, { workspaceId: 'ws1' }), bots), kind).toBeNull();
    }
  });

  it('a repo-only fact lands in every workspace with a bot on that repo (keys normalized)', () => {
    expect(factRooms(fact('merge.done', { repoKey: 'github.com/acme/app', ref: { pr: 1 } }), bots).sort()).toEqual(['ws1', 'ws2']);
    expect(factRooms(fact('merge.done', { repoKey: 'github.com/other/x', ref: { pr: 1 } }), bots)).toEqual([]);
    expect(factRooms(fact('task.done', { workspaceId: 'ws9' }), bots)).toEqual(['ws9']);
  });

  it('a cross-workspace handoff shows in both rooms', () => {
    const w = writer();
    writeFactCards(w, fact('handoff.received', { workspaceId: 'ws2', ref: { handoffId: 'h-9' }, payload: { handoffKind: 'dispatch', title: 'x', threadId: 'handoff:h-9', toWorkspaceId: 'ws2', fromWorkspaceId: 'hq' } }), bots);
    expect(w.read('ws2').cards).toHaveLength(1);
    expect(w.read('hq').cards).toHaveLength(1);
  });

  it('the cards of a fact not known clean of a guest\'s words are guest-sourced: kept out of a clean read, across a reload', () => {
    const w = writer();
    setFactGuestProbe((f) => f.ref?.handoffId === 'h-guest');
    try {
      const payload = { handoffKind: 'answer', title: 'GUEST-TITLE', answer: 'GUEST-ANSWER', threadId: 'general', toWorkspaceId: 'ws1' };
      writeFactCards(w, fact('handoff.received', { workspaceId: 'ws1', ref: { handoffId: 'h-guest' }, payload }), bots);
      writeFactCards(w, fact('handoff.received', { workspaceId: 'ws1', ref: { handoffId: 'h-clean' }, payload: { ...payload, title: 'clean', answer: 'fine' } }), bots);
    } finally {
      setFactGuestProbe(null);
    }
    expect(w.read('ws1', { guests: true }).cards.map((c) => [c.title.includes('GUEST-TITLE'), c.origin])).toEqual([[true, 'guest'], [false, undefined]]);
    const clean = JSON.stringify(w.read('ws1').cards);
    expect(clean).not.toContain('GUEST-');
    expect(clean).toContain('fine');
    const reloaded = writer();
    expect(JSON.stringify(reloaded.read('ws1').cards)).not.toContain('GUEST-');
    expect(reloaded.read('ws1', { guests: true }).cards[0]?.origin).toBe('guest');
  });

  it('where the probes are expected but missing, bot and fact cards are stamped guest-sourced; a caller\'s captured clean is kept', () => {
    const w = writer();
    const botActor = { kind: 'bot' as const, workspaceId: 'ws1', botId: 'bot-00000001' };
    expectGuestProbes();
    try {
      w.append({ workspaceId: 'ws1', kind: 'status', actor: botActor, title: 'NO-PROBE' });
      writeFactCards(w, fact('handoff.received', { workspaceId: 'ws1', ref: { handoffId: 'h-x' }, payload: { handoffKind: 'dispatch', title: 'NO-PROBE-FACT', threadId: 'general', toWorkspaceId: 'ws1' } }), bots);
    } finally {
      expectGuestProbes(false);
    }
    expect(JSON.stringify(w.read('ws1').cards)).not.toContain('NO-PROBE');
    setGuestTurnProbe(() => true);
    try {
      w.append({ workspaceId: 'ws1', kind: 'status', actor: botActor, title: 'CAPTURED-CLEAN', origin: 'clean' });
      w.append({ workspaceId: 'ws1', kind: 'status', actor: botActor, title: 'IN-GUEST-WAKE' });
    } finally {
      setGuestTurnProbe(null);
    }
    const clean = w.read('ws1').cards;
    expect(clean.map((c) => c.title)).toEqual(['CAPTURED-CLEAN']);
    expect(clean[0]).not.toHaveProperty('origin');
  });

  it('a delivered room mention writes no line; a plain message does, and a refused mention writes a refusal card', () => {
    const w = writer();
    const payload = { handoffKind: 'message', title: 'x', threadId: 'general', toWorkspaceId: 'ws1', fromWorkspaceId: 'ws1', mention: true };
    writeFactCards(w, fact('handoff.received', { workspaceId: 'ws1', ref: { handoffId: 'h-m' }, payload }), bots);
    expect(w.read('ws1').cards).toHaveLength(0);
    writeFactCards(w, fact('handoff.refused', { workspaceId: 'ws1', ref: { handoffId: 'h-m2' }, payload: { ...payload, code: 'max_depth', detail: 'too deep' } }), bots);
    expect(w.read('ws1').cards.map((c) => c.kind)).toEqual(['refusal']);
    writeFactCards(w, fact('handoff.received', { workspaceId: 'ws1', ref: { handoffId: 'h-p' }, payload: { ...payload, mention: undefined } }), bots);
    expect(w.read('ws1').cards.map((c) => c.kind)).toEqual(['refusal', 'fact']);
  });

  it('refs keep the addressed bots (bot ids only, distinct, capped) and a routine id', () => {
    const ids = Array.from({ length: ROOM_LIMITS.MENTIONS_MAX + 2 }, (_, i) => `bot-${String(i).padStart(8, '0')}`);
    expect(sanitizeRefs({ botIds: ['bot-0000000a', 'nope', 'bot-0000000a', 7], routineId: 'r-abcdefgh' })).toEqual({ botIds: ['bot-0000000a'], routineId: 'r-abcdefgh' });
    expect(sanitizeRefs({ botIds: ids })?.botIds).toHaveLength(ROOM_LIMITS.MENTIONS_MAX);
    expect(sanitizeRefs({ botIds: 'bot-0000000a' })).toBeUndefined();
    expect(sanitizeRefs({ botIds: [] })).toBeUndefined();
  });

  it('the same fact delivered twice writes one card', () => {
    const w = writer();
    const f = fact('task.done', { workspaceId: 'ws1', ref: { taskId: 'wt-1' }, payload: { title: 't' } });
    writeFactCards(w, f, bots);
    writeFactCards(w, f, bots);
    expect(w.read('ws1').cards).toHaveLength(1);
    writeFactCards(writer(), f, bots);
    expect(writer().read('ws1').cards).toHaveLength(1);
  });

  it('an interrupted wake writes a card in the bot\'s room', () => {
    const w = writer();
    const card = writeInterruptedWakeCard(w, { type: 'wake.interrupted', botId: 'bot-00000001', workspaceId: 'ws1', wakeId: 'w1', at: now }, bots) as RoomCard;
    expect(card).toMatchObject({ kind: 'fact', threadId: 'general', refs: { botId: 'bot-00000001' } });
    expect(card.title).toMatch(/interrupted/);
    expect(writeInterruptedWakeCard(w, { type: 'bot.error', botId: 'b', workspaceId: 'ws1' }, bots)).toBeNull();
  });

  it('an interrupted wake\'s card lands in the thread the wake was pinned to', () => {
    const w = writer();
    const card = writeInterruptedWakeCard(w, { type: 'wake.interrupted', botId: 'bot-00000001', workspaceId: 'ws1', wakeId: 'w1', threadId: 'task:long', at: now }, bots) as RoomCard;
    expect(card).toMatchObject({ kind: 'fact', threadId: 'task:long' });
    expect(w.read('ws1', { threadId: 'general' }).cards).toHaveLength(0);
  });

  it('a task card carries a notice code; a cancelled task reads Cancelled (stopped by owner when the owner\'s stop did it), never Failed', () => {
    expect(STOPPED_BY_OWNER).toBe('stopped by owner');
    const w = writer();
    const one = (id: string, kind: FactKind, payload: Record<string, unknown>) =>
      writeFactCards(w, fact(kind, { id, workspaceId: 'ws1', ref: { taskId: `wt-${id}` }, payload: { title: 'fix login', ...payload } }), bots)[0];
    expect(one('a', 'task.done', {})).toMatchObject({ title: 'Task done: fix login', notice: { code: 'task.done', args: { title: 'fix login' } } });
    expect(one('a2', 'task.done', { status: 'completed' })).toMatchObject({ notice: { code: 'task.done' } });
    // A worker that reported waits on review: not done.
    expect(one('r', 'task.done', { status: 'review_requested' })).toMatchObject({ title: 'Task reported · in review: fix login', notice: { code: 'task.reported', args: { title: 'fix login' } } });
    expect(one('b', 'task.failed', { status: 'failed', summary: 'tests red' })).toMatchObject({ title: 'Task failed: fix login', body: 'tests red', notice: { code: 'task.failed' } });
    const stopped = one('c', 'task.failed', { status: 'cancelled', by: 'system', summary: STOPPED_BY_OWNER });
    expect(stopped).toMatchObject({ title: 'Task cancelled · stopped by owner: fix login', notice: { code: 'task.stoppedByOwner', args: { title: 'fix login' } } });
    expect(stopped).not.toHaveProperty('body');
    expect(one('d', 'task.failed', { status: 'cancelled', by: 'bot', summary: 'not needed' })).toMatchObject({ title: 'Task cancelled: fix login', body: 'not needed', notice: { code: 'task.cancelled' } });
    expect(one('e', 'task.input_required', {})).toMatchObject({ title: 'Task needs input: fix login', notice: { code: 'task.inputRequired' } });
  });

  it('a budget card says which limit and when the bot picks up again, in words and as a notice; an unknown limit keeps no notice', () => {
    const w = writer();
    const until = now + 42 * 60_000;
    const [card] = writeFactCards(w, fact('bot.budget_exhausted', { workspaceId: 'ws1', ref: { botId: 'bot-00000001' }, payload: { reason: 'turns_hour', until } }), bots);
    expect(card.title).toMatch(/ is out of turns for this hour; it picks up again at \d\d:\d\d$/);
    expect(card.title).not.toContain('turns_hour');
    expect(card.notice).toEqual({ code: 'budget.exhausted', args: { bot: expect.any(String), limit: 'turns_hour', until } });
    const [workers] = writeFactCards(w, fact('bot.budget_exhausted', { id: 'f-w', workspaceId: 'ws1', ref: { botId: 'bot-00000001' }, payload: { reason: 'concurrent_workers' } }), bots);
    expect(workers.title).toMatch(/ is running as many workers as it may at once$/);
    expect(workers.notice).toEqual({ code: 'budget.exhausted', args: { bot: expect.any(String), limit: 'concurrent_workers' } });
    const [odd] = writeFactCards(w, fact('bot.budget_exhausted', { id: 'f-o', workspaceId: 'ws1', ref: { botId: 'bot-00000001' }, payload: { reason: 'something_new' } }), bots);
    expect(odd.title).toMatch(/ is out of budget$/);
    expect(odd).not.toHaveProperty('notice');
  });

  it('a full worker slot is a card saying the bot waits for a slot, not a budget card', () => {
    const w = writer();
    const [own] = writeFactCards(w, fact('bot.workers_full', { id: 'f-s1', workspaceId: 'ws1', ref: { botId: 'bot-00000001' }, payload: { scope: 'bot', running: 2, limit: 2, held: true } }), bots);
    expect(own.kind).toBe('fact');
    expect(own.title).toMatch(/ is waiting for a worker slot: 2 of its 2 are in use$/);
    expect(own.body).toMatch(/not a budget limit/);
    expect(own.notice).toEqual({ code: 'workers.full', args: { bot: expect.any(String), scope: 'bot', inUse: 2, cap: 2, held: 1 } });
    const [factory] = writeFactCards(w, fact('bot.workers_full', { id: 'f-s2', workspaceId: 'ws1', ref: { botId: 'bot-00000001' }, payload: { scope: 'factory', running: 3, limit: 3, held: true } }), bots);
    expect(factory.title).toMatch(/ is waiting for a worker slot: the bots use 3 of 3$/);
    const [wmux] = writeFactCards(w, fact('bot.workers_full', { id: 'f-s4', workspaceId: 'ws1', ref: { botId: 'bot-00000001' }, payload: { scope: 'wmux', running: 8, limit: 8, held: true } }), bots);
    expect(wmux.title).toMatch(/ is waiting: all 8 tasks that can run at once are in use \(including yours\)$/);
    expect(wmux.body).toBe('It will start automatically when one finishes. This is not a budget limit.');
    expect(wmux.notice).toEqual({ code: 'workers.full', args: { bot: expect.any(String), scope: 'wmux', inUse: 8, cap: 8, held: 1 } });
    // Refused unheld (a batch larger than the bot's slots): nothing starts by
    // itself, so the card promises nothing.
    const [unheld] = writeFactCards(w, fact('bot.workers_full', { id: 'f-s5', workspaceId: 'ws1', ref: { botId: 'bot-00000001' }, payload: { scope: 'wmux', running: 8, limit: 8, held: false } }), bots);
    expect(`${unheld.title} ${unheld.body}`).not.toMatch(/automatically/);
    expect(unheld.notice).toEqual({ code: 'workers.full', args: { bot: expect.any(String), scope: 'wmux', inUse: 8, cap: 8 } });
    // No worker slots at all (the first run's bot): nothing waits or starts by itself.
    const [off] = writeFactCards(w, fact('bot.workers_full', { id: 'f-s6', workspaceId: 'ws1', ref: { botId: 'bot-00000001' }, payload: { scope: 'bot', running: 0, limit: 0, held: false } }), bots);
    expect(off.title).toMatch(/ started no workers: its worker limit is 0$/);
    expect(off.body).toBe('Nothing was started, pushed or opened as a pull request. Allow workers in its settings, then ask it again.');
    expect(off.notice).toEqual({ code: 'workers.off', args: { bot: expect.any(String) } });
    expect(writeFactCards(w, fact('bot.workers_full', { id: 'f-s3', workspaceId: 'ws1', ref: { botId: 'bot-00000001' }, payload: { scope: 'elsewhere', running: 1, limit: 1 } }), bots)).toEqual([]);
  });

  it('a bot.error at the usage limit says when the bot picks up, with a notice code; a plain error has its own', () => {
    const w = writer();
    const until = now + 3 * 3_600_000;
    const msg = "You've hit your session limit · resets 1pm (Asia/Seoul)";
    const [limit] = writeFactCards(w, fact('bot.error', { workspaceId: 'ws1', ref: { botId: 'bot-00000001' }, payload: { message: msg, until } }), bots);
    expect(limit.title).toMatch(/ hit its usage limit; it picks up again at /);
    expect(limit.body).toBe(msg);
    expect(limit.notice).toEqual({ code: 'bot.usageLimit', args: { bot: expect.any(String), until } });
    const [plain] = writeFactCards(w, fact('bot.error', { id: 'f-e', workspaceId: 'ws1', ref: { botId: 'bot-00000001' }, payload: { message: 'boom' } }), bots);
    expect(plain.title).toMatch(/ hit an error$/);
    expect(plain.body).toBe('boom');
    expect(plain.notice).toEqual({ code: 'bot.error', args: { bot: expect.any(String) } });
  });

  it('PR, verdict and hop cards keep their English titles and carry a notice the reader\'s language words', () => {
    const w = writer();
    const [merged] = writeFactCards(w, fact('pr.merged', { workspaceId: 'ws1', ref: { pr: 5 }, payload: { title: 'Fix login' } }), bots);
    expect(merged).toMatchObject({ title: 'PR #5 merged: Fix login', notice: { code: 'pr.merged', args: { pr: 5, title: 'Fix login' } } });
    const [closed] = writeFactCards(w, fact('pr.closed', { workspaceId: 'ws1', ref: { pr: 6 }, payload: {} }), bots);
    expect(closed).toMatchObject({ title: 'PR #6 closed', notice: { code: 'pr.closed', args: { pr: 6 } } });
    const [verdict] = writeFactCards(w, fact('verdict.recorded', { workspaceId: 'ws1', ref: { pr: 4, headSha: 'abcdef1234', botId: 'bot-00000002' }, payload: { verdict: 'fail', summary: 'tests red' } }), bots);
    expect(verdict).toMatchObject({ title: 'Verdict fail for #4 at abcdef1 by verifier', body: 'tests red', notice: { code: 'verdict.recorded', args: { verdict: 'fail', pr: 4, sha: 'abcdef1', bot: 'verifier' } } });
    const hop = (id: string, payload: Record<string, unknown>, botId: string | null = 'bot-00000001') =>
      writeFactCards(w, fact('handoff.received', { workspaceId: 'ws1', ref: { handoffId: id, ...(botId ? { botId } : {}) }, payload: { title: 'add login', threadId: 'general', toWorkspaceId: 'ws1', toLabel: '구현', ...payload } }), bots)[0];
    expect(hop('h1', { handoffKind: 'dispatch' })).toMatchObject({ title: 'dispatch → 구현: add login', notice: { code: 'handoff.sent', args: { hop: 'dispatch', to: '구현', title: 'add login' } } });
    expect(hop('h2', { handoffKind: 'result', relay: true })).toMatchObject({ title: 'result → 구현: add login (forwarded by wmux)', notice: { code: 'handoff.sent', args: { hop: 'result', relay: 1 } } });
    expect(hop('h3', { handoffKind: 'answer', answer: 'yes' })).toMatchObject({ title: 'Answered → 구현: add login', body: 'yes', notice: { code: 'handoff.sent', args: { hop: 'answer', to: '구현', title: 'add login' } } });
    // To the owner (no addressed bot): the English stays.
    expect(hop('h4', { handoffKind: 'ask_person', toLabel: 'the owner' }, null)).not.toHaveProperty('notice');
  });

  it('a held owner message gets one status card in its thread, across repeats and a restart', () => {
    const w = writer();
    const until = now + 30 * 60_000;
    const ev = { type: 'wake.held' as const, botId: 'bot-00000001', workspaceId: 'ws1', wakeId: 'w9', threadId: 'issue:github.com/acme/app#3' as const, until, at: now };
    const card = writeBotHookCard(w, ev, bots) as RoomCard;
    expect(card).toMatchObject({ kind: 'budget', threadId: 'issue:github.com/acme/app#3', actor: { kind: 'system' }, refs: { botId: 'bot-00000001' } });
    expect(card.title).toMatch(/^Queued: .+ is out of turns until \d\d:\d\d; resume it in its profile$/);
    expect(card.notice).toEqual({ code: 'budget.held', args: { bot: expect.any(String), until } });
    expect(writeBotHookCard(w, ev, bots)).toBeNull();
    expect(writeBotHookCard(writer(), ev, bots)).toBeNull();
    expect(w.read('ws1', { threadId: 'issue:github.com/acme/app#3' }).cards.filter((c) => c.kind === 'budget')).toHaveLength(1);
    // Another held message is its own card; no time when the budget does not free by itself.
    const other = writeBotHookCard(w, { ...ev, wakeId: 'w10', threadId: undefined, until: null }, bots) as RoomCard;
    expect(other).toMatchObject({ threadId: 'general' });
    expect(other.title).toMatch(/^Queued: .+ is out of turns; resume it in its profile$/);
    expect(other.notice?.args).not.toHaveProperty('until');
    // The same seam still writes the interrupted card.
    expect(writeBotHookCard(w, { type: 'wake.interrupted', botId: 'bot-00000001', workspaceId: 'ws1', wakeId: 'w1', at: now }, bots)?.title).toMatch(/interrupted/);
  });

  it('formatHeldUntil: the time today, the date and time on another day', () => {
    const base = new Date(2026, 9, 13, 9, 0).getTime();
    expect(formatHeldUntil(new Date(2026, 9, 13, 14, 5).getTime(), base)).toBe('14:05');
    expect(formatHeldUntil(new Date(2026, 9, 14, 8, 30).getTime(), base)).toBe('Oct 14 08:30');
  });
});

describe('WakeOrdinals', () => {
  it('numbers posts and handoffs per wake attempt; a retried attempt reuses the keys', () => {
    const o = new WakeOrdinals();
    const w1 = { wakeId: 'w1', attempt: 1 };
    expect([o.next(w1, 'post'), o.next(w1, 'post'), o.next(w1, 'handoff')]).toEqual(['wake:w1:1', 'wake:w1:2', 'wake:w1:h1']);
    expect(o.next({ wakeId: 'w1', attempt: 2 }, 'post')).toBe('wake:w1:1');
    expect(o.next(null, 'post')).toBeUndefined();
  });
});

describe('shared bot surface cards on disk', () => {
  it('keeps the new card kinds, refs and a job change across a reload, and drops malformed parts', () => {
    const w = writer();
    const job = w.append({
      workspaceId: 'ws-1', kind: 'job_changed', actor: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-0a1b2c3d' }, title: 'job changed',
      refs: { botId: 'bot-0a1b2c3d', botIds: ['bot-0a1b2c3d', 'nope', 'bot-0a1b2c3d'] },
      jobChange: { botId: 'bot-0a1b2c3d', previous: null, next: 'Fix issues.' },
    });
    expect(job).toMatchObject({ kind: 'job_changed', refs: { botIds: ['bot-0a1b2c3d'] }, jobChange: { previous: null, next: 'Fix issues.' } });
    for (const kind of ['approval', 'routine', 'secret_request', 'login_request'] as const) {
      expect(w.append({ workspaceId: 'ws-1', kind, actor: { kind: 'system' }, title: kind, refs: { approvalId: 'apr-12345678', routineId: 'r-12345678', secretName: 'NPM_TOKEN' } })?.kind).toBe(kind);
    }
    // A secret ref must be a credential-shaped name; a job change rides only on its own kind.
    expect(w.append({ workspaceId: 'ws-1', kind: 'status', actor: { kind: 'system' }, title: 'x', refs: { secretName: 'PATH' }, jobChange: { botId: 'bot-0a1b2c3d', previous: null, next: 'x' } }))
      .not.toHaveProperty('jobChange');
    const again = writer();
    const cards = again.read('ws-1').cards;
    expect(cards.map((c) => c.kind)).toEqual(['job_changed', 'approval', 'routine', 'secret_request', 'login_request', 'status']);
    expect(cards[0].jobChange).toEqual({ botId: 'bot-0a1b2c3d', previous: null, next: 'Fix issues.' });
    expect(cards[3].refs).toMatchObject({ secretName: 'NPM_TOKEN', approvalId: 'apr-12345678' });
    expect(cards[5].refs).toBeUndefined();
    expect(parseCardLine({ ...cards[0], jobChange: { botId: 'x', previous: null, next: 'y' } }, 'ws-1')?.jobChange).toBeUndefined();
    expect(parseCardLine({ ...cards[0], jobChange: { botId: 'bot-0a1b2c3d', previous: 'a\u0000b', next: null } }, 'ws-1')?.jobChange).toBeUndefined();
  });
});

describe('card fields for owner requests and worker notices', () => {
  it('an approval card links its subject thread; a greeting question is marked; both survive a reload, malformed ones do not', () => {
    const w = writer();
    const appr = w.append({ workspaceId: 'ws-1', kind: 'approval', actor: { kind: 'system' }, title: 'Merge PR #1?', refs: { approvalId: 'apr-12345678', threadId: 'pr:Acme/App#1' as never } });
    expect(appr?.refs?.threadId).toBe('pr:github.com/acme/app#1');
    expect(sanitizeRefs({ threadId: 'not a thread' })).toBeUndefined();
    const greet = w.append({ workspaceId: 'ws-1', kind: 'question', actor: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-0a1b2c3d' }, title: 'What should I do?', state: 'open', greeting: true });
    expect(greet?.greeting).toBe(true);
    // Only a question can be a greeting.
    expect(w.append({ workspaceId: 'ws-1', kind: 'status', actor: { kind: 'system' }, title: 'x', greeting: true })).not.toHaveProperty('greeting');
    const cards = writer().read('ws-1').cards;
    expect(cards[0].refs?.threadId).toBe('pr:github.com/acme/app#1');
    expect(cards[1].greeting).toBe(true);
    expect(parseCardLine({ ...cards[1], kind: 'status' }, 'ws-1')).not.toHaveProperty('greeting');
  });

  it('a bot.notice is a card only when main says so', () => {
    const notice = (payload: Record<string, unknown>) => ({ id: 'f-1', seq: 1, kind: 'bot.notice' as const, at: 1, dedupeKey: 'k', workspaceId: 'ws-1', ref: { botId: 'bot-0a1b2c3d', messageId: 'm' }, payload });
    expect(systemCardForFact(notice({ topic: 'pr.merged', title: 'PR #1 merged.' }))).toBeNull();
    expect(systemCardForFact(notice({ topic: 'worker.started', title: 'started', card: true, threadId: 'task:wtask-1' }))).toMatchObject({ kind: 'fact', threadId: 'task:wtask-1', workspaces: ['ws-1'] });
    expect(systemCardForFact({ ...notice({ topic: 'worker.start_failed', title: 't', card: true }), workspaceId: undefined })).toBeNull();
    // main's code for it rides along; a malformed one is dropped.
    const failed = notice({ topic: 'worker.start_failed', title: 'Worker for "x" could not start: its setup failed', card: true, notice: { code: 'worker.startFailed', args: { title: 'x', cause: 'setup' } } });
    expect(systemCardForFact(failed)).toMatchObject({ kind: 'refusal', notice: { code: 'worker.startFailed', args: { title: 'x', cause: 'setup' } } });
    expect(systemCardForFact(notice({ topic: 'worker.start_failed', title: 't', card: true, notice: { code: 'Not A Code' } }))).not.toHaveProperty('notice');
  });
});

describe('inputRequiredWhy (#2231)', () => {
  it('knows the summaries wmux writes, and nothing else', async () => {
    const { inputRequiredWhy } = await import('../roomWriter');
    expect(inputRequiredWhy("worker is waiting on Claude Code's workspace trust dialog; it needs a keypress in the pane")).toBe('trustDialog');
    expect(inputRequiredWhy("worker is waiting on Claude Code's codex folder trust dialog; it needs a keypress in the pane")).toBe('trustDialog');
    expect(inputRequiredWhy("worker is waiting on Claude Code's auto-mode onboarding; it needs a keypress in the pane")).toBe('firstRun');
    expect(inputRequiredWhy("launch failed: no agent started in pane daemon-70a64bc2 within 45s, so the pane sits at its shell prompt; re-run the task's launch line in that pane (the fan-out result carries it)")).toBe('launchFailed');
    expect(inputRequiredWhy('I need the staging API key')).toBeNull();
  });
});


describe('RoomWriter — external guests\' cards', () => {
  it('read and find leave guest cards out unless asked; paging still advances past them', () => {
    const w = writer();
    w.append({ workspaceId: 'ws', threadId: 'general', kind: 'human', actor: { kind: 'human' }, title: 'one' });
    w.append({ workspaceId: 'ws', threadId: 'general', kind: 'guest', actor: SYS, title: 'External guest: G', body: 'x', guest: { guestId: '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b', name: 'G' } });
    w.append({ workspaceId: 'ws', threadId: 'general', kind: 'human', actor: { kind: 'human' }, title: 'three' });
    expect(w.read('ws').cards.map((c) => c.title)).toEqual(['one', 'three']);
    expect(w.read('ws', { guests: true }).cards.map((c) => c.kind)).toEqual(['human', 'guest', 'human']);
    expect(w.read('ws', { sinceSeq: 1, limit: 1 })).toMatchObject({ cards: [{ title: 'three' }], hasMore: false });
    expect(w.find('ws', (c) => c.kind === 'guest')).toBeNull();
    expect(w.find('ws', (c) => c.kind === 'guest', { guests: true })?.title).toBe('External guest: G');
  });
});
