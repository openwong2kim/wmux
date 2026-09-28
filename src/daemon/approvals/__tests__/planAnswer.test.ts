// Claude's ExitPlanMode dialog as a `decision-v2` `plan` form: the record, the
// one-key approve, and the stepwise feedback driver against a fake pane that
// replays the measured screens (fixtures/terminal-prompts/claude-plan-*.json).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ApprovalRegistry,
  STEP_RENDER_WAIT_MS,
  TERMINAL_PROMPT_MIN_ANSWER_AGE_MS,
  type ApprovalRegistryDeps,
} from '../ApprovalRegistry';
import {
  DECISION_V2_WEB_ANSWER,
  TERMINAL_PROMPT_WEB_ANSWER,
  TERMINAL_PROMPT_WEB_DECLINE,
  type ApprovalEvent,
  type ApprovalRequest,
  type DecisionAnswer,
} from '../types';
import type { PendingToolUse } from '../../transcript/pendingToolUse';

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts');
// Read with fs, not a JSON import: a JSON import breaks the daemon build.
const screen = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as { screen: string[] }).screen;
const INITIAL = screen('claude-plan-01-initial.json');
const ON_FIELD = screen('claude-plan-02-after-digit3.json');
const SUBMITTED = screen('claude-plan-07-empty-feedback.json');
const BYPASS = screen('claude-plan-06-bypass-row.json');
/** The dialog with `text` typed into the feedback field (as claude-plan-03). */
const typed = (text: string): string[] => ON_FIELD.map((r) => r.replace('❯ 3. Tell Claude what to change', `❯ 3. ${text}`));

const PLAN_CALL: PendingToolUse = {
  id: 'toolu_plan',
  name: 'ExitPlanMode',
  input: { plan: '# Plan: create hello.txt\n\n1. Write hello.txt with hi.' },
};

interface Pane {
  rows: readonly string[] | null;
  bytes: number;
  keyInputRevision: number;
  incarnation: string;
  pending: PendingToolUse | null;
  /** Whether the fake TUI draws what a key should draw. */
  echoes: boolean;
}

interface Harness {
  registry: ApprovalRegistry;
  pane: Pane;
  stepKeys: string[];
  writes: string[];
  submitted: number;
  events: ApprovalEvent[];
  clock: { now: number };
  /** Runs right after each driver key lands (a human, a sweep, …). */
  afterStepKey: { fn: ((index: number) => void) | null };
}

let tmpDir: string;

function makeRegistry(overrides: Partial<ApprovalRegistryDeps> = {}): Harness {
  const h: Harness = {
    registry: null as unknown as ApprovalRegistry,
    pane: { rows: INITIAL, bytes: 100, keyInputRevision: 3, incarnation: 'inc-1', pending: PLAN_CALL, echoes: true },
    stepKeys: [],
    writes: [],
    submitted: 0,
    events: [],
    clock: { now: 10_000 },
    afterStepKey: { fn: null },
  };
  // The fake TUI: a key moves the pane's revision by one and redraws.
  const draw = (data: string): void => {
    h.pane.keyInputRevision += 1;
    h.pane.bytes += 50;
    if (!h.pane.echoes) return;
    if (data === '3') h.pane.rows = ON_FIELD;
    else if (data.startsWith('\x1b[200~')) h.pane.rows = typed(data.slice(6, -6));
    else if (data === '\r') h.pane.rows = SUBMITTED;
  };
  let next = 1;
  h.registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => null,
    writeToSession: (_id, data) => {
      h.writes.push(data);
      draw(data);
      return true;
    },
    writeStepKey: (_id, data) => {
      h.stepKeys.push(data);
      draw(data);
      const revision = h.pane.keyInputRevision;
      h.afterStepKey.fn?.(h.stepKeys.length - 1);
      return revision;
    },
    noteSubmitted: () => { h.submitted += 1; },
    readPromptScreen: async () => {
      const rows = h.pane.rows;
      const mark = { bytes: h.pane.bytes, keyInputRevision: h.pane.keyInputRevision, incarnation: h.pane.incarnation };
      return rows ? { rows, mark, cols: 100 } : null;
    },
    promptScreenMark: () => ({ bytes: h.pane.bytes, keyInputRevision: h.pane.keyInputRevision, incarnation: h.pane.incarnation }),
    pendingToolUse: () => h.pane.pending,
    // Waiting advances the fake clock, so the driver's time bounds are exercised.
    promptReadDelay: async (ms) => { h.clock.now += ms; },
    schedule: () => () => undefined,
    now: () => h.clock.now,
    newId: () => `req-${next++}`,
    ...overrides,
  });
  h.registry.onEvent((e) => h.events.push(e));
  return h;
}

async function create(h: Harness): Promise<ApprovalRequest> {
  await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', toolName: 'ExitPlanMode', source: 'detector' });
  const [record] = h.registry.list().pending;
  if (!record) throw new Error('no record');
  h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
  return record;
}

let answerSeq = 0;
function answer(h: Harness, record: ApprovalRequest, body: Partial<DecisionAnswer> = {}) {
  return h.registry.resolve({
    id: record.id,
    decision: 'approve',
    resolvedBy: 'device Test phone (dev-1)',
    decisionV2Answer: DECISION_V2_WEB_ANSWER,
    decisionAnswer: {
      formFingerprint: record.formFingerprint!,
      clientAnswerId: `answer-0000000000${++answerSeq}`,
      action: 'feedback',
      ...body,
    },
  });
}

const stored = (h: Harness, id: string): ApprovalRequest => {
  const listed = h.registry.list();
  return [...listed.pending, ...listed.recentlyResolved].find((r) => r.id === id)!;
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-plan-answer-test-'));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('the ExitPlanMode record', () => {
  it('carries a plan form read off the screen, and nothing a shipped phone could press', async () => {
    const h = makeRegistry();
    const record = await create(h);
    expect(record).toMatchObject({
      kind: 'terminal_prompt',
      toolName: 'ExitPlanMode',
      summary: 'Plan: create hello.txt',
      question: 'Claude has written up a plan and is ready to execute. Would you like to proceed?',
      channel: 'fenced-keys',
      form: {
        v: 1,
        kind: 'plan',
        actions: [
          { id: 'approve-manual', label: 'Yes, manually approve edits' },
          { id: 'feedback', label: 'Tell Claude what to change', needsText: true },
        ],
      },
    });
    expect(record.formFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(record.promptFingerprint).toBe(record.formFingerprint);
    expect(record.choices).toBeUndefined();
    // The whole plan is the record's detail.
    expect(h.registry.terminalPromptDetail(record.id)?.command).toBe(PLAN_CALL.input['plan']);
  });

  it('is bound by the PermissionRequest hook alone when the transcript has no call yet', async () => {
    const h = makeRegistry({ agentSessionId: () => 'claude-session-1' });
    h.pane.pending = null;
    await h.registry.noteTerminalPrompt({
      sessionId: 'pty-a',
      agent: 'claude',
      toolName: 'ExitPlanMode',
      toolInput: PLAN_CALL.input,
      hookSessionId: 'claude-session-1',
      source: 'hook',
    });
    expect(h.registry.list().pending[0]?.form?.kind).toBe('plan');
  });

  it('offers no form when a row would switch to bypass permissions (claude-plan-06)', async () => {
    const h = makeRegistry();
    h.pane.rows = BYPASS;
    const record = await create(h);
    expect(record.form).toBeUndefined();
    expect(record.formFingerprint).toBeUndefined();
  });

  it('offers no form with the stepwise channel off, or for a call that is not ExitPlanMode', async () => {
    const off = makeRegistry({ phoneDecisions: () => ({ native: true, stepwise: false }) });
    expect((await create(off)).form).toBeUndefined();
    const other = makeRegistry();
    other.pane.pending = { id: 'toolu_x', name: 'Bash', input: { command: 'ls' } };
    expect((await create(other)).form).toBeUndefined();
  });
});

describe('approve-manual', () => {
  it('writes the manual-approve row\'s own key once, through the one-answer CAS', async () => {
    const h = makeRegistry();
    const record = await create(h);
    const result = await answer(h, record, { action: 'approve-manual' });
    expect(result).toMatchObject({ ok: true, request: { state: 'pending', decision: 'approve', selectedChoiceKey: '2' } });
    expect(h.writes).toEqual(['2']);
    expect(h.stepKeys).toEqual([]);
    expect(await answer(h, record, { action: 'approve-manual' })).toMatchObject({ ok: false, reason: 'already-answered' });
  });
});

describe('feedback (the stepwise driver)', () => {
  it('types the row key, ONE bracketed paste and Enter, and resolves the record', async () => {
    const h = makeRegistry();
    const record = await create(h);
    const result = await answer(h, record, { text: 'use bye instead' });
    expect(result).toMatchObject({ ok: true, request: { state: 'resolved', decision: 'deny', selectedChoiceKey: '3' } });
    expect(h.stepKeys).toEqual(['3', '\x1b[200~use bye instead\x1b[201~', '\r']);
    expect(h.writes).toEqual([]);
    expect(h.submitted).toBe(1);
    const done = stored(h, record.id);
    expect(done.step).toMatchObject({ index: 3, total: 3, status: 'done' });
    expect(done.answerDigest).toEqual({ textBytes: 15, textHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(h.events.map((e) => e.type)).toEqual(['create', 'press', 'resolve']);
    // The phone's text is never stored.
    expect(fs.readFileSync(path.join(tmpDir, 'approvals.json'), 'utf8')).not.toContain('bye instead');
  });

  it('sends only the row key and Enter for empty feedback (claude-plan-07)', async () => {
    const h = makeRegistry();
    const record = await create(h);
    expect(await answer(h, record)).toMatchObject({ ok: true, request: { state: 'resolved' } });
    expect(h.stepKeys).toEqual(['3', '\r']);
    expect(stored(h, record.id).answerDigest).toBeUndefined();
  });

  it('its own keys are never taken for a human: no refresh, supersede or sweep settles the record', async () => {
    const h = makeRegistry();
    const record = await create(h);
    // What the pane does while the keys land: the fence input, its
    // "answered", the screen verifier finding the old dialog changed.
    h.afterStepKey.fn = () => {
      h.registry.noteFenceInput('pty-a');
      void h.registry.expireForSession('pty-a', 'answered-locally', 'terminal_prompt');
      void h.registry.expireForSession('pty-a', 'screen-cleared', 'terminal_prompt');
    };
    const result = await answer(h, record, { text: 'use bye instead' });
    expect(result).toMatchObject({ ok: true, request: { state: 'resolved' } });
    await h.registry.expireForSession('pty-b', 'turn-ended');
    expect(stored(h, record.id).state).toBe('resolved');
    expect(h.events.filter((e) => e.type === 'supersede' || e.type === 'expire')).toEqual([]);
  });

  it('a human key between two driver keys leaves the answer partial and the record pending', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.afterStepKey.fn = (index) => { if (index === 0) h.pane.keyInputRevision += 1; };
    const result = await answer(h, record, { text: 'use bye instead' });
    expect(result).toMatchObject({ ok: false, reason: 'prompt-changed', request: { state: 'pending', step: { index: 1, total: 3, status: 'partial' } } });
    expect(h.stepKeys).toEqual(['3']);
    expect(h.submitted).toBe(0);
    // One answer per record: later ones, and a decline, are refused.
    expect(await answer(h, record, { text: 'again' })).toMatchObject({ ok: false, reason: 'already-answered' });
    expect(await h.registry.resolve({
      id: record.id, decision: 'deny', resolvedBy: 'x', terminalPromptDecline: TERMINAL_PROMPT_WEB_DECLINE,
    })).toMatchObject({ ok: false, reason: 'already-answered' });
    expect(h.stepKeys).toEqual(['3']);
    // No longer suppressed: the pane's own answer settles it.
    await h.registry.expireForSession('pty-a', 'answered-locally', 'terminal_prompt');
    expect(stored(h, record.id).state).toBe('expired');
  });

  it('stops partial when the pasted text is not echoed in the field', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.afterStepKey.fn = (index) => { if (index === 0) h.pane.echoes = false; };
    const started = h.clock.now;
    const result = await answer(h, record, { text: 'use bye instead' });
    expect(result).toMatchObject({ ok: false, reason: 'prompt-changed', request: { step: { index: 2, status: 'partial' } } });
    expect(h.stepKeys).toHaveLength(2);
    expect(h.clock.now - started).toBeGreaterThanOrEqual(STEP_RENDER_WAIT_MS);
  });

  it('writes nothing when a key lands before the first one', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.pane.keyInputRevision += 1;
    const result = await answer(h, record, { text: 'x' });
    expect(result).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.stepKeys).toEqual([]);
  });

  it('a daemon restart expires a partial answer', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.afterStepKey.fn = (index) => { if (index === 0) h.pane.keyInputRevision += 1; };
    await answer(h, record, { text: 'use bye instead' });
    await h.registry.expireForSession('pty-none', 'turn-ended');
    const restarted = makeRegistry();
    expect(stored(restarted, record.id)).toMatchObject({ state: 'expired', step: { status: 'partial' } });
  });
});

describe('what a plan answer refuses', () => {
  it('fails closed on the answer itself', async () => {
    const h = makeRegistry();
    const record = await create(h);
    expect(await answer(h, record, { action: 'approve-auto' })).toMatchObject({ reason: 'invalid-choice' });
    expect(await answer(h, record, { action: 'approve-manual', text: 'x' })).toMatchObject({ reason: 'invalid-choice' });
    expect(await answer(h, record, { answers: [{ questionId: 'q0', keys: ['1'] }] })).toMatchObject({ reason: 'invalid-choice' });
    expect(await answer(h, record, { formFingerprint: 'f'.repeat(32) })).toMatchObject({ reason: 'prompt-changed' });
    // A v1 answer (and the pipe / MCP, which carry no marker) cannot answer it.
    expect(await h.registry.resolve({
      id: record.id, decision: 'approve', choiceKey: '2', promptFingerprint: record.promptFingerprint,
      resolvedBy: 'x', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
    })).toMatchObject({ reason: 'answer-in-terminal', answerRefusal: 'unsupported-shape' });
    expect(await h.registry.resolve({
      id: record.id, decision: 'approve', resolvedBy: 'x',
      decisionAnswer: { formFingerprint: record.formFingerprint!, clientAnswerId: 'answer-00000000001', action: 'approve-manual' },
    })).toMatchObject({ reason: 'answer-in-terminal', answerRefusal: 'no-capability' });
    expect(h.writes).toEqual([]);
    expect(h.stepKeys).toEqual([]);
  });

  it('refuses a reflex answer, and one after the kill switch went off', async () => {
    let stepwise = true;
    const h = makeRegistry({ phoneDecisions: () => ({ native: true, stepwise }) });
    const record = await create(h);
    h.clock.now -= TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    expect(await answer(h, record)).toMatchObject({ reason: 'answer-too-soon' });
    h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
    stepwise = false;
    expect(await answer(h, record)).toMatchObject({ reason: 'answer-in-terminal', answerRefusal: 'unsupported-shape' });
  });

  it('refuses when a key reached the pane since the record: the record is refreshed instead', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.pane.keyInputRevision += 1;
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.stepKeys).toEqual([]);
    expect(h.events.map((e) => e.type)).toContain('supersede');
  });
});
