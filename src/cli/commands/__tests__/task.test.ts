// #3068: `wmux task cancel` builds the same a2a.task.cancel call as the tool.
import { describe, expect, it } from 'vitest';
import { buildTaskCancelParams, formatBulkResult } from '../task';

describe('buildTaskCancelParams', () => {
  it('ids, or a state with an age, with --dry-run and --reason', () => {
    expect(buildTaskCancelParams(['t1', 't2', '--dry-run'])).toEqual({ taskIds: ['t1', 't2'], dryRun: true });
    expect(buildTaskCancelParams(['--state', 'submitted', '--older-than-days', '3', '--reason', 'stale'])).toEqual({
      state: 'submitted',
      olderThanDays: 3,
      reason: 'stale',
    });
  });

  it('refuses a mixed, incomplete or empty selection', () => {
    expect(buildTaskCancelParams(['t1', '--state', 'submitted', '--older-than-days', '1'])).toHaveProperty('error');
    expect(buildTaskCancelParams(['--state', 'submitted'])).toHaveProperty('error');
    expect(buildTaskCancelParams(['--older-than-days', 'x', '--state', 'submitted'])).toHaveProperty('error');
    expect(buildTaskCancelParams([])).toHaveProperty('error');
    expect(buildTaskCancelParams(['--workspace', 'ws-b', 't1'])).toHaveProperty('error');
  });
});

describe('formatBulkResult', () => {
  it('one line per task and a count', () => {
    const out = formatBulkResult({ ok: true, dryRun: true, wouldCancel: ['t1'], refused: [{ taskId: 't2', error: 'no' }], unchanged: [] });
    expect(out.split('\n')).toEqual([
      'would cancel  t1',
      'refused       t2: no',
      '1 would be canceled (dry run, nothing changed), 1 refused, 0 unchanged',
    ]);
  });
});
