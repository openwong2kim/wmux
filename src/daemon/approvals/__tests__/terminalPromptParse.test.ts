// The Claude Code permission-dialog parser and its cursor-free fingerprint.
import { describe, it, expect } from 'vitest';
import {
  decisionForChoiceLabel,
  dialogMatchesToolCall,
  parseTerminalPrompt,
  PROMPT_MAX_COMMAND_LINES,
  terminalPromptAnswerability,
} from '../terminalPromptParse';
import { generateTextSnapshot } from '../../HeadlessSnapshot';

// The text of a real dialog raised by a user `permissions.ask` rule in a
// bypassPermissions session. Paths are placeholders.
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

const cursorOn = (rows: string[], key: string): string[] =>
  rows.map((row) => {
    const m = /^ (?:❯| ) (\d)\. (.*)$/.exec(row);
    if (!m) return row;
    return m[1] === key ? ` ❯ ${m[1]}. ${m[2]}` : `   ${m[1]}. ${m[2]}`;
  });

describe('parseTerminalPrompt', () => {
  it('reads the title, command lines, reason, question and options', () => {
    expect(parseTerminalPrompt(DIALOG)).toMatchObject({
      title: 'Bash command',
      commandLines: ['rm -rf build/cache', 'Remove the build cache'],
      reason: 'Permission rule Bash(rm -rf *) requires confirmation for this command.',
      question: 'Do you want to proceed?',
      options: [
        { key: '1', label: 'Yes', selected: true },
        { key: '2', label: 'No', selected: false },
      ],
    });
  });

  it('takes any number of options and leaves footer actions out', () => {
    const rows = [
      ...DIALOG.slice(0, 11),
      ' ❯ 1. Yes',
      '   2. Yes, and don\'t ask again for rm commands in this project',
      '   3. No, and tell Claude what to do differently (esc)',
      '',
      ' Esc to cancel · Tab to amend',
    ];
    const parsed = parseTerminalPrompt(rows);
    expect(parsed?.options.map((o) => o.key)).toEqual(['1', '2', '3']);
    expect(parsed?.options.map((o) => o.label).join(' ')).not.toMatch(/Tab to amend|Esc to cancel/);
  });

  it('the fingerprint ignores where the cursor is', () => {
    const a = parseTerminalPrompt(cursorOn(DIALOG, '1'));
    const b = parseTerminalPrompt(cursorOn(DIALOG, '2'));
    expect(a?.options[1]?.selected).toBe(false);
    expect(b?.options[1]?.selected).toBe(true);
    expect(a?.fingerprint).toBe(b?.fingerprint);
    expect(a?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('the fingerprint changes with the command, the reason or the options', () => {
    const base = parseTerminalPrompt(DIALOG)!.fingerprint;
    const swap = (from: string, to: string) =>
      parseTerminalPrompt(DIALOG.map((row) => row.replace(from, to)))!.fingerprint;
    expect(swap('rm -rf build/cache', 'rm -rf build/other')).not.toBe(base);
    expect(swap('Permission rule', 'Policy rule')).not.toBe(base);
    expect(swap('2. No', '2. Never')).not.toBe(base);
  });

  it('reads a boxed dialog the same way', () => {
    const boxed = DIALOG.slice(2).map((row) => (row.startsWith('──') ? `╭${row}╮` : `│${row.padEnd(76)}│`));
    const plain = parseTerminalPrompt(DIALOG);
    const parsed = parseTerminalPrompt(boxed);
    expect(parsed?.commandLines).toEqual(plain?.commandLines);
    expect(parsed?.reason).toBe(plain?.reason);
    expect(parsed?.fingerprint).toBe(plain?.fingerprint);
  });

  it('joins a reason the TUI wrapped over two rows', () => {
    const rows = [...DIALOG];
    rows.splice(8, 1, ' Permission rule Bash(rm -rf *) requires confirmation for', ' this command.');
    expect(parseTerminalPrompt(rows)?.reason)
      .toBe('Permission rule Bash(rm -rf *) requires confirmation for this command.');
  });

  it('joins soft-wrapped snapshot rows before parsing', () => {
    const rows = DIALOG.map((text) => ({ text, wrapped: false }));
    rows.splice(5, 1, { text: '   rm -rf build/ca', wrapped: false }, { text: 'che', wrapped: true });
    expect(parseTerminalPrompt(rows)?.commandLines[0]).toBe('rm -rf build/cache');
    expect(parseTerminalPrompt(rows)?.fingerprint).toBe(parseTerminalPrompt(DIALOG)?.fingerprint);
  });

  it.each([
    ['no question row', DIALOG.filter((r) => !r.includes('proceed'))],
    ['no option rows', DIALOG.filter((r) => !/\d\. /.test(r))],
    ['options out of order', DIALOG.map((r) => r.replace('2. No', '3. No'))],
    ['two cursors', DIALOG.map((r) => r.replace('   2. No', ' ❯ 2. No'))],
    ['an empty grid', []],
  ])('refuses %s', (_label, rows) => {
    expect(parseTerminalPrompt(rows)).toBeNull();
  });

  it('caps the command block', () => {
    const rows = [...DIALOG];
    rows.splice(6, 0, ...Array.from({ length: 40 }, (_, i) => `   line ${i}`));
    expect(parseTerminalPrompt(rows)?.commandLines).toHaveLength(PROMPT_MAX_COMMAND_LINES);
  });

  it('two dialogs alike for their first 200 characters but not after hash apart', () => {
    const long = (tail: string) => DIALOG.map((row) =>
      row === '   rm -rf build/cache' ? `   rm -rf ${'x'.repeat(220)}${tail}` : row);
    const a = parseTerminalPrompt(long('/alpha'))!;
    const b = parseTerminalPrompt(long('/beta'))!;
    expect(a.commandLines[0]).toBe(b.commandLines[0]);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    // A display cap is not a cut: the dialog is still whole on screen.
    expect(a.truncated).toBe(true);
    expect(a.cut).toBe(false);
    expect(terminalPromptAnswerability(a).answerable).toBe(true);
  });

  it('a row the TUI itself cut (ellipsis) makes the dialog unanswerable', () => {
    const rows = DIALOG.map((r) => (r === '   rm -rf build/cache' ? '   rm -rf build/ca…' : r));
    const parsed = parseTerminalPrompt(rows)!;
    expect(parsed.cut).toBe(true);
    expect(terminalPromptAnswerability(parsed).answerable).toBe(false);
  });

  it('whitespace is collapsed, never dropped: a space inside the command changes the hash', () => {
    const with_ = (cmd: string) => parseTerminalPrompt(DIALOG.map((r) => (r === '   rm -rf build/cache' ? `   ${cmd}` : r)))!;
    expect(with_('rm -rf /tmp/cache').fingerprint).not.toBe(with_('rm -rf / tmp/cache').fingerprint);
    expect(with_('rm -rf   /tmp/cache').fingerprint).toBe(with_('rm -rf /tmp/cache').fingerprint);
  });

  it('the fingerprint survives the TUI breaking a command over different rows', () => {
    const one = [...DIALOG];
    one.splice(5, 1, '   rm -rf build/cache other/dir');
    const two = [...DIALOG];
    two.splice(5, 1, '   rm -rf build/cache', '   other/dir');
    expect(parseTerminalPrompt(one)!.fingerprint).toBe(parseTerminalPrompt(two)!.fingerprint);
  });

  it('is active only at the bottom of the screen with one cursor and the footer under it', () => {
    expect(parseTerminalPrompt(DIALOG)!.active).toBe(true);
    // Printed into the scrollback by `cat`, with a shell prompt below it.
    expect(parseTerminalPrompt([...DIALOG, '$ '])!.active).toBe(false);
    // No cursor on any option.
    expect(parseTerminalPrompt(DIALOG.map((r) => r.replace(' ❯ 1. Yes', '   1. Yes')))!.active).toBe(false);
    // No footer.
    expect(parseTerminalPrompt(DIALOG.filter((r) => !r.includes('Esc to cancel')))!.active).toBe(false);
  });

  it('with the top rule off screen, a visible "Bash command" row stays the title, not the reason', () => {
    const parsed = parseTerminalPrompt(DIALOG.slice(3))!;
    expect(parsed.topRuleFound).toBe(false);
    expect(parsed.title).toBe('Bash command');
    expect(parsed.reason).toBe('Permission rule Bash(rm -rf *) requires confirmation for this command.');
  });

  it('a dialog taller than the viewport (top rule off screen) never binds as a whole dialog', () => {
    const cut = DIALOG.slice(4);
    const parsed = parseTerminalPrompt(cut)!;
    expect(parsed.topRuleFound).toBe(false);
    expect(parsed.title).toBeUndefined();
    const call = { name: 'Bash', command: 'rm -rf build/cache', description: 'Remove the build cache' };
    expect(dialogMatchesToolCall(parsed, call)).toBe(false);
    // Only the registry's top-cut path (exact tool_use id) may bind it.
    expect(dialogMatchesToolCall(parsed, call, { topCut: true })).toBe(true);
  });

  it('only the plain Yes and No are answerable choices; "don\'t ask again" never is', () => {
    const rows = [
      ...DIALOG.slice(0, 11),
      ' ❯ 1. Yes',
      '   2. Yes, and don\'t ask again for rm commands in this project',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend',
    ];
    expect(terminalPromptAnswerability(parseTerminalPrompt(rows)!)).toEqual({
      answerable: true,
      choices: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }],
    });
    const noPlainYes = rows.map((r) => r.replace(' ❯ 1. Yes', ' ❯ 1. Yes, allow once'));
    expect(terminalPromptAnswerability(parseTerminalPrompt(noPlainYes)!).answerable).toBe(false);
  });

  it('a command longer than the 200-character summary is still answerable', () => {
    const rows = DIALOG.map((r) => (r === '   Remove the build cache' ? `   ${'word '.repeat(45)}` : r));
    expect(terminalPromptAnswerability(parseTerminalPrompt(rows)!).answerable).toBe(true);
    expect(terminalPromptAnswerability(parseTerminalPrompt(DIALOG)!).answerable).toBe(true);
  });

  it('parses the dialog off a real headless render of its bytes', async () => {
    const bytes = `\x1b[H\x1b[2J${DIALOG.join('\r\n')}`;
    const outcome = await generateTextSnapshot({ cols: 100, rows: 30, scrollback: 0, initial: Buffer.from(bytes) });
    if (!outcome.ok) throw new Error('snapshot failed');
    const parsed = parseTerminalPrompt(outcome.rows);
    expect(parsed?.fingerprint).toBe(parseTerminalPrompt(DIALOG)?.fingerprint);
    expect(parsed?.options).toHaveLength(2);
  });
});

describe('the top rule, the No label, and binding to a call', () => {
  it('only a column-0 rule row is the frame; an indented dash row is body', () => {
    const rows = [...DIALOG];
    rows.splice(6, 0, '   --------------------------------------------------------');
    const parsed = parseTerminalPrompt(rows)!;
    expect(parsed.topRuleFound).toBe(true);
    expect(parsed.title).toBe('Bash command');
    expect(parsed.commandLines).toContain('--------------------------------------------------------');
  });

  it('with the grid width known, the rule must span it', () => {
    expect(parseTerminalPrompt(DIALOG, { cols: 60 })!.topRuleFound).toBe(true);
    expect(parseTerminalPrompt(DIALOG, { cols: 120 })!.topRuleFound).toBe(false);
  });

  it.each([
    ['No', 'deny'],
    ['No, and tell Claude what to do differently (esc)', 'deny'],
    ['Yes', 'approve'],
    ['Yes, allow once', null],
    ["Yes, and don't ask again for rm commands", null],
    ['No, always deny', null],
    ['Yes, for this session', null],
    ['Nope', null],
  ] as const)('"%s" → %s', (label, decision) => {
    expect(decisionForChoiceLabel(label)).toBe(decision);
  });

  it('binds to the call whose command (and description) the dialog shows, nothing else', () => {
    const parsed = parseTerminalPrompt(DIALOG)!;
    expect(dialogMatchesToolCall(parsed, { name: 'Bash', command: 'rm -rf build/cache', description: 'Remove the build cache' })).toBe(true);
    expect(dialogMatchesToolCall(parsed, { name: 'Bash', command: 'rm -rf build/cache' })).toBe(false);
    expect(dialogMatchesToolCall(parsed, { name: 'Bash', command: 'rm -rf build', description: 'cache Remove the build cache' })).toBe(false);
    expect(dialogMatchesToolCall(parsed, { name: 'Write', command: 'rm -rf build/cache', description: 'Remove the build cache' })).toBe(false);
  });
});

describe('Claude Code 2.1.289: the command boxed between dashed rules', () => {
  // Measured (fixtures/terminal-prompts/claude-bash-boxed-01.json): title and
  // description above a dashed box, gutter rows inside, the reason under it,
  // all at the prose indent.
  const BOXED = [
    '──────────────────────────────────────────────────',
    ' Bash command',
    ' Verify subtract function works',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' │ node -e "import(\'./math.js\').then(m => { const',
    ' │ result = m.subtract(5, 3);',
    ' │ console.log(\'Test passed:\', result === 2); })"',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' This command requires approval',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don’t ask again for: node *',
    '   3. No',
    '',
    ' Esc to cancel · Tab to amend',
  ];
  const command = 'node -e "import(\'./math.js\').then(m => { const result = m.subtract(5, 3); console.log(\'Test passed:\', result === 2); })"';

  it('reads the solid rule as the top: title, description, command and reason each in place', () => {
    const p = parseTerminalPrompt(BOXED, { cols: 50 })!;
    expect(p).toMatchObject({
      title: 'Bash command',
      descriptionRows: ['Verify subtract function works'],
      reason: 'This command requires approval',
      topRuleFound: true,
      active: true,
    });
    expect(p.commandFull).toBe(command);
    expect(terminalPromptAnswerability(p)).toEqual({ answerable: true, choices: [{ key: '1', label: 'Yes' }, { key: '3', label: 'No' }] });
  });

  it('binds to its call, and not to another command or description', () => {
    const p = parseTerminalPrompt(BOXED, { cols: 50 })!;
    expect(dialogMatchesToolCall(p, { name: 'Bash', command, description: 'Verify subtract function works' })).toBe(true);
    expect(dialogMatchesToolCall(p, { name: 'Bash', command: `${command} && rm -rf x` })).toBe(false);
    expect(dialogMatchesToolCall(p, { name: 'Bash', command, description: 'Something else' })).toBe(false);
    expect(dialogMatchesToolCall(p, { name: 'Read', command })).toBe(false);
  });

  it('with the top scrolled off, the box still gives the command, bound only as a top-cut dialog', () => {
    const cut = BOXED.slice(3); // solid rule, title and description scrolled away
    const p = parseTerminalPrompt(cut, { cols: 50 })!;
    expect(p).toMatchObject({ topRuleFound: false, reason: 'This command requires approval', active: true, descriptionRows: [] });
    expect(p.title).toBeUndefined();
    expect(p.commandFull).toBe(command);
    expect(dialogMatchesToolCall(p, { name: 'Bash', command })).toBe(false);
    expect(dialogMatchesToolCall(p, { name: 'Bash', command }, { topCut: true })).toBe(true);
    expect(dialogMatchesToolCall(p, { name: 'Bash', command: `${command} && rm -rf /` }, { topCut: true })).toBe(false);
  });

  it('a command short enough to need no gutter is still the command, under a "<Tool> command" title', () => {
    const short = [
      '──────────────────────────────────────────────────',
      ' Bash command',
      ' Run shell command',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' node math.test.js',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' This command requires approval',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      '',
      ' Esc to cancel · Tab to amend',
    ];
    const p = parseTerminalPrompt(short, { cols: 50 })!;
    expect(p).toMatchObject({ title: 'Bash command', commandFull: 'node math.test.js', reason: 'This command requires approval' });
    // A call with no description of its own: Claude's label is not compared.
    expect(dialogMatchesToolCall(p, { name: 'Bash', command: 'node math.test.js' })).toBe(true);
    expect(dialogMatchesToolCall(p, { name: 'Bash', command: 'node other.js' })).toBe(false);
  });

  it('a dashed box under any other title (an Edit dialog\'s diff) is not this layout', () => {
    const edit = [
      '──────────────────────────────────────────────────',
      ' Edit file',
      ' notes.txt',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' 2 -beta',
      ' 2 +BETA',
      '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
      ' Do you want to make this edit to notes.txt?',
      ' ❯ 1. Yes',
      '   2. No',
      '',
      ' Esc to cancel · Tab to amend',
    ];
    expect(parseTerminalPrompt(edit, { cols: 50 })?.title).not.toBe('Edit file');
  });

  it('a dashed box with a non-gutter row inside is not this layout', () => {
    const odd = [...BOXED];
    odd[5] = ' result = m.subtract(5, 3);';
    const p = parseTerminalPrompt(odd, { cols: 50 })!;
    expect(p.title).not.toBe('Bash command');
  });
});
