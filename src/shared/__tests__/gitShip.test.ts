import { describe, it, expect } from 'vitest';
import { shipState, shipBlock, type ShipInput } from '../gitShip';
import { prNextStep } from '../prNextStep';

const base: ShipInput = {
  dirty: 0,
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  detached: false,
  onDefaultBranch: false,
  pr: null,
  mergeActive: false,
};
const s = (over: Partial<ShipInput>): ShipInput => ({ ...base, ...over });
const openPr = { state: 'open' as const, url: 'https://github.com/o/r/pull/1' };

describe('shipState: the button follows the branch', () => {
  it('uncommitted changes → Commit', () => {
    expect(shipState(s({ dirty: 3 })).primary).toEqual({ action: 'commit', blocked: null });
  });

  it('committed, not pushed → Push', () => {
    expect(shipState(s({ ahead: 2 })).primary).toEqual({ action: 'push', blocked: null });
  });

  it('pushed, no PR → Create PR', () => {
    expect(shipState(s({})).primary).toEqual({ action: 'createPr', blocked: null });
  });

  it('a PR open (or draft) → Open PR', () => {
    expect(shipState(s({ pr: openPr })).primary).toEqual({ action: 'openPr', blocked: null });
    expect(shipState(s({ pr: { ...openPr, state: 'draft' } })).primary.action).toBe('openPr');
  });

  it('a merged PR with nothing new → Open PR, with Create PR in the menu', () => {
    const st = shipState(s({ pr: { ...openPr, state: 'merged' } }));
    expect(st.primary).toEqual({ action: 'openPr', blocked: null });
    expect(st.menu).toEqual(['createPr']);
  });

  it('walks the whole path: Commit → Push → Create PR → Open PR', () => {
    const steps = [
      s({ dirty: 1 }),
      s({ ahead: 1 }),
      s({}),
      s({ pr: openPr }),
    ].map((x) => shipState(x).primary.action);
    expect(steps).toEqual(['commit', 'push', 'createPr', 'openPr']);
  });

  it('new commits on a branch whose PR is open → Push, then Open PR', () => {
    expect(shipState(s({ ahead: 1, pr: openPr })).primary.action).toBe('push');
    expect(shipState(s({ pr: openPr })).primary.action).toBe('openPr');
  });
});

describe('shipState: the menu holds the other steps that can run', () => {
  it('dirty and ahead with a PR: Push and Open PR beside Commit', () => {
    expect(shipState(s({ dirty: 1, ahead: 1, pr: openPr })).menu).toEqual(['push', 'openPr']);
  });

  it('dirty, nothing ahead, no PR: Create PR beside Commit', () => {
    expect(shipState(s({ dirty: 1 })).menu).toEqual(['createPr']);
  });

  it('never repeats the primary step', () => {
    const st = shipState(s({ ahead: 1 }));
    expect(st.menu).not.toContain('push');
  });
});

describe('shipState: blocked steps say why', () => {
  it('a merge session blocks everything', () => {
    const st = shipState(s({ dirty: 1, ahead: 1, pr: openPr, mergeActive: true }));
    expect(st.primary).toEqual({ action: 'commit', blocked: 'merge-active' });
    expect(st.menu).toEqual([]);
  });

  it('no upstream blocks Push and Create PR, not a local Commit', () => {
    expect(shipState(s({ ahead: 1, hasUpstream: false })).primary).toEqual({ action: 'push', blocked: 'no-upstream' });
    expect(shipState(s({ hasUpstream: false })).primary).toEqual({ action: 'createPr', blocked: 'no-upstream' });
    expect(shipState(s({ dirty: 1, hasUpstream: false })).primary).toEqual({ action: 'commit', blocked: null });
  });

  it('behind the upstream blocks Push (it would be rejected)', () => {
    expect(shipState(s({ ahead: 1, behind: 2 })).primary).toEqual({ action: 'push', blocked: 'behind' });
  });

  it('a detached HEAD blocks Commit, Push and Create PR', () => {
    expect(shipState(s({ dirty: 1, detached: true })).primary.blocked).toBe('detached');
    expect(shipState(s({ detached: true })).primary.blocked).toBe('detached');
  });

  it('the default branch cannot open a PR', () => {
    expect(shipState(s({ onDefaultBranch: true })).primary).toEqual({ action: 'createPr', blocked: 'default-branch' });
  });

  it('shipBlock: Open PR needs a PR, Commit needs changes', () => {
    expect(shipBlock('openPr', base)).toBe('nothing-to-ship');
    expect(shipBlock('commit', base)).toBe('nothing-to-ship');
    expect(shipBlock('push', base)).toBe('nothing-to-ship');
  });
});

describe('prNextStep', () => {
  const pr = { state: 'open' as const, checks: null, mergeable: '', reviewDecision: '' };
  it('words each state, the most blocking first', () => {
    expect(prNextStep({ ...pr, state: 'merged' })).toBe('merged');
    expect(prNextStep({ ...pr, state: 'closed' })).toBe('closed');
    expect(prNextStep({ ...pr, state: 'draft', checks: 'failing' })).toBe('draft');
    expect(prNextStep({ ...pr, checks: 'failing', mergeable: 'CONFLICTING' })).toBe('ci-failing');
    expect(prNextStep({ ...pr, mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' })).toBe('conflicts');
    expect(prNextStep({ ...pr, reviewDecision: 'CHANGES_REQUESTED', checks: 'pending' })).toBe('changes-requested');
    expect(prNextStep({ ...pr, checks: 'pending', reviewDecision: 'REVIEW_REQUIRED' })).toBe('ci-running');
    expect(prNextStep({ ...pr, reviewDecision: 'REVIEW_REQUIRED', checks: 'passing' })).toBe('review-requested');
    expect(prNextStep({ ...pr, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', checks: 'passing' })).toBe('approved-mergeable');
    expect(prNextStep({ ...pr, reviewDecision: 'APPROVED', mergeable: 'UNKNOWN' })).toBe('approved');
    expect(prNextStep(pr)).toBe('open');
  });
});
