// ─── a2a.channel.* RPC handler ─────────────────────────────────────────
// Pipe RPC surface → daemon ChannelService (which owns canonical channel
// state, U3). MCP/pipe clients use these handlers for ALL channel ops; the
// renderer uses them for READS only (list/get/getMessages/getMembers).
// Renderer MUTATIONS do NOT come through here — the in-app UI has no
// senderPtyId, so a mutating call fails closed (D5, below), and instead rides
// the dedicated renderer-only `channels:mutate-local` IPC
// (src/main/ipc/handlers/channelLocal.handler.ts, pipe-unreachable). These
// handlers exist so a caller talks to one RPC router and the enforcer can gate
// them against `a2a.channel.read` / `a2a.channel.send` capabilities
// (methodCapabilityMap.ts).
//
// D5 — caller-identity server-pin. The daemon trusts `verifiedWorkspaceId`
// for every authz gate (post: sender===verified; reads: membership/
// visibility). That field MUST NOT be a client-supplied
// value, or a forger sets sender.workspaceId AND verifiedWorkspaceId to a
// victim's (public) ws-id and sails through. So here, BEFORE forwarding to
// the daemon, we OVERWRITE verifiedWorkspaceId with a value resolved from a
// verified `senderPtyId` — the same anchor a2a.task.send uses (the MCP
// server supplies its own PID-map-walked ptyId). We resolve ptyId → owning
// workspace via the renderer (`input.findOwnerWorkspace`), exactly as
// `a2a.resolve.identity` does (a2a.rpc.ts).
//
// Mutating methods (create/join/leave/post/invite) REQUIRE a resolvable
// senderPtyId and fail closed without one — so a renderer composer / headless
// caller with no PTY cannot mutate (it is read-only). (archive + kick are
// humans-only and not registered here at all — see the NOTE in the registrar.) Read methods accept a
// no-PTY caller and fall back to the caller-supplied scope: the renderer is
// trusted by the process boundary, and this is the documented same-user
// residual (a same-user process can already read every workspace's token —
// see plans/trust-root-security-epic-plan.md F1). NOTE (audit B1 — naming
// honesty): `senderPtyId` arrives in the request PARAMS and is NOT bound to the
// pipe connection's PID, so a same-user pipe client can forge it (a victim's
// live ptyId is enumerable via a2a.discover). Treat the resulting
// `verifiedWorkspaceId` as ADVISORY attribution under the #113 same-user ceiling
// — NOT an unforgeable cross-user boundary. The only real improvement over the
// old path is that it no longer rides the spoofable WMUX_WORKSPACE_ID env hint;
// a true fix derives identity from the connection peer PID
// (GetNamedPipeClientProcessId) — see plans/channels-fix-plan-2026-06-29.md
// strategy track (B1/B2/B3).
//
// Handlers MUST NOT emit events themselves; `channel.message` emission is
// owned by ChannelService inside its per-channel critical section (plan KTD3),
// bridged to the EventBus in DaemonClient.ts / DaemonNotificationRouter.ts.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { DaemonClient } from '../../DaemonClient';
import { sendToRenderer } from './_bridge';

type GetWindow = () => BrowserWindow | null;

/**
 * Resolve the caller's VERIFIED workspace from a verified `senderPtyId`.
 * The MCP server supplies its own PID-map-walked ptyId (the same anchor
 * a2a.task.send threads); the renderer resolves which workspace owns that
 * pty RIGHT NOW. Returns '' when there is no resolvable senderPtyId (a
 * renderer/headless caller with no PTY, or the renderer being unavailable).
 * Mirrors the resolution in a2a.resolve.identity (a2a.rpc.ts).
 */
async function resolveCallerWorkspace(getWindow: GetWindow, params: unknown): Promise<string> {
  const senderPtyId =
    params && typeof params === 'object' && typeof (params as Record<string, unknown>).senderPtyId === 'string'
      ? ((params as Record<string, unknown>).senderPtyId as string).trim()
      : '';
  if (!senderPtyId) return '';
  try {
    const owner = await sendToRenderer(getWindow, 'input.findOwnerWorkspace', { ptyId: senderPtyId });
    const wsId =
      owner && typeof owner === 'object' && 'workspaceId' in owner
        ? (owner as Record<string, unknown>).workspaceId
        : null;
    return typeof wsId === 'string' && wsId ? wsId : '';
  } catch {
    // Renderer unavailable (early boot / reload) — treat as unresolvable.
    return '';
  }
}

/**
 * Register the eleven `a2a.channel.*` pipe-RPC methods (v2 added ack +
 * unread). Each forwards to the daemon's ChannelService via `DaemonClient`,
 * but FIRST stamps a server-resolved `verifiedWorkspaceId` (D5) so the
 * daemon's authz gates run against an identity the caller cannot forge.
 */
export function registerA2aChannelRpc(
  router: RpcRouter,
  getDaemonClient: () => DaemonClient | null,
  getWindow: GetWindow,
): void {
  const forward = async (method: string, params: unknown, mutating: boolean): Promise<unknown> => {
    const dc = getDaemonClient();
    if (!dc) throw new Error('DaemonClient not connected');

    const ws = await resolveCallerWorkspace(getWindow, params);
    const base = (params && typeof params === 'object' ? { ...(params as Record<string, unknown>) } : {}) as Record<
      string,
      unknown
    >;

    if (ws) {
      // Verified caller: stamp the server-resolved workspace over ANY
      // client-supplied verifiedWorkspaceId (strip the forgeable copy).
      base.verifiedWorkspaceId = ws;
    } else {
      if (mutating) {
        // No verifiable caller identity → fail closed for state mutation.
        return {
          ok: false,
          error: {
            code: 'NOT_AUTHORIZED',
            message: 'channel mutation requires a verifiable caller (no resolvable senderPtyId)',
          },
        };
      }
      // Read with no senderPtyId (renderer/headless): leave the caller-supplied
      // verifiedWorkspaceId in place — process-boundary trust, documented
      // same-user residual (see file header).
    }

    return dc.rpc(method, base);
  };

  // Read-only — capability 'a2a.channel.read'
  router.register('a2a.channel.list', (p) => forward('a2a.channel.list', p, false));
  router.register('a2a.channel.get', (p) => forward('a2a.channel.get', p, false));
  router.register('a2a.channel.getMessages', (p) => forward('a2a.channel.getMessages', p, false));
  router.register('a2a.channel.getMembers', (p) => forward('a2a.channel.getMembers', p, false));
  router.register('a2a.channel.unread', (p) => forward('a2a.channel.unread', p, false));
  // Channels v2: a2a.channel.ack IS now agent-reachable — registered as
  // MUTATING, so it requires a resolvable senderPtyId and gets a server-pinned
  // verifiedWorkspaceId (D5), unlike the historical renderer-driven ack that
  // had no senderPtyId and would have left receipts forgeable (the reason it
  // was previously kept off this router). The renderer keeps its own
  // channels:mutate-local path (channelLocal.handler) — both routes land on
  // the same daemon handler, which additionally stamps headless callers
  // (channelCallerIdentity.ts). The cursor this advances (lastReadSeq) is the
  // durable-inbox consume signal: the wake worker stops re-nudging on ack.
  router.register('a2a.channel.ack', (p) => forward('a2a.channel.ack', p, true));

  // Mutating — capability 'a2a.channel.send' (verifiable caller required)
  router.register('a2a.channel.create', (p) => forward('a2a.channel.create', p, true));
  router.register('a2a.channel.join', (p) => forward('a2a.channel.join', p, true));
  router.register('a2a.channel.leave', (p) => forward('a2a.channel.leave', p, true));
  router.register('a2a.channel.post', (p) => forward('a2a.channel.post', p, true));
  router.register('a2a.channel.invite', (p) => forward('a2a.channel.invite', p, true));

  // NOTE: a2a.channel.archive and a2a.channel.kick are intentionally NOT registered
  // here. BOTH are HUMANS-ONLY actions (product decision): archiving tears a channel
  // down for EVERYONE, kicking ejects another member. Same-machine agent identity is
  // forgeable (#113, accepted ceiling), so an agent-reachable archive/kick would let
  // any member-workspace agent destroy a channel or eject anyone. Like ack, they ride
  // the renderer-only channels:mutate-local path (channelLocal.handler) — a first-party
  // GUI surface reachable only across the Electron process boundary and unreachable
  // from the pipe/MCP. Registering either here would silently re-open that hole.
}
