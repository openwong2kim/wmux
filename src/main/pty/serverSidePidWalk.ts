/**
 * Server-side process-tree walk for MCP workspace-identity resolution.
 *
 * The PROPER fix for the multi-agent identity problem (Codex especially). An
 * MCP server resolves "which workspace am I?" by finding, among its process-tree
 * ancestors, the shell PID that the pid-map anchors to a live pane. Historically
 * that walk ran CLIENT-side, inside the MCP child: it spawned a PowerShell
 * `Get-CimInstance` per hop to read each parent PID. Two things break it:
 *   - Codex SANDBOXES the MCP child, denying the per-hop PowerShell spawn past
 *     the first (free) `process.ppid` hop, so the walk never reaches the shell.
 *   - Codex also STRIPS the env hints (WMUX_WORKSPACE_ID / WMUX_PTY_ID), so the
 *     env fallback that rescues Claude is empty too — identity stays unknown.
 *
 * Moving the walk to the main process (where this module runs) sidesteps both:
 * main is unsandboxed and already takes a full `Win32_Process` snapshot for the
 * port watcher, so the whole ancestor chain is available in-memory. The MCP
 * sends its own pid as `callerPid`; we walk UP from there to the first ancestor
 * that is a known live anchor and hand the resolved identity straight back.
 *
 * This module is the PURE core of that walk — no I/O, no electron — so it can be
 * behavior-tested directly. The caller (a2a.rpc.ts) supplies the two maps:
 *   - `ppidByPid`   : child pid → parent pid for every live process (the port
 *                     watcher's snapshot, reused — see portWatch.ts).
 *   - `anchorByPid` : shell pid → its owning {ptyId, workspaceId}, built from the
 *                     pid-map entries already live-resolved this request, so dead
 *                     and recycled anchors are excluded by construction.
 */

export interface OwningAnchor {
  /** Immutable per-process pane anchor (node-pty shell pid → ptyId). */
  ptyId: string;
  /** The workspace that owns `ptyId` RIGHT NOW (resolved live by the caller). */
  workspaceId: string;
}

export interface PidWalkHit {
  anchor: OwningAnchor;
  /** The ancestor PID that matched an anchor (the owning shell). */
  pid: number;
  /** Hops from `startPid` to the match (0 = `startPid` itself is the anchor). */
  depth: number;
}

/**
 * Default hop cap. The measured real chain is shallow — a Codex MCP reaches its
 * pane shell in 3 hops (MCP → codex → node → shell) — so this is generous
 * headroom, not a tight bound. It is a backstop against a pathologically deep or
 * corrupt parent chain; the visited-set below already guarantees termination, so
 * the cap only limits how far we bother looking before giving up.
 */
const DEFAULT_MAX_DEPTH = 16;

/**
 * Walk the process tree upward from `startPid`, returning the FIRST (closest)
 * ancestor that is a live anchor, or null if none is reachable within the cap.
 *
 * "Closest wins" is correct: the nearest shell ancestor is the pane that owns
 * the caller. A higher shell (were there ever a nested one) is a less-specific
 * owner, so stopping at the first hit gives the right answer.
 *
 * Termination is guaranteed three ways, so a malformed `ppidByPid` (a cycle, a
 * self-parent, a PID 0/4 root) can never loop forever:
 *   1. `visited` short-circuits any cycle.
 *   2. A parent <= 0, equal to the child, or absent from the table ends the walk
 *      (root reached / unknown).
 *   3. `maxDepth` caps the hop count regardless.
 */
export function walkToOwningAnchor(
  startPid: number,
  ppidByPid: ReadonlyMap<number, number>,
  anchorByPid: ReadonlyMap<number, OwningAnchor>,
  opts: { maxDepth?: number } = {},
): PidWalkHit | null {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isInteger(startPid) || startPid <= 0) return null;

  const visited = new Set<number>();
  let current = startPid;
  for (let depth = 0; depth <= maxDepth; depth++) {
    if (visited.has(current)) break; // cycle guard
    visited.add(current);

    const anchor = anchorByPid.get(current);
    if (anchor) return { anchor, pid: current, depth };

    const parent = ppidByPid.get(current);
    // No parent entry → `current` is a root not in the table → stop.
    if (parent === undefined) break;
    // A non-positive, self-referential, or NaN parent is the end of a real
    // chain (or a corrupt one) — stop rather than chase it.
    if (!Number.isInteger(parent) || parent <= 0 || parent === current) break;
    current = parent;
  }
  return null;
}
