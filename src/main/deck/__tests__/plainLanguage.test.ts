import { describe, expect, it } from 'vitest';
import { internalTermsIn, plainLanguageRefusal } from '../plainLanguage';

describe('plain language for the operator', () => {
  it('finds wmux tool names, raw field names and internal ids, and nothing in plain words', () => {
    expect(internalTermsIn('Ran mcp__wmux__terminal_read and a2a_task_query on task-95c64255 (workspaceId ws-d74dde4d-52ef)'))
      .toEqual(['mcp__wmux__terminal_read', 'a2a_task_query', 'workspaceId', 'task-95c64255', 'ws-d74dde4d-52ef']);
    expect(internalTermsIn('The agent in wmux wrote hi.txt; I opened it and it holds one line.')).toEqual([]);
    expect(plainLanguageRefusal(['All done, tests pass.'])).toBeNull();
    expect(plainLanguageRefusal(['ptyId gone'])).toMatchObject({ error: 'not_plain_language', terms: ['ptyId'] });
  });
});
