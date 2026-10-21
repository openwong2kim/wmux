// laneGh.squashMergeEffect: the executor's gate reaches the GitHub merge, so
// the merge asks it right before it writes. A GitLab key goes to glab for the
// read, the merge and the login; its branch is never updated by the lane.
import { describe, expect, it, vi } from 'vitest';

const merge = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
const ghLane = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, value: { number: 7 } }));
const updateBranch = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
vi.mock('../../github/GhPrReviewService', () => ({
  ghPrReviewService: {
    checks: vi.fn(async () => ({ ok: true, value: { head: { title: 'feat: x' } } })),
    merge: (...args: unknown[]) => merge(...args),
    laneFacts: (...args: unknown[]) => ghLane(...args),
    updateBranch: (...args: unknown[]) => updateBranch(...args),
  },
}));
const glabMerge = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
const glabLane = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, value: { number: 9 } }));
const glabLogin = vi.fn(async (..._args: unknown[]) => 'alice');
vi.mock('../../github/GlabPrService', () => ({
  glabPrService: {
    merge: (...args: unknown[]) => glabMerge(...args),
    laneFacts: (...args: unknown[]) => glabLane(...args),
    currentLogin: (...args: unknown[]) => glabLogin(...args),
  },
}));
vi.mock('../../deck/taskLedgerHost', () => ({ getTaskLedger: vi.fn() }));
vi.mock('../../workspace/WorkspaceMirror', () => ({ getWorkspaceMirror: vi.fn() }));

import { currentGhLogin, freshLaneFacts, squashMergeEffect, updateBranchEffect } from '../laneGh';

describe('squashMergeEffect', () => {
  it('hands the executor gate to the merge', async () => {
    const gate = (): string | null => 'revoked';
    const effect = { repoPath: '/r', repoKey: 'github.com/a/b', prNumber: 7, expectHead: 'a'.repeat(40) };
    await squashMergeEffect(effect as never, gate);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge.mock.calls[0][0]).toBe('/r');
    expect(merge.mock.calls[0][3]).toMatchObject({ expectHead: 'a'.repeat(40), subject: 'feat: x (#7)', body: '' });
    expect(merge.mock.calls[0][4]).toBe(gate);
  });
});

describe('a GitLab repository', () => {
  const GL = 'gitlab.example.com/group/proj';
  const effect = { repoPath: '/r', repoKey: GL, prNumber: 9, expectHead: 'b'.repeat(40) };

  it('merges with glab at the expected head, with the executor gate', async () => {
    merge.mockClear();
    const gate = (): string | null => null;
    await squashMergeEffect(effect as never, gate);
    expect(merge).not.toHaveBeenCalled();
    expect(glabMerge).toHaveBeenCalledWith('/r', GL, 9, { expectHead: 'b'.repeat(40), subject: '', body: '' }, gate);
  });

  it('reads the lane facts and the login with glab; GitHub keys stay on gh', async () => {
    expect(await freshLaneFacts.readFresh('/r', GL, 9)).toEqual({ number: 9 });
    expect(glabLane).toHaveBeenCalledWith('/r', GL, 9);
    expect(await freshLaneFacts.readFresh('/r', 'github.com/a/b', 7)).toEqual({ number: 7 });
    expect(ghLane).toHaveBeenCalledWith('/r', 'github.com/a/b', 7);
    expect(await currentGhLogin({ key: GL, path: '/r' })).toBe('alice');
    expect(glabLogin).toHaveBeenCalledWith('/r', GL);
  });

  it('the lane does not update a GitLab branch', async () => {
    expect(await updateBranchEffect(effect as never)).toMatchObject({ ok: false, code: 'invalid' });
    expect(updateBranch).not.toHaveBeenCalled();
    await updateBranchEffect({ ...effect, repoKey: 'github.com/a/b' } as never);
    expect(updateBranch).toHaveBeenCalledTimes(1);
  });
});
