// #1936: Claude Code's PowerShell-tool permission dialog, captured live on
// Windows (Claude Code 2.1.294, manual mode, isolated wmux daemon;
// fixtures/terminal-prompts/claude-2.1.294/). On Windows Claude often runs
// shell commands through its PowerShell tool instead of Bash. The dialog is
// drawn like a Bash one —
//
//    PowerShell command
//    Write key-test to fx-a.txt
//   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//    Set-Content -Path fx-a.txt -Value key-test
//   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//    Do you want to proceed?
//
// — and the call's input has Bash's shape, `{ command, description }`. The
// parser always read the dialog; the record still had no choices and no
// fingerprint, because `commandOfToolInput` read `command` only for a call
// named Bash. With no command there was no call to bind, and the phone got
// `unsupported-shape`.
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

const DIR = path.join(__dirname, 'fixtures', 'terminal-prompts', 'claude-2.1.294');
type Fixture = { version: string; cols: number; rows: number; screen: string[] };
const load = (name: string): Fixture => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as Fixture;

const WIDE = load('claude-powershell-01-initial-2.1.294.json');
const NARROW = load('claude-powershell-02-narrow-2.1.294.json');
const GUTTER = load('claude-powershell-03-gutter-reason-2.1.294.json');
const WRITE = load('claude-write-create-01-2.1.294.json');

// The calls exactly as the session's transcript recorded them.
const CALL_A: PendingToolUse = {
  id: 'toolu_a',
  name: 'PowerShell',
  input: { command: 'Set-Content -Path fx-a.txt -Value key-test', description: 'Write key-test to fx-a.txt' },
};
const CALL_B: PendingToolUse = {
  id: 'toolu_b',
  name: 'PowerShell',
  input: {
    command: 'Set-Content -Path fx-b-narrow-pane-check.txt -Value key-test-narrow',
    description: 'Write key-test-narrow to fx-b-narrow-pane-check.txt',
  },
};
const CALL_C: PendingToolUse = {
  id: 'toolu_c',
  name: 'PowerShell',
  input: {
    command: 'Get-ChildItem -Path . -Filter *.txt | Where-Object { $_.Length -gt 0 } | Select-Object -Property Name, Length, LastWriteTime | Format-Table -AutoSize',
    description: 'List non-empty .txt files in current directory',
  },
};

const parse = (fx: { cols: number; screen: string[] }) => parseTerminalPrompt(fx.screen, { cols: fx.cols });
const call = (c: PendingToolUse) => ({ name: c.name, command: String(c.input['command']), description: String(c.input['description']) });

describe('the 2.1.294 fixtures', () => {
  it.each([
    ['PowerShell, 100 columns', WIDE],
    ['PowerShell, 80 columns', NARROW],
    ['PowerShell, gutter and reason, 80 columns', GUTTER],
    ['Write, 80 columns', WRITE],
  ])('%s is well-formed and sanitized', (_label, fx) => {
    expect(fx.version).toBe('Claude Code 2.1.294');
    expect(fx.screen).toHaveLength(fx.rows);
    for (const row of fx.screen) expect(row.length).toBeLessThanOrEqual(fx.cols);
    expect(fx.screen.join('\n')).not.toMatch(/\\Users\\(?!demo\\)/);
  });
});

describe('a PowerShell-tool dialog', () => {
  it.each([
    ['100 columns', WIDE, CALL_A, ['1', '2', '3']],
    ['80 columns (option 2 wraps)', NARROW, CALL_B, ['1', '2', '3']],
    ['80 columns, gutter-drawn command', GUTTER, CALL_C, ['1', '2']],
  ])('%s: parses whole and active, titled by the PowerShell tool', (_label, fx, pending, keys) => {
    const parsed = parse(fx);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      title: 'PowerShell command',
      question: 'Do you want to proceed?',
      topRuleFound: true,
      active: true,
      cut: false,
    });
    expect(toolFromDialogTitle(parsed!.title)).toBe('PowerShell');
    expect(parsed!.commandFull).toBe(pending.input['command']);
    expect(parsed!.options.map((o) => o.key)).toEqual(keys);
  });

  it('the gutter-drawn dialog keeps its reason row out of the command', () => {
    const parsed = parse(GUTTER)!;
    expect(parsed.commandRows).toEqual([
      'Get-ChildItem -Path . -Filter *.txt | Where-Object { $_.Length -gt 0 } |',
      'Select-Object -Property Name, Length, LastWriteTime | Format-Table -AutoSize',
    ]);
    expect(parsed.reason).toBe('Command contains script block that may execute arbitrary code');
  });

  it('binds to its own call by exact command and description', () => {
    expect(dialogMatchesToolCall(parse(WIDE)!, call(CALL_A))).toBe(true);
    expect(dialogMatchesToolCall(parse(NARROW)!, call(CALL_B))).toBe(true);
    expect(dialogMatchesToolCall(parse(GUTTER)!, call(CALL_C))).toBe(true);
  });

  it('refuses another call: a different command, description or tool does not bind', () => {
    expect(dialogMatchesToolCall(parse(WIDE)!, call(CALL_B))).toBe(false);
    expect(dialogMatchesToolCall(parse(WIDE)!, { ...call(CALL_A), command: 'Set-Content -Path fx-a.txt -Value key' })).toBe(false);
    expect(dialogMatchesToolCall(parse(WIDE)!, { ...call(CALL_A), description: 'Write key-test' })).toBe(false);
    expect(dialogMatchesToolCall(parse(WIDE)!, { ...call(CALL_A), name: 'Bash' })).toBe(false);
    expect(dialogMatchesToolCall(parse(GUTTER)!, { ...call(CALL_C), command: 'Get-ChildItem -Path . -Filter *.txt' })).toBe(false);
  });

  it('offers the phone the plain Yes and No only: "always allow" stays in the terminal', () => {
    expect(terminalPromptAnswerability(parse(WIDE)!)).toEqual({
      answerable: true,
      choices: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }],
    });
    expect(terminalPromptAnswerability(parse(NARROW)!).choices).toEqual([{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }]);
    expect(terminalPromptAnswerability(parse(GUTTER)!).choices).toEqual([{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]);
    expect(decisionForChoiceLabel(parse(WIDE)!.options[1]!.label)).toBeNull();
  });
});

describe('a Write-tool dialog (2.1.294)', () => {
  it('the accept-edits mode switch is never a phone choice', () => {
    const parsed = parse(WRITE)!;
    expect(parsed).toMatchObject({ question: 'Do you want to create fx-w.txt?', active: true });
    // The Write dialog names no tool and binds no call (its screen does not
    // spell the call); this only pins that its mode switch stays display-only.
    expect(toolFromDialogTitle(parsed.title)).toBeUndefined();
    expect(parsed.options.map((o) => o.key)).toEqual(['1', '2', '3']);
    expect(decisionForChoiceLabel(parsed.options[1]!.label)).toBeNull();
  });
});

// ── The record and the answer, through the registry ─────────────────────────

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-1936-test-')); });
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

describe('PowerShell-tool records', () => {
  it.each([
    ['100 columns', WIDE, CALL_A, [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }]],
    ['80 columns', NARROW, CALL_B, [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }]],
    ['80 columns, gutter-drawn', GUTTER, CALL_C, [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }]],
  ])('%s: the dialog becomes an answerable record and the phone presses 1:Yes', async (_label, fx, pending, choices) => {
    const h = makeRegistry(fx, pending, true);
    const record = await create(h);
    expect(record).toMatchObject({
      kind: 'terminal_prompt',
      toolName: 'PowerShell',
      summary: pending.input['command'],
      question: 'Do you want to proceed?',
      choices,
      toolUseId: pending.id,
    });
    expect(record.promptFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(await resolve(h, record, { choiceKey: '1', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER })).toMatchObject({ ok: true });
    expect(h.writes).toEqual(['1']);
  });

  it('the gutter-drawn record carries the dialog\'s reason', async () => {
    const record = await create(makeRegistry(GUTTER, CALL_C, true));
    expect(record.reason).toBe('Command contains script block that may execute arbitrary code');
  });

  it('the "always allow" option cannot be pressed from the phone', async () => {
    const h = makeRegistry(WIDE, CALL_A, true);
    const record = await create(h);
    expect(await resolve(h, record, { choiceKey: '2', terminalPromptAnswer: TERMINAL_PROMPT_WEB_ANSWER }))
      .toMatchObject({ ok: false, reason: 'invalid-choice' });
    expect(h.writes).toEqual([]);
  });

  it('a dialog for another PowerShell call stays terminal-only', async () => {
    const record = await create(makeRegistry(WIDE, CALL_B, true));
    expect(record.choices).toBeUndefined();
    expect(record.promptFingerprint).toBeUndefined();
  });

  it('the decline route closes it with the win32-input-mode Esc record', async () => {
    const h = makeRegistry(WIDE, CALL_A, true);
    const record = await create(h);
    expect(await resolve(h, record, { decision: 'deny', terminalPromptDecline: TERMINAL_PROMPT_WEB_DECLINE }))
      .toMatchObject({ ok: true });
    expect(h.writes).toEqual([ESCAPE_WIN32]);
  });
});
