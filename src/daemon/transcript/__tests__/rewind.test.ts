import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { transcriptLineLink } from '../parseEntry';
import { analyzeRewinds, type EntryLink } from '../rewind';

const FIXTURES = path.join(__dirname, 'fixtures');

function linksOf(name: string): EntryLink[] {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n')
    .map((line, i) => transcriptLineLink(line, i))
    .filter((link): link is EntryLink => link !== undefined);
}

const link = (uuid: string, parentUuid?: string, extra: Partial<EntryLink> = {}): EntryLink =>
  ({ uuid, ...(parentUuid ? { parentUuid } : {}), prompt: false, ...extra });

describe('analyzeRewinds', () => {
  it('abandons the earlier prompt and everything under it when a sibling prompt arrives', () => {
    const { abandoned, rewinds } = analyzeRewinds(linksOf('rewind.jsonl'));
    expect([...abandoned].sort()).toEqual(['a2', 'a3', 'r2', 'u2']);
    expect([...rewinds]).toEqual(['u3']);
  });

  it('keeps a long chain whole across both compact-boundary shapes and a parallel tool fork', () => {
    expect(analyzeRewinds(linksOf('compact-chain.jsonl'))).toEqual({ abandoned: new Set(), rewinds: new Set() });
  });

  it('follows a backward logicalParentUuid into an abandoned run', () => {
    const { abandoned } = analyzeRewinds([
      link('p', undefined, { prompt: true }),
      link('a', 'p'),
      link('e', 'a', { prompt: true }),
      link('e1', 'e'),
      link('b', undefined, { logicalParentUuid: 'e1' }),
      link('s', 'b'),
      link('e2', 's', { prompt: true }),
      link('h', 'a', { prompt: true }),
    ]);
    expect([...abandoned].sort()).toEqual(['b', 'e', 'e1', 'e2', 's']);
  });

  it('never loops on a forward logicalParentUuid', () => {
    const { abandoned } = analyzeRewinds([
      link('p', undefined, { prompt: true }),
      link('a', 'p'),
      link('e', 'a', { prompt: true }),
      // Points at an entry written after it, whose chain leads back to it.
      link('b', undefined, { logicalParentUuid: 'x' }),
      link('x', 'b'),
      link('h', 'a', { prompt: true }),
    ]);
    // The boundary has no proven link to the abandoned prompt: it stays.
    expect([...abandoned]).toEqual(['e']);
  });

  it('is no rewind when the parent\'s earlier child is not a prompt (a parallel tool call)', () => {
    expect(analyzeRewinds([link('a'), link('t', 'a'), link('u', 'a', { prompt: true })]).abandoned.size).toBe(0);
  });

  it('does not see a rewind to the first message: both prompts have no parent', () => {
    expect(analyzeRewinds([link('u1', undefined, { prompt: true }), link('a1', 'u1'), link('u2', undefined, { prompt: true })]).abandoned.size).toBe(0);
  });

  it('gives a subagent (sidechain) entry no link, so it never counts as a rewind', () => {
    const line = JSON.stringify({ type: 'user', uuid: 's1', parentUuid: 'a1', isSidechain: true, message: { role: 'user', content: 'task' } });
    expect(transcriptLineLink(line, 0)).toBeUndefined();
  });
});
