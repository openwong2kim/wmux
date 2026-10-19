import { describe, expect, it } from 'vitest';
import { AWAITING_TITLE, CLAUDE_IDLE_TITLE, CLAUDE_RUNNING_TITLE, CLAUDE_RUNNING_TITLE_OSC, CODEX_AWAITING_TITLE, CODEX_RUNNING_TITLE, RUNNING_TITLE } from '../agentTitleRules';

describe('agent title rules', () => {
  it("reads Claude Code's spinner and idle titles", () => {
    expect(CLAUDE_RUNNING_TITLE.test('◐ Claude Code')).toBe(true);
    expect(CLAUDE_RUNNING_TITLE.test('◑ fix the build')).toBe(true);
    expect(CLAUDE_RUNNING_TITLE.test('✳ Claude Code')).toBe(false);
    expect(CLAUDE_IDLE_TITLE.test('✳ Claude Code')).toBe(true);
    expect(CLAUDE_IDLE_TITLE.test('◐ Claude Code')).toBe(false);
    expect(CLAUDE_RUNNING_TITLE_OSC.test('\x1b]0;◐ Claude Code\x07')).toBe(true);
    expect(CLAUDE_RUNNING_TITLE_OSC.test('\x1b]2;◑ Claude Code\x1b\\')).toBe(true);
    expect(CLAUDE_RUNNING_TITLE_OSC.test('\x1b]1;◐ Claude Code\x07')).toBe(false);
  });

  it("reads Codex's braille frame and nothing else", () => {
    expect(CODEX_RUNNING_TITLE.test('⠙ codex | ~/repo')).toBe(true);
    expect(CODEX_RUNNING_TITLE.test('codex | ~/repo')).toBe(false);
    expect(CODEX_RUNNING_TITLE.test('◐ Claude Code')).toBe(false);
  });

  it('has a running title for claude and codex only', () => {
    expect([...RUNNING_TITLE.keys()]).toEqual(['claude', 'codex']);
    expect(RUNNING_TITLE.get('constructor')).toBeUndefined();
  });

  it("reads Codex's approval title, blinking or not, and never as running", () => {
    expect(CODEX_AWAITING_TITLE.test('[ ! ] Action Required | Create hello.txt | work')).toBe(true);
    expect(CODEX_AWAITING_TITLE.test('[ . ] Action Required | ⠹ | work')).toBe(true);
    expect(CODEX_AWAITING_TITLE.test('⠙ Action Required | work')).toBe(false);
    expect(CODEX_AWAITING_TITLE.test('fix [ ! ] Action Required')).toBe(false);
    expect(CODEX_RUNNING_TITLE.test('[ ! ] Action Required | ⠹ | work')).toBe(false);
    expect([...AWAITING_TITLE.keys()]).toEqual(['codex']);
  });
});
