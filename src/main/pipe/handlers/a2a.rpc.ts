import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import type { ClaudeWorker } from '../../a2a/ClaudeWorker';
import * as fs from 'fs';
import { getPidMapDir } from '../../../shared/constants';

type GetWindow = () => BrowserWindow | null;

export function registerA2aRpc(router: RpcRouter, getWindow: GetWindow, claudeWorker: ClaudeWorker): void {
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
  router.register('a2a.resolve.identity', async () => {
    const dir = getPidMapDir();
    const mappings: Record<string, string> = {};
    // Additive (X4 CLI): per-PID detail including the immutable ptyId anchor,
    // so a caller that finds its own shell PID here gets pane-level identity
    // (ptyId) and not just the owning workspace. `mappings` is kept verbatim
    // for existing MCP clients.
    const entries: Array<{ pid: string; ptyId: string; workspaceId: string }> = [];
    try {
      if (!fs.existsSync(dir)) return { mappings, entries };

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
        // onDaemonSessionDied cleanup); pruning here would add a destructive
        // tasklist probe to the hot path with no correctness benefit.
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
    return { mappings, entries };
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
