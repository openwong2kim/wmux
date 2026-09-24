/**
 * Agent kind on roster rows: no identity glyph; Claude (the default) is
 * unmarked and any other agent names itself in muted text. A source scan in
 * the house style of the roster guards next to it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rosterSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/Sidebar/WorkspaceAgentRoster.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('roster agent kind', () => {
  it('draws no monogram glyph anywhere in the roster', () => {
    expect(rosterSource).not.toContain('AgentGlyph');
    expect(rosterSource).not.toContain('data-agent-glyph');
  });

  it('names only non-Claude agents, in muted text', () => {
    expect(rosterSource).toMatch(/row\.slug && row\.slug !== 'claude' && \(/);
    const at = rosterSource.indexOf('data-roster-agent-kind');
    expect(at).toBeGreaterThan(-1);
    const tag = rosterSource.slice(rosterSource.lastIndexOf('<span', at), at);
    expect(tag).toContain('text-[var(--text-muted)]');
  });

  it('the collapsed summary counts each status group instead of drawing glyphs', () => {
    expect(rosterSource).toContain('<span>{group.length}</span>');
  });
});
