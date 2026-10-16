import { describe, it, expect } from 'vitest';
import { ClaudeTitleTurnEdge, sanitizeTitle, TERMINAL_TITLE_MAX } from '../titleDetect';

describe('sanitizeTitle', () => {
  it('keeps a normal title unchanged', () => {
    expect(sanitizeTitle('my-session')).toBe('my-session');
  });

  it('strips control chars (CR/LF/TAB/BEL/C1) and collapses whitespace', () => {
    expect(sanitizeTitle('a\r\nb\tc\x07d\x9ae')).toBe('a b c d e');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeTitle('  spaced  ')).toBe('spaced');
  });

  it('caps length at TERMINAL_TITLE_MAX', () => {
    const long = 'x'.repeat(TERMINAL_TITLE_MAX + 50);
    expect(sanitizeTitle(long)).toHaveLength(TERMINAL_TITLE_MAX);
  });

  it('returns empty string for control-only or empty input', () => {
    expect(sanitizeTitle('\x07\x1b\x00')).toBe('');
    expect(sanitizeTitle('')).toBe('');
  });
});

describe('ClaudeTitleTurnEdge (#2264)', () => {
  it('reports the idle title, and not the running ones', () => {
    const edge = new ClaudeTitleTurnEdge();
    expect(edge.observe('◐ 50번째 소수 검증')).toBe(false);
    expect(edge.observe('◑ 50번째 소수 검증')).toBe(false);
    expect(edge.observe('✳ 50번째 소수 검증')).toBe(true);
  });

  it('reports an idle title with no running title before it (an Esc in the first second)', () => {
    // Live: Esc 300 ms after the submit, before the first running title.
    expect(new ClaudeTitleTurnEdge().observe('✳ Claude Code')).toBe(true);
  });

  it('reads only the leading glyph', () => {
    const edge = new ClaudeTitleTurnEdge();
    expect(edge.observe('notes ✳ draft')).toBe(false);
    expect(edge.observe('bash')).toBe(false);
  });
});

describe('ClaudeTitleTurnEdge: a turn that ran its Stop hooks ended on its own', () => {
  it('does not report the idle title that follows the Stop-hook row', () => {
    const edge = new ClaudeTitleTurnEdge();
    edge.observe('◐ 50번째 소수 검증');
    edge.noteOutput('\u001b[38;2;153;153;153m\u001b[2Crunning Stop hook · 3s · \u001b[m');
    // A running title can tick between the row and the idle title.
    edge.observe('◑ 50번째 소수 검증');
    expect(edge.observe('✳ 50번째 소수 검증')).toBe(false);
    // The next turn starts clean.
    edge.observe('◐ 50번째 소수 검증');
    expect(edge.observe('✳ 50번째 소수 검증')).toBe(true);
  });
});

describe('ClaudeTitleTurnEdge: what counts as the Stop-hook row', () => {
  it('matches the row split across two reads', () => {
    const edge = new ClaudeTitleTurnEdge();
    edge.noteOutput('\u001b[2Crunning Sto');
    edge.noteOutput('p hook · 3s · \u001b[m');
    expect(edge.observe('✳ Claude Code')).toBe(false);
  });

  it('does not take conversation text about Stop hooks for the row', () => {
    const edge = new ClaudeTitleTurnEdge();
    edge.noteOutput('● The Stop hook in settings.json runs after every turn.');
    expect(edge.observe('✳ Claude Code')).toBe(true);
  });
});
