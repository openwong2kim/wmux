import { describe, it, expect } from 'vitest';
import { clampSidebarString, createSidebarDropLog, hasUnsafeSidebarText, parsePhoneSidebarSnapshot, phoneTaskNesting, PHONE_SIDEBAR_LIMITS } from '../phoneFleetSidebar';

const valid = {
  activeWorkspaceId: 'ws-1',
  workspaces: [
    {
      id: 'ws-1', order: 0, pinned: true, color: 'teal', gitBranch: 'main', gitIsWorktree: false,
      gitSync: { ahead: 1, behind: 0, hasUpstream: true, dirty: 4 },
    },
    { id: 'ws-2', order: 1, pinned: false, task: { ownerWorkspaceId: 'ws-1', detached: false, createdAt: 1_700_000_000_000, nested: true, state: { needYou: true, toReview: false, finished: false } } },
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
          task: { ownerWorkspaceId: 7, detached: false, nested: true },
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
      workspaces: [
        { id: 't', order: 0, pinned: false, task: { ownerWorkspaceId: null, detached: false, nested: true, state: { needYou: true, toReview: false, finished: false } } },
        { id: 'u', order: 1, pinned: false, task: { ownerWorkspaceId: 'o', detached: false } },
        { id: 'v', order: 2, pinned: false, task: { ownerWorkspaceId: 'o', detached: false, nested: false, state: { needYou: true, toReview: true, finished: true } } },
      ],
      panes: [],
    });
    // Nothing to nest under → not nested, and the state bits never ride a non-nested task.
    expect(parsed?.workspaces[0].task).toEqual({ ownerWorkspaceId: null, detached: false, nested: false });
    // `nested` is required.
    expect(parsed?.workspaces[1]).not.toHaveProperty('task');
    expect(parsed?.workspaces[2].task).toEqual({ ownerWorkspaceId: 'o', detached: false, nested: false });
  });

  it('phoneTaskNesting nests only under a listed owner and counts exactly the nested rows', () => {
    const state = (needYou: boolean, toReview: boolean, finished: boolean) => ({ needYou, toReview, finished });
    const rows = [
      { id: 'owner', order: 0, pinned: false },
      { id: 't1', order: 1, pinned: false, task: { ownerWorkspaceId: 'owner', detached: false, nested: true, state: state(true, false, false) } },
      { id: 't2', order: 2, pinned: false, task: { ownerWorkspaceId: 'owner', detached: false, nested: true, state: state(false, true, true) } },
      // Nested on the desktop, but no live pane: not a phone row, so not counted.
      { id: 't-unlisted', order: 3, pinned: false, task: { ownerWorkspaceId: 'owner', detached: false, nested: true, state: state(true, true, true) } },
      // Nested on the desktop under an owner the phone does not list.
      { id: 't3', order: 4, pinned: false, task: { ownerWorkspaceId: 'owner-no-pty', detached: false, nested: true, state: state(true, false, false) } },
      { id: 't4', order: 5, pinned: false, task: { ownerWorkspaceId: 'owner', detached: true, nested: false } },
    ];
    const listed = new Set(['owner', 't1', 't2', 't3', 't4']);
    const { nested, summaries } = phoneTaskNesting(rows, listed);
    expect(Object.fromEntries(nested)).toEqual({ t1: true, t2: true, t3: false, t4: false });
    expect(Object.fromEntries(summaries)).toEqual({ owner: { tasks: 2, needYou: 1, toReview: 1, finished: 1 } });
    const nestedUnderOwner = rows.filter((r) => nested.get(r.id) && r.task?.ownerWorkspaceId === 'owner').length;
    expect(summaries.get('owner')!.tasks).toBe(nestedUnderOwner);
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

describe('real fan-out data and per-item drops', () => {
  // The renderer projection captured from a live fan-out (owner + two tasks).
  const OWNER = 'ws-phone-e9b00e1b-60c6-46e4-9ae8-9b54e0b2cd77';
  const live = {
    activeWorkspaceId: OWNER,
    workspaces: [
      { id: 'ws-edaf3c5f-4aa1-420c-8c7c-12f4f7fdf5a4', order: 0, pinned: false, gitIsWorktree: false },
      { id: OWNER, order: 1, pinned: false, gitBranch: 'main', gitIsWorktree: false, gitSync: { ahead: 0, behind: 0, hasUpstream: false } },
      { id: 'ws-208c08e3-96bb-4b07-a9b4-e5bdad9728b6', order: 2, pinned: false, gitBranch: 'wtask/finish-quickly-63gs0w4a', gitIsWorktree: true, gitSync: { ahead: 0, behind: 0, hasUpstream: false },
        task: { ownerWorkspaceId: OWNER, detached: false, createdAt: 1790368163922, nested: true, state: { needYou: false, toReview: true, finished: true } } },
      { id: 'ws-706df135-6033-47b7-bd3e-d0de474ea35a', order: 3, pinned: false, gitBranch: 'wtask/ask-the-user-n9znqi5b', gitIsWorktree: true, gitSync: { ahead: 0, behind: 0, hasUpstream: false },
        task: { ownerWorkspaceId: OWNER, detached: false, createdAt: 1790368170163, nested: true, state: { needYou: true, toReview: false, finished: false } } },
    ],
    panes: [
      { ptyId: 'daemon-5b9aa7c3', workspaceId: 'ws-208c08e3-96bb-4b07-a9b4-e5bdad9728b6', surfaceTitle: '✳ Wmux task protocol and ledger', paneName: 'w3-1' },
      { ptyId: 'daemon-4b1edf50', workspaceId: 'ws-706df135-6033-47b7-bd3e-d0de474ea35a', surfaceTitle: '✳ Tabs or spaces preference', paneName: 'w4-1' },
    ],
  };

  it('parses the live snapshot unchanged, with nothing dropped', () => {
    const drops = createSidebarDropLog();
    expect(parsePhoneSidebarSnapshot(JSON.parse(JSON.stringify(live)), drops.report)).toEqual(live);
    expect(drops.summary()).toBe('');
  });

  it('drops only the offending field or row, and reports a reason tag without the value', () => {
    const broken = JSON.parse(JSON.stringify(live));
    broken.workspaces[2].task.createdAt = 'yesterday';            // tolerated: createdAt is optional
    broken.workspaces[3].task.state = { needYou: 'yes' };         // state only
    broken.workspaces[1].gitSync = { ahead: -1, behind: 0, hasUpstream: true }; // field only
    broken.workspaces.push({ id: 'SECRET-ROW', order: 'x', pinned: false }); // row
    broken.panes[0].surfaceTitle = 'SECRET\u202etitle';           // field only
    const drops = createSidebarDropLog();
    const parsed = parsePhoneSidebarSnapshot(broken, drops.report)!;
    expect(parsed.workspaces.map((w) => w.id)).toEqual(live.workspaces.map((w) => w.id));
    expect(parsed.workspaces[1]).not.toHaveProperty('gitSync');
    expect(parsed.workspaces[1].gitBranch).toBe('main');
    expect(parsed.workspaces[2].task).toEqual({ ownerWorkspaceId: OWNER, detached: false, nested: true, state: { needYou: false, toReview: true, finished: true } });
    expect(parsed.workspaces[3].task).toEqual({ ownerWorkspaceId: OWNER, detached: false, createdAt: 1790368170163, nested: true });
    expect(parsed.panes[0]).toEqual({ ptyId: 'daemon-5b9aa7c3', workspaceId: 'ws-208c08e3-96bb-4b07-a9b4-e5bdad9728b6', paneName: 'w3-1' });
    expect(parsed.activeWorkspaceId).toBe(OWNER);
    const summary = drops.summary();
    expect(summary).toBe('pane.surfaceTitle×1, workspace.gitSync×1, workspace.row×1, workspace.task.state×1');
    expect(summary).not.toMatch(/SECRET|yesterday/);
  });
});
