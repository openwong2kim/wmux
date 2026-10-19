// ─── Task ledger — main-process host ─────────────────────────────────────────
//
// The TaskLedger (src/daemon/ledger) is a plain fs-backed class; every consumer
// that needs it lives in the main process (the pipe RPC, the fan-out service,
// the merge lane, the factory), so main hosts the single instance here. The
// data dir is the WMUX_DATA_SUFFIX-scoped wmux dir, same as the deck-* stores.

import { getWmuxDir } from '../../daemon/config';
import { TaskLedger, type LedgerTransition } from '../../daemon/ledger/TaskLedger';
import { redactStoredSecretsDeep } from '../factory/secretRedaction';

let ledger: TaskLedger | null = null;

/** taskId → mission channel id, learned from the projection / fan-out (step
 *  5 posts transitions there). Released when the entry leaves the ledger. */
const missionChannels = new Map<string, string>();

export function getTaskLedger(): TaskLedger {
  if (!ledger) {
    ledger = new TaskLedger({
      dir: getWmuxDir(),
      log: (line) => console.warn(line),
      onPrune: (id) => missionChannels.delete(id),
      redact: redactStoredSecretsDeep,
    });
  }
  return ledger;
}

/** Tests only: swap the hosted instance (null = re-create lazily). */
export function setTaskLedgerForTests(instance: TaskLedger | null): void {
  ledger = instance;
  missionChannels.clear();
}

// ── mission-channel emitter (lane F step 5) ─────────────────────────────────

/** `[ledger] <taskId> <from>→<to> <by> worker: "<summary>"` — one line per
 *  transition. The summary is text the ACTOR wrote (a worker, usually) and
 *  the post goes out under the owner's authorship, so it is quoted and
 *  labelled with its author kind: provenance stays visible in the transcript. */
export function formatLedgerTransition(t: LedgerTransition): string {
  const by = `${t.by.kind}@${t.by.workspaceId}`;
  const summary = t.summary
    ? ` ${t.by.kind}: "${t.summary.replace(/\s+/g, ' ').replace(/"/g, '”').trim().slice(0, 500)}"`
    : '';
  return `[ledger] ${t.entry.id} ${t.from ?? 'new'}→${t.to} ${by}${summary}`;
}

export interface LedgerChannelPort {
  /** Post `text` to `channelId` as the owner workspace (the mission channel's
   *  creator). Resolves to the daemon's envelope; rejections are swallowed. */
  post: (input: { channelId: string; ownerWorkspaceId: string; text: string; clientMsgId: string }) => Promise<unknown>;
}

/** Subscribe the hosted ledger to a mission-channel poster. Every transition
 *  whose task has a known mission channel is posted there; a task with no
 *  channel yet (not reconciled) is skipped. Returns the unsubscribe. */
export function installLedgerChannelEmitter(port: LedgerChannelPort, instance?: TaskLedger): () => void {
  const l = instance ?? getTaskLedger();
  return l.onTransition((t) => {
    const channelId = getMissionChannelId(t.entry.id);
    if (!channelId) return;
    void port
      .post({
        channelId,
        ownerWorkspaceId: t.entry.ownerWorkspaceId,
        text: formatLedgerTransition(t),
        clientMsgId: `ledger:${t.entry.id}:${t.entry.rev}`,
      })
      .catch(() => undefined);
  });
}

// ── reconcile with WorkTask (the identity source) ───────────────────────────

/** The slice of the daemon's `task.mission.list` projection the ledger needs. */
export interface WorkTaskProjectionLike {
  id: string;
  title: string;
  status: 'open' | 'closed';
  owner: { verifiedWorkspaceId: string };
  paneGroupId?: string;
  missionChannelId?: string;
}

export interface WorkTaskReconcilerPorts {
  /** Workspaces that may own tasks (every workspace the mirror knows). */
  candidateOwners: () => string[];
  /** `task.mission.list` for one owner — the daemon's owner-scoped read. */
  listTasks: (ownerWorkspaceId: string) => Promise<unknown>;
  ledger?: TaskLedger;
  /** Who started the task in `taskWorkspaceId`, from its lineage stamp, or
   *  null. A mirrored row carries it as its dispatch origin, so a recovered
   *  bot worker counts on its bot's slots. */
  originOf?: (taskWorkspaceId: string) => { kind: string; botId?: string; tainted?: boolean } | null;
  /** Minimum spacing between two full passes (default 10s). */
  minIntervalMs?: number;
  now?: () => number;
}

export function getMissionChannelId(taskId: string): string | null {
  return missionChannels.get(taskId) ?? null;
}

/** The fan-out task whose mission channel this is, or null. */
export function getMissionTaskId(channelId: string): string | null {
  for (const [taskId, id] of missionChannels) if (id === channelId) return taskId;
  return null;
}

export function rememberMissionChannel(taskId: string, channelId: string): void {
  missionChannels.set(taskId, channelId);
}

/** A WorkTask was closed (task.mission.close succeeded, or the task was
 *  detached): force its ledger entry to `cancelled` NOW rather than on the
 *  next reconcile pass, and release its channel mapping. Never throws. */
export async function noteWorkTaskClosed(taskId: string, instance?: TaskLedger): Promise<void> {
  const l = instance ?? getTaskLedger();
  try {
    if (l.get(taskId)) await l.closeTask(taskId);
  } catch (err) {
    console.warn(`[deck] ledger close for ${taskId} failed: ${String(err)}`);
  }
  missionChannels.delete(taskId);
}

function projectTasks(res: unknown): WorkTaskProjectionLike[] {
  const r = res as { ok?: boolean; tasks?: unknown } | null;
  if (!r || r.ok !== true || !Array.isArray(r.tasks)) return [];
  return r.tasks.filter((t): t is WorkTaskProjectionLike => {
    if (!t || typeof t !== 'object') return false;
    const x = t as Record<string, unknown>;
    return (
      typeof x.id === 'string' &&
      (x.status === 'open' || x.status === 'closed') &&
      !!x.owner &&
      typeof (x.owner as Record<string, unknown>).verifiedWorkspaceId === 'string'
    );
  });
}

/**
 * Build a throttled "mirror WorkTask into the ledger" pass: every open,
 * materialized task (paneGroupId = its workspace) gets a `working` entry if it
 * has none; every closed task with a live entry is force-cancelled. The ledger
 * never invents a task — every entry here is a WorkTask the daemon returned.
 * Runs from the periodic timer, before a Stop-gate evaluation and on an
 * unknown-workspace event; the throttle makes all three cheap.
 */
export function createWorkTaskReconciler(ports: WorkTaskReconcilerPorts): () => Promise<void> {
  const now = ports.now ?? Date.now;
  const minInterval = ports.minIntervalMs ?? 10_000;
  let lastRun = -Infinity;
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    if (now() - lastRun < minInterval) return Promise.resolve();
    const l = ports.ledger ?? getTaskLedger();
    inFlight = (async () => {
      lastRun = now();
      const owners = [...new Set(ports.candidateOwners())];
      for (const owner of owners) {
        let tasks: WorkTaskProjectionLike[];
        try {
          tasks = projectTasks(await ports.listTasks(owner));
        } catch {
          continue;
        }
        for (const t of tasks) {
          if (t.status === 'closed') {
            if (l.get(t.id)) await l.closeTask(t.id);
            missionChannels.delete(t.id);
            continue;
          }
          if (typeof t.missionChannelId === 'string') missionChannels.set(t.id, t.missionChannelId);
          if (!t.paneGroupId || l.get(t.id)) continue;
          let origin: { kind: string; botId?: string; tainted?: boolean } | null = null;
          try {
            origin = ports.originOf?.(t.paneGroupId) ?? null;
          } catch {
            origin = null;
          }
          try {
            await l.register({
              id: t.id,
              taskWorkspaceId: t.paneGroupId,
              ownerWorkspaceId: t.owner.verifiedWorkspaceId,
              title: typeof t.title === 'string' ? t.title : t.id,
              ...(origin && typeof origin.kind === 'string' && origin.kind
                ? {
                    dispatch: {
                      origin: {
                        kind: origin.kind,
                        ...(origin.botId ? { botId: origin.botId } : {}),
                        // Absent stays absent: a bot task without it counts as tainted.
                        ...(typeof origin.tainted === 'boolean' ? { tainted: origin.tainted } : {}),
                      },
                      reconciled: true as const,
                    },
                  }
                : {}),
            });
          } catch (err) {
            console.warn(`[deck] ledger register for ${t.id} failed: ${String(err)}`);
          }
        }
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
