import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MoaAskBody, MoaAsker } from '../../../shared/moaAsk';
import { ticketView } from '../../../shared/moaDecision';
import { shadowPacketHash } from '../moaShadowJudge';
import {
  MOA_DECISION_RETENTION_MS,
  MOA_ESCALATION_TTL_MS,
  MoaDecisionStore,
  moaQuestionHash,
} from '../moaDecisionStore';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-moa-decisions-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const ASKER: MoaAsker = { ptyId: 'pty-1', workspaceId: 'ws-1', agent: 'claude' };
const OTHER_PANE: MoaAsker = { ptyId: 'pty-2', workspaceId: 'ws-1', agent: 'claude' };
const Q: MoaAskBody = { type: 'question', question: 'Reuse the helper?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] };
const Q2: MoaAskBody = { type: 'question', question: 'Rename it?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] };
const HEAD = '995e9d9a3124628f51c0a3989bf2eced7ea2f97c';
const MERGE: MoaAskBody = { type: 'merge', prNumber: 1858, expectHead: HEAD };
const ESCALATE = { status: 'escalated' as const, judge: null, ruleId: null, reasonCode: 'no-rule', why: '' };
const file = (): string => path.join(dir, 'moa-delegate', 'decisions.json');

async function newTicket(store: MoaDecisionStore, body: MoaAskBody = Q, askId?: string) {
  const r = await store.begin({ asker: ASKER, body, mode: 'auto', ...(askId ? { askId } : {}) });
  if (r.kind !== 'new') throw new Error(`expected new, got ${r.kind}`);
  return r.decision;
}

describe('moaQuestionHash', () => {
  it('a question hashes exactly like shadowPacketHash', () => {
    expect(moaQuestionHash(ASKER, { ...Q, topic: 'x', context: 'ignored' })).toBe(
      shadowPacketHash({ question: Q.question, choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], asker: ASKER }),
    );
  });

  it('a merge hashes its typed target and asker', () => {
    const h = moaQuestionHash(ASKER, MERGE);
    expect(h).toMatch(/^[a-f0-9]{32}$/);
    expect(moaQuestionHash(ASKER, { ...MERGE, expectHead: 'c'.repeat(40) })).not.toBe(h);
    expect(moaQuestionHash(OTHER_PANE, MERGE)).not.toBe(h);
  });
});

describe('MoaDecisionStore idempotency (AnswerReceiptStore semantics)', () => {
  it('same key and body while running → the same ticket, pending, replayed', async () => {
    const store = new MoaDecisionStore(dir);
    const d = await newTicket(store, Q, 'ask-1');
    const again = await store.begin({ asker: ASKER, askId: 'ask-1', body: Q, mode: 'auto' });
    expect(again).toMatchObject({ kind: 'replay', decision: { ticketId: d.ticketId, status: 'pending', receipt: 'inFlight' } });
  });

  it('same key and body when finished → the stored result again', async () => {
    const store = new MoaDecisionStore(dir);
    const d = await newTicket(store, Q, 'ask-1');
    await store.settle(d.id, { status: 'answered', judge: null, ruleId: 'R-x', reasonCode: 'rule_match', why: 'w', answer: { choiceKey: '1' } });
    const again = await store.begin({ asker: ASKER, askId: 'ask-1', body: Q, mode: 'auto' });
    expect(again.kind).toBe('replay');
    if (again.kind === 'replay') expect(ticketView(again.decision)).toMatchObject({ status: 'answered', answer: { choiceKey: '1', ruleId: 'R-x', resolvedBy: 'moa-auto' } });
  });

  it('same askId with another body → id-reused; without askId a new body is a new ticket', async () => {
    const store = new MoaDecisionStore(dir);
    const d = await newTicket(store, Q, 'ask-1');
    expect(await store.begin({ asker: ASKER, askId: 'ask-1', body: Q2, mode: 'auto' })).toMatchObject({ kind: 'reused', decision: { id: d.id } });
    const plain = await newTicket(store, Q);
    expect(plain.id).not.toBe(d.id);
    expect(await store.begin({ asker: ASKER, body: Q, mode: 'auto' })).toMatchObject({ kind: 'replay', decision: { id: plain.id } });
    expect((await store.begin({ asker: ASKER, body: Q2, mode: 'auto' })).kind).toBe('new');
  });

  it('keys are per asker: another pane\'s askId is its own, and cannot read the first one\'s ticket', async () => {
    const store = new MoaDecisionStore(dir);
    const d = await newTicket(store, Q, 'ask-1');
    expect((await store.begin({ asker: OTHER_PANE, askId: 'ask-1', body: Q2, mode: 'auto' })).kind).toBe('new');
    expect(store.getForAsker(ASKER, d.ticketId)?.id).toBe(d.id);
    expect(store.getForAsker(OTHER_PANE, d.ticketId)).toBeNull();
  });

  it('a ticket in flight when main stopped comes back uncertain: escalated to the asker, never judged again', async () => {
    const store = new MoaDecisionStore(dir);
    const d = await newTicket(store, Q, 'ask-1');
    const reloaded = new MoaDecisionStore(dir);
    const again = await reloaded.begin({ asker: ASKER, askId: 'ask-1', body: Q, mode: 'auto' });
    expect(again).toMatchObject({ kind: 'replay', decision: { id: d.id, receipt: 'uncertain' } });
    if (again.kind === 'replay') expect(ticketView(again.decision)).toMatchObject({ status: 'escalated', reasonCode: 'restart-uncertain' });
    // settle only applies to inFlight: the uncertain ticket keeps its state.
    expect(await reloaded.settle(d.id, { ...ESCALATE })).toBeNull();
  });

  it('the record is on disk before it is judged, and a failed write keeps nothing', async () => {
    const store = new MoaDecisionStore(dir);
    await newTicket(store);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toMatchObject({ version: 1, decisions: [{ status: 'pending', receipt: 'inFlight' }] });
    fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, 'moa-delegate'), 'not a dir');
    await expect(store.begin({ asker: ASKER, body: Q2, mode: 'auto' })).rejects.toThrow();
    expect(store.list()).toHaveLength(1);
  });

  it('a full asker\'s new asks are refused; replays still work', async () => {
    const store = new MoaDecisionStore(dir, Date.now, 1);
    await newTicket(store);
    expect(await store.begin({ asker: ASKER, body: Q2, mode: 'auto' })).toEqual({ kind: 'full' });
    expect((await store.begin({ asker: ASKER, body: Q, mode: 'auto' })).kind).toBe('replay');
  });

  it('a malformed file refuses to load (strict, like the receipt store)', () => {
    fs.mkdirSync(path.join(dir, 'moa-delegate'), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: 1, decisions: [{ id: 'nope' }] }));
    expect(() => new MoaDecisionStore(dir)).toThrow('Invalid moa decision entry');
  });

  it('a stored body the validator would not produce refuses to load', async () => {
    const store = new MoaDecisionStore(dir);
    await newTicket(store);
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(() => new MoaDecisionStore(dir)).not.toThrow();
    for (const body of [{ type: 'question', question: 'q?' }, { type: 'question', question: 'q?', options: [{ key: '1', label: 'only' }] }, { type: 'merge', prNumber: 1, expectHead: 'short' }]) {
      fs.writeFileSync(file(), JSON.stringify({ ...saved, decisions: [{ ...saved.decisions[0], body }] }));
      expect(() => new MoaDecisionStore(dir), JSON.stringify(body)).toThrow('Invalid moa decision entry');
    }
  });

  it('a reused askId with any body change is id-reused, even one the question hash leaves out', async () => {
    const store = new MoaDecisionStore(dir);
    await newTicket(store, Q, 'ask-1');
    const changed: MoaAskBody = { ...Q, options: [{ key: '1', label: 'Yes', description: 'and delete the old one' }, { key: '2', label: 'No' }] };
    expect((await store.begin({ asker: ASKER, askId: 'ask-1', body: changed, mode: 'auto' })).kind).toBe('reused');
  });

  it('an askId spelled like a generated key cannot reach the ticket of an ask without one', async () => {
    const store = new MoaDecisionStore(dir);
    const d = await newTicket(store, Q);
    const r = await store.begin({ asker: ASKER, askId: `q:${moaQuestionHash(ASKER, Q)}`, body: Q, mode: 'auto' });
    expect(r.kind).toBe('new');
    expect(r.kind === 'new' && r.decision.ticketId).not.toBe(d.ticketId);
  });

  it('another agent in the same pane cannot read the ticket', async () => {
    const store = new MoaDecisionStore(dir);
    const d = await newTicket(store, Q);
    expect(store.getForAsker({ ...ASKER, agent: 'codex' }, d.ticketId)).toBeNull();
    expect(store.getForAsker(ASKER, d.ticketId)?.id).toBe(d.id);
  });

  it('an unreadable file refuses to load instead of starting empty', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '{ torn');
    expect(() => new MoaDecisionStore(dir)).toThrow();
  });

  it('a merge decision stored before facts existed still loads; malformed facts refuse the file', async () => {
    const store = new MoaDecisionStore(dir);
    const d = await newTicket(store, MERGE);
    await store.settle(d.id, { ...ESCALATE, lane: { ok: true, reasons: [] } });
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(saved.decisions[0]).not.toHaveProperty('facts');
    const reloaded = new MoaDecisionStore(dir).list()[0];
    expect(reloaded).toMatchObject({ id: d.id, lane: { ok: true, reasons: [] } });
    expect(reloaded?.facts).toBeUndefined();
    fs.writeFileSync(file(), JSON.stringify({ ...saved, decisions: [{ ...saved.decisions[0], facts: { number: 'x' } }] }));
    expect(() => new MoaDecisionStore(dir)).toThrow('Invalid moa decision entry');
  });

  it('a stored answer of the wrong shape refuses to load', async () => {
    const store = new MoaDecisionStore(dir);
    const d = await newTicket(store, Q);
    await store.settle(d.id, { status: 'answered', judge: null, ruleId: 'R-x', reasonCode: 'rule_match', why: 'w', answer: { choiceKey: '1' } });
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    saved.decisions[0].answer = {};
    fs.writeFileSync(file(), JSON.stringify(saved));
    expect(() => new MoaDecisionStore(dir)).toThrow();
  });

  it('old records are pruned after the retention', async () => {
    let now = 1_000_000;
    const store = new MoaDecisionStore(dir, () => now);
    await newTicket(store);
    now += MOA_DECISION_RETENTION_MS + 1;
    expect(store.list()).toHaveLength(0);
  });
});

describe('MoaDecisionStore settling', () => {
  it('escalated stays open for the owner; refused and answered are final', async () => {
    const store = new MoaDecisionStore(dir);
    const a = await newTicket(store, Q);
    expect(await store.settle(a.id, ESCALATE)).toMatchObject({ status: 'escalated', resolvedBy: null, resolvedAt: null, receipt: 'done' });
    const b = await newTicket(store, Q2);
    expect(await store.settle(b.id, { ...ESCALATE, status: 'refused', reasonCode: 'head-moved' })).toMatchObject({ status: 'refused', resolvedBy: 'refused', receipt: 'refused' });
    await expect(store.settle((await newTicket(store, MERGE)).id, { ...ESCALATE, status: 'answered' })).rejects.toThrow('needs an answer');
  });

  it('the owner answers an escalated question with one of its choices', async () => {
    const store = new MoaDecisionStore(dir);
    const d = await newTicket(store, Q);
    expect(await store.resolveByOwner(d.id, { type: 'choice', choiceKey: '2' })).toMatchObject({ ok: false, code: 'not-open' });
    await store.settle(d.id, ESCALATE);
    expect(await store.resolveByOwner(d.id, { type: 'choice', choiceKey: '9' })).toMatchObject({ ok: false, code: 'invalid' });
    const r = await store.resolveByOwner(d.id, { type: 'choice', choiceKey: '2' });
    expect(r).toMatchObject({ ok: true, decision: { status: 'answered', resolvedBy: 'owner', answer: { choiceKey: '2' } } });
    expect(await store.resolveByOwner(d.id, { type: 'dismiss' })).toMatchObject({ ok: false, code: 'not-open' });
  });

  it('a merge card must name the decision\'s head', async () => {
    const store = new MoaDecisionStore(dir);
    const d = await newTicket(store, MERGE);
    await store.settle(d.id, ESCALATE);
    expect(await store.resolveByOwner(d.id, { type: 'merge', approve: true, expectHead: 'c'.repeat(40) })).toMatchObject({ ok: false, code: 'stale' });
    expect(await store.resolveByOwner(d.id, { type: 'merge', approve: true, expectHead: HEAD })).toMatchObject({
      ok: true, decision: { status: 'answered', answer: { actionVerdict: 'go' }, reasonCode: 'owner-approved' },
    });
  });

  it('the owner may settle a restart-uncertain ticket', async () => {
    const store = new MoaDecisionStore(dir);
    const d = await newTicket(store, Q);
    const reloaded = new MoaDecisionStore(dir);
    expect(await reloaded.resolveByOwner(d.id, { type: 'dismiss' })).toMatchObject({ ok: true, decision: { status: 'refused', reasonCode: 'dismissed', receipt: 'done' } });
  });

  it('an escalation the owner never answered expires', async () => {
    let now = 1_000_000;
    const store = new MoaDecisionStore(dir, () => now);
    const d = await newTicket(store, Q);
    await store.settle(d.id, ESCALATE);
    expect(await store.expire()).toHaveLength(0);
    now += MOA_ESCALATION_TTL_MS + 1;
    const [e] = await store.expire();
    expect(e).toMatchObject({ id: d.id, resolvedBy: 'expired', status: 'escalated' });
    expect(await store.resolveByOwner(d.id, { type: 'dismiss' })).toMatchObject({ ok: false, code: 'not-open' });
  });

  it('an expiry that cannot be written is rolled back', async () => {
    let now = 1_000_000;
    const store = new MoaDecisionStore(dir, () => now);
    const d = await newTicket(store, Q);
    await store.settle(d.id, ESCALATE);
    now += MOA_ESCALATION_TTL_MS + 1;
    fs.rmSync(path.join(dir, 'moa-delegate'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, 'moa-delegate'), 'not a dir');
    await expect(store.expire()).rejects.toThrow();
    expect(store.get(d.id)).toMatchObject({ resolvedBy: null });
  });
});
