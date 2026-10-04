import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ApprovalRegistry,
  RESOLVED_BY_MAX,
  sanitizeResolvedBy,
  type ApprovalRegistryDeps,
} from '../ApprovalRegistry';
import {
  getApprovalStatePath,
  loadApprovalState,
  RESOLVED_HISTORY_CAP,
  SCREEN_TAIL_ROWS,
  SCREEN_TAIL_ROW_CHARS,
} from '../approvalStore';
import {
  decideApprovalPress,
  keystrokesForAgent,
  looksLikeApprovalPrompt,
  looksLikeChoiceOnScreen,
} from '../approvalKeystrokes';
import { MAX_OPTIONS, MAX_OPTION_LABEL_CHARS, MAX_QUESTION_CHARS } from '../askUserQuestion';
import type { ApprovalEvent, ApprovalResolveResult } from '../types';
import { GateBroker } from '../GateBroker';

let tmpDir: string;

/**
 * The screen a Claude Code AskUserQuestion select actually puts up: a framed
 * question with numbered options and the `❯` cursor on the highlighted one.
 * This is the ONLY shape the registry will press into.
 */
const PROMPT_ROWS = [
  '╭──────────────────────────────────────────╮',
  '│ Which approach should I take?            │',
  '│                                          │',
  '│ ❯ 1. Rewrite the parser                  │',
  '│   2. Patch the existing one              │',
  '│   3. Type something.                     │',
  '╰──────────────────────────────────────────╯',
];

/** What PROMPT_ROWS asks, as the hook reports it. */
const PROMPT_RECORD = {
  question: 'Which approach should I take?',
  options: ['Rewrite the parser', 'Patch the existing one'],
  choices: [{ key: '1', label: 'Rewrite the parser' }, { key: '2', label: 'Patch the existing one' }],
};

/** A pane that has moved on — numbered list, but no select on screen. */
const NO_PROMPT_ROWS = [
  'Here is what I found:',
  '  1. the cache was stale',
  '  2. the lock was never released',
  '$ ',
];

interface Harness {
  registry: ApprovalRegistry;
  writes: Array<{ sessionId: string; data: string }>;
  events: ApprovalEvent[];
  /** Swap what the next screen read returns (null = unreadable). */
  setScreen: (rows: string[] | null) => void;
  /** Gate the screen read so a test can hold a resolve mid-flight. */
  blockScreen: () => () => void;
  ids: { next: number };
  /**
   * The pane's state as the daemon reads it (output bytes, key input, PTY
   * incarnation). Mutate it to simulate the pane moving between the screen
   * read and the write.
   */
  mark: { bytes: number; keyInputRevision: number; incarnation: string | null };
  /** Runs once, right after the NEXT screen read returns (the TOCTOU window). */
  afterRead: (fn: () => void) => void;
}

function makeRegistry(overrides: Partial<ApprovalRegistryDeps> = {}): Harness {
  const writes: Array<{ sessionId: string; data: string }> = [];
  const events: ApprovalEvent[] = [];
  let screen: string[] | null = PROMPT_ROWS;
  let release: (() => void) | null = null;
  const ids = { next: 1 };
  let clock = 1_000;
  const mark = { bytes: 0, keyInputRevision: 0, incarnation: 'inc-1' as string | null };
  let pendingAfterRead: (() => void) | null = null;
  const readScreen = async (): Promise<string[] | null> => {
    if (release) await new Promise<void>((resolve) => { release = resolve; });
    return screen;
  };

  const deps: ApprovalRegistryDeps = {
    wmuxDir: tmpDir,
    readScreenTail: readScreen,
    // The press path reads the grid WITH the pane's state at that instant, and
    // re-reads the state synchronously before the write.
    readPromptScreen: async () => {
      const rows = await readScreen();
      const at = { ...mark };
      const hook = pendingAfterRead;
      pendingAfterRead = null;
      hook?.();
      return rows ? { rows, mark: at } : null;
    },
    promptScreenMark: () => ({ ...mark }),
    writeToSession: (sessionId, data) => {
      writes.push({ sessionId, data });
      return true;
    },
    // The workspace-shaped press scope main will supply in production. The
    // default here is the IN-scope answer (a delegated task workspace with
    // autonomy on) so each test below exercises its own subject; the scope
    // itself is pinned by its own describe block.
    pressScope: () => ({ isTaskWorkspace: true, autonomyMode: 'assist', approvalPress: true, ownerMode: 'danger' }),
    now: () => clock++,
    newId: () => `req-${ids.next++}`,
    ...overrides,
  };
  const registry = new ApprovalRegistry(deps);
  registry.onEvent((e) => events.push(e));
  return {
    registry,
    writes,
    events,
    setScreen: (rows) => { screen = rows; },
    blockScreen: () => {
      // Arm the gate; the returned function lets the held read through.
      release = () => undefined;
      return () => {
        const r = release;
        release = null;
        r?.();
      };
    },
    ids,
    mark,
    afterRead: (fn) => { pendingAfterRead = fn; },
  };
}

/**
 * Create a request and WAIT for the mutation chain to settle it. The production
 * caller (HookIngest) deliberately does not wait — it is on the hook bridge's
 * 2 s budget — so the promise exists for exactly this.
 */
function awaitingInput(
  registry: ApprovalRegistry,
  sessionId = 'pty-a',
  agent = 'claude',
  extras: { question?: string; options?: string[]; choices?: Array<{ key: string; label: string }> } = {},
): Promise<void> {
  // By default the record describes PROMPT_ROWS exactly: a press is only ever
  // made into the record's own question, so a record needs one to be pressed.
  return registry.noteHookAwaitingInput({
    sessionId, agent, workspaceId: 'ws-1', attribution: 'exact', ...PROMPT_RECORD, ...extras,
  });
}

/** Drain pending microtasks — enough to park a mutation at its first await. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-approvals-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('ApprovalRegistry — lifecycle', () => {
  it('a hook awaiting_input creates ONE pending request, listed with its pane and workspace', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    const { pending, recentlyResolved } = h.registry.list();
    expect(pending).toHaveLength(1);
    expect(recentlyResolved).toHaveLength(0);
    expect(pending[0]).toMatchObject({
      id: 'req-1',
      sessionId: 'pty-a',
      workspaceId: 'ws-1',
      agent: 'claude',
      kind: 'awaiting_input',
      state: 'pending',
    });
    expect(h.events.map((e) => e.type)).toEqual(['create']);
  });

  it('approve writes the mapped keystroke to the PTY exactly once and resolves', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res.ok).toBe(true);
    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '1' }]);
    const { pending, recentlyResolved } = h.registry.list();
    expect(pending).toHaveLength(0);
    expect(recentlyResolved[0]).toMatchObject({
      id: 'req-1',
      state: 'resolved',
      decision: 'approve',
      resolvedBy: 'phone',
    });
    // The verified screen is kept on the record — the only evidence of what we
    // pressed into.
    expect(recentlyResolved[0].screenTail).toContain('❯ 1. Rewrite the parser');
    expect(h.events.map((e) => e.type)).toEqual(['create', 'resolve']);
  });

  it('deny sends ESC, never a carriage return', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    await h.registry.resolve({ id: 'req-1', decision: 'deny', resolvedBy: 'phone' });

    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '\x1b' }]);
  });

  it('an unknown id is not-found and writes nothing', async () => {
    const h = makeRegistry();
    const res = await h.registry.resolve({ id: 'nope', decision: 'approve', resolvedBy: 'phone' });
    expect(res).toEqual({ ok: false, reason: 'not-found' });
    expect(h.writes).toHaveLength(0);
  });

  it('a non-claude agent is unsupported-agent and stays PENDING for the desktop', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'codex');
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'unsupported-agent' });
    expect(h.writes).toHaveLength(0);
    // Refusing to press is not the same as killing the request: a human at the
    // desktop can still answer it.
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('a default approve never presses into a dialog that is not the record\'s own question', async () => {
    // Esc on a question sends no hook, so its record can outlive it; the next
    // dialog Claude draws (a permission prompt) also starts with `❯ 1.`.
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', {
      question: 'Pick a veg?',
      choices: [{ key: '1', label: 'Kale' }, { key: '2', label: 'Leek' }],
    });
    await settle();
    h.setScreen([' Do you want to proceed?', ' ❯ 1. Yes', '   2. No']);

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
    expect(h.writes).toEqual([]);

    // The record's own question on screen still answers with the default press.
    const own = makeRegistry();
    await awaitingInput(own.registry, 'pty-a', 'claude', {
      question: 'Pick a veg?',
      choices: [{ key: '1', label: 'Kale' }, { key: '2', label: 'Leek' }],
    });
    await settle();
    own.setScreen(['Pick a veg?', '', '❯ 1. Kale', '  2. Leek', '  3. Type something.']);
    expect(await own.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' })).toMatchObject({ ok: true });
    expect(own.writes).toEqual([{ sessionId: 'pty-a', data: '1' }]);
  });

  it('openclaude answers through the same map as claude', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'openclaude');
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res.ok).toBe(true);
    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '1' }]);
  });
});

describe('ApprovalRegistry — no proof of the own dialog, no bytes', () => {
  const PERMISSION_ROWS = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend'];
  const YES_NO = {
    question: 'Ship it?',
    options: ['Yes', 'No'],
    choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
  };

  it.each([
    ['default approve', { decision: 'approve' as const }],
    ['deny', { decision: 'deny' as const }],
  ])('a record with no choices: %s writes nothing and stays for the desk', async (_label, over) => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', { options: undefined, choices: undefined });
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', resolvedBy: 'phone', ...over });

    expect(res).toMatchObject({ ok: false, reason: 'answer-in-terminal', answerRefusal: 'unsupported-shape' });
    expect(h.writes).toEqual([]);
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it.each([
    ['default approve', { decision: 'approve' as const }],
    ['approve with a choiceKey', { decision: 'approve' as const, choiceKey: '1' }],
    ['deny', { decision: 'deny' as const }],
  ])('a stale "Yes" question facing a permission dialog: %s writes nothing and expires', async (_label, over) => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', YES_NO);
    await settle();
    h.setScreen(PERMISSION_ROWS);

    const res = await h.registry.resolve({ id: 'req-1', resolvedBy: 'phone', ...over });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
    expect(h.writes).toEqual([]);
    expect(h.registry.list().pending).toHaveLength(0);
  });

  it('a question whose options no longer all read back: 409, still pending, nothing written', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    // A narrow pane re-wrapped option 2 into something the prefix rule cannot read.
    h.setScreen(['Which approach should I take?', '❯ 1. Rewrite the parser', '  2. Patch the', '  existing one']);

    for (const decision of ['approve', 'deny'] as const) {
      const res = await h.registry.resolve({ id: 'req-1', decision, resolvedBy: 'phone' });
      expect(res).toMatchObject({ ok: false, reason: 'prompt-changed' });
    }
    expect(h.writes).toEqual([]);
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it.each([
    ['a key or click reached the pane', (m: Harness['mark']) => { m.keyInputRevision += 1; }],
    ['the PTY was replaced', (m: Harness['mark']) => { m.incarnation = 'inc-2'; }],
  ])('%s between the screen read and the write: nothing written, still pending', async (_label, move) => {
    for (const decision of ['approve', 'deny'] as const) {
      const h = makeRegistry();
      await awaitingInput(h.registry);
      await settle();
      h.afterRead(() => move(h.mark));

      const res = await h.registry.resolve({ id: 'req-1', decision, resolvedBy: 'phone' });

      expect(res).toMatchObject({ ok: false, reason: 'prompt-changed' });
      expect(h.writes).toEqual([]);
      expect(h.registry.list().pending).toHaveLength(1);
    }
  });

  it('output between the read and the write: read again; a pane that keeps drawing is never pressed', async () => {
    const once = makeRegistry();
    await awaitingInput(once.registry);
    await settle();
    once.afterRead(() => { once.mark.bytes += 10; });
    expect(await once.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' })).toMatchObject({ ok: true });
    expect(once.writes).toEqual([{ sessionId: 'pty-a', data: '1' }]);

    const busy = makeRegistry();
    await awaitingInput(busy.registry);
    await settle();
    const keepDrawing = (): void => { busy.mark.bytes += 10; busy.afterRead(keepDrawing); };
    busy.afterRead(keepDrawing);
    expect(await busy.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' }))
      .toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(busy.writes).toEqual([]);
  });

  it('an answer-in-terminal refusal cannot be built without naming its cause', () => {
    // Checked by tsc over this file: `answerRefusal` is required on the variant.
    // @ts-expect-error — no answerRefusal
    const missing: ApprovalResolveResult = { ok: false, reason: 'answer-in-terminal' };
    expect(missing.ok).toBe(false);
  });

  it('a registry with no marked screen read cannot prove anything, so it never presses', async () => {
    const h = makeRegistry({ readPromptScreen: undefined, promptScreenMark: undefined });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'answer-in-terminal', answerRefusal: 'screen-unreadable' });
    expect(h.writes).toEqual([]);
  });
});

describe('ApprovalRegistry — questions one key cannot answer (needs-v2)', () => {
  // The record a multi-question AskUserQuestion produced on a live 2.1.283
  // pane: only questions[0] is surfaced, so it LOOKS like a plain select.
  const multiQuestion = {
    question: 'Which size?',
    options: ['Small', 'Large'],
    choices: [{ key: '1', label: 'Small' }, { key: '2', label: 'Large' }],
    questionShape: 'multi-question' as const,
  };
  // Its first tab, as measured (fixtures/terminal-prompts/claude-ask-multi-01-q1.json).
  const Q1_ROWS = [
    '←  ☐ Size  ☐ Toppings  ✔ Submit  →',
    'Which size?',
    '❯ 1. Small',
    '  2. Large',
    '  3. Type something.',
  ];

  it.each([
    ['multi-question, default approve', multiQuestion, undefined],
    ['multi-question, approve with a choiceKey', multiQuestion, '2'],
    ['multi-select, approve with a choiceKey', { ...multiQuestion, questionShape: 'multi-select' as const }, '1'],
  ])('%s → needs-v2, nothing typed, still pending', async (_label, extras, choiceKey) => {
    const h = makeRegistry();
    h.setScreen(Q1_ROWS);
    await h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', ...extras });
    await settle();

    const res = await h.registry.resolve({
      id: 'req-1', decision: 'approve', resolvedBy: 'phone', ...(choiceKey ? { choiceKey } : {}),
    });

    expect(res).toMatchObject({ ok: false, reason: 'needs-v2' });
    expect(h.writes).toEqual([]);
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('a question that is already gone expires rather than answering needs-v2', async () => {
    const h = makeRegistry();
    h.setScreen(NO_PROMPT_ROWS);
    await h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', ...multiQuestion });
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
    expect(h.writes).toEqual([]);
    expect(h.registry.list().pending).toHaveLength(0);
  });

  it('deny still cancels it with Esc — Esc cancels the whole tool whatever its shape', async () => {
    const h = makeRegistry();
    h.setScreen(Q1_ROWS);
    await h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', ...multiQuestion });
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'deny', resolvedBy: 'phone' });

    expect(res.ok).toBe(true);
    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '\x1b' }]);
  });

  it('the shape survives a reload from approvals.json', async () => {
    const h = makeRegistry();
    await h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', ...multiQuestion });
    await settle();
    expect(loadApprovalState(tmpDir).requests[0].questionShape).toBe('multi-question');
  });
});

describe('ApprovalRegistry — supersede and expire', () => {
  it('a second awaiting_input on the same pane supersedes the first', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    await awaitingInput(h.registry);
    await settle();

    const { pending, recentlyResolved } = h.registry.list();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('req-2');
    expect(recentlyResolved[0]).toMatchObject({ id: 'req-1', state: 'superseded' });
    expect(h.events.map((e) => e.type)).toEqual(['create', 'supersede', 'create']);
  });

  it('resolving a superseded request reports expired, not already-resolved', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'expired' });
    expect((res as { request: { state: string } }).request.state).toBe('superseded');
    expect(h.writes).toHaveLength(0);
  });

  it('a pane with a pending request only ever has one, across many prompts', async () => {
    const h = makeRegistry();
    for (let i = 0; i < 5; i++) {
      await awaitingInput(h.registry);
      await settle();
    }
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('expireForSession kills the pending request on THAT pane only', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a');
    await settle();
    await awaitingInput(h.registry, 'pty-b');
    await settle();

    await h.registry.expireForSession('pty-a', 'turn-ended');
    await settle();

    const { pending, recentlyResolved } = h.registry.list();
    expect(pending.map((r) => r.sessionId)).toEqual(['pty-b']);
    expect(recentlyResolved[0]).toMatchObject({ sessionId: 'pty-a', state: 'expired' });
    expect(h.events.filter((e) => e.type === 'expire')).toHaveLength(1);
  });

  /**
   * A turn that opens SEVERAL gated tools plus an AskUserQuestion. Only one
   * pending record is superseded when the question arrives, so a second gate
   * stays pending alongside it — the one way the two kinds coexist (a gate
   * never supersedes another gate; see noteGateAwaiting).
   */
  async function gatesPlusQuestion(dropped: string[]): Promise<{ h: Harness; survivor: string }> {
    const h = makeRegistry({ notifyGateDropped: (id) => { dropped.push(id); } });
    await h.registry.noteGateAwaiting({
      sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'exact', toolName: 'Bash',
    });
    await settle();
    const survivor = await h.registry.noteGateAwaiting({
      sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', toolName: 'Write',
    });
    await settle();
    await awaitingInput(h.registry, 'pty-a');
    await settle();
    return { h, survivor };
  }

  it('expireForSession scoped to awaiting_input leaves a pending gate and its waiter alive', async () => {
    // #770 — answering the question on the PC says nothing about a gate the
    // same turn opened. Sweeping it drops its waiter, so the tool falls back
    // to the local prompt while the phone operator just sees the card vanish.
    const dropped: string[] = [];
    const { h, survivor } = await gatesPlusQuestion(dropped);
    dropped.length = 0; // the question's own supersede already dropped one gate

    await h.registry.expireForSession('pty-a', 'answered-locally', 'awaiting_input');
    await settle();

    const { pending } = h.registry.list();
    expect(pending.map((r) => r.kind)).toEqual(['awaiting_permission']);
    expect(pending[0].id).toBe(survivor);
    expect(dropped).toEqual([]);
  });

  it('an unscoped expireForSession still sweeps every kind (turn-ended backstop)', async () => {
    const dropped: string[] = [];
    const { h, survivor } = await gatesPlusQuestion(dropped);
    dropped.length = 0;

    await h.registry.expireForSession('pty-a', 'turn-ended');
    await settle();

    expect(h.registry.list().pending).toHaveLength(0);
    expect(dropped).toEqual([survivor]);
  });

  it('expiring a pane with nothing pending emits nothing', async () => {
    const h = makeRegistry();
    await h.registry.expireForSession('pty-a', 'pane-gone');
    await settle();
    expect(h.events).toHaveLength(0);
  });

  it('an expired request refuses to resolve and writes nothing', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    await h.registry.expireForSession('pty-a', 'turn-ended');
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'expired' });
    expect(h.writes).toHaveLength(0);
  });
});

describe('ApprovalRegistry — CAS under concurrent resolvers', () => {
  it('two concurrent resolves: one wins, the loser gets already-resolved with the winner named', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    // Hold the FIRST resolve inside its screen read — the exact window where a
    // read-modify-write without a mutation chain would let both callers see
    // 'pending' and both write bytes.
    const letThrough = h.blockScreen();
    const first = h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone-a' });
    await settle();
    const second = h.registry.resolve({ id: 'req-1', decision: 'deny', resolvedBy: 'phone-b' });
    await settle();

    expect(h.writes).toHaveLength(0); // still parked in the verify
    letThrough();

    const [a, b] = await Promise.all([first, second]);

    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: false, reason: 'already-resolved', resolvedBy: 'phone-a' });
    // The whole point: bytes hit the PTY exactly once, and they are the
    // WINNER's bytes.
    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '1' }]);
  });

  it('five concurrent resolves produce exactly one write and four refusals', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: `phone-${i}` }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'already-resolved')).toHaveLength(4);
    expect(h.writes).toHaveLength(1);
  });

  it('a supersede that lands while a resolve is parked cannot steal the pending record', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    const letThrough = h.blockScreen();
    const resolving = h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });
    await settle();
    // A new prompt arrives mid-resolve. It must queue BEHIND the resolve, not
    // flip req-1 to 'superseded' underneath it — so it cannot be awaited here
    // (it will not settle until the resolve ahead of it releases the chain).
    const creating = awaitingInput(h.registry);
    await settle();
    letThrough();

    const res = await resolving;
    await creating;

    expect(res.ok).toBe(true);
    expect(h.writes).toHaveLength(1);
    const { pending, recentlyResolved } = h.registry.list();
    expect(pending.map((r) => r.id)).toEqual(['req-2']);
    expect(recentlyResolved.find((r) => r.id === 'req-1')?.state).toBe('resolved');
  });
});

describe('ApprovalRegistry — pre-write screen re-verify', () => {
  it('refuses with prompt-gone when the select is no longer on screen, and expires the request', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    h.setScreen(NO_PROMPT_ROWS);

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
    expect(h.writes).toHaveLength(0);
    // Refusal expires it: the same tap would just be refused again.
    expect(h.registry.list().pending).toHaveLength(0);
    expect(h.events.map((e) => e.type)).toEqual(['create', 'expire']);
    // The rejected screen is kept so a human can see WHY it was refused.
    expect(h.registry.list().recentlyResolved[0].screenTail).toContain('the lock was never released');
  });

  it('refuses when the screen cannot be read at all (no evidence is not evidence)', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    h.setScreen(null);

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
    expect(h.writes).toHaveLength(0);
  });

  it('refuses when the screen read throws', async () => {
    const h = makeRegistry({
      readPromptScreen: async () => { throw new Error('headless parse blew up'); },
    });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
    expect(h.writes).toHaveLength(0);
  });

  it('a pane that dies between the verify and the write does not report a delivery', async () => {
    const h = makeRegistry({ writeToSession: () => false });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
    expect(h.registry.list().pending).toHaveLength(0);
  });

  it('a throwing PTY write is a refusal, not an exception out of resolve', async () => {
    const h = makeRegistry({
      writeToSession: () => { throw new Error('stream destroyed'); },
    });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res).toMatchObject({ ok: false, reason: 'prompt-gone' });
  });
});

describe('ApprovalRegistry — persistence and recovery invalidation', () => {
  it('a restart expires every pending request it inherits', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry, 'pty-a');
    await settle();
    await awaitingInput(first.registry, 'pty-b');
    await settle();
    expect(first.registry.list().pending).toHaveLength(2);

    // A new daemon reading the same data dir: the panes around it are being
    // recovered as brand-new PTYs, so nothing pending can still be answerable.
    const second = makeRegistry();
    await settle();

    expect(second.registry.list().pending).toHaveLength(0);
    expect(second.registry.list().recentlyResolved.map((r) => r.state)).toEqual([
      'expired',
      'expired',
    ]);
  });

  it('an inherited-then-expired request refuses to resolve after the restart', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry);
    await settle();

    const second = makeRegistry();
    const res = await second.registry.resolve({
      id: 'req-1',
      decision: 'approve',
      resolvedBy: 'phone',
    });

    expect(res).toMatchObject({ ok: false, reason: 'expired' });
    expect(second.writes).toHaveLength(0);
  });

  it('resolved history survives a restart (so the 409 UX can still name the winner)', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry);
    await settle();
    await first.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone-a' });

    const second = makeRegistry();
    const res = await second.registry.resolve({
      id: 'req-1',
      decision: 'approve',
      resolvedBy: 'phone-b',
    });

    expect(res).toMatchObject({ ok: false, reason: 'already-resolved', resolvedBy: 'phone-a' });
  });

  it('a corrupt approvals.json degrades to an empty registry rather than throwing', async () => {
    fs.writeFileSync(getApprovalStatePath(tmpDir), '{ this is not json', 'utf-8');
    const h = makeRegistry();
    expect(h.registry.list().pending).toHaveLength(0);
    // …and it still works from there.
    await awaitingInput(h.registry);
    await settle();
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('terminal history is capped so a long-lived daemon cannot grow the file forever', async () => {
    const h = makeRegistry();
    for (let i = 0; i < RESOLVED_HISTORY_CAP + 10; i++) {
      await awaitingInput(h.registry, `pty-${i}`);
      await settle();
      await h.registry.expireForSession(`pty-${i}`, 'turn-ended');
      await settle();
    }
    expect(h.registry.list().recentlyResolved.length).toBeLessThanOrEqual(RESOLVED_HISTORY_CAP);
  });

  it('list() hands out copies — a caller cannot mutate registry state', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    h.registry.list().pending[0].state = 'resolved';

    expect(h.registry.list().pending[0].state).toBe('pending');
  });
});

describe('A4 — the question a request is asking', () => {
  const asked = { question: 'Which file should I delete?', options: ['src/old.ts', 'src/older.ts'] };

  it('carries the question and options onto the pending record', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', asked);

    expect(h.registry.list().pending[0]).toMatchObject(asked);
  });

  it('survives a restart on the (now expired) history record', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry, 'pty-a', 'claude', asked);

    const second = makeRegistry();
    await settle();

    expect(second.registry.list().recentlyResolved[0]).toMatchObject({
      state: 'expired',
      ...asked,
    });
  });

  it('the options ARRAY is copied, not shared — a consumer cannot edit registry state', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', asked);

    h.registry.list().pending[0].options?.push('rm -rf /');
    h.registry.list().pending[0].options?.reverse();

    expect(h.registry.list().pending[0].options).toEqual(asked.options);
  });

  it('the event payload is copied too', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', asked);

    (h.events[0].request.options as string[]).push('rm -rf /');

    expect(h.registry.list().pending[0].options).toEqual(asked.options);
  });

  it('a request with no question is still created, but never pressed into', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', { question: undefined });

    expect(h.registry.list().pending[0].question).toBeUndefined();
    // Nothing identifies its dialog on screen, so no key can be proven to
    // reach it: answer at the computer, and the record stays.
    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });
    expect(res).toMatchObject({ ok: false, reason: 'answer-in-terminal', answerRefusal: 'unsupported-shape' });
    expect(h.writes).toEqual([]);
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('a hand-edited oversized question is re-truncated on read-back', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry);

    // Simulate a hand-edit / an older build with looser caps.
    const file = getApprovalStatePath(tmpDir);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.requests[0].question = 'z'.repeat(10_000);
    raw.requests[0].options = Array.from({ length: 200 }, () => 'w'.repeat(500));
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');

    const second = makeRegistry();
    const record = second.registry.list().recentlyResolved[0];

    expect(record.question?.length).toBeLessThanOrEqual(MAX_QUESTION_CHARS);
    expect(record.options?.length).toBeLessThanOrEqual(MAX_OPTIONS);
    expect(record.options?.[0].length).toBeLessThanOrEqual(MAX_OPTION_LABEL_CHARS);
  });
});

describe('risk hint — a UI step-up signal, never a gate', () => {
  it('flags a question that names a destructive action', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', {
      question: 'Run `rm -rf build/` to clear the output?',
    });

    expect(h.registry.list().pending[0].risk).toBe('critical');
    expect(h.events[0].request.risk).toBe('critical');
  });

  it('flags on an OPTION label too — the danger can live in the answer, not the question', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', {
      question: 'How should I clean up?',
      options: ['Leave it', 'DROP TABLE sessions'],
    });

    expect(h.registry.list().pending[0].risk).toBe('critical');
  });

  it('is absent — not null, not "safe" — on an ordinary question', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', {
      question: 'Which approach should I take?',
      options: ['Rewrite the parser', 'Patch the existing one'],
    });

    expect('risk' in h.registry.list().pending[0]).toBe(false);
  });

  it('★ never blocks an answer — a flagged request resolves like any other', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', { question: 'git push --force to main?' });
    h.setScreen(['git push --force to main?', '❯ 1. Rewrite the parser', '  2. Patch the existing one', '  3. Type something.']);

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    expect(res.ok).toBe(true);
    expect(h.writes).toHaveLength(1);
  });

  it('survives a restart, and a hand-edited value outside the closed set is dropped', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry, 'pty-a', 'claude', { question: 'terraform destroy prod?' });

    const second = makeRegistry();
    await settle();
    expect(second.registry.list().recentlyResolved[0].risk).toBe('critical');

    const file = getApprovalStatePath(tmpDir);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.requests[0].risk = 'apocalyptic';
    fs.writeFileSync(file, JSON.stringify(raw), 'utf-8');

    const third = makeRegistry();
    expect(third.registry.list().recentlyResolved[0].risk).toBeUndefined();
  });
});

describe('keystroke map v1', () => {
  it('claude maps approve to the first option and deny to ESC', () => {
    expect(keystrokesForAgent('claude')).toEqual({ approve: '1', deny: '\x1b' });
  });

  it('neither keystroke carries a carriage return', () => {
    const keys = keystrokesForAgent('claude');
    expect(keys?.approve).not.toContain('\r');
    expect(keys?.deny).not.toContain('\r');
  });

  it('openclaude (a Claude Code fork, same select) shares the claude map', () => {
    expect(keystrokesForAgent('openclaude')).toEqual({ approve: '1', deny: '\x1b' });
  });

  it('every other agent is unmapped rather than guessed at', () => {
    for (const slug of ['codex', 'gemini', 'opencode', 'aider', '']) {
      expect(keystrokesForAgent(slug)).toBeNull();
    }
  });
});

describe('looksLikeApprovalPrompt', () => {
  it('accepts a cursor-marked option row, framed or bare', () => {
    expect(looksLikeApprovalPrompt(PROMPT_ROWS)).toBe(true);
    expect(looksLikeApprovalPrompt(['❯ 1. Yes'])).toBe(true);
    expect(looksLikeApprovalPrompt(['  > 2) Patch it'])).toBe(true);
  });

  it('rejects a numbered list with no selection cursor', () => {
    expect(looksLikeApprovalPrompt(NO_PROMPT_ROWS)).toBe(false);
  });

  it('rejects an empty or blank screen', () => {
    expect(looksLikeApprovalPrompt([])).toBe(false);
    expect(looksLikeApprovalPrompt(['', '   ', ''])).toBe(false);
  });

  it('rejects a cursor with no option behind it', () => {
    expect(looksLikeApprovalPrompt(['❯ '])).toBe(false);
    expect(looksLikeApprovalPrompt(['❯ 1.'])).toBe(false);
  });
});

describe('resolve durability', () => {
  it('reports durable:true on the normal path', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });
    expect(res).toMatchObject({ ok: true, durable: true });
  });

  it('still resolves, but says so, when the write cannot land', async () => {
    // A wmuxDir that is a FILE: every write under it fails at mkdir. Chosen over
    // making the state file a directory, which atomicWriteJSON survives — it
    // renames the existing target aside before writing.
    const notADir = path.join(tmpDir, 'blocked');
    fs.writeFileSync(notADir, 'not a directory', 'utf8');
    const h = makeRegistry({ wmuxDir: notADir });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone' });

    // ok:true is not a lie — the keystroke IS in the terminal, and the caller
    // must not retry. What failed is the record of it.
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.durable).toBe(false);
    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '1' }]);
  });
});

describe('resolvedBy sanitation', () => {
  it('strips control characters and bounds the length', () => {
    // Persisted per record, interpolated into a daemon log line, and echoed to
    // the loser of a race — so a newline is log injection and an unbounded
    // string is file growth.
    const LF = String.fromCharCode(0x0a);
    const CR = String.fromCharCode(0x0d);
    const NUL = String.fromCharCode(0x00);
    expect(sanitizeResolvedBy(`deck${LF}FAKE LOG LINE`)).toBe('deck FAKE LOG LINE');
    expect(sanitizeResolvedBy(`a${CR}${LF}b${NUL}c`)).toBe('a b c');
    expect(sanitizeResolvedBy('  spaced   out  ')).toBe('spaced out');
    expect(sanitizeResolvedBy('x'.repeat(5_000))).toHaveLength(RESOLVED_BY_MAX);
    expect(sanitizeResolvedBy(undefined)).toBe('');
    expect(sanitizeResolvedBy({ evil: true })).toBe('');
  });

  it('applies at the chokepoint, so no caller can bypass it', async () => {
    const { registry: reg } = makeRegistry();
    // A workspaceId is required for a press: the scope check cannot classify a
    // pane it cannot name, and unknown is a refusal.
    await reg.noteHookAwaitingInput({ sessionId: 'p1', agent: 'claude', workspaceId: 'ws-1', ...PROMPT_RECORD });
    const id = reg.list().pending[0].id;

    const out = await reg.resolve({
      id,
      decision: 'approve',
      resolvedBy:
        'deck' + String.fromCharCode(0x0d) + String.fromCharCode(0x0a) + 'y'.repeat(5_000),
    });

    expect(out.ok).toBe(true);
    const stored = reg.list().recentlyResolved[0].resolvedBy ?? '';
    expect(stored.length).toBeLessThanOrEqual(RESOLVED_BY_MAX);
    expect(stored.includes(String.fromCharCode(0x0d))).toBe(false);
    expect(stored.includes(String.fromCharCode(0x0a))).toBe(false);
  });
it('logs the SANITIZED label, not the raw parameter', async () => {
    // Sanitizing only what gets STORED left the log line taking a CR/LF
    // straight from the caller — clean on disk, forged in the log, which is
    // the injection the sanitizer exists to prevent.
    const lines: string[] = [];
    const { registry: reg } = makeRegistry({
      log: (_level: string, message: string) => { lines.push(message); },
    });
    // A workspaceId is required for a press: the scope check cannot classify a
    // pane it cannot name, and unknown is a refusal.
    await reg.noteHookAwaitingInput({ sessionId: 'p1', agent: 'claude', workspaceId: 'ws-1', ...PROMPT_RECORD });
    const id = reg.list().pending[0].id;

    const LF = String.fromCharCode(0x0a);
    await reg.resolve({
      id,
      decision: 'approve',
      resolvedBy: 'deck' + LF + '[approvals] approve FORGED on p9 by nobody',
    });

    const resolveLine = lines.find((l: string) => l.includes('[approvals] approve'));
    expect(resolveLine).toBeDefined();
    expect((resolveLine ?? "").includes(LF)).toBe(false);
    expect(resolveLine).toContain('deck [approvals] approve FORGED');
  });

  it('bounds a persisted label and screen tail on the way back IN', async () => {
    // approvals.json is plain JSON on disk. Sanitizing only on write left a
    // hand-edited record able to come back unbounded.
    const dir = tmpDir;
    const huge = 'z'.repeat(10_000);
    fs.writeFileSync(
      getApprovalStatePath(dir),
      JSON.stringify({
        version: 1,
        requests: [
          {
            id: 'r1',
            sessionId: 'p1',
            agent: 'claude',
            kind: 'awaiting_input',
            createdAt: 1,
            state: 'resolved',
            resolvedBy: huge,
            screenTail: Array.from({ length: 500 }, () => huge).join('\n'),
          },
        ],
      }),
      'utf8',
    );

    const { registry: reg } = makeRegistry();
    const record = reg.list().recentlyResolved[0];
    const resolvedBy = record.resolvedBy ?? '';
    const screenTail = record.screenTail ?? '';
    expect(resolvedBy.length).toBeLessThanOrEqual(RESOLVED_BY_MAX);
    expect(screenTail.split('\n')).toHaveLength(SCREEN_TAIL_ROWS);
    for (const row of screenTail.split('\n')) {
      expect(row.length).toBeLessThanOrEqual(SCREEN_TAIL_ROW_CHARS);
    }
  });
});

describe('choices and choiceKey — per-option resolve', () => {
  const CHOICES_INPUT = {
    question: 'Which approach should I take?',
    options: ['Rewrite the parser', 'Patch the existing one'],
    choices: [
      { key: '1', label: 'Rewrite the parser' },
      { key: '2', label: 'Patch the existing one' },
    ],
  };

  /** A screen that shows option 2 with a cursor on it. */
  const SCREEN_WITH_CHOICE_2 = [
    '╭──────────────────────────────────────────╮',
    '│ Which approach should I take?             │',
    '│                                          │',
    '│   1. Rewrite the parser                   │',
    '│ ❯ 2. Patch the existing one              │',
    '│   3. Type something.                     │',
    '╰──────────────────────────────────────────╯',
  ];

  it('carries choices onto the pending record', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', CHOICES_INPUT);

    const pending = h.registry.list().pending[0];
    expect(pending.choices).toEqual(CHOICES_INPUT.choices);
  });

  it('choices are deep-copied — a consumer cannot mutate registry state', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', CHOICES_INPUT);

    const pending = h.registry.list().pending[0];
    pending.choices![0].key = '99';
    pending.choices!.push({ key: '3', label: 'injected' });

    expect(h.registry.list().pending[0].choices).toEqual(CHOICES_INPUT.choices);
  });

  it('resolving with a valid choiceKey sends that digit (not the default "1")', async () => {
    const h = makeRegistry();
    h.setScreen(SCREEN_WITH_CHOICE_2);
    await awaitingInput(h.registry, 'pty-a', 'claude', CHOICES_INPUT);
    await settle();

    const res = await h.registry.resolve({
      id: 'req-1',
      decision: 'approve',
      resolvedBy: 'phone',
      choiceKey: '2',
    });

    expect(res.ok).toBe(true);
    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '2' }]);
  });

  it('persists selectedChoiceKey on the resolved record', async () => {
    const h = makeRegistry();
    h.setScreen(SCREEN_WITH_CHOICE_2);
    await awaitingInput(h.registry, 'pty-a', 'claude', CHOICES_INPUT);
    await settle();

    await h.registry.resolve({
      id: 'req-1',
      decision: 'approve',
      resolvedBy: 'phone',
      choiceKey: '2',
    });

    const resolved = h.registry.list().recentlyResolved[0];
    expect(resolved.selectedChoiceKey).toBe('2');
  });

  it('choiceKey that does not belong to the stored choices fails with invalid-choice-key', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', CHOICES_INPUT);
    await settle();

    const res = await h.registry.resolve({
      id: 'req-1',
      decision: 'approve',
      resolvedBy: 'phone',
      choiceKey: '9',
    });

    expect(res).toMatchObject({ ok: false, reason: 'invalid-choice-key' });
    expect(h.writes).toHaveLength(0);
    // Request stays pending — a valid key can still be sent.
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('choiceKey on a request with no choices fails with invalid-choice-key', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', { options: undefined, choices: undefined });
    await settle();

    const res = await h.registry.resolve({
      id: 'req-1',
      decision: 'approve',
      resolvedBy: 'phone',
      choiceKey: '1',
    });

    expect(res).toMatchObject({ ok: false, reason: 'invalid-choice-key' });
    expect(h.writes).toHaveLength(0);
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('choiceKey fails when the option is not visible on screen', async () => {
    const h = makeRegistry();
    // Screen only shows option 1, not option 2
    h.setScreen([
      '╭──────────────────────────────────────────╮',
      '│ Which approach should I take?             │',
      '│ ❯ 1. Rewrite the parser                   │',
      '╰──────────────────────────────────────────╯',
    ]);
    await awaitingInput(h.registry, 'pty-a', 'claude', CHOICES_INPUT);
    await settle();

    const res = await h.registry.resolve({
      id: 'req-1',
      decision: 'approve',
      resolvedBy: 'phone',
      choiceKey: '2',
    });

    // The question is there but not every option reads back: the dialog is not
    // proven, so nothing is pressed (not even the key whose row IS visible).
    expect(res).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toHaveLength(0);
    // Still pending — not expired, because the prompt IS there, just not this choice.
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('omitting choiceKey preserves default behavior: approve sends "1"', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', CHOICES_INPUT);
    await settle();

    const res = await h.registry.resolve({
      id: 'req-1',
      decision: 'approve',
      resolvedBy: 'phone',
      // No choiceKey
    });

    expect(res.ok).toBe(true);
    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '1' }]);
  });

  it('omitting choiceKey preserves default behavior: deny sends ESC', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', CHOICES_INPUT);
    await settle();

    const res = await h.registry.resolve({
      id: 'req-1',
      decision: 'deny',
      resolvedBy: 'phone',
    });

    expect(res.ok).toBe(true);
    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '\x1b' }]);
  });

  it('empty string choiceKey fails closed instead of pressing the first option', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry, 'pty-a', 'claude', CHOICES_INPUT);
    await settle();

    const res = await h.registry.resolve({
      id: 'req-1',
      decision: 'approve',
      resolvedBy: 'phone',
      choiceKey: '',
    });

    expect(res).toMatchObject({ ok: false, reason: 'invalid-choice-key' });
    expect(h.writes).toHaveLength(0);
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('deny with a choiceKey fails closed instead of sending an affirmative digit', async () => {
    const h = makeRegistry();
    h.setScreen(SCREEN_WITH_CHOICE_2);
    await awaitingInput(h.registry, 'pty-a', 'claude', CHOICES_INPUT);
    await settle();

    const res = await h.registry.resolve({
      id: 'req-1',
      decision: 'deny',
      resolvedBy: 'phone',
      choiceKey: '2',
    });

    expect(res).toMatchObject({ ok: false, reason: 'invalid-choice-key' });
    expect(h.writes).toHaveLength(0);
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('choices survive a restart on the history record', async () => {
    const first = makeRegistry();
    await awaitingInput(first.registry, 'pty-a', 'claude', CHOICES_INPUT);

    const second = makeRegistry();
    await settle();

    expect(second.registry.list().recentlyResolved[0].choices).toEqual(CHOICES_INPUT.choices);
  });

  it('selectedChoiceKey survives a restart', async () => {
    const first = makeRegistry();
    first.setScreen(SCREEN_WITH_CHOICE_2);
    await awaitingInput(first.registry, 'pty-a', 'claude', CHOICES_INPUT);
    await settle();
    await first.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'phone', choiceKey: '2' });

    const second = makeRegistry();
    await settle();

    const record = second.registry.list().recentlyResolved.find((r) => r.id === 'req-1');
    expect(record?.selectedChoiceKey).toBe('2');
  });
});

describe('looksLikeChoiceOnScreen', () => {
  it('finds a visible option with the correct digit and label prefix', () => {
    const rows = ['│ ❯ 2. Patch the existing one              │'];
    expect(looksLikeChoiceOnScreen(rows, '2', 'Patch the existing one')).toBe(true);
  });

  it('matches partial label (20-char prefix)', () => {
    const rows = ['  > 1. This is a very long option label that goes on and on'];
    expect(looksLikeChoiceOnScreen(rows, '1', 'This is a very long option label that goes on')).toBe(true);
  });

  it('rejects a different digit for the same label', () => {
    const rows = ['│ ❯ 2. Patch the existing one              │'];
    expect(looksLikeChoiceOnScreen(rows, '1', 'Patch the existing one')).toBe(false);
  });

  it('rejects when the label is not on screen at all', () => {
    const rows = ['│ ❯ 1. Rewrite the parser                   │'];
    expect(looksLikeChoiceOnScreen(rows, '2', 'Patch the existing one')).toBe(false);
  });

  it('works with ) separator', () => {
    const rows = ['  ❯ 3) Third option here'];
    expect(looksLikeChoiceOnScreen(rows, '3', 'Third option here')).toBe(true);
  });

  it('returns false for empty rows', () => {
    expect(looksLikeChoiceOnScreen([], '1', 'anything')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Press scope — WHICH panes may be pressed at all
// ---------------------------------------------------------------------------
// The screen check answers "can these bytes be pressed". This answers the prior
// question, and it fails closed: a fact nobody established is a refusal, not a
// permission. A refusal here is NOT an expiry — the request stays live so a
// human at the desktop can still answer it themselves.
describe('decideApprovalPress — the four conditions', () => {
  const inScope = {
    resolver: 'automated' as const,
    decision: 'approve' as const,
    scopeAvailable: true,
    isTaskWorkspace: true,
    // A REAL mode. The earlier fixture said 'manual', which no store has ever
    // written — the whitelist happened to carry it too, so the pair agreed with
    // each other and with nothing else.
    autonomyMode: 'assist',
    approvalPress: true,
    origin: 'hook' as const,
    stillOnScreen: true,
    ownerMode: 'danger',
    attribution: 'exact' as const,
  };

  it('presses when all four hold', () => {
    expect(decideApprovalPress(inScope)).toEqual({ press: true });
  });

  // The capability, not the mode, is the authorization: main narrows it to
  // false for a `report` loop inside a 'danger' workspace, and the brain's own
  // autonomy readout says approval-press=off there.
  it('refuses when the effective approvalPress capability is off, whatever the mode says', () => {
    expect(decideApprovalPress({ ...inScope, autonomyMode: 'danger', approvalPress: false })).toEqual({
      press: false,
      reason: 'press-capability-off',
    });
  });

  it('refuses when the capability was never established', () => {
    expect(decideApprovalPress({ ...inScope, approvalPress: undefined })).toEqual({
      press: false,
      reason: 'press-capability-unknown',
    });
  });

  it('does not recognise a mode no store writes', () => {
    expect(decideApprovalPress({ ...inScope, autonomyMode: 'manual' })).toEqual({
      press: false,
      reason: 'unknown-autonomy-mode',
    });
  });

  // A person tapping Approve is LOOKING at the prompt. Gating them behind a
  // workspace classification is not safety, it is a broken button.
  it('never applies to a human, whatever the scope says', () => {
    expect(
      decideApprovalPress({ ...inScope, resolver: 'human', isTaskWorkspace: false }),
    ).toEqual({ press: true });
    expect(decideApprovalPress({ resolver: 'human' })).toEqual({ press: true });
  });

  // Denying cancels the tool call and hands the turn back — the safe direction.
  // Refusing it would keep a pane blocked in the name of protecting it.
  it('never blocks a deny, from any caller', () => {
    expect(decideApprovalPress({ ...inScope, decision: 'deny', isTaskWorkspace: false })).toEqual({
      press: true,
    });
    expect(decideApprovalPress({ resolver: 'automated', decision: 'deny' })).toEqual({
      press: true,
    });
  });

  // "Nobody wired the lookup" and "the workspace said no" are different
  // problems, and only one of them is fixed by an integration commit.
  it('names a missing scope source distinctly from a workspace that said no', () => {
    expect(decideApprovalPress({ ...inScope, scopeAvailable: false })).toEqual({
      press: false,
      reason: 'scope-unavailable',
    });
  });

  it('refuses an autonomy mode it does not recognise (a whitelist, not a blacklist)', () => {
    // Matching only the literal 'off' meant a typo in the store, or a newer
    // main writing a name we predate, read as permission.
    expect(decideApprovalPress({ ...inScope, autonomyMode: 'supervised' })).toEqual({
      press: false,
      reason: 'unknown-autonomy-mode',
    });
    expect(decideApprovalPress({ ...inScope, autonomyMode: 'assist' })).toEqual({ press: true });
  });

  it('refuses a hand-opened pane (its workspace is not a task workspace)', () => {
    expect(decideApprovalPress({ ...inScope, isTaskWorkspace: false })).toEqual({
      press: false,
      reason: 'not-a-task-workspace',
    });
  });

  it('refuses the parent workspace a fan-out was launched from', () => {
    // Same shape as a hand-opened pane: the parent was never delegated.
    expect(decideApprovalPress({ ...inScope, isTaskWorkspace: false }).press).toBe(false);
  });

  it('refuses when autonomy is off — the human answers their own prompts', () => {
    expect(decideApprovalPress({ ...inScope, autonomyMode: 'off' })).toEqual({
      press: false,
      reason: 'autonomy-off',
    });
  });

  it('refuses a detector-only prompt (a numbered list in a diff is not a select)', () => {
    expect(decideApprovalPress({ ...inScope, origin: 'detector' })).toEqual({
      press: false,
      reason: 'detector-only',
    });
  });

  it('refuses when the verify-then-press re-read no longer shows the prompt', () => {
    expect(decideApprovalPress({ ...inScope, stillOnScreen: false })).toEqual({
      press: false,
      reason: 'prompt-gone',
    });
  });

  it('an UNESTABLISHED fact is a refusal, never an assumption', () => {
    expect(decideApprovalPress({}).press).toBe(false);
    expect(decideApprovalPress({ ...inScope, isTaskWorkspace: undefined })).toEqual({
      press: false,
      reason: 'workspace-unknown',
    });
    expect(decideApprovalPress({ ...inScope, autonomyMode: undefined })).toEqual({
      press: false,
      reason: 'autonomy-unknown',
    });
  });
});

describe('ApprovalRegistry — press scope is enforced at resolve', () => {
  const automatedApprove = { decision: 'approve' as const, resolvedBy: 'deck', resolver: 'automated' as const };

  it.each([
    { autonomyMode: 'off', approvalPress: false, reason: 'autonomy-off' },
    { autonomyMode: 'assist', approvalPress: false, reason: 'press-capability-off' },
  ])('refuses automated permission gates with $reason without allowing the hook', async (scope) => {
    const broker = new GateBroker();
    const h = makeRegistry({
      pressScope: () => ({ isTaskWorkspace: true, ...scope }),
      notifyGateResolved: (id, decision) => broker.notifyResolved(id, decision),
    });
    const id = h.registry.noteGateAwaiting({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'exact', toolName: 'Bash' });
    await settle();
    let answered = false;
    const verdict = broker.awaitVerdict(id, 'pty-a').then(value => { answered = true; return value; });
    try {
      expect(await h.registry.resolve({ id, ...automatedApprove })).toMatchObject({
        ok: false, reason: 'out-of-scope', pressRefusal: scope.reason,
      });
      expect(answered).toBe(false);
      expect(h.registry.list().pending.map(r => r.id)).toEqual([id]);
      expect(h.events.map(e => e.type)).toEqual(['create']);
      expect(h.writes).toEqual([]);
    } finally { broker.cancelAll('test-teardown'); }
    expect(await verdict).toMatchObject({ decision: 'defer' });
  });

  // #1541 review: the screen press read scope BEFORE the last awaited
  // reauthorize (up to 2 s). Autonomy turned off inside that window must still
  // stop the keystroke, as it already does on the gate branch.
  it('re-checks scope after the final reauthorize, so a policy flip mid-press writes nothing', async () => {
    let scope: { isTaskWorkspace: boolean; autonomyMode: string; approvalPress: boolean; ownerMode?: string } =
      { isTaskWorkspace: true, autonomyMode: 'assist', approvalPress: true, ownerMode: 'danger' };
    const h = makeRegistry({ pressScope: () => scope });
    await awaitingInput(h.registry);
    await settle();
    let calls = 0;

    const res = await h.registry.resolve({
      id: 'req-1',
      ...automatedApprove,
      authorize: async () => {
        calls += 1;
        // The operator flips autonomy off while the final check is in flight.
        if (calls === 2) scope = { isTaskWorkspace: true, autonomyMode: 'off', approvalPress: false };
        return 'ok';
      },
    });

    expect(calls).toBe(2);
    expect(res).toMatchObject({ ok: false, reason: 'out-of-scope', pressRefusal: 'autonomy-off' });
    expect(h.writes).toEqual([]);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual(['req-1']);
  });

  it('allows an automated permission gate when workspace autonomy permits it', async () => {
    const broker = new GateBroker();
    const h = makeRegistry({ notifyGateResolved: (id, decision) => broker.notifyResolved(id, decision) });
    h.setScreen(null); // Permission hooks wait in the broker, not on a TUI prompt.
    const id = h.registry.noteGateAwaiting({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'exact', toolName: 'Bash' });
    await settle();
    const verdict = broker.awaitVerdict(id, 'pty-a');
    try {
      expect(await h.registry.resolve({ id, ...automatedApprove })).toMatchObject({ ok: true });
      expect(await verdict).toEqual({ decision: 'allow', reason: 'answered' });
      expect(h.registry.list().pending).toEqual([]);
      expect(h.writes).toEqual([]);
    } finally { broker.cancelAll('test-teardown'); }
  });


  it('refuses an out-of-scope AUTOMATED press WITHOUT expiring the request', async () => {
    const h = makeRegistry({ pressScope: () => ({ isTaskWorkspace: false, autonomyMode: 'assist', approvalPress: true }) });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', ...automatedApprove });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toBe('out-of-scope');
    // No bytes, and the request is still answerable by a human.
    expect(h.writes).toHaveLength(0);
    expect(h.registry.list().pending).toHaveLength(1);
  });

  // The relay in main (`approval.press`) turns a refusal into a hint for the
  // brain and decides whether the operator's own policy said no. 'out-of-scope'
  // is one bucket for eight conditions, so without this field every one of
  // those decisions was made on a reason string that never arrives.
  it('names the CONCRETE press condition alongside the bucketed wire reason', async () => {
    const h = makeRegistry({
      pressScope: () => ({ isTaskWorkspace: true, autonomyMode: 'assist', approvalPress: false }),
    });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', ...automatedApprove });
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toBe('out-of-scope');
    expect(res.pressRefusal).toBe('press-capability-off');
    expect(h.writes).toHaveLength(0);
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('distinguishes a workspace that said no from one it could not classify', async () => {
    const h = makeRegistry({
      pressScope: () => ({ isTaskWorkspace: false, autonomyMode: 'danger', approvalPress: true }),
    });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', ...automatedApprove });
    if (res.ok) throw new Error('expected a refusal');
    expect(res.pressRefusal).toBe('not-a-task-workspace');

    const unwired = makeRegistry({ pressScope: () => null });
    await awaitingInput(unwired.registry);
    await settle();
    const res2 = await unwired.registry.resolve({ id: 'req-1', ...automatedApprove });
    if (res2.ok) throw new Error('expected a refusal');
    expect(res2.pressRefusal).toBe('scope-unavailable');
  });

  // The regression this round caught: with the scope source unwired, EVERY
  // resolve was refused — including the person tapping Approve on their phone.
  it('lets a human approve even with no scope source wired at all', async () => {
    const h = makeRegistry({ pressScope: undefined });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'approve', resolvedBy: 'web' });
    expect(res.ok).toBe(true);
    expect(h.writes).toHaveLength(1);
  });

  it('lets a human deny in a workspace an automated press could not touch', async () => {
    const h = makeRegistry({ pressScope: () => ({ isTaskWorkspace: false, autonomyMode: 'off', approvalPress: false }) });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', decision: 'deny', resolvedBy: 'web' });
    expect(res.ok).toBe(true);
    expect(h.writes).toHaveLength(1);
  });

  // A refused deny would leave the record alive to be re-tapped forever, which
  // is how "safety" turns into a pane nobody can unblock.
  it('lets an AUTOMATED deny through regardless of scope', async () => {
    const h = makeRegistry({ pressScope: () => ({ isTaskWorkspace: false, autonomyMode: 'off', approvalPress: false }) });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({
      id: 'req-1',
      decision: 'deny',
      resolvedBy: 'deck',
      resolver: 'automated',
    });
    expect(res.ok).toBe(true);
    expect(h.writes).toHaveLength(1);
  });

  it('refuses an automated press with no scope source, and says so in the log', async () => {
    const logs: string[] = [];
    const h = makeRegistry({
      pressScope: undefined,
      log: (_level, message) => logs.push(message),
    });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', ...automatedApprove });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toBe('out-of-scope');
    expect(h.writes).toHaveLength(0);
    // The missing integration wiring must be visible, not look like policy.
    expect(logs.join('\n')).toContain('pressScope');
  });

  // Wired, but main has never pushed its table (the daemon started before the
  // GUI, or the GUI is closed). That is the same absence of evidence as no feed
  // at all, and it must NOT read as an empty answer about the workspace.
  it('treats an unpublished fact table as no scope source, not as "not a task workspace"', async () => {
    const logs: string[] = [];
    const h = makeRegistry({ pressScope: () => null, log: (_level, message) => logs.push(message) });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', ...automatedApprove });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toBe('out-of-scope');
    expect(h.writes).toHaveLength(0);
    // …and it names the RIGHT missing thing: the feed is wired, main has just
    // not published. Sending an operator to check the wiring for that is how a
    // one-line fix becomes an afternoon.
    expect(logs.join('\n')).toContain('has not published');
    expect(logs.join('\n')).not.toContain('is not wired');
  });

  // A record with no workspace at all (a hook envelope that carried none) is a
  // third cause, and it is in the payload, not in the integration.
  it('names the record, not the wiring, when the request has no workspaceId', async () => {
    const logs: string[] = [];
    const h = makeRegistry({ log: (_level, message) => logs.push(message) });
    await h.registry.noteHookAwaitingInput({ sessionId: 'pty-a', agent: 'claude', attribution: 'exact', ...PROMPT_RECORD });
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', ...automatedApprove });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toBe('out-of-scope');
    expect(logs.join('\n')).toContain('carries no workspaceId');
    expect(logs.join('\n')).not.toContain('is not wired');
  });

  // A workspace main DID answer about, and declined to classify. Different
  // reason, same refusal — and the log must not blame the wiring.
  it('refuses a workspace absent from a published table without blaming the wiring', async () => {
    const logs: string[] = [];
    const h = makeRegistry({ pressScope: () => ({}), log: (_level, message) => logs.push(message) });
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({ id: 'req-1', ...automatedApprove });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toBe('out-of-scope');
    expect(logs.join('\n')).toContain('workspace-unknown');
    expect(logs.join('\n')).not.toContain('scope source');
  });
});

describe('ApprovalRegistry — caller re-authorization inside the chain', () => {
  type Verdict = 'ok' | 'expired' | 'read-only';

  async function pendingGate(h: Harness): Promise<string> {
    const id = h.registry.noteGateAwaiting({
      sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'exact', toolName: 'Bash',
    });
    await settle();
    return id;
  }

  it('a gate whose caller is no longer authorized is refused and stays pending', async () => {
    const woken: string[] = [];
    const h = makeRegistry({ notifyGateResolved: (id) => { woken.push(id); } });
    const id = await pendingGate(h);

    const res = await h.registry.resolve({
      id, decision: 'approve', resolvedBy: 'phone', authorize: async () => 'expired',
    });

    expect(res).toMatchObject({ ok: false, reason: 'unauthorized' });
    expect(woken).toEqual([]);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([id]);
    expect(h.events.map((e) => e.type)).toEqual(['create']);
  });

  // The second call is the one right before the waiter wakes. A check made
  // only at the top of the link would let this approval run the tool.
  it('a gate re-checks immediately before waking the waiter', async () => {
    const woken: string[] = [];
    const h = makeRegistry({ notifyGateResolved: (id) => { woken.push(id); } });
    const id = await pendingGate(h);
    const verdicts: Verdict[] = ['ok', 'expired'];

    const res = await h.registry.resolve({
      id, decision: 'approve', resolvedBy: 'phone', authorize: async () => verdicts.shift() ?? 'expired',
    });

    expect(res).toMatchObject({ ok: false, reason: 'unauthorized' });
    expect(verdicts).toEqual([]);
    expect(woken).toEqual([]);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([id]);
    expect(h.events.map((e) => e.type)).toEqual(['create']);
  });

  // The check runs inside the one mutation link. A check that never settles
  // must not stall the registry: it fails closed as retryable, the record is
  // untouched, and the next resolve still runs.
  it('an authorize that never settles times out, stays pending, and frees the chain', async () => {
    const woken: string[] = [];
    const h = makeRegistry({ notifyGateResolved: (id) => { woken.push(id); }, authorizeTimeoutMs: 20 });
    const id = await pendingGate(h);

    const res = await h.registry.resolve({
      id, decision: 'approve', resolvedBy: 'phone', authorize: () => new Promise<Verdict>(() => {}),
    });

    expect(res).toMatchObject({ ok: false, reason: 'authorization-unconfirmed' });
    expect(woken).toEqual([]);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([id]);
    const next = await h.registry.resolve({ id, decision: 'approve', resolvedBy: 'desktop' });
    expect(next).toMatchObject({ ok: true });
    expect(woken).toEqual([id]);
  });

  it('a grant narrowed during the screen re-read writes no bytes', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    let verdict: Verdict = 'ok';
    const seen: string[] = [];

    const letThrough = h.blockScreen();
    const pending = h.registry.resolve({
      id: 'req-1', decision: 'approve', resolvedBy: 'phone',
      authorize: async (record) => { seen.push(record.id); return verdict; },
    });
    await settle();
    verdict = 'read-only';
    letThrough();
    const res = await pending;

    expect(res).toMatchObject({ ok: false, reason: 'input-revoked' });
    expect(seen).toEqual(['req-1', 'req-1']);
    expect(h.writes).toHaveLength(0);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual(['req-1']);
    expect(h.events.map((e) => e.type)).toEqual(['create']);
  });

  it('a revoked caller cannot expire a request whose prompt left the screen', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();
    h.setScreen(NO_PROMPT_ROWS);

    const res = await h.registry.resolve({
      id: 'req-1', decision: 'approve', resolvedBy: 'phone', authorize: async () => 'expired',
    });

    expect(res).toMatchObject({ ok: false, reason: 'unauthorized' });
    expect(h.registry.list().pending.map((r) => r.id)).toEqual(['req-1']);
    expect(h.events.map((e) => e.type)).toEqual(['create']);
  });

  it('a throwing authorize fails closed as unauthorized', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({
      id: 'req-1', decision: 'approve', resolvedBy: 'phone',
      authorize: () => { throw new Error('roster unreadable'); },
    });

    expect(res).toMatchObject({ ok: false, reason: 'unauthorized' });
    expect(h.writes).toHaveLength(0);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual(['req-1']);
  });

  it('an authorized caller resolves exactly as before', async () => {
    const h = makeRegistry();
    await awaitingInput(h.registry);
    await settle();

    const res = await h.registry.resolve({
      id: 'req-1', decision: 'approve', resolvedBy: 'phone', authorize: async () => 'ok',
    });

    expect(res.ok).toBe(true);
    expect(h.writes).toEqual([{ sessionId: 'pty-a', data: '1' }]);
  });
});

// ── C2 v2: the owner's live mode and the critical flag (HQ approval lane) ────
describe('decideApprovalPress — owner live mode and critical risk', () => {
  const inScope = {
    resolver: 'automated' as const,
    decision: 'approve' as const,
    scopeAvailable: true,
    isTaskWorkspace: true,
    autonomyMode: 'danger',
    approvalPress: true,
    origin: 'hook' as const,
    stillOnScreen: true,
    ownerMode: 'danger',
    attribution: 'exact' as const,
  };

  // The task workspace still carries the `danger` copy it took at fan-out; the
  // owner has since been lowered. Before C2 v2 the owner's mode was not a fact
  // at all, so this pressed.
  it('refuses an automated approve once the owner was lowered after the fan-out', () => {
    expect(decideApprovalPress({ ...inScope, ownerMode: 'assist' })).toEqual({ press: false, reason: 'owner-not-danger' });
    expect(decideApprovalPress({ ...inScope, ownerMode: 'off' })).toEqual({ press: false, reason: 'owner-autonomy-off' });
  });

  it('refuses when the task has no single owner to read (none, or several)', () => {
    expect(decideApprovalPress({ ...inScope, ownerMode: undefined })).toEqual({ press: false, reason: 'owner-mode-unknown' });
  });

  it('refuses an automated approve of a critical record', () => {
    expect(decideApprovalPress({ ...inScope, risk: 'critical' })).toEqual({ press: false, reason: 'critical-risk' });
  });

  it('still lets a deny and a human approve through on a critical record', () => {
    expect(decideApprovalPress({ ...inScope, risk: 'critical', decision: 'deny' })).toEqual({ press: true });
    expect(decideApprovalPress({ ...inScope, risk: 'critical', resolver: 'human' })).toEqual({ press: true });
  });
});

describe('ApprovalRegistry — critical gates and the owner floor at resolve', () => {
  const automatedApprove = { decision: 'approve' as const, resolvedBy: 'hq:ws-hq;owner:ws-own;lane:hq', resolver: 'automated' as const };

  it('flags a gate critical from its input, and refuses the automated approve without a second event', async () => {
    const broker = new GateBroker();
    const h = makeRegistry({ notifyGateResolved: (id, decision) => broker.notifyResolved(id, decision) });
    h.setScreen(null);
    const id = h.registry.noteGateAwaiting({
      sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'exact', toolName: 'Bash', toolInputSummary: 'rm -rf build/',
    });
    await settle();
    try {
      expect(h.registry.list().pending[0]).toMatchObject({ id, risk: 'critical' });
      expect(await h.registry.resolve({ id, ...automatedApprove })).toMatchObject({
        ok: false, reason: 'out-of-scope', pressRefusal: 'critical-risk',
      });
      // Still pending for the human, and nothing new was announced: the
      // existing approval is the only notification.
      expect(h.registry.list().pending.map((r) => r.id)).toEqual([id]);
      expect(h.events.map((e) => e.type)).toEqual(['create']);
      // A human approve still answers it.
      expect(await h.registry.resolve({ id, decision: 'approve', resolvedBy: 'phone' })).toMatchObject({ ok: true });
    } finally { broker.cancelAll('test-teardown'); }
  });

  it('takes the ingest verdict on the full input even when the summary was cut', async () => {
    const h = makeRegistry();
    const id = h.registry.noteGateAwaiting({
      sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'exact', toolName: 'Bash', toolInputSummary: 'echo ok', risk: 'critical',
    });
    await settle();
    expect(h.registry.list().pending.find((r) => r.id === id)?.risk).toBe('critical');
  });

  it('lets an automated deny through on a critical gate', async () => {
    const broker = new GateBroker();
    const h = makeRegistry({ notifyGateResolved: (id, decision) => broker.notifyResolved(id, decision) });
    h.setScreen(null);
    const id = h.registry.noteGateAwaiting({
      sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'exact', toolName: 'Bash', toolInputSummary: 'git push --force',
    });
    await settle();
    try {
      expect(await h.registry.resolve({ id, ...automatedApprove, decision: 'deny' })).toMatchObject({ ok: true });
    } finally { broker.cancelAll('test-teardown'); }
  });

  it('refuses when the task copy still says danger but the owner was lowered', async () => {
    const broker = new GateBroker();
    const h = makeRegistry({
      pressScope: () => ({ isTaskWorkspace: true, autonomyMode: 'danger', approvalPress: true, ownerMode: 'assist' }),
      notifyGateResolved: (id, decision) => broker.notifyResolved(id, decision),
    });
    h.setScreen(null);
    const id = h.registry.noteGateAwaiting({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'exact', toolName: 'Bash' });
    await settle();
    try {
      expect(await h.registry.resolve({ id, ...automatedApprove })).toMatchObject({
        ok: false, reason: 'out-of-scope', pressRefusal: 'owner-not-danger',
      });
    } finally { broker.cancelAll('test-teardown'); }
  });

  // A phone tap and the HQ lane on the same gate: one answer wins, the history
  // holds that one answer, and when the lane won it names the owner it acted for.
  it('records exactly one history entry when a phone resolve races an HQ press', async () => {
    const broker = new GateBroker();
    const h = makeRegistry({ notifyGateResolved: (id, decision) => broker.notifyResolved(id, decision) });
    h.setScreen(null);
    const id = h.registry.noteGateAwaiting({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'exact', toolName: 'Bash' });
    await settle();
    try {
      const [hq, phone] = await Promise.all([
        h.registry.resolve({ id, ...automatedApprove }),
        h.registry.resolve({ id, decision: 'deny', resolvedBy: 'phone:device-1' }),
      ]);
      expect([hq.ok, phone.ok].filter(Boolean)).toHaveLength(1);
      const history = h.registry.list().recentlyResolved.filter((r) => r.id === id);
      expect(history).toHaveLength(1);
      expect(history[0]!.resolvedBy).toBe(hq.ok ? 'hq:ws-hq;owner:ws-own;lane:hq' : 'phone:device-1');
      expect(h.events.filter((e) => e.type === 'resolve')).toHaveLength(1);
    } finally { broker.cancelAll('test-teardown'); }
  });

  it('keeps the full HQ audit label within the resolvedBy cap', () => {
    const ws = 'w'.repeat(80);
    const label = `hq:${ws};owner:${ws};lane:hq`;
    expect(sanitizeResolvedBy(label)).toBe(label);
  });
});

// ── #1767 review: attribution, the lane re-check at release, check order ─────
describe('ApprovalRegistry — #1767 review hardening', () => {
  const laneApprove = {
    decision: 'approve' as const,
    resolvedBy: 'hq:ws-hq;owner:ws-own;lane:hq',
    resolver: 'automated' as const,
    lane: 'hq' as const,
    laneGeneration: 4,
  };

  // A Claude started outside wmux that cd's into a task worktree is routed to
  // the task pane by cwd. Its gate is inexact and no machine approves it.
  it('never auto-approves a gate attributed by cwd rather than by pane id', async () => {
    const broker = new GateBroker();
    const h = makeRegistry({ notifyGateResolved: (id, decision) => broker.notifyResolved(id, decision) });
    h.setScreen(null);
    const id = h.registry.noteGateAwaiting({
      sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'inexact', toolName: 'Bash',
    });
    const unmarked = h.registry.noteGateAwaiting({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', toolName: 'Edit' });
    await settle();
    try {
      for (const target of [id, unmarked]) {
        expect(await h.registry.resolve({ id: target, decision: 'approve', resolvedBy: 'deck', resolver: 'automated' })).toMatchObject({
          ok: false, pressRefusal: 'attribution-inexact',
        });
      }
      // A human still answers it.
      expect(await h.registry.resolve({ id, decision: 'approve', resolvedBy: 'phone' })).toMatchObject({ ok: true });
    } finally { broker.cancelAll('test-teardown'); }
  });

  // The policy closes while the resolve waits in the chain: the lane is read at
  // release, not when the caller checked it.
  it('refuses an HQ-lane approve when the lane policy is revoked while it is queued', async () => {
    const broker = new GateBroker();
    let lane = { open: true, generation: 4 };
    const h = makeRegistry({
      hqLane: () => lane,
      notifyGateResolved: (id, decision) => broker.notifyResolved(id, decision),
    });
    h.setScreen(null);
    const id = h.registry.noteGateAwaiting({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'exact', toolName: 'Bash' });
    await settle();
    try {
      const res = await h.registry.resolve({
        id,
        ...laneApprove,
        authorize: async () => {
          // Main publishes "Moa off" while this resolve is inside the chain.
          lane = { open: false, generation: 5 };
          return 'ok';
        },
      });
      expect(res).toMatchObject({ ok: false, pressRefusal: 'hq-lane-closed' });
      expect(h.registry.list().pending.map((r) => r.id)).toEqual([id]);
    } finally { broker.cancelAll('test-teardown'); }
  });

  it('refuses an HQ-lane approve checked against an older lane generation, and passes the current one', async () => {
    const broker = new GateBroker();
    const h = makeRegistry({
      hqLane: () => ({ open: true, generation: 5 }),
      notifyGateResolved: (id, decision) => broker.notifyResolved(id, decision),
    });
    h.setScreen(null);
    const id = h.registry.noteGateAwaiting({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'exact', toolName: 'Bash' });
    await settle();
    try {
      expect(await h.registry.resolve({ id, ...laneApprove })).toMatchObject({ ok: false, pressRefusal: 'hq-lane-closed' });
      expect(await h.registry.resolve({ id, ...laneApprove, laneGeneration: 5 })).toMatchObject({ ok: true });
    } finally { broker.cancelAll('test-teardown'); }
  });

  it('an HQ-lane deny does not need the lane open', async () => {
    const broker = new GateBroker();
    const h = makeRegistry({ hqLane: () => null, notifyGateResolved: (id, decision) => broker.notifyResolved(id, decision) });
    h.setScreen(null);
    const id = h.registry.noteGateAwaiting({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', attribution: 'exact', toolName: 'Bash' });
    await settle();
    try {
      expect(await h.registry.resolve({ id, ...laneApprove, decision: 'deny' })).toMatchObject({ ok: true });
    } finally { broker.cancelAll('test-teardown'); }
  });

  // Critical is decided before any workspace fact, so the refusal never names a
  // policy the caller would escalate as a second decision card.
  it('decides critical before every workspace fact', () => {
    expect(
      decideApprovalPress({
        resolver: 'automated', decision: 'approve', risk: 'critical',
        scopeAvailable: true, isTaskWorkspace: true, autonomyMode: 'assist', approvalPress: false,
      }),
    ).toEqual({ press: false, reason: 'critical-risk' });
  });
});
