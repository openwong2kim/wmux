import { describe, expect, it } from 'vitest';
import { concreteCombo, resolveShortcut, WMUX_KEYMAP } from '../../keymap';
import { generateId } from '../../types';
import { remoteAgentKey, remoteAttachmentKey } from '../../remoteHosts';
import {
  LOCAL_PC_ID,
  PC_RAIL_APPROVAL_LIMITS,
  PC_RAIL_LIMITS,
  PC_RAIL_PENDING_TTL_MS,
  PC_RAIL_SHORTCUTS,
  applyPcRailAttentionFrame,
  comparePcRailRows,
  countPcRailAttention,
  formatShadowWorkspaceId,
  isPcRailFeedStale,
  isShadowWorkspaceId,
  parsePcRailPersisted,
  parsePcRailWorkspaceExtras,
  parseRemoteApprovalsList,
  parseShadowWorkspaceId,
  pcRailHostState,
  isPcRailHostOnline,
  prunePcRailPersisted,
  reconcilePcRailApprovals,
  type PcRailWorkspaceRow,
} from '..';

const HOST = '3f2a9c1e-7b4d-4e8a-9c21-5d6f7a8b9c0d';

describe('shadow workspace ids', () => {
  it('round-trips, keeping colons in the remote id', () => {
    for (const remoteId of ['ws-1', 'a:b', ':lead', 'trail:', 'shadow:x:y']) {
      const id = formatShadowWorkspaceId(HOST, remoteId);
      expect(id).toBe(`shadow:${HOST}:${remoteId}`);
      expect(parseShadowWorkspaceId(id)).toEqual({ hostId: HOST, remoteId });
    }
  });

  it('is one-to-one: a colon cannot move between the halves', () => {
    // (a, b:c) and (a:b, c) would both spell shadow:a:b:c; only the first is formattable.
    expect(formatShadowWorkspaceId('a', 'b:c')).toBe('shadow:a:b:c');
    expect(formatShadowWorkspaceId('a:b', 'c')).toBeNull();
    const seen = new Map<string, string>();
    for (const h of ['a', 'ab', HOST]) {
      for (const r of ['b', 'b:c', 'c', ':', 'ws-1']) {
        const id = formatShadowWorkspaceId(h, r);
        if (id === null) continue;
        expect(seen.get(id), id).toBeUndefined();
        seen.set(id, `${h}|${r}`);
      }
    }
  });

  it('refuses empty or oversized halves', () => {
    expect(formatShadowWorkspaceId('', 'ws')).toBeNull();
    expect(formatShadowWorkspaceId(HOST, '')).toBeNull();
    expect(formatShadowWorkspaceId(HOST, 'x'.repeat(129))).toBeNull();
    expect(parseShadowWorkspaceId('shadow:')).toBeNull();
    expect(parseShadowWorkspaceId('shadow::ws')).toBeNull();
    expect(parseShadowWorkspaceId(`shadow:${HOST}:`)).toBeNull();
    expect(parseShadowWorkspaceId(`shadow:${HOST}`)).toBeNull();
    expect(parseShadowWorkspaceId(42)).toBeNull();
  });

  it('never matches a local workspace id or the other remote keys', () => {
    const local = generateId('ws');
    expect(isShadowWorkspaceId(local)).toBe(false);
    expect(parseShadowWorkspaceId(local)).toBeNull();
    expect(parseShadowWorkspaceId(remoteAgentKey(HOST, 's1'))).toBeNull();
    expect(parseShadowWorkspaceId(remoteAttachmentKey(HOST, 'ws-1'))).toBeNull();
    expect(isShadowWorkspaceId(formatShadowWorkspaceId(HOST, local))).toBe(true);
  });
});

describe('persisted rail state', () => {
  it('defaults to this computer for anything unusable', () => {
    for (const v of [undefined, null, 'x', [], 7]) {
      expect(parsePcRailPersisted(v)).toEqual({ activePcId: LOCAL_PC_ID, lastWorkspaceByPc: {}, mutedPcs: [] });
    }
  });

  it('never restores a shadow id', () => {
    const shadow = formatShadowWorkspaceId(HOST, 'ws-1') as string;
    const out = parsePcRailPersisted({
      activePcId: shadow,
      lastWorkspaceByPc: { [HOST]: shadow, [LOCAL_PC_ID]: 'ws-local', [shadow]: 'ws-2' },
      mutedPcs: [shadow, HOST],
    });
    expect(out).toEqual({ activePcId: LOCAL_PC_ID, lastWorkspaceByPc: { [LOCAL_PC_ID]: 'ws-local' }, mutedPcs: [HOST] });
  });

  it('drops reserved, oversized and duplicate entries and caps the counts', () => {
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`h${i}`, `w${i}`]));
    const parsed = parsePcRailPersisted({
      activePcId: 'x'.repeat(PC_RAIL_LIMITS.id + 1),
      lastWorkspaceByPc: JSON.parse(`{"__proto__":"w", ${JSON.stringify(many).slice(1)}`),
      mutedPcs: [HOST, HOST, LOCAL_PC_ID, '', 3, ...Array.from({ length: 200 }, (_, i) => `m${i}`)],
    });
    expect(parsed.activePcId).toBe(LOCAL_PC_ID);
    expect(Object.keys(parsed.lastWorkspaceByPc)).toHaveLength(PC_RAIL_LIMITS.hosts);
    expect(Object.prototype.hasOwnProperty.call(parsed.lastWorkspaceByPc, '__proto__')).toBe(false);
    expect(parsed.mutedPcs[0]).toBe(HOST);
    expect(parsed.mutedPcs.filter((id) => id === HOST)).toHaveLength(1);
    expect(parsed.mutedPcs).not.toContain(LOCAL_PC_ID);
    expect(parsed.mutedPcs).toHaveLength(PC_RAIL_LIMITS.hosts);
  });

  it('prunes hosts that are no longer paired, falling back to this computer', () => {
    const pruned = prunePcRailPersisted(
      { activePcId: 'gone', lastWorkspaceByPc: { gone: 'w1', [HOST]: 'w2', [LOCAL_PC_ID]: 'w3' }, mutedPcs: ['gone', HOST] },
      new Set([HOST]),
    );
    expect(pruned).toEqual({ activePcId: LOCAL_PC_ID, lastWorkspaceByPc: { [HOST]: 'w2', [LOCAL_PC_ID]: 'w3' }, mutedPcs: [HOST] });
  });

  it('keeps this computer first when the host cap is reached', () => {
    const hosts = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`h${i}`, `w${i}`]));
    const parsed = parsePcRailPersisted({ lastWorkspaceByPc: { ...hosts, [LOCAL_PC_ID]: 'ws-local' } });
    expect(parsed.lastWorkspaceByPc[LOCAL_PC_ID]).toBe('ws-local');
    expect(Object.keys(parsed.lastWorkspaceByPc)[0]).toBe(LOCAL_PC_ID);
    expect(Object.keys(parsed.lastWorkspaceByPc)).toHaveLength(PC_RAIL_LIMITS.hosts + 1);
  });

  it('gives insecure its own state, never offline', () => {
    expect(pcRailHostState('insecure')).toBe('insecure');
    expect(pcRailHostState('unreachable')).toBe('offline');
    expect(pcRailHostState('needs-repair')).toBe('needs-repair');
    expect(pcRailHostState('connected')).toBe('online');
    expect(pcRailHostState('reachable')).toBe('online');
    expect(isPcRailHostOnline('insecure')).toBe(false);
  });

  it('marks a feed stale after the third missed tick', () => {
    expect(isPcRailFeedStale({ failedTicks: 2 })).toBe(false);
    expect(isPcRailFeedStale({ failedTicks: 3 })).toBe(true);
  });
});

describe('workspace row extras', () => {
  it('keeps valid sidebar fields and drops the rest', () => {
    expect(parsePcRailWorkspaceExtras({ order: 2, pinned: true, color: 'teal', gitBranch: ' main\n' }, 1))
      .toEqual({ order: 2, pinned: true, color: 'teal', gitBranch: 'main' });
    expect(parsePcRailWorkspaceExtras({ order: -1, pinned: 'yes', color: 'chartreuse', gitBranch: 5 }, 1)).toEqual({});
    expect(parsePcRailWorkspaceExtras({ gitBranch: 'b'.repeat(500) }, 1)?.gitBranch).toHaveLength(200);
  });

  it('lists a pane-less row only when the host flags it empty', () => {
    expect(parsePcRailWorkspaceExtras({}, 0)).toBeNull();
    expect(parsePcRailWorkspaceExtras({ empty: true }, 0)).toEqual({ empty: true });
    expect(parsePcRailWorkspaceExtras({ empty: true }, 2)).toBeNull();
    expect(parsePcRailWorkspaceExtras({ empty: 'true' }, 1)).toEqual({});
    expect(parsePcRailWorkspaceExtras(null, 1)).toBeNull();
  });

  it('sorts by the host order, unordered rows last by name', () => {
    const row = (id: string, name: string, order?: number): PcRailWorkspaceRow => ({ id, name, panes: [], ...(order === undefined ? {} : { order }) });
    const sorted = [row('c', 'zed'), row('a', 'b', 1), row('b', 'a'), row('d', 'x', 0)].sort(comparePcRailRows);
    expect(sorted.map((r) => r.id)).toEqual(['d', 'a', 'b', 'c']);
  });
});

describe('attention reconcile', () => {
  it('parses only pending approvals, deduped and capped', () => {
    const pending = [
      { id: 'a1', sessionId: 's1', state: 'pending', workspaceId: 'w1' },
      { id: 'a1', sessionId: 's1', state: 'pending' },
      { id: 'a2', sessionId: 's2', state: 'resolved' },
      { id: '', sessionId: 's3', state: 'pending' },
      { id: 'a4', state: 'pending' },
      ...Array.from({ length: 400 }, (_, i) => ({ id: `x${i}`, sessionId: 's', state: 'pending' })),
    ];
    const listed = parseRemoteApprovalsList({ pending, recentlyResolved: [] });
    expect(listed?.[0]).toEqual({ id: 'a1', sessionId: 's1', workspaceId: 'w1' });
    expect(listed?.filter((a) => a.id === 'a1')).toHaveLength(1);
    expect(listed).toHaveLength(256);
    expect(parseRemoteApprovalsList({})).toBeNull();
    expect(parseRemoteApprovalsList('nope')).toBeNull();
  });

  const T0 = 1_000_000;

  it('skips prompts already answered from another device', () => {
    const listed = parseRemoteApprovalsList({ pending: [
      { id: 'a1', sessionId: 's1', state: 'pending', pressedAt: 5 },
      { id: 'a2', sessionId: 's2', state: 'pending' },
    ] });
    expect(listed?.map((a) => a.id)).toEqual(['a2']);
  });

  it('SSE raises at once; the list replaces approvals and keeps criticals', () => {
    let ledger = reconcilePcRailApprovals({}, [], T0);
    const raised = applyPcRailAttentionFrame(ledger, 'approval', { tier: 'act', phase: 'create', approvalId: 'a1', sessionId: 's1' }, T0);
    expect(raised.refetch).toBe(true);
    ledger = applyPcRailAttentionFrame(raised.ledger, 'approval', { tier: 'act', phase: 'create', approvalId: 'a2', sessionId: 's3' }, T0).ledger;
    ledger = applyPcRailAttentionFrame(ledger, 'critical', { tier: 'act', sessionId: 's2' }, T0).ledger;
    expect(Object.keys(ledger).sort()).toEqual(['approval:a1', 'approval:a2', 'critical:s2']);
    ledger = reconcilePcRailApprovals(ledger, [{ id: 'a1', sessionId: 's1' }], T0 + 1);
    expect(Object.keys(ledger).sort()).toEqual(['approval:a1', 'critical:s2']);
    // A critical goes when its pane leaves the host's list, or when it expires.
    expect(Object.keys(reconcilePcRailApprovals(ledger, [], T0 + 2, new Set(['s1'])))).toEqual([]);
    expect(Object.keys(reconcilePcRailApprovals(ledger, [], T0 + 2, new Set(['s2'])))).toEqual(['critical:s2']);
    expect(Object.keys(reconcilePcRailApprovals(ledger, [], T0 + PC_RAIL_PENDING_TTL_MS))).toEqual([]);
  });

  it('treats a missing or unknown tier as act', () => {
    const empty = reconcilePcRailApprovals({}, [], T0);
    for (const tier of [undefined, 'urgent']) {
      const crit = applyPcRailAttentionFrame(empty, 'critical', { tier, sessionId: 's1' }, T0);
      expect(Object.keys(crit.ledger)).toEqual(['critical:s1']);
      const create = applyPcRailAttentionFrame(empty, 'approval', { tier, phase: 'create', approvalId: 'a1', sessionId: 's1' }, T0);
      expect(Object.keys(create.ledger)).toEqual(['approval:a1']);
    }
    expect(applyPcRailAttentionFrame(empty, 'critical', { tier: 'info', sessionId: 's1' }, T0).ledger).toBe(empty);
    expect(applyPcRailAttentionFrame(empty, 'approval', { phase: 'resolve', approvalId: 'a1', sessionId: 's1' }, T0).ledger).toBe(empty);
  });

  it('drops an answered prompt on press, and the next list does not bring it back', () => {
    let ledger = reconcilePcRailApprovals({}, [{ id: 'a1', sessionId: 's1' }], T0);
    const pressed = applyPcRailAttentionFrame(ledger, 'approval', { tier: 'info', phase: 'press', approvalId: 'a1', sessionId: 's1' }, T0);
    expect(pressed).toEqual({ ledger: {}, refetch: true });
    const listed = parseRemoteApprovalsList({ pending: [{ id: 'a1', sessionId: 's1', state: 'pending', pressedAt: T0 }] }) ?? [];
    ledger = reconcilePcRailApprovals(pressed.ledger, listed, T0 + 1);
    expect(ledger).toEqual({});
  });

  it('stays bounded under 10k distinct ids, and a repeat costs no copy', () => {
    let ledger = reconcilePcRailApprovals({}, [], T0);
    for (let i = 0; i < 10_000; i++) {
      ledger = applyPcRailAttentionFrame(ledger, 'approval', { tier: 'act', approvalId: `a${i}`, sessionId: `s${i}` }, T0 + i).ledger;
    }
    expect(Object.keys(ledger)).toHaveLength(PC_RAIL_APPROVAL_LIMITS.approvals);
    expect(ledger['approval:a9999']).toBeDefined();
    expect(ledger['approval:a0']).toBeUndefined();
    const again = applyPcRailAttentionFrame(ledger, 'approval', { tier: 'act', approvalId: 'a9999', sessionId: 's9999' }, T0 + 10_000);
    expect(again.ledger).toBe(ledger);
    expect(again.refetch).toBe(false);
  });

  it('clears an approval on its settling frame and ignores the rest', () => {
    const start = reconcilePcRailApprovals({}, [{ id: 'a1', sessionId: 's1' }], T0);
    const settled = applyPcRailAttentionFrame(start, 'approval', { tier: 'info', phase: 'resolve', approvalId: 'a1', sessionId: 's1' }, T0);
    expect(settled).toEqual({ ledger: {}, refetch: true });
    for (const [kind, data] of [
      ['notify', { tier: 'act', sessionId: 's1' }],
      ['critical', { tier: 'info', sessionId: 's1' }],
      ['approval', { tier: 'act', sessionId: 's1' }],
      ['approval', { tier: 'act', approvalId: 'a9' }],
      ['approval', { tier: 'info', phase: 'resolve', approvalId: 'unknown', sessionId: 's1' }],
      ['approval', 'garbage'],
    ] as const) {
      expect(applyPcRailAttentionFrame(start, kind, data, T0)).toEqual({ ledger: start, refetch: false });
    }
  });

  it('counts needs-you per pane and finished since the last view', () => {
    const counts = countPcRailAttention({
      panes: [
        { sessionId: 's1', workspaceId: 'w1', agentName: 'claude', agentStatus: 'awaiting_input' },
        { sessionId: 's2', workspaceId: 'w1', agentName: 'claude', agentStatus: 'complete' },
        { sessionId: 's3', workspaceId: 'w2', agentName: 'codex', agentStatus: 'complete' },
        { sessionId: 's4', workspaceId: 'w2', agentStatus: 'awaiting_input' },
        { sessionId: 's5', workspaceId: 'w2', agentName: 'codex', agentStatus: 'complete' },
      ],
      pending: reconcilePcRailApprovals({}, [{ id: 'a1', sessionId: 's1' }, { id: 'a2', sessionId: 's5' }], 0),
      completeSeenAt: { s2: 200, s3: 100, s5: 300 },
      hostSeen: { w2: 150 },
    });
    // s1 once (input + approval), s5 via its approval; s4 names no agent.
    // finished: s2 (w1 never viewed); s3 completed before w2 was viewed; s5 needs you.
    expect(counts).toEqual({ needsYou: 2, finished: 1 });
  });
});

describe('PC rail shortcuts', () => {
  const platforms: NodeJS.Platform[] = ['darwin', 'win32', 'linux'];

  it('take no key a built-in already uses, on any platform', () => {
    for (const platform of platforms) {
      // The rail's own rows are in the table now; every other row counts.
      const pcActions = new Set<string>(PC_RAIL_SHORTCUTS.map((e) => e.action));
      const taken = new Set(WMUX_KEYMAP.filter((e) => !pcActions.has(e.action)).map((e) => concreteCombo(e, platform)));
      const ours = PC_RAIL_SHORTCUTS.map((e) => concreteCombo(e, platform));
      expect(new Set(ours).size).toBe(ours.length);
      for (const combo of ours) expect(taken.has(combo), `${platform} ${combo}`).toBe(false);
    }
  });

  it('are spelled the way the resolver matches a keydown', () => {
    const bindings = PC_RAIL_SHORTCUTS.map((e) => ({ combo: e.combo, action: e.action as never }));
    const press = (key: string) => ({ key, code: key, ctrlKey: false, metaKey: false, shiftKey: true, altKey: true });
    expect(resolveShortcut(press('ArrowUp'), bindings)).toBe('prevPc');
    expect(resolveShortcut(press('ArrowDown'), bindings)).toBe('nextPc');
    expect(resolveShortcut(press('Home'), bindings)).toBe('thisPc');
  });

  it('use no Ctrl+Alt chord (AltGr on Windows)', () => {
    for (const e of PC_RAIL_SHORTCUTS) expect(e.combo).not.toMatch(/Ctrl\+.*Alt|Alt\+.*Ctrl/);
  });
});
