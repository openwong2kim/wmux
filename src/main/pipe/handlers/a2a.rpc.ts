import type { BrowserWindow } from 'electron';
import { refuseHandoffMarker } from '../handoffMarkerTripwire';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import { isHostedCaller } from '../../../shared/rpc';
import { sendToRenderer } from './_bridge';
import { resolvePtyOwnerWorkspace } from '../../workspace/ptyOwnership';
import type { ClaudeWorker } from '../../a2a/ClaudeWorker';
import type { DaemonClient } from '../../DaemonClient';
import * as fs from 'fs';
import * as os from 'os';
import { getPidMapDir } from '../../../shared/constants';
import { validateMessage, type Message, type Task } from '../../../shared/types';
import { COMPANY_BRIEF_KIND, COMPANY_RENDERER_METHOD, companyBriefOf, isCompanyTask, missingBriefFields, parseCompanySeat, renderRemoteBrief, type CompanySeat } from '../../../shared/company';
import { COMPANY_BLOCKED_BY_REFUSAL, COMPANY_BLOCKERS_MAX, COMPANY_HOLD_KEY, companyHeldMessageRefusal, companyHoldOf, companyHoldPhase, companyHoldWithholds, companyWaitingLine, type CompanyHoldMarker } from '../../../shared/companyHold';
import { configuredForge, forgeHosts } from '../../../shared/forgeHosts';
import {
  DONE_PR_CHECK_MAX,
  companyDonePrDecision,
  donePrRefs,
  tooManyDonePrs,
  withDonePrEvidence,
  type DonePrOutcome,
  type DonePrRef,
} from '../../../shared/companyDonePrCheck';
import { ghPrReviewService, type GhPrReviewService } from '../../github/GhPrReviewService';
import { EXECUTE_SEND_MAIN_TIMEOUT_MS } from '../../../shared/executeApprovalBounds';
import { GATED_DELIVERY_DEADLINE_MARGIN_MS, GATED_NEW_TASK_SEND_MAIN_TIMEOUT_MS, NEW_TASK_SEND_MAIN_TIMEOUT_MS } from '../../../shared/freshContext';
import { flagOrphanedTask, isPagedTaskQuery, pagedTaskId, shapeTaskQueryResult, summarizeTask, applyTaskQueryView } from '../../../shared/a2aTaskQueryView';
import { defaultSnapshot, withDeadline, SNAPSHOT_DEADLINE_MS } from '../../pty/portWatch';
import { claimTokenForPane, claimTokenForRun } from '../../workspace/workspaceClaimTrust';
import { isIdentityRunPty, liveIdentityRunAnchors } from '../../automation/runIdentity';
import type { PortSnapshot, SnapshotFn } from '../../pty/portWatch';
import { walkToOwningAnchor } from '../../pty/serverSidePidWalk';
import { isDaemonPtyId, liveDaemonPidEntries } from '../../pty/pidMap';
import type { DaemonSessionShell, PidMapFile } from '../../pty/pidMap';
import { tryProcessCreatedAt } from '../../pty/winSnapshotNative';
import { readWindowsAncestry } from './callerAncestry';
import { getAccountStore } from '../../account/accountStore';
import {
  CODEX_THREAD_ID_RE,
  classifyMcpParent,
  codexHome,
  matchOwnerToLiveAnchor,
  readCodexThreadOwner,
  readParentChain,
  type McpParentClass,
} from '../../../mcp/codexThreadIdentity';
import type { OwningAnchor } from '../../pty/serverSidePidWalk';
import { recordSentTask, recordTaskState, reopenedState, stateOfTask, workLinkFromRemoteSend, workLinkFromSentTask } from '../../workLink/a2aProducer';
import { noteTrackReply } from '../../deck/trackRecordFeed';
import { A2A_BRAIN_ALIAS, A2A_REMOTE_BODY_MAX, A2A_REMOTE_IMAGE_LIMITS, isRemoteTaskId } from '../../../shared/a2aRemote';
import {
  isRemoteWorkspaceId,
  remoteWorkspaceId,
  type A2aRemoteReplyInput,
  type A2aRemoteSendTaskInput,
  type A2aRemoteStateInput,
  type A2aRemoteTarget,
  type A2aStagedImage,
} from '../../../shared/a2aRemoteDelivery';

/** The daemon connection a resolve's pid-map entries were confirmed against (null: no daemon). */
type EntriesConfirmation = { client: DaemonClient | null };

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


/** How long main waits on gh for one PR of a company task's done, and on
 *  the whole check: the caller's MCP request gives up after 10 s. */
const DONE_PR_READ_DEADLINE_MS = 7_000;
const DONE_CHECK_BUDGET_MS = 9_000;
/** PRs read at once for one done. */
const DONE_PR_READS_AT_ONCE = 3;

const INTERNAL_RENDERER_FIELDS = [
  'trustedLane',
  'daemonCommitted',
  'committedTask',
  'daemonReopenedTask',
  'localReopen',
  'reopenPreflight',
  'requirePaneIdentity',
  'livePaneIds',
  'callerCompanySeat',
  'deliveryDeadlineAt',
  'deliveryGuardKey',
  'presetTaskId',
  // A send held for its blockers: stored silently with no `created` event.
  'heldForBlockers',
  // Cross-host A2A: only main's RemoteA2aBridge sets these, calling the
  // renderer directly (never through this router).
  'remoteFrom',
  'remoteMarker',
  // Images: main's checked copies (local sends) and the daemon's received
  // files (remote ones). From the wire they would put any path in a prompt.
  'attachments',
  'remoteImages',
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

/**
 * The task ids a new task's company brief waits on (`blockedBy`), without
 * repeats or empty ids, in the order asked: the same list the daemon derives
 * the task's hold from (shared/companyHold.ts companyHoldAtCreate).
 */
function blockedByOf(data: unknown): string[] {
  return [...new Set((companyBriefOf(data)?.blockedBy ?? []).filter((id) => id.length > 0))];
}

/**
 * A brief's `blockedBy` that is there but is not a list of task ids, or names
 * tasks in a brief that is not complete (only a complete brief's blockers hold
 * a task): refused, never ignored (a task sent at once while its sender meant
 * it to wait would be told too early). Null when it is absent or well formed.
 */
function malformedBlockedBy(data: unknown): string | null {
  if (!isRecord(data) || data.kind !== COMPANY_BRIEF_KIND || data.blockedBy === undefined) return null;
  const list = data.blockedBy;
  if (!Array.isArray(list) || !list.every((id) => typeof id === 'string' && id.trim().length > 0)) {
    return COMPANY_BLOCKED_BY_REFUSAL.malformed;
  }
  const missing = list.length > 0 ? missingBriefFields(data) : [];
  return missing.length > 0 ? COMPANY_BLOCKED_BY_REFUSAL.incompleteBrief(missing) : null;
}

/**
 * Who reads the daemon's tasks, as its a2a.task.query takes it: a company task
 * that still waits on a blocker is kept from its receiving side unless the
 * caller is its sender's pane or the human (shared/companyHold.ts).
 */
type TaskQueryCaller = { paneId?: string; trusted?: true };

function taskQueryCallerParams(caller: TaskQueryCaller): Record<string, unknown> {
  return {
    ...(caller.paneId ? { callerPaneId: caller.paneId } : {}),
    ...(caller.trusted ? { trustedLane: true } : {}),
  };
}

/** The ids a daemon a2a.task.query kept from this caller (`withheld`): its renderer copies go too. */
function withheldIdsOf(result: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(result.withheld) ? result.withheld.filter((id): id is string => typeof id === 'string') : []);
}

/**
 * True for a renderer copy of a task the daemon would keep from this caller
 * (used when the daemon is not there to say so). Only a full task carries the
 * marker; a copy without it passes.
 */
function copyWithheld(task: unknown, workspaceId: string, caller: TaskQueryCaller): boolean {
  return isRecord(task) && isRecord(task.metadata) && isRecord(task.metadata.to)
    && companyHoldWithholds(task as unknown as Task, { workspaceId, ...caller });
}

/**
 * A merged task row with the daemon's company hold on it, whatever the row's
 * age: the daemon is the hold's record. The renderer's copy has at most a
 * provisional marker from its send, which the daemon's replaces.
 */
function withDaemonHold(row: Record<string, unknown>, daemonRow: Record<string, unknown>, summaries: boolean): Record<string, unknown> {
  if (summaries) {
    const keys = ['waitingOn', 'held'] as const;
    if (!keys.some((k) => row[k] !== undefined || daemonRow[k] !== undefined)) return row;
    const out: Record<string, unknown> = { ...row };
    for (const k of keys) {
      if (daemonRow[k] === undefined) delete out[k];
      else out[k] = daemonRow[k];
    }
    return out;
  }
  const daemonMeta = isRecord(daemonRow.metadata) ? daemonRow.metadata : {};
  const rowMeta = isRecord(row.metadata) ? row.metadata : {};
  if (daemonMeta[COMPANY_HOLD_KEY] === undefined && rowMeta[COMPANY_HOLD_KEY] === undefined) return row;
  const metadata: Record<string, unknown> = { ...rowMeta };
  if (daemonMeta[COMPANY_HOLD_KEY] === undefined) delete metadata[COMPANY_HOLD_KEY];
  else metadata[COMPANY_HOLD_KEY] = daemonMeta[COMPANY_HOLD_KEY];
  return { ...row, metadata };
}

/** The pane of `panes` that holds `ptyId`, or undefined. */
function paneOfPty(panes: ReadonlyArray<Record<string, unknown>>, ptyId: string): string | undefined {
  const pane = panes.find((p) => Array.isArray(p.surfacePtyIds) && p.surfacePtyIds.includes(ptyId));
  return pane ? (pane.id as string) : undefined;
}

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
  /** `livePaneIds`: every pane of the caller's workspace, from the same read;
   *  `companySeat`: the pane's seat when its workspace is a company. */
  | { kind: 'resolved'; paneId: string; livePaneIds: string[]; companySeat?: CompanySeat }
  /** No senderPtyId, or one that is not a terminal in the caller's own workspace. */
  | { kind: 'absent' }
  /** The pane tree could not be read: keep the daemon's deferral to the renderer. */
  | { kind: 'unknown' };

/**
 * Map the caller's senderPtyId to its pane inside the caller's OWN workspace,
 * the same resolution the renderer's update path makes (stashed panes count, a
 * ptyId the workspace does not own is treated as absent).
 */
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
    if (ptys.includes(senderPtyId)) {
      const companySeat = parseCompanySeat(pane.companySeat);
      return { kind: 'resolved', paneId: pane.id as string, livePaneIds, ...(companySeat ? { companySeat } : {}) };
    }
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
 * the default) and each registered account's config dir, since a thread
 * started under another account's app-server keeps its owner index there. A
 * dir with no owner index (another agent's account) simply misses.
 */
function codexHomes(): string[] {
  const homes = new Set<string>([codexHome(process.env), codexHome({ ...process.env, CODEX_HOME: '' })]);
  try {
    for (const account of getAccountStore().listAccounts()) {
      if (account.configDir) homes.add(account.configDir);
    }
  } catch {
    /* an unreadable account store leaves the default homes */
  }
  return [...homes];
}

/**
 * The pane a Codex thread's owner record names, with a claim on it, or null.
 * Only for a caller main has seen to run under a shared Codex app-server
 * (`callerIsSharedServerChild`): a thread id is a routing input, and only that
 * parent hands one to an MCP server.
 */
function resolveCodexThreadClaim(
  threadId: unknown,
  entries: ReadonlyArray<{ ptyId: string; workspaceId: string }>,
  callerIsSharedServerChild: boolean,
): { workspaceId: string; ptyId: string; workspaceToken: string } | null {
  if (!callerIsSharedServerChild) return null;
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

/** Soft cap for the whole resolve.identity call, under the MCP client's ~10s RPC
 *  timeout. The snapshot wait is bounded to whatever remains after the pid-map
 *  scan so a hung Win32_Process query can't sink the legacy fallback response. */
const RPC_SNAPSHOT_DEADLINE_MS = 8000;

/** `note`: what the sender should know (images omitted for an older peer). */
type RemoteOpResult = { ok: true; taskId: string; note?: string } | { ok: false; error: string };

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
  /**
   * Check and keep an agent's images for a pane on this PC (`a2a.attachments.stage`):
   * from `ptyId`'s folders when main verified that pane, else `~/.wmux/uploads` only.
   */
  stageImages?: (input: { paths: string[]; ptyId?: string; workspaceId?: string }) => Promise<{ ok: true; images: A2aStagedImage[] } | { ok: false; error: string }>;
  /**
   * Paired PCs with no active link in the workspace (every workspace when
   * omitted). `panesOf` counts a local workspace's panes, from discover's own list.
   */
  listPeers?: (workspaceId: string | undefined, panesOf: Promise<(workspaceId: string) => number>) => Promise<A2aRemotePeerHint[]>;
}

/**
 * What the a2a handlers ask of main's CompanyReleaseBridge: pull the released
 * company tasks now (a task just ended, or a hold was released at create).
 */
export interface CompanyReleaseHook {
  pullNow(): void;
}

/**
 * One paired PC that a2a.discover cannot list as an agent yet: a count and a
 * line saying which step is missing. Never names a pane or carries an id.
 */
export interface A2aRemotePeerHint {
  name: string;
  paired: true;
  connected: boolean;
  /**
   * Panes that PC shows this one, as it last answered (asked again every 30 s
   * at most, never while discover waits); null when it joined this PC, it is
   * away, or it has not answered yet.
   */
  exposedPanes: number | null;
  /** Link requests waiting for a person, on either PC. */
  pendingLinks: number;
  hint: string;
}

/** Distinct panes per workspace in the renderer's discover agents (each entry's `url` is its workspace id). */
function paneCounter(agents: unknown[]): (workspaceId: string) => number {
  const byWs = new Map<string, Set<string>>();
  for (const a of agents) {
    if (!isRecord(a) || typeof a.url !== 'string' || !Array.isArray(a.panes)) continue;
    const ids = new Set<string>();
    for (const p of a.panes) if (isRecord(p) && typeof p.paneId === 'string') ids.add(p.paneId);
    byWs.set(a.url, ids);
  }
  return (workspaceId) => byWs.get(workspaceId)?.size ?? 0;
}

/** The most a2a.discover waits for the paired-PC hints; past it they are left out. */
export const PEER_HINTS_DEADLINE_MS = 2_000;

const REMOTE_QUEUED = { stored: true, notified: false, queued: true, reason: 'queued_for_remote_host' } as const;

const IMAGES_MAX = A2A_REMOTE_IMAGE_LIMITS.PER_MESSAGE;

/**
 * `images` of a send: undefined when absent, null when not a list of 1-4
 * absolute paths. A Windows device path (`\\?\`, `\\.\`) is never one; a
 * share path is left to the daemon, which takes it only on a share a root is on.
 */
function imagePathsOf(v: unknown): string[] | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.length > IMAGES_MAX) return null;
  const isAbs = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  const device = (p: string): boolean => /^[\\/]{2}[?.][\\/]/.test(p);
  return v.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 4096 && isAbs(p) && !device(p)) ? (v as string[]) : null;
}
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
    /** Who spawned a Codex-thread caller, from its ancestors' argv; tests inject one. */
    classifyCodexCaller?: (pid: number) => Promise<McpParentClass>;
    remote?: RemoteA2aRpcDeps;
    /** The gh reads of a company task's done check; tests inject one. */
    prReview?: Pick<GhPrReviewService, 'donePrFacts'>;
    /** Main's CompanyReleaseBridge of the moment (one per daemon connection), or null. */
    companyRelease?: () => CompanyReleaseHook | null;
  } = {},
): void {
  const getDaemonClient = opts.getDaemonClient;
  const remote = opts.remote;
  const prReview = opts.prReview ?? ghPrReviewService;

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
    // A task held on its blockers waits on this PC's daemon record; a task to
    // another PC has no such hold yet (v1).
    const malformed = malformedBlockedBy(params.data);
    if (malformed) return { error: `a2a.task.send: ${malformed}` };
    if (blockedByOf(params.data).length > 0) return { error: `a2a.task.send: ${COMPANY_BLOCKED_BY_REFUSAL.remoteTask}` };
    // An alias must name exactly one link: never pick one of several silently.
    if (matches.length > 1) {
      return { error: `a2a.task.send: "${alias}" names ${matches.length} links; send to the exact alias a2a_discover lists for the one you mean (a repeated name gets a #2, #3 suffix)` };
    }
    let message: string;
    try { message = validateMessage(typeof params.message === 'string' ? params.message : ''); } catch (e) {
      return { error: `a2a.task.send: ${e instanceof Error ? e.message : 'invalid'}` };
    }
    const images = imagePathsOf(params.images);
    if (images === null) return { error: `a2a.task.send: images must be a list of up to ${IMAGES_MAX} absolute paths` };
    const title = typeof params.title === 'string' ? params.title : '';
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
              'Ask its PC\'s Moa instead (its <PC>/Moa alias from a2a_discover).',
          };
      }
      if (!brainLink.allowOutbound) return { error: `a2a.task.send: the link to "${alias}" does not allow sending from this side` };
      const res = await remote!.sendTask({
        linkId: brainLink.linkId,
        from: { workspaceId: hq, name: A2A_BRAIN_ALIAS },
        title,
        text: message,
        ...(images ? { images } : {}),
      }).catch((err: unknown): RemoteOpResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      if (!res.ok) return { error: `a2a.task.send: remote send refused (${res.error})` };
      void recordSentTask(workLinkFromRemoteSend({
        taskId: res.taskId, linkId: brainLink.linkId, alias: brainLink.alias, requester: { workspaceId: hq }, title, message, fromCommander: true,
      }));
      return {
        ok: true,
        taskId: res.taskId,
        remote: true,
        delivery: REMOTE_QUEUED,
        // What Moa reads right after sending: the wait is not the operator's decision.
        next: 'You are woken when the other Moa replies or completes it; a2a_task_query shows remoteReceipt delivered/read once it arrives. Do not raise a decision card about waiting: end your turn.',
        ...(res.note ? { note: res.note } : {}),
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
    // A company's CEO briefs a seat on another PC as one here: the brief is
    // written into the text that PC gets, and kept as data on this PC's copy.
    let text = message;
    let brief: ReturnType<typeof companyBriefOf> = null;
    if (caller.companySeat === 'coordinator') {
      brief = companyBriefOf(params.data);
      if (!brief) {
        return {
          error: `a2a.task.send: a task from a company's CEO to another PC needs a brief in data ({"kind":"${COMPANY_BRIEF_KIND}","v":1,…}); missing: ${missingBriefFields(params.data).join(', ')}`,
        };
      }
      text = renderRemoteBrief(message, brief);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > A2A_REMOTE_BODY_MAX) {
        return {
          error: `a2a.task.send: the message with its brief written out is ${bytes} bytes, over the ${A2A_REMOTE_BODY_MAX}-byte limit for a task to another PC; shorten the message or the brief`,
        };
      }
    }
    const res = await remote!.sendTask({
      linkId: link.linkId,
      // The verified sender pty: a reply from the peer is held if another
      // agent holds this pane by then.
      from: { workspaceId, name: workspaceId, paneId: caller.paneId, ptyId: params.senderPtyId as string },
      title,
      text,
      ...(images ? { images } : {}),
      ...(brief ? { brief } : {}),
    }).catch((err: unknown): RemoteOpResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    if (!res.ok) return { error: `a2a.task.send: remote send refused (${res.error})` };
    // Work link (best-effort, never awaited), as for a local send.
    void recordSentTask(workLinkFromRemoteSend({
      taskId: res.taskId, linkId: link.linkId, alias: link.alias, requester: { workspaceId, paneId: caller.paneId }, title, message, fromCommander: false,
    }));
    return { ok: true, taskId: res.taskId, remote: true, delivery: REMOTE_QUEUED, ...(res.note ? { note: res.note } : {}) };
  }

  /** A reply on a remote task: stored in the ledger and queued for the peer. */
  async function replyRemote(method: string, taskId: string, params: Record<string, unknown>, ctx: RpcContext | undefined): Promise<unknown> {
    let message: string;
    try { message = validateMessage(typeof params.message === 'string' ? params.message : ''); } catch (e) {
      return { error: `${method}: ${e instanceof Error ? e.message : 'invalid'}` };
    }
    const images = imagePathsOf(params.images);
    if (images === null) return { error: `${method}: images must be a list of up to ${IMAGES_MAX} absolute paths` };
    const workspaceId = ctx?.commanderWorkspace ?? (typeof params.workspaceId === 'string' ? params.workspaceId : '');
    // Whose folders the images may come from: the caller's pane, once verified
    // here (a brain has none, and gets the uploads folder only).
    const ptyId = images && !ctx?.commanderWorkspace ? await verifiedCallerPty(workspaceId, params.senderPtyId) : undefined;
    const res = await remote!.reply({
      taskId,
      // A brain answers as its token-verified workspace (Moa: the HQ).
      workspaceId,
      text: message,
      ...(images ? { images } : {}),
      ...(ptyId ? { ptyId } : {}),
    }).catch((err: unknown): RemoteOpResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    if (!res.ok) return { error: `${method}: remote reply refused (${res.error})` };
    return { ok: true, taskId, remote: true, delivery: REMOTE_QUEUED, ...(res.note ? { note: res.note } : {}) };
  }

  /** The caller's pty when it is a terminal of the caller's own workspace, else undefined. */
  async function verifiedCallerPty(workspaceId: string, senderPtyId: unknown): Promise<string | undefined> {
    if (typeof senderPtyId !== 'string' || !senderPtyId || !workspaceId) return undefined;
    const caller = await resolveCallerPane(getWindow, workspaceId, senderPtyId);
    return caller.kind === 'resolved' ? senderPtyId : undefined;
  }

  /**
   * A local send's images, checked and kept by the daemon in
   * `~/.wmux/uploads/a2a/local` (the receiver reads those copies), as the
   * renderer's `attachments`. Never taken from the wire.
   *
   * Refused before anything is copied when the send cannot carry them: a
   * background (`execute`) task is handed only the text, and a message with
   * no text is refused by the renderer. A commander brain owns no pane, so its
   * images come from the uploads folder only, as on the remote reply path.
   */
  async function stageLocalImages(params: Record<string, unknown>, ctx: RpcContext | undefined): Promise<{ attachments?: A2aStagedImage[] } | { error: string }> {
    const images = imagePathsOf(params.images);
    if (images === null) return { error: `a2a.task.send: images must be a list of up to ${IMAGES_MAX} absolute paths` };
    if (!images) return {};
    if (params.execute === true) return { error: 'a2a.task.send: images cannot go with execute (the background task is given the text only)' };
    if (typeof params.message !== 'string' || !params.message.trim()) return { error: 'a2a.task.send: a message with images needs text too' };
    if (!remote?.stageImages) return { error: 'a2a.task.send: images need the wmux daemon, which is not connected' };
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    const ptyId = ctx?.commanderWorkspace ? undefined : await verifiedCallerPty(workspaceId, params.senderPtyId);
    const staged = await remote.stageImages({ paths: images, ...(ptyId ? { ptyId, workspaceId } : {}) })
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (!staged.ok) return { error: `a2a.task.send: ${staged.error}` };
    return { attachments: staged.images };
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
  const classifyCodexCaller = opts.classifyCodexCaller ?? (async (pid: number) => classifyMcpParent(await readParentChain(pid)));
  // A shared app-server's MCP child lives as long as the server, so a
  // confirmed answer is kept a minute rather than re-reading argv every call.
  // 'unknown' is never kept.
  const codexCallerClass = new Map<number, { cls: McpParentClass; at: number }>();
  async function isSharedServerChild(pid: number | null): Promise<boolean> {
    if (pid === null) return false;
    const hit = codexCallerClass.get(pid);
    if (hit && Date.now() - hit.at < 60_000) return hit.cls === 'shared-server';
    let cls: McpParentClass = 'unknown';
    try {
      cls = await classifyCodexCaller(pid);
    } catch {
      cls = 'unknown';
    }
    if (cls !== 'unknown') {
      if (codexCallerClass.size > 256) codexCallerClass.clear();
      codexCallerClass.set(pid, { cls, at: Date.now() });
    }
    return cls === 'shared-server';
  }
  let snapInflight: Promise<PortSnapshot | null> | null = null;
  async function getCoalescedSnapshot(): Promise<PortSnapshot | null> {
    if (!snapInflight) {
      // Bounded, so a snapshot child that never exits frees the slot for the
      // next handshake instead of every later one joining it forever.
      snapInflight = withDeadline<PortSnapshot | null>(snapshotFn(), SNAPSHOT_DEADLINE_MS, null)
        .finally(() => { snapInflight = null; });
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
    /** The connection `entries` are confirmed against, or null (see confirmEntriesConnection). */
    confirmEntries: () => Promise<EntriesConfirmation | null> = async () => ({ client: currentDaemonClient() }),
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
    // The pane was found in `entries` before the await above; re-find it in
    // case a reconnect re-judged them, and mint only over the current client,
    // checked synchronously right before the mint.
    const confirmed = await confirmEntries();
    if (!stillConfirmed(confirmed) || !entries.some((e) => e === pane)) return { live: true };
    const workspaceToken = claimTokenForPane(pane.workspaceId, pane.ptyId);
    return workspaceToken ? { live: true, workspaceId: pane.workspaceId, workspaceToken } : { live: true };
  }

  // The daemon's session list for the resolve-time pid-map check, kept for a
  // short while so a burst of plain identity resolves costs one listSessions,
  // not one each. It is stamped with the DaemonClient that read it: every
  // (re)connect installs a new client, and a list from before a daemon restart
  // still names the shells the restart replaced, so it is never used after it.
  const DAEMON_SESSIONS_CACHE_MS = 2000;
  let daemonSessionsCache: { at: number; client: DaemonClient; sessions: DaemonSessionShell[] } | null = null;

  /** The DaemonClient now installed, or null when there is none. */
  function currentDaemonClient(): DaemonClient | null {
    return getDaemonClient?.() ?? null;
  }

  /**
   * Synchronous: the confirmation still holds only while the client it names
   * is the installed one. Call it on the line right before a mint, with no
   * await in between (a reconnect can land in any await, including the one
   * that produced `confirmed`).
   */
  function stillConfirmed(confirmed: EntriesConfirmation | null): boolean {
    return confirmed !== null && currentDaemonClient() === confirmed.client;
  }

  /**
   * A fresh, complete session list (suspended sessions included) and the
   * client it was asked of. `sessions` is null when the daemon is not
   * connected or did not answer.
   */
  async function fetchDaemonSessions(): Promise<{ sessions: DaemonSessionShell[] | null; client: DaemonClient | null }> {
    const dc = currentDaemonClient();
    if (!dc || dc.isConnected === false) return { sessions: null, client: dc };
    try {
      const rows = await dc.rpc('daemon.listSessions', { includeSuspended: true }, { timeoutMs: 2000 });
      if (!Array.isArray(rows)) return { sessions: null, client: dc };
      daemonSessionsCache = { at: Date.now(), client: dc, sessions: rows as DaemonSessionShell[] };
      return { sessions: daemonSessionsCache.sessions, client: dc };
    } catch {
      return { sessions: null, client: dc };
    }
  }

  /** The cached list, if it is recent and was read over the current connection. */
  function cachedDaemonSessions(): { sessions: DaemonSessionShell[]; client: DaemonClient } | null {
    const cache = daemonSessionsCache;
    if (!cache || Date.now() - cache.at >= DAEMON_SESSIONS_CACHE_MS) return null;
    return cache.client === currentDaemonClient() ? cache : null;
  }

  /**
   * `entries` without the daemon pid-map hits whose PID is not that session's
   * current shell, or whose session the daemon does not have (see
   * liveDaemonPidEntries). With no daemon (not connected, or the RPC failed)
   * nothing is filtered and identity falls back to the pid-map alone, as
   * before this check existed.
   *
   * `fresh` (a call that can mint a claim) always reads the list again: a
   * claim must rest on the shells the daemon runs now. Inside the cache window
   * a pane's shell can change (a supervised restart, a reconnect) while its
   * old pid-map file is still on disk and the cached list still names that
   * old PID as current, which would let a process on the reused PID claim the
   * pane. Otherwise a cached list is trusted only to keep entries: when it
   * lacks an entry's ptyId or disagrees with its PID, the list is read again,
   * so a pane created or given a new shell inside the window is not refused.
   *
   * `client` is the connection the answer rests on (the one that produced the
   * list, or the one current when no list was needed). A claim minted from
   * these entries must check it is still the installed client: see
   * confirmEntriesConnection in the resolve handler.
   */
  async function keepLiveDaemonPidEntries<T extends PidMapFile>(
    entries: T[],
    fresh: boolean,
  ): Promise<{ entries: T[]; client: DaemonClient | null }> {
    if (!entries.some((e) => isDaemonPtyId(e.ptyId))) return { entries, client: currentDaemonClient() };
    const cached = fresh ? null : cachedDaemonSessions();
    if (cached) {
      const kept = liveDaemonPidEntries(entries, cached.sessions);
      if (kept.length === entries.length) return { entries: kept, client: cached.client };
    }
    const { sessions, client } = await fetchDaemonSessions();
    return { entries: liveDaemonPidEntries(entries, sessions), client };
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

    // A pid-map hit counts only while its PID is still the pane's shell. A
    // daemon restart gives recovered sessions new shell PIDs; a file left on an
    // old PID the OS has reused (a new worker's own claude.exe) would otherwise
    // hand that process the old pane's identity. Filtered once here, so the
    // client-side walk (entries / mappings), the server-side walk below, and
    // the Codex thread and hinted-pane lookups all see only live anchors.
    // A call that can mint a claim (the server-side walk, a Codex thread, a
    // hinted pane) is judged on a fresh list, never the cache: the claims
    // below (claimTokenForPane, the thread claim) take these entries as proof
    // that the pane's shell is live.
    const claimParams = params as { codexThreadId?: unknown; hintedPtyId?: unknown };
    const mayMintClaim = callerPid != null || claimParams.codexThreadId !== undefined || claimParams.hintedPtyId !== undefined;
    const scannedEntries = [...entries];
    const scannedMappings = { ...mappings };
    const applyLiveEntries = (live: typeof entries): void => {
      const kept = new Set(live);
      for (const key of Object.keys(mappings)) delete mappings[key];
      for (const e of scannedEntries) if (kept.has(e)) mappings[e.pid] = scannedMappings[e.pid];
      entries.splice(0, entries.length, ...live);
    };
    const filtered = await keepLiveDaemonPidEntries(entries, mayMintClaim);
    if (filtered.entries.length !== entries.length) applyLiveEntries(filtered.entries);
    // The connection the entries were judged over. The resolve awaits more
    // (the process snapshot, the run list, the daemon's WSL answer), and a
    // reconnect in any of those waits installs a new client whose sessions
    // may have different shells.
    let entriesClient = filtered.client;
    let entriesRechecked = false;
    /**
     * Called before a claim is minted from `entries`. Resolves to the client
     * the entries are confirmed against, or null to refuse the claim. Awaiting
     * it yields to the event loop even when it answers at once, so a reconnect
     * can still land after it: the caller must compare the returned client
     * with the installed one SYNCHRONOUSLY, on the line before the mint
     * (`stillConfirmed`).
     *
     * While the client the entries were judged over is still installed, that
     * client is returned. If a reconnect replaced it, the list is read once
     * from the new client and the scanned entries judged again: an unchanged
     * result is confirmed against the new client; a changed one refuses (and
     * the response carries the re-judged entries). So does a re-read that
     * yields no list (failed or malformed): the "no daemon, no filtering"
     * fallback of a fresh resolve never confirms entries judged over another
     * connection. A second replacement refuses too.
     */
    const confirmEntriesConnection = async (): Promise<EntriesConfirmation | null> => {
      if (currentDaemonClient() === entriesClient) return { client: entriesClient };
      if (entriesRechecked) return null;
      entriesRechecked = true;
      const { sessions, client } = await fetchDaemonSessions();
      if (currentDaemonClient() !== client) return null;
      if (!sessions) return null;
      const live = liveDaemonPidEntries(scannedEntries, sessions);
      const unchanged = live.length === entries.length && live.every((e, i) => e === entries[i]);
      entriesClient = client;
      if (!unchanged) {
        applyLiveEntries(live);
        return null;
      }
      return { client };
    };

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
    // No pane owns the caller: it may be the agent of a scheduled run that
    // acts as a protected pane's browser. Those runs' shells are not pane
    // anchors (no renderer surface carries them), so the daemon lists the live
    // ones with their shell pid and the same walk is tried against those. A
    // hit gets a browser-only claim on the identity's workspace.
    let runClaim: string | null = null;
    // The same holds when the walk hit a pane whose PTY IS such a run: the
    // operator opened the run's terminal, which anchors it in whatever
    // workspace it opened in. The run still acts under its granted identity,
    // so its own claim wins over the pane one.
    if (callerPid != null && (!resolved || isIdentityRunPty(resolved.ptyId))) {
      const runs = await liveIdentityRunAnchors();
      const own = resolved ? runs.find((r) => r.ptyId === resolved?.ptyId) : undefined;
      if (own) {
        runClaim = claimTokenForRun(own.workspaceId, own.ptyId);
        if (runClaim) resolved = { workspaceId: own.workspaceId, ptyId: own.ptyId };
      } else if (!resolved && runs.length > 0) {
        const snapshot = await withDeadline(
          snapshotPromise,
          RPC_SNAPSHOT_DEADLINE_MS - (Date.now() - startedAt),
          null,
        );
        const ppidByPid =
          snapshot && snapshot.ppidByPid.has(callerPid)
            ? snapshot.ppidByPid
            : await readAncestry(callerPid, RPC_SNAPSHOT_DEADLINE_MS - (Date.now() - startedAt));
        const parentPid = ppidByPid?.get(callerPid);
        if (ppidByPid && parentPid !== undefined) {
          const runAnchors = new Map<number, OwningAnchor>(
            runs.map((r) => [r.pid, { ptyId: r.ptyId, workspaceId: r.workspaceId }]),
          );
          const hit = walkToOwningAnchor(parentPid, ppidByPid, runAnchors, { createdAt, child: callerPid });
          if (hit) {
            runClaim = claimTokenForRun(hit.anchor.workspaceId, hit.anchor.ptyId);
            if (runClaim) resolved = { workspaceId: hit.anchor.workspaceId, ptyId: hit.anchor.ptyId };
          }
        }
      }
    }

    // A pane claim from the walk rests on `entries`: confirm they were judged
    // over the connection installed now. The synchronous re-check and the mint
    // run with no await between them. A walk hit whose entries a reconnect
    // invalidated gets no claim and no `resolved`; the caller still has the
    // re-judged entries for its own walk, and its next resolve walks those.
    if (resolved && !runClaim) {
      const confirmed = await confirmEntriesConnection();
      if (!stillConfirmed(confirmed)) resolved = null;
    }
    const workspaceToken = resolved ? (runClaim ?? claimTokenForPane(resolved.workspaceId, resolved.ptyId)) : null;
    // A call from a shared Codex app-server names its thread instead: the pane
    // comes from the thread's owner record (written by wmux's Codex hooks from
    // inside that pane), joined with the LIVE anchors above. The claim goes
    // back on its own field because the caller stamps it on that call only.
    const codexThreadId = (params as { codexThreadId?: unknown }).codexThreadId;
    let threadClaim: ReturnType<typeof resolveCodexThreadClaim> = null;
    if (codexThreadId !== undefined) {
      const sharedServerChild = await isSharedServerChild(normalizeCallerPid((params as { codexCallerPid?: unknown }).codexCallerPid));
      const confirmed = await confirmEntriesConnection();
      if (stillConfirmed(confirmed)) threadClaim = resolveCodexThreadClaim(codexThreadId, entries, sharedServerChild);
    }
    // The walk missed but the caller's env names a pane. Main says whether
    // that pane is live, and attests it only when the daemon follows a live
    // agent inside it from WSL — the one pane kind whose processes main cannot
    // walk. A name that is not a live pane (a scheduled run's `auto-` session,
    // which belongs to no workspace) is reported as such, never as a pane.
    const hintedPane = resolved
      ? null
      : await resolveHintedPane((params as { hintedPtyId?: unknown }).hintedPtyId, entries, confirmEntriesConnection);
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
    const ws = typeof params.workspaceId === 'string' && params.workspaceId ? params.workspaceId : '';
    // Started beside the renderer read and capped: the hints are optional, and
    // on this path they read only this PC's daemon (never the other PC). The
    // local pane counts they may need come from the renderer's answer.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let counted: (count: (workspaceId: string) => number) => void = () => undefined;
    const panesOf = new Promise<(workspaceId: string) => number>((resolve) => { counted = resolve; });
    const peersP: Promise<A2aRemotePeerHint[]> = remote?.listPeers
      ? Promise.race([
        remote.listPeers(ws || undefined, panesOf).catch(() => []),
        new Promise<A2aRemotePeerHint[]>((resolve) => { deadline = setTimeout(() => resolve([]), PEER_HINTS_DEADLINE_MS); }),
      ]).finally(() => clearTimeout(deadline))
      : Promise.resolve([]);
    const res = await sendToRenderer(getWindow, 'a2a.discover', params);
    const agents = isRecord(res) && Array.isArray(res.agents) ? res.agents : null;
    counted(paneCounter(agents ?? []));
    if (!remote || !isRecord(res) || !agents) {
      clearTimeout(deadline);
      return res;
    }
    const [targets, remotePeers] = await Promise.all([remote.listTargets().catch(() => [] as A2aRemoteTarget[]), peersP]);
    // A remote pane is addressable only from its linked local pane: list the
    // links of the caller's workspace (every link when no workspace is named).
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
    const out = entries.length ? { ...res, agents: [...agents, ...entries] } : res;
    return remotePeers.length ? { ...out, remotePeers } : out;
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
    // 내부 operator만 단건 상태 view를 사용한다.
    const stateOnly = params.view === 'state' && ctx?.operator === true;
    if (stateOnly && (typeof params.taskId !== 'string' || !params.taskId.trim())) {
      return { error: 'a2a.task.query: state view requires taskId' };
    }
    if (params.view !== 'page' && !stateOnly) delete params.view;
    // A company task still waiting on a blocker is kept from its receiving
    // side (shared/companyHold.ts): the daemon needs the caller's pane, and the
    // human sees every task. The MCP tool sends no senderPtyId, so the pane
    // comes from the caller's pane claim, else its envelope's pty.
    const queryWs = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    const operatorRead = ctx?.operator === true;
    const claim = ctx?.workspaceClaim;
    const callerPty = operatorRead ? undefined : (claim?.kind === 'bound' ? claim.ptyId : undefined) ?? ctx?.callerPtyId;
    const panes = queryWs && (paged || callerPty) ? await readWorkspacePanes(getWindow, queryWs) : null;
    if (paged && panes) params.livePaneIds = panes.map((pane) => pane.id as string);
    const callerPaneId = callerPty && panes ? paneOfPty(panes, callerPty) : undefined;
    const caller: TaskQueryCaller = { ...(callerPaneId ? { paneId: callerPaneId } : {}), ...(operatorRead ? { trusted: true as const } : {}) };
    // No daemon to say what it keeps from this caller: the renderer's full
    // copies are checked here. A summary row carries no marker (accepted gap).
    const withoutWithheldCopies = (res: unknown): unknown => (isRecord(res) && Array.isArray(res.tasks)
      ? { ...res, tasks: res.tasks.filter((t) => !copyWithheld(t, queryWs, caller)) }
      : res);
    const taskId = pagedTaskId(params);
    const summaries = paged && !taskId;
    const shape = (result: unknown): unknown => stateOnly && isRecord(result) && Array.isArray(result.tasks)
      ? { ...result, tasks: applyTaskQueryView(result.tasks, params) }
      : (paged
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
    // 상태 전용 조회는 독립된 두 저장소를 동시에 읽는다. 오류는 기존 폴백으로 처리한다.
    const stateGate = stateOnly ? daemonTaskRpc(getDaemonClient, 'a2a.task.query', {
      workspaceId: params.workspaceId, view: 'state', taskId: params.taskId,
      ...taskQueryCallerParams(caller),
      ...(typeof params.role === 'string' ? { role: params.role } : {}),
      ...(typeof params.updatedSince === 'string' && Number.isFinite(Date.parse(params.updatedSince))
        ? { updatedSince: new Date(params.updatedSince).toISOString() } : {}),
    }, { timeoutMs: PAGED_TASK_QUERY_DAEMON_TIMEOUT_MS }) : undefined;
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
    const gate = await (stateGate ?? daemonTaskRpc(getDaemonClient, 'a2a.task.query', {
      workspaceId: params.workspaceId,
      ...(typeof params.role === 'string' ? { role: params.role } : {}),
      ...(updatedSince ? { updatedSince } : {}),
      ...(paged ? { view: 'page', ...(taskId ? { taskId } : {}) } : {}),
      ...(params.livePaneIds ? { livePaneIds: params.livePaneIds } : {}),
      ...taskQueryCallerParams(caller),
    }, paged ? { timeoutMs: PAGED_TASK_QUERY_DAEMON_TIMEOUT_MS } : {}));
    if (gate.kind !== 'ok') return shape(withoutWithheldCopies(rendererRes));
    // The tasks the daemon kept from this caller: the renderer's copies go too.
    const withheld = withheldIdsOf(gate.result);
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
    const rendererTasks = (rendererRes as { tasks: Array<Record<string, unknown>> }).tasks
      .filter((t) => !withheld.has(t.id as string));
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
        if (summaries) return withDaemonHold({ ...rt, state: dt.state, updatedAt: dt.updatedAt }, dt, true);
        const rtMeta = isRecord(rt.metadata) ? rt.metadata : {};
        const dtMeta = isRecord(dt.metadata) ? dt.metadata : {};
        return withDaemonHold({ ...rt, status: dt.status, metadata: { ...rtMeta, updatedAt: dtMeta.updatedAt } }, dt, false);
      }
      return withDaemonHold(rt, dt, summaries);
    });
    const seen = new Set(rendererTasks.map((t) => t.id));
    merged.push(...daemonTasks.filter((t) => !seen.has(t.id)));
    // 데몬 무필터 조회분(override·append)에 최종 status 필터를 적용한다 —
    // 렌더러는 이미 status로 걸렀지만, 데몬 override로 상태가 바뀐 태스크(stale
    // working→canonical completed)와 데몬-only 추가분은 여기서 걸러져야 한다.
    const finalTasks = statusFilter ? merged.filter((t) => stateOf(t) === statusFilter) : merged;
    return shape({ ...(rendererRes as Record<string, unknown>), tasks: finalTasks });
  });

  /**
   * One task in full: the daemon's copy, else the renderer's; null when neither
   * has it, or when it is kept from `caller` (a company task still waiting on a
   * blocker, read from its receiving side).
   */
  async function readFullTask(workspaceId: string, taskId: string, caller: TaskQueryCaller = {}): Promise<Record<string, unknown> | null> {
    const query = { workspaceId, view: 'page', taskId };
    const pick = (res: unknown): Record<string, unknown> | null => {
      const tasks: unknown[] = isRecord(res) && Array.isArray(res.tasks) ? res.tasks : [];
      const task = tasks.find((t) => isRecord(t) && t.id === taskId);
      return isRecord(task) ? task : null;
    };
    const [gate, fromRenderer] = await Promise.all([
      daemonTaskRpc(getDaemonClient, 'a2a.task.query', { ...query, ...taskQueryCallerParams(caller) }, { timeoutMs: PAGED_TASK_QUERY_DAEMON_TIMEOUT_MS }),
      sendToRenderer(getWindow, 'a2a.task.query', query).then(pick, () => null),
    ]);
    if (gate.kind === 'ok' ? withheldIdsOf(gate.result).has(taskId) : copyWithheld(fromRenderer, workspaceId, caller)) return null;
    const fromDaemon = gate.kind === 'ok' ? pick(gate.result) : null;
    // As in a2a.task.query: replies live in the renderer's history only, and a
    // remote task's history grows in the daemon.
    if (fromDaemon && fromRenderer && !isRemoteTaskId(taskId) && Array.isArray(fromRenderer.history)) {
      return { ...fromDaemon, history: fromRenderer.history };
    }
    return fromDaemon ?? fromRenderer;
  }

  /**
   * Company mode: the blockers a new task's brief names, judged against the
   * daemon's record only (the renderer's store is empty after a restart, and a
   * task the daemon does not hold would never release the hold). The company
   * is the sender's workspace: a brief to a staff seat is always sent from
   * inside its company. A completed blocker is satisfied already; the open
   * ones are returned, to be waited on. Refused: too many, a task on another
   * PC, one the daemon does not know (or ended over 30 minutes ago), one that
   * is not a company task of this workspace, and one that failed or was
   * canceled.
   */
  async function judgeCompanyBlockers(
    blockedBy: string[],
    workspaceId: string,
    caller: TaskQueryCaller,
  ): Promise<{ open: string[] } | { error: string }> {
    if (blockedBy.length > COMPANY_BLOCKERS_MAX) return { error: COMPANY_BLOCKED_BY_REFUSAL.tooMany(blockedBy.length) };
    const remoteId = blockedBy.find((id) => isRemoteTaskId(id));
    if (remoteId) return { error: COMPANY_BLOCKED_BY_REFUSAL.remoteBlocker(remoteId) };
    const reads = await Promise.all(blockedBy.map((taskId) => daemonTaskRpc(
      getDaemonClient,
      'a2a.task.query',
      { workspaceId, view: 'page', taskId, ...taskQueryCallerParams(caller) },
      { timeoutMs: PAGED_TASK_QUERY_DAEMON_TIMEOUT_MS },
    )));
    const open: string[] = [];
    for (const [i, id] of blockedBy.entries()) {
      const gate = reads[i];
      // Not a refusal: a hold needs the daemon, and it did not answer.
      if (gate.kind !== 'ok') return { error: `wmux could not read task ${id} to check blockedBy; retry` };
      const tasks: unknown[] = Array.isArray(gate.result.tasks) ? gate.result.tasks : [];
      const task = tasks.find((t) => isRecord(t) && t.id === id);
      if (!isRecord(task)) return { error: COMPANY_BLOCKED_BY_REFUSAL.unknown(id) };
      const meta = isRecord(task.metadata) ? task.metadata : {};
      const to = isRecord(meta.to) ? meta.to : {};
      if (isRemoteWorkspaceId(to.workspaceId)) return { error: COMPANY_BLOCKED_BY_REFUSAL.remoteBlocker(id) };
      const history: unknown[] = Array.isArray(task.history) ? task.history : [];
      const first = history[0];
      const companyTask = isRecord(first) && Array.isArray(first.parts) && isCompanyTask(history as Message[]);
      if (!companyTask || to.workspaceId !== workspaceId) return { error: COMPANY_BLOCKED_BY_REFUSAL.otherCompany(id) };
      const state = isRecord(task.status) ? task.status.state : undefined;
      if (state === 'failed' || state === 'canceled') return { error: COMPANY_BLOCKED_BY_REFUSAL.ended(id, state) };
      if (state !== 'completed') open.push(id);
    }
    return { open };
  }

  /**
   * The daemon's hold on a task, null when it has none. Main's own read (it
   * decides only how a message on the task is delivered, nothing is shown to
   * the caller); undefined when the daemon cannot say, and the renderer then
   * checks its own copy's marker.
   */
  async function daemonCompanyHold(taskId: string, workspaceId: string): Promise<CompanyHoldMarker | null | undefined> {
    if (!taskId || !workspaceId || isRemoteTaskId(taskId)) return undefined;
    const gate = await daemonTaskRpc(
      getDaemonClient,
      'a2a.task.query',
      { workspaceId, view: 'page', taskId, trustedLane: true },
      { timeoutMs: PAGED_TASK_QUERY_DAEMON_TIMEOUT_MS },
    );
    if (gate.kind !== 'ok' || !Array.isArray(gate.result.tasks)) return undefined;
    const task: unknown = gate.result.tasks.find((t: unknown) => isRecord(t) && t.id === taskId);
    return (isRecord(task) && isRecord(task.metadata) ? companyHoldOf(task as unknown as Task) : undefined) ?? null;
  }

  /**
   * The end of a send the renderer stored with no delivery because its brief
   * names blockers. The hold must be durable: when the daemon did not create
   * the task with its hold, the renderer's copy is dropped and the send fails
   * (a hold nothing keeps would be stored and never sent). The daemon decides
   * the hold from the blockers' states at create, so the receipt names what
   * it waits on. One whose blockers have all completed is released at create,
   * and main's bridge writes it to its pane: the bridge is the only path a
   * task with blockers is delivered by, so a blocker reopened meanwhile can
   * never get the task told to its seat twice.
   */
  async function finishHeldSend(
    result: Record<string, unknown>,
    mirror: DaemonTaskGate | undefined,
    workLink: ReturnType<typeof workLinkFromSentTask>,
    silentAsked: boolean,
  ): Promise<unknown> {
    const taskId = result.taskId as string;
    const created = mirror?.kind === 'ok' && isRecord(mirror.result.task) && isRecord(mirror.result.task.metadata)
      ? (mirror.result.task as unknown as Task)
      : undefined;
    const hold = companyHoldOf(created);
    if (!hold) {
      await sendToRenderer(getWindow, COMPANY_RENDERER_METHOD.discard, { taskId }).catch(() => undefined);
      const why = mirror?.kind === 'reject'
        ? mirror.error
        : mirror?.kind === 'ok' ? 'the wmux daemon did not record the hold' : 'the wmux daemon did not answer';
      return {
        error: `a2a.task.send: the task waits on blockedBy, and wmux could not keep it on hold (${why}); nothing was stored, send it again`,
      };
    }
    void recordSentTask(workLink);
    if (hold.waitingOn.length === 0) {
      opts.companyRelease?.()?.pullNow();
      return {
        ...result,
        silent: silentAsked,
        delivery: {
          stored: true,
          notified: false,
          reason: 'released',
          hint: 'Its blockers have completed; wmux writes it to its pane next.',
        },
      };
    }
    return {
      ...result,
      silent: silentAsked,
      delivery: {
        stored: true,
        notified: false,
        reason: 'blocked',
        waitingOn: hold.waitingOn,
        hint: `${companyWaitingLine(hold.waitingOn)}. wmux writes it to its pane once they complete. To change what it waits on, cancel it and send it again.`,
      },
    };
  }

  /**
   * A company task's done waits on wmux's own read of every GitHub PR the task
   * names (shared/companyDonePrCheck.ts). Returns the refusal, or null with
   * each passing PR added to `params.evidence` as a verified inspection. A
   * task that is not a company task, or names no PR, is left as it is.
   * Evidence that is missing or not shaped is left to the daemon's evidence
   * gate, which refuses it; nothing is read for it.
   */
  async function companyDonePrRefusal(params: Record<string, unknown>, seat: CompanySeat | undefined, callerPaneId?: string): Promise<string | null> {
    const budgetEnd = Date.now() + DONE_CHECK_BUDGET_MS;
    const evidence = params.evidence;
    const items = isRecord(evidence) ? evidence.items : undefined;
    if (!isRecord(evidence) || typeof evidence.summary !== 'string' || !Array.isArray(items)) return null;
    const { taskId, workspaceId } = params;
    if (typeof taskId !== 'string' || !taskId || typeof workspaceId !== 'string' || !workspaceId) return null;
    const task = await readFullTask(workspaceId, taskId, callerPaneId ? { paneId: callerPaneId } : {});
    // The CEO's done waits on the check, so a task wmux cannot read is not let through.
    if (!task) return seat === 'coordinator' ? `a2a.task.update: wmux could not read task ${taskId} to check the PRs it names; retry` : null;
    const history: unknown[] = Array.isArray(task.history) ? task.history : [];
    const brief = history[0];
    if (!isRecord(brief) || !Array.isArray(brief.parts) || !isCompanyTask(history as Message[])) return null;
    const status = task.status;
    const prs = donePrRefs({
      history,
      statusMessage: isRecord(status) ? status.message : undefined,
      // The report's own evidence: a PR only it names is checked too.
      statusEvidence: isRecord(status) ? status.evidence : undefined,
      message: params.message,
      evidence,
    });
    if (prs.length === 0) return null;
    if (prs.length > DONE_PR_CHECK_MAX) return tooManyDonePrs(prs.length);
    const elsewhere = prs.find((pr) => pr.host.toLowerCase() !== 'github.com' && configuredForge(pr.host, forgeHosts()) !== 'github');
    if (elsewhere) {
      return `a2a.task.update: wmux checks pull requests on github.com and on hosts gh is signed in to, and ${elsewhere.url} is on neither; `
        + 'the owner can mark the task done from their own lane.';
    }
    // The caller's MCP request gives up after 10 s. A read still running near
    // then is refused, so a done never commits after the caller saw it fail.
    const readOne = async (pr: DonePrRef): Promise<DonePrOutcome> => {
      const wait = Math.min(DONE_PR_READ_DEADLINE_MS, budgetEnd - Date.now());
      if (wait <= 0) return { pr, read: 'error', message: 'no time left to read it' };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${Math.ceil(wait / 1000)} s`)), wait);
        });
        const read = await Promise.race([prReview.donePrFacts(os.homedir(), `${pr.host}/${pr.owner}/${pr.repo}`, pr.number), late]);
        return read.ok ? { pr, read: 'ok', facts: read.value } : { pr, read: 'error', message: read.message };
      } catch (err) {
        return { pr, read: 'error', message: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    };
    const outcomes: DonePrOutcome[] = [];
    for (let i = 0; i < prs.length; i += DONE_PR_READS_AT_ONCE) {
      // eslint-disable-next-line no-await-in-loop -- a few PRs, a few at a time
      outcomes.push(...await Promise.all(prs.slice(i, i + DONE_PR_READS_AT_ONCE).map(readOne)));
    }
    const decision = companyDonePrDecision(outcomes);
    if (decision.kind === 'refuse') return decision.error;
    const next = withDonePrEvidence({ ...evidence, items }, decision.items);
    if (!next.ok) return next.error;
    params.evidence = next.evidence;
    return null;
  }

  // task.update — 데몬 정본 게이트 선행(envelope PR4 C12 대칭 경로).
  // 데몬 ok → 렌더러에 daemonCommitted 마커 + committedTask로 verbatim 캐시 적용 +
  // 메시지 배달/이벤트 방출(렌더러 UI 반응성 로직 보존). 데몬 reject → 렌더러
  // 미접촉 반환(재판정 금지). 데몬 unavailable → 현행 렌더러-검증 경로 폴백.
  router.register('a2a.task.update', async (rawParams, ctx) => {
    const marked = refuseHandoffMarker('a2a.task.update', rawParams.message, ctx);
    if (marked) return marked;
    const params = withOperatorOrigin(rawParams, ctx);
    // Only a reply on a remote task (replyRemote below) carries images; every
    // other path here hands the renderer the text only.
    if (params.images !== undefined && params.images !== null
      && !(typeof params.status !== 'string' && typeof params.message === 'string' && remote && isRemoteTaskId(params.taskId))) {
      return { error: 'a2a.task.update: images go only with a message (no status) on a task with another PC; on this PC, reply with a2a.task.send' };
    }
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
    // External callers must prove their pane to move a pane-pinned task; the
    // human operator and in-process first-party lanes are trusted as before.
    const trustedLane = ctx?.operator === true || (ctx?.firstParty === true && !isHostedCaller(ctx));
    params.requirePaneIdentity = !trustedLane;
    if (typeof params.status === 'string') {
      const callerPane = await resolveCallerPane(getWindow, params.workspaceId, params.senderPtyId);
      // A company task is done only once wmux has checked the PRs it names.
      // The human's lane is exempt, and a staff seat's done is refused by the
      // daemon anyway.
      if (params.status === 'completed' && !trustedLane
        && !(callerPane.kind === 'resolved' && callerPane.companySeat === 'staff')) {
        const refused = await companyDonePrRefusal(
          params,
          callerPane.kind === 'resolved' ? callerPane.companySeat : undefined,
          callerPane.kind === 'resolved' ? callerPane.paneId : undefined,
        );
        if (refused) return { error: refused };
      }
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
        // The same read gives the pane's company seat: who marks a company
        // task done.
        ...(callerPane.kind === 'resolved'
          ? {
            senderPtyId: params.senderPtyId,
            callerPaneId: callerPane.paneId,
            livePaneIds: callerPane.livePaneIds,
            ...(callerPane.companySeat ? { callerCompanySeat: callerPane.companySeat } : {}),
          }
          : callerPane.kind === 'unknown' && typeof params.senderPtyId === 'string'
            ? { senderPtyId: params.senderPtyId }
            : {}),
        ...(callerPane.kind === 'absent' && !trustedLane ? { requirePaneIdentity: true } : {}),
        ...(trustedLane ? { trustedLane: true } : {}),
        ...(params.evidence !== undefined ? { evidence: params.evidence } : {}),
        // The status message, checked above, so the daemon's copy keeps it too
        // (and a task with another PC sends it back with the state).
        ...(typeof params.message === 'string' ? { message: params.message } : {}),
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
        // The daemon settled the company tasks waiting on this one before it
        // answered: a released one is delivered, a stranded one told to the CEO.
        if (params.status === 'completed' || params.status === 'failed' || params.status === 'canceled') {
          opts.companyRelease?.()?.pullNow();
        }
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
    // A new task with `execute` runs a background claude outside the worker
    // fence: a fenced worker sends it as a message only.
    if (ctx?.fencedWorker && params.execute === true && !params.taskId) {
      return { error: 'a2a.task.send: execute is not available inside the worker fence; send the task without execute' };
    }
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
    // Company mode: a new task whose brief waits on other tasks. Its blockers
    // are judged before anything is stored. The task is then stored with no
    // delivery and held in the daemon, and main writes it to its pane once
    // the last blocker completes (CompanyReleaseBridge), at once when they all
    // have already.
    const malformed = params.taskId ? null : malformedBlockedBy(params.data);
    if (malformed) return { error: `a2a.task.send: ${malformed}` };
    const blockedBy = params.taskId ? [] : blockedByOf(params.data);
    if (blockedBy.length > 0) {
      const senderWs = ctx?.commanderWorkspace ?? (typeof params.workspaceId === 'string' ? params.workspaceId : '');
      // Read as the sender: a blocker still waiting on its own blockers is
      // kept from everyone but its sender's pane and the human.
      const senderPane = ctx?.operator === true ? null : await resolveCallerPane(getWindow, senderWs, params.senderPtyId);
      const judged = await judgeCompanyBlockers(blockedBy, senderWs, senderPane === null
        ? { trusted: true }
        : senderPane.kind === 'resolved' ? { paneId: senderPane.paneId } : {});
      if ('error' in judged) return { error: `a2a.task.send: ${judged.error}` };
      // A background worker would start the task now.
      if (params.execute === true) {
        return { error: 'a2a.task.send: a task that waits on blockedBy goes to its pane once they complete; send it without execute' };
      }
    }
    const held = blockedBy.length > 0;
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
    // Images reach the renderer only as main's checked copies (`attachments`).
    delete sendParams.images;
    const staged = await stageLocalImages(params, ctx);
    if ('error' in staged) return { error: staged.error };
    if (staged.attachments) sendParams.attachments = staged.attachments;
    // A send the renderer then refuses leaves its copies in the local folder,
    // which makes room from copies nothing open names (the daemon's eviction).
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
    }
    // Stored with no delivery; the addressed pane is pinned on the task as usual.
    // Nothing announces it yet: its seat hears of it when it is written there.
    if (held) {
      sendParams.silent = true;
      sendParams.heldForBlockers = true;
    }
    // A NEW execute send's reply is held until the user answers the approval
    // prompt, which the 5 s bridge default gave up on long before (#1462). The
    // renderer bounds that prompt against this same value, so it always
    // answers first. Plain sends keep the default: nothing in them waits on a
    // person.
    const awaitsApproval = params.execute === true && !params.taskId;
    // Company mode: a message on a task still held for its blockers, or
    // released and not yet written to its seat, is kept on the task with no
    // write and no event; the release delivery brings the seat to the task
    // with its whole history. A task held for a person with nothing written
    // has no delivery coming, so a message on it is refused. One whose write
    // may have landed (`delivery-unconfirmed`) or that was delivered goes as
    // any reply, whatever the renderer's copy says.
    if (params.taskId && params.execute !== true) {
      const hold = await daemonCompanyHold(params.taskId as string, typeof sendParams.workspaceId === 'string' ? sendParams.workspaceId : '');
      const phase = hold ? companyHoldPhase(hold) : undefined;
      if (hold && phase === 'held' && (hold.held === 'no-agent' || hold.held === 'pane-missing')) {
        return { error: `a2a.task.send: ${companyHeldMessageRefusal(params.taskId as string, hold.held)}` };
      }
      if (phase === 'waiting' || phase === 'owed') {
        sendParams.silent = true;
        sendParams.heldForBlockers = true;
      } else if (hold !== undefined) {
        sendParams.heldForBlockers = false;
      }
    }
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
    let mirror: DaemonTaskGate | undefined;
    let workLink: ReturnType<typeof workLinkFromSentTask> = null;
    if (isRecord(result) && result.ok === true && isRecord(result.task) && !params.taskId) {
      // Work link (best-effort, never awaited): read before `task` is stripped.
      // A commander brain's send is a Moa delegation (docs/work-links.md).
      workLink = workLinkFromSentTask(result, { fromCommander: !!ctx?.commanderWorkspace, workLinkId });
      // A held task's link waits until the daemon has kept its hold (below).
      if (!held) void recordSentTask(workLink);
      const t = result.task as { id?: unknown; metadata?: { title?: unknown; from?: unknown; to?: unknown }; history?: unknown };
      if (typeof t.id === 'string' && isRecord(t.metadata)) {
        mirror = await daemonTaskRpc(getDaemonClient, 'a2a.task.create', {
          id: t.id,
          title: t.metadata.title,
          from: t.metadata.from,
          to: t.metadata.to,
          ...(Array.isArray(t.history) ? { history: t.history } : {}),
          // The daemon keeps a marker even when every blocker completes before
          // it creates the task, so the bridge is what delivers it.
          ...(held ? { holdForBlockers: true } : {}),
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
    if (held && isRecord(result) && result.ok === true && typeof result.taskId === 'string') {
      return finishHeldSend(result, mirror, workLink, params.silent === true);
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
  router.register('a2a.task.cancel', async (params, ctx) => {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    // The caller's pane, resolved here as for an update: a company task is
    // canceled only by the pane that created it (shared/company.ts).
    const trustedLane = ctx?.operator === true || (ctx?.firstParty === true && !isHostedCaller(ctx));
    const callerPane = await resolveCallerPane(getWindow, params.workspaceId, params.senderPtyId);
    // Only fields main sets reach the renderer.
    const forward = withOperatorOrigin(params, ctx);
    if (trustedLane) forward.trustedLane = true;
    const gate = await daemonTaskRpc(getDaemonClient, 'a2a.task.cancel', {
      taskId,
      workspaceId: params.workspaceId,
      ...(callerPane.kind === 'resolved' ? { callerPaneId: callerPane.paneId } : {}),
      ...(trustedLane ? { trustedLane: true } : {}),
      // §4 멱등(리뷰 codex): update 경로와 대칭 — 파이프 호출자 키를 데몬까지 전달.
      ...(typeof params.idempotencyKey === 'string' ? { idempotencyKey: params.idempotencyKey } : {}),
    });
    if (gate.kind === 'reject') return { error: gate.error };
    // A background worker stops only once the cancel is allowed.
    if (gate.kind === 'ok') {
      if (taskId) claudeWorker.cancel(taskId);
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
        // A company task waiting on this one stays held; its CEO is told.
        opts.companyRelease?.()?.pullNow();
        const applied = await sendToRenderer(getWindow, 'a2a.task.cancel', {
          ...forward,
          daemonCommitted: true,
          committedTask: gate.result.task,
        });
        await queueRemoteState(taskId, 'canceled', undefined);
        return applied;
      }
      return { ok: true, taskId };
    }
    const res = await sendToRenderer(getWindow, 'a2a.task.cancel', forward);
    if (isRecord(res) && res.ok === true) {
      if (taskId) claudeWorker.cancel(taskId);
      void recordTaskState(taskId, 'canceled');
    }
    return res;
  });
}
