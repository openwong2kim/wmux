// The owner's answer reaches the asker's pane: an escalated moa_ask ticket the
// owner resolves in the panel is pasted back into the asker's pane exactly
// once, and recorded on the decision. A busy pane waits; an asker that read
// the answer itself is not told twice. Real stores in a tmp dir, a fake pane.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MoaAsker, MoaAskRequest } from '../../../shared/moaAsk';
import { MoaDecisionStore, countOpenTicketsReadOnly } from '../moaDecisionStore';
import { MoaEffectStore } from '../moaEffectStore';
import { MoaMergeExecutor } from '../moaMergeExecutor';
import { MoaAskService, ESCALATED_NEXT } from '../moaAskService';
import { answerLine, type AskerPaneState, type CourierSendResult } from '../moaAnswerCourier';
import { parsePolicyBook } from '../deckPolicy';
import type { JudgeRunResult } from '../moaShadowJudge';

const ASKER: MoaAsker = { ptyId: 'pty-1', workspaceId: 'ws-1', agent: 'claude' };
const BOOK = '# Policy\n- [R-reuse] Prefer reusing an existing helper over writing a new one.\n';
const Q_REQ: MoaAskRequest = {
  body: { type: 'question', question: 'Rerun the flaky job?', options: [{ key: 'rerun', label: 'Re-run the failed job once' }, { key: 'look', label: 'Investigate now' }] },
};
const ESCALATE: JudgeRunResult = { reply: JSON.stringify({ verdict: 'escalate', reasonCode: 'unclear', why: 'no rule covers it' }), tokens: { input: 1, output: 1 }, ms: 3 };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-moa-courier-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function build(opts: { pane: () => AskerPaneState; send?: (text: string) => Promise<CourierSendResult> }) {
  const decisions = new MoaDecisionStore(dir);
  const effects = new MoaEffectStore(dir);
  const timers: Array<() => void> = [];
  const sent: string[] = [];
  const send = vi.fn(async (_asker: MoaAsker, text: string): Promise<CourierSendResult> => {
    sent.push(text);
    return opts.send ? opts.send(text) : { ok: true };
  });
  const readFresh = vi.fn(async () => { throw new Error('unused'); });
  let service: MoaAskService | null = null;
  const executor = new MoaMergeExecutor({
    effects,
    facts: { readFresh },
    merge: async () => ({ ok: true }),
    laneContext: (e) => (service as MoaAskService).laneContext(e),
    authorize: (e) => (service as MoaAskService).authorize(e),
    emit: () => undefined,
    log: () => undefined,
  });
  service = new MoaAskService({
    decisions,
    effects,
    executor,
    facts: { readFresh },
    getConfig: () => ({ mode: 'suggest', autoRules: [], trustedAuthors: [] }),
    setAutoRules: async () => true,
    loadBook: () => ({ ...parsePolicyBook(BOOK), text: BOOK }),
    judge: async () => ESCALATE,
    readScreen: async () => [],
    resolveRepo: async () => null,
    askerBranches: async () => [],
    answerPane: { state: () => opts.pane(), send, retryMs: 10, setTimer: (fn) => { timers.push(fn); } },
    log: () => undefined,
  });
  /** Run the timers queued so far (the courier's retries). */
  const tick = async () => {
    const due = timers.splice(0);
    for (const fn of due) fn();
    await new Promise((r) => setTimeout(r, 5));
  };
  return { service, decisions, send, sent, tick, timers };
}

async function escalatedTicket(h: ReturnType<typeof build>) {
  const r = await h.service.ask(ASKER, '/repo', Q_REQ);
  if (!r.ok) throw new Error(r.code);
  await h.service.idle();
  const s = await h.service.status(ASKER, r.ticket.ticketId);
  if (!s.ok) throw new Error(s.code);
  return { ticketId: r.ticket.ticketId, view: s.ticket, decision: h.decisions.list()[0] };
}

describe('the answer goes back to the asker', () => {
  it('an escalated ticket tells the asker to end its turn without restating it', async () => {
    const h = build({ pane: () => 'idle' });
    const { view } = await escalatedTicket(h);
    expect(view.status).toBe('escalated');
    expect(view.next).toBe(ESCALATED_NEXT);
    expect(view.next).toContain('without restating the question');
    // Nothing was pasted while it waits on the owner.
    expect(h.send).not.toHaveBeenCalled();
  });

  it('resolving it delivers exactly once, and records it on the decision', async () => {
    const h = build({ pane: () => 'idle' });
    const { ticketId, decision } = await escalatedTicket(h);
    const r = await h.service.resolveByOwner({ decisionId: decision.id, answer: { type: 'choice', choiceKey: 'rerun' } });
    expect(r.ok).toBe(true);
    await vi.waitFor(() => expect(h.decisions.get(decision.id)?.delivery?.state).toBe('delivered'));
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.sent[0]).toBe(`[wmux] Moa ticket ${ticketId}: the owner chose "Re-run the failed job once" (option rerun). Continue your task with this answer.`);
    const rec = h.decisions.get(decision.id)!;
    expect(rec.delivery).toMatchObject({ state: 'delivered', agent: 'claude' });
    // On disk too, and a second resolve or a restart does not send it again.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'moa-delegate', 'decisions.json'), 'utf8')).decisions[0].delivery.state).toBe('delivered');
    const again = await h.service.resolveByOwner({ decisionId: decision.id, answer: { type: 'choice', choiceKey: 'look' } });
    expect(again.ok).toBe(false);
    await h.service.start();
    await h.tick();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('a busy pane waits; the paste goes once it is idle', async () => {
    let pane: AskerPaneState = 'busy';
    const h = build({ pane: () => pane });
    const { decision } = await escalatedTicket(h);
    await h.service.resolveByOwner({ decisionId: decision.id, answer: { type: 'choice', choiceKey: 'look' } });
    await vi.waitFor(() => expect(h.decisions.get(decision.id)?.delivery?.state).toBe('waiting'));
    await h.tick();
    await h.tick();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.timers.length).toBe(1); // one retry queued, not a pile
    pane = 'idle';
    await h.tick();
    await vi.waitFor(() => expect(h.decisions.get(decision.id)?.delivery?.state).toBe('delivered'));
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('someone typing: refused before the paste, retried, then delivered once', async () => {
    let n = 0;
    const h = build({ pane: () => 'idle', send: async () => (++n === 1 ? { ok: false, retry: true, reason: 'user_typing' } : { ok: true }) });
    const { decision } = await escalatedTicket(h);
    await h.service.resolveByOwner({ decisionId: decision.id, answer: { type: 'choice', choiceKey: 'look' } });
    await vi.waitFor(() => expect(h.decisions.get(decision.id)?.delivery?.reason).toBe('user_typing'));
    await h.tick();
    await vi.waitFor(() => expect(h.decisions.get(decision.id)?.delivery?.state).toBe('delivered'));
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('the asker read the answer itself while its pane was busy: nothing is pasted', async () => {
    const h = build({ pane: () => 'busy' });
    const { ticketId, decision } = await escalatedTicket(h);
    await h.service.resolveByOwner({ decisionId: decision.id, answer: { type: 'choice', choiceKey: 'rerun' } });
    const s = await h.service.status(ASKER, ticketId);
    expect(s.ok && s.ticket.status).toBe('answered');
    expect(h.decisions.get(decision.id)?.delivery?.state).toBe('seen');
    await h.tick();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a closed pane fails the delivery, visibly', async () => {
    const h = build({ pane: () => 'gone' });
    const { decision } = await escalatedTicket(h);
    await h.service.resolveByOwner({ decisionId: decision.id, answer: { type: 'dismiss' } });
    await vi.waitFor(() => expect(h.decisions.get(decision.id)?.delivery).toMatchObject({ state: 'failed', reason: 'pane-gone' }));
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a paste started when main stopped is never sent again', async () => {
    const h = build({ pane: () => 'idle', send: () => new Promise(() => undefined) });
    const { decision } = await escalatedTicket(h);
    await h.service.resolveByOwner({ decisionId: decision.id, answer: { type: 'choice', choiceKey: 'rerun' } });
    await vi.waitFor(() => expect(h.decisions.get(decision.id)?.delivery?.state).toBe('sending'));
    const reloaded = new MoaDecisionStore(dir);
    expect(reloaded.get(decision.id)?.delivery).toMatchObject({ state: 'failed', reason: 'restart' });
  });
});

describe('answerLine', () => {
  it('names the ticket and the verdict, on one line', async () => {
    const h = build({ pane: () => 'busy' });
    const { decision } = await escalatedTicket(h);
    expect(answerLine(decision)).toBeNull(); // still open: nothing to tell
    const base = { ...decision, status: 'answered' as const, resolvedBy: 'owner' as const, resolvedAt: 1 };
    const merge = { ...base, kind: 'merge' as const, body: { type: 'merge' as const, prNumber: 44, expectHead: 'a'.repeat(40) } };
    expect(answerLine({ ...merge, answer: { actionVerdict: 'go' } })).toContain('the owner approved merging PR #44 at aaaaaaa');
    expect(answerLine({ ...merge, answer: { actionVerdict: 'no-go' } })).toContain('declined merging PR #44 at aaaaaaa. Do not merge it.');
    const label = { ...base, body: { ...Q_REQ.body, options: [{ key: 'x', label: 'two\nlines\u001b[2J' }, { key: 'y', label: 'B' }] }, answer: { choiceKey: 'x' } } as typeof base;
    // eslint-disable-next-line no-control-regex
    expect(answerLine(label)).not.toMatch(/[\n\u001b]/);
  });
});

describe('countOpenTicketsReadOnly (the panel notice while the delegate is off)', () => {
  it('counts escalated tickets without writing, and creates nothing when there is no file', async () => {
    expect(countOpenTicketsReadOnly(dir)).toBe(0);
    expect(fs.existsSync(path.join(dir, 'moa-delegate'))).toBe(false);
    const h = build({ pane: () => 'busy' });
    await escalatedTicket(h);
    const file = path.join(dir, 'moa-delegate', 'decisions.json');
    const before = fs.readFileSync(file, 'utf8');
    const mtime = fs.statSync(file).mtimeMs;
    expect(countOpenTicketsReadOnly(dir)).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });
});
