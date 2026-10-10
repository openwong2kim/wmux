// A permission dialog for a command longer than the record's 200-character
// summary, a dialog whose top scrolled off a short pane, and declining one
// with a single Esc. The screens below are real Claude Code 2.1.283 renders
// (a `permissions.ask` rule hit), captured from a live pane at three sizes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ApprovalRegistry,
  TERMINAL_PROMPT_MIN_ANSWER_AGE_MS,
  type ApprovalRegistryDeps,
  type PromptScreenMark,
} from '../ApprovalRegistry';
import {
  TERMINAL_PROMPT_WEB_ANSWER,
  TERMINAL_PROMPT_WEB_DECLINE,
  type ApprovalRequest,
  type ApprovalResolveParams,
} from '../types';
import { dialogMatchesToolCall, parseTerminalPrompt } from '../terminalPromptParse';
import type { PendingToolUse } from '../../transcript/pendingToolUse';

const COMMAND =
  'S=/tmp/lcH1/work/scratchpad; mkdir -p $S/dd-main; du -sh $S/dd-main ' +
  '/tmp/lcH1/work/a-very-long-directory-name-that-keeps-going-and-going-past-sixty-columns-of-width-xyz 2>/dev/null; ' +
  'echo cleaning-one; rm -rf $S/dd-main; ls -d /tmp/lcH1/Library/Developer/Xcode/DerivedData 2>/dev/null; echo done-one';

/** 140 columns. The command is drawn with a `│` gutter; option 2 wraps. */
const WIDE = [
  '─'.repeat(140),
  ' Bash command',
  '',
  '   │ S=/tmp/lcH1/work/scratchpad; mkdir -p $S/dd-main; du -sh $S/dd-main',
  '   │ /tmp/lcH1/work/a-very-long-directory-name-that-keeps-going-and-going-past-sixty-columns-of-width-xyz 2>/dev/null; echo cleaning-one;',
  '   │ rm -rf $S/dd-main; ls -d /tmp/lcH1/Library/Developer/Xcode/DerivedData 2>/dev/null; echo done-one',
  '   Run shell command',
  '',
  ' Permission rule Bash(du:*) requires confirmation for this command.',
  ' /permissions to update rules',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and allow /tmp/lcH1/Library/Developer/Xcode access and mkdir -p /tmp/lcH1/work/scratchpad/dd-main and rm -rf',
  '      /tmp/lcH1/work/scratchpad/dd-main commands',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
];

/** 60 columns: the TUI breaks the long path INSIDE a word ("keeps" / "-going"). */
const NARROW = [
  '─'.repeat(60),
  ' Bash command',
  '',
  '   │ S=/tmp/lcH1/work/scratchpad; mkdir -p $S/dd-main; du',
  '   │ -sh $S/dd-main',
  '   │ /tmp/lcH1/work/a-very-long-directory-name-that-keeps',
  '   │ -going-and-going-past-sixty-columns-of-width-xyz',
  '   │ 2>/dev/null; echo cleaning-one; rm -rf $S/dd-main;',
  '   │ ls -d /tmp/lcH1/Library/Developer/Xcode/DerivedData',
  '   │ 2>/dev/null; echo done-one',
  '   Run shell command',
  '',
  ' Permission rule Bash(du:*) requires confirmation for this',
  ' command.',
  ' /permissions to update rules',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and allow /tmp/lcH1/Library/Developer/Xcode',
  '      access and mkdir -p /tmp/lcH1/work/scratchpad/dd-main',
  '      and rm -rf /tmp/lcH1/work/scratchpad/dd-main commands',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
];

/** An 80×16 pane: the dialog's top rule, title and first command rows scrolled off. */
const TOP_CUT = [
  '   │ t-sixty-columns-of-width-xyz 2>/dev/null; echo cleaning-one; rm -rf',
  '   │ $S/dd-main; ls -d /tmp/lcH1/Library/Developer/Xcode/DerivedData',
  '   │ 2>/dev/null; echo done-one',
  '   Run shell command',
  '',
  ' Permission rule Bash(du:*) requires confirmation for this command.',
  ' /permissions to update rules',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and allow /tmp/lcH1/Library/Developer/Xcode access and mkdir -p',
  '      /tmp/lcH1/work/scratchpad/dd-main and rm -rf',
  '      /tmp/lcH1/work/scratchpad/dd-main commands',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
];

/** The pane's own Claude session (its transcript's basename). */
const SESSION = '0e010e5e-4e56-48f4-b980-f7b52beffe85';

const CALL: PendingToolUse = { id: 'toolu_long', name: 'Bash', input: { command: COMMAND }, unanswered: 1 };

let tmpDir: string;

interface Harness {
  registry: ApprovalRegistry;
  pane: PromptScreenMark & { rows: readonly string[] | null; pending: PendingToolUse | null; cols?: number };
  writes: string[];
  logs: string[];
  clock: { now: number };
  afterRender: { fn: (() => void) | null };
}

function makeRegistry(overrides: Partial<ApprovalRegistryDeps> = {}): Harness {
  const h: Harness = {
    registry: null as unknown as ApprovalRegistry,
    pane: { bytes: 100, keyInputRevision: 3, incarnation: 'inc-1', rows: WIDE, pending: CALL, cols: 140 },
    writes: [],
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
      const mark = { bytes: h.pane.bytes, keyInputRevision: h.pane.keyInputRevision, incarnation: h.pane.incarnation };
      const rows = h.pane.rows;
      const cols = h.pane.cols;
      h.afterRender.fn?.();
      return rows ? { rows, mark, ...(cols ? { cols } : {}) } : null;
    },
    promptScreenMark: () => ({ bytes: h.pane.bytes, keyInputRevision: h.pane.keyInputRevision, incarnation: h.pane.incarnation }),
    pendingToolUse: () => h.pane.pending,
    agentSessionId: () => SESSION,
    promptReadDelay: async () => undefined,
    log: (_level, message) => { h.logs.push(message); },
    now: () => h.clock.now,
    newId: () => `req-${next++}`,
    ...overrides,
  });
  return h;
}

async function create(h: Harness, note: Partial<Parameters<ApprovalRegistry['noteTerminalPrompt']>[0]> = {}): Promise<ApprovalRequest> {
  await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', source: 'detector', ...note });
  const [record] = h.registry.list().pending;
  if (!record) throw new Error('no record');
  return record;
}

const settle = (h: Harness) => { h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS; };

function approve(h: Harness, record: ApprovalRequest, over: Partial<ApprovalResolveParams> = {}) {
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

function decline(h: Harness, record: ApprovalRequest, over: Partial<ApprovalResolveParams> = {}) {
  return h.registry.resolve({
    id: record.id,
    decision: 'deny',
    resolvedBy: 'device Test phone (dev-1)',
    terminalPromptDecline: TERMINAL_PROMPT_WEB_DECLINE,
    ...over,
  });
}

const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-terminal-long-test-'));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('a long command, as the TUI draws it', () => {
  it.each([
    ['140 columns', WIDE, 140],
    ['60 columns (a path broken inside a word)', NARROW, 60],
  ])('%s: the gutter rows are the command, the wrapped option is one option, and it binds', (_label, rows, cols) => {
    const parsed = parseTerminalPrompt(rows, { cols })!;
    expect(parsed).toMatchObject({ active: true, topRuleFound: true, cut: false, title: 'Bash command' });
    expect(parsed.descriptionRows).toEqual(['Run shell command']);
    expect(parsed.options.map((o) => o.key)).toEqual(['1', '2', '3']);
    expect(parsed.options[1]!.label).toMatch(/^Yes, and allow .* commands$/);
    // Whitespace is collapsed, never dropped: a space inside the command
    // is part of what the hash covers.
    const spaced = rows.map((r) => r.replace('mkdir -p', 'mkdir - p'));
    expect(parseTerminalPrompt(spaced, { cols })!.fingerprint).not.toBe(parsed.fingerprint);
    expect(dialogMatchesToolCall(parsed, { name: 'Bash', command: COMMAND })).toBe(true);
    // Anything else under the same rows does not bind: a changed tail, a
    // character changed where the TUI broke the word, a different description.
    expect(dialogMatchesToolCall(parsed, { name: 'Bash', command: `${COMMAND}x` })).toBe(false);
    expect(dialogMatchesToolCall(parsed, { name: 'Bash', command: COMMAND.replace('keeps-going', 'keeps_going') })).toBe(false);
    expect(dialogMatchesToolCall(parsed, { name: 'Bash', command: COMMAND.replace('du -sh', 'du  -sh').replace('dd-main;', 'dd-main ;') })).toBe(false);
    expect(dialogMatchesToolCall(parsed, { name: 'Bash', command: COMMAND, description: 'Something else' })).toBe(false);
  });
});

describe('A — a command longer than the 200-character summary', () => {
  it('is answerable; the summary stays capped, the full command is only in /detail', async () => {
    const h = makeRegistry();
    const record = await create(h);
    expect(COMMAND.length).toBeGreaterThan(200);
    expect(record).toMatchObject({
      toolName: 'Bash',
      question: 'Do you want to proceed?',
      choices: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }],
      toolUseId: 'toolu_long',
    });
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(record.summary!.length).toBeLessThanOrEqual(201);
    expect(record.summary!.endsWith('…')).toBe(true);

    expect(h.registry.terminalPromptDetail(record.id)).toEqual({
      id: record.id,
      toolName: 'Bash',
      command: COMMAND,
      commandHash: sha256(COMMAND),
      commandBytes: Buffer.byteLength(COMMAND),
      truncated: false,
    });
    // Never persisted: approvals.json holds the capped summary only.
    const onDisk = fs.readFileSync(path.join(tmpDir, 'approvals.json'), 'utf8');
    expect(onDisk).not.toContain('done-one');
    expect(JSON.stringify(h.registry.list())).not.toContain('done-one');

    settle(h);
    expect(await approve(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
    // Detail lasts while the record is pending, and is gone once it settles.
    await h.registry.expireForSession('pty-a', 'screen-cleared');
    expect(h.registry.terminalPromptDetail(record.id)).toBeNull();
  });

  it('two commands alike for their first 200 characters get the same summary but different fingerprints', async () => {
    const a = makeRegistry();
    const first = await create(a);
    const other = COMMAND.replace('done-one', 'done-TWO');
    const b = makeRegistry();
    b.pane.rows = WIDE.map((r) => r.replace('done-one', 'done-TWO'));
    b.pane.pending = { ...CALL, input: { command: other } };
    const second = await create(b);
    expect(second.summary).toBe(first.summary);
    expect(second.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(second.promptFingerprint).not.toBe(first.promptFingerprint);
  });

  it('approving with the fingerprint of a command that has since changed is refused, nothing typed', async () => {
    const h = makeRegistry();
    const record = await create(h);
    // The agent moved on to a different long command (a new call, a new dialog).
    h.pane.rows = WIDE.map((r) => r.replace('done-one', 'done-TWO'));
    h.pane.pending = { id: 'toolu_next', name: 'Bash', input: { command: COMMAND.replace('done-one', 'done-TWO') }, unanswered: 1 };
    settle(h);
    expect(await approve(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });

  it('the fingerprint covers the call\'s whole input: the same id and screen with a changed input is refused', async () => {
    const h = makeRegistry();
    const record = await create(h);
    // Same tool_use id, same rows on screen, but the input differs past the summary.
    h.pane.pending = { ...CALL, input: { command: COMMAND, timeout: 600_000 } };
    settle(h);
    expect(await approve(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });
});

/**
 * The PermissionRequest hook's note for CALL, as HookIngest builds it from
 * Claude Code 2.1.283's real payload (keys: cwd, hook_event_name,
 * permission_mode, prompt_id, scratchpad_dir, session_id, tool_input,
 * tool_name, transcript_path — no tool_use_id).
 */
const HOOK = {
  source: 'hook' as const,
  toolName: 'Bash',
  toolInput: { command: COMMAND },
  hookSessionId: SESSION,
  promptId: 'd295f9e3-b691-4b17-be6d-de40ce709012',
};

describe('B — the dialog\'s top scrolled off a short pane', () => {
  it('binds to the transcript\'s one pending call when the hook fired for it and its option rows are on screen', async () => {
    const h = makeRegistry();
    h.pane.rows = TOP_CUT;
    h.pane.cols = 80;
    const record = await create(h, HOOK);
    expect(record).toMatchObject({
      toolUseId: 'toolu_long',
      choices: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }],
    });
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    settle(h);
    expect(await approve(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it('the visible option rows are in the fingerprint', async () => {
    const h = makeRegistry();
    h.pane.rows = TOP_CUT;
    const record = await create(h, HOOK);
    h.pane.rows = TOP_CUT.map((r) => r.replace('3. No', '3. No, and tell Claude what to do differently'));
    settle(h);
    expect(await approve(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });

  it.each([
    // A RUNNING tool is an unanswered tool_use too: its output can print a
    // question, options and a footer under the tail of its own command.
    ['a running tool printing a look-alike (no PermissionRequest for it)', {}],
    ['the hook fired for another call', { note: { ...HOOK, toolInput: { command: 'ls' } } }],
    ['two calls pending (parallel tool use)', { note: HOOK, pending: { ...CALL, unanswered: 2 } }],
    ['the pending count unknown (the transcript window was cut)', { note: HOOK, pending: { ...CALL, unanswered: undefined } }],
    ['no transcript call (hook input only)', { note: HOOK, pending: null }],
    ['visible command rows that are not the call\'s tail', { note: HOOK, rows: TOP_CUT.map((r) => r.replace('done-one', 'done-TWO')) }],
    ['no command row on screen at all', { note: HOOK, rows: TOP_CUT.slice(4) }],
    ['the option to press cut off the bottom', { note: HOOK, rows: TOP_CUT.slice(0, -3) }],
  ])('%s → informational, and neither a Yes nor an Esc is ever written', async (_label, over: {
    note?: Partial<Parameters<ApprovalRegistry['noteTerminalPrompt']>[0]>;
    pending?: PendingToolUse | null;
    rows?: string[];
  }) => {
    const h = makeRegistry();
    h.pane.rows = over.rows ?? TOP_CUT;
    if ('pending' in over) h.pane.pending = over.pending ?? null;
    const record = await create(h, over.note ?? {});
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('promptFingerprint');
    expect(h.registry.terminalPromptDetail(record.id)).toBeNull();
    settle(h);
    expect(await approve(h, record, { promptFingerprint: 'a'.repeat(32) })).toMatchObject({ ok: false });
    expect(await decline(h, record)).toMatchObject({ ok: false });
    expect(h.writes).toEqual([]);
  });

  it('the hook\'s evidence ends with the pane\'s sweep', async () => {
    const h = makeRegistry();
    h.pane.rows = TOP_CUT;
    await create(h, HOOK);
    await h.registry.expireForSession('pty-a', 'turn-ended');
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', source: 'detector' });
    const [again] = h.registry.list().pending;
    expect(again).toBeDefined();
    expect(again).not.toHaveProperty('choices');
  });
});

describe('C — decline: one Esc, only for the dialog the phone saw', () => {
  it('writes exactly one Esc and marks the record answered; a second decline writes nothing', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    const out = await decline(h, record, { promptFingerprint: record.promptFingerprint });
    expect(out).toMatchObject({ ok: true, request: { decision: 'deny', state: 'pending' } });
    expect(out.ok && typeof out.request.pressedAt).toBe('number');
    expect(h.writes).toEqual(['\x1b']);
    expect(await decline(h, record)).toMatchObject({ ok: false, reason: 'already-answered' });
    expect(h.writes).toEqual(['\x1b']);
    expect(h.logs.some((l) => /terminal-prompt decline outcome=pressed .*via=escape/.test(l))).toBe(true);
  });

  it('works on a matched record the phone cannot answer Yes/No (a row the TUI cut)', async () => {
    const h = makeRegistry();
    // The reason row ends in an ellipsis: not answerable, still this call's dialog.
    // (A cut command row would not spell the call; a cut option that says it
    // writes a lasting rule no longer blocks the Yes.)
    h.pane.rows = WIDE.map((r) => (r === ' /permissions to update rules' ? `${r}…` : r));
    const record = await create(h);
    expect(record).not.toHaveProperty('promptFingerprint');
    settle(h);
    expect(await decline(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['\x1b']);
  });

  it('within the reflex window: answer-too-soon, nothing written', async () => {
    const h = makeRegistry();
    const record = await create(h);
    expect(await decline(h, record)).toMatchObject({ ok: false, reason: 'answer-too-soon' });
    expect(h.writes).toEqual([]);
  });

  it('after the record settled: 409/410 and nothing written', async () => {
    const h = makeRegistry();
    const record = await create(h);
    await h.registry.expireForSession('pty-a', 'screen-cleared');
    expect(await decline(h, record)).toMatchObject({ ok: false, reason: 'expired' });
    const h2 = makeRegistry();
    const answered = await create(h2);
    settle(h2);
    expect(await approve(h2, answered)).toMatchObject({ ok: true });
    await h2.registry.expireForSession('pty-a', 'screen-cleared');
    expect(await decline(h2, answered)).toMatchObject({ ok: false, reason: 'already-resolved' });
    expect(h.writes).toEqual([]);
    expect(h2.writes).toEqual(['1']);
  });

  it('the dialog closing between the read and the write: nothing written', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    // Right after the screen read the agent moves on: output lands and the
    // dialog is gone by the time the write would happen.
    h.afterRender.fn = () => {
      h.afterRender.fn = null;
      h.pane.bytes += 500;
      h.pane.rows = ['⏺ Done.', '', '❯ '];
    };
    expect(await decline(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });

  it('a key in the pane between the read and the write: nothing written', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    h.afterRender.fn = () => { h.pane.keyInputRevision += 1; };
    expect(await decline(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });

  it('refuses a caller without the route\'s marker, an approve, or a stale fingerprint', async () => {
    const h = makeRegistry();
    const record = await create(h);
    settle(h);
    expect(await decline(h, record, { terminalPromptDecline: undefined, terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER }))
      .toMatchObject({ ok: false, reason: 'invalid-choice' });
    expect(await h.registry.resolve({
      id: record.id, decision: 'deny', resolvedBy: 'pipe', terminalPromptDecline: TERMINAL_PROMPT_WEB_DECLINE, resolver: 'automated',
    })).toMatchObject({ ok: false, reason: 'answer-in-terminal' });
    expect(await decline(h, record, { decision: 'approve' })).toMatchObject({ ok: false, reason: 'invalid-choice' });
    expect(await decline(h, record, { promptFingerprint: 'f'.repeat(32) })).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });
});

/** Call B: the agent's NEXT call, with its own dialog. */
const COMMAND_B = COMMAND.replace('done-one', 'done-bee');
const CALL_B: PendingToolUse = { id: 'toolu_bee', name: 'Bash', input: { command: COMMAND_B }, unanswered: 1 };
const WIDE_B = WIDE.map((r) => r.replace('done-one', 'done-bee'));

describe('unprovable → nothing written, on both write paths', () => {
  type Path = 'approve' | 'decline';
  const press = (h: Harness, record: ApprovalRequest, path: Path) =>
    (path === 'approve'
      ? approve(h, record, { promptFingerprint: record.promptFingerprint ?? 'a'.repeat(32) })
      : decline(h, record));

  const cases: Array<[string, (h: Harness) => Promise<ApprovalRequest>]> = [
    ['a record minted before any dialog was drawn, bound to call A, while call B\'s dialog is up', async (h) => {
      h.pane.rows = null;
      const record = await create(h);
      h.pane.rows = WIDE_B;
      h.pane.pending = CALL_B;
      return record;
    }],
    ['a record for call A while call B (same screen text) is now pending', async (h) => {
      const record = await create(h);
      h.pane.pending = { ...CALL, id: 'toolu_other' };
      return record;
    }],
    ['a record for call A whose input changed under the same id', async (h) => {
      const record = await create(h);
      h.pane.pending = { ...CALL, input: { command: COMMAND, timeout: 1 } };
      return record;
    }],
    ['a key or click since the record was created (answered in the pane)', async (h) => {
      const record = await create(h);
      h.pane.keyInputRevision += 1;
      return record;
    }],
    ['a new PTY since the record was created', async (h) => {
      const record = await create(h);
      h.pane.incarnation = 'inc-2';
      return record;
    }],
    ['a different dialog on screen now', async (h) => {
      const record = await create(h);
      h.pane.rows = WIDE_B;
      return record;
    }],
    ['no dialog on screen now', async (h) => {
      const record = await create(h);
      h.pane.rows = null;
      return record;
    }],
    ['a record with no transcript call at all', async (h) => {
      h.pane.pending = null;
      return create(h);
    }],
    ['a PermissionRequest from another Claude session', async (h) => {
      h.pane.pending = null;
      return create(h, { ...HOOK, hookSessionId: 'another-session' });
    }],
    ['a hook-bound record whose PermissionRequest is joined by a second one', async (h) => {
      h.pane.pending = null;
      const record = await create(h, HOOK);
      await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', ...HOOK, toolInput: { command: 'ls' } });
      return record;
    }],
  ];

  for (const path of ['approve', 'decline'] as const) {
    it.each(cases)(`${path}: %s`, async (_label, arrange) => {
      const h = makeRegistry();
      const record = await arrange(h);
      settle(h);
      const out = await press(h, record, path);
      expect(out.ok).toBe(false);
      expect(h.writes).toEqual([]);
    });
  }
});

describe('D — bound by the PermissionRequest hook when the transcript has no tool_use yet', () => {
  const hookOnly = (): Harness => {
    const h = makeRegistry();
    h.pane.pending = null;
    return h;
  };

  it('the real 2.1.283 hook payload makes the dialog answerable without the transcript', async () => {
    const h = hookOnly();
    const record = await create(h, HOOK);
    expect(record).toMatchObject({ choices: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }] });
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(record).not.toHaveProperty('toolUseId');
    expect(h.registry.terminalPromptDetail(record.id)?.command).toBe(COMMAND);
    settle(h);
    expect(await approve(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it('decline on a hook-bound record writes one Esc', async () => {
    const h = hookOnly();
    const record = await create(h, HOOK);
    settle(h);
    expect(await decline(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['\x1b']);
  });

  it('a detector-first card upgrades when the hook arrives', async () => {
    const h = hookOnly();
    const first = await create(h);
    expect(first).not.toHaveProperty('promptFingerprint');
    await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', ...HOOK });
    for (let i = 0; i < 20 && !h.registry.list().pending[0]?.promptFingerprint; i++) await new Promise((r) => setTimeout(r, 5));
    expect(h.registry.list().pending[0]).toMatchObject({ choices: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }] });
  });

  it('the transcript call, once it is there, still has to be the hook\'s call', async () => {
    const h = hookOnly();
    const record = await create(h, HOOK);
    h.pane.pending = { ...CALL, input: { command: COMMAND_B } };
    settle(h);
    expect(await approve(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
    // …and a transcript call that disagrees with the hook at creation: informational.
    const t = makeRegistry();
    t.pane.pending = { ...CALL, input: { command: COMMAND_B } };
    t.pane.rows = WIDE_B;
    expect(await create(t, HOOK)).not.toHaveProperty('promptFingerprint');
  });

  it.each([
    ['two concurrent PermissionRequests', async (h: Harness) => {
      await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', ...HOOK, toolInput: { command: 'ls' } });
      return create(h, HOOK);
    }],
    ['the hook\'s command is not the one on screen', async (h: Harness) => {
      h.pane.rows = WIDE_B;
      return create(h, HOOK);
    }],
    ['the hook names another tool than the dialog', async (h: Harness) => create(h, { ...HOOK, toolName: 'Write' })],
    ['a key reached the pane after the hook', async (h: Harness) => {
      // The hook lands before the dialog is drawn; a key reaches the pane
      // before anything reads it. Every later look sees the key.
      h.pane.rows = null;
      const record = await create(h, HOOK);
      h.pane.keyInputRevision += 1;
      h.pane.rows = WIDE;
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
      return h.registry.list().pending[0] ?? record;
    }],
    ['a hook from another Claude session', async (h: Harness) => create(h, { ...HOOK, hookSessionId: 'someone-else' })],
  ])('%s → informational, zero bytes', async (_label, arrange) => {
    const h = hookOnly();
    const record = await arrange(h);
    expect(record).not.toHaveProperty('promptFingerprint');
    settle(h);
    expect((await approve(h, record, { promptFingerprint: 'a'.repeat(32) })).ok).toBe(false);
    expect((await decline(h, record)).ok).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it('the next call\'s hook after the previous dialog settled binds again', async () => {
    const h = hookOnly();
    const first = await create(h, HOOK);
    settle(h);
    expect(await approve(h, first)).toMatchObject({ ok: true });
    await h.registry.expireForSession('pty-a', 'screen-cleared');
    h.clock.now += 10_000;
    h.pane.rows = WIDE_B;
    const second = await create(h, { ...HOOK, toolInput: { command: COMMAND_B } });
    expect(second.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
  });
});
