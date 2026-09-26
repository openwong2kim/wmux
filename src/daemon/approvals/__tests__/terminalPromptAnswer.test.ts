// Answering the agent's own terminal dialog from a capable phone: creation from
// a screen parse, and every fence between the POST and the one byte written.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ApprovalRegistry,
  TERMINAL_PROMPT_ANSWER_ATTEMPTS,
  TERMINAL_PROMPT_MIN_ANSWER_AGE_MS,
  type ApprovalRegistryDeps,
  type PromptScreenMark,
} from '../ApprovalRegistry';
import { TERMINAL_PROMPT_WEB_ANSWER, type ApprovalEvent, type ApprovalRequest, type ApprovalResolveParams } from '../types';
import type { PendingToolUse } from '../../transcript/pendingToolUse';
import { buildApprovalPushPayload } from '../../push/approvalPushPayload';
import { ApprovalPushRouter } from '../../push/approvalPushRouter';

// A real Claude Code permission dialog (a `permissions.ask` rule hit in a
// bypassPermissions session), as the bottom of the visible grid. Placeholders
// for paths.
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

let tmpDir: string;

/** The transcript's pending call the DIALOG above is for. */
const CALL: PendingToolUse = {
  id: 'toolu_01',
  name: 'Bash',
  input: { command: 'rm -rf build/cache', description: 'Remove the build cache' },
};

interface Harness {
  registry: ApprovalRegistry;
  pane: PromptScreenMark & { rows: readonly string[] | null; pending: PendingToolUse | null };
  writes: string[];
  renders: number;
  events: ApprovalEvent[];
  logs: string[];
  clock: { now: number };
  /** Runs after each screen read, i.e. between the render and the write. */
  afterRender: { fn: (() => void) | null };
}

function makeRegistry(overrides: Partial<ApprovalRegistryDeps> = {}): Harness {
  const h: Harness = {
    registry: null as unknown as ApprovalRegistry,
    pane: { bytes: 100, keyInputRevision: 3, incarnation: 'inc-1', rows: DIALOG, pending: CALL },
    writes: [],
    renders: 0,
    events: [],
    logs: [],
    clock: { now: 10_000 },
    afterRender: { fn: null },
  };
  let next = 1;
  h.registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => null,
    writeToSession: (_id, data) => {
      h.writes.push(data);
      return true;
    },
    readPromptScreen: async () => {
      h.renders += 1;
      const mark = { bytes: h.pane.bytes, keyInputRevision: h.pane.keyInputRevision, incarnation: h.pane.incarnation };
      const rows = h.pane.rows;
      h.afterRender.fn?.();
      return rows ? { rows, mark } : null;
    },
    promptScreenMark: () => ({ bytes: h.pane.bytes, keyInputRevision: h.pane.keyInputRevision, incarnation: h.pane.incarnation }),
    pendingToolUse: () => h.pane.pending,
    promptReadDelay: async () => undefined,
    log: (_level, message) => { h.logs.push(message); },
    now: () => h.clock.now,
    newId: () => `req-${next++}`,
    ...overrides,
  });
  h.registry.onEvent((e) => h.events.push(e));
  return h;
}

async function create(h: Harness): Promise<ApprovalRequest> {
  await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', source: 'detector' });
  const [record] = h.registry.list().pending;
  if (!record) throw new Error('no record');
  h.renders = 0;
  return record;
}

function answer(h: Harness, record: ApprovalRequest, over: Partial<ApprovalResolveParams> = {}) {
  return h.registry.resolve({
    id: record.id,
    decision: 'approve',
    choiceKey: '1',
    promptFingerprint: record.promptFingerprint,
    resolvedBy: 'device Test phone (dev-1)',
    terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER,
    ...over,
  });
}

const settle = (h: Harness) => { h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS; };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-terminal-answer-test-'));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('terminal_prompt creation from the screen', () => {
  it('parses a whole dialog into an answerable record with only Yes/No as choices', async () => {
    const h = makeRegistry();
    const record = await create(h);
    expect(record).toMatchObject({
      kind: 'terminal_prompt',
      toolName: 'Bash',
      summary: 'rm -rf build/cache',
      risk: 'critical',
      question: 'Do you want to proceed?',
      reason: 'Permission rule Bash(rm -rf *) requires confirmation for this command.',
      choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }],
    });
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(record).not.toHaveProperty('screenTail');
    expect(record).not.toHaveProperty('options');
  });

  it('a "don\'t ask again" option is never a choice', async () => {
    const h = makeRegistry();
    h.pane.rows = [
      ...DIALOG.slice(0, 11),
      ' ❯ 1. Yes',
      "   2. Yes, and don't ask again for rm commands in this project",
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
    ];
    const record = await create(h);
    expect(record.choices).toEqual([{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }]);
    settle(h);
    expect(await answer(h, record, { choiceKey: '2' })).toMatchObject({ ok: false, reason: 'invalid-choice' });
    expect(h.writes).toEqual([]);
  });

  it.each([
    ['taller than the viewport (no top rule)', DIALOG.slice(3)],
    ['printed by cat (a shell prompt below it)', [...DIALOG, '$ cat dialog.txt', '$ ']],
    ['no plain Yes', DIALOG.map((r) => r.replace('❯ 1. Yes', '❯ 1. Yes, allow once'))],
    ['nothing on screen', null],
  ])('%s → the informational record, never answerable', async (_label, rows) => {
    const h = makeRegistry();
    h.pane.rows = rows;
    const record = await create(h);
    expect(record).not.toHaveProperty('question');
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('promptFingerprint');
    settle(h);
    expect(await answer(h, record, { promptFingerprint: 'f'.repeat(32) })).toMatchObject({ ok: false, reason: 'answer-in-terminal' });
    expect(h.writes).toEqual([]);
  });

  it('a hook that lands before the dialog is drawn is upgraded once the dialog appears — one push', async () => {
    const gaps: Array<() => void> = [];
    let immediate = 2; // the creation reads' own gaps
    const h = makeRegistry({
      promptReadDelay: (ms) => (immediate-- > 0 ? Promise.resolve() : new Promise<void>((r) => { gaps.push(r); void ms; })),
    });
    h.pane.rows = ['', '  ⎿  Running PermissionRequest hook…', ''];
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', toolName: 'Bash', summary: 'rm -rf build/cache', source: 'hook' });
    const [first] = h.registry.list().pending;
    expect(first).not.toHaveProperty('promptFingerprint');
    h.pane.rows = DIALOG;
    await new Promise((r) => setTimeout(r, 0));
    gaps.shift()?.();
    await vi.waitFor(() => expect(h.events.filter((e) => e.type === 'create')).toHaveLength(2));
    const [upgraded] = h.registry.list().pending;
    expect(upgraded?.id).not.toBe(first!.id);
    expect(upgraded).toMatchObject({ toolName: 'Bash', choices: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] });
    expect(upgraded?.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    const creates = h.events.filter((e) => e.type === 'create');
    expect(creates.map((e) => e.replaces)).toEqual([undefined, first!.id]);
    // What the push subscriber sends: creates that replace nothing.
    expect(creates.filter((e) => !e.replaces)).toHaveLength(1);
  });

  it('no record when the pane was answered while the screen was being read', async () => {
    const h = makeRegistry({
      readPromptScreen: async () => {
        await h.registry.expireForSession('pty-a', 'answered-locally', 'terminal_prompt');
        return { rows: DIALOG, mark: { bytes: 1, keyInputRevision: 1, incarnation: 'i' } };
      },
    });
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', source: 'detector' });
    expect(h.registry.list().pending).toEqual([]);
  });
});

describe('terminal_prompt answer', () => {
  it('writes exactly one byte, the digit, and stays pending (pressed) until the dialog is gone', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    const result = await answer(h, record);
    expect(result).toMatchObject({ ok: true, request: { state: 'pending', selectedChoiceKey: '1', decision: 'approve' } });
    expect(h.writes).toEqual(['1']);
    expect(h.events.at(-1)?.type).toBe('press');
    // The answered path fires (the digit reached the bridge): it resolves.
    await h.registry.expireForSession('pty-a', 'answered-locally', 'terminal_prompt');
    expect(h.registry.list().recentlyResolved).toMatchObject([{ id: record.id, state: 'resolved' }]);
  });

  it('a deny names the plain No', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    expect(await answer(h, record, { decision: 'deny', choiceKey: '2' })).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['2']);
  });

  it('one write per record: a second answer is already-answered and writes nothing', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    await answer(h, record);
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'already-answered' });
    expect(await answer(h, record, { decision: 'deny', choiceKey: '2' })).toMatchObject({ ok: false, reason: 'already-answered' });
    expect(h.writes).toEqual(['1']);
  });

  it.each([
    ['an automated resolver', { resolver: 'automated' as const }, 'answer-in-terminal'],
    ['no web capability marker', { terminalPromptAnswer: undefined }, 'answer-in-terminal'],
    ['no choiceKey', { choiceKey: undefined }, 'invalid-choice'],
    ['a choiceKey not among the choices', { choiceKey: '7' }, 'invalid-choice'],
    ['a decision that disagrees with the option', { decision: 'deny' as const, choiceKey: '1' }, 'invalid-choice'],
    ['no fingerprint', { promptFingerprint: undefined }, 'invalid-choice'],
    ['a stale fingerprint', { promptFingerprint: '0'.repeat(32) }, 'prompt-changed'],
  ])('refuses %s in the registry, writing nothing', async (_label, over, reason) => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    expect(await answer(h, record, over)).toMatchObject({ ok: false, reason });
    expect(h.writes).toEqual([]);
    expect(h.registry.list().pending).toHaveLength(1);
  });

  it('refuses an answer within 1.5 s of the record appearing', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS - 1;
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'answer-too-soon' });
    h.clock.now += 1;
    expect(await answer(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it('output between the render and the write is read again, capped: a redrawing dialog is refused', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    // The pane draws after every read, as a dialog redrawing behind would.
    h.afterRender.fn = () => { h.pane.bytes += 1; };
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
    expect(h.renders).toBe(TERMINAL_PROMPT_ANSWER_ATTEMPTS);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([record.id]);
  });

  it('a new PTY between the render and the write → prompt-changed at once, no second read', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    h.afterRender.fn = () => { h.pane.incarnation = `${h.pane.incarnation}+`; };
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
    expect(h.renders).toBe(1);
  });

  it('a key or click between the render and the write → prompt-changed, nothing written, record refreshed', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    let once = true;
    h.afterRender.fn = () => { if (once) { once = false; h.pane.keyInputRevision += 1; } };
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
    // One read for the answer, one fresh read for the refreshed record.
    expect(h.renders).toBe(2);
    const [fresh] = h.registry.list().pending;
    expect(fresh?.id).not.toBe(record.id);
    expect(fresh?.keyRevisionAtCreate).toBe(4);
  });

  it('a key or click since the record appeared → prompt-changed, nothing written', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    h.pane.keyInputRevision += 1;
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });

  it('one movement is absorbed by a re-read; the second read is clean and the key goes in', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    let once = true;
    h.afterRender.fn = () => { if (once) { once = false; h.pane.bytes += 5; } };
    expect(await answer(h, record)).toMatchObject({ ok: true });
    expect(h.renders).toBe(2);
    expect(h.writes).toEqual(['1']);
  });

  it('a dialog no longer active (something printed below it) → prompt-changed, nothing written', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    h.pane.rows = [...DIALOG, '$ '];
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([record.id]);
  });

  it('a changed dialog supersedes the record with a fresh parse, without a second push', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    h.pane.rows = DIALOG.map((r) => r.replace('build/cache', 'build/other'));
    h.pane.pending = { ...CALL, id: 'toolu_02', input: { ...CALL.input, command: 'rm -rf build/other' } };
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
    const [fresh] = h.registry.list().pending;
    expect(fresh?.id).not.toBe(record.id);
    expect(fresh?.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh?.promptFingerprint).not.toBe(record.promptFingerprint);
    expect(h.events.slice(-2).map((e) => [e.type, e.replaces])).toEqual([['supersede', undefined], ['create', record.id]]);
    // The fresh record starts its own reflex guard, then answers.
    expect(await answer(h, fresh!)).toMatchObject({ ok: false, reason: 'answer-too-soon' });
    settle(h);
    expect(await answer(h, fresh!)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it('audits every remote answer without the command text', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    await answer(h, record, { decision: 'deny', choiceKey: '1' });
    await answer(h, record);
    const audit = h.logs.filter((l) => l.includes('terminal-prompt answer'));
    expect(audit).toHaveLength(2);
    expect(audit[1]).toContain('outcome=pressed');
    expect(audit[1]).toContain(`record=${record.id}`);
    expect(audit[1]).toContain('session=pty-a');
    expect(audit[1]).toContain('device Test phone (dev-1)');
    expect(audit[1]).toContain('choice=1:Yes');
    expect(audit[1]).toContain(`fp=${record.promptFingerprint!.slice(0, 8)}`);
    expect(audit[1]).toContain('tool=Bash');
    for (const line of audit) {
      expect(line).not.toContain('build/cache');
      expect(line).not.toContain('Remove the build cache');
      expect(line).not.toContain('Permission rule');
      expect(line).not.toContain('reason=');
    }
  });

  it('a daemon restart turns a pressed record into a resolved one, keeping its fields', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    await answer(h, record);
    const reloaded = makeRegistry();
    expect(reloaded.registry.list().recentlyResolved).toMatchObject([
      { id: record.id, kind: 'terminal_prompt', state: 'resolved', promptFingerprint: record.promptFingerprint },
    ]);
  });

  it('push: never a lock-screen button; rm -rf reads critical', async () => {
    const h = makeRegistry();
    const record = await create(h);
    const payload = buildApprovalPushPayload(record);
    expect(payload).toMatchObject({ requiresInAppChoice: true, risk: 'critical' });
    expect(payload).not.toHaveProperty('firstOption');
    expect(payload.body).toBe('Permission needed: Bash — rm -rf build/cache');
    // The reason alone is enough to read the rule as dangerous.
    expect(buildApprovalPushPayload({ ...record, summary: undefined, toolName: undefined }).risk).toBe('critical');
    expect(buildApprovalPushPayload({ ...record, summary: 'sudo ls', reason: undefined }).risk).toBe('critical');
  });
});

describe('terminal_prompt binding to the pane\'s own tool call', () => {
  const HEREDOC_CALL: PendingToolUse = {
    id: 'toolu_hd',
    name: 'Bash',
    input: { command: "cat <<'EOF'\n--------------------------------------------------------\nEOF\nrm -rf ~/work" },
  };
  const heredocDialog = (dashAtColumnZero: boolean): string[] => [
    '● Bash(cat <<EOF …)',
    '',
    '────────────────────────────────────────────────────────────',
    ' Bash command',
    '',
    "   cat <<'EOF'",
    dashAtColumnZero ? '────────────────────────────────────────────────────────────' : '   --------------------------------------------------------',
    '   EOF',
    '   rm -rf ~/work',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend',
  ];

  it('a dash row inside the command is body, not the frame: the whole command binds', async () => {
    const h = makeRegistry();
    h.pane.pending = HEREDOC_CALL;
    h.pane.rows = heredocDialog(false);
    const record = await create(h);
    expect(record.summary).toContain('rm -rf ~/work');
    expect(record.choices).toBeDefined();
  });

  it('a row that hides part of the command (read as the frame) is not answerable', async () => {
    const h = makeRegistry();
    h.pane.pending = HEREDOC_CALL;
    h.pane.rows = heredocDialog(true);
    const record = await create(h);
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('promptFingerprint');
    // The summary still comes from the call itself, whole.
    expect(record.summary).toContain('rm -rf ~/work');
  });

  it('a dialog printed into the pane with no pending tool call is not answerable', async () => {
    const h = makeRegistry();
    h.pane.pending = null;
    const record = await create(h);
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('promptFingerprint');
  });

  it('a pending call whose command differs from the dialog is not answerable', async () => {
    const h = makeRegistry();
    h.pane.pending = { ...CALL, input: { command: 'rm -rf build/other', description: 'Remove the build cache' } };
    expect(await create(h)).not.toHaveProperty('choices');
    const t = makeRegistry();
    t.pane.pending = { ...CALL, name: 'Write' };
    expect(await create(t)).not.toHaveProperty('choices');
  });

  it('the hook payload binds when the transcript has nothing', async () => {
    const h = makeRegistry();
    h.pane.pending = null;
    await h.registry.noteTerminalPrompt({
      sessionId: 'pty-a', agent: 'claude', toolName: 'Bash', source: 'hook', toolInput: CALL.input,
    });
    expect(h.registry.list().pending[0]?.choices).toEqual([{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]);
  });

  it('the same dialog for two different calls has two fingerprints; the stale answer is refused', async () => {
    const h = makeRegistry();
    const first = await create(h);
    settle(h);
    // The first call ran; the agent asks for an identical second one.
    h.pane.pending = { ...CALL, id: 'toolu_02' };
    expect(await answer(h, first)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
    const [second] = h.registry.list().pending;
    expect(second?.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(second?.promptFingerprint).not.toBe(first.promptFingerprint);
  });

  it('"No, …" is the deny choice; "don\'t ask again" / "always" never are', async () => {
    const h = makeRegistry();
    h.pane.rows = [
      ...DIALOG.slice(0, 11),
      ' ❯ 1. Yes',
      "   2. Yes, and don't ask again for rm commands in this project",
      '   3. No, and tell Claude what to do differently (esc)',
      '',
      ' Esc to cancel · Tab to amend',
    ];
    const record = await create(h);
    expect(record.choices).toEqual([
      { key: '1', label: 'Yes' },
      { key: '3', label: 'No, and tell Claude what to do differently (esc)' },
    ]);
    settle(h);
    expect(await answer(h, record, { decision: 'deny', choiceKey: '3' })).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['3']);

    const a = makeRegistry();
    a.pane.rows = DIALOG.map((r) => r.replace('2. No', '2. No, always deny rm'));
    expect((await create(a)).choices).toEqual([{ key: '1', label: 'Yes' }]);
  });
});

describe('terminal_prompt creation races and cooldown', () => {
  it('a pane that dies while its screen is read gets no record, and stays swept', async () => {
    let alive = true;
    const h = makeRegistry({
      readPromptScreen: async () => {
        alive = false;
        await h.registry.expireForSession('pty-a', 'pane-gone');
        return { rows: DIALOG, mark: { bytes: 1, keyInputRevision: 3, incarnation: 'inc-1' } };
      },
      promptScreenMark: () => (alive ? { bytes: 1, keyInputRevision: 3, incarnation: 'inc-1' } : null),
    });
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', source: 'detector' });
    expect(h.registry.list().pending).toEqual([]);
  });

  it('the pane-gone sweep alone (pane still readable) also drops a straddling creation', async () => {
    const h = makeRegistry({
      readPromptScreen: async () => {
        await h.registry.expireForSession('pty-a', 'pane-gone');
        return { rows: DIALOG, mark: { bytes: 1, keyInputRevision: 3, incarnation: 'inc-1' } };
      },
    });
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', source: 'detector' });
    expect(h.registry.list().pending).toEqual([]);
  });

  it('the cooldown holds back the SAME dialog only; another dialog and the hook path get records', async () => {
    const h = makeRegistry();
    const first = await create(h);
    await h.registry.expireForSession('pty-a', 'screen-cleared', 'terminal_prompt');
    // Same dialog, same call, from the detector: held back.
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', source: 'detector' });
    expect(h.registry.list().pending).toEqual([]);
    // The hook path is exempt.
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', toolName: 'Bash', source: 'hook' });
    expect(h.registry.list().pending).toHaveLength(1);
    await h.registry.expireForSession('pty-a', 'answered-locally', 'terminal_prompt');
    // A different call inside the window: a record.
    h.pane.pending = { ...CALL, id: 'toolu_03' };
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', source: 'detector' });
    const [third] = h.registry.list().pending;
    expect(third?.id).not.toBe(first.id);
    expect(third?.promptFingerprint).not.toBe(first.promptFingerprint);
  });

  it('never rejects: failing reads and a failing mutation are logged, not thrown', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = makeRegistry({
        readPromptScreen: async () => { throw new Error('render exploded'); },
        pendingToolUse: () => { throw new Error('transcript exploded'); },
        promptScreenMark: () => { throw new Error('pane exploded'); },
      });
      await expect(h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', source: 'detector' }))
        .resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
      expect(h.logs.some((l) => l.includes('terminal prompt record failed'))).toBe(true);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('a key or click in the pane refreshes the record instead of wedging it', () => {
  /** A registry whose refresh timer is driven by hand. */
  function withTimers() {
    const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
    const h = makeRegistry({
      schedule: (fn, ms) => {
        const t = { fn, at: h.clock.now + ms, live: true };
        timers.push(t);
        return () => { t.live = false; };
      },
    });
    /** Advance the clock, firing due timers in order. */
    const advance = async (ms: number) => {
      const end = h.clock.now + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        h.clock.now = Math.max(h.clock.now, due.at);
        due.fn();
        // Let the refresh's screen read and its persisted mutation land.
        await new Promise((r) => setTimeout(r, 25));
      }
      h.clock.now = end;
    };
    return { h, advance };
  }
  const key = (h: Harness) => {
    h.pane.keyInputRevision += 1;
    h.registry.noteFenceInput('pty-a');
  };
  const supersedes = (h: Harness) => h.events.filter((e) => e.type === 'supersede').length;

  it('↓ then a phone answer: 409, a fresh record, and the fresh one answers with exactly one digit', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    h.pane.keyInputRevision += 1; // ↓ in the pane
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
    const [fresh] = h.registry.list().pending;
    expect(fresh?.id).not.toBe(record.id);
    expect(fresh?.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh?.promptFingerprint).not.toBe(record.promptFingerprint);
    expect(h.events.slice(-2).map((e) => [e.type, e.replaces])).toEqual([['supersede', undefined], ['create', record.id]]);
    // The phone re-reads, re-confirms after the guard, and the key goes in.
    expect(await answer(h, fresh!)).toMatchObject({ ok: false, reason: 'answer-too-soon' });
    settle(h);
    expect(await answer(h, fresh!)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it('↓ then ↑ is refreshed before anyone taps, and the fresh record is answerable', async () => {
    const { h, advance } = withTimers();
    const record = await create(h);
    key(h); // ↓
    key(h); // ↑
    await advance(3_000);
    const [fresh] = h.registry.list().pending;
    expect(fresh?.id).not.toBe(record.id);
    expect(fresh?.choices).toEqual([{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]);
    expect(fresh?.keyRevisionAtCreate).toBe(5);
    expect(supersedes(h)).toBe(1);
    settle(h);
    expect(await answer(h, fresh!)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it('key auto-repeat produces a bounded number of refreshes', async () => {
    const { h, advance } = withTimers();
    await create(h);
    // Ten seconds of auto-repeat at 30 ms, then quiet.
    for (let t = 0; t < 10_000; t += 30) {
      key(h);
      await advance(30);
    }
    await advance(5_000);
    expect(supersedes(h)).toBeGreaterThanOrEqual(1);
    expect(supersedes(h)).toBeLessThanOrEqual(Math.ceil(15_000 / 2_000));
  });

  it('input that dismisses the dialog refreshes nothing into an answerable record', async () => {
    const { h, advance } = withTimers();
    const record = await create(h);
    h.pane.rows = ['● Bash(rm -rf build/cache)', '  ⎿  Interrupted by user', '', '> ', '  ⏵⏵ bypass permissions on'];
    key(h); // ESC
    await advance(5_000);
    expect(supersedes(h)).toBe(0);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([record.id]);
    // …and a phone answer to it is refused without a write or a new record.
    settle(h);
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([record.id]);
  });

  it('a dialog still up but no longer bound refreshes into an informational record only', async () => {
    const { h, advance } = withTimers();
    await create(h);
    h.pane.pending = null;
    key(h);
    await advance(3_000);
    const [fresh] = h.registry.list().pending;
    expect(fresh).not.toHaveProperty('choices');
    expect(fresh).not.toHaveProperty('promptFingerprint');
  });

  it('a refresh sends no second push', async () => {
    const { h, advance } = withTimers();
    const sent: string[] = [];
    const router = new ApprovalPushRouter({
      build: (r) => ({ title: 't', body: r.id, approvalId: r.id }),
      collapseId: (r) => `ap-${r.sessionId}`,
      suppress: () => false,
      send: (payload) => { sent.push(payload.approvalId as string); },
      park: () => undefined,
      forget: () => undefined,
      isParked: () => false,
    });
    h.registry.onEvent((e) => router.onEvent(e));
    await create(h);
    key(h);
    await advance(3_000);
    key(h);
    await advance(3_000);
    expect(supersedes(h)).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it('input on a pane with no answerable record schedules nothing', () => {
    const scheduled: number[] = [];
    const h = makeRegistry({ schedule: (_fn, ms) => { scheduled.push(ms); return () => undefined; } });
    h.registry.noteFenceInput('pty-a');
    expect(scheduled).toEqual([]);
  });
});
