import { describe, expect, it } from 'vitest';
import { freshContextGrammarFor, LAUNCH_GRAMMAR_BY_AGENT } from '../agentLaunchOptions';

describe('fresh-context grammar (#1680)', () => {
  it('names the verified command and evidence per agent', () => {
    expect(freshContextGrammarFor('claude')).toEqual({ command: '/clear', evidence: 'session_start' });
    expect(freshContextGrammarFor('codex')).toEqual({ command: '/new', evidence: 'screen' });
  });

  it('has no command for agents nobody verified, and never guesses', () => {
    expect(freshContextGrammarFor('agy')).toBeUndefined();
    expect(freshContextGrammarFor('opencode')).toBeUndefined();
    expect(freshContextGrammarFor('gemini')).toBeUndefined();
    expect(freshContextGrammarFor(undefined)).toBeUndefined();
    // Own keys only.
    expect(freshContextGrammarFor('constructor')).toBeUndefined();
    expect(freshContextGrammarFor('toString')).toBeUndefined();
  });

  it('every command is a single slash token (typed into a composer as-is)', () => {
    for (const grammar of Object.values(LAUNCH_GRAMMAR_BY_AGENT)) {
      if (!grammar.freshContext) continue;
      expect(grammar.freshContext.command).toMatch(/^\/[a-z]+$/);
    }
  });
});
