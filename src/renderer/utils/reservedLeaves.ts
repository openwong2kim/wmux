// ─── Empty leaves another spawn is about to fill ───────────────────────────
//
// fanout.spawnWorkspace adds a workspace (its one leaf empty, and active)
// and only then awaits its worker's pty.create. Meanwhile EmptyLeafFunnel
// sees that empty leaf and starts a plain shell in it. Its orphan guard
// usually disposes that shell, but with WSL as the default shell both
// creates take the slow WSL probe and the shell could land first, leaving a
// stray home-folder pane beside the worker (#2231 Windows run 4). A leaf the
// spawn reserves is skipped by the funnel until the spawn releases it.

const reserved = new Set<string>();

/** Reserve an empty leaf for a spawn already on its way; returns the release. */
export function reserveLeaf(paneId: string): () => void {
  reserved.add(paneId);
  return () => {
    reserved.delete(paneId);
  };
}

/** Whether a spawn has reserved this leaf. */
export function isLeafReserved(paneId: string): boolean {
  return reserved.has(paneId);
}
