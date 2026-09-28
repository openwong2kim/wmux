// OpenCode permissions/questions: the plugin's list becomes native records,
// and a registry answer becomes one plugin reply. Driven against the real
// registry so the fingerprint, the settled-request memory and the v1
// projection a shipped phone reads are the real ones.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalRegistry, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS } from '../ApprovalRegistry';
import { createOpenCodeDecisions, openCodeDecisionNote, openCodeReply } from '../openCodeDecisions';
import { TERMINAL_PROMPT_WEB_ANSWER, TERMINAL_PROMPT_WEB_DECLINE, type ApprovalEvent } from '../types';
import type { OpenCodeDecision, OpenCodeDecisionOutcome, OpenCodeDecisionReply, OpenCodeDecisionsRead } from '../../transcript/TerminalChatService';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-decisions-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const D = (n: number) => n.toString(16).padStart(32, '0');
const PERM = (requestId: string, sessionId = 'ses_root', digest = D(1), patterns = ['touch a.txt']): OpenCodeDecision =>
  ({ kind: 'permission', requestId, sessionId, digest, permission: 'bash', patterns });
const QUESTION: OpenCodeDecision = { kind: 'question', requestId: 'que_1', sessionId: 'ses_root', digest: D(2), questions: [
  { question: 'Which color?', header: 'Color', multiple: false, custom: true, options: [{ label: 'Red' }, { label: 'Blue' }] },
] };

function rig() {
  const clock = { now: 50_000 };
  let n = 0;
  const registry = new ApprovalRegistry({ wmuxDir: tmpDir, now: () => clock.now, newId: () => `r${++n}`,
    readScreenTail: async () => null, writeToSession: () => false,
    answerNative: async (native, reply, sessionId) => decisions.answer(native, reply, sessionId) });
  const events: ApprovalEvent[] = [];
  registry.onEvent((e) => events.push(e));
  const state: { read: OpenCodeDecisionsRead; replies: Array<{ pane: string; reply: OpenCodeDecisionReply }>; known: unknown[]; outcome: OpenCodeDecisionOutcome } =
    { read: { state: 'ok', routeSessionId: 'ses_root', decisions: [], gone: [] }, replies: [], known: [], outcome: 'ok' };
  const decisions = createOpenCodeDecisions({
    read: async (_pane, known) => { state.known.push(known); return state.read; },
    reply: async (pane, reply) => { state.replies.push({ pane, reply }); return state.outcome; },
    registry,
    workspaceOf: () => 'ws-1',
  });
  return { registry, decisions, state, events, clock };
}
const listed = (...decisions: OpenCodeDecision[]): OpenCodeDecisionsRead => ({ state: 'ok', routeSessionId: 'ses_root', decisions, gone: [] });

describe('OpenCode native decisions', () => {
  it('builds the same form for the same request, so a reconcile never flips the card', async () => {
    expect(openCodeDecisionNote(PERM('per_1'))).toEqual(openCodeDecisionNote(PERM('per_1')));
    const r = rig();
    r.state.read = listed(PERM('per_1'));
    expect(await r.decisions.reconcile('pty-1')).toBe('native');
    expect(await r.decisions.reconcile('pty-1')).toBe('native');
    expect(r.events.map((e) => e.type)).toEqual(['create']);
    const [record] = r.registry.list().pending;
    // What a shipped phone reads: a plain Yes/No terminal_prompt, `always` nowhere.
    expect(record).toMatchObject({ kind: 'terminal_prompt', question: 'Allow bash?', summary: 'touch a.txt', toolName: 'bash', workspaceId: 'ws-1',
      choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }], native: { adapter: 'opencode', requestId: 'per_1', nativeSessionId: 'ses_root', digest: D(1) } });
    expect(record!.promptFingerprint).toBe(record!.formFingerprint);
    expect(JSON.stringify(record)).not.toMatch(/always/i);
  });

  it('the same id asking something else is a new card: the old one cannot approve it', async () => {
    const r = rig();
    r.state.read = listed(PERM('per_1'));
    await r.decisions.reconcile('pty-1');
    const old = r.registry.list().pending[0]!;
    r.state.read = listed(PERM('per_1', 'ses_root', D(9), ['rm -rf /tmp/x']));
    await r.decisions.reconcile('pty-1');
    const fresh = r.registry.list().pending;
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ summary: 'rm -rf /tmp/x', native: { digest: D(9) } });
    expect(fresh[0]!.formFingerprint).not.toBe(old.formFingerprint);
    r.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    const stale = await r.registry.resolve({ id: old.id, decision: 'approve', choiceKey: '1', promptFingerprint: old.promptFingerprint, resolvedBy: 'phone', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER });
    expect(stale).toMatchObject({ ok: false });
    expect(r.state.replies).toEqual([]);
    // The plugin's own check right before the reply: a request changed after
    // the last read is refused, and the card stays up for the next read.
    r.state.outcome = 'changed';
    expect(await r.registry.resolve({ id: fresh[0]!.id, decision: 'approve', choiceKey: '1', promptFingerprint: fresh[0]!.promptFingerprint, resolvedBy: 'phone', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER }))
      .toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(r.state.replies.at(-1)!.reply).toMatchObject({ digest: D(9) });
    expect(r.registry.list().pending).toHaveLength(1);
  });

  it('a plugin refusal is final (invalid-choice), not a retryable outage', async () => {
    const r = rig();
    r.state.read = listed(PERM('per_1'));
    await r.decisions.reconcile('pty-1');
    r.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    r.state.outcome = 'refused';
    const [rec] = r.registry.list().pending;
    expect(await r.registry.resolve({ id: rec!.id, decision: 'approve', choiceKey: '1', promptFingerprint: rec!.promptFingerprint, resolvedBy: 'phone', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER }))
      .toMatchObject({ ok: false, reason: 'invalid-choice' });
  });

  it('several pending requests are separate cards; the plugin saying one is gone expires only that one', async () => {
    const r = rig();
    r.state.read = listed(PERM('per_1'), PERM('per_2', 'ses_child'), QUESTION);
    await r.decisions.reconcile('pty-1');
    expect(r.registry.list().pending.map((x) => x.native?.requestId)).toEqual(['per_1', 'per_2', 'que_1']);
    // The route moved: nothing listed, nothing gone — every card stays.
    r.state.read = { state: 'ok', routeSessionId: '', decisions: [], gone: [] };
    await r.decisions.reconcile('pty-1');
    expect(r.registry.list().pending).toHaveLength(3);
    // The daemon asks about what it holds, by each request's own session.
    expect(r.state.known.at(-1)).toEqual([
      { requestId: 'per_1', sessionId: 'ses_root' }, { requestId: 'per_2', sessionId: 'ses_child' }, { requestId: 'que_1', sessionId: 'ses_root' }]);
    r.state.read = { state: 'ok', routeSessionId: 'ses_root', decisions: [PERM('per_1'), QUESTION], gone: ['per_2'] };
    await r.decisions.reconcile('pty-1');
    expect(r.registry.list().pending.map((x) => x.native?.requestId)).toEqual(['per_1', 'que_1']);
  });

  it('covers a signalled request only when a native record now stands for it', async () => {
    const r = rig();
    r.state.read = listed(PERM('per_1'));
    expect(await r.decisions.covers('pty-1', 'per_1')).toBe('native');
    // Not listed (a child route, a grandchild, TUI state behind): missing.
    expect(await r.decisions.covers('pty-1', 'per_other')).toBe('missing');
    // Listed but with no answerable form: missing.
    r.state.read = listed({ ...PERM('per_long'), truncated: true });
    expect(await r.decisions.covers('pty-1', 'per_long')).toBe('missing');
    r.state.read = listed();
    expect(await r.decisions.covers('pty-1')).toBe('missing');
    r.state.read = { state: 'unsupported' };
    expect(await r.decisions.covers('pty-1', 'per_1')).toBe('unsupported');
  });

  it('a native record retires the informational card for its request; an id-less one only when all are covered', async () => {
    const r = rig();
    const card = async (requestId?: string) => {
      await r.registry.noteHookAwaitingInput({ sessionId: 'pty-1', agent: 'opencode', ...(requestId ? { requestId } : {}) });
      return r.registry.list().pending.find((x) => x.kind === 'awaiting_input' && !x.native)!;
    };
    const keyed = await card('per_1');
    r.state.read = listed(PERM('per_1'));
    await r.decisions.reconcile('pty-1');
    expect(r.registry.list().pending.map((x) => x.id)).not.toContain(keyed.id);
    const unkeyed = await card();
    r.state.read = listed(PERM('per_1'), { ...PERM('per_2'), truncated: true });
    await r.decisions.reconcile('pty-1');
    expect(r.registry.list().pending.map((x) => x.id)).toContain(unkeyed.id);
    r.state.read = listed(PERM('per_1'), PERM('per_3'));
    await r.decisions.reconcile('pty-1');
    expect(r.registry.list().pending.map((x) => x.id)).not.toContain(unkeyed.id);
  });

  it('no form for a request the plugin cut, or an option label that would not show as it is', () => {
    expect(openCodeDecisionNote({ ...QUESTION, truncated: true })).toBeNull();
    const q = (label: string): OpenCodeDecision => ({ kind: 'question', requestId: 'que_1', sessionId: 'ses_root', digest: D(2),
      questions: [{ question: 'Which?', header: '', multiple: false, custom: true, options: [{ label }] }] });
    expect(openCodeDecisionNote(q(' padded '))).toBeNull();
    expect(openCodeDecisionNote(q('tab\there'))).toBeNull();
    expect(openCodeDecisionNote(q('x'.repeat(200)))).not.toBeNull();
  });

  it('a plugin that predates decisions, or no answer, makes no record', async () => {
    const r = rig();
    r.state.read = { state: 'unsupported' };
    expect(await r.decisions.reconcile('pty-1')).toBe('unsupported');
    r.state.read = { state: 'unavailable' };
    expect(await r.decisions.reconcile('pty-1')).toBe('unavailable');
    expect(r.registry.list().pending).toEqual([]);
  });

  it("a shipped phone answers Yes, No and decline through the plugin, to the request's own session", async () => {
    const r = rig();
    r.state.read = listed(PERM('per_1', 'ses_child'), PERM('per_2'), PERM('per_3'));
    await r.decisions.reconcile('pty-1');
    r.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    const [a, b, c] = r.registry.list().pending;
    const answer = (id: string, decision: 'approve' | 'deny', key: string, fp: string) =>
      r.registry.resolve({ id, decision, choiceKey: key, promptFingerprint: fp, resolvedBy: 'phone', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER });
    const yes = await answer(a!.id, 'approve', '1', a!.promptFingerprint!);
    expect(yes).toMatchObject({ ok: true, request: { state: 'resolved' } });
    expect(yes.ok && yes.request.pressedAt).toBeUndefined();
    expect(await answer(b!.id, 'deny', '2', b!.promptFingerprint!)).toMatchObject({ ok: true });
    expect(await r.registry.resolve({ id: c!.id, decision: 'deny', resolvedBy: 'phone', terminalPromptDecline: TERMINAL_PROMPT_WEB_DECLINE })).toMatchObject({ ok: true });
    expect(r.state.replies).toEqual([
      { pane: 'pty-1', reply: { kind: 'permission', requestId: 'per_1', sessionId: 'ses_child', digest: D(1), reply: 'once' } },
      { pane: 'pty-1', reply: { kind: 'permission', requestId: 'per_2', sessionId: 'ses_root', digest: D(1), reply: 'reject' } },
      { pane: 'pty-1', reply: { kind: 'permission', requestId: 'per_3', sessionId: 'ses_root', digest: D(1), reply: 'reject' } },
    ]);
    // A second phone (or an offline queue replay) finds it answered.
    expect(await answer(a!.id, 'approve', '1', a!.promptFingerprint!)).toMatchObject({ ok: false, reason: 'already-resolved' });
  });

  it('maps registry answers to option indexes, never labels, and never to `always`', () => {
    const native = { adapter: 'opencode' as const, requestId: 'que_1', nativeSessionId: 'ses_root', digest: D(2) };
    expect(openCodeReply(native, { decision: 'approve', formKind: 'questions', answers: [{ keys: ['1'] }, { keys: ['2', '3'], other: 'x' }] }))
      .toEqual({ kind: 'question', requestId: 'que_1', sessionId: 'ses_root', digest: D(2), answers: [{ options: [0] }, { options: [1, 2], other: 'x' }] });
    expect(openCodeReply(native, { decision: 'deny', formKind: 'questions' })).toEqual({ kind: 'question', requestId: 'que_1', sessionId: 'ses_root', digest: D(2), reject: true });
    expect(openCodeReply(native, { decision: 'approve', formKind: 'questions' })).toBeNull();
    expect(openCodeReply(native, { decision: 'approve', formKind: 'questions', answers: [{ keys: ['a'] }] })).toBeNull();
    expect(openCodeReply({ ...native, nativeSessionId: undefined }, { decision: 'approve', formKind: 'permission' })).toBeNull();
    expect(openCodeReply({ ...native, digest: undefined }, { decision: 'approve', formKind: 'permission' })).toBeNull();
    expect(openCodeReply({ adapter: 'codex', requestId: '1' }, { decision: 'approve', formKind: 'permission' })).toBeNull();
    const form = openCodeDecisionNote(QUESTION)!.form;
    expect(form).toMatchObject({ kind: 'questions', questions: [{ id: 'q0', header: 'Color', multiSelect: false, allowOther: true, options: [{ key: '1', label: 'Red' }, { key: '2', label: 'Blue' }] }] });
  });
});
