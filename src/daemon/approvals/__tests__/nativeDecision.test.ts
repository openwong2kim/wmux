// `native-rpc` records: decisions the agent's own server holds. Every rule
// that reads the pane's screen or keys must leave them alone, and the only
// way to answer one is a human through a web route, delivered to the agent's
// server — never a key in the pane.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ApprovalRegistry,
  NATIVE_DECISIONS_PER_SESSION_MAX,
  TERMINAL_PROMPT_MIN_ANSWER_AGE_MS,
  type ApprovalRegistryDeps,
} from '../ApprovalRegistry';
import {
  DECISION_V2_WEB_ANSWER,
  TERMINAL_PROMPT_WEB_ANSWER,
  TERMINAL_PROMPT_WEB_DECLINE,
  needsInputGrant,
  type ApprovalEvent,
  type ApprovalExpiryReason,
  type ApprovalRequest,
  type ApprovalResolveParams,
  type DecisionForm,
  type NativeDecisionOutcome,
  type NativeDecisionRef,
  type NativeDecisionReply,
} from '../types';
import { parseApprovalResolveRequest } from '../resolveRequest';
import { coercePhoneDecisions, type PhoneDecisionsConfig } from '../decisionConfig';

const DIALOG = [
  '● Bash(rm -rf build/cache)',
  '',
  '────────────────────────────────────────────────────────────',
  ' Bash command',
  '',
  '   rm -rf build/cache',
  '   Remove the build cache',
  '',
  ' Permission rule Bash(rm -rf *) requires confirmation for this command.',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
];

const PERMISSION: DecisionForm = {
  v: 1,
  kind: 'permission',
  actions: [{ id: 'approve', label: 'Allow once' }, { id: 'deny', label: 'Reject' }],
};

let tmpDir: string;

interface Harness {
  registry: ApprovalRegistry;
  writes: string[];
  renders: number;
  scheduled: number;
  native: Array<{ ref: NativeDecisionRef; reply: NativeDecisionReply }>;
  outcome: { next: NativeDecisionOutcome | (() => Promise<NativeDecisionOutcome>) };
  switches: PhoneDecisionsConfig;
  events: ApprovalEvent[];
  clock: { now: number };
}

function makeRegistry(overrides: Partial<ApprovalRegistryDeps> = {}): Harness {
  const h: Harness = {
    registry: null as unknown as ApprovalRegistry,
    writes: [],
    renders: 0,
    scheduled: 0,
    native: [],
    outcome: { next: 'ok' },
    switches: { native: true, stepwise: true },
    events: [],
    clock: { now: 10_000 },
  };
  let next = 1;
  h.registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => { h.renders += 1; return DIALOG; },
    writeToSession: (_id, data) => { h.writes.push(data); return true; },
    readPromptScreen: async () => {
      h.renders += 1;
      return { rows: DIALOG, mark: { bytes: 100, keyInputRevision: 3, incarnation: 'inc-1' } };
    },
    promptScreenMark: () => ({ bytes: 100, keyInputRevision: 3, incarnation: 'inc-1' }),
    pendingToolUse: () => null,
    promptReadDelay: async () => undefined,
    schedule: () => { h.scheduled += 1; return () => undefined; },
    answerNative: async (ref, reply) => {
      h.native.push({ ref, reply });
      const next = h.outcome.next;
      return typeof next === 'function' ? next() : next;
    },
    phoneDecisions: () => h.switches,
    now: () => h.clock.now,
    newId: () => `req-${next++}`,
    ...overrides,
  });
  h.registry.onEvent((e) => h.events.push(e));
  return h;
}

async function nativePermission(h: Harness, requestId = 'per_1', sessionId = 'pty-oc'): Promise<ApprovalRequest> {
  const id = await h.registry.noteNativeDecision({
    sessionId,
    agent: 'opencode',
    workspaceId: 'ws-1',
    native: { adapter: 'opencode', requestId, nativeSessionId: 'ses_1' },
    form: PERMISSION,
    question: 'Allow bash: npm test?',
    toolName: 'bash',
  });
  const record = h.registry.list().pending.find((r) => r.id === id);
  if (!record) throw new Error('no native record');
  return record;
}

const v1Answer = (record: ApprovalRequest, over: Partial<ApprovalResolveParams> = {}): ApprovalResolveParams => ({
  id: record.id,
  decision: 'approve',
  choiceKey: '1',
  promptFingerprint: record.promptFingerprint,
  resolvedBy: 'device Phone (d1)',
  terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
  ...over,
});
const decline = (record: ApprovalRequest): ApprovalResolveParams => ({
  id: record.id,
  decision: 'deny',
  resolvedBy: 'device Phone (d1)',
  terminalPromptDecline: TERMINAL_PROMPT_WEB_DECLINE,
});
const settle = (h: Harness) => { h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS; };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-native-decision-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('native decision records', () => {
  it('project to a shipped phone as a plain Yes/No terminal_prompt keyed by the form fingerprint', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    expect(record).toMatchObject({
      kind: 'terminal_prompt',
      channel: 'native-rpc',
      question: 'Allow bash: npm test?',
      native: { adapter: 'opencode', requestId: 'per_1' },
    });
    expect(record.choices).toEqual([{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]);
    expect(record.formFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(record.promptFingerprint).toBe(record.formFingerprint);
  });

  it('are keyed per (pane, adapter, request): a repeat is a no-op, a changed form replaces, the cap holds', async () => {
    const h = makeRegistry();
    const first = await nativePermission(h);
    expect((await nativePermission(h)).id).toBe(first.id);
    const changed = await h.registry.noteNativeDecision({
      sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'per_1' },
      form: { ...PERMISSION, actions: [{ id: 'deny', label: 'Reject' }] }, question: 'Allow bash: npm test?',
    });
    expect(changed).not.toBe(first.id);
    expect(h.events.at(-1)).toMatchObject({ type: 'create', replaces: first.id });
    for (let i = 2; i <= NATIVE_DECISIONS_PER_SESSION_MAX; i++) await nativePermission(h, `per_${i}`);
    expect(await h.registry.noteNativeDecision({
      sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'per_over' },
      form: PERMISSION, question: 'one too many',
    })).toBeNull();
    expect(h.registry.list().pending).toHaveLength(NATIVE_DECISIONS_PER_SESSION_MAX);
  });

  // Table A, row 1: resolve routes by channel before kind.
  it('an answer goes to the agent\'s server: no screen read, no key, no pressedAt', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    settle(h);
    const result = await h.registry.resolve(v1Answer(record));
    expect(result).toMatchObject({ ok: true, durable: true, request: { state: 'resolved', decision: 'approve', selectedChoiceKey: '1' } });
    expect(h.native).toEqual([{ ref: { adapter: 'opencode', requestId: 'per_1', nativeSessionId: 'ses_1' }, reply: { decision: 'approve', formKind: 'permission' } }]);
    expect(h.writes).toEqual([]);
    expect(h.renders).toBe(0);
    expect(result.ok && result.request.pressedAt).toBeUndefined();
    // A replayed offline answer meets the CAS.
    expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ ok: false, reason: 'already-resolved' });
    expect(h.native).toHaveLength(1);
  });

  // Table A, row 2: decline never writes Esc.
  it('a decline rejects through the agent\'s server and never writes an Esc', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    settle(h);
    expect(await h.registry.resolve(decline(record))).toMatchObject({ ok: true, request: { state: 'resolved', decision: 'deny' } });
    expect(h.native.map((c) => c.reply)).toEqual([{ decision: 'deny', formKind: 'permission' }]);
    expect(h.writes).toEqual([]);
    expect(h.renders).toBe(0);
  });

  it('the shipped phone\'s deny names No; a deny on Yes or a stale fingerprint is refused', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    settle(h);
    expect(await h.registry.resolve(v1Answer(record, { decision: 'deny', choiceKey: '1' }))).toMatchObject({ reason: 'invalid-choice' });
    expect(await h.registry.resolve(v1Answer(record, { promptFingerprint: 'cd'.repeat(16) }))).toMatchObject({ reason: 'prompt-changed' });
    expect(h.native).toEqual([]);
    expect(await h.registry.resolve(v1Answer(record, { decision: 'deny', choiceKey: '2' }))).toMatchObject({ ok: true });
    expect(h.native.map((c) => c.reply)).toEqual([{ decision: 'deny', formKind: 'permission' }]);
  });

  // Rule 4: the web markers. The pipe and MCP approval_press carry none.
  it('the pipe RPC and MCP approval_press cannot answer it', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    settle(h);
    for (const isFirstParty of [true, false]) {
      const parsed = parseApprovalResolveRequest({ id: record.id, decision: 'approve', choiceKey: '1' }, { isFirstParty });
      if ('ok' in parsed) throw new Error('parse refused');
      expect(await h.registry.resolve({ ...parsed, promptFingerprint: record.promptFingerprint }))
        .toMatchObject({ ok: false, reason: 'answer-in-terminal', answerRefusal: 'no-capability' });
    }
    // Even a marked call is refused once it declares itself automated.
    expect(await h.registry.resolve(v1Answer(record, { resolver: 'automated' })))
      .toMatchObject({ reason: 'answer-in-terminal', answerRefusal: 'no-capability' });
    expect(h.native).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.registry.list().pending[0]).toMatchObject({ id: record.id, state: 'pending' });
  });

  // Table A, row 3: only the agent, the turn, the pane and a restart settle it.
  it.each(['answered-locally', 'screen-cleared', 'prompt-submitted', 'prompt-gone'] as ApprovalExpiryReason[])(
    'a %s sweep leaves it pending', async (reason) => {
      const h = makeRegistry();
      await nativePermission(h);
      await h.registry.expireForSession('pty-oc', reason, 'terminal_prompt');
      await h.registry.expireForSession('pty-oc', reason);
      expect(h.registry.list().pending).toHaveLength(1);
    },
  );

  it.each(['turn-ended', 'pane-gone', 'session-start'] as ApprovalExpiryReason[])('a %s sweep expires it', async (reason) => {
    const h = makeRegistry();
    await nativePermission(h);
    await h.registry.expireForSession('pty-oc', reason);
    expect(h.registry.list().pending).toHaveLength(0);
  });

  it('a daemon restart expires it (no pressedAt, so never read back as answered)', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    const reloaded = makeRegistry();
    expect(reloaded.registry.list().pending).toEqual([]);
    expect(reloaded.registry.list().recentlyResolved.find((r) => r.id === record.id)).toMatchObject({ state: 'expired', channel: 'native-rpc' });
  });

  // Table A, row 4: keys in the pane, screen-backed creation and supersede.
  it('keys in the pane schedule no refresh, and screen-backed records neither replace it nor are blocked by it', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    h.registry.noteFenceInput('pty-oc');
    expect(h.scheduled).toBe(0);
    const kinds = () => h.registry.list().pending.map((r) => `${r.kind}${r.id === record.id ? '*' : ''}`).sort();
    await h.registry.noteHookAwaitingInput({ sessionId: 'pty-oc', agent: 'claude', question: 'Pick one', choices: [{ key: '1', label: 'A' }] });
    expect(kinds()).toEqual(['awaiting_input', 'terminal_prompt*']);
    // The question is the pane's lone screen-backed record, so the stale check
    // may retire it (its text is not on screen) — the native one is not counted.
    await h.registry.retireStaleQuestion('pty-oc');
    expect(kinds()).toEqual(['terminal_prompt*']);
    // A native decision does not make the pane "pending" for a screen dialog.
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-oc', agent: 'claude', source: 'detector' });
    expect(kinds()).toEqual(['terminal_prompt', 'terminal_prompt*']);
    // A gate replaces the screen dialog, never the native decision.
    h.registry.noteGateAwaiting({ sessionId: 'pty-oc', agent: 'claude', toolName: 'Bash' });
    await h.registry.noteGateDeadline('flush', 0);
    expect(kinds()).toEqual(['awaiting_permission', 'terminal_prompt*']);
  });

  // Table A, row 6.
  it('has no terminal-prompt detail', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    expect(h.registry.terminalPromptDetail(record.id)).toBeNull();
  });

  it('agent says the request is gone → 410 prompt-gone and the card expires', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    settle(h);
    h.outcome.next = 'not-found';
    expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ ok: false, reason: 'prompt-gone', request: { state: 'expired' } });
    expect(h.registry.list().pending).toEqual([]);
  });

  it('an unreachable agent server delivers nothing and leaves the card answerable', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    settle(h);
    h.outcome.next = 'unavailable';
    expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ ok: false, reason: 'agent-unavailable' });
    expect(h.registry.list().pending).toHaveLength(1);
    h.outcome.next = 'ok';
    expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ ok: true });
  });

  it('a single-select question is answered by option key; its deny rejects; the adapter learns the form kind', async () => {
    const h = makeRegistry();
    const id = await h.registry.noteNativeDecision({
      sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'que_1' },
      form: { v: 1, kind: 'questions', actions: [], questions: [{ id: 'q0', text: 'Which env?', multiSelect: false, allowOther: false, options: [{ key: '1', label: 'dev' }, { key: '2', label: 'prod' }] }] },
    });
    const record = h.registry.list().pending.find((r) => r.id === id)!;
    expect(record).toMatchObject({ kind: 'awaiting_input', question: 'Which env?', choices: [{ key: '1', label: 'dev' }, { key: '2', label: 'prod' }] });
    settle(h);
    const marked: Omit<ApprovalResolveParams, 'decision'> = { id: record.id, resolvedBy: 'device Phone (d1)', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER };
    expect(await h.registry.resolve({ ...marked, decision: 'approve', choiceKey: '9' })).toMatchObject({ reason: 'invalid-choice' });
    expect(await h.registry.resolve({ ...marked, decision: 'approve', choiceKey: '2' })).toMatchObject({ ok: true, request: { selectedChoiceKey: '2' } });
    expect(h.native.map((c) => c.reply)).toEqual([{ decision: 'approve', formKind: 'questions', choiceKey: '2', answers: [{ keys: ['2'] }] }]);

    const multi = await h.registry.noteNativeDecision({
      sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'que_2' },
      form: { v: 1, kind: 'questions', actions: [], questions: [{ id: 'q0', text: 'Which?', multiSelect: true, allowOther: false, options: [{ key: '1', label: 'a' }] }] },
    });
    settle(h);
    expect(await h.registry.resolve({ ...marked, id: multi!, decision: 'approve', choiceKey: '1' })).toMatchObject({ reason: 'needs-v2' });
    expect(await h.registry.resolve({ ...marked, id: multi!, decision: 'deny' })).toMatchObject({ ok: true });
    expect(h.native.at(-1)!.reply).toEqual({ decision: 'deny', formKind: 'questions' });
  });

  it('a request answered a moment ago is not resurrected by a late re-notify', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    settle(h);
    expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ ok: true });
    expect(await h.registry.noteNativeDecision({
      sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'per_1' }, form: PERMISSION, question: 'Allow bash: npm test?',
    })).toBeNull();
    expect(h.registry.list().pending).toEqual([]);
  });

  it('two records for one agent request cannot both reply (the claim is per request)', async () => {
    const h = makeRegistry();
    const a = await nativePermission(h, 'per_1', 'pty-a');
    const b = await nativePermission(h, 'per_1', 'pty-b');
    settle(h);
    let release!: (o: NativeDecisionOutcome) => void;
    h.outcome.next = () => new Promise<NativeDecisionOutcome>((resolve) => { release = resolve; });
    const first = h.registry.resolve(v1Answer(a));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await h.registry.resolve(v1Answer(b))).toMatchObject({ reason: 'already-answered' });
    release('ok');
    await first;
    expect(h.native).toHaveLength(1);
  });

  it('an adapter that never answers times out as uncertain and frees the request', async () => {
    const h = makeRegistry({ nativeAnswerTimeoutMs: 20 });
    const record = await nativePermission(h);
    settle(h);
    h.outcome.next = () => new Promise<NativeDecisionOutcome>(() => undefined);
    expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ ok: false, reason: 'answer-uncertain' });
    expect(h.registry.list().pending).toHaveLength(1);
    h.outcome.next = 'not-found';
    // The claim was released: a second try reaches the agent, which says it is gone.
    expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ reason: 'prompt-gone' });
  });

  it('a form out of bounds is refused; text is cleaned and capped', async () => {
    const h = makeRegistry();
    const tooMany = { v: 1 as const, kind: 'questions' as const, actions: [], questions: Array.from({ length: 17 }, (_, i) => ({ id: `q${i}`, text: 't', multiSelect: false, allowOther: false, options: [{ key: '1', label: 'a' }] })) };
    const badKey = { v: 1 as const, kind: 'questions' as const, actions: [], questions: [{ id: 'q0', text: 't', multiSelect: false, allowOther: false, options: [{ key: 'a b', label: 'a' }] }] };
    for (const form of [tooMany, badKey]) {
      expect(await h.registry.noteNativeDecision({ sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'x' }, form })).toBeNull();
    }
    const id = await h.registry.noteNativeDecision({
      sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'y' },
      form: { ...PERMISSION, actions: [{ id: 'approve', label: `Allow\x1b[31m ${'x'.repeat(400)}` }] }, question: 'Allow?\x07',
    });
    const record = h.registry.list().pending.find((r) => r.id === id)!;
    expect(record.question).toBe('Allow?');
    expect(record.form!.actions[0]!.label).not.toContain('\x1b');
    expect(record.form!.actions[0]!.label.length).toBeLessThanOrEqual(201);
  });

  it('two phones: one answer in flight, the other is told it is already answered, then already resolved', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    settle(h);
    let release!: (o: NativeDecisionOutcome) => void;
    h.outcome.next = () => new Promise<NativeDecisionOutcome>((resolve) => { release = resolve; });
    const first = h.registry.resolve(v1Answer(record));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await h.registry.resolve(v1Answer(record, { resolvedBy: 'device Other (d2)' }))).toMatchObject({ reason: 'already-answered' });
    release('ok');
    expect(await first).toMatchObject({ ok: true });
    expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ reason: 'already-resolved', resolvedBy: 'device Phone (d1)' });
    expect(h.native).toHaveLength(1);
  });

  it('too soon after it appeared is refused, as for a terminal dialog', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ reason: 'answer-too-soon' });
    expect(h.native).toEqual([]);
  });

  it('a caller whose grant narrowed is refused before the agent hears anything', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    settle(h);
    expect(await h.registry.resolve(v1Answer(record, { authorize: async () => 'read-only' })))
      .toMatchObject({ ok: false, reason: 'input-revoked' });
    let calls = 0;
    expect(await h.registry.resolve(v1Answer(record, { authorize: async () => (++calls === 1 ? 'ok' : 'read-only') })))
      .toMatchObject({ ok: false, reason: 'input-revoked' });
    expect(h.native).toEqual([]);
  });

  it('a v2 answer to a screen record takes the 1.5 s reflex guard before it is refused', async () => {
    const h = makeRegistry();
    await h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', question: 'Pick', choices: [{ key: '1', label: 'A' }] });
    const [record] = h.registry.list().pending;
    const v2: ApprovalResolveParams = {
      id: record!.id, decision: 'approve', resolvedBy: 'device Phone (d1)', decisionV2Answer: DECISION_V2_WEB_ANSWER,
      decisionAnswer: { formFingerprint: 'ab'.repeat(16), clientAnswerId: 'a'.repeat(16), action: 'approve' },
    };
    expect(await h.registry.resolve(v2)).toMatchObject({ reason: 'answer-too-soon' });
    settle(h);
    expect(await h.registry.resolve(v2)).toMatchObject({ reason: 'answer-in-terminal', answerRefusal: 'unsupported-shape' });
    expect(h.writes).toEqual([]);
  });

  it('a v2 answer to a permission names approve or deny and must echo the form fingerprint', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    settle(h);
    const v2 = (answer: Partial<NonNullable<ApprovalResolveParams['decisionAnswer']>>): ApprovalResolveParams => ({
      id: record.id, decision: 'approve', resolvedBy: 'device Phone (d1)',
      decisionV2Answer: DECISION_V2_WEB_ANSWER,
      decisionAnswer: { formFingerprint: record.formFingerprint!, clientAnswerId: 'a'.repeat(16), ...answer },
    });
    expect(await h.registry.resolve(v2({ action: 'always' }))).toMatchObject({ reason: 'invalid-choice' });
    expect(await h.registry.resolve(v2({ action: 'approve', formFingerprint: 'f'.repeat(32) }))).toMatchObject({ reason: 'prompt-changed' });
    expect(await h.registry.resolve(v2({ action: 'approve', text: 'why' }))).toMatchObject({ reason: 'invalid-choice' });
    expect(h.native).toEqual([]);
    const done = await h.registry.resolve(v2({ action: 'deny' }));
    expect(done).toMatchObject({ ok: true, request: { state: 'resolved', decision: 'deny' } });
    expect(done.ok && done.request.pressedAt).toBeUndefined();
    expect(h.native).toEqual([{ ref: expect.objectContaining({ requestId: 'per_1' }), reply: { decision: 'deny', formKind: 'permission' } }]);
    expect(h.writes).toEqual([]);
  });

  it('a v2 answer to questions hands the agent one label list per question, typed text only where allowed', async () => {
    const h = makeRegistry();
    const id = await h.registry.noteNativeDecision({
      sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'que_9', nativeSessionId: 'ses_1' },
      form: { v: 1, kind: 'questions', actions: [{ id: 'submit', label: 'Submit' }, { id: 'deny', label: 'Dismiss' }], questions: [
        { id: 'q0', text: 'Toppings?', multiSelect: true, allowOther: false, options: [{ key: '1', label: 'Cheese' }, { key: '2', label: 'Basil' }] },
        { id: 'q1', text: 'Size?', multiSelect: false, allowOther: true, options: [{ key: '1', label: 'Small' }] },
      ] },
    });
    const record = h.registry.list().pending.find((r) => r.id === id)!;
    settle(h);
    const v2 = (answers: NonNullable<NonNullable<ApprovalResolveParams['decisionAnswer']>['answers']>): ApprovalResolveParams => ({
      id: record.id, decision: 'approve', resolvedBy: 'device Phone (d1)', decisionV2Answer: DECISION_V2_WEB_ANSWER,
      decisionAnswer: { formFingerprint: record.formFingerprint!, clientAnswerId: 'b'.repeat(16), answers },
    });
    // Typed text on a question that allows none; a question left out; two answers to a single select.
    expect(await h.registry.resolve(v2([{ questionId: 'q0', keys: [], other: 'Olive' }, { questionId: 'q1', keys: ['1'] }]))).toMatchObject({ reason: 'invalid-choice' });
    expect(await h.registry.resolve(v2([{ questionId: 'q0', keys: ['1'] }]))).toMatchObject({ reason: 'invalid-choice' });
    expect(await h.registry.resolve(v2([{ questionId: 'q0', keys: ['1'] }, { questionId: 'q1', keys: ['1'], other: 'Huge' }]))).toMatchObject({ reason: 'invalid-choice' });
    expect(h.native).toEqual([]);
    const done = await h.registry.resolve(v2([{ questionId: 'q1', keys: [], other: 'Huge' }, { questionId: 'q0', keys: ['2', '1'] }]));
    expect(done).toMatchObject({ ok: true, request: { state: 'resolved' } });
    expect(h.native.at(-1)!.reply).toEqual({ decision: 'approve', formKind: 'questions', answers: [{ keys: ['2', '1'] }, { keys: [], other: 'Huge' }] });
    // The typed text is kept as a digest, never verbatim.
    const stored = h.registry.list().recentlyResolved.find((r) => r.id === record.id)!;
    expect(stored.answerDigest).toMatchObject({ textBytes: 4 });
    expect(JSON.stringify(stored)).not.toContain('Huge');
  });

  it('a whitespace-only typed answer, and a v1 approve of several questions, are refused for good', async () => {
    const h = makeRegistry();
    const id = await h.registry.noteNativeDecision({
      sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'que_w', nativeSessionId: 'ses_1' },
      form: { v: 1, kind: 'questions', actions: [], questions: [
        { id: 'q0', text: 'A?', multiSelect: false, allowOther: true, options: [{ key: '1', label: 'x' }] },
        { id: 'q1', text: 'B?', multiSelect: false, allowOther: true, options: [{ key: '1', label: 'y' }] },
      ] },
    });
    settle(h);
    expect(await h.registry.resolve({
      id: id!, decision: 'approve', resolvedBy: 'device Phone (d1)', decisionV2Answer: DECISION_V2_WEB_ANSWER,
      decisionAnswer: { formFingerprint: h.registry.list().pending[0]!.formFingerprint!, clientAnswerId: 'c'.repeat(16),
        answers: [{ questionId: 'q0', keys: [], other: '   ' }, { questionId: 'q1', keys: ['1'] }] },
    })).toMatchObject({ reason: 'invalid-choice' });
    // A shipped phone cannot answer several questions: needs-v2 (501), not a retry.
    expect(await h.registry.resolve({ id: id!, decision: 'approve', choiceKey: '1', resolvedBy: 'device Phone (d1)', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER }))
      .toMatchObject({ reason: 'needs-v2' });
    expect(h.native).toEqual([]);
  });

  it('the agent refusing an answer is final; a request that changed is prompt-changed', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    settle(h);
    h.outcome.next = 'refused';
    expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ ok: false, reason: 'invalid-choice' });
    h.outcome.next = 'changed';
    expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.registry.list().pending.map((r) => r.id)).toContain(record.id);
  });

  it('the fingerprint covers what the card shows: a new command under the same id replaces the card', async () => {
    const h = makeRegistry();
    const first = await nativePermission(h);
    const again = await h.registry.noteNativeDecision({
      sessionId: 'pty-oc', agent: 'opencode', workspaceId: 'ws-1',
      native: { adapter: 'opencode', requestId: 'per_1', nativeSessionId: 'ses_1' },
      form: PERMISSION, question: 'Allow bash: npm test?', toolName: 'bash', summary: 'rm -rf build',
    });
    expect(again).not.toBe(first.id);
    const now = h.registry.list().pending;
    expect(now).toHaveLength(1);
    expect(now[0]!.formFingerprint).not.toBe(first.formFingerprint);
    expect(h.events.map((e) => e.type)).toEqual(['create', 'supersede', 'create']);
  });

  it('expireHookAwaiting settles only the named informational cards, never a native record', async () => {
    const h = makeRegistry();
    const native = await nativePermission(h);
    await h.registry.noteHookAwaitingInput({ sessionId: 'pty-oc', agent: 'opencode', requestId: 'per_x' });
    const card = h.registry.list().pending.find((r) => !r.native)!;
    expect(card.hookRequestId).toBe('per_x');
    expect(await h.registry.expireHookAwaiting('pty-oc', ['per_other'])).toBe(0);
    expect(await h.registry.expireHookAwaiting('pty-oc', ['per_x', 'per_1'])).toBe(1);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([native.id]);
  });

  it('an adapter that lost the answer after it left reports uncertain, not unavailable', async () => {
    const h = makeRegistry();
    const record = await nativePermission(h);
    settle(h);
    h.outcome.next = 'uncertain';
    expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ ok: false, reason: 'answer-uncertain' });
    expect(h.registry.list().pending.map((r) => r.id)).toContain(record.id);
  });

  it('expireNativeRequests settles only the named requests of that pane, past the screen guard', async () => {
    const h = makeRegistry();
    const a = await nativePermission(h, 'per_a');
    const b = await nativePermission(h, 'per_b');
    const other = await nativePermission(h, 'per_c', 'pty-other');
    h.registry.expireForSession('pty-oc', 'answered-locally');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.registry.list().pending.map((r) => r.id).sort()).toEqual([a.id, b.id, other.id].sort());
    expect(await h.registry.expireNativeRequests('pty-oc', 'opencode', ['per_a', 'per_c'])).toBe(1);
    expect(h.registry.list().pending.map((r) => r.id).sort()).toEqual([b.id, other.id].sort());
    // Settled: a late re-notify of the same request does not bring it back.
    expect(await h.registry.noteNativeDecision({ sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'per_a', nativeSessionId: 'ses_1' }, form: PERMISSION, question: 'Allow bash?' })).toBeNull();
  });

  describe('the phoneDecisions kill switch', () => {
    it('off at creation: an informational card that nothing types into', async () => {
      const h = makeRegistry();
      h.switches = { native: false, stepwise: true };
      const id = await h.registry.noteNativeDecision({
        sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'per_1' }, form: PERMISSION, question: 'Allow?',
      });
      const record = h.registry.list().pending.find((r) => r.id === id)!;
      expect(record).toMatchObject({ channel: 'none', kind: 'terminal_prompt' });
      expect(record).not.toHaveProperty('choices');
      expect(record).not.toHaveProperty('promptFingerprint');
      expect(record).not.toHaveProperty('form');
      settle(h);
      expect(await h.registry.resolve(v1Answer(record, { promptFingerprint: 'ab'.repeat(16) })))
        .toMatchObject({ reason: 'answer-in-terminal' });
      expect(await h.registry.resolve(decline(record))).toMatchObject({ ok: false, reason: 'answer-in-terminal' });
      // Turned back on later: a card made while off stays informational.
      h.switches = { native: true, stepwise: true };
      expect(await h.registry.resolve(decline(record))).toMatchObject({ ok: false, reason: 'answer-in-terminal' });
      expect(h.writes).toEqual([]);
      expect(h.renders).toBe(0);
      expect(h.native).toEqual([]);
    });

    it('off: a re-notify of the same request is a no-op, not a new card', async () => {
      const h = makeRegistry();
      h.switches = { native: false, stepwise: true };
      const note = () => h.registry.noteNativeDecision({
        sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'per_1' }, form: PERMISSION, question: 'Allow?',
      });
      const first = await note();
      const events = h.events.length;
      expect(await note()).toBe(first);
      expect(h.events).toHaveLength(events);
    });

    it('off: the card is still agent-held — screen sweeps, keys and screen dialogs leave it alone', async () => {
      const h = makeRegistry();
      h.switches = { native: false, stepwise: true };
      const id = await h.registry.noteNativeDecision({
        sessionId: 'pty-oc', agent: 'opencode', native: { adapter: 'opencode', requestId: 'per_1' }, form: PERMISSION, question: 'Allow?',
      });
      await h.registry.expireForSession('pty-oc', 'screen-cleared');
      await h.registry.expireForSession('pty-oc', 'answered-locally', 'terminal_prompt');
      h.registry.noteFenceInput('pty-oc');
      await h.registry.noteTerminalPrompt({ sessionId: 'pty-oc', agent: 'claude', source: 'detector' });
      const pending = h.registry.list().pending;
      expect(pending.find((r) => r.id === id)).toMatchObject({ state: 'pending' });
      expect(pending).toHaveLength(2);
      expect(h.scheduled).toBe(0);
    });

    it('off after creation: the answer is refused, nothing is delivered', async () => {
      const h = makeRegistry();
      const record = await nativePermission(h);
      settle(h);
      h.switches = { native: false, stepwise: true };
      expect(await h.registry.resolve(v1Answer(record))).toMatchObject({ reason: 'answer-in-terminal', answerRefusal: 'unsupported-shape' });
      expect(await h.registry.resolve(decline(record))).toMatchObject({ reason: 'answer-in-terminal' });
      expect(h.native).toEqual([]);
      expect(h.writes).toEqual([]);
    });

    it('defaults both channels on; only an explicit false turns one off', () => {
      expect(coercePhoneDecisions(undefined)).toEqual({ native: true, stepwise: true });
      expect(coercePhoneDecisions({ native: 'no', stepwise: 0 })).toEqual({ native: true, stepwise: true });
      expect(coercePhoneDecisions({ native: false })).toEqual({ native: false, stepwise: true });
    });
  });

  it('needsInputGrant: every native decision and every v2 answer needs the grant', () => {
    expect(needsInputGrant({ kind: 'awaiting_input' })).toBe(false);
    expect(needsInputGrant({ kind: 'awaiting_input', channel: 'native-rpc' })).toBe(true);
    expect(needsInputGrant({ kind: 'terminal_prompt' })).toBe(true);
    expect(needsInputGrant({ kind: 'awaiting_permission' })).toBe(true);
    expect(needsInputGrant({ kind: 'awaiting_input' }, 'answer')).toBe(true);
    expect(needsInputGrant({ kind: 'awaiting_input' }, 'decline')).toBe(true);
  });
});
