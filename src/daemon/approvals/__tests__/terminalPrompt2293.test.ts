// Claude Code 2.1.293's Bash permission dialog, captured live on Windows in
// manual mode inside an isolated wmux daemon (fixtures/terminal-prompts/
// claude-2.1.293/). This build draws a tip between the dialog's title and the
// call's description —
//
//    Bash command
//    Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
//    Write key-test into fx-a.txt in the working directory
//
// — and a third option, "Yes, and switch to auto mode". Before #1914 the tip
// row stood in front of the description, so the dialog never bound to its
// call: the record carried no choices and no fingerprint, and the phone got
// `unsupported-shape`. #1915: on a Windows pane the decline's Esc is a
// win32-input-mode key record; a bare ESC byte was measured to leave the
// dialog up.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ApprovalRegistry, TERMINAL_PROMPT_MIN_ANSWER_AGE_MS } from '../ApprovalRegistry';
import {
  TERMINAL_PROMPT_WEB_ANSWER,
  TERMINAL_PROMPT_WEB_DECLINE,
  type ApprovalRequest,
  type ApprovalResolveParams,
} from '../types';
import type { PendingToolUse } from '../../transcript/pendingToolUse';
import {
  decisionForChoiceLabel,
  dialogMatchesToolCall,
  parseTerminalPrompt,
  terminalPromptAnswerability,
  toolFromDialogTitle,
} from '../terminalPromptParse';
import { ESCAPE_WIN32 } from '../../../shared/win32InputKeys';

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts', 'claude-2.1.293');
const load = (name: string): { version: string; cols: number; rows: number; screen: string[] } =>
  JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as { version: string; cols: number; rows: number; screen: string[] };

const WIDE = load('claude-bash-tip-01-initial-2.1.293.json');
const NARROW = load('claude-bash-tip-02-narrow-2.1.293.json');

const DESCRIPTION = (file: string) => `Write key-test into ${file} in the working directory`;
const CALL_A: PendingToolUse = { id: 'toolu_a', name: 'Bash', input: { command: 'echo key-test > fx-a.txt', description: DESCRIPTION('fx-a.txt') } };
const CALL_B: PendingToolUse = { id: 'toolu_b', name: 'Bash', input: { command: 'echo key-test > fx-b.txt', description: DESCRIPTION('fx-b.txt') } };

const parse = (fx: { cols: number; screen: string[] }) => parseTerminalPrompt(fx.screen, { cols: fx.cols });
const call = (c: PendingToolUse) => ({ name: c.name, command: String(c.input['command']), description: String(c.input['description']) });

describe('the 2.1.293 fixtures', () => {
  it.each([
    ['100 columns', WIDE],
    ['80 columns (the tip and option 2 wrap)', NARROW],
  ])('%s is well-formed and sanitized', (_label, fx) => {
    expect(fx.version).toBe('Claude Code 2.1.293');
    expect(fx.screen).toHaveLength(fx.rows);
    for (const row of fx.screen) expect(row.length).toBeLessThanOrEqual(fx.cols);
    expect(fx.screen.join('\n')).not.toMatch(/\\Users\\(?!demo\\)/);
  });
});

describe('a Bash dialog with the auto-mode tip', () => {
  it.each([
    ['100 columns', WIDE, 'fx-a.txt'],
    ['80 columns', NARROW, 'fx-b.txt'],
  ])('%s: parses whole and active, the tip stays out of the command', (_label, fx, file) => {
    const parsed = parse(fx);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      title: 'Bash command',
      commandRows: [`echo key-test > ${file}`],
      question: 'Do you want to proceed?',
      topRuleFound: true,
      active: true,
      cut: false,
    });
    expect(toolFromDialogTitle(parsed!.title)).toBe('Bash');
    expect(parsed!.options.map((o) => o.key)).toEqual(['1', '2', '3', '4']);
    expect(parsed!.options[2]!.label).toBe('Yes, and switch to auto mode · auto mode handles these prompts for you');
  });

  it('binds to its call although the tip sits above the description, wrapped or not', () => {
    expect(dialogMatchesToolCall(parse(WIDE)!, call(CALL_A))).toBe(true);
    expect(dialogMatchesToolCall(parse(NARROW)!, call(CALL_B))).toBe(true);
  });

  it('still refuses another call: a different description or command does not bind', () => {
    expect(dialogMatchesToolCall(parse(WIDE)!, call(CALL_B))).toBe(false);
    expect(dialogMatchesToolCall(parse(WIDE)!, { ...call(CALL_A), description: 'Write key-test into fx-a.txt' })).toBe(false);
    expect(dialogMatchesToolCall(parse(WIDE)!, { ...call(CALL_A), description: 'in the working directory' })).toBe(false);
    expect(dialogMatchesToolCall(parse(WIDE)!, { ...call(CALL_A), command: 'echo key-test > fx-c.txt' })).toBe(false);
  });

  it('only a row that opens with "Tip:" may stand in front of the description', () => {
    const notATip = WIDE.screen.map((row) => row.replace(' Tip: auto mode', ' Note: auto mode'));
    expect(dialogMatchesToolCall(parseTerminalPrompt(notATip, { cols: WIDE.cols })!, call(CALL_A))).toBe(false);
  });

  it('offers the phone the plain Yes and No only: the auto-mode switch stays in the terminal', () => {
    for (const fx of [WIDE, NARROW]) {
      expect(terminalPromptAnswerability(parse(fx)!)).toEqual({
        answerable: true,
        choices: [{ key: '1', label: 'Yes' }, { key: '4', label: 'No' }],
      });
    }
    expect(decisionForChoiceLabel('Yes, and switch to auto mode · auto mode handles these prompts for you')).toBeNull();
    expect(decisionForChoiceLabel('Yes, and switch to auto mode')).toBeNull();
  });
});

// ── The record and the answer, through the registry ─────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-2293-test-')); });
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function makeRegistry(fx: { cols: number; screen: string[] }, pending: PendingToolUse, win32Input?: boolean) {
  const pane = { keyInputRevision: 3, incarnation: 'inc-1', rows: fx.screen as readonly string[], cols: fx.cols, pending };
  const writes: string[] = [];
  const clock = { now: 10_000 };
  let next = 1;
  const registry = new ApprovalRegistry({
    wmuxDir: tmpDir,
    readScreenTail: async () => null,
    writeToSession: (_id, data) => { writes.push(data); return true; },
    ...(win32Input !== undefined ? { win32Input: () => win32Input } : {}),
    readPromptScreen: async () => ({
      rows: pane.rows,
      cols: pane.cols,
      mark: { bytes: 1, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation },
    }),
    promptScreenMark: () => ({ bytes: 1, keyInputRevision: pane.keyInputRevision, incarnation: pane.incarnation }),
    pendingToolUse: () => pane.pending,
    promptReadDelay: async () => undefined,
    now: () => clock.now,
    newId: () => `req-${next++}`,
  });
  return { registry, pane, writes, clock };
}

async function create(h: ReturnType<typeof makeRegistry>): Promise<ApprovalRequest> {
  await h.registry.noteTerminalPrompt({ sessionId: 'pty-a', agent: 'claude', workspaceId: 'ws-1', source: 'detector' });
  const [record] = h.registry.list().pending;
  if (!record) throw new Error('no record');
  h.clock.now += TERMINAL_PROMPT_MIN_ANSWER_AGE_MS;
  return record;
}

const resolve = (h: ReturnType<typeof makeRegistry>, record: ApprovalRequest, over: Partial<ApprovalResolveParams>) =>
  h.registry.resolve({
    id: record.id,
    decision: 'approve',
    promptFingerprint: record.promptFingerprint,
    resolvedBy: 'device Test phone (dev-1)',
    ...over,
  });

describe('2.1.293 records', () => {
  it.each([
    ['100 columns', WIDE, CALL_A],
    ['80 columns', NARROW, CALL_B],
  ])('%s: the dialog becomes an answerable record and the phone presses 1:Yes', async (_label, fx, pending) => {
    const h = makeRegistry(fx, pending, true);
    const record = await create(h);
    expect(record).toMatchObject({
      kind: 'terminal_prompt',
      toolName: 'Bash',
      question: 'Do you want to proceed?',
      choices: [{ key: '1', label: 'Yes' }, { key: '4', label: 'No' }],
      toolUseId: pending.id,
    });
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(await resolve(h, record, { choiceKey: '1', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER })).toMatchObject({ ok: true });
    // A digit is a plain byte on a win32-input-mode pane too.
    expect(h.writes).toEqual(['1']);
  });

  it('the auto-mode option cannot be pressed from the phone', async () => {
    const h = makeRegistry(WIDE, CALL_A, true);
    const record = await create(h);
    expect(await resolve(h, record, { choiceKey: '3', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER }))
      .toMatchObject({ ok: false, reason: 'invalid-choice' });
    expect(h.writes).toEqual([]);
  });

  it('#1915: the decline route writes the win32-input-mode Esc record on a Windows pane', async () => {
    const h = makeRegistry(WIDE, CALL_A, true);
    const record = await create(h);
    expect(await resolve(h, record, { decision: 'deny', terminalPromptDecline: TERMINAL_PROMPT_WEB_DECLINE }))
      .toMatchObject({ ok: true });
    expect(h.writes).toEqual([ESCAPE_WIN32]);
  });

  it('the decline route keeps the bare ESC where the pane is not in win32-input-mode', async () => {
    const h = makeRegistry(WIDE, CALL_A);
    const record = await create(h);
    expect(await resolve(h, record, { decision: 'deny', terminalPromptDecline: TERMINAL_PROMPT_WEB_DECLINE }))
      .toMatchObject({ ok: true });
    expect(h.writes).toEqual(['\x1b']);
  });
});
