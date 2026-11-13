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
import { isHostId } from '../../shared/a2aRemote';
import type { AgentSlug } from '../../shared/agentIdentity';
import { type LedgerEntry, type LedgerRemote, remoteTaskWorkspaceId } from '../../shared/ledger';
import { isOpenLedgerStatus, type LedgerTransition, type TaskLedger } from '../../daemon/ledger/TaskLedger';
import { remoteTaskId } from '../../daemon/a2aRemote/ids';
import type { DaemonClient } from '../DaemonClient';
import { getTaskLedger, rememberMissionChannel } from '../deck/taskLedgerHost';

/** The one agent a fan-out asks another PC for in v1 (the agent a box starts with nobody at the pane). */
export const REMOTE_FANOUT_AGENT: AgentSlug = 'claude';

/** How long a request waits for the other PC (the shortest a request may ask for). */
export const REMOTE_FANOUT_EXPIRES_HOURS = 1;

/** Appended to every remote task's prompt: v1 brings back only the branch and its head. */
export const REMOTE_TASK_FOOTER =
  'When you are done, commit your work on the current branch, and end your last reply with the branch name and the commit sha.';

export interface RemoteFanoutDaemon {
  ask(input: A2aSpawnAskInput): Promise<A2aSpawnAskResult>;
  outgoing(): Promise<A2aSpawnOutgoingList>;
  /** This PC's host id, as the other PC knows it; null when not known. */
  selfHostId(): Promise<string | null>;
  revokeLink(linkId: string): Promise<void>;
  missionStart(p: { title: string; verifiedWorkspaceId: string; idempotencyKey: string }): Promise<{ taskId: string; channelId: string } | { error: string }>;
  missionClose(taskId: string, verifiedWorkspaceId: string): Promise<void>;
}

export type RemoteLedger = Pick<TaskLedger, 'get' | 'list' | 'register' | 'update' | 'updateRemote' | 'onTransition'>;

export interface RemoteFanoutDeps {
  daemon: RemoteFanoutDaemon;
  ledger: RemoteLedger;
  rememberChannel(taskId: string, channelId: string): void;
  log?: (line: string) => void;
}

export interface RemoteFanoutRequest {
  /** The caller's own key, and the workspace-scoped key it stands for. */
  idempotencyKey: string;
  scopedKey: string;
  ownerWorkspaceId: string;
  paneId: string;
  pc: string;
  root: string;
  sub?: string;
  titles: string[];
  /** The full prompt of each task, index-aligned with `titles`. */
  prompts: string[];
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
  branch?: string;
  /** Why it failed or will not run, in words. */
  reason?: string;
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** The keys of one remote fan-out: one caller key, one request key and one mission key per task. */
export function remoteFanoutKeys(scopedKey: string): { callerKey: string; requestKey: (k: number) => string; missionKey: (k: number) => string } {
  return {
    callerKey: sha256(scopedKey).slice(0, 32),
    requestKey: (k) => sha256(`${scopedKey}\0${k}`),
    missionKey: (k) => `remote-${sha256(`${scopedKey}\0${k}`).slice(0, 48)}`,
  };
}

/**
 * The branch the other PC makes for a request: `wmux/remote/<tree id>`, where
 * the tree id is named for the asking PC's host id and the spawn id
 * (headlessStarter.ts headlessTreeId; a test holds the two equal).
 */
export function remoteTaskBranch(askingHostId: string, spawnId: string): string {
  const h = sha256(`${askingHostId}:${spawnId}`);
  return `wmux/remote/sp-${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
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
      const size = promptBytes !== undefined ? ` (${Math.ceil(promptBytes / 1024)} KiB)` : '';
      return `${pc} does not let this PC start this agent in that folder, or the prompt${size} is longer than it accepts (not-allowed)`;
    }
    case 'agent-not-allowed': return `${pc} does not let this PC start Claude (agent-not-allowed)`;
    case 'agent-not-installed': return `Claude is not installed on ${pc} (agent-not-installed)`;
    case 'folder-not-allowed': return `${pc} does not let this PC use that folder (folder-not-allowed)`;
    case 'expired': return `${pc} did not start it within ${REMOTE_FANOUT_EXPIRES_HOURS} hour (expired)`;
    case 'rate-limited': return `${pc} is at its own limit of agents (rate-limited)`;
    case 'declined': return `${pc}'s owner declined it (declined)`;
    case 'app-not-ready': return `${pc} could not take it: its wmux was not ready (app-not-ready)`;
    default: return `${pc} could not start the agent (${code ?? 'failed'})`;
  }
}

/** Refusals that need nothing but the parameters (decision H). Null: none. */
export function remoteFanoutRefusal(params: Record<string, unknown>): string | null {
  const present = (k: string): boolean => params[k] !== undefined && params[k] !== null;
  for (const [k, what] of [
    ['dependsOn', 'depends_on'], ['files', 'files'], ['checkout', 'checkout'], ['secretNames', 'secret_names'],
    ['connectors', 'connectors'], ['preset', 'preset'], ['roles', 'roles'], ['threadId', 'thread_id'],
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

function resultOf(index: number, title: string, entry: LedgerEntry, channelId: string | undefined, promptBytes: number): RemoteTaskResult {
  const r = entry.remote;
  const failed = entry.status === 'failed' || entry.status === 'cancelled';
  return {
    index, title, ok: !failed, taskId: entry.id,
    ...(channelId ? { channelId } : {}),
    ...(r ? {
      spawnId: r.spawnId, state: r.state,
      ...(r.code ? { code: r.code } : {}),
      ...(r.linkId ? { linkId: r.linkId } : {}),
      ...(r.a2aTaskId ? { a2aTaskId: r.a2aTaskId } : {}),
      ...(r.branch ? { branch: r.branch } : {}),
      ...(r.state === 'refused' || r.state === 'expired' ? { reason: remoteCodeText(r.code, r.pc, promptBytes) } : {}),
    } : {}),
    ...(failed && !r?.code ? { reason: entry.summary ?? entry.status } : {}),
  };
}

/**
 * Start (or, for a key already used, answer) a remote fan-out. Refusals of the
 * whole call come back as `{ error }`; a task that fails alone is a result
 * with `ok: false`.
 */
export async function startRemoteFanout(req: RemoteFanoutRequest, deps: RemoteFanoutDeps): Promise<{ hostId: string; pc: string; tasks: RemoteTaskResult[] } | { error: string }> {
  let list: A2aSpawnOutgoingList;
  try {
    list = await deps.daemon.outgoing();
  } catch (err) {
    return { error: `the background service could not list the paired PCs (${(err as Error).message})` };
  }
  const place = resolvePlace(list.places, req.pc);
  if (place === 'unknown-pc' || place === 'ambiguous-pc') return { error: askErrorText(place, req.pc) };
  const pcName = place.name?.trim() || req.pc;
  if (!place.supported) return { error: askErrorText('not-supported', pcName) };

  const keys = remoteFanoutKeys(req.scopedKey);
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
      tasks.push({ index: k, title, ok: false, reason: `the mission could not be started (${mission.error})` });
      continue;
    }
    const { taskId, channelId } = mission;
    deps.rememberChannel(taskId, channelId);
    const existing = deps.ledger.get(taskId);
    if (existing) {
      // A retry: answered from the row, never asked again.
      tasks.push(resultOf(k, title, existing, channelId, promptBytes));
      continue;
    }
    let asked: A2aSpawnAskResult;
    try {
      asked = await deps.daemon.ask({
        pc: place.hostId,
        agent: REMOTE_FANOUT_AGENT,
        folder: { root: req.root, ...(req.sub ? { sub: req.sub } : {}) },
        text,
        expiresInHours: REMOTE_FANOUT_EXPIRES_HOURS,
        from: { kind: 'pane', workspaceId: req.ownerWorkspaceId, paneId: req.paneId },
        callerKey: keys.callerKey,
        requestKey: keys.requestKey(k),
        budget: 'fanout',
      });
    } catch (err) {
      asked = { ok: false, error: 'unavailable', message: (err as Error).message };
    }
    if (!asked.ok) {
      // Nothing was sent: the mission is closed so it does not count as open.
      await deps.daemon.missionClose(taskId, req.ownerWorkspaceId).catch(() => undefined);
      tasks.push({ index: k, title, ok: false, taskId, channelId, reason: askErrorText(asked.error, pcName, asked.message) });
      continue;
    }
    const spawn = asked.spawn;
    try {
      const entry = await deps.ledger.register({
        id: taskId,
        taskWorkspaceId: remoteTaskWorkspaceId(spawn.spawnId),
        ownerWorkspaceId: req.ownerWorkspaceId,
        title,
        remote: { hostId: place.hostId, pc: pcName, spawnId: spawn.spawnId, root: req.root, state: spawn.state, ...(spawn.code ? { code: spawn.code } : {}) },
      });
      tasks.push(resultOf(k, title, entry, channelId, promptBytes));
    } catch (err) {
      // The request is out: the same key again registers it (the request key answers with it).
      tasks.push({ index: k, title, ok: false, taskId, channelId, spawnId: spawn.spawnId, state: spawn.state, reason: `the task row could not be written (${(err as Error).message}); send the same key again` });
    }
  }
  // States that arrived meanwhile (a refusal, a start) are on the rows before the answer.
  await reconcileRemoteTasks(deps).catch((err: unknown) => deps.log?.(`[remote-fanout] reconcile failed: ${String(err)}`));
  for (const t of tasks) {
    if (!t.taskId || t.ok === false && !t.spawnId) continue;
    const entry = deps.ledger.get(t.taskId);
    if (entry) Object.assign(t, resultOf(t.index, t.title, entry, t.channelId, Buffer.byteLength(req.prompts[t.index], 'utf8')));
  }
  return { hostId: place.hostId, pc: pcName, tasks };
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

/** The task was closed, cancelled or failed here: a start that arrives later is ended at once. */
export async function withdrawRemote(entry: LedgerEntry, deps: RemoteFanoutDeps): Promise<void> {
  const r = entry.remote;
  if (!r) return;
  const marked = r.withdrawn ? entry : await deps.ledger.updateRemote(entry.id, { withdrawn: true });
  if (!marked?.remote) return;
  if (marked.remote.linkId && !marked.remote.revoked) await revokeOnce(marked, marked.remote.linkId, deps);
}

/** Move every remote row to what this PC's sent requests say now. */
export async function reconcileRemoteTasks(deps: RemoteFanoutDeps): Promise<void> {
  const rows = deps.ledger.list().filter((e) => e.remote && !(e.remote.withdrawn && (e.remote.revoked || e.remote.state === 'refused' || e.remote.state === 'expired')));
  if (rows.length === 0) return;
  const list = await deps.daemon.outgoing();
  const bySpawn = new Map<string, A2aSpawnOutgoingSummary>(list.requests.map((r) => [r.spawnId, r]));
  let self: string | null | undefined;
  for (const row of rows) {
    const r = row.remote!;
    const rec = bySpawn.get(r.spawnId);
    let next: LedgerEntry | null = row;
    if (!rec) {
      // Not held any more: a waiting row ends here and is never asked again.
      if (r.state === 'sent' || r.state === 'waiting') next = await deps.ledger.updateRemote(row.id, { state: 'expired', code: 'expired' });
    } else if (rec.state === 'started' && asSpawnLinkId(rec.linkId)) {
      const linkId = asSpawnLinkId(rec.linkId)!;
      if (self === undefined) self = await deps.daemon.selfHostId().catch(() => null);
      next = await deps.ledger.updateRemote(row.id, {
        state: 'started',
        linkId,
        a2aTaskId: remoteTaskId(linkId, spawnFirstMessageId(linkId)),
        ...(self ? { branch: remoteTaskBranch(self, r.spawnId) } : {}),
      });
      if (next?.remote?.withdrawn && !next.remote.revoked) await revokeOnce(next, linkId, deps);
    } else if (rec.state !== r.state || rec.code !== r.code) {
      next = await deps.ledger.updateRemote(row.id, { state: rec.state, ...(rec.code ? { code: rec.code } : {}) });
    }
    const nr = next?.remote;
    if (next && nr && (nr.state === 'refused' || nr.state === 'expired') && isOpenLedgerStatus(next.status)) {
      await deps.ledger.update({ id: next.id, status: 'failed', actor: { kind: 'system', workspaceId: 'main' }, expectedRev: next.rev, summary: remoteCodeText(nr.code, nr.pc) });
    }
  }
}

/** Withdraw every remote row that closes, is cancelled or fails here. Returns the unsubscribe. */
export function installRemoteTaskWithdraw(ledger: Pick<RemoteLedger, 'onTransition'>, getDeps: () => RemoteFanoutDeps | null): () => void {
  return ledger.onTransition((t: LedgerTransition) => {
    if (!t.entry.remote || (t.to !== 'cancelled' && t.to !== 'failed')) return;
    const deps = getDeps();
    if (!deps) return; // The next reconcile pass withdraws it: a closed row with a start ends then.
    void withdrawRemote(t.entry, deps).catch((err: unknown) => deps.log?.(`[remote-fanout] ${t.entry.id}: withdraw failed: ${String(err)}`));
  });
}

/** One reconcile at a time; a call while one runs runs once more after it. */
export function remoteTaskReconciler(getDeps: () => RemoteFanoutDeps | null): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  const run = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        const deps = getDeps();
        if (!deps) return;
        await reconcileRemoteTasks(deps).catch((err: unknown) => deps.log?.(`[remote-fanout] reconcile failed: ${String(err)}`));
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  };
  return run;
}

const errText = (e: unknown): string =>
  typeof e === 'string' ? e : typeof (e as { message?: unknown } | null)?.message === 'string' ? (e as { message: string }).message : 'refused';

/** The daemon side of a remote fan-out, over the connected client. */
export function remoteFanoutDepsOf(getDaemonClient: () => DaemonClient | null): RemoteFanoutDeps | null {
  const dc = getDaemonClient();
  if (!dc?.isConnected) return null;
  return {
    daemon: {
      ask: (input) => dc.a2aSpawnAsk(input),
      outgoing: () => dc.a2aSpawnOutgoing(),
      selfHostId: async () => (await dc.a2aRemoteStatus()).hostId,
      revokeLink: async (linkId) => {
        const res = await dc.a2aRemoteLinkAction('revoke', linkId);
        // Gone, or ended already: nothing left to end.
        if (!res.ok && res.error !== 'unknown-link' && res.error !== 'invalid-state') throw new Error(res.message ?? res.error);
      },
      missionStart: async (p) => {
        const started = (await dc.rpc('task.mission.start', { ...p, memberId: p.verifiedWorkspaceId })) as { ok?: boolean; taskId?: string; channelId?: string; error?: unknown };
        return started?.ok && started.taskId && started.channelId ? { taskId: started.taskId, channelId: started.channelId } : { error: errText(started?.error) };
      },
      missionClose: async (taskId, verifiedWorkspaceId) => {
        await dc.rpc('task.mission.close', { taskId, verifiedWorkspaceId });
      },
    },
    ledger: getTaskLedger(),
    rememberChannel: rememberMissionChannel,
    log: (line) => console.warn(line),
  };
}
