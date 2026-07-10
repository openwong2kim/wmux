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
// see plans/trust-root-security-epic-plan.md F1) — EXCEPT the reserved human
// workspace: a ws-human read scope is first-party only (ctx.firstParty),
// since W1's operator observation makes it a skeleton key to every private
// channel's full history (see the gate in forward()). NOTE (audit B1 — naming
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
import type { RpcContext } from '../../../shared/rpc';
import type { DaemonClient } from '../../DaemonClient';
import { HUMAN_WORKSPACE_ID } from '../../../shared/channels';
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
  const forward = async (
    method: string,
    params: unknown,
    mutating: boolean,
    ctx?: RpcContext,
  ): Promise<unknown> => {
    const dc = getDaemonClient();
    if (!dc) throw new Error('DaemonClient not connected');

    const ws = await resolveCallerWorkspace(getWindow, params);
    const base = (params && typeof params === 'object' ? { ...(params as Record<string, unknown>) } : {}) as Record<
      string,
      unknown
    >;

    // R2 review C1: principalId is a renderer-only field — if a pipe/MCP caller
    // asserts a principal coordinate on a member row, it could redirect the
    // wake worker's PTY-write target to an arbitrary pane (including a sibling
    // pane). By the same principle as verifiedWorkspaceId, strip the forgeable
    // copy here. A legitimate principalId is carried only by the GUI join UI
    // over the channels:mutate-local path.
    for (const key of ['member', 'invitedMember', 'createdBy', 'sender'] as const) {
      const ref = base[key];
      if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
        delete (ref as Record<string, unknown>).principalId;
      }
    }
    for (const arrKey of ['members', 'invite'] as const) {
      const arr = base[arrKey];
      if (Array.isArray(arr)) {
        for (const m of arr) {
          if (m && typeof m === 'object' && !Array.isArray(m)) {
            delete (m as Record<string, unknown>).principalId;
          }
        }
      }
    }
    // Every caller-supplied identity ref the spoof guards below must cover: the
    // four scalar refs PLUS each entry of create's initial `members[]` array
    // (ship review — Codex: create's members[] was the ONE identity path the
    // per-key guards missed, so a pipe channel_create could seed a reserved-id
    // member row and bypass both guards below) PLUS mission.start's `invite[]`
    // array and its scalar `memberId` (J0 review: mission params carry identity
    // in those two shapes, not member/members).
    const identityRefs: Array<Record<string, unknown>> = [];
    for (const key of ['member', 'invitedMember', 'createdBy', 'sender'] as const) {
      const ref = base[key];
      if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
        identityRefs.push(ref as Record<string, unknown>);
      }
    }
    for (const arrKey of ['members', 'invite'] as const) {
      const arr = base[arrKey];
      if (Array.isArray(arr)) {
        for (const m of arr) {
          if (m && typeof m === 'object' && !Array.isArray(m)) {
            identityRefs.push(m as Record<string, unknown>);
          }
        }
      }
    }
    if (typeof base.memberId === 'string') {
      // mission.start carries the creator's memberId as a bare scalar — wrap it
      // so the reserved-identity guards below see it too.
      identityRefs.push({ memberId: base.memberId });
    }
    // R2 review C4: 'local-ui' is the GUI human's reserved identity — if a pipe
    // path uses this label, it would be shown in the roster/transcript
    // impersonating the human ("me"). The GUI never goes through this router
    // (channels:mutate-local only), so a 'local-ui' over the pipe is always a
    // spoof — reject.
    for (const ref of identityRefs) {
      if (ref.memberId === 'local-ui' || ref.memberName === 'local-ui') {
        return {
          ok: false,
          error: {
            code: 'NOT_AUTHORIZED',
            message: "'local-ui' is a reserved GUI identity and cannot be used from the pipe",
          },
        };
      }
    }
    // P5 — 'ws-human' is the reserved VIRTUAL workspace of the unified human
    // identity, created and managed ONLY by the renderer-local mutate path. A
    // pipe caller must never touch it, as a CALLER (post/join/create as "Me"),
    // an invite TARGET, or a create initial-member. `invitedMember` and the
    // create `members[]` entries are both covered (ship review): the only thing
    // a ws-human ref from the pipe could do is seed a bogus (ws-human,
    // <non-local-ui>) row that the load-time merge (which folds only memberId
    // === 'local-ui') can never clean and that every renderer membership check
    // (workspaceId-keyed) treats as the human — an agent force-injecting a
    // channel into the human's always-on view. Reject it. Reads keep the
    // documented process-boundary residual (renderer reads ride this router
    // scoped to ws-human).
    for (const ref of identityRefs) {
      if (ref.workspaceId === HUMAN_WORKSPACE_ID) {
        return {
          ok: false,
          error: {
            code: 'NOT_AUTHORIZED',
            message: `'${HUMAN_WORKSPACE_ID}' is the reserved human workspace and cannot be claimed or targeted from the pipe`,
          },
        };
      }
    }

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
      // W1 hardening (Codex P1) — a wire client must not self-claim the reserved
      // human workspace on READS. The identityRefs guards above reject ws-human
      // as a caller/target ref but deliberately exempt the bare
      // `verifiedWorkspaceId` read scope, because the renderer's OWN reads ride
      // this router scoped to ws-human. Pre-W1 that residual let a wire caller
      // read the channels the human was a MEMBER of; W1's operator observation
      // (ChannelService.isObservableBy) widens the ws-human read scope to EVERY
      // private channel with FULL history, so the self-claim must now be gated.
      // `ctx.firstParty` is set only by trusted in-process dispatch (the
      // renderer IPC bridge in main/index.ts, the plugin host) and is a
      // dispatch() argument, never a request field — the wire (PipeServer)
      // cannot forge it (see RpcContext.firstParty / audit B3 events.poll
      // precedent). There is no legitimate wire client that reads as ws-human:
      // the CLI/MCP read as their own resolved workspace. Note ws-human owns no
      // panes, so no senderPtyId can resolve into it via the `if (ws)` branch
      // above either. This also closes the PRE-W1 residual (wire reads of
      // human-member channels); other self-claimed workspace reads keep the
      // documented same-user residual (out of scope here).
      if (base.verifiedWorkspaceId === HUMAN_WORKSPACE_ID && !ctx?.firstParty) {
        return {
          ok: false,
          error: {
            code: 'NOT_AUTHORIZED',
            message: `reserved human workspace ('${HUMAN_WORKSPACE_ID}') reads are first-party only`,
          },
        };
      }
      // Read with no senderPtyId (renderer/headless): leave the caller-supplied
      // verifiedWorkspaceId in place — process-boundary trust, documented
      // same-user residual (see file header).
    }

    return dc.rpc(method, base);
  };

  // Read-only — capability 'a2a.channel.read'. ctx is threaded so the forwarder
  // can distinguish the first-party operator (renderer bridge / plugin host)
  // from the wire for the reserved-human-workspace read gate above.
  router.register('a2a.channel.list', (p, ctx) => forward('a2a.channel.list', p, false, ctx));
  router.register('a2a.channel.get', (p, ctx) => forward('a2a.channel.get', p, false, ctx));
  router.register('a2a.channel.getMessages', (p, ctx) => forward('a2a.channel.getMessages', p, false, ctx));
  router.register('a2a.channel.getMembers', (p, ctx) => forward('a2a.channel.getMembers', p, false, ctx));
  router.register('a2a.channel.unread', (p, ctx) => forward('a2a.channel.unread', p, false, ctx));
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

  // Mission RPCs (J0 §3) — same forwarder, same D5 stamp discipline: mutating
  // start/close require a resolvable senderPtyId (fail-closed) and get a
  // server-pinned verifiedWorkspaceId over any client-supplied value; list is
  // a read (owner-scoped by the stamped/advisory workspace). These MUST be
  // registered here or the MCP mission tools die with "Unknown method"
  // (J0 3-model review — Codex, conf 10: capability map + FIRST_PARTY had the
  // methods but the router forward was the missing link).
  router.register('task.mission.start', (p) => forward('task.mission.start', p, true));
  router.register('task.mission.close', (p) => forward('task.mission.close', p, true));
  router.register('task.mission.list', (p, ctx) => forward('task.mission.list', p, false, ctx));
  // task.mission.update(J1 §5) — 물질화 커밋. 변이라 verifiable caller 필수(start/
  // close와 동일 forwarder·스탬프 규율). MCP 도구 표면은 없지만(FanOutService 내부
  // 경로), 이 router 등록으로 first-party 파이프 클라이언트는 도달 가능하다 — "도구
  // 없음 = 파이프 미도달"이 아니다. 변이는 owner OR CEO authz 게이트가 방어한다:
  // #113 same-machine 신원 위조 ceiling 하에서 owner-워크스페이스 에이전트가 자기
  // 태스크를 선점 물질화하는 것은 수용 잔여(단, 물질화 단조 게이트가 이중 물질화는
  // 차단하므로 피해는 자기 태스크 1회 선점에 한정된다).
  router.register('task.mission.update', (p) => forward('task.mission.update', p, true));

  // NOTE: a2a.channel.archive and a2a.channel.kick are intentionally NOT registered
  // here. BOTH are HUMANS-ONLY actions (product decision): archiving tears a channel
  // down for EVERYONE, kicking ejects another member. Same-machine agent identity is
  // forgeable (#113, accepted ceiling), so an agent-reachable archive/kick would let
  // any member-workspace agent destroy a channel or eject anyone. Like ack, they ride
  // the renderer-only channels:mutate-local path (channelLocal.handler) — a first-party
  // GUI surface reachable only across the Electron process boundary and unreachable
  // from the pipe/MCP. Registering either here would silently re-open that hole.
}
