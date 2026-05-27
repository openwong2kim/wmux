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
    try {
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir)) {
          let value: string;
          try {
            value = fs.readFileSync(`${dir}/${file}`, 'utf8').trim();
          } catch {
            continue; // unreadable / racing-unlink entry — skip
          }
          if (!value) continue;

          if (value.startsWith('ws-')) {
            // Legacy entry written before the live-ownership change
            // (PID → workspaceId). Pass it through best-effort; it is
            // overwritten with a ptyId on the next session create/reconnect.
            mappings[file] = value;
            continue;
          }

          // Current format: PID → ptyId. Resolve the workspace that owns this
          // pty RIGHT NOW. PID → ptyId is immutable for the process lifetime;
          // only the pty → workspace edge changes, and that is read live.
          try {
            const owner = await sendToRenderer(getWindow, 'input.findOwnerWorkspace', { ptyId: value });
            const wsId =
              owner && typeof owner === 'object' && 'workspaceId' in owner
                ? (owner as Record<string, unknown>)['workspaceId']
                : null;
            if (typeof wsId === 'string' && wsId) mappings[file] = wsId;
          } catch {
            // Renderer unavailable (early boot / reload) — skip this entry;
            // the caller retries resolution on its next identity-gated call.
          }
        }
      }
    } catch { /* best-effort: identity resolution is non-critical */ }
    return { mappings };
  });

  // A2A protocol — passthrough to renderer
  router.register('a2a.whoami', (params) => sendToRenderer(getWindow, 'a2a.whoami', params));
  router.register('a2a.discover', (params) => sendToRenderer(getWindow, 'a2a.discover', params));
  router.register('a2a.task.query', (params) => sendToRenderer(getWindow, 'a2a.task.query', params));
  router.register('a2a.task.update', (params) => sendToRenderer(getWindow, 'a2a.task.update', params));
  router.register('a2a.broadcast', (params) => sendToRenderer(getWindow, 'a2a.broadcast', params));
  router.register('meta.setSkills', (params) => sendToRenderer(getWindow, 'meta.setSkills', params));

  // task.send: store via renderer + background execution for new tasks
  router.register('a2a.task.send', async (params) => {
    // 1) Save task to store + deliver via PTY paste (renderer handles both)
    const result = await sendToRenderer(getWindow, 'a2a.task.send', params);

    // 2) Background execution only when explicitly requested (execute: true)
    //    AND user has approved via the confirmation dialog. The Claude CLI is
    //    spawned with --permission-mode bypassPermissions so any external MCP
    //    caller flipping execute:true would otherwise gain unattended RCE.
    if (params.execute) {
      const taskId = (result as Record<string, unknown>)?.taskId as string | undefined;
      if (taskId && !params.taskId) {
        const senderWsId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
        const receiverWsId = typeof params.to === 'string' ? params.to : '';
        const message = typeof params.message === 'string' ? params.message : '';
        const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;

        let approved = false;
        try {
          const decision = await sendToRenderer(
            getWindow,
            'a2a.confirmExecute',
            {
              taskId,
              senderWorkspaceId: senderWsId,
              receiverWorkspaceId: receiverWsId,
              messagePreview: message.slice(0, 500),
              cwd: cwd ?? null,
            },
            { timeoutMs: 35_000 },
          );
          approved = (decision as { approved?: boolean } | null)?.approved === true;
        } catch (err) {
          console.warn(`[a2a.rpc] confirmExecute failed for task ${taskId}:`, err);
          approved = false;
        }

        if (approved) {
          claudeWorker.execute(taskId, receiverWsId, message, cwd).catch((err) => {
            console.error(`[a2a.rpc] Background worker failed for task ${taskId}:`, err);
          });
        } else {
          // Mark task canceled so the sender's a2a_task_query reflects the
          // denial. The original message delivery still happened in step 1.
          await sendToRenderer(getWindow, 'a2a.task.cancel', {
            taskId,
            workspaceId: receiverWsId,
          }).catch(() => { /* best-effort */ });
        }
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
