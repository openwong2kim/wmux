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
//    The daemon's authz gates (sender-pin, membership, archive member/CEO) are
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
// caller and fall back to the caller scope); only the channel-mutating methods
// are routed here.

import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { DaemonClient } from '../../DaemonClient';
import type { RpcMethod } from '../../../shared/rpc';

/** Positive allow-list — only channel/principal-mutating methods may ride the
 *  renderer trust path. Reads and every other RPC are rejected so this surface
 *  can never become a general renderer→daemon bypass. */
const CHANNEL_MUTATING_METHODS: ReadonlySet<string> = new Set<string>([
  'a2a.channel.create',
  'a2a.channel.post',
  'a2a.channel.join',
  'a2a.channel.leave',
  'a2a.channel.archive',
  // invite is the ONLY in-app path into a private channel (ChannelMembers UI →
  // inviteChannelDaemon → mutateLocal). Like the others it is daemon-gated
  // (caller must be a current member) and the renderer-trusted verifiedWorkspaceId
  // is the inviter; without it here every GUI invite returns NOT_AUTHORIZED.
  'a2a.channel.invite',
  // kick is HUMANS-ONLY: a human in the roster ejects another member. It rides
  // this renderer-only path EXCLUSIVELY and is deliberately absent from the
  // a2a.channel.* pipe router (a2a.channel.rpc.ts), so no agent/MCP caller can
  // eject anyone — same-machine agent identity is forgeable (#113), so an
  // agent-level kick would let any agent eject any other. The process boundary
  // (Electron IPC, pipe-unreachable) is what makes "humans only" real.
  'a2a.channel.kick',
  // A1: receipt ack mutates recipientSnapshot/deliveryStatus, so it must NOT ride
  // the pipe (where a no-PTY caller's verifiedWorkspaceId would be unpinned and a
  // same-user pipe client could forge another member's receipt). The renderer
  // drives it on channel read; route it through this pinned, pipe-unreachable path.
  'a2a.channel.ack',
  // Shared nudge ledger (remediation 2a-2): the renderer reports a mention
  // paste it delivered so the daemon wake worker's re-nudge budget counts it
  // (no immediate double-paste). Renderer-only for the same reason as kick —
  // a forgeable pipe caller could suppress another member's re-nudges (#113).
  'a2a.channel.nudgeRecorded',
  // R2 — system cleanup / registry writes. Same humans-only convention as
  // kick: deliberately absent from the pipe router, reachable only via this
  // renderer-only path. purge is the system action that sweeps dead member
  // rows on workspace/pane deletion, and the three principal writes are
  // registry writes sourced from the renderer's agent detection — this
  // allow-list is exactly the boundary that keeps a forgeable agent identity
  // (#113) from registering/deleting arbitrary principals.
  'a2a.channel.purgeMembership',
  // operator-join (design §2.1/§2.2) — trusted path for operators (humans) to join
  // private channels created by agents (operatorJoin) + discovery list (operatorList).
  // Same humans-only convention as kick/purge: not registered on pipe router
  // (a2a.channel.rpc.ts); reachable only via this renderer-only path. operatorList is
  // read-only but exposing it on pipe would let agents enumerate all private channel
  // names, so humans-only transport is required — kept on the same allowlist.
  'a2a.channel.operatorJoin',
  'a2a.channel.operatorList',
  'a2a.principal.upsert',
  'a2a.principal.remove',
  'a2a.principal.markStaleWorkspace',
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
