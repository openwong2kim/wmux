// J1 fan-out IPC handler (renderer → main). One prompt → N isolated tasks.
//
// Assemble FanOutService(main) each call: daemon RPC port (daemonClient) + renderer spawn
// port (sendToRenderer('fanout.spawnWorkspace')). Renderer-trusted identity (verifiedWorkspaceId)
// same trust basis as channelLocal.handler (Electron process boundary — not on pipe).
//
// Idempotency (§2 G1) managed by FanOutService instance key→result LRU, so service instance
// must be reused for process lifetime (create once at handler registration, preserve in closure).

import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import type { RpcMethod } from '../../../shared/rpc';
import { sendToRenderer } from '../../pipe/handlers/_bridge';
import { FanOutService } from '../../worktask/FanOutService';
import type { FanOutRequest } from '../../worktask/FanOutService';

type GetWindow = () => BrowserWindow | null;

/** Spawn may take seconds — generous renderer spawn timeout (includes PTY creation). */
const SPAWN_TIMEOUT_MS = 30000;

export function registerFanOutHandler(
  getDaemonClient: () => DaemonClient | null,
  getWindow: GetWindow,
): () => void {
  // Single instance for process lifetime — idempotency LRU must persist across calls.
  const service = new FanOutService({
    daemon: {
      rpc: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
        const dc = getDaemonClient();
        if (!dc) throw new Error('Daemon not connected');
        return dc.rpc(method as RpcMethod, params);
      },
    },
    renderer: {
      spawnWorkspace: async (p) => {
        const res = (await sendToRenderer(getWindow, 'fanout.spawnWorkspace', p, {
          timeoutMs: SPAWN_TIMEOUT_MS,
        })) as { workspaceId?: string; ptyId?: string; error?: string };
        if (res && typeof res.error === 'string') return { error: res.error };
        if (res && typeof res.workspaceId === 'string') {
          return { workspaceId: res.workspaceId, ...(res.ptyId ? { ptyId: res.ptyId } : {}) };
        }
        return { error: 'fanout.spawnWorkspace: renderer returned no workspaceId' };
      },
    },
  });

  ipcMain.removeHandler(IPC.FANOUT_START);
  ipcMain.handle(
    IPC.FANOUT_START,
    wrapHandler(IPC.FANOUT_START, async (_event: Electron.IpcMainInvokeEvent, rawReq: unknown) => {
      const req = normalizeRequest(rawReq);
      if ('error' in req) return { ok: false, error: req.error, tasks: [] };
      return service.start(req);
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.FANOUT_START);
  };
}

/** Defensive wire parsing — renderer trusted but shape validated. export=test-only (review finding
 *  — titles·taskPrompts index alignment regression guard, Codex review). */
export function normalizeRequest(raw: unknown): FanOutRequest | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'fanout:start: request object required' };
  }
  const r = raw as Record<string, unknown>;
  const idempotencyKey = typeof r['idempotencyKey'] === 'string' ? r['idempotencyKey'] : '';
  const prompt = typeof r['prompt'] === 'string' ? r['prompt'] : '';
  // titles·taskPrompts are index-aligned pairs (FanOutService.run() recombines same index).
  // Review finding (Codex) — old code .filter() compressed non-string titles (removed holes)
  // but .map() kept taskPrompts original indices; mixed non-string in titles shifted indices
  // and misdelivered prompts (e.g. titles=['A',null,'B'], taskPrompts=['pa','ignored','pb'] →
  // compressed titles=['A','B'] paired with taskPrompts[0,1]=['pa','ignored'] so B got 'ignored' not 'pb').
  // Filter after pairing to keep indices aligned.
  const rawTitles = Array.isArray(r['titles']) ? (r['titles'] as unknown[]) : [];
  const rawTaskPrompts = Array.isArray(r['taskPrompts']) ? (r['taskPrompts'] as unknown[]) : [];
  const pairedEntries = rawTitles
    .map((rt, k) => ({
      title: rt,
      taskPrompt: typeof rawTaskPrompts[k] === 'string' ? (rawTaskPrompts[k] as string) : '',
    }))
    .filter((e): e is { title: string; taskPrompt: string } => typeof e.title === 'string');
  const titles = pairedEntries.map((e) => e.title);
  const taskPrompts = Array.isArray(r['taskPrompts']) ? pairedEntries.map((e) => e.taskPrompt) : undefined;
  const repoPath = typeof r['repoPath'] === 'string' ? r['repoPath'] : '';
  const agentCmd = typeof r['agentCmd'] === 'string' ? r['agentCmd'] : 'claude';
  const verifiedWorkspaceId = typeof r['verifiedWorkspaceId'] === 'string' ? r['verifiedWorkspaceId'] : '';
  const memberId = typeof r['memberId'] === 'string' ? r['memberId'] : undefined;
  if (!repoPath) return { error: 'fanout:start: repoPath is required' };
  return {
    idempotencyKey,
    prompt,
    titles,
    ...(taskPrompts ? { taskPrompts } : {}),
    repoPath,
    agentCmd,
    verifiedWorkspaceId,
    ...(memberId ? { memberId } : {}),
  };
}
