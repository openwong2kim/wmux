// ─── Deck plumbing that serves human panes ───────────────────────────────────
//
// What is left of the Command Deck once the per-workspace brains are gone:
// the bookkeeping fan-out and PR work needs whoever started it.
//   - the task ledger follows WorkTask (a periodic reconcile) and posts every
//     transition to the task's mission channel;
//   - a finished task workspace drops the autonomy it inherited;
//   - the pane that started a fan-out is told when its workers move, stop or
//     go idle (fanoutCallerNotify.ts, fanoutCallerStopNotify.ts,
//     fanoutWorkerWatchHost.ts), and the pane that owns a PR hears its CI,
//     review and conflict events (prOwnerNotify.ts);
//   - the renderer reads every workspace's pending bot question
//     (DECK_MOA_DECISIONS, re-read on DECK_MOA_CHANGED);
//   - once per process, the Deck state of workspaces that no longer exist is
//     archived and torn down (deckOrphanReconcile.ts).

import { ipcMain, app, type BrowserWindow } from 'electron';
import { IPC } from '../../../shared/constants';
import type { MoaPendingDecision } from '../../../shared/moa';
import { wrapHandler } from '../wrapHandler';
import { getWmuxDir } from '../../../daemon/config';
import { sweepOrphanAtomicTemps } from '../../../daemon/util/atomicWrite';
import { eventBus } from '../../events/EventBus';
import { getWorkspaceMirror } from '../../workspace/WorkspaceMirror';
import { setWorkspaceMode } from '../../deck/deckAutonomyStore';
import { loadDeckDecisions, onDecisionsChanged } from '../../deck/deckDecisionStore';
import { operatorDecisionContext, setDeckWorkBootId } from '../../deck/deckWorkStore';
import { createWorkTaskReconciler, getTaskLedger, installLedgerChannelEmitter } from '../../deck/taskLedgerHost';
import { installFanoutCallerLedgerNotify, notifyFanoutCaller } from '../../deck/fanoutCallerNotify';
import { createFanoutCallerStopNotify } from '../../deck/fanoutCallerStopNotify';
import { startFanoutWorkerWatch } from '../../deck/fanoutWorkerWatchHost';
import { notifyPrOwner, setPrOwnerSink } from '../../deck/prOwnerNotify';
import { isStartupDeckReconcileDone, tryStartupDeckReconcile } from '../../deck/deckOrphanReconcile';
import { getWorkLinkStore } from '../../workLink/workLinkStore';
import { getFanOutGuards } from '../../worktask/fanoutGuards';

type GetWindow = () => BrowserWindow | null;

/** The daemon calls this module makes. */
export interface DeckDaemonClient {
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

export interface RegisterDeckHandlerOptions {
  /** Live daemon client getter (the ledger reconcile and the mission channel). */
  getDaemonClient?: () => DeckDaemonClient | null;
  /** Data directory override for tests. */
  dir?: string;
}

/** No workspace has a brain of its own any more: every owner is told. */
const NO_BRAIN = (): boolean => false;

export function registerDeckHandler(getWindow: GetWindow, opts: RegisterDeckHandlerOptions = {}): () => void {
  // One process-wide boot identity for durable work records (#733).
  setDeckWorkBootId(eventBus.bootId);

  // WMX-06: sweep orphan atomic write temps before the deck stores are read.
  try {
    sweepOrphanAtomicTemps(opts.dir ?? getWmuxDir());
  } catch {
    /* best-effort — startup sweep must never break registration */
  }

  const send = (channel: string, payload: unknown): boolean => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return false;
    win.webContents.send(channel, payload);
    return true;
  };

  // Lane F: the ledger mirrors WorkTask (the identity source) on demand —
  // every workspace the mirror knows is a candidate owner, listed through the
  // daemon's owner-scoped `task.mission.list`. Throttled inside.
  const reconcileTaskLedger = createWorkTaskReconciler({
    candidateOwners: () => (getWorkspaceMirror().getEntries() ?? []).map((e) => e.id),
    listTasks: async (owner) => {
      const client = opts.getDaemonClient?.() ?? null;
      if (!client) return null;
      return client.rpc('task.mission.list', { verifiedWorkspaceId: owner });
    },
    originOf: (taskWorkspaceId) => getFanOutGuards().lineageFor([taskWorkspaceId])[taskWorkspaceId]?.origin ?? null,
  });
  // Every ledger transition is posted to the task's mission channel as the
  // owner workspace, so the channel transcript and the ledger never disagree.
  const disposeLedgerEmitter = installLedgerChannelEmitter({
    post: async ({ channelId, ownerWorkspaceId, text, clientMsgId }) => {
      const client = opts.getDaemonClient?.() ?? null;
      if (!client) return null;
      return client.rpc('a2a.channel.post', {
        channelId,
        sender: { workspaceId: ownerWorkspaceId, memberId: ownerWorkspaceId },
        text,
        verifiedWorkspaceId: ownerWorkspaceId,
        clientMsgId,
      });
    },
  });
  // A finished task workspace must not keep the autonomy it inherited from its
  // owner (taskAutonomy.ts): hand it the product default again.
  const disposeFinishedTaskMode = getTaskLedger().onTransition((t) => {
    if (t.to === 'completed' || t.to === 'failed' || t.to === 'cancelled') {
      void setWorkspaceMode(t.entry.taskWorkspaceId, 'off', opts.dir).catch((err) => {
        console.warn(`[deck] could not clear the autonomy of finished task workspace ${t.entry.taskWorkspaceId}: ${String(err)}`);
      });
    }
  });

  // The pane that started a fan-out, told when its workers move
  // (fanoutCallerNotify.ts). One pointer to the renderer, no ack.
  const notifyCaller = (owner: string, taskWs: string, taskId: string, kind: string, seq: number): void => {
    notifyFanoutCaller(owner, taskWs, taskId, kind, seq, { send: (payload) => send(IPC.DECK_FANOUT_CALLER, payload) });
  };
  const disposeCallerLedgerNotify = installFanoutCallerLedgerNotify(NO_BRAIN, notifyCaller);
  // A worker whose agent exited, whose PTY ended, or that sits idle long after
  // its last turn moves to input_required, which the line above tells the
  // caller; its turn ends reach the caller too (fanoutCallerStopNotify.ts).
  const workerWatch = startFanoutWorkerWatch(
    getWindow,
    () => opts.getDaemonClient?.() ?? null,
    NO_BRAIN,
    createFanoutCallerStopNotify({
      deckRuntimeActive: NO_BRAIN,
      hasBrain: NO_BRAIN,
      notify: notifyCaller,
      reconcile: reconcileTaskLedger,
    }),
  );
  // Periodic pass: a task closed or detached elsewhere only shows up by
  // re-reading WorkTask, and an idle worker only by looking again.
  const ledgerReconcileTimer = setInterval(() => {
    void reconcileTaskLedger().catch(() => undefined);
    void workerWatch.tick().catch(() => undefined);
  }, 60_000);
  ledgerReconcileTimer.unref?.();
  // The pane that owns a PR, told about CI / review / conflict
  // (prOwnerNotify.ts).
  setPrOwnerSink((ev) => {
    notifyPrOwner(ev, {
      hasBrain: NO_BRAIN,
      send: (payload) => send(IPC.DECK_PR_OWNER, payload),
    });
  });

  // WMX-06: once the renderer's workspace mirror is loaded, archive and tear
  // down the Deck state of workspaces that no longer exist, and settle the
  // work links they owned. Bounded retries (5 × 2.5 s); a mirror that never
  // arrives skips it for this process.
  const settleClosedWork = opts.dir
    ? undefined
    : (live: ReadonlySet<string>) => getWorkLinkStore().abandonOrphaned((ws) => live.has(ws));
  let orphanReconcileRetries = 0;
  const MAX_ORPHAN_RECONCILE_RETRIES = 5;
  let orphanReconcileTimer: ReturnType<typeof setInterval> | null = null;
  const stopOrphanReconcile = (): void => {
    if (orphanReconcileTimer) clearInterval(orphanReconcileTimer);
    orphanReconcileTimer = null;
  };
  if (!isStartupDeckReconcileDone()) {
    orphanReconcileTimer = setInterval(() => {
      if (isStartupDeckReconcileDone() || ++orphanReconcileRetries > MAX_ORPHAN_RECONCILE_RETRIES) {
        stopOrphanReconcile();
        if (!isStartupDeckReconcileDone()) {
          console.log('[deck:reconcile] skipped startup reconcile: workspace mirror not ready after retries');
        }
        return;
      }
      void tryStartupDeckReconcile({ dir: opts.dir, settleClosedWork }).then((done) => {
        if (done) stopOrphanReconcile();
      });
    }, 2500);
    orphanReconcileTimer.unref?.();
  }

  // Every workspace's pending decision a bot asked (Fleet's tickets, the phone
  // sidebar). It is answered in the workspace's room. A card the removed
  // brains raised has nowhere left to be answered: it stays on disk, unlisted.
  // A change rides DECK_MOA_CHANGED, told by the store after every write.
  const offDecisionsChanged = onDecisionsChanged(() => { send(IPC.DECK_MOA_CHANGED, {}); });
  ipcMain.removeHandler(IPC.DECK_MOA_DECISIONS);
  ipcMain.handle(
    IPC.DECK_MOA_DECISIONS,
    wrapHandler(IPC.DECK_MOA_DECISIONS, async (): Promise<{ decisions: MoaPendingDecision[] }> => {
      const names = new Map((getWorkspaceMirror().getEntries() ?? []).map((e) => [e.id, e.name]));
      const decisions: MoaPendingDecision[] = [];
      for (const [workspaceId, d] of Object.entries(loadDeckDecisions(opts.dir))) {
        if (d.status !== 'pending' || d.origin !== 'ask_person') continue;
        const workspaceName = names.get(workspaceId);
        decisions.push({
          workspaceId,
          ...(workspaceName ? { workspaceName } : {}),
          decision: { id: d.id, question: d.question, options: d.options, context: operatorDecisionContext(d.context), raisedAt: d.raisedAt },
        });
      }
      decisions.sort((a, b) => b.decision.raisedAt - a.decision.raisedAt);
      return { decisions };
    }),
  );

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(ledgerReconcileTimer);
    stopOrphanReconcile();
    disposeLedgerEmitter();
    disposeFinishedTaskMode();
    disposeCallerLedgerNotify();
    workerWatch.dispose();
    setPrOwnerSink(null);
    offDecisionsChanged();
    ipcMain.removeHandler(IPC.DECK_MOA_DECISIONS);
  };
  app.once('before-quit', dispose);
  return () => {
    app.removeListener('before-quit', dispose);
    dispose();
  };
}
