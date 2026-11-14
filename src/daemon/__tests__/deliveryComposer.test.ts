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
  it("finds the paste's start, or the agent's collapsed paste, on the composer's own rows", () => {
    expect(frameShowsPaste(f([RULE, '❯\u00a0wmux: A2A task t-1 is', RULE]), 'wmux: A2A task t-1')).toBe(true);
    expect(frameShowsPaste(f([RULE, '❯\u00a0[Pasted text #1 +12 lines]', RULE]), '━━━ WMUX A2A ━━━')).toBe(true);
    expect(frameShowsPaste(f(['› [Pasted Content 4096 chars]', footer]), '━━━ WMUX A2A ━━━')).toBe(true);
  });

  it('the same words in the transcript above prove nothing', () => {
    const earlier = ['❯ wmux: A2A task t-1 is waiting', '⏺ [Pasted text #1 +12 lines]'];
    expect(frameShowsPaste(f([...earlier, RULE, '❯\u00a0my own draft', RULE]), 'wmux: A2A task t-1')).toBe(false);
    expect(frameShowsPaste(f([...earlier, RULE, '❯\u00a0my own draft', RULE]), '━━━ WMUX A2A ━━━')).toBe(false);
  });

  it('with no composer (a shell took over), only the cursor row counts', () => {
    const rows = ['user@host ~ % wmux: A2A task t-1 is', 'zsh: command not found: wmux:', 'user@host ~ % '];
    expect(frameShowsPaste(f(rows, rows, 2), 'wmux: A2A task t-1')).toBe(false);
    expect(frameShowsPaste(f(rows, rows, 0), 'wmux: A2A task t-1')).toBe(true);
    expect(frameShowsPaste(f(['user@host ~ % '], undefined, -1), 'x')).toBe(false);
    expect(frameShowsPaste(null, 'x')).toBe(false);
  });
});
