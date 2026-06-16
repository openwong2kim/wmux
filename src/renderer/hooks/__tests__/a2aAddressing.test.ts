import { describe, it, expect } from 'vitest';
import type { PaneLeaf, Surface } from '../../../shared/types';
import { resolvePaneAddress, activePaneTerminalPty, decideSameWsSend, isTerminalPtyInLeaves, resolveSelfPaneIdentity } from '../a2aAddressing';

function surface(id: string, ptyId: string, surfaceType: Surface['surfaceType'] = 'terminal'): Surface {
  return { id, ptyId, title: id, shell: '', cwd: '', surfaceType } as Surface;
}
function leaf(id: string, surfaces: Surface[], activeSurfaceId?: string): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId: activeSurfaceId ?? surfaces[0]?.id ?? '' };
}

// Target workspace: two panes, each with a distinct agent terminal.
const leaves: PaneLeaf[] = [
  leaf('pane-A', [surface('surf-A', 'pty-A')]),
  leaf('pane-B', [surface('surf-B1', 'pty-B1'), surface('surf-B2', 'pty-B2')], 'surf-B2'),
  leaf('pane-browser', [surface('surf-web', 'pty-web', 'browser')]),
];

describe('resolvePaneAddress', () => {
  it('resolves surface_id → that surface only', () => {
    expect(resolvePaneAddress(leaves, '', 'surf-B1')).toEqual({ ptyId: 'pty-B1', paneId: 'pane-B', surfaceId: 'surf-B1' });
  });

  it('resolves pane_id → the leaf active terminal surface', () => {
    // pane-B's activeSurfaceId is surf-B2.
    expect(resolvePaneAddress(leaves, 'pane-B', '')).toEqual({ ptyId: 'pty-B2', paneId: 'pane-B', surfaceId: 'surf-B2' });
  });

  it('resolves pane_id → first terminal surface when active is not a terminal', () => {
    const ls = [leaf('p', [surface('web', 'pw', 'browser'), surface('t', 'pt')], 'web')];
    expect(resolvePaneAddress(ls, 'p', '')).toEqual({ ptyId: 'pt', paneId: 'p', surfaceId: 't' });
  });

  it('REJECTS when pane_id and surface_id disagree (no silent pick)', () => {
    const r = resolvePaneAddress(leaves, 'pane-A', 'surf-B1');
    expect('error' in r && r.error).toMatch(/does not belong to pane_id/);
  });

  it('REJECTS a browser surface (not a terminal)', () => {
    const r = resolvePaneAddress(leaves, '', 'surf-web');
    expect('error' in r && r.error).toMatch(/not a terminal/);
  });

  it('FAIL-CLOSED: a cross-ws / unknown surface_id is not found (only target leaves searched)', () => {
    const r = resolvePaneAddress(leaves, '', 'surf-from-other-ws');
    expect('error' in r && r.error).toMatch(/not found in target workspace/);
  });

  it('FAIL-CLOSED: an unknown pane_id is not found', () => {
    const r = resolvePaneAddress(leaves, 'pane-from-other-ws', '');
    expect('error' in r && r.error).toMatch(/not found in target workspace/);
  });

  it('REJECTS a pane with no terminal surface', () => {
    const ls = [leaf('only-browser', [surface('web', 'pw', 'browser')])];
    const r = resolvePaneAddress(ls, 'only-browser', '');
    expect('error' in r && r.error).toMatch(/no terminal surface/);
  });
});

describe('activePaneTerminalPty', () => {
  it('returns the active leaf first terminal pty', () => {
    expect(activePaneTerminalPty(leaves, 'pane-B')).toBe('pty-B1');
  });
  it('falls back to the first leaf with a terminal when active id is unknown', () => {
    expect(activePaneTerminalPty(leaves, 'nonexistent')).toBe('pty-A');
  });
  it('returns null when no terminal surface exists', () => {
    expect(activePaneTerminalPty([leaf('p', [surface('w', 'pw', 'browser')])], 'p')).toBeNull();
  });
});

describe('decideSameWsSend', () => {
  it('cross-workspace send always delivers loud (path unchanged)', () => {
    expect(decideSameWsSend(false, 'pty-X', '')).toEqual({ kind: 'deliver', suppressPaste: false });
    expect(decideSameWsSend(false, undefined, 'pty-self')).toEqual({ kind: 'deliver', suppressPaste: false });
  });

  it('same-ws with NO resolved address is rejected (ambiguous → would loop to self)', () => {
    const r = decideSameWsSend(true, undefined, 'pty-self');
    expect(r.kind).toBe('reject');
    expect(r.kind === 'reject' && r.error).toMatch(/without addressing a specific pane/);
  });

  it('same-ws addressing the sender\'s OWN pane is rejected (true self-send loop)', () => {
    const r = decideSameWsSend(true, 'pty-self', 'pty-self');
    expect(r.kind).toBe('reject');
    expect(r.kind === 'reject' && r.error).toMatch(/your own pane/);
  });

  it('same-ws sibling pane with a VERIFIED sender pty delivers loud', () => {
    // senderPtyId present and ≠ target → proven not-self → loud paste allowed.
    expect(decideSameWsSend(true, 'pty-sibling', 'pty-self')).toEqual({ kind: 'deliver', suppressPaste: false });
  });

  it('same-ws sibling pane with an ABSENT sender pty delivers SILENT (fail-closed paste)', () => {
    // Common pid-map-miss / env-hint case: we cannot prove the target isn't self,
    // so suppress the paste (task still persisted + pollable) — never a loop.
    expect(decideSameWsSend(true, 'pty-sibling', '')).toEqual({ kind: 'deliver', suppressPaste: true });
  });
});

describe('isTerminalPtyInLeaves', () => {
  it('accepts a real terminal pty in the tree', () => {
    expect(isTerminalPtyInLeaves(leaves, 'pty-A')).toBe(true);
    expect(isTerminalPtyInLeaves(leaves, 'pty-B2')).toBe(true);
  });
  it('rejects a browser-surface pty (not a terminal)', () => {
    expect(isTerminalPtyInLeaves(leaves, 'pty-web')).toBe(false);
  });
  it('rejects a foreign/unknown pty and the empty string', () => {
    expect(isTerminalPtyInLeaves(leaves, 'pty-from-other-ws')).toBe(false);
    expect(isTerminalPtyInLeaves(leaves, '')).toBe(false);
  });
});

describe('resolveSelfPaneIdentity (a2a_whoami pane-level)', () => {
  const agents: Record<string, { name?: string; status?: string }> = {
    'pty-A': { name: 'Claude Code', status: 'working' },
    'pty-B1': { name: 'Codex', status: 'idle' },
  };
  const agentFor = (ptyId: string) => agents[ptyId];

  it('resolves a verified senderPtyId to its OWN pane + per-pane agent', () => {
    expect(resolveSelfPaneIdentity(leaves, agentFor, 'pty-A')).toEqual({
      ptyId: 'pty-A', paneId: 'pane-A', surfaceId: 'surf-A',
      agentName: 'Claude Code', agentStatus: 'working',
    });
  });

  it('two sibling ptyIds resolve to DIFFERENT panes (the divergence fix)', () => {
    const a = resolveSelfPaneIdentity(leaves, agentFor, 'pty-A');
    const b = resolveSelfPaneIdentity(leaves, agentFor, 'pty-B1');
    expect(a?.paneId).toBe('pane-A');
    expect(b?.paneId).toBe('pane-B');
    expect(a?.agentName).not.toBe(b?.agentName);
  });

  it('degrades to null for an ABSENT senderPtyId (caller falls back to ws-level)', () => {
    expect(resolveSelfPaneIdentity(leaves, agentFor, '')).toBeNull();
  });

  it('degrades to null for a FOREIGN/unknown senderPtyId (fail-closed, never echo)', () => {
    expect(resolveSelfPaneIdentity(leaves, agentFor, 'pty-from-other-ws')).toBeNull();
  });

  it('does not resolve a browser-surface pty (terminal only)', () => {
    expect(resolveSelfPaneIdentity(leaves, agentFor, 'pty-web')).toBeNull();
  });

  it('returns null agent fields when the resolved pane has no detected agent', () => {
    // pty-B2 is a real terminal surface but absent from the agent map.
    expect(resolveSelfPaneIdentity(leaves, agentFor, 'pty-B2')).toEqual({
      ptyId: 'pty-B2', paneId: 'pane-B', surfaceId: 'surf-B2',
      agentName: null, agentStatus: null,
    });
  });
});
