import { describe, expect, it } from 'vitest';
import { activeProviders } from '../activeProviders';
import type { OrchestratorRoleBindings } from '../orchestratorRole';

describe('activeProviders', () => {
  it.each([
    {
      name: 'returns all three when bindings is undefined',
      bindings: undefined,
      expected: ['claude', 'codex', 'agy'],
    },
    {
      name: 'returns all three when bindings is null',
      bindings: null,
      expected: ['claude', 'codex', 'agy'],
    },
    {
      name: 'returns all three when bindings is empty object',
      bindings: {},
      expected: ['claude', 'codex', 'agy'],
    },
    {
      name: 'returns empty when role bindings have no agent specified',
      bindings: { Builder: { model: 'haiku' } },
      expected: [],
    },
    {
      name: 'extracts single claude binding',
      bindings: { Builder: { agent: 'claude' } },
      expected: ['claude'],
    },
    {
      name: 'extracts single codex binding',
      bindings: { Reviewer: { agent: 'codex' } },
      expected: ['codex'],
    },
    {
      name: 'extracts single agy binding',
      bindings: { Tester: { agent: 'agy' } },
      expected: ['agy'],
    },
    {
      name: 'preserves fixed order (claude, codex, agy) regardless of role order',
      bindings: {
        Tester: { agent: 'agy' },
        Builder: { agent: 'codex' },
        Planner: { agent: 'claude' },
      },
      expected: ['claude', 'codex', 'agy'],
    },
    {
      name: 'deduplicates distinct agents bound to multiple roles',
      bindings: {
        Builder: { agent: 'agy' },
        Tester: { agent: 'agy' },
      },
      expected: ['agy'],
    },
    {
      name: 'restricts agents to claude, codex, agy and ignores unrecognised or other agents',
      bindings: {
        Builder: { agent: 'opencode' },
        Tester: { agent: 'gemini' },
        Reviewer: { agent: 'codex' },
      },
      expected: ['codex'],
    },
    {
      name: 'returns empty when only other agents are bound',
      bindings: {
        Builder: { agent: 'opencode' },
      },
      expected: [],
    },
    {
      name: 'handles whitespace around agent names',
      bindings: {
        Builder: { agent: '  claude  ' },
        Tester: { agent: 'agy' },
      },
      expected: ['claude', 'agy'],
    },
  ])('$name', ({ bindings, expected }) => {
    expect(activeProviders(bindings as OrchestratorRoleBindings)).toEqual(expected);
  });
});
