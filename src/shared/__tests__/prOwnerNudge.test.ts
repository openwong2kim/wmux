import { describe, it, expect } from 'vitest';
import { buildCallerNudge, isCallerNudge, prNumbersInNudge } from '../prOwnerNudge';

describe('PR owner nudge template', () => {
  it('builds one clause per PR event, most severe first, and caps them', () => {
    expect(buildCallerNudge([], [
      { prNumber: 12, kind: 'pr.checks_passed' },
      { prNumber: 12, kind: 'pr.merge_conflict' },
    ])).toBe('[wmux] PR #12: merge conflict — gh pr view 12; PR #12: checks passed, ready for review — gh pr view 12');
    const many = [1, 2, 3, 4, 5, 6].map((n) => ({ prNumber: n, kind: 'pr.ci_failed' as const }));
    expect(buildCallerNudge([], many)).toMatch(/; \+2 more PR events$/);
  });

  it('a fan-out-only line is exactly the fan-out template', () => {
    expect(buildCallerNudge([{ taskId: 'wtask-x-aaaa1111', kind: 'agent.stop' }], [])).toBe(
      '[wmux] fan-out task aaaa1111 updated — channel_mission_list',
    );
  });

  it('accepts exactly what the builder makes and names its PRs', () => {
    const built = buildCallerNudge([{ taskId: 'wtask-x-aaaa1111', kind: 'ledger.failed' }], [{ prNumber: 9, kind: 'pr.review_comment' }]);
    expect(isCallerNudge(built)).toBe(true);
    expect(prNumbersInNudge(built)).toEqual([9]);
    expect(isCallerNudge(`${built}\r`)).toBe(false);
    expect(isCallerNudge('[wmux] PR #9: CI failed — gh pr checks 9; see the log: npm ERR!')).toBe(false);
    expect(isCallerNudge('[wmux] PR #9: CI failed by alice — gh pr checks 9')).toBe(false);
    expect(isCallerNudge('[wmux] PR #09: CI failed — gh pr checks 09')).toBe(false);
    expect(prNumbersInNudge('PR #5: anything')).toEqual([]);
  });
});
