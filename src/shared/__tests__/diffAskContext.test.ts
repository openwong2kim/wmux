// diff→orchestrator question context block assembly — field, fencing, and cap contract.
import { describe, it, expect } from 'vitest';
import { buildDiffAskContext, DIFF_ASK_CONTEXT_CAP } from '../diffAskContext';

const base = {
  repoLabel: 'D:/proj/repo',
  branch: 'feat/x',
  file: 'src/a.ts',
  hunkHeader: '@@ -1,3 +1,4 @@',
  hunkBody: ' line1\n+added\n line2',
  question: 'Is this change safe?',
};

describe('buildDiffAskContext', () => {
  it('includes repo·branch·file·hunk headers and wraps hunk body in ```diff fence', () => {
    const out = buildDiffAskContext(base);
    expect(out).toContain('[diff question]');
    expect(out).toContain('repo: D:/proj/repo');
    expect(out).toContain('branch: feat/x');
    expect(out).toContain('file: src/a.ts');
    expect(out).toContain('hunk: @@ -1,3 +1,4 @@');
    expect(out).toContain('```diff\n line1\n+added\n line2\n```');
    expect(out.trim().endsWith('Is this change safe?')).toBe(true);
  });

  it('omits branch·hunk lines when empty; omits fence when body absent', () => {
    const out = buildDiffAskContext({ ...base, branch: '', hunkHeader: '', hunkBody: '' });
    expect(out).not.toContain('branch:');
    expect(out).not.toContain('hunk:');
    expect(out).not.toContain('```');
  });

  it('omits entire hunk body when over cap (no partial truncate) — path·headers·question kept', () => {
    const out = buildDiffAskContext({ ...base, hunkBody: 'x'.repeat(DIFF_ASK_CONTEXT_CAP + 100) });
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(DIFF_ASK_CONTEXT_CAP);
    expect(out).not.toContain('xxx');
    expect(out).toContain('hunk body omitted');
    expect(out).toContain('file: src/a.ts');
    expect(out).toContain('Is this change safe?');
  });

  it('fence does not terminate early when hunk contains ``` line (Codex P2)', () => {
    const out = buildDiffAskContext({ ...base, hunkBody: ' before\n+```\n after' });
    // Must wrap with a fence longer than ``` in the body (````).
    expect(out).toContain('````diff\n before\n+```\n after\n````');
  });

  it('after body omission, still over cap (large question) → final byte cap truncate (Codex P3)', () => {
    const out = buildDiffAskContext({
      ...base,
      hunkBody: 'x'.repeat(100),
      question: 'q'.repeat(DIFF_ASK_CONTEXT_CAP + 5000),
    });
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(DIFF_ASK_CONTEXT_CAP);
  });
});
