// Renderer-only channel-mutation IPC (D5) — thin first-party surface that lets
// the in-app channels UI (create + composer post) mutate channel state even
// though it has no PTY.
//
// Why this exists, and why it is sound:
//  - The pipe-facing `a2a.channel.*` handler (a2a.channel.rpc.ts) resolves an
//    unforgeable `verifiedWorkspaceId` from a verified `senderPtyId` and FAILS
//    CLOSED on a mutating call with no resolvable senderPtyId. The in-app
//    composer/create UI is not a PTY, so it has no senderPtyId — through the
//    pipe handler every renderer create/post would be NOT_AUTHORIZED.
//  - This channel is registered with `ipcMain.handle` (NOT on the pipe
//    RpcRouter), so it is reachable ONLY from the renderer process — a
//    same-user named-pipe / MCP client physically cannot invoke an Electron
//    IPC handler. This is the identical renderer-only boundary that
//    projectConfig.handler.ts relies on for its trust mutation.
//  - The renderer is the first-party GUI and the source of truth for the
//    company/CEO identity, so the renderer-supplied `verifiedWorkspaceId` (the
//    active human/CEO workspace) is trusted HERE and forwarded to the daemon.
//    The daemon's authz gates (sender-pin, membership, archive creator/CEO) are
//    identical to the MCP path — but the TRUST BASIS of `verifiedWorkspaceId`
//    differs and is weaker: the MCP path resolves it from an unforgeable
//    `senderPtyId` (input.findOwnerWorkspace), whereas this path has no PTY and
//    trusts the renderer's claim, sound ONLY because this IPC is unreachable
//    from the pipe. There is no second anchor here — the security rests
//    entirely on the process boundary, bottoming out at the same same-user
//    ceiling.
//  - This does NOT widen the same-user ceiling: an attacker who wants to
//    post-as-CEO must reach the daemon control pipe directly (the documented
//    residual — plans/trust-root-security-epic-plan.md F1), which this path
//    neither enables nor depends on.
//
// Reads stay on the existing `a2a.channel.*` pipe handler (they accept a no-PTY
// caller and fall back to the caller scope); only the five MUTATING methods are
// routed here.

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import type { RpcMethod } from '../../../shared/rpc';

/** Positive allow-list — only channel-mutating methods may ride the renderer
 *  trust path. Reads and every non-channel RPC are rejected so this surface
 *  can never become a general renderer→daemon bypass. */
const CHANNEL_MUTATING_METHODS: ReadonlySet<string> = new Set<string>([
  'a2a.channel.create',
  'a2a.channel.post',
  'a2a.channel.join',
  'a2a.channel.leave',
  'a2a.channel.archive',
]);

type ChannelRejection = { ok: false; error: { code: 'NOT_AUTHORIZED'; message: string } };

const reject = (message: string): ChannelRejection => ({
  ok: false,
  error: { code: 'NOT_AUTHORIZED', message },
});

/**
 * Register the renderer-only channel-mutation handler. `getDaemonClient` is the
 * same `() => daemonClient` accessor the pipe-facing a2a.channel handler uses,
 * so the forward target tracks daemon reconnects.
 */
export function registerChannelLocalHandlers(getDaemonClient: () => DaemonClient | null): () => void {
  ipcMain.removeHandler(IPC.CHANNEL_MUTATE_LOCAL);
  ipcMain.handle(
    IPC.CHANNEL_MUTATE_LOCAL,
    wrapHandler(IPC.CHANNEL_MUTATE_LOCAL, async (
      _event: Electron.IpcMainInvokeEvent,
      method: unknown,
      params: unknown,
    ): Promise<unknown> => {
      if (typeof method !== 'string' || !CHANNEL_MUTATING_METHODS.has(method)) {
        return reject(`channels:mutate-local rejects method: ${String(method)}`);
      }
      const p = (params && typeof params === 'object' && !Array.isArray(params)
        ? { ...(params as Record<string, unknown>) }
        : {}) as Record<string, unknown>;
      // The renderer-supplied workspace is the trusted identity here (process
      // boundary). Normalize + require it, then strip-and-stamp so a stale or
      // malformed copy can't slip through — mirrors the server-pin in
      // a2a.channel.rpc.ts, just with the renderer (not a senderPtyId) as the
      // unforgeable anchor.
      const ws = typeof p.verifiedWorkspaceId === 'string' ? p.verifiedWorkspaceId.trim() : '';
      if (!ws) {
        return reject('channels:mutate-local requires a renderer-supplied verifiedWorkspaceId');
      }
      p.verifiedWorkspaceId = ws;
      // The pipe handler also strips senderPtyId before forwarding; a renderer
      // post never has one, but drop any stray value so the daemon never sees a
      // forged anchor on this path.
      delete p.senderPtyId;

      const dc = getDaemonClient();
      if (!dc) throw new Error('Daemon not connected');
      return dc.rpc(method as RpcMethod, p);
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.CHANNEL_MUTATE_LOCAL);
  };
}
