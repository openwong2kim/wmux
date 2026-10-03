import { describe, expect, it } from 'vitest';
import { selectGitRailSignal } from '../gitSignal';
import type { PrStatus } from '../../../../shared/types';

const state = (...prs: (Partial<PrStatus> | null)[]) => ({
  workspaces: prs.map((pr, i) => ({ id: `w${i}`, metadata: pr ? { pr: { number: i, url: 'u', checks: null, state: 'open', ...pr } } : {} })),
}) as never;

describe('selectGitRailSignal', () => {
  it('lights for an open or draft PR that fails its checks or conflicts', () => {
    expect(selectGitRailSignal(state({ checks: 'failing' }))).toBe(true);
    expect(selectGitRailSignal(state({ state: 'draft', conflicting: true }))).toBe(true);
    expect(selectGitRailSignal(state({ checks: 'passing' }, null))).toBe(false);
  });
  it('stays dark for a merged or closed PR, whatever its last run said', () => {
    expect(selectGitRailSignal(state({ state: 'merged', checks: 'failing' }))).toBe(false);
    expect(selectGitRailSignal(state({ state: 'closed', conflicting: true }))).toBe(false);
  });
});
