import { describe, it, expect } from 'vitest';
import { walkToOwningAnchor, type OwningAnchor } from '../serverSidePidWalk';

function anchors(entries: Record<number, OwningAnchor>): Map<number, OwningAnchor> {
  return new Map(Object.entries(entries).map(([pid, a]) => [Number(pid), a]));
}
function ppids(entries: Record<number, number>): Map<number, number> {
  return new Map(Object.entries(entries).map(([pid, ppid]) => [Number(pid), ppid]));
}
const SHELL: OwningAnchor = { ptyId: 'daemon-shell', workspaceId: 'ws-live' };

describe('walkToOwningAnchor — server-side ancestor walk', () => {
  it('resolves a Codex chain MCP→codex→node→shell to the shell anchor (the live measured shape)', () => {
    // Measured live (.wmux-dev): Codex MCP(39876) → codex(25020) → node(40452)
    // → powershell shell(49076) which the pid-map anchors to a live pane.
    const ppidByPid = ppids({ 39876: 25020, 25020: 40452, 40452: 49076, 49076: 57454 });
    const anchorByPid = anchors({ 49076: SHELL });

    const hit = walkToOwningAnchor(39876, ppidByPid, anchorByPid);

    expect(hit).toEqual({ anchor: SHELL, pid: 49076, depth: 3 });
  });

  it('hits at depth 0 when startPid is itself an anchor', () => {
    const hit = walkToOwningAnchor(49076, ppids({ 49076: 57454 }), anchors({ 49076: SHELL }));
    expect(hit).toEqual({ anchor: SHELL, pid: 49076, depth: 0 });
  });

  it('returns null on a miss — the chain reaches a root with no anchor', () => {
    // MCP → claude → electron(root, ppid=1). No ancestor is an anchor.
    const ppidByPid = ppids({ 100: 200, 200: 300, 300: 1 });
    const hit = walkToOwningAnchor(100, ppidByPid, anchors({ 999: SHELL }));
    expect(hit).toBeNull();
  });

  it('returns the CLOSEST anchor when several ancestors are anchors', () => {
    const ppidByPid = ppids({ 10: 20, 20: 30, 30: 40 });
    const near: OwningAnchor = { ptyId: 'pty-near', workspaceId: 'ws-near' };
    const far: OwningAnchor = { ptyId: 'pty-far', workspaceId: 'ws-far' };
    const hit = walkToOwningAnchor(10, ppidByPid, anchors({ 20: near, 40: far }));
    expect(hit).toEqual({ anchor: near, pid: 20, depth: 1 });
  });

  it('terminates (no infinite loop) on a cyclic parent table and still finds an anchor before the cycle', () => {
    // 10 → 20 → 30 → 20 (cycle). Anchor at 30 is reached before the loop closes.
    const ppidByPid = ppids({ 10: 20, 20: 30, 30: 20 });
    const hit = walkToOwningAnchor(10, ppidByPid, anchors({ 30: SHELL }));
    expect(hit).toEqual({ anchor: SHELL, pid: 30, depth: 2 });
  });

  it('returns null (does not hang) on a cycle with no anchor', () => {
    const ppidByPid = ppids({ 10: 20, 20: 30, 30: 10 });
    expect(walkToOwningAnchor(10, ppidByPid, anchors({}))).toBeNull();
  });

  it('respects maxDepth — an anchor beyond the cap is not reached', () => {
    const ppidByPid = ppids({ 1: 2, 2: 3, 3: 4, 4: 5 });
    const anchorByPid = anchors({ 5: SHELL }); // depth 4 from pid 1
    expect(walkToOwningAnchor(1, ppidByPid, anchorByPid, { maxDepth: 2 })).toBeNull();
    expect(walkToOwningAnchor(1, ppidByPid, anchorByPid, { maxDepth: 4 })).toEqual({
      anchor: SHELL,
      pid: 5,
      depth: 4,
    });
  });

  it('stops at a non-positive / root parent without matching anything', () => {
    // 50 → 0 (root sentinel). 0 is never walked into.
    expect(walkToOwningAnchor(50, ppids({ 50: 0 }), anchors({ 0: SHELL }))).toBeNull();
  });

  it('stops on a self-parent without looping', () => {
    expect(walkToOwningAnchor(4, ppids({ 4: 4 }), anchors({}))).toBeNull();
  });

  it('returns null for an invalid startPid', () => {
    const ppidByPid = ppids({ 10: 20 });
    const anchorByPid = anchors({ 20: SHELL });
    expect(walkToOwningAnchor(0, ppidByPid, anchorByPid)).toBeNull();
    expect(walkToOwningAnchor(-5, ppidByPid, anchorByPid)).toBeNull();
    expect(walkToOwningAnchor(NaN, ppidByPid, anchorByPid)).toBeNull();
    expect(walkToOwningAnchor(1.5, ppidByPid, anchorByPid)).toBeNull();
  });

  it('returns null when the start pid is absent from the process table (no parent to follow)', () => {
    // startPid not in ppidByPid and not an anchor → immediate miss.
    expect(walkToOwningAnchor(777, ppids({ 1: 0 }), anchors({ 888: SHELL }))).toBeNull();
  });
});
