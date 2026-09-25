import { describe, it, expect } from 'vitest';
import { clampSidebarString, hasUnsafeSidebarText, parsePhoneSidebarSnapshot, PHONE_SIDEBAR_LIMITS } from '../phoneFleetSidebar';

const valid = {
  activeWorkspaceId: 'ws-1',
  workspaces: [
    {
      id: 'ws-1', order: 0, pinned: true, color: 'teal', gitBranch: 'main', gitIsWorktree: false,
      gitSync: { ahead: 1, behind: 0, hasUpstream: true, dirty: 4 },
      taskSummary: { tasks: 2, needYou: 1, toReview: 0, finished: 0 },
    },
    { id: 'ws-2', order: 1, pinned: false, task: { ownerWorkspaceId: 'ws-1', detached: false, createdAt: 1_700_000_000_000 } },
  ],
  panes: [{ ptyId: 'pty-1', workspaceId: 'ws-1', surfaceTitle: '✳ app review', paneName: 'w1-5' }],
};

describe('parsePhoneSidebarSnapshot', () => {
  it('keeps every allowlisted field and drops the rest (gitSync.dirty is not on the wire)', () => {
    const parsed = parsePhoneSidebarSnapshot({ ...valid, secret: 'x' });
    expect(parsed).toEqual({
      ...valid,
      workspaces: [
        { ...valid.workspaces[0], gitSync: { ahead: 1, behind: 0, hasUpstream: true } },
        valid.workspaces[1],
      ],
    });
    expect(parsed).not.toHaveProperty('secret');
  });

  it('returns null for anything that is not a snapshot envelope', () => {
    for (const raw of [undefined, null, [], 'x', { error: 'wmux is still starting', retryable: true }, { workspaces: [] }]) {
      expect(parsePhoneSidebarSnapshot(raw)).toBeNull();
    }
  });

  it('drops a row without a valid identity and a malformed optional field on its own', () => {
    const parsed = parsePhoneSidebarSnapshot({
      activeWorkspaceId: 42,
      workspaces: [
        { id: '', order: 0, pinned: false },
        { id: '__proto__', order: 0, pinned: false },
        { id: 'ok', order: -1, pinned: false },
        { id: 'ok', order: 0, pinned: 'yes' },
        {
          id: 'ok', order: 2, pinned: false, color: '#ff0000', gitBranch: 'a\nb', gitIsWorktree: 1,
          gitSync: { ahead: Number.NaN, behind: 0, hasUpstream: true },
          task: { ownerWorkspaceId: 7, detached: false },
          taskSummary: { tasks: 1, needYou: 2, toReview: 0, finished: 0 },
          extra: { nested: true },
        },
        { id: 'ok', order: 3, pinned: true },
      ],
      panes: [
        { ptyId: 'pty-1', workspaceId: 'ok', surfaceTitle: 'x'.repeat(PHONE_SIDEBAR_LIMITS.surfaceTitle + 1), paneName: '' },
        { ptyId: 'pty-1', workspaceId: 'ok', surfaceTitle: 'duplicate' },
        { ptyId: 'pty-2' },
        'junk',
      ],
    });
    expect(parsed).toEqual({
      activeWorkspaceId: null,
      workspaces: [{ id: 'ok', order: 2, pinned: false }],
      panes: [{ ptyId: 'pty-1', workspaceId: 'ok' }],
    });
  });

  it('accepts a task whose owner is unnamed as null', () => {
    const parsed = parsePhoneSidebarSnapshot({
      activeWorkspaceId: null,
      workspaces: [{ id: 't', order: 0, pinned: false, task: { ownerWorkspaceId: null, detached: false } }],
      panes: [],
    });
    expect(parsed?.workspaces[0].task).toEqual({ ownerWorkspaceId: null, detached: false });
  });

  it('caps the row counts', () => {
    const many = Array.from({ length: PHONE_SIDEBAR_LIMITS.panes + 10 }, (_, i) => ({ ptyId: `p${i}`, workspaceId: 'w' }));
    expect(parsePhoneSidebarSnapshot({ activeWorkspaceId: null, workspaces: [], panes: many })?.panes).toHaveLength(PHONE_SIDEBAR_LIMITS.panes);
  });
});

describe('unsafe text (C1, separators, bidi controls)', () => {
  const unsafe = ['\u0085', '\u009b', '\u2028', '\u2029', '\u202a', '\u202e', '\u2066', '\u2069', '\u200f', '\u061c', '\u001b', '\u007f'];

  it('the parser refuses a field carrying any of them, at every string field', () => {
    for (const ch of unsafe) {
      const parsed = parsePhoneSidebarSnapshot({
        activeWorkspaceId: `ws${ch}1`,
        workspaces: [{ id: 'ws-1', order: 0, pinned: false, gitBranch: `main${ch}x` }, { id: `ws${ch}2`, order: 1, pinned: false }],
        panes: [{ ptyId: 'p1', workspaceId: 'ws-1', surfaceTitle: `evil${ch}title`, paneName: `w1${ch}-2` }],
      });
      expect(parsed).toEqual({
        activeWorkspaceId: null,
        workspaces: [{ id: 'ws-1', order: 0, pinned: false }],
        panes: [{ ptyId: 'p1', workspaceId: 'ws-1' }],
      });
    }
  });

  it('the renderer clamp strips them, and what it returns always passes the parser', () => {
    expect(clampSidebarString('abc\u202edcba', 50)).toBe('abcdcba');
    expect(clampSidebarString('\u2067app\u2069 review', 50)).toBe('app review');
    expect(clampSidebarString('one\u2028two\u0085three', 50)).toBe('one two three');
    for (const ch of unsafe) {
      const clamped = clampSidebarString(`left${ch}right`, 50)!;
      expect(hasUnsafeSidebarText(clamped)).toBe(false);
      const parsed = parsePhoneSidebarSnapshot({ activeWorkspaceId: null, workspaces: [], panes: [{ ptyId: 'p', workspaceId: 'w', surfaceTitle: clamped }] });
      expect(parsed?.panes[0].surfaceTitle).toBe(clamped);
    }
  });
});

describe('clampSidebarString', () => {
  it('flattens control characters, trims, and never splits a surrogate pair', () => {
    expect(clampSidebarString('  a\tb\n ', 10)).toBe('a b');
    expect(clampSidebarString('   ', 10)).toBeUndefined();
    expect(clampSidebarString(`${'a'.repeat(4)}😀`, 5)).toBe('aaaa');
  });
});
