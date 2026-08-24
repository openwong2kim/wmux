/**
 * RPC contract for stashed panes (#977).
 *
 * useRpcBridge pulls in the store and `window`, so it cannot be imported under
 * vitest — every routing invariant in this file is pinned in SOURCE, the same
 * way useRpcBridge.focus / .workspaceClose / .a2aPaneIdentity already are. The
 * pure pieces these handlers delegate to (the refusal shape, the liveness
 * derivation, the surface allow-list) are tested behaviorally in
 * shared/__tests__/paneStash.test.ts.
 *
 * The rule the whole surface turns on: a stashed pane is an ADDRESS you can
 * still reach, not a POSITION you can still act on. Writing, reading, closing
 * and A2A delivery keep working because the PTY is alive in the daemon and none
 * of them need to know where the pane sits. Focusing does not, and says so with
 * a refusal that names the fix.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(
  path.join(__dirname, '..', 'useRpcBridge.ts'),
  'utf-8',
);

function region(startMarker: string, endMarker: string): string {
  const match = source.match(new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`));
  if (!match) {
    throw new Error(`${startMarker} -> ${endMarker} not found in useRpcBridge.ts — update the regex if the layout changed.`);
  }
  return match[0];
}

describe('list membership is opt-in', () => {
  it.each([
    ['pane.list', "method === 'pane\\.list'", "method === 'pane\\.focus'"],
    ['surface.list', "method === 'surface\\.list'", "method === 'surface\\.new'"],
  ])('%s defaults to the visible tree and widens only on includeStashed', (_name, start, end) => {
    const block = region(start, end);
    // Changing WHO is in a list is not a forward-compatible change the way
    // adding a field is: an existing client reading this array as "what is on
    // screen" would silently start acting on panes it cannot see.
    expect(block).toMatch(/const includeStashed = params\.includeStashed === true;/);
    expect(block).toMatch(/includeStashed \? getWorkspaceLeafPanes\(ws\) : findLeafPanes\(ws\.rootPane\)/);
  });

  it('pane.list stamps an explicit boolean on EVERY row', () => {
    const block = region("method === 'pane\\.list'", "method === 'pane\\.focus'");
    // "key absent" and "false" must not be the same wire shape, or a client has
    // to guess whether it is talking to a build that knows about stashing.
    expect(block).toMatch(/stashed: isStashed,/);
    expect(block).toMatch(/stashedLiveness: stashedPaneLiveness\(l\)/);
    // A stashed pane is never the workspace's active pane on screen.
    expect(block).toMatch(/active: !isStashed && l\.id === ws\.activePaneId/);
  });

  it('surface.list never reports an off-screen surface as active', () => {
    const block = region("method === 'surface\\.list'", "method === 'surface\\.new'");
    expect(block).toMatch(/isActive: !stashedIds\.has\(leaf\.id\) && s\.id === leaf\.activeSurfaceId/);
    expect(block).toMatch(/stashed: stashedIds\.has\(leaf\.id\)/);
  });
});

describe('position operations refuse with an actionable error', () => {
  it('pane.focus answers a stashed target with PANE_STASHED', () => {
    const block = region("method === 'pane\\.focus'", "method === 'pane\\.split'");
    expect(block).toContain("paneStashedError('pane.focus', paneId)");
  });

  it('surface.focus answers a stashed target with PANE_STASHED', () => {
    const block = region("method === 'surface\\.focus'", "method === 'pane\\.close'");
    expect(block).toContain("paneStashedError('surface.focus'");
  });

  it('does NOT auto-unstash on an agent\'s behalf', () => {
    // An agent rearranging the user's layout as a side effect of a focus call is
    // the same class of surprise this feature exists to remove. The in-app jump
    // surfaces DO unstash — because a human clicked "take me to this pane".
    const block = region("method === 'pane\\.focus'", "method === 'pane\\.split'");
    expect(block).not.toMatch(/store\.unstashPane\(/);
  });
});

describe('address operations reach a stashed pane', () => {
  it('pane.close resolves across the whole workspace', () => {
    const block = region("method === 'pane\\.close'", "method === 'surface\\.close'");
    // An API that hands you an id in pane.list and then cannot close it is a
    // leak with extra steps.
    expect(block).toMatch(/findOwnedPane\(store\.workspaces, paneId\)/);
    expect(block).not.toMatch(/for \(const ws of store\.workspaces\)/);
  });

  it('surface.close resolves across the whole workspace', () => {
    const block = region("method === 'surface\\.close'", "method === 'pane\\.list'");
    expect(block).toMatch(/findOwnedSurface\(store\.workspaces,\s*surfaceId\)/);
  });

  it('input.findOwnerWorkspace does not reject a stashed pty as foreign', () => {
    const block = region("method === 'input\\.findOwnerWorkspace'", "method === 'input\\.readScreen'");
    // This is the gate main uses for input.send. A visible-tree walk would
    // reject writes to a stashed agent with a FALSE security message ("PTY not
    // owned by workspace … cross-workspace terminal access is not allowed")
    // about a pane the workspace does own.
    expect(block).toMatch(/const leaves = getWorkspaceLeafPanes\(ws\);/);
  });

  it('input.readScreen ownership check is workspace-wide', () => {
    const block = region("method === 'input\\.readScreen'", "method === 'input\\.getActivePtyId'");
    expect(block).toMatch(/getWorkspaceLeafPanes\(targetWs\)\.some/);
  });

  it('a2a.discover lists stashed panes as addressable', () => {
    const block = region("method === 'a2a\\.discover'", "method === 'a2a\\.task\\.send'");
    // pane_list and a2a_discover are read side by side as the same address
    // source. A pane in one and not the other reads as "it disappeared", and
    // acting on that is a silent misroute.
    expect(block).toMatch(/for \(const leaf of getWorkspaceLeafPanes\(w\)\)/);
  });

  it('no A2A address resolution is left scoped to the visible tree', () => {
    // The delivery / reply / pin coordinates. A stashed pane dropping out of any
    // one of them produces "pinned target pane is gone" for a pane that is
    // running and reachable.
    expect(source).not.toMatch(/resolvePaneAddress\(findLeafPanes\(/);
    expect(source).not.toMatch(/isTerminalPtyInLeaves\(\s*findLeafPanes\(/);
    expect(source).not.toMatch(/activePaneTerminalPty\(findLeafPanes\(/);
  });

  it('workspace.close disposes stashed PTYs', () => {
    const block = region("method === 'workspace\\.close'", "method === 'workspace\\.current'");
    expect(block).toMatch(/getWorkspacePtyIds\(ws\)/);
  });
});

describe('pane.stash / pane.unstash', () => {
  it('stash delegates every guard to the slice', () => {
    const block = region("method === 'pane\\.stash'", "method === 'pane\\.unstash'");
    expect(block).toMatch(/store\.stashPane\(paneId, owned\.ws\.id\)/);
    // Already stashed is a success, not an error.
    expect(block).toMatch(/if \(owned\.stashed\) return \{ ok: true, stashed: true \}/);
    // The refusal names all three reasons — an agent cannot see the toast.
    expect(block).toContain('only visible pane');
    expect(block).toContain('daemon is not connected');
    expect(block).toContain('editor/diff tab');
  });

  it.each([
    ['pane.stash', "method === 'pane\\.stash'", "method === 'pane\\.unstash'"],
    ['pane.unstash', "method === 'pane\\.unstash'", "method === 'surface\\.close'"],
  ])('%s refuses a pane outside the commander workspace', (name, start, end) => {
    // Both take a globally-unique paneId the renderer resolves across ALL
    // workspaces, and both are on COMMANDER_TOOL_SURFACE. Without this check a
    // validated commander could rearrange another workspace's layout — the
    // §4.0 blast-radius invariant that pane.focus and pane.split already hold.
    const block = region(start, end);
    expect(block).toMatch(/readConfineWorkspaceId\(params\)/);
    expect(block).toMatch(/owned\.ws\.id !== \w+Confine/);
    expect(block).toContain(`${name}: pane \${paneId} is outside the commander`);
  });

  it('unstash is idempotent — the retry it asks for must always be safe', () => {
    const block = region("method === 'pane\\.unstash'", "method === 'surface\\.close'");
    expect(block).toMatch(/if \(!owned\.stashed\) return \{ ok: true, stashed: false \}/);
    expect(block).toMatch(/store\.unstashPane\(paneId, owned\.ws\.id\)/);
  });
});
