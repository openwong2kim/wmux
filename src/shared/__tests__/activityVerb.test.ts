import { describe, expect, it } from 'vitest';
import { parseActivity } from '../activityVerb';
import { summarizeActivity } from '../activitySummary';

describe('parseActivity', () => {
  it('reads each glyph summarizeActivity writes back as a verb and its target', () => {
    const cases: [string, unknown, string, string][] = [
      ['Edit', { file_path: '/repo/src/foo.ts' }, 'edited', 'foo.ts'],
      ['Bash', { command: 'npm test' }, 'ran', 'npm test'],
      ['Read', { file_path: 'C:\\repo\\x.ts' }, 'read', 'x.ts'],
      ['Grep', { pattern: 'TODO' }, 'searched', 'TODO'],
      ['Task', { description: 'review the diff' }, 'delegated', 'review the diff'],
      ['Skill', { skill: 'qa' }, 'skill', '/qa'],
      ['WebFetch', { url: 'https://example.com/a' }, 'browsed', 'example.com'],
      ['mcp__wmux__pane_list', {}, 'called', 'wmux:pane_list'],
      ['TodoWrite', {}, 'used', 'TodoWrite'],
    ];
    for (const [tool, input, verb, target] of cases) {
      expect(parseActivity(summarizeActivity(tool, input)), tool).toEqual({ verb, target });
    }
  });

  it('returns null for an empty line or a bare glyph', () => {
    expect(parseActivity('')).toBeNull();
    expect(parseActivity('   ')).toBeNull();
    expect(parseActivity(undefined)).toBeNull();
    expect(parseActivity('✎ ')).toBeNull();
  });
});
