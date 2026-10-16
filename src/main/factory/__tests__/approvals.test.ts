// Owner approvals: main writes every request from its own reads; only the
// owner (main window, phone, or the owner's own typed words in the thread)
// or a remembered rule approves; an approved merge waits out its Undo window
// and the executor asks again at run time.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotBinding, BotProfile } from '../../../shared/bot';
import { APPROVAL_UNDO_MS, BOT_APPROVAL_RPC } from '../../../shared/botApproval';
import type { Fact, FactDraft } from '../../../shared/facts';
import type { MergeEffect } from '../../../shared/moaDecision';
import type { PrLaneFacts } from '../../../shared/prReview';
import type { RpcContext } from '../../../shared/rpc';
import { ApprovalService, registerApprovalRpc, ruleCovers, typedApprovalSourceAllowed, typedApprovalTargets, withoutOwnerQuotes, type ApprovalMergeHost, type ApprovalPorts, type ApprovalWake, type StoredApproval } from '../approvals';
import type { BotNoticeInput } from '../botNotices';
import { RoomWriter } from '../roomWriter';
import { registeredFactoryModules } from '../factoryHost';

const KEY = 'github.com/o/r';
const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const WS = 'ws-1';

const bot = (id: string, over: Partial<BotProfile> = {}): BotProfile => ({
  version: 1, id, workspaceId: WS, role: 'lead', name: `Bot ${id}`, engine: { kind: 'claude-sdk' }, triggers: [],
  budget: { maxTurnsPerDay: 9, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 } as BotProfile['budget'],
  repo: { repoKey: 'o/r', repoPath: '/repo' }, enabled: true, createdAt: 0, updatedAt: 0, ...over,
});
const DEV = bot('bot-0000dev1');
const OTHER = bot('bot-0000oth1');
const binding = (b: BotProfile): BotBinding => ({ workspaceId: b.workspaceId, botId: b.id, role: 'lead' });

const facts = (n: number, head = HEAD): PrLaneFacts => ({
  number: n, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefOid: head, headRefName: `wtask/x-${n}`, baseRefName: 'main',
  author: 'owner', mergedAt: null, mergeCommitOid: null, labels: [], labelsTruncated: false, files: ['a.ts'], filesTruncated: false,
  checksHeadOid: head, checks: [], checksTruncated: false,
});

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-approvals-')); });
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function rig(over: Partial<ApprovalPorts> = {}) {
  const writer = new RoomWriter({ dir: path.join(dir, 'rooms') });
  const state = {
    now: 1_000_000,
    wakes: new Map<string, ApprovalWake>([[DEV.id, { wakeId: 'w-1', attempt: 1, threadId: null, tainted: false }], [OTHER.id, { wakeId: 'w-9', attempt: 1, threadId: null, tainted: false }]]),
    heads: new Map<number, string>([[1, HEAD], [2, HEAD]]),
    login: 'owner' as string | null,
    ruleCheck: null as string | null,
  };
  const facts_: FactDraft[] = [];
  const enqueued: Array<{ id: string; approvedBy: string }> = [];
  const host: ApprovalMergeHost = {
    enqueue: vi.fn(async (r: StoredApproval, approvedBy) => {
      enqueued.push({ id: r.requestId, approvedBy });
      return { id: `effect:${r.requestId}:pr.merge`, kind: 'pr.merge', decisionId: r.requestId, approvedBy, repoKey: r.repoKey, repoPath: r.repoPath, prNumber: r.prNumber as number, expectHead: r.headSha as string, status: 'pending', attempt: 0, createdAt: 1, updatedAt: 1 } as MergeEffect;
    }),
    run: vi.fn(async () => null),
    ruleCheck: vi.fn(async () => state.ruleCheck),
  };
  const ports: ApprovalPorts = {
    file: path.join(dir, 'factory', 'approvals.json'),
    bots: () => ({ listEnabled: () => [DEV, OTHER], get: (id) => [DEV, OTHER].find((b) => b.id === id) ?? null }),
    runningWake: (id) => state.wakes.get(id) ?? null,
    readPr: async (_p, _k, n) => {
      const h = state.heads.get(n);
      if (!h) throw new Error('no such PR');
      return facts(n, h);
    },
    ghLogin: async () => state.login,
    rooms: () => writer,
    merge: () => host,
    appendFact: (d) => {
      facts_.push(d);
      return null;
    },
    now: () => state.now,
    log: () => undefined,
    ...over,
  };
  const svc = new ApprovalService(ports);
  const ownerSays = (text: string, threadId?: string, to: string[] = [DEV.id], clientPostId?: string, lead = false) => {
    const r = writer.post({ workspaceId: WS, kind: 'human', actor: { kind: 'human' }, title: text, refs: { botId: to[0], ...(to.length > 1 ? { botIds: to } : {}) }, ...(threadId ? { threadId: threadId as never } : {}), ...(clientPostId ? { clientPostId } : {}) });
    if (!r.ok) throw new Error('post failed');
    svc.onFact({ id: 'f', seq: 1, kind: 'human.message', at: 1, dedupeKey: 'k', workspaceId: WS, ref: { messageId: r.card.id }, payload: { cardId: r.card.id, ...(lead ? { lead: true } : {}) } });
    return r.card;
  };
  const ask = async (b: BotProfile, params: Record<string, unknown>) => {
    const res = await svc.request(binding(b), params);
    if (!res.ok) throw new Error(`refused: ${res.code} ${res.message}`);
    return res.request;
  };
  return { svc, writer, state, host, enqueued, facts: facts_, ownerSays, ask, ports };
}

describe('approval requests (bot side)', () => {
  it('importing the store registers no factory module (the IPC handler imports it early; modules.ts orders the module)', () => {
    expect(registeredFactoryModules()).not.toContain('approvals');
  });

  it('main reads the repository, head, login, thread and taint; the bot names only the act', async () => {
    const r = rig();
    r.state.wakes.set(DEV.id, { wakeId: 'w-1', attempt: 1, threadId: 'task:t-1' as never, tainted: true });
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'CI green, verified', headSha: HEAD2, repoKey: 'evil/x', ghLogin: 'mallory', state: 'approved' });
    // The card goes where the owner talks with the bot (general before the
    // owner wrote to it), linking the PR's own thread.
    expect(req).toMatchObject({ action: 'merge', repoKey: KEY, prNumber: 1, headSha: HEAD, ghLogin: 'owner', botId: DEV.id, workspaceId: WS, threadId: 'general', tainted: true, state: 'pending' });
    const card = r.writer.get(WS, req.cardId as string);
    expect(card).toMatchObject({ kind: 'approval', state: 'open', threadId: 'general', actor: { kind: 'bot', botId: DEV.id }, refs: { approvalId: req.requestId, pr: 1, threadId: `pr:${KEY}#1` } });
    // Said once, by the card's own line from `tainted`, never again in the body.
    expect(card?.body).not.toContain('outside text');
  });

  it('the request card answers the owner message that started the wake, when it lands in its thread', async () => {
    const r = rig();
    const said = r.ownerSays('PR 1 looks done');
    r.state.wakes.set(DEV.id, { wakeId: 'w-1', attempt: 1, threadId: 'general' as never, tainted: false, ownerWords: true, ownerCardId: said.id });
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'green' });
    expect(r.writer.get(WS, req.cardId as string)).toMatchObject({ kind: 'approval', threadId: 'general', replyTo: said.id });
    // An owner card in another thread is not answered across threads.
    const other = r.ownerSays('and the issue', 'task:t-2');
    r.state.wakes.set(DEV.id, { wakeId: 'w-2', attempt: 1, threadId: 'general' as never, tainted: false, ownerCardId: other.id });
    const next = await r.ask(DEV, { action: 'comment', prNumber: 1, reason: 'note' });
    const card = r.writer.get(WS, next.cardId as string);
    expect(card?.threadId).toBe('general');
    expect(card?.replyTo).toBeUndefined();
  });

  it('a reason is the bot\'s own account: sentences quoting the owner\'s words are left out', async () => {
    expect(withoutOwnerQuotes('PR #2 at af06b88: verify gate passed. Owner said "머지할거 머지해".', ['머지할거  머지해'])).toBe('PR #2 at af06b88: verify gate passed.');
    expect(withoutOwnerQuotes('Diff is 1 line. 사용자가 「merge it」라고 했습니다.', ['Merge it'])).toBe('Diff is 1 line.');
    // A quote that is not the owner's, and no owner words at all, stay.
    expect(withoutOwnerQuotes('Title is "acme app".', ['머지해'])).toBe('Title is "acme app".');
    expect(withoutOwnerQuotes('Owner said "go".', [])).toBe('Owner said "go".');
    expect(withoutOwnerQuotes('Owner said "go".', ['go'])).toBe('');
    // A quote with its own full stop is still one quote; single quotes count,
    // an apostrophe in a word does not.
    expect(withoutOwnerQuotes('CI is green. Owner said "Check CI. Merge it" earlier.', ['Check CI. Merge it'])).toBe('CI is green.');
    expect(withoutOwnerQuotes("It's ready. Owner said 'merge it'.", ['merge it'])).toBe("It's ready.");
    expect(withoutOwnerQuotes('Owner said ‘merge it’. Diff ok.', ['merge it'])).toBe('Diff ok.');
    expect(withoutOwnerQuotes("The bot's check passed. Don't wait.", ["s check passed. Don"])).toBe("The bot's check passed. Don't wait.");
    const r = rig();
    r.ownerSays('머지할거 머지해', undefined, [DEV.id, OTHER.id]);
    r.state.wakes.set(DEV.id, { wakeId: 'w-1', attempt: 1, threadId: 'general' as never, tainted: false });
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'Verify gate passed at the head. Owner said "머지할거 머지해".' });
    expect(req).toMatchObject({ reason: 'Verify gate passed at the head.' });
    expect(r.writer.get(WS, req.cardId as string)?.body).not.toContain('머지');
    // Nothing of its own left: main names the act.
    r.state.wakes.set(DEV.id, { wakeId: 'w-2', attempt: 1, threadId: 'general' as never, tainted: false });
    const bare = await r.ask(DEV, { action: 'issue_close', issueNumber: 3, reason: '"머지할거 머지해"' });
    expect(bare).toMatchObject({ reason: 'Close issue #3.' });
  });

  it('a request lands in the thread of the owner\'s latest words to the bot, else the owner wake\'s own thread', async () => {
    const talked = rig({ conversationThread: (id) => (id === DEV.id ? 'issue:github.com/o/r#4' as never : null) });
    talked.state.wakes.set(DEV.id, { wakeId: 'w-1', attempt: 1, threadId: 'task:t-1' as never, tainted: false });
    expect(await talked.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' })).toMatchObject({ threadId: 'issue:github.com/o/r#4' });
    const answering = rig();
    answering.state.wakes.set(DEV.id, { wakeId: 'w-2', attempt: 1, threadId: `pr:${KEY}#2` as never, tainted: false, ownerWords: true });
    const req = await answering.ask(DEV, { action: 'merge', prNumber: 2, reason: 'x' });
    expect(req.threadId).toBe(`pr:${KEY}#2`);
    // Already in its subject's thread: no link to itself.
    expect(answering.writer.get(WS, req.cardId as string)?.refs?.threadId).toBeUndefined();
  });

  it('a turn in the bot\'s own 1:1 (its task\'s work, asked for there) asks there, though the owner spoke in the room since', async () => {
    const DM = bot('bot-0000de01');
    const inDm = rig({ conversationThread: () => 'general' as never, bots: () => ({ listEnabled: () => [DM], get: () => DM }) });
    inDm.state.wakes.set(DM.id, { wakeId: 'w-3', attempt: 1, threadId: `dm:${DM.id}` as never, tainted: false });
    expect(await inDm.ask(DM, { action: 'merge', prNumber: 1, reason: 'x' })).toMatchObject({ threadId: `dm:${DM.id}` });
  });

  it('refuses outside a wake, without a repository, a closed PR, or an unreadable login', async () => {
    const r = rig();
    r.state.wakes.delete(DEV.id);
    expect(await r.svc.request(binding(DEV), { action: 'merge', prNumber: 1, reason: 'x' })).toMatchObject({ ok: false, code: 'not_running' });
    const noRepo = rig({ bots: () => ({ listEnabled: () => [], get: () => bot('bot-0000dev1', { repo: undefined }) }) });
    expect(await noRepo.svc.request(binding(DEV), { action: 'merge', prNumber: 1, reason: 'x' })).toMatchObject({ ok: false, code: 'no_repo' });
    const r2 = rig();
    expect(await r2.svc.request(binding(DEV), { action: 'merge', prNumber: 7, reason: 'x' })).toMatchObject({ ok: false, code: 'read_failed' });
    r2.state.login = null;
    expect(await r2.svc.request(binding(DEV), { action: 'merge', prNumber: 1, reason: 'x' })).toMatchObject({ ok: false, code: 'read_failed' });
    expect(await r2.svc.request(binding(DEV), { action: 'fly', reason: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await r2.svc.request(binding(DEV), { action: 'merge', reason: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('a retried turn gets its request back; the same head asked twice is one request', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    const again = await r.svc.request(binding(DEV), { action: 'merge', prNumber: 1, reason: 'x', clientRequestId: 'wake:w-1:a1' });
    expect(again).toMatchObject({ ok: true, duplicate: true, request: { requestId: a.requestId } });
    const other = await r.svc.request(binding(OTHER), { action: 'merge', prNumber: 1, reason: 'y' });
    expect(other).toMatchObject({ ok: true, duplicate: true, request: { requestId: a.requestId } });
    expect(r.svc.listForOperator(WS)).toHaveLength(1);
  });

  it('a turn still running keeps its request count while many other turns ask', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'issue_create', reason: 'first' });
    for (let i = 0; i < 210; i += 1) {
      r.state.wakes.set(OTHER.id, { wakeId: `w-o${i}`, attempt: 1, threadId: null, tainted: false });
      await r.svc.request(binding(OTHER), { action: 'issue_create', reason: 'x' });
    }
    const b = await r.svc.request(binding(DEV), { action: 'issue_create', reason: 'second' });
    expect(b).toMatchObject({ ok: true });
    expect((b as { duplicate?: true }).duplicate).toBeUndefined();
    expect((b as { request: { requestId: string } }).request.requestId).not.toBe(a.requestId);
  });

  it('a retried turn (the next attempt) asks again under the same default keys', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'issue_create', reason: 'file it' });
    r.state.wakes.set(DEV.id, { wakeId: 'w-1', attempt: 2, threadId: null, tainted: false });
    expect(await r.svc.request(binding(DEV), { action: 'issue_create', reason: 'file it' })).toMatchObject({ ok: true, duplicate: true, request: { requestId: a.requestId } });
  });

  it('approval_list returns only the caller\'s requests', async () => {
    const r = rig();
    await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    await r.ask(OTHER, { action: 'issue_create', reason: 'y' });
    const mine = r.svc.listFor(binding(DEV), {});
    expect(mine).toMatchObject({ ok: true, requests: [{ botId: DEV.id }] });
    expect((mine as { requests: unknown[] }).requests).toHaveLength(1);
  });

  it('a store that did not start tells the asking bot that approvals are off and what to fix', async () => {
    const handlers = new Map<string, (raw: unknown, ctx?: RpcContext) => Promise<unknown>>();
    let failure: string | null = null;
    registerApprovalRpc({ register: (m: string, h: never) => handlers.set(m, h) } as never, () => null, () => failure);
    const asBot = { origin: 'local', bot: binding(DEV) } as unknown as RpcContext;
    expect(await handlers.get(BOT_APPROVAL_RPC.request)?.({ action: 'merge', prNumber: 1, reason: 'x' }, asBot)).toMatchObject({ ok: false, code: 'not_started', message: 'approvals are not running yet' });
    failure = 'Error: Unreadable approvals storage';
    const res = await handlers.get(BOT_APPROVAL_RPC.list)?.({}, asBot) as { code: string; message: string };
    expect(res.code).toBe('not_started');
    expect(res.message).toContain('factory/approvals.json');
    expect(res.message).not.toContain('Unreadable approvals storage');
  });

  it('the bot RPCs answer only a bot; no bot RPC decides', async () => {
    const handlers = new Map<string, (raw: unknown, ctx?: RpcContext) => Promise<unknown>>();
    const r = rig();
    registerApprovalRpc({ register: (m: string, h: never) => handlers.set(m, h) } as never, () => r.svc);
    expect([...handlers.keys()].sort()).toEqual([BOT_APPROVAL_RPC.list, BOT_APPROVAL_RPC.request].sort());
    const operator = { origin: 'local', operator: true, firstParty: true } as unknown as RpcContext;
    expect(await handlers.get(BOT_APPROVAL_RPC.request)?.({ action: 'merge', prNumber: 1, reason: 'x' }, operator)).toMatchObject({ ok: false, code: 'not_bot' });
    const asBot = { origin: 'local', bot: binding(DEV) } as unknown as RpcContext;
    const res = await handlers.get(BOT_APPROVAL_RPC.request)?.({ action: 'merge', prNumber: 1, reason: 'x', decision: 'approve' }, asBot) as { request: StoredApproval };
    expect(res.request.state).toBe('pending');
  });
});

describe('owner decisions', () => {
  it('approve waits out the Undo window, then the executor gets an owner effect', async () => {
    vi.useFakeTimers();
    const r = rig();
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    expect(r.svc.decide({ requestId: req.requestId, decision: 'approve' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'approved', decidedBy: 'owner', executeAfter: r.state.now + APPROVAL_UNDO_MS } });
    expect(r.svc.authorizeEffect({ decisionId: req.requestId, approvedBy: 'owner', expectHead: HEAD, prNumber: 1, repoKey: KEY } as MergeEffect)).toBe('approval-undo-window');
    r.state.now += APPROVAL_UNDO_MS;
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS);
    expect(r.enqueued).toEqual([{ id: req.requestId, approvedBy: 'owner' }]);
    expect(r.host.run).toHaveBeenCalledWith(`effect:${req.requestId}:pr.merge`);
    expect(r.svc.authorizeEffect({ decisionId: req.requestId, approvedBy: 'owner', expectHead: HEAD, prNumber: 1, repoKey: KEY } as MergeEffect)).toBeNull();
    expect(r.svc.decide({ requestId: req.requestId, decision: 'undo' }, 'desktop')).toMatchObject({ ok: false, code: 'too_late' });
  });

  it('undo within the window takes the approval back; nothing runs', async () => {
    vi.useFakeTimers();
    const r = rig();
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.svc.decide({ requestId: req.requestId, decision: 'approve' }, 'desktop');
    expect(r.writer.get(WS, req.cardId as string)?.state).toBe('resolved');
    expect(r.svc.decide({ requestId: req.requestId, decision: 'undo' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'pending' } });
    expect(r.writer.get(WS, req.cardId as string)?.state).toBe('open');
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS * 2);
    expect(r.enqueued).toEqual([]);
  });

  it('deny closes the card; a decided request takes no second decision', async () => {
    const r = rig();
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    expect(r.svc.decide({ requestId: req.requestId, decision: 'deny' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'denied' } });
    expect(r.writer.get(WS, req.cardId as string)?.state).toBe('resolved');
    expect(r.svc.decide({ requestId: req.requestId, decision: 'approve' }, 'phone')).toMatchObject({ ok: false, code: 'not_pending' });
  });

  it('the run-time gate: head, approver and state must match; the login must not change', async () => {
    vi.useFakeTimers();
    const r = rig();
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.svc.decide({ requestId: req.requestId, decision: 'approve' }, 'desktop');
    r.state.now += APPROVAL_UNDO_MS;
    const e = { decisionId: req.requestId, approvedBy: 'owner', expectHead: HEAD, prNumber: 1, repoKey: KEY } as MergeEffect;
    expect(r.svc.authorizeEffect({ ...e, expectHead: HEAD2 })).toBe('approval-mismatch');
    expect(r.svc.authorizeEffect({ ...e, approvedBy: 'rule' })).toBe('approval-mismatch');
    expect(r.svc.authorizeEffect({ ...e, decisionId: 'apr-nothere12345' })).toBe('approval-missing');
    expect(await r.svc.identityEffect(e)).toBeNull();
    r.state.login = 'someone-else';
    expect(await r.svc.identityEffect(e)).toBe('identity-changed');
    r.state.login = null;
    expect(await r.svc.identityEffect(e)).toBe('identity-unknown');
  });

  it('an executor outcome settles the request, writes the fact and an outcome card', async () => {
    const r = rig();
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.svc.decide({ requestId: req.requestId, decision: 'approve' }, 'desktop');
    const effect = { id: `effect:${req.requestId}:pr.merge`, kind: 'pr.merge', decisionId: req.requestId, approvedBy: 'owner', repoKey: KEY, repoPath: '/repo', prNumber: 1, expectHead: HEAD, status: 'refused', reason: 'head-moved', attempt: 1, createdAt: 1, updatedAt: 2 } as MergeEffect;
    r.svc.onEffect(effect);
    expect(r.svc.get(req.requestId)).toMatchObject({ state: 'refused', refusal: 'head-moved' });
    expect(r.facts).toMatchObject([{ kind: 'merge.refused', payload: { approvedBy: 'owner', reason: 'head-moved' } }]);
    const cards = r.writer.read(WS, {}).cards;
    expect(cards.at(-1)).toMatchObject({ kind: 'refusal', title: expect.stringContaining('needs a new approval') });
  });

  it('acts other than merge are recorded, never executed', async () => {
    vi.useFakeTimers();
    const r = rig();
    const req = await r.ask(DEV, { action: 'issue_create', reason: 'file the crash' });
    expect(r.writer.get(WS, req.cardId as string)?.body).toContain('does not carry this act out yet');
    expect(r.svc.decide({ requestId: req.requestId, decision: 'approve' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'approved' } });
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS * 2);
    expect(r.enqueued).toEqual([]);
  });

  it('a pending request expires after a day', async () => {
    const r = rig();
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.state.now += 24 * 3600_000;
    expect(r.svc.listForOperator(WS)[0]).toMatchObject({ requestId: req.requestId, state: 'expired' });
  });

  it('on start, a request whose merge already ended takes that outcome', async () => {
    const r = rig();
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.svc.decide({ requestId: req.requestId, decision: 'approve' }, 'desktop');
    r.state.now += APPROVAL_UNDO_MS;
    await r.svc.execute(req.requestId);
    const done = { id: `effect:${req.requestId}:pr.merge`, kind: 'pr.merge', decisionId: req.requestId, approvedBy: 'owner', repoKey: KEY, repoPath: '/repo', prNumber: 1, expectHead: HEAD, status: 'done', attempt: 1, createdAt: 1, updatedAt: 2 } as MergeEffect;
    // The outcome never reached the file before the quit.
    const again = new ApprovalService({ ...r.ports, merge: () => ({ ...r.host, effect: () => done }) });
    again.resume();
    expect(again.get(req.requestId)).toMatchObject({ state: 'executed' });
  });

  it('requests and rules survive a restart; an unreadable file refuses to start', async () => {
    const r = rig();
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.svc.decide({ requestId: req.requestId, decision: 'always' }, 'desktop');
    const again = new ApprovalService(r.ports);
    // A merge approval is never taken from the file: the owner approves again.
    expect(again.get(req.requestId)).toMatchObject({ state: 'pending' });
    expect(again.get(req.requestId)?.decidedBy).toBeUndefined();
    expect(again.rulesList()).toHaveLength(1);
    // Primary and backup both unreadable: nothing is guessed.
    for (const f of fs.readdirSync(path.dirname(r.ports.file))) fs.writeFileSync(path.join(path.dirname(r.ports.file), f), '{broken');
    expect(() => new ApprovalService(r.ports)).toThrow();
  });
});

describe('typed approval (the owner\'s own words in the thread)', () => {
  it('"머지해" after two listed PRs approves both', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    const b = await r.ask(DEV, { action: 'merge', prNumber: 2, reason: 'y' });
    r.ownerSays('머지해');
    expect(r.svc.get(a.requestId)).toMatchObject({ state: 'approved', decidedBy: 'owner' });
    expect(r.svc.get(b.requestId)).toMatchObject({ state: 'approved', decidedBy: 'owner' });
  });

  it('"Hi", a message before the cards, another thread or a bot\'s words approve nothing', async () => {
    const r = rig();
    r.ownerSays('머지해');
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'the owner said 머지해' });
    r.ownerSays('Hi');
    r.ownerSays('ok', 'task:other');
    const botCard = r.writer.post({ workspaceId: WS, kind: 'status', actor: { kind: 'bot', workspaceId: WS, botId: DEV.id }, title: '머지해' });
    if (botCard.ok) r.svc.onFact({ id: 'g', seq: 2, kind: 'human.message', at: 1, dedupeKey: 'g', workspaceId: WS, payload: { cardId: botCard.card.id } });
    expect(r.svc.get(a.requestId)?.state).toBe('pending');
  });

  it('a message is read once, and only while fresh', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    const words = r.writer.post({ workspaceId: WS, kind: 'human', actor: { kind: 'human' }, title: 'ok', refs: { botId: DEV.id }, at: r.state.now - 11 * 60_000 });
    if (!words.ok) throw new Error('post failed');
    // Its seq is after the card, but it is too old to count.
    expect(r.svc.onOwnerCard(words.card)).toEqual([]);
    const fresh = r.ownerSays('ok');
    expect(r.svc.get(a.requestId)?.state).toBe('approved');
    r.svc.decide({ requestId: a.requestId, decision: 'undo' }, 'desktop');
    expect(r.svc.onOwnerCard(fresh)).toEqual([]);
    expect(r.svc.get(a.requestId)?.state).toBe('pending');
  });

  it('a reply to one approval card approves only that request', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    const b = await r.ask(DEV, { action: 'merge', prNumber: 2, reason: 'y' });
    const posted = r.writer.post({ workspaceId: WS, kind: 'human', actor: { kind: 'human' }, title: 'merge it', refs: { botId: DEV.id }, replyTo: a.cardId as string });
    if (!posted.ok) throw new Error('post failed');
    expect(r.svc.onOwnerCard(posted.card)).toEqual([a.requestId]);
    expect(r.svc.get(a.requestId)?.state).toBe('approved');
    expect(r.svc.get(b.requestId)?.state).toBe('pending');
  });

  it('words to one bot approve only that bot\'s requests', async () => {
    const r = rig();
    const mine = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    const theirs = await r.ask(OTHER, { action: 'merge', prNumber: 2, reason: 'y' });
    r.ownerSays('머지해', undefined, [OTHER.id]);
    expect(r.svc.get(mine.requestId)?.state).toBe('pending');
    expect(r.svc.get(theirs.requestId)?.state).toBe('approved');
  });

  it('an open question between the cards and the words takes the words instead', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.writer.post({ workspaceId: WS, kind: 'question', actor: { kind: 'bot', workspaceId: WS, botId: OTHER.id }, title: 'Proceed with the refactor?', state: 'open' });
    r.ownerSays('응');
    expect(r.svc.get(a.requestId)?.state).toBe('pending');
  });

  it('typedApprovalTargets is pure: ordered by card, scoped to the addressees, no open question, no reply elsewhere', () => {
    const msg = { kind: 'human', actor: { kind: 'human' }, threadId: 'general', seq: 10, title: 'merge them', workspaceId: WS, refs: { botId: 'bot-a' } } as const;
    const cards = new Map([['c1', { seq: 3, threadId: 'general', kind: 'approval' }], ['c2', { seq: 5, threadId: 'general', kind: 'approval' }], ['c3', { seq: 12, threadId: 'general', kind: 'approval' }], ['c4', { seq: 6, threadId: 'general', kind: 'approval' }], ['q', { seq: 7, threadId: 'general', kind: 'question' }]]);
    const get = (id: string) => (cards.get(id) as never) ?? null;
    const pending = [
      { requestId: 'apr-b', workspaceId: WS, threadId: 'general', state: 'pending', cardId: 'c2', botId: 'bot-a' },
      { requestId: 'apr-a', workspaceId: WS, threadId: 'general', state: 'pending', cardId: 'c1', botId: 'bot-a' },
      { requestId: 'apr-late', workspaceId: WS, threadId: 'general', state: 'pending', cardId: 'c3', botId: 'bot-a' },
      { requestId: 'apr-done', workspaceId: WS, threadId: 'general', state: 'denied', cardId: 'c1', botId: 'bot-a' },
      { requestId: 'apr-other-bot', workspaceId: WS, threadId: 'general', state: 'pending', cardId: 'c4', botId: 'bot-b' },
    ] as const;
    const none: never[] = [];
    expect(typedApprovalTargets(msg as never, pending as never, get, none)).toEqual(['apr-a', 'apr-b']);
    expect(typedApprovalTargets({ ...msg, refs: { botId: 'bot-a', botIds: ['bot-a', 'bot-b'] } } as never, pending as never, get, none)).toEqual(['apr-a', 'apr-b', 'apr-other-bot']);
    expect(typedApprovalTargets({ ...msg, refs: undefined } as never, pending as never, get, none)).toEqual([]);
    const openQ = [{ seq: 7, kind: 'question', state: 'open', actor: { kind: 'bot' }, title: 'q?' }];
    expect(typedApprovalTargets(msg as never, pending as never, get, openQ as never)).toEqual([]);
    const first = { seq: 1, kind: 'status', actor: { kind: 'bot' }, title: 'x' };
    expect(typedApprovalTargets(msg as never, pending as never, get, [first, { ...openQ[0], state: 'resolved' }] as never)).toEqual(['apr-a', 'apr-b']);
    // Cards read that do not reach back to a request's card: that request is not approved.
    expect(typedApprovalTargets(msg as never, pending as never, get, [{ ...first, seq: 4 }] as never)).toEqual(['apr-b']);
    expect(typedApprovalTargets({ ...msg, replyTo: 'q' } as never, pending as never, get, none)).toEqual([]);
    // A reply to one approval card approves only that card's request.
    expect(typedApprovalTargets({ ...msg, replyTo: 'c1' } as never, pending as never, get, none)).toEqual(['apr-a']);
    expect(typedApprovalTargets({ ...msg, replyTo: 'c2' } as never, pending as never, get, none)).toEqual(['apr-b']);
    // Even when the words woke another bot (a room's coordinator): the reply names the request.
    expect(typedApprovalTargets({ ...msg, replyTo: 'c4' } as never, pending as never, get, none)).toEqual(['apr-other-bot']);
    expect(typedApprovalTargets({ ...msg, title: 'merge them and also delete the repo' } as never, pending as never, get, none)).toEqual([]);
    // Only the requests right above: the owner said something else at seq 4.
    const said = [{ seq: 4, kind: 'human', actor: { kind: 'human' }, title: 'Hi' }];
    expect(typedApprovalTargets(msg as never, pending as never, get, said as never)).toEqual(['apr-b']);
    // An open question asked before that message no longer holds the words.
    expect(typedApprovalTargets(msg as never, pending as never, get, [{ ...openQ[0], seq: 2 }, ...said] as never)).toEqual(['apr-b']);
    // The same words said again are no boundary.
    expect(typedApprovalTargets(msg as never, pending as never, get, [first, { ...said[0], title: '머지해' }] as never)).toEqual(['apr-a', 'apr-b']);
  });

  it('in general, to the whole room: "머지할거 머지해" approves the room\'s pending requests right above it', async () => {
    const dev = bot('bot-0000aaa1');
    const rev = bot('bot-0000bbb2');
    const r = rig({ bots: () => ({ listEnabled: () => [dev, rev], get: (id) => [dev, rev].find((b) => b.id === id) ?? null }) });
    r.state.wakes.set(dev.id, { wakeId: 'w-d', attempt: 1, threadId: null, tainted: false });
    r.state.wakes.set(rev.id, { wakeId: 'w-r', attempt: 1, threadId: null, tainted: false });
    const a = await r.ask(dev, { action: 'merge', prNumber: 1, reason: 'x' });
    const b = await r.ask(rev, { action: 'merge', prNumber: 2, reason: 'y' });
    r.writer.post({ workspaceId: WS, kind: 'status', actor: { kind: 'bot', workspaceId: WS, botId: dev.id }, title: 'Press Approve when ready' });
    r.ownerSays('머지할거 머지해', 'general', [dev.id, rev.id]);
    expect(r.svc.get(a.requestId)?.state).toBe('approved');
    expect(r.svc.get(b.requestId)?.state).toBe('approved');
  });

  it('in a room with a coordinator, words to the room (which woke only it) still approve for every bot of the room', async () => {
    const dev = bot('bot-0000aaa1');
    const rev = bot('bot-0000bbb2');
    const lead = bot('bot-0000ccc3', { role: 'moa', template: 'coordinator' });
    const r = rig({ bots: () => ({ listEnabled: () => [dev, rev, lead], get: (id) => [dev, rev, lead].find((b) => b.id === id) ?? null }) });
    r.state.wakes.set(dev.id, { wakeId: 'w-d', attempt: 1, threadId: null, tainted: false });
    r.state.wakes.set(rev.id, { wakeId: 'w-r', attempt: 1, threadId: null, tainted: false });
    const a = await r.ask(dev, { action: 'merge', prNumber: 1, reason: 'x' });
    // A 1:1 to the coordinator approves only its own requests.
    r.ownerSays('merge it', 'general', [lead.id]);
    expect(r.svc.get(a.requestId)?.state).toBe('pending');
    const b = await r.ask(rev, { action: 'merge', prNumber: 2, reason: 'y' });
    r.ownerSays('merge them', 'general', [lead.id], undefined, true);
    expect(r.svc.get(b.requestId)?.state).toBe('approved');
  });

  it('another owner message between the cards and the words leaves the requests above it pending', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.ownerSays('wait, what about the tests?');
    const b = await r.ask(DEV, { action: 'merge', prNumber: 2, reason: 'y' });
    r.ownerSays('ok');
    expect(r.svc.get(a.requestId)?.state).toBe('pending');
    expect(r.svc.get(b.requestId)?.state).toBe('approved');
  });
});

describe('a deleted bot\'s requests', () => {
  function rigWithDeletable() {
    const gone = new Set<string>();
    const live = () => [DEV, OTHER].filter((b) => !gone.has(b.id));
    const r = rig({ bots: () => ({ listEnabled: live, get: (id) => live().find((b) => b.id === id) ?? null }) });
    return { ...r, gone };
  }

  it('on delete, each waiting request of the bot expires and its card closes; a later approve is refused', async () => {
    const r = rigWithDeletable();
    const merge = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    const other = await r.ask(OTHER, { action: 'merge', prNumber: 2, reason: 'y' });
    r.gone.add(DEV.id);
    expect(r.svc.botRemoved(DEV.id)).toBe(1);
    expect(r.svc.get(merge.requestId)?.state).toBe('expired');
    expect(r.writer.get(WS, merge.cardId as string)?.state).toBe('resolved');
    expect(r.svc.decide({ requestId: merge.requestId, decision: 'approve' }, 'desktop')).toMatchObject({ ok: false, code: 'not_bot' });
    expect(r.svc.get(merge.requestId)?.state).toBe('expired');
    expect(r.enqueued).toEqual([]);
    // Another bot's request is untouched.
    expect(r.svc.get(other.requestId)?.state).toBe('pending');
  });

  it('a request whose bot is gone is refused even when nothing expired it first', async () => {
    const r = rigWithDeletable();
    const merge = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.gone.add(DEV.id);
    for (const decision of ['approve', 'always', 'deny']) {
      expect(r.svc.decide({ requestId: merge.requestId, decision }, 'desktop')).toMatchObject({ ok: false, code: 'not_bot' });
    }
    expect(r.svc.get(merge.requestId)?.state).toBe('expired');
    expect(r.svc.rulesList()).toEqual([]);
    expect(r.enqueued).toEqual([]);
  });

  it('a merge approved but inside its Undo window ends on delete, and no merge effect of a deleted bot is authorized', async () => {
    const r = rigWithDeletable();
    const merge = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    expect(r.svc.decide({ requestId: merge.requestId, decision: 'approve' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'approved' } });
    const effect = { decisionId: merge.requestId, approvedBy: 'owner', expectHead: HEAD, prNumber: 1, repoKey: KEY } as unknown as MergeEffect;
    r.gone.add(DEV.id);
    expect(r.svc.authorizeEffect(effect)).toBe('bot-removed');
    expect(r.svc.botRemoved(DEV.id)).toBe(1);
    expect(r.svc.get(merge.requestId)?.state).toBe('expired');
    expect(r.svc.authorizeEffect(effect)).toBe('approval-not-approved');
    r.svc.stop();
  });

  it('a request still open for a bot deleted earlier ends when the store starts again', async () => {
    const r = rigWithDeletable();
    const merge = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.gone.add(DEV.id);
    const again = new ApprovalService(r.ports);
    again.resume();
    expect(again.get(merge.requestId)?.state).toBe('expired');
    again.stop();
  });
});

describe('always allow (remembered rules)', () => {
  it('always allow is one write: a failed write leaves neither the rule nor the approval', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    // Every write into the approvals folder fails (portable: no permission bits).
    const folder = path.dirname(r.ports.file);
    const realWrite = fsDefault.writeFileSync;
    const spy = vi.spyOn(fsDefault, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof file === 'string' && path.dirname(file) === folder) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return (realWrite as (...a: unknown[]) => void)(file, ...rest);
    }) as typeof fsDefault.writeFileSync);
    try {
      expect(r.svc.decide({ requestId: a.requestId, decision: 'always' }, 'desktop')).toMatchObject({ ok: false, code: 'write_failed' });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(r.svc.rulesList()).toEqual([]);
    expect(r.svc.get(a.requestId)?.state).toBe('pending');
    const issue = await r.ask(DEV, { action: 'issue_create', reason: 'y' });
    expect(r.svc.decide({ requestId: issue.requestId, decision: 'always' }, 'desktop')).toMatchObject({ ok: false, code: 'not_ruleable' });
  });

  it('an owner decision made while the rule check reads GitHub stands', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.svc.decide({ requestId: a.requestId, decision: 'always' }, 'desktop');
    r.state.wakes.set(DEV.id, { wakeId: 'w-2', attempt: 1, threadId: null, tainted: false });
    (r.host.ruleCheck as ReturnType<typeof vi.fn>).mockImplementationOnce(async (req: StoredApproval) => {
      expect(r.svc.decide({ requestId: req.requestId, decision: 'approve' }, 'desktop')).toMatchObject({ ok: true });
      expect(r.svc.decide({ requestId: req.requestId, decision: 'undo' }, 'desktop')).toMatchObject({ ok: true, request: { state: 'pending' } });
      return null;
    });
    const b = await r.ask(DEV, { action: 'merge', prNumber: 2, reason: 'y' });
    expect(b.state).toBe('pending');
    expect(b.decidedBy).toBeUndefined();
    expect(r.svc.get(b.requestId)).toMatchObject({ state: 'pending' });
  });

  it('a rule decides only a request whose card was posted', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.svc.decide({ requestId: a.requestId, decision: 'always' }, 'desktop');
    r.state.wakes.set(DEV.id, { wakeId: 'w-2', attempt: 1, threadId: null, tainted: false });
    (r.host.ruleCheck as ReturnType<typeof vi.fn>).mockClear();
    const post = r.writer.post.bind(r.writer);
    const spy = vi.spyOn(r.writer, 'post').mockImplementation((input) => (input.kind === 'approval' ? { ok: false, code: 'invalid', message: 'refused' } as never : post(input)));
    try {
      const b = await r.ask(DEV, { action: 'merge', prNumber: 2, reason: 'y' });
      expect(b.cardId).toBeUndefined();
      expect(b).toMatchObject({ state: 'pending', ruleSkipped: 'its card could not be posted' });
      expect(r.host.ruleCheck).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a rule revoked while its check reads GitHub approves nothing', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    const res = r.svc.decide({ requestId: a.requestId, decision: 'always' }, 'desktop') as { rule: { ruleId: string } };
    r.state.wakes.set(DEV.id, { wakeId: 'w-2', attempt: 1, threadId: null, tainted: false });
    (r.host.ruleCheck as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      r.svc.revokeRule(res.rule.ruleId);
      return null;
    });
    expect(await r.ask(DEV, { action: 'merge', prNumber: 2, reason: 'y' })).toMatchObject({ state: 'pending', ruleSkipped: 'the rule was revoked' });
  });

  it('approves the request, and a later covered request is approved by the rule when the lane check passes', async () => {
    vi.useFakeTimers();
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    const res = r.svc.decide({ requestId: a.requestId, decision: 'always' }, 'desktop');
    expect(res).toMatchObject({ ok: true, request: { state: 'approved', decidedBy: 'owner' }, rule: { action: 'merge', repoKey: KEY, scope: { botId: DEV.id } } });
    r.state.wakes.set(DEV.id, { wakeId: 'w-2', attempt: 1, threadId: null, tainted: false });
    const b = await r.ask(DEV, { action: 'merge', prNumber: 2, reason: 'y' });
    expect(b).toMatchObject({ state: 'approved', decidedBy: 'rule', ruleId: (res as { rule: { ruleId: string } }).rule.ruleId });
    r.state.now += APPROVAL_UNDO_MS;
    expect(r.svc.authorizeEffect({ decisionId: b.requestId, approvedBy: 'rule', expectHead: HEAD, prNumber: 2, repoKey: KEY } as MergeEffect)).toBeNull();
    // Revoked: the run-time gate refuses it.
    r.svc.revokeRule((res as { rule: { ruleId: string } }).rule.ruleId);
    expect(r.svc.authorizeEffect({ decisionId: b.requestId, approvedBy: 'rule', expectHead: HEAD, prNumber: 2, repoKey: KEY } as MergeEffect)).toBe('rule-revoked');
  });

  it('a rule never approves a tainted request, one the lane check refuses, another bot\'s, or a release', async () => {
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.svc.decide({ requestId: a.requestId, decision: 'always' }, 'desktop');
    r.state.wakes.set(DEV.id, { wakeId: 'w-2', attempt: 1, threadId: null, tainted: true });
    r.state.heads.set(3, HEAD);
    const tainted = await r.ask(DEV, { action: 'merge', prNumber: 3, reason: 'from an issue' });
    expect(tainted).toMatchObject({ state: 'pending', ruleSkipped: 'tainted-origin' });
    r.state.wakes.set(DEV.id, { wakeId: 'w-3', attempt: 1, threadId: null, tainted: false });
    r.state.ruleCheck = 'lane-paused';
    r.state.heads.set(4, HEAD);
    expect(await r.ask(DEV, { action: 'merge', prNumber: 4, reason: 'x' })).toMatchObject({ state: 'pending', ruleSkipped: 'lane-paused' });
    r.state.ruleCheck = null;
    r.state.heads.set(5, HEAD);
    // The rule covers the bot that asks: another bot's request is told so.
    expect(await r.ask(OTHER, { action: 'merge', prNumber: 5, reason: 'x' })).toMatchObject({ state: 'pending', ruleSkipped: 'rule-other-asker' });
    const rel = await r.ask(DEV, { action: 'release', reason: 'ship' });
    expect(r.svc.decide({ requestId: rel.requestId, decision: 'always' }, 'desktop')).toMatchObject({ ok: false, code: 'not_ruleable' });
    expect(ruleCovers({ ruleId: 'r', action: 'merge', repoKey: KEY, scope: { workspaceId: WS }, createdAt: 1 }, { action: 'release', repoKey: KEY, botId: DEV.id, workspaceId: WS })).toBe(false);
  });
});

describe('the phone operator\'s route (main side)', () => {
  it('reads a request and decides it the way the card does; nothing a bot wrote rides along', async () => {
    const { handlePhoneBotApprovalCommand } = await import('../../phone/PhoneBotApprovals');
    const r = rig();
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'green and verified' });
    const svc = () => r.svc;
    const got = handlePhoneBotApprovalCommand('workspaces.botApproval', { requestId: req.requestId }, svc);
    expect(got).toMatchObject({ request: { requestId: req.requestId, action: 'merge', state: 'pending', prNumber: 1, headSha: HEAD, canAlwaysAllow: true, tainted: false } });
    expect(JSON.stringify(got)).not.toContain('green and verified');
    expect(JSON.stringify(got)).not.toContain('/repo');
    const approved = handlePhoneBotApprovalCommand('workspaces.botApprovalDecide', { requestId: req.requestId, decision: 'approve' }, svc);
    expect(approved).toMatchObject({ request: { state: 'approved', decidedBy: 'owner', executeAfter: r.state.now + APPROVAL_UNDO_MS, canAlwaysAllow: false } });
    expect(handlePhoneBotApprovalCommand('workspaces.botApprovalDecide', { requestId: req.requestId, decision: 'undo' }, svc)).toMatchObject({ request: { state: 'pending' } });
    expect(handlePhoneBotApprovalCommand('workspaces.botApprovalDecide', { requestId: req.requestId, decision: 'deny' }, svc)).toMatchObject({ request: { state: 'denied' } });
    expect(handlePhoneBotApprovalCommand('workspaces.botApprovalDecide', { requestId: req.requestId, decision: 'approve' }, svc)).toEqual({ refused: { code: 'not_pending', message: 'the request is denied' } });
  });

  it('logs the paired device a decision came from; a malformed device id is not logged', async () => {
    const { handlePhoneBotApprovalCommand } = await import('../../phone/PhoneBotApprovals');
    const logs: string[] = [];
    const r = rig({ log: (line: string) => logs.push(line) });
    const svc = () => r.svc;
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'green' });
    handlePhoneBotApprovalCommand('workspaces.botApprovalDecide', { requestId: req.requestId, decision: 'approve', deviceId: 'dev-1' }, svc);
    handlePhoneBotApprovalCommand('workspaces.botApprovalDecide', { requestId: req.requestId, decision: 'undo', deviceId: 'dev-1' }, svc);
    handlePhoneBotApprovalCommand('workspaces.botApprovalDecide', { requestId: req.requestId, decision: 'deny', deviceId: 'a b\nc' }, svc);
    expect(logs).toEqual([
      `[factory] approval ${req.requestId} approved by owner (phone, device dev-1)`,
      `[factory] approval ${req.requestId} undone by owner (phone, device dev-1)`,
      `[factory] approval ${req.requestId} denied by owner (phone)`,
    ]);
  });

  it('refuses a malformed id or decision, an unknown request, and answers unavailable before the store runs', async () => {
    const { handlePhoneBotApprovalCommand } = await import('../../phone/PhoneBotApprovals');
    const r = rig();
    const svc = () => r.svc;
    expect(handlePhoneBotApprovalCommand('workspaces.list', {}, svc)).toBeNull();
    expect(handlePhoneBotApprovalCommand('workspaces.botApproval', { requestId: '../x' }, svc)).toEqual({ invalid: true });
    expect(handlePhoneBotApprovalCommand('workspaces.botApproval', { requestId: 'apr-unknown1' }, svc)).toEqual({ notFound: true });
    expect(handlePhoneBotApprovalCommand('workspaces.botApprovalDecide', { requestId: 'apr-unknown1', decision: 'approve' }, svc)).toEqual({ notFound: true });
    expect(handlePhoneBotApprovalCommand('workspaces.botApprovalDecide', { requestId: 'apr-unknown1', decision: 'merge' }, svc)).toEqual({ invalid: true });
    expect(handlePhoneBotApprovalCommand('workspaces.botApprovalDecide', { requestId: 'apr-unknown1', decision: 'approve', ruleScope: 'workspace' }, svc)).toEqual({ invalid: true });
    expect(handlePhoneBotApprovalCommand('workspaces.botApproval', { requestId: 'apr-unknown1' }, () => null)).toEqual({ unavailable: true });
  });
});

describe('typed approval from a phone', () => {
  const phoneId = (actor: string) => `phone:${createHash('sha256').update(actor).digest('hex').slice(0, 16)}:m-1`;

  it('the operator token\'s message approves; a paired device\'s does not', async () => {
    expect(typedApprovalSourceAllowed({})).toBe(true);
    expect(typedApprovalSourceAllowed({ clientPostId: 'desktop:x' })).toBe(true);
    expect(typedApprovalSourceAllowed({ clientPostId: phoneId('operator') })).toBe(true);
    expect(typedApprovalSourceAllowed({ clientPostId: phoneId('device:d-1') })).toBe(false);
    const r = rig();
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.ownerSays('머지해', undefined, [DEV.id], phoneId('device:d-1'));
    expect(r.svc.get(a.requestId)?.state).toBe('pending');
    r.ownerSays('머지해', undefined, [DEV.id], phoneId('operator'));
    expect(r.svc.get(a.requestId)?.state).toBe('approved');
  });
});

describe('the bots learn what became of a request (A4)', () => {
  const noticeRig = () => {
    const notices: BotNoticeInput[] = [];
    const r = rig({ notice: (n) => notices.push(n) });
    return { ...r, notices };
  };
  const mergedFact = (kind: 'merge.done' | 'pr.merged', approvedBy?: string): Fact => ({
    id: `f-${kind}`, seq: 9, kind, at: 1, dedupeKey: kind, repoKey: 'o/r', ref: { pr: 1, headSha: HEAD }, payload: approvedBy ? { approvedBy } : {},
  });

  it('a denial is told to the bot that asked and to the bots that spoke in the thread since its card', async () => {
    const r = noticeRig();
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.writer.post({ workspaceId: WS, kind: 'status', actor: { kind: 'bot', workspaceId: WS, botId: OTHER.id }, title: 'Press Approve' });
    r.svc.decide({ requestId: req.requestId, decision: 'deny' }, 'desktop');
    expect(r.notices.map((n) => n.botId).sort()).toEqual([DEV.id, OTHER.id].sort());
    expect(r.notices[0]).toMatchObject({ key: `approval:${req.requestId}:denied`, topic: 'approval.decided', threadId: 'general', title: 'The owner denied: Merge PR #1.' });
  });

  it('a refused merge is told in plain words; the view carries the plain text', async () => {
    const r = noticeRig();
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.svc.decide({ requestId: req.requestId, decision: 'approve' }, 'desktop');
    expect(r.notices).toEqual([]);
    r.svc.onEffect({ id: 'e', kind: 'pr.merge', decisionId: req.requestId, approvedBy: 'owner', repoKey: KEY, repoPath: '/repo', prNumber: 1, expectHead: HEAD, status: 'refused', reason: 'identity-changed', attempt: 1, createdAt: 1, updatedAt: 2 } as MergeEffect);
    expect(r.notices).toMatchObject([{ botId: DEV.id, key: `approval:${req.requestId}:refused`, title: 'Not merged: PR #1 (The GitHub login changed since the check).' }]);
    const view = r.svc.listForOperator(WS).find((v) => v.requestId === req.requestId)!;
    expect(view).toMatchObject({ refusal: 'identity-changed', refusalText: 'The GitHub login changed since the check' });
    expect(view).not.toHaveProperty('repoPath');
  });

  it('a merged PR is told once per bot, whichever fact comes first, and its pending requests are moot', async () => {
    const r = noticeRig();
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.writer.post({ workspaceId: WS, kind: 'status', actor: { kind: 'bot', workspaceId: WS, botId: OTHER.id }, title: 'Press Approve' });
    r.svc.onFact(mergedFact('pr.merged'));
    expect(r.svc.get(req.requestId)?.state).toBe('expired');
    expect(r.writer.get(WS, req.cardId as string)?.state).toBe('resolved');
    expect(r.notices.map((n) => [n.botId, n.key, n.topic])).toEqual([
      [DEV.id, `pr.merged:${KEY}#1`, 'pr.merged'],
      [OTHER.id, `pr.merged:${KEY}#1`, 'pr.merged'],
    ]);
    expect(r.notices[0].title).toBe('PR #1 merged on GitHub.');
    // The second fact for the same merge carries the same key (one wake per bot).
    r.svc.onFact(mergedFact('merge.done', 'owner'));
    expect(new Set(r.notices.map((n) => `${n.botId} ${n.key}`)).size).toBe(2);
    expect(r.notices[2].title).toBe('PR #1 merged with the owner\'s approval.');
  });

  it('a rule skip reads as plain words on the view', async () => {
    const r = rig();
    const first = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.svc.decide({ requestId: first.requestId, decision: 'always' }, 'desktop');
    r.state.ruleCheck = 'required-checks-green:no-required-checks';
    const second = await r.ask(DEV, { action: 'merge', prNumber: 2, reason: 'y' });
    const view = r.svc.listForOperator(WS).find((v) => v.requestId === second.requestId)!;
    expect(view).toMatchObject({ state: 'pending', ruleSkippedText: 'The repository has no required checks' });
  });
});

describe('always allow: what a rule needs and why it did not apply', () => {
  const view = (r: ReturnType<typeof rig>, id: string) => r.svc.listForOperator(WS).find((v) => v.requestId === id) ?? { ruleNeeds: 'missing', ruleSkipped: 'missing', ruleSkippedCondition: 'missing' };

  it('a merge no rule covers says what a rule from it would still lack here: a Reviewer bot, required checks, a trusted author', async () => {
    const r = rig();
    r.state.ruleCheck = 'required-checks-green:no-required-checks, author-trusted:external-author, verifier-pass-at-head:no-verdict';
    const a = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    expect(view(r, a.requestId)).toMatchObject({ state: 'pending', ruleNeeds: ['verifier', 'noChecks', 'author'] });
    expect(view(r, a.requestId).ruleSkipped).toBeUndefined();
    // A Reviewer bot of another repository cannot verify this one.
    const elsewhere = bot('bot-0000rev2', { template: 'reviewer', role: 'verifier', repo: { repoKey: 'o/other', repoPath: '/other' } });
    const other = rig({ bots: () => ({ listEnabled: () => [DEV, OTHER, elsewhere], get: (id) => [DEV, OTHER, elsewhere].find((b) => b.id === id) ?? null }) });
    other.state.ruleCheck = 'verifier-pass-at-head:no-verdict';
    other.state.wakes.set(DEV.id, { wakeId: 'w-4', attempt: 1, threadId: null, tainted: false });
    other.state.heads.set(4, HEAD);
    const d = await other.ask(DEV, { action: 'merge', prNumber: 4, reason: 'x' });
    expect(view(other, d.requestId).ruleNeeds).toEqual(['verifier']);
    // A Reviewer bot on this repository can verify: only what the repository lacks.
    const reviewer = bot('bot-0000rev1', { template: 'reviewer', role: 'verifier' });
    const withReviewer = rig({ bots: () => ({ listEnabled: () => [DEV, OTHER, reviewer], get: (id) => [DEV, OTHER, reviewer].find((b) => b.id === id) ?? null }) });
    withReviewer.state.ruleCheck = 'required-checks-green:no-required-checks, verifier-pass-at-head:no-verdict';
    withReviewer.state.wakes.set(DEV.id, { wakeId: 'w-5', attempt: 1, threadId: null, tainted: false });
    const b = await withReviewer.ask(DEV, { action: 'merge', prNumber: 2, reason: 'x' });
    expect(view(withReviewer, b.requestId).ruleNeeds).toEqual(['noChecks']);
    // Nothing missing for good (a pending check, a verdict still to come): no line.
    withReviewer.state.ruleCheck = 'required-checks-green:required-check-pending, verifier-pass-at-head:no-verdict';
    withReviewer.state.heads.set(3, HEAD);
    withReviewer.state.wakes.set(DEV.id, { wakeId: 'w-2', attempt: 1, threadId: null, tainted: false });
    const c = await withReviewer.ask(DEV, { action: 'merge', prNumber: 3, reason: 'x' });
    expect(view(withReviewer, c.requestId).ruleNeeds).toBeUndefined();
  });

  it('a covered request that the rule could not approve names its first unmet condition on its own pending card', async () => {
    const r = rig();
    const first = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    r.svc.decide({ requestId: first.requestId, decision: 'always' }, 'desktop');
    r.state.wakes.set(DEV.id, { wakeId: 'w-2', attempt: 1, threadId: null, tainted: false });
    // The Windows E2E: verifier passed, author trusted, the repository has no checks at all.
    r.state.ruleCheck = 'required-checks-green:no-required-checks';
    const second = await r.ask(DEV, { action: 'merge', prNumber: 2, reason: 'y' });
    expect(view(r, second.requestId)).toMatchObject({ state: 'pending', ruleSkippedCondition: 'noChecks', ruleSkippedText: 'The repository has no required checks' });
    // Several unmet: the verifier first, as Settings lists them.
    r.state.wakes.set(DEV.id, { wakeId: 'w-3', attempt: 1, threadId: null, tainted: false });
    r.state.heads.set(3, HEAD2);
    r.state.ruleCheck = 'required-checks-green:required-check-failure, author-trusted:external-author, verifier-pass-at-head:no-verdict';
    const third = await r.ask(DEV, { action: 'merge', prNumber: 3, reason: 'z' });
    expect(view(r, third.requestId)).toMatchObject({ ruleSkippedCondition: 'verifier', ruleSkippedText: 'No verifier recorded a verdict' });
    // A code that is none of the rule's conditions keeps main's words.
    r.state.wakes.set(DEV.id, { wakeId: 'w-4', attempt: 1, threadId: null, tainted: false });
    r.state.heads.set(4, HEAD2);
    r.state.ruleCheck = 'lane-daily-cap';
    const fourth = await r.ask(DEV, { action: 'merge', prNumber: 4, reason: 'z' });
    expect(view(r, fourth.requestId)).toMatchObject({ ruleSkippedText: 'Today\'s lane merge limit is reached' });
    expect(view(r, fourth.requestId).ruleSkippedCondition).toBeUndefined();
  });

  it('a rule covers the bot that asked: the coordinator\'s rule does not cover the developer\'s request, and the card says so', async () => {
    const r = rig();
    const coord = await r.ask(OTHER, { action: 'merge', prNumber: 1, reason: 'x' });
    const res = r.svc.decide({ requestId: coord.requestId, decision: 'always' }, 'desktop');
    expect(res).toMatchObject({ ok: true, rule: { scope: { botId: OTHER.id } } });
    const dev = await r.ask(DEV, { action: 'merge', prNumber: 2, reason: 'y' });
    expect(view(r, dev.requestId)).toMatchObject({ state: 'pending', ruleSkipped: 'rule-other-asker', ruleSkippedCondition: 'asker', ruleSkippedText: 'Your rule covers the merges another bot asks for' });
  });
});

describe('merges from before the start (review)', () => {
  it('settle the requests still pending for them, waking nobody', async () => {
    const notices: BotNoticeInput[] = [];
    const r = rig({ notice: (n) => notices.push(n) });
    const req = await r.ask(DEV, { action: 'merge', prNumber: 1, reason: 'x' });
    const other = await r.ask(DEV, { action: 'merge', prNumber: 2, reason: 'y' });
    r.svc.settleMergedSince([
      { id: 'f1', seq: 1, kind: 'pr.merged', at: 1, dedupeKey: 'a', repoKey: 'o/r', ref: { pr: 1 }, payload: {} },
      { id: 'f2', seq: 2, kind: 'ci.green', at: 1, dedupeKey: 'b', repoKey: 'o/r', ref: { pr: 2 }, payload: {} },
    ]);
    expect(r.svc.get(req.requestId)?.state).toBe('expired');
    expect(r.svc.get(other.requestId)?.state).toBe('pending');
    expect(notices).toEqual([]);
  });
});
