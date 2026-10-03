import { describe, expect, it } from 'vitest';
import type { OrchestratorRoleBindings } from '../orchestratorRole';
import { TOKEN_PROFILES, applyTokenProfile, matchTokenProfile, tokenProfileChanges } from '../tokenProfiles';

// Planner claude, Builder+Tester agy (one pane), Reviewer codex.
const BOUND: OrchestratorRoleBindings = {
  Planner: { agent: 'claude', model: 'claude-opus-5-5', effort: 'high', skipPermissions: true },
  Builder: { agent: 'agy', model: 'gemini-3.8-flash-high', skipPermissions: true, args: '--foo' },
  Tester: { agent: 'agy', model: 'gemini-3.7-flash-high' },
  Reviewer: { agent: 'codex', model: 'gpt-6-sol', effort: 'high' },
};

describe('token profiles', () => {
  it('offers Full, Coding, Balanced and Minimal', () => {
    expect([...TOKEN_PROFILES]).toEqual(['full', 'coding', 'balanced', 'minimal']);
  });

  it('minimal: lowest effort, role tools, never touches permissions or args', () => {
    const next = applyTokenProfile(BOUND, 'minimal');
    expect(next.Planner).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', skipPermissions: true, tools: 'role' });
    expect(next.Builder).toEqual({ agent: 'agy', model: 'gemini-3.8-flash-low', skipPermissions: true, args: '--foo', tools: 'role' });
    expect(next.Tester).toEqual({ agent: 'agy', model: 'gemini-3.7-flash-low', tools: 'role' });
    expect(next.Reviewer).toEqual({ agent: 'codex', model: 'gpt-6-sol', effort: 'low', tools: 'role' });
  });

  it('full: best Claude model, high effort, every wmux tool', () => {
    const next = applyTokenProfile(BOUND, 'full');
    expect(next.Planner).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', tools: 'full' });
    expect(next.Builder).toMatchObject({ model: 'gemini-3.8-flash-high', tools: 'full' });
  });

  it('coding: no browser tools (core); balanced: role tools with cheaper checkers', () => {
    expect(applyTokenProfile(BOUND, 'coding').Reviewer).toMatchObject({ effort: 'medium', tools: 'core' });
    const balanced = applyTokenProfile(BOUND, 'balanced');
    expect(balanced.Planner).toMatchObject({ effort: 'medium', tools: 'role' });
    expect(balanced.Tester).toMatchObject({ model: 'gemini-3.7-flash-low', tools: 'role' });
  });

  it('works for any agent a role is bound to, and gives a custom role core instead of role tools', () => {
    const other: OrchestratorRoleBindings = {
      Reviewer: { agent: 'claude', model: 'opus' },
      Tester: { agent: 'codex' },
      Docs: { agent: 'claude' },
      Shell: { agent: 'opencode', args: '-x' },
    };
    const next = applyTokenProfile(other, 'minimal');
    expect(next.Reviewer).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low', tools: 'role' });
    expect(next.Tester).toMatchObject({ effort: 'low', tools: 'role' });
    expect(next.Docs.tools).toBe('core');
    expect(next.Shell).toEqual({ agent: 'opencode', args: '-x', tools: 'core' });
  });

  it('an agy non-Flash family moves to the default Flash and carries no separate effort', () => {
    const next = applyTokenProfile({ Builder: { agent: 'agy', model: 'gemini-3.1-pro-high', effort: 'high' } }, 'coding');
    expect(next.Builder).toEqual({ agent: 'agy', model: 'gemini-3.8-flash-medium', tools: 'core' });
  });

  it('matchTokenProfile derives the profile from the bindings, else custom', () => {
    expect(matchTokenProfile(BOUND)).toBe('custom');
    for (const p of TOKEN_PROFILES) expect(matchTokenProfile(applyTokenProfile(BOUND, p))).toBe(p);
    const edited = { ...applyTokenProfile(BOUND, 'minimal'), Reviewer: { agent: 'codex', model: 'gpt-6-sol', effort: 'xhigh', tools: 'role' as const } };
    expect(matchTokenProfile(edited)).toBe('custom');
    expect(matchTokenProfile({})).toBe('custom');
  });

  it('tokenProfileChanges lists only the roles that would change', () => {
    expect(tokenProfileChanges(applyTokenProfile(BOUND, 'minimal'), 'minimal')).toEqual([]);
    expect(tokenProfileChanges(BOUND, 'minimal').map((c) => c.role)).toEqual(['Planner', 'Builder', 'Tester', 'Reviewer']);
  });
});
