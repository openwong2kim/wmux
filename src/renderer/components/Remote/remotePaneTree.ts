/**
 * Split-tree layout for one remote workspace's panes (#1091 follow-up to
 * #1094's flat mirror grid — the fixed 6-cell grid never let a user choose
 * how panes are arranged or resize them, unlike a local workspace's own
 * split/resize).
 *
 * Deliberately independent of both:
 *  - `AttachedRemoteWorkspace.panes` (server truth: which sessions exist —
 *    `reconcile` below is the only bridge from that list into this tree)
 *  - the LOCAL pane tree (`shared/types.ts` `Pane`, `paneSlice.ts`) — a leaf
 *    here holds a remote sessionId, not a local PTY. Zero shared code, zero
 *    risk to local workspaces if this file has a bug.
 *
 * This tree is intentionally NOT persisted: it lives in `RemoteWorkspaceView`
 * component state only (rebuilt via `reconcile` from `workspace.panes` on
 * every change), matching the existing "panes are always re-fetched, never
 * restored from disk" rule for remote workspaces.
 */

export interface RemotePaneLeaf {
  id: string; // sessionId
  type: 'leaf';
}

export interface RemotePaneBranch {
  id: string;
  type: 'branch';
  direction: 'horizontal' | 'vertical';
  children: RemotePaneNode[];
  sizes?: number[];
}

export type RemotePaneNode = RemotePaneLeaf | RemotePaneBranch;

let branchCounter = 0;
function newBranchId(): string {
  branchCounter += 1;
  return `remote-branch-${branchCounter}`;
}

export function leafIds(node: RemotePaneNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return node.children.flatMap(leafIds);
}

export function findLeaf(node: RemotePaneNode, id: string): RemotePaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findLeaf(child, id);
    if (found) return found;
  }
  return null;
}

/** Split `targetId`'s leaf into a branch holding the old leaf plus a new one
 *  for `newId`, in the given direction. A no-op if `targetId` isn't in the
 *  tree (the pane it pointed at may have just closed under the user). */
export function splitLeaf(
  root: RemotePaneNode,
  targetId: string,
  newId: string,
  direction: 'horizontal' | 'vertical',
): RemotePaneNode {
  if (root.type === 'leaf') {
    if (root.id !== targetId) return root;
    return {
      id: newBranchId(),
      type: 'branch',
      direction,
      children: [{ id: targetId, type: 'leaf' }, { id: newId, type: 'leaf' }],
      sizes: [50, 50],
    };
  }
  return { ...root, children: root.children.map((c) => splitLeaf(c, targetId, newId, direction)) };
}

/** Remove one leaf. A branch left with a single child collapses into it —
 *  same discipline a local workspace's pane-close uses. Returns null when
 *  the whole tree was that one leaf. */
export function removeLeaf(root: RemotePaneNode, targetId: string): RemotePaneNode | null {
  if (root.type === 'leaf') return root.id === targetId ? null : root;
  const nextChildren = root.children
    .map((c) => removeLeaf(c, targetId))
    .filter((c): c is RemotePaneNode => c !== null);
  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) return nextChildren[0];
  if (nextChildren.length === root.children.length) return root; // nothing removed
  return { ...root, children: nextChildren, sizes: undefined };
}

/** Write fresh drag-resize sizes onto the branch with this id. A no-op if the
 *  branch already restructured out from under an in-flight resize. */
export function applySizes(root: RemotePaneNode, branchId: string, sizes: number[]): RemotePaneNode {
  if (root.type === 'leaf') return root;
  if (root.id === branchId) return { ...root, sizes };
  return { ...root, children: root.children.map((c) => applySizes(c, branchId, sizes)) };
}

/** Bring the tree in line with the server's current pane id list: drop
 *  leaves for sessions that closed elsewhere, append a leaf for any session
 *  the tree doesn't have yet (as a new root-level sibling — the user can
 *  split it into place). `paneIds` order matters only for first construction. */
export function reconcile(root: RemotePaneNode | null, paneIds: readonly string[]): RemotePaneNode | null {
  let next = root;
  const wanted = new Set(paneIds);

  if (next) {
    for (const id of leafIds(next)) {
      if (!wanted.has(id)) next = next ? removeLeaf(next, id) : null;
    }
  }

  const known = next ? new Set(leafIds(next)) : new Set<string>();
  for (const id of paneIds) {
    if (known.has(id)) continue;
    if (!next) {
      next = { id, type: 'leaf' };
    } else if (next.type === 'leaf') {
      next = { id: newBranchId(), type: 'branch', direction: 'horizontal', children: [next, { id, type: 'leaf' }] };
    } else {
      next = { ...next, children: [...next.children, { id, type: 'leaf' }], sizes: undefined };
    }
  }
  return next;
}
