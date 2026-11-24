import { describe, expect, it } from 'vitest';
import { normalizeForPromptMatch, unwrapPastedContent } from '../promptMatch';

describe('normalizeForPromptMatch', () => {
  it('reads a prompt stored inside paste markers as the prompt itself (Claude Code 2.1.326)', () => {
    const prompt = 'Reply with PONG.\nThen run uname -s';
    const stored = `\n\n<pasted_content id="3de0">\n${prompt}\n</pasted_content id="3de0">\n`;
    expect(normalizeForPromptMatch(stored)).toBe(normalizeForPromptMatch(prompt));
  });

  it('ignores a line break the TUI put inside a word (2.1.289)', () => {
    expect(normalizeForPromptMatch('…blo\n</pasted_content id="bc9f">\n\ncked…')).toBe(normalizeForPromptMatch('…blocked…'));
  });

  it('keeps different text different, and leaves other tags alone', () => {
    expect(normalizeForPromptMatch('run the tests')).not.toBe(normalizeForPromptMatch('run the builds'));
    expect(normalizeForPromptMatch('<b>x</b>')).toBe('<b>x</b>');
  });
});

describe('unwrapPastedContent (what user_text shows)', () => {
  const wrap = (inner: string, id = '3de0') => `<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">`;

  it('removes a matched pair and the one line break inside each tag, keeping the inner text byte-exact', () => {
    expect(unwrapPastedContent(wrap('line one\nline two'))).toEqual({ text: 'line one\nline two', pasted: true });
  });

  it('keeps CRLF inside: only the \\n Claude Code writes next to each tag goes, never a \\r the user typed', () => {
    expect(unwrapPastedContent(wrap('a\r\nb\r\n')).text).toBe('a\r\nb\r\n');
    expect(unwrapPastedContent(wrap('ends in a carriage return\r')).text).toBe('ends in a carriage return\r');
    expect(unwrapPastedContent(wrap('\r\nstarts with CRLF')).text).toBe('\r\nstarts with CRLF');
  });

  it('keeps trailing spaces and a leading blank line inside the paste', () => {
    expect(unwrapPastedContent(wrap('\nfirst  \nsecond   ')).text).toBe('\nfirst  \nsecond   ');
  });

  it('keeps Korean multi-line text exactly', () => {
    const ko = '로그인 화면에서 비밀번호 칸이 비어 있으면\n제출 버튼을 막아 줘.\n\n테스트도 하나 추가해 줘.  ';
    expect(unwrapPastedContent(wrap(ko, '5a1c')).text).toBe(ko);
  });

  it('removes only one line break inside each tag, never more', () => {
    expect(unwrapPastedContent('<pasted_content id="ab12">\n\nx\n\n</pasted_content id="ab12">').text).toBe('\nx\n');
  });

  it('unwraps each pair in a message and leaves the typed text around them alone', () => {
    const text = `before ${wrap('one', 'aaaa')} middle ${wrap('two', 'bbbb')} after`;
    expect(unwrapPastedContent(text)).toEqual({ text: 'before one middle two after', pasted: true });
  });

  it('leaves an unmatched tag, a pair with different ids, or an id Claude Code does not write', () => {
    for (const text of [
      '<pasted_content id="3de0">\nno closing tag',
      'only a closing tag\n</pasted_content id="3de0">',
      '<pasted_content id="aaaa">\nx\n</pasted_content id="bbbb">',
      '<pasted_content id="my-id">\nx\n</pasted_content id="my-id">',
      'about <pasted_content> in general',
    ]) {
      expect(unwrapPastedContent(text)).toEqual({ text, pasted: false });
    }
  });
});
