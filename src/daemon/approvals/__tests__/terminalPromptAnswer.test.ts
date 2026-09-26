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
import { buildApprovalPushPayload } from '../../push/approvalPushPayload';

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

interface Harness {
  registry: ApprovalRegistry;
  pane: PromptScreenMark & { rows: readonly string[] | null };
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
    pane: { bytes: 100, keyInputRevision: 3, incarnation: 'inc-1', rows: DIALOG },
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
  await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', toolName: 'Bash' });
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
      summary: 'rm -rf build/cache · Remove the build cache',
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
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', toolName: 'Bash', summary: 'rm -rf build/cache' });
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
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude' });
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

  it.each([
    ['output', (h: Harness) => { h.pane.bytes += 1; }],
    ['key input', (h: Harness) => { h.pane.keyInputRevision += 1; }],
    ['a new PTY incarnation', (h: Harness) => { h.pane.incarnation = `${h.pane.incarnation}+`; }],
  ])('%s between the render and the write → prompt-changed, nothing written, retry cap holds', async (_label, bump) => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    // The pane moves after every read, as a dialog redrawing behind would.
    h.afterRender.fn = () => bump(h);
    expect(await answer(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
    expect(h.renders).toBe(TERMINAL_PROMPT_ANSWER_ATTEMPTS);
    expect(h.registry.list().pending.map((r) => r.id)).toEqual([record.id]);
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
    expect(audit[1]).toContain('Permission rule Bash(rm -rf *) requires confirmation');
    for (const line of audit) {
      expect(line).not.toContain('build/cache');
      expect(line).not.toContain('Remove the build cache');
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
    expect(payload.body).toBe('Permission needed: Bash — rm -rf build/cache · Remove the build cache');
    // The reason alone is enough to read the rule as dangerous.
    expect(buildApprovalPushPayload({ ...record, summary: undefined, toolName: undefined }).risk).toBe('critical');
    expect(buildApprovalPushPayload({ ...record, summary: 'sudo ls', reason: undefined }).risk).toBe('critical');
  });
});
