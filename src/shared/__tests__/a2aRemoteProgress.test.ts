import { describe, expect, it } from 'vitest';
import { A2A_REMOTE_PROGRESS_FILES_MAX, parseA2aRemoteProgress, parseA2aRemoteStatus } from '../a2aRemote';

describe('a status\'s worktree progress', () => {
  const progress = { head: 'abc1234def56', committedAt: '2026-11-24T01:00:00.000Z', changedFiles: 3 };

  it('round-trips with the status; a status from an older PC has none', () => {
    expect(parseA2aRemoteStatus({ kind: 'working', since: '2026-11-24T01:00:00Z', detail: { progress } })).toEqual({
      kind: 'working', since: '2026-11-24T01:00:00.000Z', detail: { progress },
    });
    expect(parseA2aRemoteStatus({ kind: 'working', since: '2026-11-24T01:00:00Z' })).toEqual({ kind: 'working', since: '2026-11-24T01:00:00.000Z' });
  });

  it('is strict: a sha, a whole count (capped), and a commit time only when it is one', () => {
    expect(parseA2aRemoteProgress({ head: 'abc1234', changedFiles: 0, committedAt: 'yesterday' })).toEqual({ head: 'abc1234', changedFiles: 0 });
    expect(parseA2aRemoteProgress({ head: 'abc1234', changedFiles: 10 ** 9 })?.changedFiles).toBe(A2A_REMOTE_PROGRESS_FILES_MAX);
    for (const bad of [null, [], { head: 'ABC1234', changedFiles: 1 }, { head: 'abc12', changedFiles: 1 }, { head: 'abc1234def567', changedFiles: 1 }, { head: 'abc1234', changedFiles: 1.5 }, { head: 'abc1234', changedFiles: '1' }]) {
      expect(parseA2aRemoteProgress(bad)).toBeNull();
    }
    // A bad progress leaves the rest of the status as it is.
    expect(parseA2aRemoteStatus({ kind: 'working', since: '2026-11-24T01:00:00Z', detail: { background: 1, progress: { head: 'x' } } })?.detail).toEqual({ background: 1 });
  });
});
