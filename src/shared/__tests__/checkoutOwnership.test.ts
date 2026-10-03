// The containment case is adapted from MonoCode (hardbeat920/monocode@6bd432ca,
// src-tauri/src/control.rs — checkout_reservations_include_nested_folders),
// MIT License, Copyright (c) 2026 Nick.

import { describe, it, expect } from 'vitest';
import { comparisonPath, findForeignCheckoutOwner, isSameOrInside, type CheckoutOwnerTask } from '../checkoutOwnership';

const task = (over: Partial<CheckoutOwnerTask> = {}): CheckoutOwnerTask => ({
  id: 'wtask-1',
  title: 'Fix login',
  status: 'open',
  worktreePath: '/home/u/.wmux/worktrees/abc/fix-login',
  paneGroupId: 'ws-task',
  owner: { verifiedWorkspaceId: 'ws-orch' },
  ...over,
});

describe('isSameOrInside', () => {
  it('counts the checkout and folders nested in it, not siblings or parents', () => {
    expect(isSameOrInside('/repo', '/repo')).toBe(true);
    expect(isSameOrInside('/repo/src', '/repo')).toBe(true);
    expect(isSameOrInside('/repo2', '/repo')).toBe(false);
    expect(isSameOrInside('/', '/repo')).toBe(false);
  });

  it('folds case and separators only on Windows', () => {
    expect(comparisonPath('C:\\Work\\Repo\\', true)).toBe('c:/work/repo');
    expect(comparisonPath('/Work/Repo/', false)).toBe('/Work/Repo');
    expect(isSameOrInside(comparisonPath('C:\\WORK\\repo\\src', true), comparisonPath('c:\\work\\Repo', true))).toBe(true);
    expect(isSameOrInside(comparisonPath('/work/repo', false), comparisonPath('/Work/Repo', false))).toBe(false);
  });
});

describe('findForeignCheckoutOwner', () => {
  const tasks = [task()];
  it('flags an agent inside a task worktree from an unrelated workspace', () => {
    expect(findForeignCheckoutOwner('/home/u/.wmux/worktrees/abc/fix-login/src', 'ws-other', tasks, false)?.id).toBe('wtask-1');
  });

  it("exempts the task's own workspace and its orchestrator", () => {
    expect(findForeignCheckoutOwner('/home/u/.wmux/worktrees/abc/fix-login', 'ws-task', tasks, false)).toBeNull();
    expect(findForeignCheckoutOwner('/home/u/.wmux/worktrees/abc/fix-login', 'ws-orch', tasks, false)).toBeNull();
  });

  it('ignores closed tasks, unmaterialized tasks and the home folder above every worktree', () => {
    expect(findForeignCheckoutOwner('/home/u/.wmux/worktrees/abc/fix-login', 'ws-other', [task({ status: 'closed' })], false)).toBeNull();
    expect(findForeignCheckoutOwner('/home/u/.wmux/worktrees/abc/fix-login', 'ws-other', [task({ paneGroupId: undefined })], false)).toBeNull();
    expect(findForeignCheckoutOwner('/home/u', 'ws-other', tasks, false)).toBeNull();
  });

  it('still treats a detached task as the owner, and matches a case-only difference when folding', () => {
    expect(findForeignCheckoutOwner('/home/u/.wmux/worktrees/abc/fix-login', 'ws-other', [task({ status: 'closed', detachedAt: 1 })], false)?.id).toBe('wtask-1');
    expect(findForeignCheckoutOwner('/HOME/u/.wmux/worktrees/abc/Fix-Login', 'ws-other', tasks, true)?.id).toBe('wtask-1');
  });
});
