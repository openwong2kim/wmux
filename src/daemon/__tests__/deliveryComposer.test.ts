// Plain input mode from a frame, per agent: positive evidence of the agent's
// plain prompt, with its modes and dialogs as named refusals.
import { describe, expect, it } from 'vitest';
import { cursorInComposer, frameShowsPaste, hasPlainPrompt, readComposer, type DeliveryFrame } from '../deliveryComposer';

const RULE = '─'.repeat(40);
const f = (rows: string[], undimmed: string[] = rows, cursorRow = -1): DeliveryFrame => ({ rows: Object.assign([...rows], { undimmed }), cursorRow });

describe('Claude Code', () => {
  it('plain: the ❯ prompt between rules (Claude draws a no-break space after the glyph)', () => {
    expect(readComposer(f([RULE, '❯\u00a0', RULE, '  ? for shortcuts']), 'claude', 'paste').verdict).toBe('plain');
  });

  it('a dimmed suggestion in an empty prompt is still empty', () => {
    expect(readComposer(f([RULE, '❯\u00a0Try "fix lint"', RULE], [RULE, '❯', RULE]), 'claude', 'paste').verdict).toBe('plain');
  });

  it('`!` shell mode and `#` mode are named refusals, empty or not', () => {
    expect(readComposer(f([RULE, '!\u00a0', RULE, '  ! for shell mode']), 'claude', 'paste').verdict).toBe('mode');
    expect(readComposer(f([RULE, '!\u00a0ls', RULE]), 'claude', 'enter').verdict).toBe('mode');
    expect(readComposer(f([RULE, '#\u00a0', RULE]), 'claude', 'paste').verdict).toBe('mode');
  });

  it("a shell-mode command echoed in the transcript is not the prompt's mode", () => {
    expect(readComposer(f(['! ls', '  ⎿  file', RULE, '❯\u00a0', RULE]), 'claude', 'paste').verdict).toBe('plain');
  });

  it("a collapsed paste wrapped in a narrow box is a draft, as w4-6's Windows frames draw it (#3390)", () => {
    // Default foreground (no dim), the placeholder wrapped over 2 rows at 27 columns and over 4 at 12.
    const R27 = '─'.repeat(27);
    const R12 = '─'.repeat(12);
    expect(readComposer(f(['⏺ Done.', '', R27, '❯ [Pasted text #1 +7', '  lines]', R27, '  ? for shortcuts']), 'claude', 'paste').verdict).toBe('busy');
    expect(readComposer(f(['⏺ Done.', '', R12, '❯ [Pasted', '  text #1', '  +7', '  lines]', R12, '  ? for']), 'claude', 'paste').verdict).toBe('busy');
  });

  it('a dialog, a draft, or no prompt at all', () => {
    expect(readComposer(f(['Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel']), 'claude', 'paste').verdict).toBe('mode');
    expect(readComposer(f([RULE, '❯\u00a0my draft', RULE]), 'claude', 'paste').verdict).toBe('busy');
    expect(readComposer(f(['user@host ~ % ']), 'claude', 'paste').verdict).toBe('unknown');
    expect(readComposer(null, 'claude', 'paste').verdict).toBe('unknown');
  });

  it('only the composer and the rows under it decide: a transcript quoting a dialog or a mode is not the state', () => {
    const quoted = ['  Esc to cancel', '  ! for shell mode', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'];
    expect(readComposer(f([...quoted, RULE, '❯\u00a0', RULE, '  ? for shortcuts']), 'claude', 'paste').verdict).toBe('plain');
    // At the Enter the composer holds our paste, which may quote such words itself.
    expect(readComposer(f([RULE, '❯\u00a0press Esc to cancel', '  # to memorize', RULE]), 'claude', 'enter').verdict).toBe('plain');
    // A real dialog under the composer still refuses.
    expect(readComposer(f([RULE, '❯\u00a0', RULE, 'Esc to cancel']), 'claude', 'paste').verdict).toBe('mode');
  });

  it('a block forged in the transcript (indented, as Claude prints it) above a dialog is not a composer', () => {
    const forged = ['⏺ an earlier message, echoed:', `  ${RULE}`, '  ❯\u00a0', `  ${RULE}`, ''];
    // A dialog with no footer wmux knows: nothing reads as a prompt.
    const plainDialog = [...forged, RULE, ' Choose a theme', ' ❯ Dark', '   Light'];
    expect(readComposer(f(plainDialog), 'claude', 'paste').verdict).toBe('unknown');
    expect(readComposer(f(plainDialog), 'claude', 'enter').verdict).toBe('unknown');
    // An approval: named as the dialog it is.
    expect(readComposer(f([...forged, RULE, ' Do you want to make this edit?', ' ❯ 1. Yes', '   2. No']), 'claude', 'paste').verdict).toBe('mode');
  });

  it("a rule inside a draft (indented under the prompt) does not close the composer", () => {
    expect(readComposer(f([RULE, '❯\u00a01. Run the report', '  ──────────', '  Then summarize it.', RULE]), 'claude', 'paste').verdict).toBe('busy');
  });

  it('the cursor test covers the prompt row only', () => {
    const frame = f([RULE, '❯\u00a0', RULE, '  ? for shortcuts'], undefined, 1);
    const read = readComposer(frame, 'claude', 'paste');
    expect(cursorInComposer(frame, read)).toBe(true);
    expect(cursorInComposer({ ...frame, cursorRow: 3 }, read)).toBe(false);
  });

  describe('the rows of a pane whose ring has wrapped (2.1.330/2.1.331 after an auto-update)', () => {
    const R80 = '─'.repeat(80);
    const NOTICE = '                                        ✔ Update installed · /restart to apply';
    const STATUS = '                                     21% · 7d 68% ↺ 2d1h';
    const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · PR #3508 · ← 2 agents';
    const SURVEY = ['● How is Claude doing this session? (optional)', '  1: Bad    2: Fine   3: Good   0: Dismiss', ''];
    const NOTICE_LEFT = '  new task? /clear to save 210.5k to… · ✔ Update installed · /restart to apply';

    it('a blank row where the closing rule was drawn is no composer: its cells may hide a draft', () => {
      const rows = ['✻ Worked for 7m 38s · done 2:21 PM', NOTICE, R80, '❯ ', '', STATUS, FOOTER];
      expect(readComposer(f(rows), 'claude', 'paste').verdict).toBe('unknown');
      expect(readComposer(f(rows), 'claude', 'enter').verdict).toBe('unknown');
    });

    it('the update notice over the top rule is not what refuses: with its closing rule the composer is plain', () => {
      expect(readComposer(f(['✻ Worked for 7m 38s · done 2:21 PM', NOTICE, R80, '❯ ', R80, STATUS, FOOTER]), 'claude', 'paste').verdict).toBe('plain');
      expect(readComposer(f([NOTICE_LEFT, R80, '❯ ', R80, FOOTER]), 'claude', 'paste').verdict).toBe('plain');
    });

    it("the session survey takes a digit at the empty prompt: a mode at the paste, with or without the closing rule", () => {
      expect(readComposer(f([...SURVEY, NOTICE_LEFT, R80, '❯ ', R80, FOOTER]), 'claude', 'paste').verdict).toBe('mode');
      // At the Enter the prompt holds this delivery's paste, which no digit key answers: the Enter submits it.
      expect(readComposer(f([...SURVEY, NOTICE_LEFT, R80, '❯\u00a0hello', R80, FOOTER]), 'claude', 'enter').verdict).toBe('plain');
      expect(readComposer(f([...SURVEY, NOTICE_LEFT, R80, '❯ ', '', STATUS, FOOTER]), 'claude', 'paste').verdict).not.toBe('plain');
    });

    it('a survey far up the transcript, answered long ago, is not the pane\'s state', () => {
      expect(readComposer(f([...SURVEY, '⏺ ok', '', '⏺ more', '', NOTICE, R80, '❯ ', R80, FOOTER]), 'claude', 'paste').verdict).toBe('plain');
    });

    it('a permission prompt and a draft still refuse under the update notice', () => {
      expect(readComposer(f([NOTICE, R80, ' Do you want to make this edit?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel']), 'claude', 'paste').verdict).toBe('mode');
      expect(readComposer(f([NOTICE, R80, '❯ my draft', R80, FOOTER]), 'claude', 'paste').verdict).toBe('busy');
    });
  });
});

describe('Codex', () => {
  const footer = '  gpt-5 medium · ~/project';
  it('plain: the › prompt over its footer, empty (the placeholder is dim)', () => {
    expect(readComposer(f(['› Ask Codex to do anything', footer], ['›', footer]), 'codex', 'paste').verdict).toBe('plain');
  });

  it('a draft, or a popup between the prompt and the footer, holds', () => {
    expect(readComposer(f(['› fix it', footer]), 'codex', 'paste').verdict).toBe('busy');
    expect(readComposer(f(['› /', '  /model  choose a model', '  /new    new chat', footer], ['› /', '  /model  choose a model', '  /new    new chat', footer]), 'codex', 'paste').verdict).toBe('busy');
  });

  it('an overlay that waits for esc is a refusal; a tmux status line under the footer is not the composer', () => {
    expect(readComposer(f(['› ', footer, '  esc to close']), 'codex', 'paste').verdict).toBe('mode');
    expect(readComposer(f(['›', footer, '[0] 0:codex*   "host" 12:01'], ['›', footer, '[0] 0:codex*   "host" 12:01']), 'codex', 'paste').verdict).toBe('plain');
  });

  it('a transcript, or our own paste, that says "esc to cancel" is not an overlay', () => {
    expect(readComposer(f(['• press esc to cancel the run', '›', footer]), 'codex', 'paste').verdict).toBe('plain');
    expect(readComposer(f(['› press esc to cancel', footer]), 'codex', 'enter').verdict).toBe('plain');
  });
});

describe('every other agent', () => {
  it('has no known plain prompt', () => {
    expect(hasPlainPrompt('gemini')).toBe(false);
    expect(hasPlainPrompt('opencode')).toBe(false);
    expect(hasPlainPrompt('claude')).toBe(true);
    expect(hasPlainPrompt('codex')).toBe(true);
  });
});

describe('frameShowsPaste', () => {
  const footer = '  gpt-5 medium · ~/project';
  const ENVELOPE = { probe: '━━━ WMUX A2A ━━━', lines: 10, chars: 600 };
  it("finds the paste's start, or the agent's collapsed form of it, on the composer's own rows", () => {
    expect(frameShowsPaste(f([RULE, '❯\u00a0wmux: A2A task t-1 is', RULE]), { probe: 'wmux: A2A task t-1' })).toBe(true);
    expect(frameShowsPaste(f([RULE, '❯\u00a0[Pasted text #1 +10 lines]', RULE]), ENVELOPE)).toBe(true);
    // One long line: Claude names no line count.
    expect(frameShowsPaste(f([RULE, '❯\u00a0[Pasted text #2]', RULE]), { probe: 'x', lines: 0, chars: 1200 })).toBe(true);
    expect(frameShowsPaste(f(['› [Pasted Content 600 chars]', footer]), ENVELOPE)).toBe(true);
  });

  it("someone else's paste is not this one: another count, a second paste, or keys after it", () => {
    expect(frameShowsPaste(f([RULE, '❯\u00a0[Pasted text #1 +3 lines]', RULE]), ENVELOPE)).toBe(false);
    expect(frameShowsPaste(f([RULE, '❯\u00a0[Pasted text #1 +10 lines] [Pasted text #2 +10 lines]', RULE]), ENVELOPE)).toBe(false);
    expect(frameShowsPaste(f([RULE, '❯\u00a0[Pasted text #1 +10 lines] and my note', RULE]), ENVELOPE)).toBe(false);
    expect(frameShowsPaste(f(['› [Pasted Content 599 chars]', footer]), ENVELOPE)).toBe(false);
    // No count to compare with: never ours.
    expect(frameShowsPaste(f([RULE, '❯\u00a0[Pasted text #1 +10 lines]', RULE]), { probe: '━━━ WMUX A2A ━━━' })).toBe(false);
  });

  it('with the whole text, an uncollapsed paste must be the entire input, wrapped rows joined', () => {
    const text = 'wmux: A2A task t-1 is waiting for you, read it with a2a_task_query';
    const pasted = { probe: 'wmux: A2A task t-1 is wa', text };
    // Wrapped as the composer wraps it: continuation rows indented.
    const wrapped = [RULE, '❯\u00a0wmux: A2A task t-1 is waiting for you, read', '  it with a2a_task_query', RULE];
    expect(frameShowsPaste(f(wrapped), pasted)).toBe(true);
    // Same start, but someone's keys before or after it: not only ours.
    expect(frameShowsPaste(f([RULE, `❯\u00a0${text} and also fix the build`, RULE]), pasted)).toBe(false);
    expect(frameShowsPaste(f([RULE, `❯\u00a0note: ${text}`, RULE]), pasted)).toBe(false);
    // Only part of it shown (the rest never arrived): not this paste either.
    expect(frameShowsPaste(f([RULE, '❯\u00a0wmux: A2A task t-1 is waiting', RULE]), pasted)).toBe(false);
  });

  describe('a one-line pointer in a narrow box (#3390)', () => {
    const NARROW = '─'.repeat(27);
    const text = '[wmux] new A2A task 3ac71741 from Workspace 1.w1-2 — a2a_task_query task_id:task-3ac71741-02eb-4659-988e-f3cbeb63a838';
    const pointer = { probe: '[wmux] new A2A task 3ac7', lines: 0, chars: [...text].length, text };

    it('collapsed with the rows it takes as its count, the placeholder wrapped over two rows', () => {
      expect(frameShowsPaste(f([NARROW, '❯\u00a0[Pasted text #1 +7', '  lines]', NARROW]), pointer)).toBe(true);
      // On one row too.
      expect(frameShowsPaste(f([RULE, '❯\u00a0[Pasted text #1 +7 lines]', RULE]), pointer)).toBe(true);
      // Two placeholders, or one with keys after it, still are not ours.
      expect(frameShowsPaste(f([NARROW, '❯\u00a0[Pasted text #1 +7', '  lines] [Pasted text #2', '  +7 lines]', NARROW]), pointer)).toBe(false);
      expect(frameShowsPaste(f([NARROW, '❯\u00a0[Pasted text #1 +7', '  lines] ok', NARROW]), pointer)).toBe(false);
      // More rows than its characters could fill in any box: someone else's paste.
      expect(frameShowsPaste(f([NARROW, '❯\u00a0[Pasted text #1 +40', '  lines]', NARROW]), pointer)).toBe(false);
    });

    it("collapsed, its start scrolled out of a 12-column box that draws a hint under itself (w4-6's frame)", () => {
      const RULE12 = '─'.repeat(12);
      const hint = ['  paste', '  again to', '  expand'];
      const frame = f([RULE12, '❯\u00a0text #2', '  +7', '  lines]', RULE12, ...hint]);
      expect(frameShowsPaste(frame, pointer)).toBe(true);
      // The hint rows sit under the closing rule: not the composer's, and not a mode.
      expect(readComposer(frame, 'claude', 'enter')).toEqual({ verdict: 'plain', span: { from: 1, to: 4 } });
      // Only `lines]` (no count), a tail with keys after it, someone else's count, or a cut that is not the placeholder's.
      expect(frameShowsPaste(f([RULE12, '❯\u00a0lines]', RULE12, ...hint]), pointer)).toBe(false);
      expect(frameShowsPaste(f([RULE12, '❯\u00a0text #2', '  +7', '  lines] ok', RULE12]), pointer)).toBe(false);
      expect(frameShowsPaste(f([RULE12, '❯\u00a0text #2', '  +40', '  lines]', RULE12]), pointer)).toBe(false);
      expect(frameShowsPaste(f([RULE12, '❯\u00a0note #2', '  +7', '  lines]', RULE12]), pointer)).toBe(false);
      expect(frameShowsPaste(f([RULE12, '❯\u00a0text #', '  +7', '  lines]', RULE12]), pointer)).toBe(false);
      // Its count alone, or the number's last digits, still are this placeholder's end.
      expect(frameShowsPaste(f([RULE12, '❯\u00a0+7 lines]', RULE12]), pointer)).toBe(true);
    });

    it('a double-width text counts two columns a character: 40 Hangul characters take up to 10 rows of 8 columns', () => {
      const wide = '가'.repeat(40);
      const pasted = { probe: wide.slice(0, 24), lines: 0, chars: 40, text: wide };
      expect(frameShowsPaste(f([NARROW, '❯\u00a0[Pasted text #1 +10', '  lines]', NARROW]), pasted)).toBe(true);
      expect(frameShowsPaste(f([NARROW, '❯\u00a0[Pasted text #1 +11', '  lines]', NARROW]), pasted)).toBe(false);
    });

    it('scrolled, its start out of view: the visible rows are the end of this text', () => {
      const scrolled = [NARROW, '❯\u00a03ac71741 from Workspace', '  1.w1-2 —', '  a2a_task_query task_id:', '  task-3ac71741-02eb-4659', '  -988e-f3cbeb63a838', NARROW];
      expect(frameShowsPaste(f(scrolled), pointer)).toBe(true);
    });

    it('scrolled, but not ours: a key typed after it, too short a tail, or another task id', () => {
      const typedAfter = [NARROW, '❯\u00a0a2a_task_query task_id:', '  task-3ac71741-02eb-4659', '  -988e-f3cbeb63a838x', NARROW];
      expect(frameShowsPaste(f(typedAfter), pointer)).toBe(false);
      expect(frameShowsPaste(f([NARROW, '❯\u00a0-f3cbeb63a838', NARROW]), pointer)).toBe(false);
      const other = [NARROW, '❯\u00a0a2a_task_query task_id:', '  task-99999999-02eb-4659', '  -988e-f3cbeb63a838', NARROW];
      expect(frameShowsPaste(f(other), pointer)).toBe(false);
    });
  });

  it('the same words in the transcript above prove nothing', () => {
    const earlier = ['❯ wmux: A2A task t-1 is waiting', '⏺ [Pasted text #1 +10 lines]'];
    expect(frameShowsPaste(f([...earlier, RULE, '❯\u00a0my own draft', RULE]), { probe: 'wmux: A2A task t-1' })).toBe(false);
    expect(frameShowsPaste(f([...earlier, RULE, '❯\u00a0my own draft', RULE]), ENVELOPE)).toBe(false);
  });

  it('with no composer (a shell took over), only the cursor row counts', () => {
    const rows = ['user@host ~ % wmux: A2A task t-1 is', 'zsh: command not found: wmux:', 'user@host ~ % '];
    const pointer = { probe: 'wmux: A2A task t-1' };
    expect(frameShowsPaste(f(rows, rows, 2), pointer)).toBe(false);
    expect(frameShowsPaste(f(rows, rows, 0), pointer)).toBe(true);
    expect(frameShowsPaste(f(['user@host ~ % '], undefined, -1), { probe: 'x' })).toBe(false);
    expect(frameShowsPaste(null, { probe: 'x' })).toBe(false);
  });
});
