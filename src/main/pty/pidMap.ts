import fs from 'node:fs';
import path from 'node:path';
import { getPidMapDir } from '../../shared/constants';

/**
 * PID ↔ ptyId on-disk map (~/.wmux/pid-map/<PID> → ptyId).
 *
 * This is the anchor MCP uses to resolve workspace identity when env vars don't
 * propagate to Claude Code's MCP child processes. The fs primitives live here —
 * free of electron / daemon imports — so they can be behavior-tested directly
 * (the pty.handler module they're called from pulls in electron and can't be
 * imported under vitest, which is why its other tests are source-structural).
 */

/**
 * Write a PID → ptyId mapping for MCP workspace-identity resolution.
 *
 * We deliberately store the ptyId, NOT the workspaceId: a workspace id can be
 * re-minted (daemon respawn / session restore) while the shell process lives
 * on, so a frozen workspace id goes stale. The ptyId is immutable for the
 * process lifetime; `a2a.resolve.identity` maps ptyId → the CURRENT owning
 * workspace at lookup time. (Claude Code doesn't propagate env vars to MCP
 * child processes, so this on-disk map is the resolution anchor.)
 */
export function writePidMap(pid: string | number, ptyId: string): void {
  try {
    const dir = getPidMapDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, String(pid)), ptyId, 'utf8');
  } catch { /* best-effort */ }
}

/**
 * Remove every pid-map file pointing at `ptyId`. Pruned at the WRITE boundary
 * instead of on the read hot-path. Daemon sessions otherwise leak a file per
 * shell forever (writePidMap has no PID-keyed remove pair here, unlike
 * PTYManager.dispose), which let the OS recycle those PIDs onto unrelated
 * processes — the accretion behind the ghost-workspace bug.
 *
 * Called from BOTH daemon-owned teardown paths (in pty.handler.ts):
 *  - session:died (onDaemonSessionDied): natural/unexpected PTY exit.
 *  - pty:dispose: explicit close (pane/workspace close) → daemon.destroySession,
 *    which emits session:destroyed — NOT session:died — so the died handler
 *    never fires for it. Without pruning here too, every UI-driven close (the
 *    common path) would still leak its anchor.
 *
 * Keyed by ptyId (content) because the session:died payload and the dispose
 * arg both carry the sessionId/ptyId, not the OS PID. Matching by filename
 * (the PID) instead would miss recycled-PID entries and let the ghost
 * accretion return.
 */
export function removePidMapByPtyId(ptyId: string): void {
  if (!ptyId) return;
  try {
    const dir = getPidMapDir();
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      try {
        if (fs.readFileSync(path.join(dir, file), 'utf8').trim() === ptyId) {
          fs.unlinkSync(path.join(dir, file));
        }
      } catch { /* unreadable / racing-unlink — skip */ }
    }
  } catch { /* best-effort */ }
}
