import { describe, it, expect } from 'vitest';
import { clampSidebarString, createSidebarDropLog, equalLayoutSizes, normalizeLayoutSizes, hasUnsafeSidebarText, parsePhoneSidebarSnapshot, phoneTaskNesting, PHONE_SIDEBAR_LIMITS } from '../phoneFleetSidebar';

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

  it('parses the pane placement pairwise and drops only a bad paneId or placement', () => {
    const task = (extra: Record<string, unknown>, nested = true) => ({ ownerWorkspaceId: 'ws-1', detached: false, nested, ...extra });
    const drops = createSidebarDropLog();
    const parsed = parsePhoneSidebarSnapshot({
      activeWorkspaceId: null,
      workspaces: [
        { id: 'a', order: 0, pinned: false, task: task({ paneGroup: 'pane', requesterPaneId: 'pane-1' }) },
        { id: 'b', order: 1, pinned: false, task: task({ paneGroup: 'closedPane' }) },
        // 'pane' without the pane it names, a reserved id, an unknown group, a non-nested task.
        { id: 'c', order: 2, pinned: false, task: task({ paneGroup: 'pane' }) },
        { id: 'd', order: 3, pinned: false, task: task({ paneGroup: 'pane', requesterPaneId: '__proto__' }) },
        { id: 'e', order: 4, pinned: false, task: task({ paneGroup: 'workspace' }) },
        { id: 'f', order: 5, pinned: false, task: task({ paneGroup: 'pane', requesterPaneId: 'pane-1' }, false) },
      ],
      panes: [
        { ptyId: 'pty-1', workspaceId: 'ws-1', paneId: 'pane-1' },
        { ptyId: 'pty-2', workspaceId: 'ws-1', paneId: 'x'.repeat(PHONE_SIDEBAR_LIMITS.id + 1), paneName: 'w1-2' },
        { ptyId: 'pty-3', workspaceId: 'ws-1', paneId: 'constructor' },
      ],
    }, drops.report)!;
    const byId = new Map(parsed.workspaces.map((w) => [w.id, w.task]));
    expect(byId.get('a')).toMatchObject({ paneGroup: 'pane', requesterPaneId: 'pane-1' });
    expect(byId.get('b')).toMatchObject({ paneGroup: 'closedPane' });
    for (const id of ['c', 'd', 'e', 'f']) {
      expect(byId.get(id)).toBeDefined();
      expect(byId.get(id)).not.toHaveProperty('paneGroup');
      expect(byId.get(id)).not.toHaveProperty('requesterPaneId');
    }
    expect(parsed.panes).toEqual([
      { ptyId: 'pty-1', workspaceId: 'ws-1', paneId: 'pane-1' },
      { ptyId: 'pty-2', workspaceId: 'ws-1', paneName: 'w1-2' },
      { ptyId: 'pty-3', workspaceId: 'ws-1' },
    ]);
    expect(drops.summary()).toBe('pane.paneId×2, workspace.task.paneGroup×4');
  });

  it('phoneTaskNesting files a task under a pane only when a listed session of its owner carries that pane', () => {
    const task = (paneGroup?: string, requesterPaneId?: string, owner = 'owner', nested = true) => ({
      ownerWorkspaceId: owner, detached: false, nested,
      ...(paneGroup ? { paneGroup } : {}), ...(requesterPaneId ? { requesterPaneId } : {}),
    });
    const rows = [
      { id: 'owner', order: 0, pinned: false },
      { id: 'other', order: 1, pinned: false },
      { id: 'live', order: 2, pinned: false, task: task('pane', 'pane-a') },
      { id: 'closed', order: 3, pinned: false, task: task('closedPane') },
      // The requesting pane lives on the desktop but has no listed session (browser tabs only).
      { id: 'unlisted', order: 4, pinned: false, task: task('pane', 'pane-browser') },
      // Names a pane the reply lists, but under another workspace.
      { id: 'foreign', order: 5, pinned: false, task: task('pane', 'pane-other') },
      // A desktop build without the split.
      { id: 'old', order: 6, pinned: false, task: task() },
      { id: 'detached', order: 7, pinned: false, task: { ...task('pane', 'pane-a'), detached: true, nested: false } },
      { id: 'orphan', order: 8, pinned: false, task: task('pane', 'pane-a', 'gone-owner') },
    ] as Parameters<typeof phoneTaskNesting>[0];
    const listed = new Set(rows.map((r) => r.id));
    const panes = new Map([['pane-a', 'owner'], ['pane-other', 'other']]);
    const { placement } = phoneTaskNesting(rows, listed, panes);
    expect(Object.fromEntries(placement)).toEqual({
      live: { nestedUnder: 'pane', requesterPaneId: 'pane-a' },
      closed: { nestedUnder: 'closedPane' },
    });
    // No pane map at all (panes cut for size): only the closed-pane verdict survives.
    expect(Object.fromEntries(phoneTaskNesting(rows, listed).placement)).toEqual({ closed: { nestedUnder: 'closedPane' } });
  });

  it('keeps the HQ id and moa flag, and drops either alone when malformed', () => {
    expect(parsePhoneSidebarSnapshot({ ...valid, hqWorkspaceId: 'ws-hq', moa: true })).toMatchObject({ hqWorkspaceId: 'ws-hq', moa: true });
    const bad: unknown[] = ['', ' ws ', 'x'.repeat(PHONE_SIDEBAR_LIMITS.id + 1), '__proto__', 'ws\u202e', 42, null];
    for (const hqWorkspaceId of bad) {
      const reasons: string[] = [];
      const parsed = parsePhoneSidebarSnapshot({ ...valid, hqWorkspaceId, moa: true }, (r) => reasons.push(r));
      expect(parsed).not.toHaveProperty('hqWorkspaceId');
      expect(parsed?.moa).toBe(true);
      expect(parsed?.workspaces).toHaveLength(2);
      expect(reasons).toEqual(['hqWorkspaceId']);
    }
    for (const moa of [false, 'true', 1, null, {}]) {
      const reasons: string[] = [];
      const parsed = parsePhoneSidebarSnapshot({ ...valid, hqWorkspaceId: 'ws-hq', moa }, (r) => reasons.push(r));
      expect(parsed).not.toHaveProperty('moa');
      expect(parsed?.hqWorkspaceId).toBe('ws-hq');
      expect(reasons).toEqual(['moa']);
    }
    // Absent is not a drop.
    const reasons: string[] = [];
    const parsed = parsePhoneSidebarSnapshot(valid, (r) => reasons.push(r));
    expect(parsed).not.toHaveProperty('hqWorkspaceId');
    expect(parsed).not.toHaveProperty('moa');
    expect(reasons).toEqual([]);
  });

  it('keeps moaWakeBlocked only as the one known reason, dropping anything else alone', () => {
    expect(parsePhoneSidebarSnapshot({ ...valid, moa: true, moaWakeBlocked: 'moa-mode-off' }))
      .toMatchObject({ moa: true, moaWakeBlocked: 'moa-mode-off' });
    for (const moaWakeBlocked of ['moa-off', 'MOA-MODE-OFF', '', true, 1, null, {}]) {
      const reasons: string[] = [];
      const parsed = parsePhoneSidebarSnapshot({ ...valid, moa: true, moaWakeBlocked }, (r) => reasons.push(r));
      expect(parsed).not.toHaveProperty('moaWakeBlocked');
      expect(parsed?.moa).toBe(true);
      expect(reasons).toEqual(['moaWakeBlocked']);
    }
    const reasons: string[] = [];
    expect(parsePhoneSidebarSnapshot({ ...valid, moa: true }, (r) => reasons.push(r))).not.toHaveProperty('moaWakeBlocked');
    expect(reasons).toEqual([]);
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

describe('workspace layout tree', () => {
  // Each tab gets a surfaceId `<paneId>-t<i>` unless the case sets its own.
  const leafNode = (paneId: string, surfaces: object[], activeIndex: number | undefined = surfaces.length > 0 ? 0 : undefined) => ({
    kind: 'leaf', paneId, surfaces: surfaces.map((s, i) => ({ surfaceId: `${paneId}-t${i}`, ...s })), ...(activeIndex !== undefined ? { activeIndex } : {}),
  });
  const goodLayout = {
    root: {
      kind: 'split', direction: 'horizontal', sizes: [60, 40], children: [
        leafNode('pa', [{ kind: 'terminal', ptyId: 'p1' }, { kind: 'terminal', ptyId: 'p2' }, { kind: 'browser', title: 'Docs' }], 2),
        { kind: 'split', direction: 'vertical', sizes: [1, 3], children: [leafNode('pb', [{ kind: 'terminal', ptyId: 'p3' }]), leafNode('pc', [{ kind: 'terminal' }])] },
      ],
    },
    activePaneId: 'pb',
  };
  const parseLayout = (layout: unknown) => {
    const log = createSidebarDropLog();
    const parsed = parsePhoneSidebarSnapshot({ activeWorkspaceId: null, workspaces: [{ id: 'ws', order: 0, pinned: false, layout }], panes: [] }, log.report);
    return { row: parsed?.workspaces[0], dropped: log.summary() };
  };

  it('keeps a valid tree and normalises sizes to percent', () => {
    const { row, dropped } = parseLayout(goodLayout);
    expect(dropped).toBe('');
    expect(row?.layout?.activePaneId).toBe('pb');
    const root = row?.layout?.root;
    expect(root?.kind === 'split' && root.sizes).toEqual([60, 40]);
    const inner = root?.kind === 'split' ? root.children[1] : undefined;
    expect(inner?.kind === 'split' && inner.sizes).toEqual([25, 75]);
    expect(root?.kind === 'split' && root.children[0]).toEqual(goodLayout.root.children[0]);
  });

  it('refuses the whole tree, keeping the row, on a depth bomb and on a node bomb', () => {
    let deep: unknown = leafNode('bottom', []);
    for (let i = 0; i < 10_000; i += 1) deep = { kind: 'split', direction: 'vertical', sizes: [1], children: [deep] };
    const depth = parseLayout({ root: deep });
    expect(depth.row).toEqual({ id: 'ws', order: 0, pinned: false });
    expect(depth.dropped).toBe('workspace.layout.depth×1');

    const wide = { kind: 'split', direction: 'horizontal', sizes: Array(100_000).fill(1), children: Array.from({ length: 100_000 }, (_, i) => leafNode(`p${i}`, [])) };
    expect(parseLayout({ root: wide }).dropped).toBe('workspace.layout.children×1');

    // Within every per-split bound, but over the leaf total.
    const split = (n: number, base: number) => ({ kind: 'split', direction: 'vertical', sizes: Array(n).fill(1), children: Array.from({ length: n }, (_, i) => leafNode(`p${base + i}`, [])) });
    const many = { kind: 'split', direction: 'horizontal', sizes: [1, 1], children: [split(40, 0), split(40, 100)] };
    expect(parseLayout({ root: many }).dropped).toBe('workspace.layout.leaves×1');
  });

  it('refuses bad sizes: wrong count, zero, negative, non-finite, not numbers', () => {
    for (const sizes of [[100], [0, 100], [-1, 101], [Infinity, 1], [NaN, 1], ['50', '50'], undefined]) {
      const root = { kind: 'split', direction: 'horizontal', sizes, children: [leafNode('a', []), leafNode('b', [])] };
      expect(parseLayout({ root }).dropped).toBe('workspace.layout.sizes×1');
    }
  });

  it('normalises sizes to whole hundredths summing to exactly 100, none below 0.01', () => {
    const hundredths = (sizes: number[]) => sizes.reduce((sum, size) => sum + Math.round(size * 100), 0);
    const cases: number[][] = [
      [1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1],
      // The 0.01 floor used to push these over 100.
      [1e-9, 1e-9, 1e-9, 1],
      [...Array(63).fill(1e-9), 1],
      [0.3, 0.3, 0.4],
      [33.333, 33.333, 33.334],
      Array(64).fill(1),
    ];
    for (const weights of cases) {
      const sizes = normalizeLayoutSizes(weights, weights.length)!;
      expect(hundredths(sizes)).toBe(10_000);
      expect(sizes.every((size) => size >= 0.01 && Number.isInteger(Math.round(size * 100)) && Math.abs(size * 100 - Math.round(size * 100)) < 1e-6)).toBe(true);
    }
    expect(normalizeLayoutSizes([1, 1, 1], 3)).toEqual([33.34, 33.33, 33.33]);
    expect(normalizeLayoutSizes([60, 40], 2)).toEqual([60, 40]);
    expect(equalLayoutSizes(3)).toEqual([33.34, 33.33, 33.33]);
    expect(hundredths(equalLayoutSizes(7))).toBe(10_000);
    // Re-normalising a normalised split changes nothing (every hop parses).
    const once = normalizeLayoutSizes([2, 7, 11], 3)!;
    expect(normalizeLayoutSizes(once, 3)).toEqual(once);
  });

  it('reads an unknown surface kind as other, and refuses an unknown node kind', () => {
    const { row } = parseLayout({ root: leafNode('a', [{ kind: 'hologram', title: 'Future tab', extra: 1 }]) });
    expect(row?.layout?.root).toEqual({ kind: 'leaf', paneId: 'a', surfaces: [{ surfaceId: 'a-t0', kind: 'other', title: 'Future tab' }], activeIndex: 0 });
    expect(parseLayout({ root: { kind: 'grid', children: [] } }).dropped).toBe('workspace.layout.kind×1');
  });

  it('refuses an unsafe title, a duplicate pane or session id, and an out-of-range active tab', () => {
    expect(parseLayout({ root: leafNode('a', [{ kind: 'browser', title: 'evil‮title' }]) }).dropped).toBe('workspace.layout.title×1');
    const two = (a: unknown, b: unknown) => ({ root: { kind: 'split', direction: 'horizontal', sizes: [1, 1], children: [a, b] } });
    expect(parseLayout(two(leafNode('a', []), leafNode('a', []))).dropped).toBe('workspace.layout.paneId×1');
    expect(parseLayout(two(leafNode('a', [{ kind: 'terminal', ptyId: 'p' }]), leafNode('b', [{ kind: 'terminal', ptyId: 'p' }]))).dropped).toBe('workspace.layout.ptyId×1');
    expect(parseLayout({ root: leafNode('a', [{ kind: 'terminal', ptyId: 'p' }], 1) }).dropped).toBe('workspace.layout.activeIndex×1');
    expect(parseLayout({ root: { kind: 'leaf', paneId: 'a', surfaces: [{ surfaceId: 's', kind: 'terminal', ptyId: 'p' }] } }).dropped).toBe('workspace.layout.activeIndex×1');
  });

  it('refuses a tab without a valid surfaceId, and a surfaceId used twice in the tree', () => {
    for (const surfaceId of [undefined, '', ' s', '__proto__', 'x'.repeat(129), 's‮']) {
      expect(parseLayout({ root: leafNode('a', [{ surfaceId, kind: 'terminal' }]) }).dropped).toBe('workspace.layout.surfaceId×1');
    }
    const two = { root: { kind: 'split', direction: 'horizontal', sizes: [1, 1], children: [
      leafNode('a', [{ surfaceId: 'same', kind: 'terminal' }]), leafNode('b', [{ surfaceId: 'same', kind: 'browser' }]),
    ] } };
    expect(parseLayout(two).dropped).toBe('workspace.layout.surfaceId×1');
  });

  it('drops only an activePaneId that is not a leaf of the tree', () => {
    const { row, dropped } = parseLayout({ ...goodLayout, activePaneId: 'stashed-pane' });
    expect(row?.layout?.activePaneId).toBeUndefined();
    expect(row?.layout?.root.kind).toBe('split');
    expect(dropped).toBe('workspace.layout.activePaneId×1');
  });
});

describe('pending Moa hand-off notice', () => {
  const row = (moaHandoff: unknown) => ({ activeWorkspaceId: null, panes: [], workspaces: [{ id: 'ws-1', order: 0, pinned: false, moaHandoff }] });

  it('keeps a valid notice and only its three fields', () => {
    const notice = { agentName: 'Codex', title: 'Ship the fix', raisedAt: 1_700_000_000_000 };
    expect(parsePhoneSidebarSnapshot(row({ ...notice, body: 'secret body' }))!.workspaces[0].moaHandoff).toEqual(notice);
  });

  it('drops a malformed notice on its own and keeps the row', () => {
    for (const bad of [
      { agentName: 'Codex', title: 'a\nb', raisedAt: 1 },
      { agentName: 'Codex', title: 'x'.repeat(PHONE_SIDEBAR_LIMITS.moaHandoffTitle + 1), raisedAt: 1 },
      { agentName: '', title: 'ok', raisedAt: 1 },
      { agentName: 'Codex', title: 'ok', raisedAt: 0 },
      'nope',
    ]) {
      const reasons: string[] = [];
      const parsed = parsePhoneSidebarSnapshot(row(bad), (r) => reasons.push(r))!;
      expect(parsed.workspaces[0]).toEqual({ id: 'ws-1', order: 0, pinned: false });
      expect(reasons).toEqual(['workspace.moaHandoff']);
    }
  });
});

describe("Moa's delegated jobs", () => {
  const snap = (moaDelegations: unknown) => ({ activeWorkspaceId: null, panes: [], workspaces: [], moaDelegations });
  const job = (taskId: string, since: number, extra: Record<string, unknown> = {}) => ({
    taskId, workspaceId: 'ws-1', agentName: 'Codex CLI', title: 'Ship it', state: 'working', since, ...extra,
  });

  it('keeps only the six fields, newest first, and an empty list as empty', () => {
    const parsed = parsePhoneSidebarSnapshot(snap([job('t1', 1), { ...job('t2', 2, { state: 'blocked' }), result: 'secret', request: 'secret' }]))!;
    expect(parsed.moaDelegations).toEqual([job('t2', 2, { state: 'blocked' }), job('t1', 1)]);
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(parsePhoneSidebarSnapshot(snap([]))!.moaDelegations).toEqual([]);
    expect(parsePhoneSidebarSnapshot(snap(undefined))).not.toHaveProperty('moaDelegations');
  });

  it('drops a malformed job on its own, a duplicate, and anything past the cap', () => {
    const reasons: string[] = [];
    const bad = [
      job('a', 1, { state: 'queued' }),
      job('b', 1, { title: 'a\nb' }),
      job('c', 1, { title: 'x'.repeat(PHONE_SIDEBAR_LIMITS.moaDelegationTitle + 1) }),
      job('d', 0),
      job('e', 1, { agentName: '' }),
      { ...job('f', 1), workspaceId: undefined },
      'nope',
    ];
    const many = Array.from({ length: PHONE_SIDEBAR_LIMITS.moaDelegations + 2 }, (_, i) => job(`ok-${i}`, i + 1));
    const parsed = parsePhoneSidebarSnapshot(snap([...bad, job('ok-0', 9), ...many]), (r) => reasons.push(r))!;
    expect(parsed.moaDelegations).toHaveLength(PHONE_SIDEBAR_LIMITS.moaDelegations);
    expect(reasons.filter((r) => r === 'moaDelegations.row')).toHaveLength(bad.length);
    expect(reasons).toContain('moaDelegations.duplicate');
    expect(reasons).toContain('moaDelegations.overLimit');
    expect(parsePhoneSidebarSnapshot(snap('nope'), (r) => reasons.push(r))).not.toHaveProperty('moaDelegations');
    expect(reasons.at(-1)).toBe('moaDelegations');
  });
});
