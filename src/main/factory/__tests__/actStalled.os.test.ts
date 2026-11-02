// A claimed act row has a bound of its own (#2752): a row an earlier try
// left claimed is not aged out with its approval (#2742), since it may be on
// GitHub, so a row whose reads keep failing would be tried, or read, forever.
// Past ACT_STALL_MAX_MS from its first try and ACT_STALL_MIN_TRIES reads
// GitHub did not answer, no write is sent for it again: a read that finds
// nothing refuses it, and while reads still cannot say the owner is told once
// that it may be on GitHub. A read that finds it settles it as ever.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotBinding, BotProfile } from '../../../shared/bot';
import { APPROVAL_UNDO_MS } from '../../../shared/botApproval';
import type { GhActAnswer } from '../../github/GhActService';
import { ApprovalService, type ApprovalActHost, type ApprovalPorts } from '../approvals';
import { RoomWriter } from '../roomWriter';
import { ACT_STALL_MAX_MS, ACT_STALL_MIN_TRIES, ActEffectStore, actEffectId } from '../actEffectStore';
import { ActExecutor, readIssue, readLogin, readPull, readRepo } from '../actExecutor';
import { readReleaseAsk } from '../releaseAct';
import { FakeGithub } from './fakeGithubActs';

const WS = 'ws-1';
const HEAD = 'a'.repeat(40);
const HOUR = 3600_000;
const STALE = 'The approval is more than a day old and nothing was done: the bot asks again if it is still wanted';

const DEV: BotProfile = {
  version: 1, id: 'bot-0000abcd', workspaceId: WS, role: 'lead', name: 'Bot dev', engine: { kind: 'claude-sdk' }, triggers: [],
  budget: { maxTurnsPerDay: 9, maxConcurrentWorkers: 1, maxWorkerHoursPerDay: 1, turnTimeoutMs: 1 } as BotProfile['budget'],
  repo: { repoKey: 'o/r', repoPath: '/repo' }, enabled: true, createdAt: 0, updatedAt: 0,
};
const binding: BotBinding = { workspaceId: WS, botId: DEV.id, role: 'lead' };
const COMMENT = { action: 'comment', prNumber: 1, reason: 'the fix is in', body: 'Fixed in this PR.' };

/** A read GitHub did not answer (no HTTP status). */
const READ_FAILS: GhActAnswer = { ok: false, kind: 'error', message: 'gh: timeout' };
/** A write that timed out: uncertain. */
const WRITE_TIMES_OUT: GhActAnswer = { ok: false, kind: 'error', message: 'timeout' };

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-act-stalled-'));
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function rig() {
  const gh = new FakeGithub();
  gh.addPull(1, HEAD);
  const writer = new RoomWriter({ dir: path.join(dir, 'rooms') });
  const effects = new ActEffectStore(path.join(dir, 'factory', 'act-effects.json'));
  let svc: ApprovalService | null = null;
  const executor = new ActExecutor({
    effects,
    gh,
    approval: { request: (id) => svc?.get(id) ?? null, authorize: (e) => (svc ? svc.authorizeAct(e) : 'approval-not-running') },
    emit: (e) => svc?.onActEffect(e),
    stalled: (e) => svc?.onActStalled(e),
  });
  const host: ApprovalActHost = {
    login: () => readLogin(gh, 'github.com'),
    repo: (k) => readRepo(gh, k),
    issue: (k, n) => readIssue(gh, k, n),
    pull: (k, n) => readPull(gh, k, n),
    release: (k, input) => readReleaseAsk(gh, k, input),
    enqueue: (r) => (r.act && r.payloadHash ? effects.enqueue({ requestId: r.requestId, action: r.act.kind, repoKey: r.repoKey, payloadHash: r.payloadHash }) : null),
    run: (id) => executor.run(id),
    effect: (id) => effects.get(id),
    remove: (id) => effects.remove(id),
  };
  const notices: string[] = [];
  const ports: ApprovalPorts = {
    file: path.join(dir, 'factory', 'approvals.json'),
    bots: () => ({ listEnabled: () => [DEV], get: (id) => (id === DEV.id ? DEV : null) }),
    runningWake: () => ({ wakeId: 'w-1', attempt: 1, threadId: null, tainted: false, guest: false, signedIn: false }),
    readPr: async () => { throw new Error('not used'); },
    ghLogin: async () => 'owner',
    rooms: () => writer,
    merge: () => null,
    acts: () => host,
    notice: (n) => notices.push(n.title),
    now: () => Date.now(),
    log: () => undefined,
  };
  svc = new ApprovalService(ports);
  const service = svc;
  /** Ask, approve, and run the first try: its write times out (`landed`:
   *  whether it reached GitHub all the same), so the row is uncertain. */
  const approvedUncertain = async (landed: boolean) => {
    const res = await service.request(binding, COMMENT);
    if (!res.ok) throw new Error(`refused: ${res.code} ${res.message}`);
    expect(service.decide({ requestId: res.request.requestId, decision: 'approve', payloadHash: res.request.payloadHash }, 'desktop')).toMatchObject({ ok: true });
    gh.nextWrite = { answer: WRITE_TIMES_OUT, landed };
    await vi.advanceTimersByTimeAsync(APPROVAL_UNDO_MS + 10);
    await executor.idle();
    const id = actEffectId(res.request.requestId);
    const row = effects.get(id);
    expect(row).toMatchObject({ status: 'uncertain', attempt: 1 });
    return { requestId: res.request.requestId, id, firstTry: row?.firstStartedAt as number };
  };
  const sweepAt = async (at: number) => {
    vi.setSystemTime(at);
    await executor.reconcileAll();
  };
  /** One sweep every two hours from `from`, `n` of them; the last one's time. */
  const sweeps = async (from: number, n: number) => {
    let at = from;
    for (let i = 1; i <= n; i += 1) {
      at = from + i * 2 * HOUR;
      await sweepAt(at);
    }
    return at;
  };
  const cards = (requestId: string) => writer.read(WS, {}).cards.filter((c) => c.refs?.approvalId === requestId && c.actor.kind === 'system');
  return { svc: service, gh, effects, notices, approvedUncertain, sweepAt, sweeps, cards };
}

describe('a claimed act row whose reads keep failing', () => {
  it('a row an earlier try left at attempt 1, whose reads before the write keep failing, is not written again past its bound: a read that finds nothing refuses it', async () => {
    const r = rig();
    const a = await r.approvedUncertain(false);
    // Each sweep reads the comments (nothing there: pending), claims a try,
    // and its identity read fails: the try is given back at attempt 1.
    r.gh.answerRead = (e) => (e === 'user' ? READ_FAILS : null);
    await r.sweeps(a.firstTry, ACT_STALL_MIN_TRIES);
    expect(r.effects.get(a.id)).toMatchObject({ status: 'pending', attempt: 1, reason: 'read-failed', readUnansweredTries: ACT_STALL_MIN_TRIES, lastReadError: 'gh: timeout' });
    expect(r.svc.get(a.requestId)?.state).toBe('approved');

    // Past both bounds GitHub answers again; the read finds nothing, and no
    // write is sent: the row is refused, its card and its bot told.
    r.gh.answerRead = null;
    await r.sweepAt(a.firstTry + ACT_STALL_MAX_MS + 1);
    expect(r.gh.writes).toHaveLength(1);
    expect(r.gh.comments).toEqual([]);
    expect(r.effects.get(a.id)).toMatchObject({ status: 'refused', attempt: 1, reason: 'approval-stale' });
    expect(r.svc.get(a.requestId)).toMatchObject({ state: 'refused', refusal: 'approval-stale' });
    expect(r.cards(a.requestId).map((c) => c.title)).toEqual([`Not done: Comment on PR #1 (${STALE})`]);
    expect(r.cards(a.requestId)[0].body).toContain('Last read error: gh: timeout');
    expect(r.notices).toContain(`Not done: Comment on PR #1 (${STALE}).`);
  });

  it('an uncertain row whose read cannot say tells the owner once past its bound, and keeps reading', async () => {
    const r = rig();
    const a = await r.approvedUncertain(false);
    r.gh.answerRead = () => READ_FAILS;
    // Enough reads, not yet a day from the first try: nothing told.
    const last = await r.sweeps(a.firstTry - HOUR, ACT_STALL_MIN_TRIES);
    expect(last - a.firstTry).toBeLessThan(ACT_STALL_MAX_MS);
    expect(r.cards(a.requestId)).toEqual([]);
    expect(r.effects.get(a.id)).toMatchObject({ status: 'uncertain', readUnansweredTries: ACT_STALL_MIN_TRIES });

    await r.sweeps(last, 4);
    const told = r.cards(a.requestId);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      kind: 'status',
      clientPostId: `approval-outcome:${a.requestId}:stalled`,
      title: 'Not confirmed: Comment on PR #1 (GitHub has not said for a day whether it went through)',
    });
    expect(told[0].body).toContain('It may be on GitHub: check there');
    expect(told[0].body).toContain('Last read error: gh: timeout');
    expect(r.notices.filter((n) => n.startsWith('Not confirmed:'))).toHaveLength(1);
    // Still the read's to settle: approved, uncertain, nothing written again.
    expect(r.svc.get(a.requestId)?.state).toBe('approved');
    expect(r.effects.get(a.id)).toMatchObject({ status: 'uncertain', attempt: 1 });
    expect(r.gh.writes).toHaveLength(1);
  });

  it('a row past its bound whose read later finds the act is done as ever', async () => {
    const r = rig();
    const a = await r.approvedUncertain(true);
    r.gh.answerRead = () => READ_FAILS;
    const last = await r.sweeps(a.firstTry, ACT_STALL_MIN_TRIES + 2);
    expect(r.cards(a.requestId).map((c) => c.clientPostId)).toEqual([`approval-outcome:${a.requestId}:stalled`]);

    r.gh.answerRead = null;
    await r.sweepAt(last + 2 * HOUR);
    expect(r.effects.get(a.id)).toMatchObject({ status: 'done', attempt: 1 });
    expect(r.svc.get(a.requestId)?.state).toBe('executed');
    expect(r.gh.comments).toHaveLength(1);
    expect(r.gh.writes).toHaveLength(1);
    expect(r.cards(a.requestId).map((c) => c.clientPostId)).toEqual([`approval-outcome:${a.requestId}:stalled`, `approval-outcome:${a.requestId}`]);
  });
});
