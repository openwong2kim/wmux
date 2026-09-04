import { describe, it, expect } from 'vitest';
import {
  buildPaneNamesByPrincipal,
  paneNameForAuthor,
  paneNameForMember,
  paneNamesKey,
  parsePaneNamesKey,
} from '../paneMemberNames';
import { createLeafPane, createSurface, type Pane, type Workspace } from '../../../shared/types';
import { panePrincipalId } from '../../../shared/principals';
import type { ChannelMember } from '../../../shared/channels';

// C-5 — the case that motivated this module: a pane that joined the channel over
// MCP/CLI stores an opaque spawn-stamped memberId, so the roster and the
// transcript printed `pty-…` for a pane the composer and the title bar both call
// `w1-1(claude)`. The principal coordinate on the member row is the bridge.

const CLAUDE = { name: 'Claude Code', slug: 'claude' as const };

function twoPaneWorkspace() {
  const leafA = createLeafPane(createSurface('ptyA', 'pwsh', ''), 1);
  const leafB = createLeafPane(createSurface('ptyB', 'pwsh', ''), 2);
  const root: Pane = {
    id: 'br',
    type: 'branch',
    direction: 'horizontal',
    children: [leafA, leafB],
    sizes: [50, 50],
  };
  const ws: Workspace = {
    id: 'ws-1',
    name: 'Backend',
    wsOrdinal: 1,
    nextPaneOrdinal: 3,
    rootPane: root,
    activePaneId: leafA.id,
  };
  return { ws, leafA, leafB };
}

function member(workspaceId: string, memberId: string, principalId?: string): ChannelMember {
  return {
    workspaceId,
    memberId,
    joinedAt: 0,
    historyFromSeq: 0,
    ...(principalId ? { principalId } : {}),
  };
}

describe('buildPaneNamesByPrincipal', () => {
  it('names every pane by principal, with the agent suffix and any user rename', () => {
    const { ws, leafA, leafB } = twoPaneWorkspace();
    const names = buildPaneNamesByPrincipal({
      workspaces: [ws],
      surfaceAgent: { ptyA: CLAUDE, ptyB: CLAUDE },
      paneLabel: { [leafB.id]: '  Reviewer  ' },
    });
    expect(names.get(panePrincipalId('ws-1', leafA.id))).toBe('w1-1(claude)');
    // A rename wins over the auto name and is trimmed (paneDisplayName).
    expect(names.get(panePrincipalId('ws-1', leafB.id))).toBe('Reviewer');
  });

  it('still names a pane whose agent has exited — coordinate only, no suffix', () => {
    const { ws, leafA } = twoPaneWorkspace();
    const names = buildPaneNamesByPrincipal({
      workspaces: [ws],
      surfaceAgent: {},
      paneLabel: {},
    });
    expect(names.get(panePrincipalId('ws-1', leafA.id))).toBe('w1-1');
  });
});

describe('paneNameForMember / paneNameForAuthor', () => {
  it('resolves an opaque MCP-joined memberId back to the pane display name', () => {
    const { ws, leafA } = twoPaneWorkspace();
    const names = buildPaneNamesByPrincipal({
      workspaces: [ws],
      surfaceAgent: { ptyA: CLAUDE },
      paneLabel: {},
    });
    const row = member('ws-1', 'pty-9f31c2ab', panePrincipalId('ws-1', leafA.id));
    expect(paneNameForMember(row, names)).toBe('w1-1(claude)');
    expect(
      paneNameForAuthor({ members: [row], names, workspaceId: 'ws-1', memberId: 'pty-9f31c2ab' }),
    ).toBe('w1-1(claude)');
  });

  it('returns undefined for a row with no principal, a dead pane, or no roster match', () => {
    const names = new Map<string, string>();
    expect(paneNameForMember(member('ws-1', 'legacy'), names)).toBeUndefined();
    const orphan = member('ws-1', 'gone', panePrincipalId('ws-1', 'pane-deleted'));
    expect(paneNameForMember(orphan, names)).toBeUndefined();
    expect(
      paneNameForAuthor({ members: [orphan], names, workspaceId: 'ws-1', memberId: 'someone-else' }),
    ).toBeUndefined();
  });
});

describe('paneNamesKey projection', () => {
  it('round-trips through parsePaneNamesKey and is stable across identical inputs', () => {
    const { ws, leafA } = twoPaneWorkspace();
    const sources = {
      workspaces: [ws],
      surfaceAgent: { ptyA: CLAUDE },
      paneLabel: { [leafA.id]: 'Deck brain' },
    };
    const key = paneNamesKey(sources);
    expect(paneNamesKey(sources)).toBe(key);
    expect(parsePaneNamesKey(key)).toEqual(buildPaneNamesByPrincipal(sources));
    expect(parsePaneNamesKey('').size).toBe(0);
  });
});
