import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import type { ClaudeWorker } from '../../a2a/ClaudeWorker';
import * as fs from 'fs';
import { getPidMapDir } from '../../../shared/constants';
import { defaultSnapshot } from '../../pty/portWatch';
import type { PortSnapshot, SnapshotFn } from '../../pty/portWatch';
import { walkToOwningAnchor } from '../../pty/serverSidePidWalk';
import type { OwningAnchor } from '../../pty/serverSidePidWalk';

type GetWindow = () => BrowserWindow | null;

/** Validate an RPC-supplied caller pid. Anything non-positive / non-integer is
 *  ignored (older MCP build, or junk) → the handler keeps its legacy behavior. */
function normalizeCallerPid(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/** Resolve `p`, but never wait longer than `ms` — on timeout resolve `fallback`.
 *  Keeps a slow process snapshot from blocking (past the client's RPC deadline)
 *  the legacy identity fallback the handler still wants to return. */
function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(fallback); } }, ms);
    const finish = (v: T) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    p.then(finish, () => finish(fallback));
  });
}

/** Soft cap for the whole resolve.identity call, under the MCP client's ~10s RPC
 *  timeout. The snapshot wait is bounded to whatever remains after the pid-map
 *  scan so a hung Win32_Process query can't sink the legacy fallback response. */
const RPC_SNAPSHOT_DEADLINE_MS = 8000;

export function registerA2aRpc(
  router: RpcRouter,
  getWindow: GetWindow,
  claudeWorker: ClaudeWorker,
  opts: { snapshot?: SnapshotFn } = {},
): void {
  // Server-side process-tree snapshot for handshake identity resolution. Shared
  // across CONCURRENT handshakes (in-flight coalescing) so the multi-agent launch
  // burst triggers ONE Win32_Process spawn, not one per agent. The MCP side
  // caches a resolved identity, so a successful handshake never re-fires; only
  // the miss/fallback path re-snaps.
  const snapshotFn: SnapshotFn = opts.snapshot ?? defaultSnapshot;
  let snapInflight: Promise<PortSnapshot> | null = null;
  async function getCoalescedSnapshot(): Promise<PortSnapshot | null> {
    if (!snapInflight) {
      snapInflight = snapshotFn().finally(() => { snapInflight = null; });
    }
    try {
      return await snapInflight;
    } catch {
      return null; // PowerShell missing / denied → no server walk
    }
  }
  // Return a process table guaranteed to contain `callerPid` (or null). A
  // coalesced snapshot can PREDATE this caller — an earlier handshake in the same
  // burst triggered it before this MCP's process existed — so our pid and our
  // ancestry may be absent, silently missing the walk. When the shared table
  // lacks callerPid, take ONE fresh snapshot. A single refresh is enough; a pid
  // still absent afterwards is a genuine miss (caller detached / exited), not a
  // staleness artifact.
  async function snapshotForCaller(callerPid: number): Promise<PortSnapshot | null> {
    const shared = await getCoalescedSnapshot();
    // Snapshot FAILED (PowerShell/CIM unavailable or slow) — do NOT retry: a
    // second attempt could stack two ~8s timeouts and blow past the client's RPC
    // deadline, costing the caller even the legacy/client-walk/env fallback
    // mappings. Degrade gracefully (no server walk; mappings/entries still
    // returned). Refresh ONLY when the table succeeded but predates this caller.
    if (!shared) return null;
    if (shared.ppidByPid.has(callerPid)) return shared;
    // Stale: this snapshot predates our process. Re-COALESCE rather than spawn
    // directly — the first batch's inflight promise already cleared, so this
    // joins/forms a SECOND shared snapshot with the burst's other late arrivers
    // instead of one PowerShell spawn per caller. A callerPid still absent after
    // that is a genuine miss the walk handles (parent undefined → null).
    return getCoalescedSnapshot();
  }

  // a2a.resolve.identity — handled in main process (not renderer).
  // Returns PID → CURRENT workspaceId mappings so an MCP server can resolve
  // which workspace it belongs to by walking its own process tree.
  //
  // The on-disk pid-map stores PID → ptyId (a stable, immutable anchor). The
  // owning workspace is resolved LIVE here, from the renderer, every time —
  // because a workspace id can be re-minted by a daemon respawn or session
  // restore while the shell process (and its frozen WMUX_WORKSPACE_ID env)
  // lives on. Storing the workspace id at create time and trusting it forever
  // is exactly what produced stale identities ("no workspace found for ws-…").
  router.register('a2a.resolve.identity', async (params) => {
    // PROPER multi-agent fix: a caller that can't walk its own process tree —
    // Codex sandboxes the per-hop PowerShell spawn and strips the env hints —
    // sends its OWN pid as `callerPid`. We then walk the tree HERE (main, where
    // the snapshot is unsandboxed) from that pid up to the owning shell's
    // pid-map anchor and return the resolved identity directly. Absent callerPid
    // keeps the legacy contract verbatim (the client walks the returned map), so
    // older MCP builds are unaffected.
    //
    // SECURITY: callerPid is caller-asserted (the pipe does not bind the
    // connection to a pid), so a same-user caller could pass a foreign pid to
    // resolve another pane's identity. That stays within the #113 same-user
    // ceiling — a caller holding the pipe token is already grandfathered
    // allow-all — so this is a reliability mechanism, not a new security boundary.
    const callerPid = normalizeCallerPid((params as { callerPid?: unknown }).callerPid);
    // Start the snapshot CONCURRENTLY and bound the wait (at the walk below) to the
    // RPC budget: it feeds only the final walk, so it must never delay — or, past
    // the client's ~10s RPC deadline, SINK — the legacy mappings/entries fallback
    // this handler returns. Overlapping the pid-map scan + renderer resolves hides
    // its latency in the common case; the deadline caps the degraded one
    // (PowerShell/CIM hung → up to two 8s timeouts inside snapshotForCaller).
    // Started only when a caller asked for server-side resolution (legacy calls
    // pay nothing); resolves to a table containing callerPid, or null.
    const startedAt = Date.now();
    const snapshotPromise: Promise<PortSnapshot | null> =
      callerPid != null ? snapshotForCaller(callerPid) : Promise.resolve(null);

    const dir = getPidMapDir();
    const mappings: Record<string, string> = {};
    // Additive (X4 CLI): per-PID detail including the immutable ptyId anchor,
    // so a caller that finds its own shell PID here gets pane-level identity
    // (ptyId) and not just the owning workspace. `mappings` is kept verbatim
    // for existing MCP clients.
    const entries: Array<{ pid: string; ptyId: string; workspaceId: string }> = [];
    try {
      if (!fs.existsSync(dir)) return { mappings, entries, resolved: null };

      for (const file of fs.readdirSync(dir)) {
        let value: string;
        try {
          value = fs.readFileSync(`${dir}/${file}`, 'utf8').trim();
        } catch {
          continue; // unreadable / racing-unlink entry — skip
        }
        if (!value) continue;

        // Drop legacy "PID → workspaceId" entries unconditionally. They have no
        // ptyId anchor so they cannot be live-resolved; the old code passed them
        // through verbatim, handing back a frozen id that goes stale the moment
        // the workspace is re-minted (daemon respawn / session restore). Worse,
        // the OS recycles PID numbers onto unrelated live processes (Notepad /
        // Discord / RuntimeBroker observed in the wild), so a legacy entry on a
        // recycled-but-live PID resurfaces as a ghost workspace (browser_open →
        // "no active workspace"; terminal ops → "not owned by workspace ws-…").
        // The current writer only ever stores ptyIds, so any "ws-" value is pure
        // legacy debris — purge it. This is the single largest ghost source and
        // is safe to delete on this read path (no liveness probe, no race).
        //
        // We deliberately do NOT "keep it if its workspace is still live"
        // (considered, then rejected): workspace.list proves only that the
        // workspace exists, not that this PID file still belongs to that pane.
        // Legacy files are PID-keyed with ws- content, so removePidMapByPtyId
        // (keyed by ptyId content) can never prune them — a kept entry lives
        // forever, and once the OS recycles its PID onto another MCP server's
        // ancestor it mis-routes commands to a live-but-WRONG workspace (worse
        // than the dead-id ghost: silent, not a hard failure). Unverifiable +
        // unprunable ⇒ unconditional purge is the only safe policy. A genuinely
        // live pane re-anchors with a current-format ptyId entry on its next
        // reconnect, so nothing is permanently lost.
        if (value.startsWith('ws-')) {
          try { fs.unlinkSync(`${dir}/${file}`); } catch { /* best-effort */ }
          continue;
        }

        // Current format: PID → ptyId. Resolve the workspace that owns this pty
        // RIGHT NOW. PID → ptyId is immutable for the process lifetime; only the
        // pty → workspace edge changes, and that is read live. A dead or
        // recycled-but-live PID whose stored ptyId no longer exists resolves to
        // null here and is correctly excluded — so a stale current-format file
        // can never produce a ghost and is harmless if left on disk. Accretion
        // is bounded instead at the write boundary (see pty.handler.ts
        // onDaemonSessionDied cleanup); a read-path prune is deliberately out of
        // scope — a snapshot-only liveness signal can be incomplete and would
        // risk deleting a LIVE pane's anchor (3-way review consensus).
        try {
          const owner = await sendToRenderer(getWindow, 'input.findOwnerWorkspace', { ptyId: value });
          const wsId =
            owner && typeof owner === 'object' && 'workspaceId' in owner
              ? (owner as Record<string, unknown>)['workspaceId']
              : null;
          if (typeof wsId === 'string' && wsId) {
            mappings[file] = wsId;
            entries.push({ pid: file, ptyId: value, workspaceId: wsId });
          }
        } catch {
          // Renderer unavailable (early boot / reload) — skip this entry;
          // the caller retries resolution on its next identity-gated call.
        }
      }
    } catch { /* best-effort: identity resolution is non-critical */ }

    // Server-side walk: from callerPid's PARENT up the live tree to the first
    // ancestor that is a known live anchor. `entries` is already the set of LIVE
    // PID→ptyId→workspace anchors resolved above, so the walk reuses it — no
    // second pid-map read, and dead/recycled anchors are excluded by construction.
    //
    // We start at the PARENT, never callerPid itself: the MCP is never its own
    // pane's shell, and matching its own pid could hit a recycled-PID anchor (an
    // old shell's pid-map file whose number the OS reassigned to this MCP) and
    // mis-route to a stranger workspace. The client-side walk avoids this the same
    // way — it starts at process.ppid.
    // The snapshot feeds ONLY the walk, and the walk can only hit if there is at
    // least one live anchor. With no entries (empty dir / boot-respawn window /
    // renderer gave no owners) skip the snapshot wait entirely — awaiting a
    // slow/hung snapshot to walk an empty anchor set would stall the empty-map
    // fallback for nothing (and terminal routing's empty-map grace loop would
    // multiply it). The concurrently-started snapshot just resolves and is dropped
    // (coalesced, so a boot burst shares one).
    let resolved: { workspaceId: string; ptyId: string } | null = null;
    if (callerPid != null && entries.length > 0) {
      const snapshot = await withDeadline(
        snapshotPromise,
        RPC_SNAPSHOT_DEADLINE_MS - (Date.now() - startedAt),
        null,
      );
      if (snapshot) {
        const anchorByPid = new Map<number, OwningAnchor>();
        for (const e of entries) {
          const pid = Number(e.pid);
          if (Number.isInteger(pid) && pid > 0) {
            anchorByPid.set(pid, { ptyId: e.ptyId, workspaceId: e.workspaceId });
          }
        }
        const parentPid = snapshot.ppidByPid.get(callerPid);
        const hit = parentPid !== undefined
          ? walkToOwningAnchor(parentPid, snapshot.ppidByPid, anchorByPid)
          : null;
        if (hit) resolved = { workspaceId: hit.anchor.workspaceId, ptyId: hit.anchor.ptyId };
      }
    }

    return { mappings, entries, resolved };
  });

  // A2A protocol — passthrough to renderer
  router.register('a2a.whoami', (params) => sendToRenderer(getWindow, 'a2a.whoami', params));
  router.register('a2a.discover', (params) => sendToRenderer(getWindow, 'a2a.discover', params));
  router.register('a2a.task.query', (params) => sendToRenderer(getWindow, 'a2a.task.query', params));
  router.register('a2a.task.update', (params) => sendToRenderer(getWindow, 'a2a.task.update', params));
  router.register('a2a.broadcast', (params) => sendToRenderer(getWindow, 'a2a.broadcast', params));
  router.register('meta.setSkills', (params) => sendToRenderer(getWindow, 'meta.setSkills', params));

  // task.send: renderer validates, approval-gates execute:true, then stores +
  // delivers. Main only spawns the background worker after renderer reports that
  // the pre-create execute approval succeeded.
  router.register('a2a.task.send', async (params, ctx) => {
    const result = await sendToRenderer(getWindow, 'a2a.task.send', params);

    // execute → origin decision (LanLink PR-1, positive-allow):
    //   local  + execute + !taskId + approved → claudeWorker.execute()  ← only spawn
    //   remote / undefined / unknown          → drop (fail-closed; blocks remote RCE)
    //   local  + (no execute | taskId | !approved) → message-only
    // origin is a REQUIRED RpcContext field, so a future remote transport cannot
    // silently inherit execute. The renderer-returned executeApproved is
    // origin-blind, so it is only consulted once we know origin is local.
    if (ctx?.origin === 'local' && params.execute === true && !params.taskId) {
      const record = result as Record<string, unknown> | null;
      const taskId = typeof record?.taskId === 'string' ? record.taskId : '';
      const receiverWsId = typeof record?.toWorkspaceId === 'string' ? record.toWorkspaceId : '';
      const executeApproved = record?.executeApproved === true;
      if (taskId && receiverWsId && executeApproved) {
        const message = typeof params.message === 'string' ? params.message : '';
        const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
        claudeWorker.execute(taskId, receiverWsId, message, cwd).catch((err) => {
          console.error(`[a2a.rpc] Background worker failed for task ${taskId}:`, err);
        });
      }
    }

    return result;
  });

  // task.cancel: cancel worker + update store
  router.register('a2a.task.cancel', async (params) => {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    if (taskId) claudeWorker.cancel(taskId);
    return sendToRenderer(getWindow, 'a2a.task.cancel', params);
  });
}
