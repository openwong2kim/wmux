// #2398 — what counts as on screen for starting a blank surface's shell.
import { describe, it, expect } from 'vitest';
import type { PaneLeaf, Workspace } from '../../../../shared/types';
import { isPaneDeferred, isSurfaceDrawnInLeaf, isSurfaceShown, isWorkspaceShown, resumesOnStart } from '../surfaceShown';

function leaf(id: string, surfaces: Array<Partial<PaneLeaf['surfaces'][number]> & { id: string }>, active: string): PaneLeaf {
  return { id, type: 'leaf', surfaces: surfaces.map((s) => ({ ptyId: '', title: s.id, shell: '', ...s })), activeSurfaceId: active } as PaneLeaf;
}

function ws(id: string, root: PaneLeaf, extra: Partial<Workspace> = {}): Workspace {
  return { id, name: id, rootPane: root, activePaneId: root.id, ...extra } as Workspace;
}

const A = ws('ws-a', leaf('pane-a', [{ id: 's-a' }], 's-a'));
const B = ws('ws-b', leaf('pane-b', [{ id: 's-b' }], 's-b'));

function state(over: Record<string, unknown> = {}) {
  return { workspaces: [A, B], activeWorkspaceId: A.id, multiviewIds: [] as string[], appRoute: 'workspaces' as const, botsWorkerPanel: null, ...over } as never;
}

describe('isWorkspaceShown', () => {
  it('the active workspace and the tiles of a drawn multiview grid', () => {
    expect(isWorkspaceShown(state(), A.id)).toBe(true);
    expect(isWorkspaceShown(state(), B.id)).toBe(false);
    expect(isWorkspaceShown(state({ multiviewIds: [A.id, B.id] }), B.id)).toBe(true);
    // The grid is not drawn unless the active workspace is one of its tiles.
    expect(isWorkspaceShown(state({ multiviewIds: [B.id, 'ws-c'] }), B.id)).toBe(false);
  });

  it('the workspace the Bots page hosts in its worker panel, only while Bots is the page', () => {
    const panel = { workspaceId: B.id, conversationId: 'c-1' };
    expect(isWorkspaceShown(state({ appRoute: 'bots', botsWorkerPanel: panel }), B.id)).toBe(true);
    expect(isWorkspaceShown(state({ appRoute: 'workspaces', botsWorkerPanel: panel }), B.id)).toBe(false);
  });
});

describe('isSurfaceDrawnInLeaf', () => {
  it('a stacked pane draws its active tab only', () => {
    const l = leaf('p', [{ id: 't1' }, { id: 't2' }], 't2');
    expect(isSurfaceDrawnInLeaf(l, 't2')).toBe(true);
    expect(isSurfaceDrawnInLeaf(l, 't1')).toBe(false);
  });

  it("a split draws its terminal column's tab even while the work area is expanded", () => {
    const l = leaf('p', [{ id: 't1' }, { id: 't2' }, { id: 'web', surfaceType: 'browser' }], 'web');
    expect(isSurfaceDrawnInLeaf(l, 't1')).toBe(true);
    expect(isSurfaceDrawnInLeaf(l, 't2')).toBe(false);
  });

  it('a split draws the terminal that last had the focus, as the pane does', () => {
    const l = { ...leaf('p', [{ id: 't1' }, { id: 't2' }, { id: 'edit', surfaceType: 'editor' }], 'edit'), splitTerminalId: 't2' };
    expect(isSurfaceDrawnInLeaf(l, 't2')).toBe(true);
    expect(isSurfaceDrawnInLeaf(l, 't1')).toBe(false);
  });
});

describe('isSurfaceShown', () => {
  it('needs both a shown workspace and a drawn surface; a stashed pane is not shown', () => {
    const stashedLeaf = leaf('pane-s', [{ id: 's-stashed' }], 's-stashed');
    const withStash = ws('ws-a', A.rootPane as PaneLeaf, { stashedPanes: [{ pane: stashedLeaf, stashedAt: 1 }] } as never);
    const s = state({ workspaces: [withStash, B] });
    expect(isSurfaceShown(s, A.id, 's-a')).toBe(true);
    expect(isSurfaceShown(s, B.id, 's-b')).toBe(false);
    expect(isSurfaceShown(s, A.id, 's-stashed')).toBe(false);
  });
});

describe('isPaneDeferred', () => {
  it('a pane whose terminals have no pty and no create is deferred; one creating or bound is not', () => {
    const blank = leaf('p', [{ id: 't1' }], 't1');
    expect(isPaneDeferred({ ptyCreateByKey: {}, ptyUnconfirmedById: {} }, blank)).toBe(true);
    expect(isPaneDeferred({ ptyCreateByKey: { t1: { state: 'creating' } }, ptyUnconfirmedById: {} }, blank)).toBe(false);
    expect(isPaneDeferred({ ptyCreateByKey: {}, ptyUnconfirmedById: {} }, leaf('p', [{ id: 't1', ptyId: 'pty-1' }], 't1'))).toBe(false);
    expect(isPaneDeferred({ ptyCreateByKey: {}, ptyUnconfirmedById: {} }, leaf('p', [{ id: 'web', surfaceType: 'browser' }], 'web'))).toBe(false);
  });
});

describe('resumesOnStart (owner decisions §6-2, §6-4 option B)', () => {
  const exact = (agent: string) => ({ agent, sessionId: '0c8f6a52-6c1b-4b6e-9a51-2f0d3c4b5a69', cwd: '/home/me/p' });

  it('only an exact Claude Code or Codex conversation, only with the setting on', () => {
    expect(resumesOnStart({ resumeAgent: 'claude', resumeBinding: exact('claude') }, true)).toBe(true);
    expect(resumesOnStart({ resumeAgent: 'codex', resumeBinding: exact('codex') }, true)).toBe(true);
    // The agent read off the binding alone (a suspended session's record).
    expect(resumesOnStart({ resumeBinding: exact('claude') }, true)).toBe(true);
    expect(resumesOnStart({ resumeAgent: 'claude', resumeBinding: exact('claude') }, false)).toBe(false);
    expect(resumesOnStart({}, true)).toBe(false);
    expect(resumesOnStart(undefined, true)).toBe(false);
  });

  it('never guesses a session: no binding, a binding for another agent, or a malformed id waits', () => {
    expect(resumesOnStart({ resumeAgent: 'claude' }, true)).toBe(false);
    expect(resumesOnStart({ resumeAgent: 'claude', resumeBinding: exact('codex') }, true)).toBe(false);
    expect(resumesOnStart({ resumeAgent: 'claude', resumeBinding: { agent: 'claude', sessionId: 'latest' } }, true)).toBe(false);
    expect(resumesOnStart({ resumeBinding: exact('aider') }, true)).toBe(false);
  });
});
