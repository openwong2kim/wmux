import { describe, expect, it } from 'vitest';
import { normalizeForPromptMatch } from '../promptMatch';

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
