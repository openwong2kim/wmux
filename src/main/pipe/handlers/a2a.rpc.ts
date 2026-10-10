import type { BrowserWindow } from 'electron';
import { getHqWorkspaceId } from '../../deck/deckHqStore';
import { getTaskLedger } from '../../deck/taskLedgerHost';
import { getMoaHandoffService } from '../../deck/moaHandoff';
import { refuseHandoffMarker } from '../handoffMarkerTripwire';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { isHostedCaller } from '../../../shared/rpc';
import { sendToRenderer } from './_bridge';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import type { ClaudeWorker } from '../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../DaemonClient';
import * as fs from 'fs';
import { getPidMapDir } from '../../../shared/constants';
import { validateMessage } from '../../../shared/types';
import { EXECUTE_SEND_MAIN_TIMEOUT_MS } from '../../../shared/executeApprovalBounds';
import { GATED_DELIVERY_DEADLINE_MARGIN_MS, GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS, NEW_TASK_SEND_MAIN_TIMEOUT_MS } from '../../../shared/freshContext';
import { flagOrphanedTask, isPagedTaskQuery, pagedTaskId, shapeTaskQueryResult, summarizeTask } from '../../../shared/a2aTaskQueryView';
import { defaultSnapshot } from '../../pty/portWatch';
import { claimTokenForPane } from '../../workspace/workspaceClaimTrust';
import type { PortSnapshot, SnapshotFn } from '../../pty/portWatch';
import { walkToOwningAnchor } from '../../pty/serverSidePidWalk';
import { tryProcessCreatedAt } from '../../pty/winSnapshotNative';
import { readWindowsAncestry } from './callerAncestry';
import { getAccountStore } from '../../account/accountStore';
import {
  CODEX_THREAD_ID_RE,
  codexHome,
  matchOwnerToLiveAnchor,
  readCodexThreadOwner,
} from '../../../mcp/codexThreadIdentity';
import type { OwningAnchor } from '../../pty/serverSidePidWalk';
import { recordSentTask, recordTaskState, reopenedState, stateOfTask, workLinkFromSentTask } from '../../workLink/a2aProducer';
import { noteTrackReply } from '../../deck/trackRecordFeed';
import { A2A_BRAIN_ALIAS, isRemoteTaskId } from '../../../shared/a2aRemote';
import {
  isRemoteWorkspaceId,
  remoteWorkspaceId,
  type A2aRemoteReplyInput,
  type A2aRemoteSendTaskInput,
  type A2aRemoteStateInput,
  type A2aRemoteTarget,
} from '../../../shared/a2aRemoteDelivery';

type GetWindow = () => BrowserWindow | null;

// ─── envelope PR4: A2A 태스크 데몬 정본 게이트 ─────────────────────────
// 전이·취소·생성의 정본은 데몬 A2aTaskService(append-only 로그)다. 이 헬퍼가
// 데몬 커밋을 시도하고 결과를 3분류한다:
//   ok          — 데몬 게이트(권한·VALID_TRANSITIONS) 통과 + 로그 커밋. 렌더러는
//                 committedTask를 **verbatim 적용**해야 한다(§6.M C6).
//   reject      — 데몬 명시 거부(불법 전이 등). 렌더러를 건드리지 않고 그대로
//                 반환한다 — 렌더러가 재판정하면 split-brain.
//   unavailable — 데몬 미가용/로그 미개방/태스크 미시드('task not found': 렌더러-
//                 로컬 생성 태스크 등). 기존 렌더러-검증 경로로 폴백(컨틴전시) —
//                 A2A는 역사적으로 best-effort 비내구라 degrade가 파국이 아니다.
type DaemonTaskGate =
  | { kind: 'ok'; result: Record<string, unknown> }
  | { kind: 'reject'; error: string }
  | { kind: 'unavailable' };

// soft 분류 마커: 'pane-authz deferred'는 S-C2 페인 게이트를 렌더러(페인 트리
// 소유자)가 판정하도록 데몬이 의도적으로 미루는 신호다 — 거부가 아니라 폴백.
const A2A_DAEMON_SOFT_ERRORS = ['task log unavailable', 'task not found', 'pane-authz deferred'];


const INTERNAL_RENDERER_FIELDS = [
  'daemonCommitted',
  'committedTask',
  'daemonReopenedTask',
  'localReopen',
  'reopenPreflight',
  'requirePaneIdentity',
  'livePaneIds',
  'deliveryDeadlineAt',
  'deliveryGuardKey',
  'presetTaskId',
  'hqHandoffOnly',
  // Cross-host A2A: only main's RemoteA2aBridge sets these, calling the
  // renderer directly (never through this router).
  'remoteFrom',
  'remoteMarker',
] as const;

/**
 * Params for a renderer delivery method, with `operatorOrigin` stamped from
 * the router context and never taken from the wire. The renderer writes A2A
 * deliveries into panes and, unless this is set, first asks main whether an
 * approval is in front of the target (IPC.A2A_DELIVERY_GATE). Only the human
 * operator's in-process surface is exempt, exactly as for `input.send`.
 */
function withOperatorOrigin(
  params: Record<string, unknown>,
  ctx: RpcContext | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  delete out.operatorOrigin;
  // Fields only main may set on the way to the renderer. Taken from the wire,
  // they would let a caller apply a forged task snapshot or skip a check.
  for (const k of INTERNAL_RENDERER_FIELDS) delete out[k];
  if (ctx?.operator) out.operatorOrigin = true;
  return out;
}

export { refuseHandoffMarker } from '../handoffMarkerTripwire';

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** task.metadata.updatedAt(ISO-8601, 사전순=시간순). 부재 시 '' — 항상 최소값. */
function taskUpdatedAt(t: Record<string, unknown>): string {
  const meta = isRecord(t.metadata) ? t.metadata : undefined;
  return typeof meta?.updatedAt === 'string' ? meta.updatedAt : '';
}

/** Daemon deadline for a paged a2a.task.query (see the handler). */
const PAGED_TASK_QUERY_DAEMON_TIMEOUT_MS = 3_000;

async function daemonTaskRpc(
  getDaemonClient: (() => DaemonClient | null) | undefined,
  method: string,
  params: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<DaemonTaskGate> {
  const dc = getDaemonClient?.();
  if (!dc) return { kind: 'unavailable' };
  try {
    const res = await dc.rpc(method, params, opts);
    if (isRecord(res) && res.ok === true) return { kind: 'ok', result: res };
    const error = isRecord(res) && typeof res.error === 'string' ? res.error : `${method}: daemon rejected`;
    if (A2A_DAEMON_SOFT_ERRORS.some((s) => error.includes(s))) return { kind: 'unavailable' };
    return { kind: 'reject', error };
  } catch {
    // 파이프 단절/타임아웃 — 렌더러 폴백(soft).
    return { kind: 'unavailable' };
  }
}

type CallerPane =
  /** `livePaneIds`: every pane of the caller's workspace, from the same read. */
  | { kind: 'resolved'; paneId: string; livePaneIds: string[] }
  /** No senderPtyId, or one that is not a terminal in the caller's own workspace. */
  | { kind: 'absent' }
  /** The pane tree could not be read: keep the daemon's deferral to the renderer. */
  | { kind: 'unknown' };

/**
 * Map the caller's senderPtyId to its pane inside the caller's OWN workspace,
 * the same resolution the renderer's update path makes (stashed panes count, a
 * ptyId the workspace does not own is treated as absent).
 */
/** Why the HQ could not close a hand-off task (requesterComplete codes). */
const HANDOFF_CLOSE_REFUSAL: Record<string, string> = {
  not_requester: 'this HQ did not propose it, or it was never delivered',
  ended: 'the task already ended',
  needs_input: 'the worker is waiting on the operator; relay its question instead',
  turn_not_ended: "the worker's turn has not ended yet; wait for its stop",
  target_working: 'the worker is mid-turn again; wait for its next stop',
  error: 'the task could not be moved',
};

async function resolveCallerPane(
  getWindow: () => BrowserWindow | null,
  workspaceId: unknown,
  senderPtyId: unknown,
): Promise<CallerPane> {
  if (typeof senderPtyId !== 'string' || !senderPtyId || typeof workspaceId !== 'string' || !workspaceId) {
    return { kind: 'absent' };
  }
  const panes = await readWorkspacePanes(getWindow, workspaceId);
  if (!panes) return { kind: 'unknown' };
  const livePaneIds = panes.map((pane) => pane.id as string);
  for (const pane of panes) {
    const ptys = Array.isArray(pane.surfacePtyIds) ? pane.surfacePtyIds : [];
    if (ptys.includes(senderPtyId)) return { kind: 'resolved', paneId: pane.id as string, livePaneIds };
  }
  return { kind: 'absent' };
}

/**
 * A workspace's panes, stashed ones included; null when the tree is unreadable
 * or the workspace is not there. `pane.list` answers [] for a workspace it does
 * not know (before hydration, mid-switch), and a live workspace always has at
 * least one pane, so an empty list is "unknown", never "every pane is gone".
 */
async function readWorkspacePanes(
  getWindow: () => BrowserWindow | null,
  workspaceId: string,
): Promise<Array<Record<string, unknown>> | null> {
  let panes: unknown;
  try {
    panes = await sendToRenderer(getWindow, 'pane.list', { workspaceId, includeStashed: true });
  } catch {
    return null;
  }
  if (!Array.isArray(panes)) return null;
  const known = panes.filter((pane): pane is Record<string, unknown> => isRecord(pane) && typeof pane.id === 'string');
  return known.length > 0 ? known : null;
}

/** Validate an RPC-supplied caller pid. Anything non-positive / non-integer is
 *  ignored (older MCP build, or junk) → the handler keeps its legacy behavior. */
/**
 * Every Codex home the owner record can live in: main's own CODEX_HOME (or
 * the default) and each registered Codex account's config dir, since a thread
 * started under another account's app-server keeps its owner index there.
 */
function codexHomes(): string[] {
  const homes = new Set<string>([codexHome(process.env), codexHome({ ...process.env, CODEX_HOME: '' })]);
  try {
    for (const account of getAccountStore().listAccounts()) {
      if (account.vendor === 'codex' && account.configDir) homes.add(account.configDir);
    }
  } catch {
    /* an unreadable account store leaves the default homes */
  }
  return [...homes];
}

/** The pane a Codex thread's owner record names, with a claim on it, or null. */
function resolveCodexThreadClaim(
  threadId: unknown,
  entries: ReadonlyArray<{ ptyId: string; workspaceId: string }>,
): { workspaceId: string; ptyId: string; workspaceToken: string } | null {
  if (typeof threadId !== 'string' || !CODEX_THREAD_ID_RE.test(threadId)) return null;
  let owner: ReturnType<typeof readCodexThreadOwner>;
  for (const home of codexHomes()) {
    owner = readCodexThreadOwner(threadId, home);
    if (owner) break;
  }
  const match = matchOwnerToLiveAnchor(threadId, owner, entries, process.env.WMUX_DATA_SUFFIX || '');
  if (match.status !== 'hit') return null;
  const workspaceToken = claimTokenForPane(match.wsId, match.ptyId);
  return workspaceToken ? { workspaceId: match.wsId, ptyId: match.ptyId, workspaceToken } : null;
}

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

type RemoteOpResult = { ok: true; taskId: string } | { ok: false; error: string };

/**
 * Cross-host A2A hooks into this handler set. Each is a daemon RPC in the
 * wiring step (`A2A_REMOTE_RPC`); absent = no remote addressing at all.
 */
export interface RemoteA2aRpcDeps {
  /** Every ACTIVE link as an alias target. */
  listTargets: () => Promise<A2aRemoteTarget[]>;
  /** Create the outbound ledger task and queue its envelope. */
  sendTask: (input: A2aRemoteSendTaskInput) => Promise<RemoteOpResult>;
  /** Append a reply to a remote task and queue it. */
  reply: (input: A2aRemoteReplyInput) => Promise<RemoteOpResult>;
  /** Queue a state the ledger already committed on a remote task. */
  state: (input: A2aRemoteStateInput) => Promise<RemoteOpResult>;
  /** The receiver of an inbound remote task read it: the sender gets a `read` receipt. */
  read?: (input: { taskId: string; workspaceId: string }) => Promise<unknown>;
}

const REMOTE_QUEUED = { stored: true, notified: false, queued: true, reason: 'queued_for_remote_host' } as const;
const REMOTE_STATES: ReadonlySet<string> = new Set(['working', 'input-required', 'completed', 'failed', 'canceled']);

export function registerA2aRpc(
  router: RpcRouter,
  getWindow: GetWindow,
  claudeWorker: ClaudeWorker,
  opts: {
    snapshot?: SnapshotFn;
    getDaemonClient?: () => DaemonClient | null;
    /** Process creation time for the walk's pid-reuse guard; tests inject one. */
    createdAt?: (pid: number) => bigint | null;
    /** One caller's ancestry when the snapshot is unavailable; tests inject one. */
    readAncestry?: (pid: number, timeoutMs: number) => Promise<Map<number, number> | null>;
    remote?: RemoteA2aRpcDeps;
  } = {},
): void {
  const getDaemonClient = opts.getDaemonClient;
  const remote = opts.remote;

  /**
   * Active links `to` names EXACTLY (no trimming, no partial match): by alias,
   * or by the `remote:<linkId>` id a2a.discover lists for the remote end.
   */
  async function remoteTargetsFor(to: unknown): Promise<A2aRemoteTarget[]> {
    if (!remote || typeof to !== 'string' || (!to.includes('/') && !isRemoteWorkspaceId(to))) return [];
    try {
      return (await remote.listTargets()).filter((t) => t.alias === to || remoteWorkspaceId(t.linkId) === to);
    } catch {
      return [];
    }
  }

  /**
   * A new task addressed to a remote pane's alias. Only the link's own local
   * pane may send on it, so the caller's pane must be proven; the task is
   * message-only (no worker is ever spawned for a remote pane).
   */
  async function sendRemoteTask(
    params: Record<string, unknown>,
    matches: A2aRemoteTarget[],
    ctx: RpcContext | undefined,
  ): Promise<unknown> {
    const alias = params.to as string;
    if (params.execute === true) return { error: 'a2a.task.send: execute is not available for a remote pane (message only)' };
    // An alias must name exactly one link: never pick one of several silently.
    if (matches.length > 1) {
      return { error: `a2a.task.send: "${alias}" names ${matches.length} links; send to the exact alias a2a_discover lists for the one you mean (a repeated name gets a #2, #3 suffix)` };
    }
    let message: string;
    try { message = validateMessage(typeof params.message === 'string' ? params.message : ''); } catch (e) {
      return { error: `a2a.task.send: ${e instanceof Error ? e.message : 'invalid'}` };
    }
    if (ctx?.commanderWorkspace) {
      // A brain sends only on a brain link of its own workspace: Moa to
      // another PC's Moa. The sender is the token-verified commander binding,
      // never a wire value.
      const hq = ctx.commanderWorkspace;
      const brainLink = matches.find((t) => t.kind === 'brain' && t.local.workspaceId === hq);
      if (!brainLink) {
        return matches.some((t) => t.kind === 'brain')
          ? { error: `a2a.task.send: "${alias}" is linked to another workspace's Moa, not to this one` }
          : {
            error:
              `a2a.task.send: Moa does not send work straight to an agent ("${alias}" is a remote pane). ` +
              'Ask its PC\'s Moa instead (its <PC>/Moa alias from a2a_discover), or propose the work to the operator with moa_propose_handoff.',
          };
      }
      if (!brainLink.allowOutbound) return { error: `a2a.task.send: the link to "${alias}" does not allow sending from this side` };
      const res = await remote!.sendTask({
        linkId: brainLink.linkId,
        from: { workspaceId: hq, name: A2A_BRAIN_ALIAS },
        title: typeof params.title === 'string' ? params.title : '',
        text: message,
      }).catch((err: unknown): RemoteOpResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      if (!res.ok) return { error: `a2a.task.send: remote send refused (${res.error})` };
      return {
        ok: true,
        taskId: res.taskId,
        remote: true,
        delivery: REMOTE_QUEUED,
        // What Moa reads right after sending: the wait is not the operator's decision.
        next: 'You are woken when the other Moa replies or completes it; a2a_task_query shows remoteReceipt delivered/read once it arrives. Do not raise a decision card about waiting: end your turn.',
      };
    }
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    const caller = await resolveCallerPane(getWindow, workspaceId, params.senderPtyId);
    if (caller.kind !== 'resolved') {
      return { error: `a2a.task.send: "${alias}" is a remote pane; sending to it needs the caller's verified pane` };
    }
    const link = matches.find((t) => t.kind !== 'brain' && t.local.workspaceId === workspaceId && t.local.paneId === caller.paneId);
    if (!link) return { error: `a2a.task.send: this pane is not linked to "${alias}"` };
    if (!link.allowOutbound) return { error: `a2a.task.send: the link to "${alias}" does not allow sending from this side` };
    const res = await remote!.sendTask({
      linkId: link.linkId,
      // The verified sender pty: a reply from the peer is held if another
      // agent holds this pane by then.
      from: { workspaceId, name: workspaceId, paneId: caller.paneId, ptyId: params.senderPtyId as string },
      title: typeof params.title === 'string' ? params.title : '',
      text: message,
    }).catch((err: unknown): RemoteOpResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    if (!res.ok) return { error: `a2a.task.send: remote send refused (${res.error})` };
    return { ok: true, taskId: res.taskId, remote: true, delivery: REMOTE_QUEUED };
  }

  /** A reply on a remote task: stored in the ledger and queued for the peer. */
  async function replyRemote(method: string, taskId: string, params: Record<string, unknown>, ctx: RpcContext | undefined): Promise<unknown> {
    let message: string;
    try { message = validateMessage(typeof params.message === 'string' ? params.message : ''); } catch (e) {
      return { error: `${method}: ${e instanceof Error ? e.message : 'invalid'}` };
    }
    const res = await remote!.reply({
      taskId,
      // A brain answers as its token-verified workspace (Moa: the HQ).
      workspaceId: ctx?.commanderWorkspace ?? (typeof params.workspaceId === 'string' ? params.workspaceId : ''),
      text: message,
    }).catch((err: unknown): RemoteOpResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    if (!res.ok) return { error: `${method}: remote reply refused (${res.error})` };
    return { ok: true, taskId, remote: true, delivery: REMOTE_QUEUED };
  }

  /** After the ledger committed a state on a remote task, tell the peer. Best effort. */
  async function queueRemoteState(taskId: string, state: unknown, evidence: unknown): Promise<void> {
    if (!remote || !isRemoteTaskId(taskId) || typeof state !== 'string' || !REMOTE_STATES.has(state)) return;
    const summary = isRecord(evidence) && typeof evidence.summary === 'string' ? evidence.summary : undefined;
    try {
      const res = await remote.state({ taskId, state: state as A2aRemoteStateInput['state'], ...(summary ? { summary } : {}) });
      if (!res.ok) console.warn(`[a2a.rpc] state ${state} of remote task ${taskId} was not queued: ${res.error}`);
    } catch (err) {
      console.warn(`[a2a.rpc] state ${state} of remote task ${taskId} was not queued:`, err);
    }
  }
  // Server-side process-tree snapshot for handshake identity resolution. Shared
  // across CONCURRENT handshakes (in-flight coalescing) so the multi-agent launch
  // burst triggers ONE Win32_Process spawn, not one per agent. The MCP side
  // caches a resolved identity, so a successful handshake never re-fires; only
  // the miss/fallback path re-snaps.
  const snapshotFn: SnapshotFn = opts.snapshot ?? defaultSnapshot;
  const createdAt = opts.createdAt ?? tryProcessCreatedAt;
  const readAncestry = opts.readAncestry ?? readWindowsAncestry;
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

  /** See the `hintedPane` field of `a2a.resolve.identity`. */
  async function resolveHintedPane(
    hintedPtyId: unknown,
    entries: ReadonlyArray<{ ptyId: string; workspaceId: string }>,
  ): Promise<{ live: boolean; workspaceId?: string; workspaceToken?: string } | null> {
    if (typeof hintedPtyId !== 'string' || hintedPtyId.length === 0 || hintedPtyId.length > 128) return null;
    const pane = entries.find((e) => e.ptyId === hintedPtyId);
    if (!pane) return { live: false };
    let wslLive = false;
    try {
      const res = await getDaemonClient?.()?.rpc('session.wslAgentLive', { sessionId: hintedPtyId }, { timeoutMs: 2000 });
      wslLive = (res as { live?: unknown } | null)?.live === true;
    } catch {
      wslLive = false; // daemon unreachable or older: unattested
    }
    if (!wslLive) return { live: true };
    const workspaceToken = claimTokenForPane(pane.workspaceId, pane.ptyId);
    return workspaceToken ? { live: true, workspaceId: pane.workspaceId, workspaceToken } : { live: true };
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
    // ceiling — a caller holding the pipe token can already claim a recognised
    // client name (before #1111 it did not even need that) — so this is a
    // reliability mechanism, not a new security boundary.
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
          // Mirror-first (workspace/ptyOwnership.ts) — this loop pays one
          // lookup per live pid-map anchor, so a fresh mirror collapses N
          // renderer round-trips into zero.
          const wsId = await resolvePtyOwnerWorkspace(getWindow, value);
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
      // No usable snapshot (on Windows: the Win32_Process query failed or ran
      // out of time, or it predates the caller): read just this caller's chain
      // instead, so a pane agent still gets its claim. The chain script checks
      // creation times itself, so the walk needs no separate reuse guard.
      const ppidByPid =
        snapshot && snapshot.ppidByPid.has(callerPid)
          ? snapshot.ppidByPid
          : await readAncestry(callerPid, RPC_SNAPSHOT_DEADLINE_MS - (Date.now() - startedAt));
      if (ppidByPid) {
        const anchorByPid = new Map<number, OwningAnchor>();
        for (const e of entries) {
          const pid = Number(e.pid);
          if (Number.isInteger(pid) && pid > 0) {
            anchorByPid.set(pid, { ptyId: e.ptyId, workspaceId: e.workspaceId });
          }
        }
        const parentPid = ppidByPid.get(callerPid);
        // Creation times reject a reused parent pid: a Codex app-server that
        // updated itself is orphaned, and its dead parent's pid may now be a
        // new pane's shell (Windows only; elsewhere the reader returns null).
        const hit = parentPid !== undefined
          ? walkToOwningAnchor(parentPid, ppidByPid, anchorByPid, { createdAt, child: callerPid })
          : null;
        if (hit) resolved = { workspaceId: hit.anchor.workspaceId, ptyId: hit.anchor.ptyId };
      }
    }

    // A pane claim from main's own walk: the token binds the walked workspace
    // and pane, so browser calls carrying it are scoped from what main found
    // rather than from a workspace the caller names. Additive — a caller that
    // ignores the field is unaffected. Only for a hit main resolved itself,
    // never for the client-side walk over `entries`.
    const workspaceToken = resolved ? claimTokenForPane(resolved.workspaceId, resolved.ptyId) : null;
    // A call from a shared Codex app-server names its thread instead: the pane
    // comes from the thread's owner record (written by wmux's Codex hooks from
    // inside that pane), joined with the LIVE anchors above. The claim goes
    // back on its own field because the caller stamps it on that call only.
    const threadClaim = resolveCodexThreadClaim((params as { codexThreadId?: unknown }).codexThreadId, entries);
    // The walk missed but the caller's env names a pane. Main says whether
    // that pane is live, and attests it only when the daemon follows a live
    // agent inside it from WSL — the one pane kind whose processes main cannot
    // walk. A name that is not a live pane (a scheduled run's `auto-` session,
    // which belongs to no workspace) is reported as such, never as a pane.
    const hintedPane = resolved ? null : await resolveHintedPane((params as { hintedPtyId?: unknown }).hintedPtyId, entries);
    return {
      mappings,
      entries,
      resolved,
      ...(workspaceToken && { workspaceToken }),
      ...(threadClaim && { threadClaim }),
      ...(hintedPane && { hintedPane }),
    };
  });

  /**
   * A message from a task's verified sender reopens it when it has ended. The
   * reopen is committed in the daemon FIRST, then the renderer applies the
   * daemon's snapshot while it stores the message, so the durable copy and the
   * cache never disagree about it:
   *   1. preflight: the renderer runs the call's checks and says whether this
   *      message would reopen the task (no mutation);
   *   2. daemon `a2a.task.reopen` (the daemon re-checks the sender itself);
   *   3. the real call, carrying `daemonReopenedTask`.
   * A task the daemon does not hold (renderer-local tasks, no daemon) reopens
   * in the cache alone (`localReopen`). Any other daemon failure refuses the
   * whole call: nothing is stored, and the sender gets the error to retry.
   *
   * Returns the params for the real call, or a response to return as is.
   */
  async function prepareReopen(
    method: 'a2a.task.send' | 'a2a.task.update',
    params: Record<string, unknown>,
  ): Promise<{ params: Record<string, unknown> } | { response: unknown }> {
    const preflight = await sendToRenderer(getWindow, method, { ...params, reopenPreflight: true });
    if (!isRecord(preflight) || !isRecord(preflight.preflight)) return { response: preflight };
    if (preflight.preflight.reopen !== true) return { params };
    const dc = getDaemonClient?.();
    if (!dc) return { params: { ...params, localReopen: true } };
    const callerPane = await resolveCallerPane(getWindow, params.workspaceId, params.senderPtyId);
    let res: unknown;
    try {
      res = await dc.rpc('a2a.task.reopen', {
        taskId: params.taskId,
        workspaceId: params.workspaceId,
        ...(callerPane.kind === 'resolved' ? { callerPaneId: callerPane.paneId } : {}),
      });
    } catch (err) {
      return { response: { error: `${method}: could not reopen the ended task (${err instanceof Error ? err.message : String(err)}); nothing was stored, retry` } };
    }
    if (isRecord(res) && res.ok === true && isRecord(res.task)) {
      return { params: { ...params, daemonReopenedTask: res.task } };
    }
    const error = isRecord(res) && typeof res.error === 'string' ? res.error : 'daemon rejected';
    if (error.includes('task not found') || error.includes('task log unavailable')) {
      return { params: { ...params, localReopen: true } };
    }
    return { response: { error: `${method}: could not reopen the ended task (${error}); nothing was stored` } };
  }

  // A2A protocol — whoami/discover/broadcast/skills는 렌더러 소유 그대로.
  router.register('a2a.whoami', (params) => sendToRenderer(getWindow, 'a2a.whoami', params));
  router.register('a2a.discover', async (params) => {
    const res = await sendToRenderer(getWindow, 'a2a.discover', params);
    if (!remote || !isRecord(res) || !Array.isArray(res.agents)) return res;
    let targets: A2aRemoteTarget[] = [];
    try { targets = await remote.listTargets(); } catch { return res; }
    // A remote pane is addressable only from its linked local pane: list the
    // links of the caller's workspace (every link when no workspace is named).
    const ws = typeof params.workspaceId === 'string' && params.workspaceId ? params.workspaceId : '';
    const entries = targets
      .filter((t) => !ws || t.local.workspaceId === ws)
      .map((t) => ({
        name: t.alias,
        description: t.kind === 'brain'
          ? `Moa of PC ${t.alias.split('/')[0]} (linked to this PC's Moa; send_message to: "${t.alias}"; message only)`
          : `Remote pane ${t.alias} (linked to local pane ${t.local.paneId}; message only)`,
        url: remoteWorkspaceId(t.linkId),
        version: '1.0',
        capabilities: { stateTransitionHistory: true },
        skills: [],
        skillsRegistered: false,
        live: false,
        remote: true,
        panes: [],
        metadata: {
          workspaceId: remoteWorkspaceId(t.linkId),
          status: 'remote',
          agentName: null,
          live: false,
          remote: true,
          linkId: t.linkId,
          hostId: t.hostId,
          ...(t.local.paneId ? { localPaneId: t.local.paneId } : {}),
          endpoint: t.kind,
          allowOutbound: t.allowOutbound,
        },
      }));
    return entries.length ? { ...res, agents: [...res.agents, ...entries] } : res;
  });
  router.register('a2a.broadcast', async (params, ctx) =>
    refuseHandoffMarker('a2a.broadcast', params.message, ctx)
    ?? sendToRenderer(getWindow, 'a2a.broadcast', withOperatorOrigin(params, ctx)));
  router.register('meta.setSkills', (params) => sendToRenderer(getWindow, 'meta.setSkills', params));

  // task.query — 데몬 정본 + 렌더러 캐시 병합(envelope PR4).
  // 렌더러: 렌더러-로컬 생성 태스크(채널멘션 chmention-* 등)와 세션 내 증분
  // 히스토리를 보유. 데몬: 재시작을 생존한 정본 태스크를 보유(내구화의 가치).
  // 병합 규칙(패널 D): 같은 id면 **데몬이 더 최신일 때 데몬 status/updatedAt 우선**.
  // 데몬 커밋 후 렌더러가 daemonCommitted를 적용하기 전 크래시/불달이면 렌더러
  // 캐시가 stale인데, 렌더러-무조건-우선은 그 stale이 정본을 영영 가린다. 데몬이
  // 더 최신이면 status/updatedAt만 데몬 값으로 덮고, 렌더러 전용 증분(history·
  // artifacts)은 보존한다(§6.F — 증분 히스토리는 아직 데몬 비내구). 데몬-only
  // id(재시작 생존분)는 추가. 데몬 미가용이면 현행 렌더러-only와 동일.
  router.register('a2a.task.query', async (rawParams, ctx) => {
    // Reading one remote task by id is what the sender's `read` receipt means.
    // The daemon checks the caller is the task's receiving workspace.
    const readId = typeof rawParams.taskId === 'string' ? rawParams.taskId : '';
    const reader = ctx?.commanderWorkspace ?? (typeof rawParams.workspaceId === 'string' ? rawParams.workspaceId : '');
    if (remote?.read && isRemoteTaskId(readId) && reader) {
      void remote.read({ taskId: readId, workspaceId: reader }).catch(() => undefined);
    }
    // view: 'page' (a2a_task_query): each source returns summaries (or the one
    // named task), and the merged result is paged here — see a2aTaskQueryView.
    const paged = isPagedTaskQuery(rawParams);
    // #1598: both sources flag tasks whose receiver pane is gone, from the live
    // pane list main reads here. Never taken from the wire.
    const params: Record<string, unknown> = { ...rawParams };
    delete params.livePaneIds;
    // `page` is the only public view. `anchors` (#1680) is main's own
    // open-task read, sent straight to the daemon; a pipe caller cannot ask for
    // it, nor for any other value, which would reach both task sources as-is.
    if (params.view !== 'page') delete params.view;
    if (paged && typeof params.workspaceId === 'string' && params.workspaceId) {
      const panes = await readWorkspacePanes(getWindow, params.workspaceId);
      if (panes) params.livePaneIds = panes.map((pane) => pane.id as string);
    }
    const taskId = pagedTaskId(params);
    const summaries = paged && !taskId;
    const shape = (result: unknown): unknown => (paged
      ? shapeTaskQueryResult(filterByStatus(result), {
        taskId,
        messageId: typeof params.messageId === 'string' && params.messageId ? params.messageId : undefined,
        limit: typeof params.limit === 'number' ? params.limit : undefined,
        cursor: typeof params.cursor === 'string' && params.cursor ? params.cursor : undefined,
      })
      : result);
    const stateOf = (t: Record<string, unknown>): unknown =>
      (summaries ? t.state : isRecord(t.status) ? t.status.state : undefined);
    const updatedAtOf = (t: Record<string, unknown>): string =>
      (summaries ? (typeof t.updatedAt === 'string' ? t.updatedAt : '') : taskUpdatedAt(t));
    const statusFilter = typeof params.status === 'string' ? params.status : undefined;
    // A daemon-only answer carries tasks the renderer never filtered.
    const filterByStatus = (result: unknown): unknown => (
      statusFilter && isRecord(result) && Array.isArray(result.tasks)
        ? { ...result, tasks: (result.tasks as Array<Record<string, unknown>>).filter((t) => stateOf(t) === statusFilter) }
        : result);
    let rendererRes: unknown = null;
    try {
      rendererRes = await sendToRenderer(getWindow, 'a2a.task.query', params);
    } catch (err) {
      rendererRes = null; // 렌더러 미가용(early boot) — 데몬 단독 응답 시도
      if (!getDaemonClient?.()) throw err; // 양쪽 다 없으면 현행대로 전파
    }
    // 렌더러의 구조화 검증 에러(workspaceId 누락·불량 커서)는 계약 그대로 반환 —
    // 데몬-only 응답으로 대체하면 오늘의 에러 계약이 사라진다.
    if (isRecord(rendererRes) && typeof rendererRes.error === 'string') return rendererRes;
    // 커서는 렌더러와 동일하게 canonical UTC ISO로 정규화해 데몬에 전달한다
    // (데몬 projection의 사전순 비교 건전성 — useRpcBridge A9와 동일 이유).
    let updatedSince: string | undefined;
    if (typeof params.updatedSince === 'string' && params.updatedSince.trim()) {
      const ms = Date.parse(params.updatedSince.trim());
      if (!Number.isNaN(ms)) updatedSince = new Date(ms).toISOString();
    }
    // status 필터는 데몬 조회에 넣지 않는다(패널 델타): 데몬 정본이 필터 밖 상태이면
    // (예: 렌더러 stale=working인데 데몬 정본=completed, 필터=working) 데몬 조회가 그
    // 태스크를 빼버려 same-id override가 불가능해진다. 데몬은 status 무필터로 받아
    // 병합해 정본을 덮은 뒤, 최종 merged에 status 필터를 적용한다. role(불변)·
    // updatedSince(커서)는 override 문제가 없어 데몬 조회에 유지.
    // A paged call gets a short daemon deadline: a daemon from before the paged
    // view answers with every full task, which can outgrow the 1 MiB control
    // line and be dropped, and waiting out the default 10 s would time out the
    // caller too. The renderer answer stands in, as for any unavailable daemon.
    const gate = await daemonTaskRpc(getDaemonClient, 'a2a.task.query', {
      workspaceId: params.workspaceId,
      ...(typeof params.role === 'string' ? { role: params.role } : {}),
      ...(updatedSince ? { updatedSince } : {}),
      ...(paged ? { view: 'page', ...(taskId ? { taskId } : {}) } : {}),
      ...(params.livePaneIds ? { livePaneIds: params.livePaneIds } : {}),
    }, paged ? { timeoutMs: PAGED_TASK_QUERY_DAEMON_TIMEOUT_MS } : {});
    if (gate.kind !== 'ok') return shape(rendererRes);
    const rawDaemonTasks = Array.isArray(gate.result.tasks) ? (gate.result.tasks as Array<Record<string, unknown>>) : [];
    // A daemon from before the paged view ignores it and sends full tasks
    // (they carry metadata; a summary row does not): summarize them here so
    // one list never mixes the two shapes.
    const daemonTasks = summaries
      ? rawDaemonTasks.map((t) => (isRecord(t.metadata) ? flagOrphanedTask(summarizeTask(t), t, params) : t))
      : rawDaemonTasks;
    const rendererOk = isRecord(rendererRes) && Array.isArray(rendererRes.tasks);
    if (!rendererOk) {
      return shape({ workspaceId: params.workspaceId, tasks: daemonTasks });
    }
    const rendererTasks = (rendererRes as { tasks: Array<Record<string, unknown>> }).tasks;
    const daemonById = new Map(daemonTasks.map((t) => [t.id, t]));
    const merged = rendererTasks.map((rt) => {
      const dt = daemonById.get(rt.id);
      if (!dt) return rt;
      // A remote task's history grows in the daemon (the peer's replies), so
      // the daemon copy is the whole truth for it.
      if (isRemoteTaskId(rt.id)) return dt;
      // 데몬 정본이 렌더러 캐시보다 최신이면(렌더러가 daemonCommitted 미적용) status/
      // updatedAt을 데몬 값으로 덮되 렌더러 전용 증분(history·artifacts)은 보존.
      if (updatedAtOf(dt) > updatedAtOf(rt)) {
        if (summaries) return { ...rt, state: dt.state, updatedAt: dt.updatedAt };
        const rtMeta = isRecord(rt.metadata) ? rt.metadata : {};
        const dtMeta = isRecord(dt.metadata) ? dt.metadata : {};
        return { ...rt, status: dt.status, metadata: { ...rtMeta, updatedAt: dtMeta.updatedAt } };
      }
      return rt;
    });
    const seen = new Set(rendererTasks.map((t) => t.id));
    merged.push(...daemonTasks.filter((t) => !seen.has(t.id)));
    // 데몬 무필터 조회분(override·append)에 최종 status 필터를 적용한다 —
    // 렌더러는 이미 status로 걸렀지만, 데몬 override로 상태가 바뀐 태스크(stale
    // working→canonical completed)와 데몬-only 추가분은 여기서 걸러져야 한다.
    const finalTasks = statusFilter ? merged.filter((t) => stateOf(t) === statusFilter) : merged;
    return shape({ ...(rendererRes as Record<string, unknown>), tasks: finalTasks });
  });

  // task.update — 데몬 정본 게이트 선행(envelope PR4 C12 대칭 경로).
  // 데몬 ok → 렌더러에 daemonCommitted 마커 + committedTask로 verbatim 캐시 적용 +
  // 메시지 배달/이벤트 방출(렌더러 UI 반응성 로직 보존). 데몬 reject → 렌더러
  // 미접촉 반환(재판정 금지). 데몬 unavailable → 현행 렌더러-검증 경로 폴백.
  router.register('a2a.task.update', async (rawParams, ctx) => {
    const marked = refuseHandoffMarker('a2a.task.update', rawParams.message, ctx);
    if (marked) return marked;
    const params = withOperatorOrigin(rawParams, ctx);
    // A brain moves a remote task as its token-verified workspace (Moa: the
    // HQ), never a wire value: the state also goes to the other PC.
    if (ctx?.commanderWorkspace && remote && isRemoteTaskId(params.taskId)) params.workspaceId = ctx.commanderWorkspace;
    // 메시지 선검증(shared validateMessage — 렌더러와 동일 계약): 데몬 커밋 후
    // 렌더러가 메시지를 거부해 캐시-데몬이 갈라지는 창을 닫는다.
    if (typeof params.message === 'string') {
      try { validateMessage(params.message); } catch (e) {
        return { error: `a2a.task.update: ${e instanceof Error ? e.message : 'invalid'}` };
      }
    }
    // A Moa hand-off is the operator's task, so its receiver never closes it
    // through this lane. The HQ that proposed it may close it as completed once
    // the worker's turn has ended; main moves it, with the worker's closing
    // words as the result. The caller proves it is that HQ by its own pane
    // there (or its commander token). Any other caller falls through to the
    // receiver rules below, which refuse it.
    if (params.status === 'completed' && typeof params.taskId === 'string' && typeof params.workspaceId === 'string') {
      const handoffs = getMoaHandoffService();
      if (handoffs && handoffs.byTask(params.taskId)?.hqWorkspaceId === params.workspaceId) {
        const proven = ctx?.commanderWorkspace === params.workspaceId
          || (await resolveCallerPane(getWindow, params.workspaceId, params.senderPtyId)).kind === 'resolved';
        if (!proven) return { error: 'a2a.task.update: only the HQ that proposed this hand-off may close it' };
        const done = await handoffs.requesterComplete(params.workspaceId, params.taskId);
        if (done.ok) return { ok: true, taskId: params.taskId, status: 'completed', result: done.result };
        return { error: `a2a.task.update: hand-off not closed (${done.code}): ${HANDOFF_CLOSE_REFUSAL[done.code]}${done.message ? ` (${done.message})` : ''}` };
      }
    }
    // External callers must prove their pane to move a pane-pinned task; the
    // human operator and in-process first-party lanes are trusted as before.
    const trustedLane = ctx?.operator === true || (ctx?.firstParty === true && !isHostedCaller(ctx));
    params.requirePaneIdentity = !trustedLane;
    if (typeof params.status === 'string') {
      const callerPane = await resolveCallerPane(getWindow, params.workspaceId, params.senderPtyId);
      const gate = await daemonTaskRpc(getDaemonClient, 'a2a.task.update', {
        taskId: params.taskId,
        workspaceId: params.workspaceId,
        status: params.status,
        // S-C2: the daemon cannot map a ptyId to a pane, so main resolves it here
        // and the daemon runs the pane gate itself. Without this, every update
        // from an MCP agent on a pane-pinned task was deferred to the renderer
        // cache only, and the durable copy stayed `submitted`.
        // #1598: the same read's pane list lets the daemon tell a gone
        // receiver pane (adoptable by this workspace) from a live one.
        ...(callerPane.kind === 'resolved'
          ? { senderPtyId: params.senderPtyId, callerPaneId: callerPane.paneId, livePaneIds: callerPane.livePaneIds }
          : callerPane.kind === 'unknown' && typeof params.senderPtyId === 'string'
            ? { senderPtyId: params.senderPtyId }
            : {}),
        ...(callerPane.kind === 'absent' && !trustedLane ? { requirePaneIdentity: true } : {}),
        ...(params.evidence !== undefined ? { evidence: params.evidence } : {}),
        // §4 멱등(리뷰 codex): 파이프 호출자의 키를 데몬까지 전달한다 — 없으면 커밋 후
        // 응답 유실 재시도가 캐시 미스 → invalid transition(completed->completed)으로 변질.
        ...(typeof params.idempotencyKey === 'string' ? { idempotencyKey: params.idempotencyKey } : {}),
      });
      if (gate.kind === 'reject') return { error: gate.error };
      // A receiver's cancel also stops a background worker running the task.
      // Once the daemon committed it, stop the worker before the renderer call:
      // a renderer that throws or times out must not leave it running (a retry
      // is refused as an invalid transition).
      const cancelWorker = params.status === 'canceled' && typeof params.taskId === 'string'
        ? params.taskId
        : undefined;
      if (gate.kind === 'ok') {
        if (cancelWorker) claudeWorker.cancel(cancelWorker);
        // Work link (best-effort): the daemon's committed state is the truth.
        void recordTaskState(params.taskId, stateOfTask(gate.result.task), undefined, gate.result.task);
        const applied = await sendToRenderer(getWindow, 'a2a.task.update', {
          ...params,
          daemonCommitted: true,
          committedTask: gate.result.task,
        });
        if (typeof params.taskId === 'string') await queueRemoteState(params.taskId, params.status, params.evidence);
        return applied;
      }
      // unavailable → the renderer's own checked writer (fallback). Only an
      // explicit ok from it counts as a committed cancel.
      const res = await sendToRenderer(getWindow, 'a2a.task.update', params);
      if (cancelWorker && isRecord(res) && res.ok === true) claudeWorker.cancel(cancelWorker);
      if (isRecord(res) && res.ok === true) {
        // No committed task on this path: its report is the update itself.
        void recordTaskState(params.taskId, params.status, undefined,
          { status: { state: params.status, message: params.message, evidence: params.evidence } });
      }
      return res;
    }
    // A message on a remote task is a reply for the peer host.
    if (typeof params.message === 'string' && remote && typeof params.taskId === 'string' && isRemoteTaskId(params.taskId)) {
      return replyRemote('a2a.task.update', params.taskId, params, ctx);
    }
    // Message-only update: may reopen an ended task (daemon first).
    if (typeof params.message === 'string') {
      const prepared = await prepareReopen('a2a.task.update', params);
      if ('response' in prepared) return prepared.response;
      const res = await sendToRenderer(getWindow, 'a2a.task.update', prepared.params);
      if (isRecord(res) && res.ok === true) {
        void recordTaskState(params.taskId, reopenedState(prepared.params));
      }
      return res;
    }
    return sendToRenderer(getWindow, 'a2a.task.update', params);
  });

  // task.send: renderer validates, approval-gates execute:true, then stores +
  // delivers. Main only spawns the background worker after renderer reports that
  // the pre-create execute approval succeeded.
  // envelope PR4: 렌더러 성공 후 데몬 A2aTaskService에 정본 미러-생성한다(주소
  // 해석·승인 게이트 등 렌더러 UI 반응성 로직은 그대로). 워커 spawn **전에**
  // await — 이후 전이(working/completed)가 데몬 게이트에서 태스크를 찾도록.
  router.register('a2a.task.send', async (params, ctx) => {
    const marked = refuseHandoffMarker('a2a.task.send', [params.message, params.title], ctx);
    if (marked) return marked;
    // Cross-host A2A: a reply on a remote task, or a new task to a remote
    // pane's exact alias, goes to the peer host instead of a local pane.
    if (remote && typeof params.taskId === 'string' && isRemoteTaskId(params.taskId)) {
      if (params.execute === true) return { error: 'a2a.task.send: execute is only supported for new tasks' };
      return replyRemote('a2a.task.send', params.taskId, params, ctx);
    }
    if (!params.taskId) {
      const matches = await remoteTargetsFor(params.to);
      if (matches.length > 0) return sendRemoteTask(params, matches, ctx);
      // A remote end's id never names a local workspace: no active link, no send.
      if (isRemoteWorkspaceId(params.to)) return { error: `a2a.task.send: "${params.to}" is not an active link to another PC` };
    }
    // Forward the VALIDATED commander binding (RpcRouter set it from the
    // per-spawn token; never read from the wire, so any caller-supplied value
    // is dropped first). The renderer's reply-delivery guards need it: an
    // orchestrator brain owns no pane, so without this every brain→worker nudge
    // in its own workspace is suppressed as an unverifiable sender.
    //
    // `workspaceId` is PINNED to the same binding, exactly as pane.rpc does for
    // its confinement: the relaxation is keyed on the binding naming the
    // caller's own workspace, so a brain that could still name a different
    // `workspaceId` on the wire would carry its privilege into someone else's.
    let sendParams: Record<string, unknown> = withOperatorOrigin(params, ctx);
    delete sendParams.commanderWorkspaceId;
    // A main-registered delivery check (deliveryGuards.ts), kept only on the
    // operator lane. It can only add a refusal, never skip a check.
    if (ctx?.operator === true && typeof params.deliveryGuardKey === 'string' && params.gatedDelivery === true) {
      sendParams.deliveryGuardKey = params.deliveryGuardKey;
    }
    // A task id main minted for a new operator send (moaHandoff.ts).
    if (ctx?.operator === true && typeof params.presetTaskId === 'string' && !params.taskId && !isRemoteTaskId(params.presetTaskId)) {
      sendParams.presetTaskId = params.presetTaskId;
    }
    // A trusted in-process caller (Git page, fanout, Moa) that created the work
    // link first names it here, so the new task joins that link instead of
    // starting a twin. Never taken from an external caller; main-only.
    const linkTrusted = ctx?.operator === true || (ctx?.firstParty === true && !isHostedCaller(ctx));
    const workLinkId = linkTrusted && typeof sendParams.workLinkId === 'string' ? sendParams.workLinkId : undefined;
    delete sendParams.workLinkId;
    if (ctx?.commanderWorkspace) {
      sendParams.commanderWorkspaceId = ctx.commanderWorkspace;
      sendParams.workspaceId = ctx.commanderWorkspace;
      // Moa (the HQ brain) gives work to another workspace only through a
      // hand-off the operator approves (moa_propose_handoff). A new task from
      // it may go to its own workspace and its own fan-out tasks; the renderer
      // refuses any other target after it resolves `to`.
      if (!params.taskId && ctx.commanderWorkspace === getHqWorkspaceId()) {
        let own: string[] = [];
        try {
          own = getTaskLedger().list({ ownerWorkspaceId: ctx.commanderWorkspace }).map((e) => e.taskWorkspaceId);
        } catch {
          // a ledger we cannot read grants nothing extra
        }
        sendParams.hqHandoffOnly = { allowedTargets: [ctx.commanderWorkspace, ...own] };
      }
    }
    // A NEW execute send's reply is held until the user answers the approval
    // prompt, which the 5 s bridge default gave up on long before (#1462). The
    // renderer bounds that prompt against this same value, so it always
    // answers first. Plain sends keep the default: nothing in them waits on a
    // person.
    const awaitsApproval = params.execute === true && !params.taskId;
    // A reply may reopen an ended task: commit that in the daemon first.
    if (params.taskId && params.execute !== true) {
      const prepared = await prepareReopen('a2a.task.send', sendParams);
      if ('response' in prepared) return prepared.response;
      sendParams = prepared.params;
    }
    // A NEW task's delivery may run the target pane's fresh-context step
    // (#1680): its command, up to FRESH_CONTEXT_TIMEOUT_MS of waiting, then
    // the paste. Replies never do, and keep the default.
    // A gated new task (the Git page's hand-off) also waits for the person to
    // stop typing: a longer wait, and a deadline main stamps (never taken from
    // the wire) after which nothing is written, so a late delivery cannot land
    // once this call has given up.
    const gatedNewTask = !awaitsApproval && !params.taskId && sendParams.gatedDelivery === true;
    if (gatedNewTask) {
      sendParams.deliveryDeadlineAt = Date.now() + GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS - GATED_DELIVERY_DEADLINE_MARGIN_MS;
    }
    const result = awaitsApproval
      ? await sendToRenderer(getWindow, 'a2a.task.send', sendParams, { timeoutMs: EXECUTE_SEND_MAIN_TIMEOUT_MS })
      : !params.taskId
        ? await sendToRenderer(getWindow, 'a2a.task.send', sendParams, {
            timeoutMs: gatedNewTask ? GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS : NEW_TASK_SEND_MAIN_TIMEOUT_MS,
          })
        : await sendToRenderer(getWindow, 'a2a.task.send', sendParams);

    // 데몬 정본 미러-생성(신규 태스크 브랜치에서만 — 렌더러가 task 스냅샷 동반).
    // 실패는 soft-degrade: 이후 전이가 'task not found'로 렌더러 폴백을 탄다.
    if (isRecord(result) && result.ok === true && isRecord(result.task) && !params.taskId) {
      // Work link (best-effort, never awaited): read before `task` is stripped.
      // A commander brain's send is a Moa delegation (docs/work-links.md).
      void recordSentTask(workLinkFromSentTask(result, { fromCommander: !!ctx?.commanderWorkspace, workLinkId }));
      const t = result.task as { id?: unknown; metadata?: { title?: unknown; from?: unknown; to?: unknown }; history?: unknown };
      if (typeof t.id === 'string' && isRecord(t.metadata)) {
        const mirror = await daemonTaskRpc(getDaemonClient, 'a2a.task.create', {
          id: t.id,
          title: t.metadata.title,
          from: t.metadata.from,
          to: t.metadata.to,
          ...(Array.isArray(t.history) ? { history: t.history } : {}),
        });
        // C(패널): 미러-생성 실패는 조용한 비내구 태스크가 된다(렌더러엔 있고 데몬엔
        // 없음 → 재시작 미생존). 이후 전이는 'task not found'로 렌더러 폴백해 수렴하나,
        // 침묵 손실은 관측 가능해야 한다(롤백/outbox는 §6.F 소관 — 여기선 경고만).
        if (mirror.kind !== 'ok') {
          console.warn(
            `[a2a.rpc] daemon mirror-create failed for task ${t.id} — will not survive restart:`,
            mirror.kind === 'reject' ? mirror.error : 'daemon unavailable',
          );
        }
      }
      // 내부 운반 필드 제거 — 파이프 호출자 응답 계약 불변.
      delete (result as Record<string, unknown>).task;
    }
    // A reply that reopened an ended task moves its link back with it.
    if (params.taskId && isRecord(result) && result.ok === true) {
      void recordTaskState(params.taskId, reopenedState(sendParams));
      // Track record: a reply from anyone but the task's owner is a nudge.
      noteTrackReply(params.taskId, sendParams.workspaceId);
    }

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

  // task.cancel: cancel worker + 데몬 정본 커밋 + 렌더러 캐시/이벤트(envelope PR4).
  router.register('a2a.task.cancel', async (params) => {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    if (taskId) claudeWorker.cancel(taskId);
    const gate = await daemonTaskRpc(getDaemonClient, 'a2a.task.cancel', {
      taskId,
      workspaceId: params.workspaceId,
      // §4 멱등(리뷰 codex): update 경로와 대칭 — 파이프 호출자 키를 데몬까지 전달.
      ...(typeof params.idempotencyKey === 'string' ? { idempotencyKey: params.idempotencyKey } : {}),
    });
    if (gate.kind === 'reject') return { error: gate.error };
    if (gate.kind === 'ok') {
      // G(패널 델타): 데몬이 실제로 canceled로 전이했을 때만 렌더러 cancelled 이벤트를
      // 태운다. 이미 종단(completed/failed)인 태스크의 멱등 no-op(데몬 G 수정)은 상태
      // 변화가 없는데, 렌더러 cancel 핸들러는 daemonCommitted 시 무조건 state:'canceled'
      // 이벤트를 하드코딩 방출한다(useRpcBridge :1951) → completed 태스크에 거짓 'canceled'
      // 이벤트. no-op이면 렌더러 라운드트립 없이 ok만 반환(캐시 표류는 query 병합이 수렴).
      const committed = isRecord(gate.result.task) ? gate.result.task : undefined;
      const committedState =
        committed && isRecord(committed.status) ? committed.status.state : undefined;
      if (committedState === 'canceled') {
        void recordTaskState(taskId, 'canceled');
        const applied = await sendToRenderer(getWindow, 'a2a.task.cancel', {
          ...params,
          daemonCommitted: true,
          committedTask: gate.result.task,
        });
        await queueRemoteState(taskId, 'canceled', undefined);
        return applied;
      }
      return { ok: true, taskId };
    }
    const res = await sendToRenderer(getWindow, 'a2a.task.cancel', params);
    if (isRecord(res) && res.ok === true) void recordTaskState(taskId, 'canceled');
    return res;
  });
}
