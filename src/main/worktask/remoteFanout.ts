// ─── fanout_start with `pc`: tasks another PC runs ──────────────────────────
//
// Each task is a mission (its channel, its ledger row) plus one start request
// to the other PC (A2A spawn). Nothing runs here: no worktree, no workspace,
// no pane. The ledger row's task workspace is `remote:<spawnId>` and its
// `remote` record holds what this PC knows of the request.
//
// Retries are safe at every step: the mission start and the request both take
// a key derived from the caller's fan-out key, and a task that already has a
// row is answered from it without asking again.
//
// The row follows the request: `reconcileRemoteTasks` reads this PC's sent
// requests and moves each row (refused or expired → failed). A request this PC
// no longer holds, for a row still waiting, ends the row as `expired`; it is
// never asked again. A row that is closed, cancelled or failed is withdrawn:
// its link is revoked now if the agent started, or when its start arrives.

import crypto from 'node:crypto';
import type { A2aSpawnAskError, A2aSpawnAskInput, A2aSpawnAskResult, A2aSpawnOutgoingList, A2aSpawnOutgoingSummary } from '../../shared/a2aSpawn';
import { asSpawnLinkId, spawnFirstMessageId } from '../../shared/a2aSpawn';
import { isHostId, parseA2aRemoteProgress, type A2aRemoteProgressV1 } from '../../shared/a2aRemote';
import type { AgentSlug } from '../../shared/agentIdentity';
import { LEDGER_POOL_REFUSALS_MAX, LEDGER_REMOTE_QUESTIONS, type LedgerEntry, type LedgerRemote, type LedgerRemoteWaiting, type LedgerStatus, remoteTaskWorkspaceId } from '../../shared/ledger';
import { STATE_VIEW_IDS_MAX } from '../../shared/a2aTaskQueryView';
import { FANOUT_MAX_TASKS } from '../../shared/workTask';
import { isOpenLedgerStatus, type LedgerTransition, type TaskLedger } from '../../daemon/ledger/TaskLedger';
import { remoteTaskId } from '../../daemon/a2aRemote/ids';
import type { DaemonClient } from '../DaemonClient';
import { getTaskLedger, rememberMissionChannel } from '../deck/taskLedgerHost';

/** The one agent a fan-out asks another PC for in v1 (the agent a box starts with nobody at the pane). */
export const REMOTE_FANOUT_AGENT: AgentSlug = 'claude';

/** How long a request waits for the other PC (the shortest a request may ask for). */
export const REMOTE_FANOUT_EXPIRES_HOURS = 1;

/**
 * How long a row stays `sent` with no request this PC holds before it ends
 * as expired: its row is written before the request, and the request may
 * still be on its way to the daemon (well past any RPC timeout).
 */
export const REMOTE_ASK_GRACE_MS = 10 * 60 * 1000;

/** `pc` value that lets wmux place each task on a paired PC itself (the pool). */
export const ANY_PC = 'any';

/** How long a PC that answered a pool task "full" is passed over when placing (epoch ms). */
export const POOL_REFUSING_MS = 5 * 60 * 1000;

/** How long a pool task may be held for a PC with room before it fails. */
export const POOL_HOLD_MAX_MS = REMOTE_FANOUT_EXPIRES_HOURS * 60 * 60 * 1000;

/** Appended to every remote task's prompt: v1 brings back only the branch and its head. */
export const REMOTE_TASK_FOOTER =
  'When you are done, commit your work on the current branch, and end your last reply with the branch name and the commit sha.';

export interface RemoteFanoutDaemon {
  ask(input: A2aSpawnAskInput): Promise<A2aSpawnAskResult>;
  outgoing(): Promise<A2aSpawnOutgoingList>;
  revokeLink(linkId: string): Promise<void>;
  missionStart(p: { title: string; verifiedWorkspaceId: string; idempotencyKey: string }): Promise<{ taskId: string; channelId: string } | { error: string }>;
  missionClose(taskId: string, verifiedWorkspaceId: string): Promise<void>;
  /** This PC's host id, as the other PC knows it; null when not known. */
  selfHostId(): Promise<string | null>;
  /** The workspace id at the other end of a link, or null when the link is not known. */
  linkRemoteWorkspace(linkId: string): Promise<string | null>;
  /** The ids of `ownerWorkspaceId`'s closed missions (the WorkTask log). */
  closedMissions(ownerWorkspaceId: string): Promise<ReadonlySet<string>>;
  /** Tasks `ownerWorkspaceId` sent, as the state view shows them: one call for all of them. */
  taskStates(ownerWorkspaceId: string, taskIds: string[]): Promise<RemoteTaskView[]>;
}

/** A sent A2A task as main follows it: its state, whether the other PC reported it, and its worker's status (kinds only). */
export interface RemoteTaskView {
  id: string;
  state: string;
  /** The id of the other PC's message that last reported it; absent before any report. */
  reportId?: string;
  status?: { kind: string; since: string; question?: string; resetsAt?: string; progress?: A2aRemoteProgressV1 };
  /** The other PC's agent replied after the last message this PC sent. */
  answered?: true;
  /** It failed here because its link ended, not by a `failed` the other PC sent. */
  linkEnded?: true;
  /** A reply of that PC's agent is held here: it was not written to the caller's pane. */
  replyHeld?: true;
}

/** One row of the state view, or nothing when it is not one. */
export function remoteTaskViewOf(raw: unknown): RemoteTaskView[] {
  const t = raw && typeof raw === 'object' ? raw as { id?: unknown; status?: { state?: unknown }; metadata?: { remote?: { reported?: unknown; status?: unknown; answered?: unknown; linkEnded?: unknown; replyHeld?: unknown } } } : null;
  if (!t || typeof t.id !== 'string' || typeof t.status?.state !== 'string') return [];
  const remote = t.metadata?.remote;
  const st = remote?.status && typeof remote.status === 'object' ? remote.status as { kind?: unknown; since?: unknown; detail?: { question?: unknown; resetsAt?: unknown; progress?: unknown } } : null;
  const progress = parseA2aRemoteProgress(st?.detail?.progress);
  const status = st && typeof st.kind === 'string' && typeof st.since === 'string'
    ? {
      kind: st.kind, since: st.since,
      ...(typeof st.detail?.question === 'string' ? { question: st.detail.question } : {}),
      ...(typeof st.detail?.resetsAt === 'string' ? { resetsAt: st.detail.resetsAt } : {}),
      ...(progress ? { progress } : {}),
    }
    : undefined;
  return [{
    id: t.id, state: t.status.state, ...(typeof remote?.reported === 'string' ? { reportId: remote.reported } : {}), ...(status ? { status } : {}),
    ...(remote?.answered === true ? { answered: true as const } : {}), ...(remote?.linkEnded === true ? { linkEnded: true as const } : {}),
    ...(remote?.replyHeld === true ? { replyHeld: true as const } : {}),
  }];
}

export type RemoteLedger = Pick<TaskLedger, 'get' | 'list' | 'register' | 'update' | 'updateRemote' | 'placeRemote' | 'closeTask' | 'onTransition'>;

export interface RemoteFanoutDeps {
  daemon: RemoteFanoutDaemon;
  ledger: RemoteLedger;
  rememberChannel(taskId: string, channelId: string): void;
  log?: (line: string) => void;
  /** Injected in tests; default Date.now. */
  now?: () => number;
  /** How long a pool task may be held (default POOL_HOLD_MAX_MS); see WMUX_TEST_POOL_HOLD_MS. */
  poolHoldMs?: number;
}

const holdMsOf = (deps: RemoteFanoutDeps): number => deps.poolHoldMs ?? POOL_HOLD_MAX_MS;

export interface RemoteFanoutRequest {
  /** The caller's own key, and the workspace-scoped key it stands for. */
  idempotencyKey: string;
  scopedKey: string;
  ownerWorkspaceId: string;
  paneId: string;
  /** The caller's own terminal in that pane (its verified senderPtyId): where the replies go. */
  ptyId?: string;
  pc: string;
  root: string;
  sub?: string;
  titles: string[];
  /** The full prompt of each task, index-aligned with `titles`. */
  prompts: string[];
  /** The sha256 of the whole call, kept on each row (see remoteKeyRows). */
  digest: string;
  /** The calling pane's repository as main resolved it (LedgerRemote.homeRepo); absent when it is in none. */
  homeRepo?: string;
}

export interface RemoteTaskResult {
  index: number;
  title: string;
  ok: boolean;
  taskId?: string;
  channelId?: string;
  spawnId?: string;
  state?: LedgerRemote['state'];
  code?: string;
  linkId?: string;
  a2aTaskId?: string;
  /** The branch the agent works on, on that PC (once it started). */
  branchOnPc?: string;
  /** That PC's word on why that branch starts at its HEAD, not its origin's fetched base (once it started). */
  baseNote?: string;
  /** Why it failed or will not run, in words. */
  reason?: string;
  /** What the agent waits on while the task stays open (kinds only); `pc-full`: wmux holds it for a PC with room. */
  pending?: { waitingOn: 'question' | 'usage-limit' | 'pc-full'; question?: string; resetsAt?: string };
  /** With `pc: "any"`: the PC this task is placed on (or was last tried on, while held). */
  pc?: string;
  hostId?: string;
  /** How to reach the agent once it started. */
  followUp?: string;
  /** What the agent's worktree on that PC shows, as of its last turn end (a headless box only). */
  progress?: A2aRemoteProgressV1;
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** The keys of one remote fan-out: one caller key, one request key and one mission key per task. */
export function remoteFanoutKeys(scopedKey: string): {
  callerKey: string;
  requestKey: (k: number) => string;
  missionKey: (k: number) => string;
  spawnId: (k: number) => string;
  /** A pool task's spawn id and request key for one placement: placement 0 keeps the task's own spawn id. */
  poolSpawnId: (k: number, attempt: number) => string;
  poolRequestKey: (k: number, hostId: string, attempt: number) => string;
} {
  const spawnId = (k: number): string => `sp-${uuidOf(sha256(`${scopedKey}\0${k}\0spawn`))}`;
  return {
    callerKey: sha256(scopedKey).slice(0, 32),
    requestKey: (k) => sha256(`${scopedKey}\0${k}`),
    missionKey: (k) => `remote-${sha256(`${scopedKey}\0${k}`).slice(0, 48)}`,
    spawnId,
    poolSpawnId: (k, attempt) => (attempt === 0 ? spawnId(k) : `sp-${uuidOf(sha256(`${scopedKey}\0${k}\0spawn\0${attempt}`))}`),
    poolRequestKey: (k, hostId, attempt) => sha256(`${scopedKey}\0${k}\0${hostId}\0${attempt}`),
  };
}

/** The rows an earlier call with this key wrote: the spawn ids follow from
 *  the key, so this needs no mission or request. */
export function remoteKeyRows(ledger: Pick<RemoteLedger, 'list'>, scopedKey: string): LedgerEntry[] {
  const keys = remoteFanoutKeys(scopedKey);
  const ids = new Set(Array.from({ length: FANOUT_MAX_TASKS }, (_, k) => remoteTaskWorkspaceId(keys.spawnId(k))));
  return ledger.list().filter((e) => ids.has(e.taskWorkspaceId));
}

/** A uuid-shaped id (version 4, variant 8) from hex. */
const uuidOf = (h: string): string => `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;

/**
 * The branch the agent works on, on the other PC. A box that runs headless
 * (its workspace ids start `hl-`) names the worktree for the asking PC's host
 * id and the spawn id (headlessStarter.ts headlessTreeId); a desktop app names
 * it for the spawn id. Either way the branch is `wmux/remote/<that id>`
 * (spawnWorktree.ts branchFor). Tests hold both equal to those functions.
 */
export function branchOnPc(spawnId: string, remoteWorkspaceId: string, askingHostId: string | null): string | null {
  if (!remoteWorkspaceId.startsWith('hl-')) return `wmux/remote/${spawnId}`;
  if (!askingHostId) return null;
  return `wmux/remote/sp-${uuidOf(sha256(`${askingHostId}:${spawnId}`))}`;
}

/** Why a request could not be sent, in words. */
export function askErrorText(error: A2aSpawnAskError, pc: string, message?: string): string {
  switch (error) {
    case 'unknown-pc': return `no paired PC is called ${pc}`;
    case 'ambiguous-pc': return `more than one paired PC is called ${pc}; name it by its host id`;
    case 'not-supported': return `${pc}'s wmux cannot start agents for other PCs (or it has not connected since it was paired)`;
    case 'rate-limited': return `too many requests are waiting for ${pc}`;
    case 'unavailable': return `the request could not be stored or queued${message ? ` (${message})` : ''}`;
    case 'needs-review': return `${pc} needs to be reviewed in Settings › Remote first`;
    case 'bad-request': return `the request is not valid${message ? ` (${message})` : ''}`;
  }
}

/** Why the other PC did not start it, in words (the code is kept beside it). */
export function remoteCodeText(code: string | undefined, pc: string, promptBytes?: number): string {
  switch (code) {
    case 'not-supported': return `${pc} starts only Claude without an app, and not in the permission mode it is set to (not-supported)`;
    case 'not-allowed': {
      // The size the other PC compares: the prompt with wmux's footer.
      const size = promptBytes !== undefined ? ` (${(promptBytes / 1024).toFixed(1)} KiB, wmux's footer included)` : '';
      return `${pc} does not let this PC start this agent in that folder, or the prompt${size} is longer than it accepts (not-allowed)`;
    }
    case 'agent-not-allowed': return `${pc} does not let this PC start Claude (agent-not-allowed)`;
    case 'agent-not-installed': return `Claude is not installed on ${pc} (agent-not-installed)`;
    case 'agent-signed-out': return `Claude on ${pc} is not signed in; sign in there, then send again (agent-signed-out)`;
    case 'folder-not-allowed': return `${pc} does not let this PC use that folder (folder-not-allowed)`;
    case 'expired': return `${pc} did not start it within ${REMOTE_FANOUT_EXPIRES_HOURS} hour (expired)`;
    case 'rate-limited': return `${pc} is at a limit it sets (agents running, or starts per hour or day), holds too many requests from this PC, or its request store is full (rate-limited)`;
    case 'declined': return `${pc}'s owner declined it (declined)`;
    case 'app-not-ready': return `${pc} could not take it: its wmux was not ready (app-not-ready)`;
    case 'pc-full': return `no paired PC had room for it within ${REMOTE_FANOUT_EXPIRES_HOURS} hour (pc-full)`;
    default: return `${pc} could not start the agent (${code ?? 'failed'})`;
  }
}

/** Refusals that need nothing but the parameters (decision H). Null: none. */
export function remoteFanoutRefusal(params: Record<string, unknown>): string | null {
  const present = (k: string): boolean => params[k] !== undefined && params[k] !== null;
  for (const [k, what] of [['preset', 'preset'], ['roles', 'roles']] as const) {
    if (present(k)) return `${what} is not available for tasks on another PC: a paired PC starts Claude only, with its own settings`;
  }
  for (const [k, what] of [
    ['dependsOn', 'depends_on'], ['files', 'files'], ['checkout', 'checkout'], ['secretNames', 'secret_names'],
    ['connectors', 'connectors'], ['threadId', 'thread_id'],
  ] as const) {
    if (present(k)) return `${what} is not available for tasks on another PC`;
  }
  if (params['cancelPending'] === true) return 'cancel_pending is not available for tasks on another PC (they never wait on one another)';
  if (present('agents')) {
    const agents = params['agents'];
    if (!Array.isArray(agents)) return 'agents must be an array';
    for (const a of agents) {
      const o = a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
      if (o['agent'] !== REMOTE_FANOUT_AGENT) return 'another PC starts only Claude for a fan-out';
      if (o['model'] !== undefined || o['effort'] !== undefined) return 'model and effort are set by the other PC, not by the fan-out';
    }
  }
  return null;
}

type Place = A2aSpawnOutgoingList['places'][number];

/** The paired PC `pc` names (its host id, or its name, case-insensitive), as the requester resolves it. */
export function resolvePlace(places: Place[], pc: string): Place | 'unknown-pc' | 'ambiguous-pc' {
  if (isHostId(pc as unknown)) return places.find((p) => p.hostId === pc) ?? 'unknown-pc';
  const want = pc.trim().toLowerCase();
  const named = want ? places.filter((p) => (p.name ?? '').trim().toLowerCase() === want) : [];
  if (named.length > 1) return 'ambiguous-pc';
  return named[0] ?? 'unknown-pc';
}

/** A PC a pool task may go to, with that PC's own root id for the folder (each PC names its folders itself). */
export type PoolPlace = Place & { poolRoot: string };

/**
 * The origin hash of the folder `root` names, as the PCs advertise it on their roots with that id: null when none
 * gives one (the pool then matches the id alone), 'ambiguous' when they give different ones. Pure.
 */
export function poolRootHash(places: Place[], root: string): string | null | 'ambiguous' {
  const seen = new Set<string>();
  for (const p of places) for (const r of p.targets?.roots ?? []) if (r.id === root && r.originKeyHash) seen.add(r.originKeyHash);
  return seen.size > 1 ? 'ambiguous' : ([...seen][0] ?? null);
}

/**
 * The PCs a pool task may go to: online, taking start requests, offering Claude and the folder. The folder is a
 * root with origin hash `hash`, or a root with no hash under the id `root` itself (an older PC sends none, nor does
 * one that cannot read the origin now); with no `hash`, only `root` itself. Labels are never compared. A PC with
 * two such roots is asked for `root` when it is one, else for the lowest id. Pure.
 */
export function poolCandidates(places: Place[], root: string, hash: string | null): PoolPlace[] {
  const out: PoolPlace[] = [];
  for (const p of places) {
    if (!p.online || !p.supported || !p.targets?.agents.includes(REMOTE_FANOUT_AGENT)) continue;
    const ids = p.targets.roots.filter((r) => (hash && r.originKeyHash ? r.originKeyHash === hash : r.id === root)).map((r) => r.id).sort();
    if (ids.length > 0) out.push({ ...p, poolRoot: ids.includes(root) ? root : ids[0] });
  }
  return out;
}

/**
 * The PC a pool task goes to: of `candidates`, the one this PC has the fewest open tasks on (rows with a request out
 * or a started agent; other PCs' tasks on it are not seen), skipping PCs that answered "full" within
 * POOL_REFUSING_MS; ties go to the lowest host id. Null when every candidate is passed over. Pure.
 */
export function pickPoolHost<P extends Place>(candidates: P[], rows: readonly LedgerEntry[], now: number): P | null {
  const load = new Map<string, number>();
  const refusing = new Set<string>();
  for (const e of rows) {
    const r = e.remote;
    if (!r || !isOpenLedgerStatus(e.status)) continue;
    if (r.state === 'sent' || r.state === 'waiting' || r.state === 'started') load.set(r.hostId, (load.get(r.hostId) ?? 0) + 1);
    for (const f of r.pool?.refusals ?? []) if (now - f.at < POOL_REFUSING_MS) refusing.add(f.hostId);
  }
  const open = candidates.filter((p) => !refusing.has(p.hostId));
  open.sort((a, b) => (load.get(a.hostId) ?? 0) - (load.get(b.hostId) ?? 0) || (a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : 0));
  return open[0] ?? null;
}

const placeName = (p: Place): string => {
  const named = p.name?.trim() ?? '';
  return storableName(named) ? named : p.hostId;
};

function resultOf(index: number, title: string, entry: LedgerEntry, channelId: string | undefined, promptBytes: number): RemoteTaskResult {
  const r = entry.remote;
  const failed = entry.status === 'failed' || entry.status === 'cancelled';
  return {
    index, title, ok: !failed, taskId: entry.id,
    ...(channelId ? { channelId } : {}),
    ...(r ? {
      // A closed row that was held has no request anywhere: it answers closed (its reason), not held.
      spawnId: r.spawnId, ...(failed && r.state === 'held' ? {} : { state: r.state }),
      ...(r.code ? { code: r.code } : {}),
      ...(r.linkId ? { linkId: r.linkId } : {}),
      ...(r.a2aTaskId ? { a2aTaskId: r.a2aTaskId } : {}),
      ...(r.branchOnPc ? { branchOnPc: r.branchOnPc } : {}),
      ...(r.baseNote ? { baseNote: r.baseNote } : {}),
      ...(r.state === 'refused' || r.state === 'expired' ? { reason: remoteCodeText(r.code, r.pc, promptBytes) } : {}),
      ...(r.waiting && !failed ? { pending: { waitingOn: r.waiting.on, ...(r.waiting.question ? { question: r.waiting.question } : {}), ...(r.waiting.resetsAt ? { resetsAt: r.waiting.resetsAt } : {}) } } : {}),
      ...(r.state === 'held' && !failed ? { pending: { waitingOn: 'pc-full' as const } } : {}),
      ...(r.pool ? { pc: r.pc, hostId: r.hostId } : {}),
      ...(r.a2aTaskId && !failed ? { followUp: followUpText(r) } : {}),
      ...(r.progress ? { progress: r.progress } : {}),
    } : {}),
    ...(failed && !r?.code ? { reason: entry.summary ?? entry.status } : {}),
  };
}

/**
 * How the caller reaches a started agent: its A2A task. Not for a question on
 * its screen: a reply on the task is never typed into it (a headless box types
 * only into a task waiting for a reply; an app-attached PC gives a live agent
 * a one-line pointer, never the text), so only that PC's pane answers it.
 */
function followUpText(r: LedgerRemote): string {
  const reply = `send_message task_id=${r.a2aTaskId}`;
  return r.waiting?.on === 'question'
    ? `it waits on a ${r.waiting.question ?? 'screen'} question: answer it in that PC's pane; it cannot be answered from here yet, and a headless box ends the task after 10 minutes`
    : `${reply} reaches the agent; its replies come back to your pane`;
}

/** A folder id as the other PC offers it (a2aSpawn.ts ROOT_ID_RE). */
const ROOT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** What a ledger row keeps as the PC's name (TaskLedger copyRemote). */
const storableName = (name: string): boolean => name.length > 0 && name.length <= 256 && !/\p{Cc}/u.test(name);

/**
 * Start (or, for a key already used, answer) a remote fan-out. Refusals of the
 * whole call come back as `{ error }`; a task that fails alone is a result
 * with `ok: false`.
 *
 * With `pc: "any"` (the pool) each task is placed by wmux: on the online PC
 * that offers the folder and has the fewest of this PC's open tasks. A task
 * that PC answers "full" (rate-limited) is held, with no request out, and the
 * same call again places it anew. A task is asked of one PC at a time: it is
 * moved only while held (TaskLedger.placeRemote), that is after its request
 * ended refused.
 */
export async function startRemoteFanout(req: RemoteFanoutRequest, deps: RemoteFanoutDeps): Promise<{ hostId?: string; pc: string; tasks: RemoteTaskResult[] } | { error: string; retry?: true }> {
  // Everything the row will hold is checked before anything is sent.
  if (!ROOT_ID_RE.test(req.root)) return { error: 'root is a folder id the other PC offers (lowercase letters, digits and dashes, at most 32)' };
  let list: A2aSpawnOutgoingList;
  try {
    list = await deps.daemon.outgoing();
  } catch (err) {
    return { error: `the background service could not list the paired PCs (${(err as Error).message}); nothing was sent, so send the same idempotency_key again`, retry: true };
  }
  const pool = req.pc.trim().toLowerCase() === ANY_PC;
  let place: Place | null = null;
  let candidates: PoolPlace[] = [];
  let rootHash: string | null = null;
  const noPcText = `no paired PC that is online offers the folder ${req.root} for Claude, so no task could be placed (pc "${ANY_PC}"); `
    + 'a pool finds the folder on other PCs by its git origin, so a folder without one is found only under that same id';
  if (pool) {
    const keyRows = remoteKeyRows(deps.ledger, req.scopedKey);
    // The folder this key's tasks went to at their first placement; a new key reads it from the PCs.
    const prior = keyRows.find((e) => e.remote?.pool);
    const hash = prior ? (prior.remote!.pool!.rootHash ?? null) : poolRootHash(list.places, req.root);
    if (hash === 'ambiguous') {
      return { error: `paired PCs offer the folder id ${req.root} for different repositories, so wmux cannot tell which folder it is (pc "${ANY_PC}"); name the PC with pc instead` };
    }
    rootHash = hash;
    candidates = poolCandidates(list.places, req.root, hash);
    // Tasks this key placed already are still answered (a poll): the call is refused only when it has none.
    if (candidates.length === 0 && keyRows.length === 0) return { error: noPcText };
  } else {
    const found = resolvePlace(list.places, req.pc);
    if (found === 'unknown-pc' || found === 'ambiguous-pc') return { error: askErrorText(found, req.pc) };
    if (!found.supported) return { error: askErrorText('not-supported', placeName(found)) };
    place = found;
  }
  // A task whose mission was closed is over: the same key never asks for it
  // again, whatever its row says (the WorkTask log is the durable fact).
  let closed: ReadonlySet<string>;
  try {
    closed = await deps.daemon.closedMissions(req.ownerWorkspaceId);
  } catch (err) {
    return { error: `the background service could not list your missions (${(err as Error).message}); nothing was sent, so send the same idempotency_key again`, retry: true };
  }

  const now = deps.now ?? Date.now;
  const keys = remoteFanoutKeys(req.scopedKey);
  const held = new Set(list.requests.map((r) => r.spawnId));
  const tasks: RemoteTaskResult[] = [];
  for (const [k, title] of req.titles.entries()) {
    const text = req.prompts[k];
    const promptBytes = Buffer.byteLength(text, 'utf8');
    let mission: { taskId: string; channelId: string } | { error: string };
    try {
      mission = await deps.daemon.missionStart({ title, verifiedWorkspaceId: req.ownerWorkspaceId, idempotencyKey: keys.missionKey(k) });
    } catch (err) {
      mission = { error: (err as Error).message };
    }
    if ('error' in mission) {
      tasks.push({ index: k, title, ok: false, reason: `the mission could not be started (${mission.error}); send the same idempotency_key again` });
      continue;
    }
    const { taskId, channelId } = mission;
    deps.rememberChannel(taskId, channelId);
    let existing = deps.ledger.get(taskId);
    if (closed.has(taskId)) {
      // Its mission was closed: never asked for again.
      tasks.push(existing ? resultOf(k, title, existing, channelId, promptBytes) : { index: k, title, ok: false, taskId, channelId, reason: 'this task\'s mission was closed, so it is not asked for again; send a new key' });
      continue;
    }
    // A held pool task (no request out) is placed anew: on a PC with room, or it stays held.
    if (existing?.remote?.pool && existing.remote.state === 'held' && isOpenLedgerStatus(existing.status)) {
      const to = pickPoolHost(candidates, deps.ledger.list(), now());
      const attempt = existing.remote.pool.attempt + 1;
      // Held past its time: not placed (the pass below fails it).
      const moved = to
        ? await deps.ledger.placeRemote(taskId, { hostId: to.hostId, pc: placeName(to), spawnId: keys.poolSpawnId(k, attempt), root: to.poolRoot, attempt }, now() - holdMsOf(deps)).catch(() => null)
        : null;
      if (!moved) {
        tasks.push(resultOf(k, title, deps.ledger.get(taskId) ?? existing, channelId, promptBytes));
        continue;
      }
      existing = moved;
    }
    // A retry of a task whose request never reached the daemon (its row is
    // still `sent` and open, and this PC holds no such request) asks again:
    // the request key and spawn id make that the same request. Any other row
    // answers as it is.
    const resend = existing?.remote?.state === 'sent' && isOpenLedgerStatus(existing.status) && !held.has(existing.remote.spawnId);
    if (existing && !resend) {
      tasks.push(resultOf(k, title, existing, channelId, promptBytes));
      continue;
    }
    // The row comes first, under the spawn id the request will carry: a close
    // always has a row to withdraw, even when the request's answer is lost.
    let row: LedgerEntry;
    try {
      if (existing) {
        row = existing;
      } else {
        if (pool && candidates.length === 0) {
          tasks.push({ index: k, title, ok: false, taskId, channelId, reason: `${noPcText}; send the same idempotency_key again` });
          continue;
        }
        // A pool task with every candidate passed over is written held, on the least loaded of them, with no request.
        const to = pool ? pickPoolHost(candidates, deps.ledger.list(), now()) : place;
        const on = to ?? pickPoolHost(candidates, [], now())!;
        row = await deps.ledger.register({
          id: taskId,
          taskWorkspaceId: remoteTaskWorkspaceId(keys.spawnId(k)),
          ownerWorkspaceId: req.ownerWorkspaceId,
          title,
          remote: {
            hostId: on.hostId, pc: placeName(on), spawnId: keys.spawnId(k), root: pool ? (on as PoolPlace).poolRoot : req.root, state: to ? 'sent' : 'held',
            requestDigest: req.digest, from: { paneId: req.paneId }, ...(req.homeRepo ? { homeRepo: req.homeRepo } : {}),
            ...(pool ? { pool: { attempt: 0, ...(to ? {} : { heldSince: now() }), ...(rootHash ? { rootHash } : {}) } } : {}),
          },
        });
      }
    } catch (err) {
      tasks.push({ index: k, title, ok: false, taskId, channelId, reason: `the task row could not be written (${(err as Error).message}); nothing was sent, so send the same idempotency_key again` });
      continue;
    }
    const r = row.remote!;
    if (r.state === 'held') {
      tasks.push(resultOf(k, title, row, channelId, promptBytes));
      continue;
    }
    let asked: A2aSpawnAskResult;
    try {
      asked = await deps.daemon.ask({
        pc: r.hostId,
        agent: REMOTE_FANOUT_AGENT,
        // The row's root: the placed PC's own id for the folder (a pool task's may differ from the caller's).
        folder: { root: r.root, ...(req.sub ? { sub: req.sub } : {}) },
        text,
        expiresInHours: REMOTE_FANOUT_EXPIRES_HOURS,
        from: { kind: 'pane', workspaceId: req.ownerWorkspaceId, paneId: req.paneId },
        ...(req.ptyId ? { fromPtyId: req.ptyId } : {}),
        callerKey: keys.callerKey,
        requestKey: r.pool ? keys.poolRequestKey(k, r.hostId, r.pool.attempt) : keys.requestKey(k),
        budget: 'fanout',
        spawnId: r.spawnId,
      });
    } catch (err) {
      // No answer: the request may be stored and on its way. The row stays
      // `sent` (a close withdraws it); the same key again asks again.
      tasks.push({ index: k, title, ok: false, taskId, channelId, spawnId: r.spawnId, state: 'sent', reason: `the request got no answer (${(err as Error).message}); send the same idempotency_key again` });
      continue;
    }
    if (!asked.ok && r.pool && asked.error === 'unavailable') {
      // This PC could not store or queue it (its request store full, say): a pool task waits held, as for a full PC.
      const at = now();
      const back = await deps.ledger.updateRemote(taskId, { state: 'held', pool: { ...r.pool, heldSince: r.pool.heldSince ?? at } }, undefined, { state: 'sent', spawnId: r.spawnId }).catch(() => null);
      tasks.push(resultOf(k, title, back ?? row, channelId, promptBytes));
      continue;
    }
    if (!asked.ok) {
      // Refused here, so nothing was sent: the row fails with the reason,
      // which answers the same key from now on, and the mission is closed.
      const reason = askErrorText(asked.error, r.pc, asked.message);
      const failed = await deps.ledger.update({ id: taskId, status: 'failed', actor: { kind: 'system', workspaceId: 'main' }, expectedRev: row.rev, summary: reason }).catch(() => null);
      if (!failed?.ok) deps.log?.(`[remote-fanout] ${taskId}: the refused task's row could not be failed`);
      await deps.daemon.missionClose(taskId, req.ownerWorkspaceId).catch(() => undefined);
      tasks.push({ index: k, title, ok: false, taskId, channelId, reason });
      continue;
    }
    const spawn = asked.spawn;
    const entry = await deps.ledger.updateRemote(taskId, { state: spawn.state, ...(spawn.code ? { code: spawn.code } : {}) }).catch(() => null);
    tasks.push(resultOf(k, title, entry ?? row, channelId, promptBytes));
  }
  // States that arrived meanwhile (a refusal, a start) are on the rows before the answer.
  await reconcileRemoteTasks(deps).catch((err: unknown) => deps.log?.(`[remote-fanout] reconcile failed: ${String(err)}`));
  for (const t of tasks) {
    // A task that failed here keeps its reason; one that was asked (or held) shows its row now.
    if (!t.ok || !t.taskId) continue;
    const entry = deps.ledger.get(t.taskId);
    if (entry && (t.spawnId || entry.remote?.pool)) Object.assign(t, resultOf(t.index, t.title, entry, t.channelId, Buffer.byteLength(req.prompts[t.index], 'utf8')));
  }
  return place ? { hostId: place.hostId, pc: placeName(place), tasks } : { pc: ANY_PC, tasks };
}

/** Revoke a withdrawn task's link once; a failure is retried on the next pass. */
async function revokeOnce(entry: LedgerEntry, linkId: string, deps: RemoteFanoutDeps): Promise<void> {
  try {
    await deps.daemon.revokeLink(linkId);
    await deps.ledger.updateRemote(entry.id, { linkId, revoked: true });
  } catch (err) {
    deps.log?.(`[remote-fanout] ${entry.id}: the link ${linkId} could not be revoked yet: ${String(err)}`);
  }
}

/** The task ended here (closed, cancelled, failed or completed): its link is
 *  revoked now if it started, or when its start arrives. */
export async function withdrawRemote(entry: LedgerEntry, deps: RemoteFanoutDeps): Promise<void> {
  const r = entry.remote;
  if (!r) return;
  const marked = r.withdrawn ? entry : await deps.ledger.updateRemote(entry.id, { withdrawn: true });
  if (!marked?.remote) return;
  if (marked.remote.linkId && !marked.remote.revoked) await revokeOnce(marked, marked.remote.linkId, deps);
}

/** Passes in flight, one per ledger: a call while one runs runs once more after it. */
const passes = new WeakMap<object, { running: Promise<void>; again: boolean }>();

/** Move every remote row to what this PC's sent requests say now. One pass at a time per ledger. */
export function reconcileRemoteTasks(deps: RemoteFanoutDeps): Promise<void> {
  const cur = passes.get(deps.ledger);
  if (cur) {
    cur.again = true;
    return cur.running;
  }
  const state = { running: Promise.resolve(), again: false };
  state.running = (async () => {
    do {
      state.again = false;
      await reconcileOnce(deps);
    } while (state.again);
  })().finally(() => passes.delete(deps.ledger));
  passes.set(deps.ledger, state);
  return state.running;
}

async function reconcileOnce(deps: RemoteFanoutDeps): Promise<void> {
  // A revoked row is done. A refused one never starts, once its status has
  // moved (a failed status write is retried here). Every other row is read:
  // an expired request still takes a late start.
  const rows = deps.ledger.list().filter((e) => e.remote && !e.remote.revoked && (e.remote.state !== 'refused' || isOpenLedgerStatus(e.status)));
  if (rows.length === 0) return;
  const list = await deps.daemon.outgoing();
  const bySpawn = new Map<string, A2aSpawnOutgoingSummary>(list.requests.map((r) => [r.spawnId, r]));
  // Read once per pass, and only when a started row still lacks its branch.
  let self: Promise<string | null> | undefined;
  const branchOf = async (linkId: string, spawnId: string): Promise<string | null> => {
    const ws = await deps.daemon.linkRemoteWorkspace(linkId).catch(() => null);
    if (!ws) return null; // Not listed yet: the next pass fills it.
    self ??= deps.daemon.selfHostId().catch(() => null);
    return branchOnPc(spawnId, ws, await self);
  };
  for (const row of rows) {
    const r = row.remote!;
    const rec = bySpawn.get(r.spawnId);
    let next: LedgerEntry | null = row;
    if (r.state === 'held') {
      // No request is out for a held row: only its time runs (placing it again is the caller's next poll).
      const since = r.pool?.heldSince ?? row.updatedAt;
      // Only the placement read here: one a poll made meanwhile is left alone.
      if (isOpenLedgerStatus(row.status) && (deps.now ?? Date.now)() - since >= holdMsOf(deps)) {
        next = await deps.ledger.updateRemote(row.id, { state: 'expired', code: 'pc-full' }, undefined, { state: 'held', spawnId: r.spawnId });
      }
    } else if (r.pool && r.state !== 'expired' && rec?.state === 'refused' && rec.code === 'rate-limited' && isOpenLedgerStatus(row.status)) {
      // That PC is full: the pool task is held, with its request ended, until a later call places it on one with room.
      const at = (deps.now ?? Date.now)();
      const refusals = [...(r.pool.refusals ?? []).filter((f) => f.hostId !== r.hostId), { hostId: r.hostId, at }].slice(-LEDGER_POOL_REFUSALS_MAX);
      next = await deps.ledger.updateRemote(row.id, { state: 'held', code: undefined, pool: { ...r.pool, refusals, heldSince: r.pool.heldSince ?? at } }, undefined, { state: r.state, spawnId: r.spawnId });
    } else if (!rec) {
      // Not held any more: a waiting row ends here and is never asked again.
      // A row written just before its request is given time for it to land.
      const young = r.state === 'sent' && (deps.now ?? Date.now)() - row.updatedAt < REMOTE_ASK_GRACE_MS;
      if ((r.state === 'sent' && !young) || r.state === 'waiting') next = await deps.ledger.updateRemote(row.id, { state: 'expired', code: 'expired' });
    } else if (rec.state === 'started' && asSpawnLinkId(rec.linkId)) {
      const linkId = asSpawnLinkId(rec.linkId)!;
      const branch = r.branchOnPc ?? await branchOf(linkId, r.spawnId);
      next = await deps.ledger.updateRemote(row.id, {
        state: 'started', linkId, a2aTaskId: remoteTaskId(linkId, spawnFirstMessageId(linkId)), ...(branch ? { branchOnPc: branch } : {}),
        ...(rec.baseNote ? { baseNote: rec.baseNote } : {}),
      });
    } else if ((rec.state !== r.state || rec.code !== r.code) && !(r.state === 'expired' && r.code === 'pc-full')) {
      // A pool task that ran out of time keeps its own reason: the request of its last placement says nothing of it.
      next = await deps.ledger.updateRemote(row.id, { state: rec.state, ...(rec.code ? { code: rec.code } : {}) });
    }
    if (!next?.remote) continue;
    const nr = next.remote;
    if ((nr.state === 'refused' || nr.state === 'expired') && isOpenLedgerStatus(next.status)) {
      const failed = await deps.ledger.update({ id: next.id, status: 'failed', actor: { kind: 'system', workspaceId: 'main' }, expectedRev: next.rev, summary: remoteCodeText(nr.code, nr.pc) });
      if (failed.ok) next = failed.entry;
    }
    // An ended row is withdrawn here too: its transition may have come while
    // the daemon was away, or it ended before this PC learned of the start.
    if (!isOpenLedgerStatus(next.status)) await withdrawRemote(next, deps);
  }
  await followTasks(deps);
}

const SYSTEM_ACTOR = { kind: 'system', workspaceId: 'main' } as const;

/** How long a gone agent, or a task the daemon no longer lists, waits before its row fails: the end normally follows within seconds. */
export const REMOTE_GONE_GRACE_MS = 60_000;

/** The row's text while its agent waits for a reply its turn already sent (the caller's pane has that reply). */
export function remoteReplyWaitText(r: Pick<LedgerRemote, 'pc' | 'a2aTaskId'>): string {
  return `the agent on ${r.pc} waits for your reply on A2A task ${r.a2aTaskId}`;
}

/** Listeners for a row of another PC's task that, already waiting, now waits on something someone must act on (onRemoteWaitInPlace). */
const waitInPlace = new Set<(entry: LedgerEntry) => void>();

/**
 * A row already input_required that now waits on something someone must act
 * on (a question on that PC's screen, its agent stopped with no reply, or its
 * reply held here) moves no status, so no ledger transition tells it: this
 * does, once per new reason, with the row as it is now. Returns the
 * unsubscribe.
 */
export function onRemoteWaitInPlace(listener: (entry: LedgerEntry) => void): () => void {
  waitInPlace.add(listener);
  return () => waitInPlace.delete(listener);
}

/**
 * Started rows follow their A2A task: one state-view call per owner workspace
 * and pass (STATE_VIEW_IDS_MAX ids at most each), whatever the number of rows.
 */
async function followTasks(deps: RemoteFanoutDeps): Promise<void> {
  const rows = deps.ledger.list().filter((e) => e.remote?.state === 'started' && e.remote.a2aTaskId && isOpenLedgerStatus(e.status));
  const byOwner = new Map<string, LedgerEntry[]>();
  for (const row of rows) {
    const owned = byOwner.get(row.ownerWorkspaceId);
    if (owned) owned.push(row);
    else byOwner.set(row.ownerWorkspaceId, [row]);
  }
  for (const [owner, owned] of byOwner) {
    for (let i = 0; i < owned.length; i += STATE_VIEW_IDS_MAX) {
      const chunk = owned.slice(i, i + STATE_VIEW_IDS_MAX);
      let views: RemoteTaskView[];
      try {
        views = await deps.daemon.taskStates(owner, chunk.map((e) => e.remote!.a2aTaskId!));
      } catch (err) {
        deps.log?.(`[remote-fanout] the tasks sent from ${owner} could not be read: ${String(err)}`);
        continue;
      }
      const byId = new Map(views.map((v) => [v.id, v]));
      for (const row of chunk) {
        await followTask(row.id, byId.get(row.remote!.a2aTaskId!) ?? null, deps).catch((err: unknown) => deps.log?.(`[remote-fanout] ${row.id}: ${String(err)}`));
        // Ended here: withdrawn now (as the transition listener does), not a pass later.
        const after = deps.ledger.get(row.id);
        if (after && !isOpenLedgerStatus(after.status)) await withdrawRemote(after, deps);
      }
    }
  }
}

/**
 * One row from its A2A task (null: the daemon no longer lists it). The row is
 * read again here, after the daemon call: one closed meanwhile is left alone.
 *
 * Precedence: a new report (another report message id) moves the row to
 * review_requested, and a report stands there until a follow-up sets the
 * agent working again (then the statuses below apply as before), also once
 * the daemon no longer lists the task (a cancel then leaves it as it is). An
 * ended task beats the worker's status. A task whose agent answered the last
 * message and that then failed only because its link ended (a headless box
 * ends the link when it ends the agent) is cancelled, not failed.
 * A gone agent, or a task the daemon dropped, fails the row only after
 * REMOTE_GONE_GRACE_MS, so the end that normally follows is taken instead.
 * Text from the other PC never goes into the row: kinds, the PC's name and
 * the task id only. A stale rev is left for the next pass.
 */
async function followTask(id: string, view: RemoteTaskView | null, deps: RemoteFanoutDeps): Promise<void> {
  let entry = deps.ledger.get(id);
  if (!entry?.remote || !isOpenLedgerStatus(entry.status)) return;
  const r = entry.remote;
  const on = `A2A task ${r.a2aTaskId}`;
  const now = (deps.now ?? Date.now)();
  const patch = async (p: Partial<LedgerRemote>): Promise<void> => {
    entry = (await deps.ledger.updateRemote(entry!.id, p)) ?? entry;
  };
  const move = async (status: LedgerStatus, summary: string): Promise<void> => {
    if (entry!.status === status) return;
    const res = await deps.ledger.update({ id: entry!.id, status, actor: SYSTEM_ACTOR, expectedRev: entry!.rev, summary });
    if (res.ok) entry = res.entry;
  };
  const replyText = remoteReplyWaitText(r);
  const replyHeldText = `the agent on ${r.pc} replied, but its reply is held here (not written to your pane); read it on ${on}, or retry it from the Remote page`;
  const stoppedText = `the agent on ${r.pc} stopped without a reply; send it a follow-up on ${on}`;
  const questionText = (question?: string): string => `the agent on ${r.pc} waits on a ${question ?? 'screen'} question: answer it in that PC's pane; it cannot be answered from here yet, and a headless box ends the task after 10 minutes`;
  const reportedText = `reported on ${r.pc}; the report is on ${on}`;
  const workingText = `working on ${r.pc}`;
  const endedAfterReplyText = `the agent on ${r.pc} ended after it replied; its reply is on ${on}`;
  /** Every text this pass writes on an open row; a brain's move keeps the one it found when it gives none. */
  const ownTexts = new Set([replyText, replyHeldText, stoppedText, reportedText, workingText, questionText(), ...LEDGER_REMOTE_QUESTIONS.map(questionText)]);
  /**
   * The row waits, as `summary` says, after `p` on its remote record. Into input_required: the record, then the move.
   * Already there: a text this pass wrote (a question answered, then a reply asked for; or one left by a brain that
   * sent the row back with no text) is replaced, with the record in one write. A text a brain wrote is kept.
   */
  /** Why the row waits, as far as telling the caller goes: only `reply` (its reply reached the pane) is not told. */
  const waitKind = (e: LedgerEntry, summary: string | undefined): string =>
    e.remote?.waiting?.on === 'question' ? 'question' : summary === replyText ? 'reply' : summary === stoppedText ? 'stopped' : summary === replyHeldText ? 'held' : 'other';
  const waitFor = async (summary: string, p: Partial<LedgerRemote>): Promise<void> => {
    // Already waiting: a new reason moves no status, so a new one that needs someone is told below.
    const before = entry!.status === 'input_required' ? waitKind(entry!, entry!.summary) : null;
    const ownText = entry!.status === 'input_required' && entry!.summary !== summary && ownTexts.has(entry!.summary ?? '');
    if (!ownText) {
      await patch(p);
      await move('input_required', summary);
    } else {
      const written = await deps.ledger.updateRemote(entry!.id, p, { summary, expectedRev: entry!.rev });
      // Not written (the row went, or moved meanwhile): the next pass reads it again; nothing is told for it.
      if (!written || written.summary !== summary) return;
      entry = written;
    }
    // The reason this pass found (a brain's own text on the row is kept, but the reason is still new).
    const now = waitKind(entry!, ownTexts.has(entry!.summary ?? '') ? entry!.summary : summary);
    if (before === null || entry!.status !== 'input_required' || now === 'reply' || now === before) return;
    // Under a brain's own text only a question is remembered on the row (`waiting`): any other reason would read as new every pass.
    if (before === 'other' && now !== 'question') return;
    for (const listener of waitInPlace) {
      try {
        listener(entry!);
      } catch {
        // best effort
      }
    }
  };
  /** Fails the row once the grace from the first sighting is over. */
  const failAfterGrace = async (summary: string): Promise<void> => {
    if (r.goneSeenAt === undefined) return patch({ goneSeenAt: now });
    if (now - r.goneSeenAt >= REMOTE_GONE_GRACE_MS) await move('failed', summary);
  };
  // A report stands: a reported task the daemon dropped later (its log keeps
  // ended tasks only a while) keeps its row as it is.
  if (!view) return entry.status === 'review_requested' ? undefined : failAfterGrace(`the task on ${r.pc} is no longer known here`);
  // The worktree's facts, as that PC last said: kept on the row whatever else this pass does (no status moves for
  // it). A status without them (that PC could not read them) clears them; no status at all, or `gone` (which
  // never carries any), leaves the last ones on the row.
  const progress = view.status?.progress;
  if (view.status && view.status.kind !== 'gone' && JSON.stringify(progress) !== JSON.stringify(r.progress)) await patch({ progress });
  const settled = r.waiting || r.goneSeenAt !== undefined ? { waiting: undefined, goneSeenAt: undefined } : null;
  const newReport = view.reportId !== undefined && view.reportId !== r.reportId;
  if (newReport || (view.state === 'completed' && entry.status !== 'review_requested')) {
    await patch({ ...(settled ?? {}), ...(view.reportId ? { reportId: view.reportId } : {}) });
    return move('review_requested', reportedText);
  }
  // A report stands until a follow-up sets the agent working again.
  if (entry.status === 'review_requested' && view.state !== 'working' && view.state !== 'submitted') return;
  if (view.state === 'canceled') return move('cancelled', `cancelled on ${r.pc}`);
  // The agent answered the last message, then its link ended (it was ended on that PC): its reply stands on the task.
  if (view.state === 'failed' && view.linkEnded && view.answered) return move('cancelled', endedAfterReplyText);
  if (view.state === 'failed') return move('failed', `failed on ${r.pc}; why is on ${on}`);
  if (view.state === 'input-required') return waitFor(view.replyHeld ? replyHeldText : replyText, settled ?? {});
  const st = view.status;
  if (st?.kind === 'question') {
    const question = (LEDGER_REMOTE_QUESTIONS as readonly string[]).includes(st.question ?? '') ? st.question as LedgerRemoteWaiting['question'] : undefined;
    return waitFor(questionText(question), { waiting: { on: 'question', since: st.since, ...(question ? { question } : {}) }, goneSeenAt: undefined });
  }
  if (st?.kind === 'gone') return failAfterGrace(`the agent on ${r.pc} is gone`);
  if (st?.kind === 'waiting-input') {
    // Its turn ended with no reply and no report: nothing moves until someone writes to it.
    return waitFor(stoppedText, settled ?? {});
  }
  if (st?.kind === 'usage-limit') {
    // That PC resumes it by itself: nothing is asked of the caller.
    await patch({ waiting: { on: 'usage-limit', since: st.since, ...(st.resetsAt ? { resetsAt: st.resetsAt } : {}) }, goneSeenAt: undefined });
  } else if (settled) {
    await patch(settled);
  }
  await move('working', workingText);
}

/** Withdraw every remote row that ends here. Returns the unsubscribe. */
export function installRemoteTaskWithdraw(ledger: Pick<RemoteLedger, 'onTransition'>, getDeps: () => RemoteFanoutDeps | null): () => void {
  return ledger.onTransition((t: LedgerTransition) => {
    if (!t.entry.remote || isOpenLedgerStatus(t.to)) return;
    const deps = getDeps();
    if (!deps) return; // The next reconcile pass withdraws it.
    void withdrawRemote(t.entry, deps).catch((err: unknown) => deps.log?.(`[remote-fanout] ${t.entry.id}: withdraw failed: ${String(err)}`));
  });
}

/** The reconcile pass over whatever daemon is connected now (none: nothing to do). */
/** Between passes while a started task on another PC is open: the daemon tells main nothing when such a task moves. */
export const REMOTE_FOLLOW_INTERVAL_MS = 10_000;

/** The timer calls a follow pass uses (injected in tests). */
export interface FollowTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const NODE_TIMERS: FollowTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * The reconcile pass over whatever daemon is connected now (none: nothing to
 * do). While a started task on another PC is open, one more pass follows
 * REMOTE_FOLLOW_INTERVAL_MS after each: its question, report, failure or gone
 * agent (and the gone grace) move the row without waiting for an unrelated
 * event. With none open, no pass is scheduled. Passes never overlap
 * (reconcileRemoteTasks is single-flight per ledger).
 */
export function remoteTaskReconciler(getDeps: () => RemoteFanoutDeps | null, timers: FollowTimers = NODE_TIMERS): (() => Promise<void>) & { stop(): void } {
  let timer: unknown = null;
  const schedule = (deps: RemoteFanoutDeps): void => {
    if (timer !== null) return;
    const open = deps.ledger.list().filter((e) => isOpenLedgerStatus(e.status));
    const following = open.some((e) => e.remote?.state === 'started');
    // A held pool task fails at its limit even when nobody calls again: a pass is due by then.
    const now = (deps.now ?? Date.now)();
    const holdEnds = open.flatMap((e) => (e.remote?.state === 'held' ? [(e.remote.pool?.heldSince ?? e.updatedAt) + holdMsOf(deps) - now] : []));
    if (!following && holdEnds.length === 0) return;
    const delay = Math.max(0, Math.min(REMOTE_FOLLOW_INTERVAL_MS, ...holdEnds));
    timer = timers.set(() => {
      timer = null;
      void run();
    }, delay);
  };
  const run = (): Promise<void> => {
    const deps = getDeps();
    if (!deps) return Promise.resolve();
    return reconcileRemoteTasks(deps)
      .catch((err: unknown) => deps.log?.(`[remote-fanout] reconcile failed: ${String(err)}`))
      .finally(() => schedule(deps));
  };
  return Object.assign(run, {
    stop: (): void => {
      if (timer !== null) timers.clear(timer);
      timer = null;
    },
  });
}

const errText = (e: unknown): string =>
  typeof e === 'string' ? e : typeof (e as { message?: unknown } | null)?.message === 'string' ? (e as { message: string }).message : 'refused';

/** The daemon side of a remote fan-out, over the connected client. */
export function remoteFanoutDepsOf(getDaemonClient: () => DaemonClient | null): RemoteFanoutDeps | null {
  const dc = getDaemonClient();
  if (!dc?.isConnected) return null;
  return {
    daemon: {
      ask: async (input) => {
        const res = await dc.a2aSpawnAsk(input);
        // Test seam for a live run: the daemon stores and sends the request,
        // and its answer never reaches this PC (a lost reply).
        if (process.env['WMUX_TEST_DROP_SPAWN_ASK_REPLY'] === '1') throw new Error('the answer was dropped (WMUX_TEST_DROP_SPAWN_ASK_REPLY)');
        return res;
      },
      outgoing: () => dc.a2aSpawnOutgoing(),
      revokeLink: async (linkId) => {
        const res = await dc.a2aRemoteLinkAction('revoke', linkId);
        // Gone, or ended already: nothing left to end.
        if (!res.ok && res.error !== 'unknown-link' && res.error !== 'invalid-state') throw new Error(res.message ?? res.error);
      },
      missionStart: async (p) => {
        const started = (await dc.rpc('task.mission.start', { ...p, memberId: p.verifiedWorkspaceId })) as { ok?: boolean; taskId?: string; channelId?: string; error?: unknown };
        return started?.ok && started.taskId && started.channelId ? { taskId: started.taskId, channelId: started.channelId } : { error: errText(started?.error) };
      },
      selfHostId: async () => (await dc.a2aRemoteStatus()).hostId,
      linkRemoteWorkspace: async (linkId) => (await dc.a2aRemoteLinksList()).links.find((l) => l.linkId === linkId)?.remote.workspaceId ?? null,
      closedMissions: async (verifiedWorkspaceId) => {
        const res = (await dc.rpc('task.mission.list', { verifiedWorkspaceId })) as { ok?: boolean; tasks?: Array<{ id?: unknown; status?: unknown }>; error?: unknown };
        if (!res?.ok || !Array.isArray(res.tasks)) throw new Error(errText(res?.error));
        return new Set(res.tasks.filter((t) => t.status === 'closed' && typeof t.id === 'string').map((t) => t.id as string));
      },
      missionClose: async (taskId, verifiedWorkspaceId) => {
        await dc.rpc('task.mission.close', { taskId, verifiedWorkspaceId });
      },
      taskStates: async (workspaceId, taskIds) => {
        const res = (await dc.rpc('a2a.task.query', { workspaceId, view: 'state', taskIds })) as { ok?: boolean; tasks?: unknown[]; error?: unknown };
        if (!res?.ok || !Array.isArray(res.tasks)) throw new Error(errText(res?.error));
        return res.tasks.flatMap(remoteTaskViewOf);
      },
    },
    ledger: getTaskLedger(),
    rememberChannel: rememberMissionChannel,
    log: (line) => console.warn(line),
    ...poolHoldOverride(),
  };
}

/** Test seam for a live run: WMUX_TEST_POOL_HOLD_MS (a positive integer of ms) shortens the pool hold limit; unset, the limit is POOL_HOLD_MAX_MS. */
export function poolHoldOverride(): { poolHoldMs?: number } {
  const raw = process.env['WMUX_TEST_POOL_HOLD_MS'];
  const ms = raw !== undefined && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : null;
  return ms !== null && ms < POOL_HOLD_MAX_MS ? { poolHoldMs: ms } : {};
}
