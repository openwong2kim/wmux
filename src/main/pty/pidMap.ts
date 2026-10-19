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
 *
 * A pane has one live shell, so a ptyId keeps exactly one PID: any other file
 * pointing at the same ptyId is an earlier shell of that pane (a daemon
 * restart respawns a recovered session with a new PID, and the reconnect
 * writes it here) and is removed first. Left behind, the OS hands that old PID
 * to an unrelated process, and an MCP server whose ancestry includes it (a new
 * worker's own claude.exe) resolves to the old pane's identity.
 */
export function writePidMap(pid: string | number, ptyId: string): void {
  try {
    const dir = getPidMapDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const name = String(pid);
    if (ptyId) {
      for (const file of fs.readdirSync(dir)) {
        if (file === name) continue;
        try {
          if (fs.readFileSync(path.join(dir, file), 'utf8').trim() === ptyId) {
            fs.unlinkSync(path.join(dir, file));
          }
        } catch { /* unreadable / racing-unlink — skip */ }
      }
    }
    fs.writeFileSync(path.join(dir, name), ptyId, 'utf8');
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

/**
 * The fields of a `daemon.listSessions` row the pid-map checks read. `pid` and
 * `state` stay `unknown` because they come straight off the RPC.
 */
export interface DaemonSessionShell {
  id: string;
  pid?: unknown;
  state?: unknown;
}

/** One pid-map file: its name (the PID) and its content (the ptyId). */
export interface PidMapFile {
  pid: string;
  ptyId: string;
}

/** Daemon-mode ptyIds (see pty.handler.ts `pty:create`). Local PTYManager ids and legacy `ws-` content are not. */
export function isDaemonPtyId(ptyId: string): boolean {
  return ptyId.startsWith('daemon-');
}

/**
 * The PID of a daemon session's running shell, as the daemon reports it:
 *  - a number: the session is live (attached/detached) and names its shell;
 *  - null: the session has no running shell. `dead` and `suspended` rows keep
 *    the PID of the shell that ended (a tombstone, or a recovery still
 *    pending), and that PID is free for the OS to hand to anyone;
 *  - undefined: live, but the row carries no usable PID. Nothing is decided.
 */
function runningShellPid(session: DaemonSessionShell): number | null | undefined {
  if (session.state === 'dead' || session.state === 'suspended') return null;
  const pid = session.pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function sessionsById(sessions: readonly DaemonSessionShell[]): Map<string, DaemonSessionShell> {
  const byId = new Map<string, DaemonSessionShell>();
  for (const s of sessions) {
    if (s && typeof s.id === 'string') byId.set(s.id, s);
  }
  return byId;
}

/**
 * The pid-map files that no longer name a daemon session's running shell,
 * judged against the daemon's COMPLETE session list:
 *  - the ptyId is not in the list (the session is gone);
 *  - the session has no running shell (dead / suspended);
 *  - the session's shell PID is known and is not the file's PID (an earlier
 *    shell of that pane; a daemon restart gives every recovered session a new
 *    one).
 * Kept: non-daemon content (local PTYManager panes, legacy `ws-` files; both
 * are handled elsewhere) and a live session whose row carries no PID.
 *
 * Pure: returns the file names (PIDs) to remove.
 */
export function staleDaemonPidFiles(
  files: readonly PidMapFile[],
  sessions: readonly DaemonSessionShell[],
): string[] {
  const byId = sessionsById(sessions);
  const stale: string[] = [];
  for (const f of files) {
    if (!isDaemonPtyId(f.ptyId)) continue;
    const session = byId.get(f.ptyId);
    if (!session) {
      stale.push(f.pid);
      continue;
    }
    const shellPid = runningShellPid(session);
    if (shellPid === undefined) continue;
    if (shellPid === null || String(shellPid) !== f.pid) stale.push(f.pid);
  }
  return stale;
}

/** Every pid-map file with its content, or [] when there is no map. Best-effort. */
export function readPidMapFiles(): PidMapFile[] {
  const out: PidMapFile[] = [];
  try {
    const dir = getPidMapDir();
    if (!fs.existsSync(dir)) return out;
    for (const file of fs.readdirSync(dir)) {
      try {
        const ptyId = fs.readFileSync(path.join(dir, file), 'utf8').trim();
        if (ptyId) out.push({ pid: file, ptyId });
      } catch { /* unreadable / racing-unlink — skip */ }
    }
  } catch { /* best-effort */ }
  return out;
}

/**
 * Remove the pid-map files that `staleDaemonPidFiles` finds stale against the
 * daemon's complete session list `live`. `files` is the map as read BEFORE
 * that list was fetched (defaults to reading it now). A file is removed only
 * while it still holds the content it was judged on, so one rewritten in the
 * meantime is left alone. Returns how many files were removed.
 */
export function pruneDaemonPidMap(
  live: readonly DaemonSessionShell[],
  files: readonly PidMapFile[] = readPidMapFiles(),
): number {
  let removed = 0;
  try {
    const dir = getPidMapDir();
    const judged = new Map(files.map((f) => [f.pid, f.ptyId]));
    for (const pid of staleDaemonPidFiles(files, live)) {
      const file = path.join(dir, pid);
      try {
        if (fs.readFileSync(file, 'utf8').trim() !== judged.get(pid)) continue;
        fs.unlinkSync(file);
        removed++;
      } catch { /* already gone / unreadable — skip */ }
    }
  } catch { /* best-effort */ }
  return removed;
}

/**
 * Startup prune, run each time main connects to the daemon (the first connect
 * and every reconnect after a daemon respawn). The daemon only answers once its
 * session recovery is done, so the list it returns is complete. A respawn is
 * exactly when every recovered session got a new shell PID and the old PIDs'
 * files went stale.
 *
 * The map is read BEFORE the session list is fetched. A pane created while the
 * RPC is in flight writes its file after its session exists, so the file is
 * either missing from the snapshot or its session is in the list. Reading the
 * map afterwards could catch such a file without its session and remove a
 * live pane's anchor, which `pty:create` never writes again.
 *
 * `listSessions` should include suspended sessions. Any failure, or an answer
 * that is not a list, removes nothing.
 */
export async function pruneDaemonPidMapAtConnect(
  listSessions: () => Promise<unknown>,
): Promise<number> {
  const files = readPidMapFiles().filter((f) => isDaemonPtyId(f.ptyId));
  if (files.length === 0) return 0;
  let sessions: unknown;
  try {
    sessions = await listSessions();
  } catch {
    return 0;
  }
  if (!Array.isArray(sessions)) return 0;
  return pruneDaemonPidMap(sessions as DaemonSessionShell[], files);
}

/**
 * Resolve-time check for `a2a.resolve.identity`: keep a pid-map entry only if
 * its PID can still be the pane's shell. An entry for a daemon ptyId is
 * dropped when the daemon does not have that session, reports it with no
 * running shell (dead / suspended), or reports a known shell PID that is not
 * the entry's PID. Each is a leftover file whose PID the OS may have given to
 * another process (a new worker's own claude.exe), which would otherwise
 * claim the old pane. A missed or failed startup prune leaves such files.
 *
 * `sessions` must be the daemon's COMPLETE list (suspended sessions
 * included), read after the entries' files were: `pty:create` writes a file
 * only once its session exists, so a ptyId missing from that list is gone.
 * The caller re-reads the list rather than judge against a cached one that
 * predates the file.
 *
 * Kept as is:
 *  - everything, when `sessions` is null (the daemon is not connected or did
 *    not answer). Identity keeps working on the pid-map alone, as it did
 *    before this check; refusing every pane while the daemon is unreachable
 *    would break far more than the stale files can. The write-time and
 *    startup prunes still bound those files.
 *  - non-daemon entries (local PTYManager panes).
 *  - a live session whose row carries no PID.
 */
export function liveDaemonPidEntries<T extends PidMapFile>(
  entries: readonly T[],
  sessions: readonly DaemonSessionShell[] | null,
): T[] {
  if (!sessions) return [...entries];
  const byId = sessionsById(sessions);
  return entries.filter((e) => {
    if (!isDaemonPtyId(e.ptyId)) return true;
    const session = byId.get(e.ptyId);
    if (!session) return false;
    const shellPid = runningShellPid(session);
    if (shellPid === undefined) return true;
    return shellPid !== null && String(shellPid) === e.pid;
  });
}
