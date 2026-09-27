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

describe('B — the dialog\'s top scrolled off a short pane', () => {
  it('binds to the transcript\'s one pending call when its option rows are on screen', async () => {
    const h = makeRegistry();
    h.pane.rows = TOP_CUT;
    h.pane.cols = 80;
    const record = await create(h);
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
    const record = await create(h);
    h.pane.rows = TOP_CUT.map((r) => r.replace('3. No', '3. No, and tell Claude what to do differently'));
    settle(h);
    expect(await approve(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });

  it.each([
    ['two calls pending (parallel tool use)', { pending: { ...CALL, unanswered: 2 } }],
    ['no transcript call (hook input only)', { pending: null }],
    ['visible command rows that are not the call\'s tail', { rows: TOP_CUT.map((r) => r.replace('done-one', 'done-TWO')) }],
    ['no command row on screen at all', { rows: TOP_CUT.slice(4) }],
    ['the option to press cut off the bottom', { rows: TOP_CUT.slice(0, -3) }],
  ])('%s → informational', async (_label, over: { pending?: PendingToolUse | null; rows?: string[] }) => {
    const h = makeRegistry();
    h.pane.rows = over.rows ?? TOP_CUT;
    if ('pending' in over) h.pane.pending = over.pending ?? null;
    const record = await create(h, over.pending === null ? { source: 'hook', toolName: 'Bash', toolInput: { command: COMMAND } } : {});
    expect(record).not.toHaveProperty('choices');
    expect(record).not.toHaveProperty('promptFingerprint');
    expect(h.registry.terminalPromptDetail(record.id)).toBeNull();
  });
});

describe('C — decline: one Esc, only while pending and on screen', () => {
  it('writes exactly one Esc and marks the record answered; a second decline writes nothing', async () => {
    const h = makeRegistry();
    const record = await create(h);
    const out = await decline(h, record, { promptFingerprint: record.promptFingerprint });
    expect(out).toMatchObject({ ok: true, request: { decision: 'deny', state: 'pending' } });
    expect(out.ok && typeof out.request.pressedAt).toBe('number');
    expect(h.writes).toEqual(['\x1b']);
    expect(await decline(h, record)).toMatchObject({ ok: false, reason: 'already-answered' });
    expect(h.writes).toEqual(['\x1b']);
    expect(h.logs.some((l) => /terminal-prompt decline outcome=pressed .*via=escape/.test(l))).toBe(true);
  });

  it('is allowed on an informational record (declining is the safe direction)', async () => {
    const h = makeRegistry();
    h.pane.pending = null;
    const record = await create(h);
    expect(record).not.toHaveProperty('promptFingerprint');
    expect(await decline(h, record)).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['\x1b']);
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
    h.afterRender.fn = () => { h.pane.keyInputRevision += 1; };
    expect(await decline(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });

  it('a different dialog on screen, or no dialog: nothing written', async () => {
    const h = makeRegistry();
    const record = await create(h);
    h.pane.rows = WIDE.map((r) => r.replace('done-one', 'done-TWO'));
    expect(await decline(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    h.pane.rows = null;
    expect(await decline(h, record)).toMatchObject({ ok: false, reason: 'prompt-changed' });
    expect(h.writes).toEqual([]);
  });

  it('refuses a caller without the route\'s marker, an approve, or a stale fingerprint', async () => {
    const h = makeRegistry();
    const record = await create(h);
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
