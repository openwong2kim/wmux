// ─── Command Deck — Commander brain IPC handler (Phase 2, per-ws M1.5) ───────
//
// The thin Electron shell that wires real ClaudeSdkAdapters + a webContents
// event sink into (transport-agnostic) CommanderSessionManagers. Registered
// with ipcMain.handle — a RENDERER-ONLY surface, unreachable from the daemon
// pipe / a same-user MCP client (the identical process-boundary trust basis
// channelLocal.handler + fanout.handler rely on).
//
// M1.5: ONE ORCHESTRATOR PER WORKSPACE ("my assistant per project"). The
// single fleet-wide manager became a wsId-keyed map — each workspace gets its
// own conversation, its own busy state (true parallelism: ws-2 never queues
// behind ws-1's turn), and a commander token confined to its own panes.
// Managers are still created LAZILY on a workspace's first deck:send, so idle
// workspaces (and idle wmux sessions) pay nothing. Every DECK_STREAM push is
// enveloped with its workspaceId so the renderer routes events to the right
// per-workspace thread.
//
// The renderer supplies the active workspaceId with every call. That is the
// same renderer-trust basis as the rest of this surface — but the value is
// format-checked because it keys maps and persisted files.

import { ipcMain, app, type BrowserWindow } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { BrainAdapter, BrainEvent } from '../../deck/BrainAdapter';
import { ClaudeSdkAdapter, buildCommanderSystemPrompt, resolveMcpBundlePath } from '../../deck/ClaudeSdkAdapter';
import { AcpBrainAdapter } from '../../deck/AcpBrainAdapter';
import {
  ClaudePtyBrainAdapter,
  createBrainPtyHost,
  resolveBrainBridgePath,
  type DaemonClientLike,
} from '../../deck/ClaudePtyBrainAdapter';
import { evaluateStopGate } from '../../deck/stopGate';
import {
  noteGateVerdict,
  clearGateVerdict,
  noteGateCapOut,
  suppressedGateFingerprint,
  clearGateCapOut,
} from '../../deck/stopGateState';
import type { BrainVendor } from '../../../shared/types';
import { getMemoryRootDir } from '../../deck/commanderMemory';
import { loadDeckPolicyBlock, ensureDeckPolicySeed } from '../../deck/deckPolicy';
import { grantReExamineLease, revokeReExamineLease } from '../../deck/reExamineLease';
import {
  CommanderSessionManager,
  type CommanderSendResult,
  type CommanderStatusSnapshot,
} from '../../deck/CommanderSessionManager';
import { loadCommanderSession, saveCommanderSession, clearCommanderSession } from '../../deck/commanderSessionStore';
import { DeckScheduler } from '../../deck/DeckScheduler';
import { DeckHeartbeat } from '../../deck/DeckHeartbeat';
import { CommanderEventCoalescer } from '../../deck/CommanderEventCoalescer';
import {
  routeWorkerEventToOwner,
  takeOrphanBacklog,
  createWorkTaskReconciler,
} from '../../deck/taskLedgerHost';
import { createGlobalTurnGate, type GlobalTurnGate } from '../../deck/globalTurnGate';
import { loadDeckHeartbeat } from '../../deck/deckHeartbeatStore';
import { getWorkspaceMirror, type FleetSnapshot } from '../../workspace/WorkspaceMirror';
import {
  loadWorkspaceAutonomy,
  setWorkspaceAutonomy,
  setWorkspaceMode,
  loadWorkspaceMode,
  modeToCaps,
  type AgentMode,
} from '../../deck/deckAutonomyStore';
import { loadAutoWakeEnabled, setAutoWakeEnabled } from '../../deck/deckAutoWakeStore';
import {
  loadWorkspaceLoopState,
  renderLoopStateBlock,
  startLoop,
  clearLoop,
  setLoopStatus,
  setTaskPasses,
  LOOP_STATE_LIMITS,
  type WorkspaceLoopState,
  type LoopTier,
} from '../../deck/deckLoopStateStore';
import {
  loadWorkspaceDecision,
  loadDeckDecisions,
  resolveDecision,
  clearResolvedDecision,
  clearDecision,
  renderDecisionBlock,
  renderStaleDecisionBlock,
  isDecisionStale,
  hasPendingDecision,
  raiseDecision,
  type WorkspaceDecision,
} from '../../deck/deckDecisionStore';
import {
  beginOrContinueDeckWork,
  clearActiveDeckWork,
  hasPendingDeckWorkA2aTasks,
  isDeckWorkParked,
  loadActiveDeckWork,
  loadActiveDeckWorks,
  loadLiveDeckWork,
  loadLiveDeckWorks,
  recordDeckWorkA2aTask,
  renderActiveDeckWorkBlock,
  renderActiveDeckWorkReminderLine,
  renderStrandedDeckWorkBlock,
  setDeckWorkBootId,
  unparkDeckWork,
  type ActiveDeckWork,
} from '../../deck/deckWorkStore';
import { scanSkillCatalog, type SkillCatalogEntry } from '../../deck/skillCatalogScan';
import {
  buildWorkspaceBriefing,
  toBriefedSnapshot,
  type BriefedSnapshot,
  type WorkspaceBriefing,
} from '../../deck/deckBriefing';
import {
  loadDeckBriefingConfig,
  saveDeckBriefingConfig,
  readDeckBriefingConfig,
  readBriefedSnapshot,
  saveBriefedSnapshot,
  type DeckBriefingConfig,
} from '../../deck/deckBriefingStore';
import { eventBus } from '../../events/EventBus';
import {
  loadDeckSchedules,
  saveDeckSchedules,
  createSchedule,
  DECK_SCHEDULE_LIMITS,
  type DeckSchedule,
} from '../../deck/deckScheduleStore';

type GetWindow = () => BrowserWindow | null;

export interface RegisterDeckHandlerOptions {
  /** Adapter factory — injected in tests so no SDK subprocess spawns. Defaults
   *  to a fresh ClaudeSdkAdapter (subscription Claude, wmux MCP auto-mounted).
   *  `model` is the orchestrator model override ('' → SDK default);
   *  `workspaceId` binds the commander token to the one workspace this brain
   *  serves. */
  createAdapter?: (opts: {
    model?: string;
    workspaceId: string;
    fullPower?: boolean;
    vendor?: BrainVendor;
    /** How an adapter announces (or retracts, with null) the terminal the deck
     *  embeds. Passed to every factory — including an injected one — so the
     *  embed plumbing is exercisable without a live daemon. */
    onPtySpawned: (ptyId: string | null) => void;
    /** How an adapter reports a human prompt submitted directly in the embedded
     *  terminal brain, before that foreign turn finishes. */
    onForeignTurnStart: (prompt: string) => void;
    /** How an adapter reports that a turn IT did not start has ended (the
     *  `claude-pty` human-typed-into-the-TUI case). Passed to every factory so
     *  the wake plumbing is exercisable without a live daemon. */
    onForeignTurnEnd: () => void;
    /** How an adapter reports a session id learned from a foreign turn's Stop
     *  (TUI-only conversations must survive a restart). */
    onForeignSessionId: (sessionId: string) => void;
  }) => BrainAdapter;
  /** M2 startup-reconcile delay (ms) before resolved-but-unconsumed decisions
   *  are resumed headlessly. Deferred so daemon/session recovery settles first;
   *  injected small in tests. */
  reconcileDelayMs?: number;
  /** The fleet-wide concurrent-turn gate. Injected in tests to observe/spy the
   *  acquire path; defaults to a fresh cap-2 gate. */
  turnGate?: GlobalTurnGate;
  /** Live daemon client getter. Required for the `claude-pty` vendor, whose
   *  brain IS a daemon pty session; every other vendor ignores it. */
  getDaemonClient?: () => DaemonClientLike | null;
}

/** Fleet-context token budget (~2KB). A larger snapshot is truncated so the
 *  one-shot injection can't blow the turn's context. */
const FLEET_CONTEXT_MAX_CHARS = 2048;

/** Workspace ids key maps and persisted JSON — reject anything that isn't a
 *  plausible id token before it can become a key. */
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * The optional one-line fleet summary the coalescer appends to an edge-wake
 * prompt (getFleetTail). Counts the mirror snapshot's attention panes by status
 * so the brain sees the wider fleet state without a poll, e.g.
 * `(fleet: 2 awaiting, 1 stopped)`. Returns undefined when the mirror is empty
 * for this workspace or nothing needs attention — no line rather than a noisy
 * "0 of everything". Pure + exported for unit testing.
 */
export function buildFleetTailLine(snapshot: FleetSnapshot | null): string | undefined {
  if (!snapshot || snapshot.panes.length === 0) return undefined;
  let awaiting = 0;
  let stopped = 0;
  let errored = 0;
  for (const p of snapshot.panes) {
    if (p.agentStatus === 'awaiting_input' || p.agentStatus === 'waiting') awaiting += 1;
    else if (p.agentStatus === 'complete') stopped += 1;
    else if (p.agentStatus === 'error') errored += 1;
  }
  const parts: string[] = [];
  if (awaiting > 0) parts.push(`${awaiting} awaiting`);
  if (stopped > 0) parts.push(`${stopped} stopped`);
  if (errored > 0) parts.push(`${errored} error${errored === 1 ? '' : 's'}`);
  if (parts.length === 0) return undefined; // fleet is all running/idle — no line
  // Just the counts — no "heartbeat will review" clause, which would be a lie
  // whenever the heartbeat is disabled (3-way review P3).
  return `(fleet: ${parts.join(', ')})`;
}

/**
 * The per-turn `[autonomy]` block: tells the brain what DECISION AUTHORITY its
 * current mode carries, so it reads the policy/decision/loop blocks below it in
 * the right frame. Mode is read FRESH each turn (a Settings flip applies without
 * a restart). `off` workspaces get NO block — an off workspace should never
 * receive ambient-turn instructions. Pure + exported for unit testing.
 */
export function renderAutonomyBlock(mode: AgentMode): string | null {
  switch (mode) {
    case 'danger':
      return (
        '[autonomy] mode: danger — you have DECISION AUTHORITY. Resolve forks yourself from ' +
        'binding policy rules, standing conventions, and memory; escalate via ' +
        'deck_ask_decision ONLY for a genuine residual fork none of those settles (or a risky/' +
        'irreversible action).'
      );
    case 'assist':
      return (
        '[autonomy] mode: assist — report and recommend; do not drive panes beyond your ' +
        'caps. Escalate genuine forks via deck_ask_decision.'
      );
    case 'off':
      return null;
  }
}

/**
 * The workspace mode, as the terminal brain's LAUNCH posture (owner decision
 * 2026-08-01 — the mode says HOW claude starts, not what wakes it):
 *   assist → accept-edits, danger → bypass-permissions.
 * `off` returns null because an off workspace has no brain to launch; the null
 * is defensive only (refuseWhenModeOff stops every turn before a spawn), and it
 * resolves to "no flag", i.e. claude's own prompting default. Pure + exported
 * for unit testing.
 */
export function modeToPermissionMode(
  mode: AgentMode,
): 'acceptEdits' | 'bypassPermissions' | null {
  switch (mode) {
    case 'assist':
      return 'acceptEdits';
    case 'danger':
      return 'bypassPermissions';
    case 'off':
      return null;
  }
}

export function registerDeckHandler(
  getWindow: GetWindow,
  opts: RegisterDeckHandlerOptions = {},
): () => void {
  // Adopt one process-wide boot identity for durable work records (#733). The
  // EventBus already mints a per-process UUID at construction, so reusing it
  // keeps "this boot" meaning the same thing to the work store as it does to
  // every event consumer. Imported from `events/EventBus` (where the singleton
  // is defined) rather than from `main/index.ts`, so no cycle is introduced.
  // Runs before anything can write a record, otherwise records stamped with the
  // store's own seed value would come back parked.
  setDeckWorkBootId(eventBus.bootId);

  // One-way push: which daemon session holds a workspace's embedded brain TUI
  // (`claude-pty` only; null retires it). Declared before createAdapter so the
  // default factory can hand it to a freshly spawned adapter.
  // Main is the authority on which workspace currently has an embeddable
  // terminal; the push below is only a notification. The renderer hydrates
  // from this map on mount (DECK_BRAIN_PTY_LIST) because a reload drops
  // everything it learned from earlier pushes.
  const brainPtyIds = new Map<string, string>();
  const emitBrainPty = (workspaceId: string, ptyId: string | null): void => {
    if (ptyId) brainPtyIds.set(workspaceId, ptyId);
    else brainPtyIds.delete(workspaceId);
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.DECK_BRAIN_PTY, { workspaceId, ptyId });
    }
  };

  // The fingerprint of each workspace's LAST refused Stop (rule 5). A cap-out
  // is recorded for suppression only when it names this same state — the gate
  // must never silence a hold no refusal was ever issued for. In-memory and
  // per-registration, cleared with the commander (retireManager).
  const lastBlockedFingerprints = new Map<string, string>();

  const createAdapter =
    opts.createAdapter ??
    ((adapterOpts: {
      model?: string;
      workspaceId: string;
      fullPower?: boolean;
      vendor?: BrainVendor;
      onPtySpawned: (ptyId: string | null) => void;
      onForeignTurnStart: (prompt: string) => void;
      onForeignTurnEnd: () => void;
      onForeignSessionId: (sessionId: string) => void;
    }) => {
      // BYOB M0: the vendor picker decides which brain runtime serves this
      // workspace. 'hermes' rides the generic ACP adapter (any ACP agent
      // could — Hermes is simply the first configured spawn spec); everything
      // else is the Claude SDK default. Model/fullPower are Claude-specific
      // and deliberately not forwarded to ACP brains.
      // 'claude-pty' drives the user's OWN claude binary as an interactive TUI
      // in a daemon pty the deck embeds — the subscription-safe hedge. It needs
      // the daemon (its brain IS a session); with no daemon we fall through to
      // the SDK adapter rather than handing back a brain that cannot spawn.
      if (adapterOpts.vendor === 'claude-pty') {
        const client = opts.getDaemonClient?.() ?? null;
        if (client) {
          return new ClaudePtyBrainAdapter({
            workspaceId: adapterOpts.workspaceId,
            host: createBrainPtyHost(client),
            bridgePath: resolveBrainBridgePath(),
            onPtySpawned: adapterOpts.onPtySpawned,
            onForeignTurnStart: adapterOpts.onForeignTurnStart,
            // The Stop gate: the orchestrator may not end a turn while worker
            // panes are still running or waiting on it. The mirror lookup lives
            // here, not in the adapter, so the predicate stays pure.
            evaluateStopGate: (workspaceId, consecutiveBlocks) => {
              const snapshot = getWorkspaceMirror().getFleetSnapshot(workspaceId);
              const verdict = evaluateStopGate({
                snapshot,
                activeWork: loadActiveDeckWork(workspaceId),
                consecutiveBlocks,
                // A pending decision means the brain is legitimately waiting
                // on a human (gate rule 4) — the same signal that already
                // suppresses every auto-wake releases the Stop gate. Read
                // fresh per Stop, so resolve/clear re-arms with no state.
                pendingDecision: hasPendingDecision(workspaceId),
                // Cap-out hysteresis (rule 5): once the gate has given up on
                // this exact state, re-blocking on it next turn only re-buys
                // the same refusal run.
                suppressedFingerprint: suppressedGateFingerprint(workspaceId),
              });
              // Record which panes are holding the gate so input.rpc can refuse
              // session-terminating input aimed at them (#733). The list comes
              // off the verdict, never off the snapshot: an active-work hold on
              // a stale snapshot blocks without naming a pane, and re-reading
              // that snapshot here would protect panes the model was never told
              // about. Cleared as soon as the gate lets a turn end.
              noteGateVerdict(
                workspaceId,
                verdict.block ? verdict.outstandingPtyIds : null,
              );
              if (verdict.block) {
                lastBlockedFingerprints.set(workspaceId, verdict.fingerprint);
              } else if (
                verdict.cappedOutFingerprint &&
                // Suppress only a state the gate actually REFUSED at least
                // once. The capping Stop sees the fleet as it is NOW — a
                // worker dispatched mid-refusal-run would otherwise be
                // silenced by a cap-out no refusal ever named.
                lastBlockedFingerprints.get(workspaceId) === verdict.cappedOutFingerprint
              ) {
                noteGateCapOut(workspaceId, verdict.cappedOutFingerprint);
              }
              return verdict;
            },
            onForeignTurnEnd: adapterOpts.onForeignTurnEnd,
            onForeignSessionId: adapterOpts.onForeignSessionId,
            // The workspace mode IS the launch policy (owner decision
            // 2026-08-01): assist launches claude in accept-edits, danger in
            // bypass. Read per spawn, from here rather than inside the adapter,
            // so the adapter keeps no store dependency. `off` cannot reach a
            // spawn at all (refuseWhenModeOff gates every turn entry point), so
            // it maps to the same no-flag default a non-deck embedding gets.
            resolvePermissionMode: () => modeToPermissionMode(
              loadWorkspaceMode(adapterOpts.workspaceId),
            ),
            // The model picker applies to the TUI brain too (`--model`);
            // fullPower is SDK-only (it tunes canUseTool/allowedTools, which
            // an interactive session has no equivalent for).
            ...(adapterOpts.model ? { model: adapterOpts.model } : {}),
          });
        }
        console.warn(
          '[deck] the terminal brain (claude-pty) needs daemon mode — falling back to the Claude SDK brain.',
        );
      }
      if (adapterOpts.vendor === 'hermes') {
        return new AcpBrainAdapter({
          spawnSpec: { command: 'hermes', args: ['acp'] },
          workspaceId: adapterOpts.workspaceId,
          mcpBundlePath: resolveMcpBundlePath(),
        });
      }
      return new ClaudeSdkAdapter({
        workspaceId: adapterOpts.workspaceId,
        ...(adapterOpts.model ? { model: adapterOpts.model } : {}),
        ...(adapterOpts.fullPower ? { fullPower: true } : {}),
      });
    });

  // One Commander session per workspace (M1.5), created lazily on that
  // workspace's first send.
  interface ManagedCommander {
    manager: CommanderSessionManager;
    /** The model the manager's adapter was created with ('' = SDK default). */
    model: string;
    /** Whether the adapter was created in full-power mode (BYOB approach A). */
    fullPower: boolean;
    /** The brain vendor the adapter was created for (BYOB M0). */
    vendor: BrainVendor;
  }
  const managers = new Map<string, ManagedCommander>();

  /**
   * Retire a workspace's commander. Every dispose path routes through here so
   * the Stop-gate hold dies with the commander that created it (#733) — a new
   * commander in the same workspace must not inherit the old one's protected
   * pane set.
   */
  const retireManager = (workspaceId: string): void => {
    managers.delete(workspaceId);
    clearGateVerdict(workspaceId);
    // The cap-out suppression dies with the commander too — a new commander in
    // the same workspace starts with a fully-armed gate.
    clearGateCapOut(workspaceId);
    lastBlockedFingerprints.delete(workspaceId);
  };

  // Fleet-wide ceiling on CONCURRENT autonomous turns. Each workspace's manager
  // is already one-turn-at-a-time, but a hook storm across many workspaces could
  // wake several brains at once — this caps how many run in parallel. Held for
  // the WHOLE turn at runTurnForWorkspace (autonomous path only); human
  // DECK_SEND never passes through it. One instance per registration (not a
  // module singleton) so tests start clean.
  const globalTurnGate = opts.turnGate ?? createGlobalTurnGate(2);

  // One-shot autonomous callers (loop kickoff, decision resume, startup
  // reconcile) await a fleet slot rather than dropping their turn on a transient
  // full gate. Generous ceiling — well beyond any real turn — so it never hangs
  // forever; on timeout the queued acquire falls back to the fast `busy` reject.
  const QUEUED_ACQUIRE_TIMEOUT_MS = 120_000;

  // Full-power toggle (BYOB approach A) — MAIN-side authority so scheduled /
  // event-woken turns and toggle changes between typed commands all see the
  // live value (Codex/GLM review round 1: a send-carried flag left autonomous
  // turns on the stale mode, and a restart silently dropped a persisted ON).
  // Synced by DECK_FULLPOWER_SET: on change and once after session hydration.
  let fullPowerEnabled = false;

  // Orchestrator model — same main-authority contract as full power and the
  // vendor. Previously the model rode ONLY on the DECK_SEND payload, so it
  // reached main exactly when a human typed into the deck composer. That made
  // it invisible on two paths that matter: the terminal brain has no composer
  // at all (its TUI is the input path), and automation-driven turns spawned
  // brains on whatever the last typed turn happened to leave cached — or on
  // the SDK default when nothing had been typed yet.
  let brainModel = '';

  /** Sanitize a model override to a plausible token. It ends up on the brain
   *  subprocess command line (`--model`), so anything outside this alphabet is
   *  dropped to '' (the vendor default) rather than forwarded. */
  const sanitizeModel = (raw: unknown): string => {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return /^[A-Za-z0-9._-]{1,64}$/.test(trimmed) ? trimmed : '';
  };

  /**
   * The vendor that will actually serve a spawn right now. It diverges from the
   * SELECTED one in exactly one place: the terminal brain's pty IS a daemon
   * session, so with no daemon createAdapter hands back an SDK brain instead.
   *
   * A MISSING accessor is not the same signal as one that returns null: the
   * former means this host never wired daemon mode into the deck at all (the
   * unit-test harness, which injects its own factory), the latter is the real
   * "the daemon is gone" report createAdapter falls back on. Only the latter
   * downgrades, so a test that selects the terminal brain still gets
   * terminal-brain semantics.
   */
  const resolveEffectiveVendor = (requested: BrainVendor): BrainVendor => {
    const daemonAvailable = opts.getDaemonClient ? !!opts.getDaemonClient() : true;
    return requested === 'claude-pty' && !daemonAvailable ? 'claude' : requested;
  };

  /**
   * What a workspace is actually RUNNING as: the live manager's recorded
   * runtime, or — with nothing spawned — what a spawn right now would resolve
   * to. Every decision derived from the vendor has to read this rather than the
   * raw selection, or it describes a brain that isn't there. The two that did:
   * `/clear` computed a session key nothing had ever written (so clearing a
   * fallen-back workspace silently kept its conversation), and the ambient
   * dedup treated a headless SDK brain as the visible TUI (so autonomy/policy
   * edits stopped reaching it after the first turn).
   */
  const vendorForWorkspace = (workspaceId: string): BrainVendor =>
    managers.get(workspaceId)?.vendor ?? resolveEffectiveVendor(brainVendor);

  /** BYOB M0: each vendor keeps its OWN conversation thread. Bare workspaceId
   *  for the SDK brain so sessions persisted before vendors existed keep
   *  resuming; composite for everyone else. */
  const sessionKeyFor = (workspaceId: string, vendor: BrainVendor): string =>
    vendor === 'claude' ? workspaceId : `${workspaceId}::${vendor}`;

  // Brain vendor (BYOB M0) — same main-authority contract as full power.
  // Defaults to the terminal brain (owner decision 2026-07-30) so a turn that
  // races the renderer's first DECK_BRAIN_VENDOR_SET sync lands on the same
  // vendor the store defaults to. createAdapter still falls back to the SDK
  // brain when daemon mode is unavailable.
  let brainVendor: BrainVendor = 'claude-pty';

  // Event-push coalescer. Declared here, constructed below once
  // runTurnForWorkspace exists — the manager's onIdle closure references it
  // lazily (only invoked at runtime, long after construction), so the cyclic
  // dependency (manager → coalescer → runTurn → ensureManager → manager) is
  // resolved by late binding. (prefer-const can't see the forward references in
  // the onIdle / DECK_SEND closures above the assignment — this genuinely must
  // be a `let`.)
  // eslint-disable-next-line prefer-const
  let coalescer: CommanderEventCoalescer | undefined;

  const emit = (workspaceId: string, event: BrainEvent): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.DECK_STREAM, { workspaceId, event });
    }
  };

  /**
   * A request record has LEFT the store — superseded by a newer human request,
   * or dropped by a conversation clear. It can no longer be closed by
   * `deck_complete_work`, so anything it delegated is now unowned.
   *
   * The surface is a DECISION (deckDecisionStore), for three reasons. It is
   * durable — a toast or a stream event is gone the moment the window is, and
   * #733 itself was caused by a state clear that only ever ran from a toast
   * nobody had kept. It is already the channel this exact record class uses:
   * the startup reconcile asks "resume it, or drop it?" the same way. And a
   * pending decision suppresses auto-wake for the workspace, which is the right
   * posture while delegated tasks have no owner.
   *
   * It is raised ONLY when the dropped record still has pending A2A tasks. That
   * is the whole reason the pending state matters — and a decision has a cost:
   * it blocks autonomous follow-through on the request the human JUST made
   * until they answer. Charging that for a record with nothing outstanding
   * would tax every normal supersede for bookkeeping, and train people to click
   * through the one that matters. With nothing outstanding, the human's own
   * newer instruction is the surfacing; a log line covers diagnosis.
   *
   * Cancelling the tasks outright is not this layer's call: the A2A client
   * lives behind the pipe router (deck.rpc), main has no handle on it, and
   * "cancel someone else's running worker" is exactly the kind of fork the
   * decision gate exists to put in front of a human. So we ask.
   *
   * Never throws and never blocks its caller — the supersede/clear already
   * happened on disk, and neither may fail because of this bookkeeping.
   */
  const surfaceStrandedWork = (
    workspaceId: string,
    work: ActiveDeckWork,
    reason: 'superseded' | 'cleared',
  ): void => {
    try {
      if (!hasPendingDeckWorkA2aTasks(work)) {
        // eslint-disable-next-line no-console
        console.warn(`[deck] ${reason} work record ${work.id} (no delegated tasks outstanding)`);
        return;
      }
      // The decision store is last-writer-wins, so a real question already
      // waiting on this human must never be clobbered by our bookkeeping (same
      // guard as the startup reconcile). The log keeps the drop diagnosable.
      if (hasPendingDecision(workspaceId)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[deck] ${reason} work record ${work.id} has outstanding A2A tasks; ` +
          'a decision is already pending, not replacing it',
        );
        return;
      }
      const question = reason === 'superseded'
        ? 'A newer request replaced an earlier one that still has delegated tasks running. ' +
          'Cancel those tasks, or adopt them into the new request?'
        : 'Starting a new session dropped a request that still has delegated tasks running. ' +
          'Cancel those tasks, or leave them running?';
      void raiseDecision(workspaceId, {
        question,
        options: reason === 'superseded'
          ? ['Cancel the old tasks', 'Adopt them into the current request']
          : ['Cancel the old tasks', 'Leave them running'],
        context: renderStrandedDeckWorkBlock(work),
      }).catch(() => {
        /* best-effort — the log line above is the fallback record */
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[deck] failed to surface stranded work:', err);
    }
  };

  /** Persist request ownership without ever breaking a human turn. The store is
   *  synchronous so the DECK_SEND idle-check → send sequence does not yield. */
  const beginTrackedWork = (workspaceId: string, text: string): void => {
    const humanText = text.trim();
    try {
      // A human turn re-arms a capped-out Stop gate (rule 5): whatever state
      // the gate went quiet on, the human has now spoken, and the brain owes
      // the fleet a fresh look even if nothing else changed.
      clearGateCapOut(workspaceId);
      // The placeholder stands in for a prompt main never saw — the terminal
      // brain's UserPromptSubmit can carry an empty body. It is a fine objective
      // for a workspace that owns nothing yet, and it is NOT allowed to be
      // anything else: passed against an existing record it would either file
      // itself as a meaningless follow-up or, worse, supersede a real objective
      // with boilerplate. A blank turn therefore leaves the record exactly as it
      // is — including parked, which is the fail-closed answer for a turn whose
      // content we cannot read.
      if (!humanText) {
        if (loadActiveDeckWork(workspaceId)) return;
        beginOrContinueDeckWork(
          workspaceId,
          'Continue the request submitted directly in the commander terminal.',
        );
        return;
      }
      const result = beginOrContinueDeckWork(workspaceId, humanText);
      if (result?.superseded) surfaceStrandedWork(workspaceId, result.superseded, 'superseded');
    } catch (err) {
      // A persistence failure costs autonomous follow-through, never the human's
      // immediate turn. Keep the failure visible for diagnosis.
      // eslint-disable-next-line no-console
      console.warn('[deck] failed to persist active work:', err);
    }
  };

  /**
   * `off` means the terminal brain DOES NOT RUN (owner decision 2026-08-01).
   *
   * Every turn entry point calls this before ensureManager, because
   * ensureManager is what constructs the adapter whose first send spawns the
   * pty — refusing here is what keeps an `off` workspace from ever having a
   * live claude. Returns the refusal verdict to hand straight back to the
   * caller (`{ ok: false, code: 'mode_off' }`, the `{ ok, code }` shape every
   * other deck handler rejects with), or null to proceed.
   *
   * The renderer disables the composer for the same reason, but that is a
   * courtesy, not the enforcement: schedules, loops, the heartbeat and the pipe
   * RPC all start turns without going anywhere near it.
   */
  const refuseWhenModeOff = (workspaceId: string): { ok: false; code: 'mode_off' } | null => {
    let mode: AgentMode;
    try {
      mode = loadWorkspaceMode(workspaceId);
    } catch {
      // An unreadable store already resolves to the product default (off) inside
      // the loader; this catch only covers a throw it cannot itself absorb.
      return { ok: false, code: 'mode_off' };
    }
    return mode === 'off' ? { ok: false, code: 'mode_off' } : null;
  };

  const ensureManager = (
    workspaceId: string,
    fleetContext?: string,
    model = '',
  ): CommanderSessionManager => {
    // Model or full-power mode changed in Settings: swap that workspace's
    // brain between turns. The adapter pins both at spawn (--model /
    // settingSources), but the CONVERSATION survives — the new adapter
    // resumes the persisted session id, so this is a switch mid-thread, not a
    // new thread. Never swap while a turn streams: the busy manager keeps
    // running and the send below gets the normal `busy` reject; the new
    // setting applies on the next turn. Full power is read from the MAIN-side
    // authority (fullPowerEnabled), never from the caller — every turn path
    // gets the same answer.
    const fullPower = fullPowerEnabled;
    // The vendor the operator SELECTED vs. the runtime that will actually
    // serve this workspace. They diverge in exactly one place: the terminal
    // brain's pty IS a daemon session, so with no daemon createAdapter hands
    // back an SDK brain instead. Resolving that here rather than leaving it
    // buried in the factory is what keeps the derived state honest —
    // sessionKey, the memory policy, the swap check and the recorded entry all
    // key off the runtime that exists, not the one that was asked for.
    // Consequences of getting it wrong, all previously live: an SDK session id
    // written under the `::claude-pty` key (so the real terminal conversation
    // is unresumable), an SDK brain told it has no Write tool, and a fallback
    // manager tagged 'claude-pty' that the daemon coming back could never
    // dislodge — because `vendor !== existing.vendor` compared two requests.
    const vendor = resolveEffectiveVendor(brainVendor);
    const existing = managers.get(workspaceId);
    // Only vendor-RELEVANT settings participate in the swap check, so a change
    // never needlessly dispose+respawns a brain that ignores it (GLM review).
    // The two knobs have different reach, and conflating them left the model
    // picker dead on the terminal brain (harmless while it was opt-in, a
    // default-path bug once it became the default):
    //   model     — reaches BOTH Claude runtimes; createAdapter forwards it to
    //               the SDK brain and to the TUI's `--model` alike.
    //   fullPower — SDK-only: it tunes settingSources/canUseTool, which an
    //               interactive session has no equivalent for.
    // An ACP brain ignores both.
    const modelApplies = vendor === 'claude' || vendor === 'claude-pty';
    const claudeSettingsChanged = existing
      ? (modelApplies && model !== existing.model) ||
        (vendor === 'claude' && fullPower !== existing.fullPower)
      : false;
    if (
      existing &&
      (vendor !== existing.vendor || claudeSettingsChanged) &&
      existing.manager.getStatus().status !== 'busy'
    ) {
      existing.manager.dispose();
      retireManager(workspaceId);
      forgetAmbient(workspaceId);
    }
    const current = managers.get(workspaceId);
    if (current) return current.manager;
    // P3a: resume this workspace's persisted conversation from the previous
    // app run. A dead id is soft — the adapter falls back to a fresh session.
    const sessionKey = sessionKeyFor(workspaceId, vendor);
    const persisted = loadCommanderSession(sessionKey);
    // The adapter's foreign-turn callback needs the manager the adapter is
    // about to be constructed INTO — late-bound through this holder, exactly
    // like the coalescer's own forward reference above. It can only fire long
    // after the assignment below.
    let managerRef: CommanderSessionManager | undefined;
    const manager = new CommanderSessionManager({
      adapter: createAdapter({
        workspaceId,
        vendor,
        onPtySpawned: (ptyId) => emitBrainPty(workspaceId, ptyId),
        onForeignTurnStart: (prompt) => {
          // The default terminal brain has no deck composer: UserPromptSubmit is
          // the only place main sees that a human explicitly assigned work.
          beginTrackedWork(workspaceId, prompt);
          coalescer?.notifyHumanSend(workspaceId);
        },
        onForeignTurnEnd: () => managerRef?.notifyForeignTurnEnd(),
        onForeignSessionId: (sessionId) => {
          // A CHANGED session id means the TUI conversation was reset (e.g.
          // /clear typed into the terminal) — the new conversation has never
          // seen the ambient rules or the full [active-work] block, so the
          // changed-only memory must forget or the reminder line would point
          // at a contract that no longer exists anywhere on screen. The first
          // announcement of a session is not a reset and keeps the memory.
          const prev = lastForeignSessionIds.get(workspaceId);
          lastForeignSessionIds.set(workspaceId, sessionId);
          if (prev !== undefined && prev !== sessionId) forgetAmbient(workspaceId);
          managerRef?.notifyForeignSessionId(sessionId);
        },
        ...(model ? { model } : {}),
        ...(fullPower ? { fullPower: true } : {}),
      }),
      sink: (event) => emit(workspaceId, event),
      startOptions: {
        // Bake the brain's REAL memory-folder paths into the write policy (M1b)
        // so it persists learnings to an absolute path, not a guessed one.
        systemPrompt: buildCommanderSystemPrompt(undefined, {
          memoryRoot: getMemoryRootDir(),
          workspaceId,
          // The terminal brain's generated profile hard-denies Write (an
          // interactive session has no canUseTool sandbox to route it
          // through), so it is told memory persistence is unavailable rather
          // than handed a write policy it can only fail at.
          memoryWrites: vendor !== 'claude-pty',
        }),
        ...(fleetContext ? { fleetContext } : {}),
        ...(persisted ? { resumeSessionId: persisted.sessionId } : {}),
      },
      onSessionId: (sessionId) => {
        // Fire-and-forget: a failed persist only costs continuity next run.
        void saveCommanderSession(sessionKey, sessionId).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[deck] failed to persist commander session id:', err);
        });
      },
      // Event-push: when this workspace's turn ends, wake the coalescer (on a
      // later tick — the manager defers) so any events buffered during the turn
      // flush into the next one.
      onIdle: () => coalescer?.notifyIdle(workspaceId),
    });
    managerRef = manager;
    managers.set(workspaceId, { manager, model, fullPower, vendor });
    return manager;
  };

  const readWorkspaceId = (req: Record<string, unknown>): string | null => {
    const raw = typeof req.workspaceId === 'string' ? req.workspaceId : '';
    return WORKSPACE_ID_RE.test(raw) ? raw : null;
  };

  // Loop engineering v1: when a workspace has a loop configured, EVERY brain
  // turn (human DECK_SEND, scheduled, event-woken — the latter two both route
  // through runTurnForWorkspace) carries the loop-state block so the brain
  // always knows its objective + checklist + recent progress. Prepending here
  // (main, per-send) rather than composePrompt is deliberate: composePrompt
  // injects on the FIRST turn only (ClaudeSdkAdapter `_contextInjected` guard),
  // which would go stale immediately. READ-ONLY context — the brain has no tool
  // to write `passes` and `done` does not suppress wakes in v1 (owner decision:
  // the human stops the loop).
  // Last ambient (autonomy+policy) text each workspace's TUI brain has already
  // been shown. Those blocks are re-read every turn so Settings/policy edits
  // apply immediately — but a VISIBLE terminal brain types its whole prompt on
  // screen, and re-sending an unchanged multi-KB block every turn drowns the
  // conversation. Keyed per workspace; cleared wherever the manager is retired
  // so a fresh conversation gets the blocks again. Headless brains (SDK/ACP)
  // keep the every-turn behavior — nothing is visible there and stale-block
  // risk beats noise.
  const shownAmbientBlocks = new Map<string, string>();
  // Ambient text a turn CARRIED but whose delivery is not yet proven. A first
  // turn that dies on Claude's own trust/sign-in dialog never showed the brain
  // anything, so marking at build time permanently skipped those blocks for the
  // retry. Promoted to `shown` only by a CLEAN turn (settleAmbient).
  const pendingAmbientBlocks = new Map<string, string>();
  // Same changed-only memory for the [active-work] block, for the same reason:
  // the full block (objective + every follow-up + every A2A row + the ownership
  // imperatives) re-typed on screen every wake was the largest recurring
  // injection in a supervision loop. An UNCHANGED block collapses to a one-line
  // reminder (renderActiveDeckWorkReminderLine) rather than to nothing — unlike
  // autonomy/policy, the ownership contract must stay in every turn's face.
  const shownActiveWorkBlocks = new Map<string, string>();
  const pendingActiveWorkBlocks = new Map<string, string>();
  // The last session id each workspace's TUI brain announced. A CHANGE means
  // the on-screen conversation was reset, which invalidates everything the
  // changed-only memory believes the brain has already seen.
  const lastForeignSessionIds = new Map<string, string>();
  /** Resolve the changed-only blocks this workspace's just-finished turn
   *  carried. `code:'errored'` covers both a thrown adapter and one that merely
   *  YIELDED an error event (the TUI-dialog case) — either way the brain did
   *  not see the blocks, so the next turn must re-send them. */
  const settleAmbient = (workspaceId: string, verdict: CommanderSendResult): void => {
    const delivered = verdict.ok && verdict.code !== 'errored';
    const pending = pendingAmbientBlocks.get(workspaceId);
    if (pending !== undefined) {
      pendingAmbientBlocks.delete(workspaceId);
      if (delivered) shownAmbientBlocks.set(workspaceId, pending);
    }
    const pendingWork = pendingActiveWorkBlocks.get(workspaceId);
    if (pendingWork !== undefined) {
      pendingActiveWorkBlocks.delete(workspaceId);
      if (delivered) shownActiveWorkBlocks.set(workspaceId, pendingWork);
    }
  };
  /** Drop the changed-only memory — a retired conversation must be told the
   *  rules (and the full active-work contract) again. */
  const forgetAmbient = (workspaceId: string): void => {
    shownAmbientBlocks.delete(workspaceId);
    pendingAmbientBlocks.delete(workspaceId);
    shownActiveWorkBlocks.delete(workspaceId);
    pendingActiveWorkBlocks.delete(workspaceId);
  };
  const withLoopContext = (workspaceId: string, text: string): string => {
    // Mode is read fresh here (not cached) so a Settings flip between turns
    // takes effect immediately — same rationale as the heartbeat's per-tick read.
    const mode = loadWorkspaceMode(workspaceId);
    const decision = loadWorkspaceDecision(workspaceId);
    const loop = loadWorkspaceLoopState(workspaceId);
    const activeWork = loadActiveDeckWork(workspaceId);
    const blocks: string[] = [];
    // The [autonomy] block LEADS — it frames how the brain should read everything
    // below it (whether it has authority to resolve the policy/decision itself).
    // `off` returns null (no ambient instructions for an off workspace).
    const ambient: string[] = [];
    const autonomy = renderAutonomyBlock(mode);
    if (autonomy) ambient.push(autonomy);
    // Binding operator policy next: the standing rules that let the brain resolve
    // a fork itself instead of escalating (and, in assist, guide what it
    // recommends). Injected for auto AND assist; never for off. Read fresh (the
    // operator can edit deck-policy.md between turns). Fail-open → no block.
    if (mode !== 'off') {
      const policy = loadDeckPolicyBlock();
      if (policy) ambient.push(policy);
    }
    // A visible TUI brain re-types its whole prompt on screen, so the ambient
    // (autonomy+policy) blocks go in only when their content CHANGED since the
    // last turn this conversation saw them. A Settings/policy edit therefore
    // still applies on the very next turn; unchanged rules stop drowning the
    // terminal. Headless brains keep the unconditional every-turn injection.
    const ambientText = ambient.join('\n\n');
    // Gate on what this workspace is RUNNING, not what was selected. A
    // `claude-pty` request that fell back to the SDK brain is headless, and
    // treating it as the visible TUI applies the changed-only rule to a brain
    // nothing is drowning — so an autonomy/policy edit would stop reaching it
    // after the first turn. Unknown workspace → the else branch, which injects
    // unconditionally: the safe direction.
    if (vendorForWorkspace(workspaceId) === 'claude-pty') {
      if (ambientText && shownAmbientBlocks.get(workspaceId) !== ambientText) {
        pendingAmbientBlocks.set(workspaceId, ambientText);
        blocks.push(ambientText);
      }
    } else if (ambientText) {
      blocks.push(ambientText);
    }
    // Then the decision block — a blocked (or just-resolved) decision is the most
    // urgent trusted context. Both decision + loop survive a reboot as atomic
    // JSON, so a resumed brain re-reads exactly where it paused.
    if (decision) blocks.push(renderDecisionBlock(decision));
    if (activeWork) {
      // Changed-only injection for the visible TUI brain, same vendor gate as
      // the ambient blocks above. An unchanged block collapses to a one-line
      // reminder instead of vanishing — the ownership contract must survive in
      // some form on every turn. PARKED records are exempt: parking changes
      // what the block means (a prohibition, not ownership), and the reminder
      // line speaks ownership language, so a parked record always goes in full.
      const workBlock = renderActiveDeckWorkBlock(activeWork);
      if (vendorForWorkspace(workspaceId) === 'claude-pty' && !isDeckWorkParked(activeWork)) {
        if (shownActiveWorkBlocks.get(workspaceId) === workBlock) {
          blocks.push(renderActiveDeckWorkReminderLine(activeWork));
        } else {
          pendingActiveWorkBlocks.set(workspaceId, workBlock);
          blocks.push(workBlock);
        }
      } else {
        blocks.push(workBlock);
      }
    }
    if (loop) blocks.push(renderLoopStateBlock(loop));
    if (blocks.length === 0) return text;
    return `${blocks.join('\n\n')}\n\n${text}`;
  };

  ipcMain.removeHandler(IPC.DECK_SEND);
  ipcMain.handle(
    IPC.DECK_SEND,
    wrapHandler(IPC.DECK_SEND, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<CommanderSendResult> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const text = typeof req.text === 'string' ? req.text : '';
      if (!text.trim()) return { ok: false, code: 'empty' };
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false, code: 'invalid_workspace' };
      // Mode `off`: no brain, so nothing to send to. The composer is disabled
      // in that state, so this is the race/stale-renderer path.
      const refusal = refuseWhenModeOff(workspaceId);
      if (refusal) return refusal;
      let fleetContext = typeof req.fleetContext === 'string' ? req.fleetContext : undefined;
      if (fleetContext && fleetContext.length > FLEET_CONTEXT_MAX_CHARS) {
        fleetContext = fleetContext.slice(0, FLEET_CONTEXT_MAX_CHARS) + '\n…(truncated)';
      }
      // A send may still carry the model (the composer rides it along), but it
      // is no longer the only way main learns it — fall back to the synced
      // authority so a payload that omits it does not silently reset the brain
      // to the vendor default.
      const model = sanitizeModel(req.model) || brainModel;
      const mgr = ensureManager(workspaceId, fleetContext, model);
      // Human input resets this workspace's auto-wake budget and subsumes any
      // buffered push events (the human's own turn re-observes live state) —
      // but ONLY when the send will actually be accepted. A busy reject (e.g.
      // racing an in-flight auto-wake turn) must not consume buffered events:
      // that stop may be the very completion the loop is waiting on, and
      // subsuming it on a turn that never ran would silently stall the loop
      // (dogfood finding, 2026-07-12). Status check + send are one synchronous
      // sequence, so nothing can interleave (same basis as runTurnForWorkspace).
      if (mgr.getStatus().status === 'idle') {
        beginTrackedWork(workspaceId, text);
        coalescer?.notifyHumanSend(workspaceId);
      }
      // Awaits the full turn (events stream over DECK_STREAM meanwhile); the
      // resolved value is only the accept/reject verdict. The loop + decision
      // blocks ride in front of the typed text — invisible to the renderer's
      // optimistic user bubble, visible to the brain. If this human turn carried
      // a resolved decision's block, consume it (id-scoped) so it never re-injects.
      const injectedDecision = loadWorkspaceDecision(workspaceId);
      // A human at the composer: no double-check delay — they are waiting on it,
      // and a turn they typed themselves cannot be racing their own TUI input.
      const verdict = await mgr.send(withLoopContext(workspaceId, text), { origin: 'human' });
      settleAmbient(workspaceId, verdict);
      if (verdict.ok && injectedDecision?.status === 'resolved') {
        void clearResolvedDecision(workspaceId, injectedDecision.id).catch(() => {});
      }
      return verdict;
    }),
  );

  ipcMain.removeHandler(IPC.DECK_INTERRUPT);
  ipcMain.handle(
    IPC.DECK_INTERRUPT,
    wrapHandler(IPC.DECK_INTERRUPT, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: true }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (workspaceId) managers.get(workspaceId)?.manager.interrupt();
      return { ok: true };
    }),
  );

  // The operator's `/clear`: dispose the live brain (interrupt + retire) and
  // drop the persisted session id so the next turn on ANY path (typed, event
  // wake, schedule) starts a fresh SDK conversation. The channel transcript
  // stays — history is the audit trail; only the brain's context resets. The
  // vendor-composite session key mirrors ensureManager exactly.
  ipcMain.removeHandler(IPC.DECK_CONVERSATION_CLEAR);
  ipcMain.handle(
    IPC.DECK_CONVERSATION_CLEAR,
    wrapHandler(IPC.DECK_CONVERSATION_CLEAR, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean; code?: string }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false, code: 'invalid_workspace' };
      const entry = managers.get(workspaceId);
      if (entry) {
        entry.manager.dispose(); // interrupts an in-flight turn, flips to disposed
        retireManager(workspaceId);
        forgetAmbient(workspaceId);
      }
      // The vendor this workspace actually RAN as, not the one selected: a
      // `claude-pty` request that fell back to the SDK brain persisted under
      // the bare workspaceId, so keying the clear off the selection would
      // target `${workspaceId}::claude-pty` — a key nothing ever wrote. The
      // clear would no-op and the conversation would survive its own reset.
      // `entry` is captured above, so this still reads the retired manager.
      const sessionKey = sessionKeyFor(workspaceId, entry?.vendor ?? resolveEffectiveVendor(brainVendor));
      await clearCommanderSession(sessionKey);
      try {
        // Unconditional by contract — "New session" is the escape hatch for a
        // wedged record and must never start refusing (deck_complete_work is
        // the path that CAN refuse, on a2a_tasks_outstanding). But the clear is
        // no longer blind: whatever it removed comes back, so delegated tasks
        // that outlive the record are put in front of the human instead of
        // being dropped with it.
        const removed = clearActiveDeckWork(workspaceId);
        if (removed) surfaceStrandedWork(workspaceId, removed, 'cleared');
      } catch {
        // Conversation clear is still successful if the auxiliary work record
        // could not be removed; the next prompt can supersede/reconcile it.
      }
      return { ok: true };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_STATUS);
  ipcMain.handle(
    IPC.DECK_STATUS,
    wrapHandler(IPC.DECK_STATUS, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<CommanderStatusSnapshot> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      const mgr = workspaceId ? managers.get(workspaceId)?.manager : undefined;
      return mgr?.getStatus() ?? { status: 'idle', sessionId: null };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_FULLPOWER_SET);
  ipcMain.handle(
    IPC.DECK_FULLPOWER_SET,
    wrapHandler(IPC.DECK_FULLPOWER_SET, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: true; enabled: boolean }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      // Fail closed: only a strict boolean true enables full power.
      const enabled = req.enabled === true;
      if (enabled !== fullPowerEnabled) {
        fullPowerEnabled = enabled;
        // Retire IDLE managers on the stale mode now, so the next turn on any
        // path (typed, scheduled, event-woken) spawns on the new mode — the
        // OFF direction especially must not keep running hooks. Busy managers
        // finish their in-flight turn; ensureManager swaps them on their next
        // turn (same never-swap-mid-turn rule as the model override).
        for (const [workspaceId, entry] of [...managers]) {
          if (entry.fullPower !== enabled && entry.manager.getStatus().status !== 'busy') {
            entry.manager.dispose();
            retireManager(workspaceId);
            forgetAmbient(workspaceId);
          }
        }
      }
      return { ok: true, enabled };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_MODEL_SET);
  ipcMain.handle(
    IPC.DECK_MODEL_SET,
    wrapHandler(IPC.DECK_MODEL_SET, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: true; model: string }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const model = sanitizeModel(req.model);
      if (model !== brainModel) {
        brainModel = model;
        // Retire IDLE managers on the stale model so the next turn on ANY path
        // spawns on the new one. Busy managers finish their in-flight turn and
        // ensureManager swaps them on their next (never-swap-mid-turn). Gated
        // on the vendors the model actually reaches — an ACP brain ignores it,
        // and respawning one would cost a conversation for nothing.
        for (const [workspaceId, entry] of [...managers]) {
          const modelApplies = entry.vendor === 'claude' || entry.vendor === 'claude-pty';
          if (
            modelApplies &&
            entry.model !== model &&
            entry.manager.getStatus().status !== 'busy'
          ) {
            entry.manager.dispose();
            retireManager(workspaceId);
            forgetAmbient(workspaceId);
            // A retired terminal brain takes its embedded pty with it.
            emitBrainPty(workspaceId, null);
          }
        }
      }
      return { ok: true, model };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_BRAIN_VENDOR_SET);
  ipcMain.handle(
    IPC.DECK_BRAIN_VENDOR_SET,
    wrapHandler(IPC.DECK_BRAIN_VENDOR_SET, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: true; vendor: BrainVendor }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      // Fail closed to the default: only known vendor ids are accepted. The
      // default is the terminal brain, matching every other default site
      // (uiSlice, loadSession, brainVendor above) — coercing to 'claude' here
      // would split main and the store onto different vendors, and with them
      // onto different commander session keys, for the same bad input.
      const vendor: BrainVendor =
        req.vendor === 'claude' || req.vendor === 'hermes' || req.vendor === 'claude-pty'
          ? req.vendor
          : 'claude-pty';
      if (vendor !== brainVendor) {
        brainVendor = vendor;
        // Retire IDLE stale-vendor brains now (same contract as full power):
        // the next turn on ANY path spawns on the new vendor; busy managers
        // finish their in-flight turn and swap on their next one.
        for (const [workspaceId, entry] of [...managers]) {
          if (entry.vendor !== vendor && entry.manager.getStatus().status !== 'busy') {
            entry.manager.dispose();
            retireManager(workspaceId);
            forgetAmbient(workspaceId);
            // The retired brain's embedded terminal is gone with it — retract
            // the pty id so the deck falls back to the bubble view instead of
            // showing a dead terminal.
            emitBrainPty(workspaceId, null);
          }
        }
      }
      return { ok: true, vendor };
    }),
  );

  // Fire ONE main-originated brain turn on a workspace's orchestrator. Shared
  // by the P3d scheduler AND the event-push coalescer — both need the identical
  // "announce-then-send, skip-if-busy" sequence. A main-originated turn has no
  // renderer-side optimistic message, so the stream would hit a thread with no
  // open turn and be dropped: announce `turn-start` first — but ONLY when the
  // manager will actually accept it (a busy reject must not open a phantom
  // stuck-streaming bubble). The status check and send are one synchronous
  // sequence, so nothing can interleave between them.
  const runTurnForWorkspace = async (
    prompt: string,
    workspaceId: string,
    runOpts: {
      queued?: boolean;
      // WP3 re-examine: a heartbeat-fired wake that BYPASSES the pending-decision
      // block. The wire prompt carries the STALE decision block (not the normal
      // "BLOCKED — wait" pending block withLoopContext would prepend), so the
      // brain re-examines and — in auto mode — may self-resolve. Present only on
      // that one narrow path; every other caller leaves it undefined and gets
      // the unchanged withLoopContext prompt.
      // Only the EXPECTED decision id is captured at fire time; mode, TTL and
      // staleness are re-validated FRESH after the (possibly long) queued gate
      // wait — a workspace flipped to `off`, a replaced decision, or a decision
      // that is no longer stale/pending ABORTS the re-examine instead of running
      // a stale turn (3-way review P1: the off kill switch must hold across the
      // gate wait, and a replaced decision must not inherit the old re-examine).
      reExamine?: { expectedId: string };
    } = {},
  ): Promise<{ ok: boolean; code?: string }> => {
    if (!WORKSPACE_ID_RE.test(workspaceId)) {
      return { ok: false, code: 'invalid_workspace' as const };
    }
    // Mode `off` = the brain does not run. Checked before the busy check and
    // before the fleet-slot acquire so an off workspace never spawns a brain,
    // never consumes a slot, and never waits on the queued gate. Every ambient
    // driver (heartbeat, loop, scheduler, decision resume, startup reconcile)
    // routes through here, so this one line is the whole kill switch for them.
    const modeRefusal = refuseWhenModeOff(workspaceId);
    if (modeRefusal) return modeRefusal;
    // Per-workspace busy check BEFORE the fleet-slot acquire (3-way review P3):
    // a workspace already running a turn must not momentarily consume — or, for
    // the queued path, sit and WAIT on — one of the scarce global slots. ensureManager
    // still runs first (unchanged lazy-creation semantics), we just don't hold the
    // gate across the check. Scheduled/event-woken turns take the model from the
    // main-side authority, exactly like full power and the vendor — reusing the
    // live manager's cached model instead meant an autonomous turn could pin a
    // brain to '' (the vendor default) and the operator's picker never applied
    // to a workspace nothing had been typed into.
    const preMgr = ensureManager(workspaceId, undefined, brainModel);
    if (preMgr.getStatus().status !== 'idle') {
      return { ok: false, code: 'busy' as const };
    }
    // Fleet-wide concurrency gate (autonomous path only). One-shot callers (loop
    // kickoff, decision resume, startup reconcile) AWAIT a slot so their turn is
    // not silently dropped on a transient full gate with no event to retry it;
    // coalescer/scheduler take the fast reject-and-requeue path. The slot is held
    // for the WHOLE turn — release in the finally once mgr.send has settled — so
    // N concurrent turns never exceed the cap even while their streams are open.
    const token = runOpts.queued
      ? await globalTurnGate.acquireWhenAvailable(QUEUED_ACQUIRE_TIMEOUT_MS, workspaceId)
      : globalTurnGate.tryAcquire(workspaceId);
    if (!token) {
      return { ok: false, code: 'busy' as const };
    }
    try {
      // The queued path awaited (up to 120s) for the slot — re-resolve the manager
      // and re-check idle now that we hold it: a human/scheduled turn (or a
      // settings-driven manager swap) could have started/retired this workspace's
      // brain during the wait. From here the status check and send are one
      // synchronous sequence (nothing awaits between them).
      const mgr = ensureManager(workspaceId, undefined, brainModel);
      if (mgr.getStatus().status !== 'idle') {
        return { ok: false, code: 'busy' as const };
      }
      // Build the wire prompt (prepends any pending/resolved [decision] block and
      // the loop block) BEFORE the send.
      // turn-start announces the ORIGINAL prompt (what the human should see as
      // the turn's cause); the context blocks ride only on the wire to the brain,
      // mirroring the DECK_SEND path.
      // Capture the decision THIS turn will inject (withLoopContext reads the same
      // on-disk state synchronously right below) so at turn end we consume ONLY a
      // resolution this turn actually carried — never one RAISED mid-turn, whose
      // prompt this turn was built before (that would silently drop the human's
      // answer and unblock the loop — 3-way review P1).
      const injected = loadWorkspaceDecision(workspaceId);
      // WP3 re-examine builds a DIFFERENT wire prompt: the STALE decision block
      // (re-examine / auto-may-self-resolve) instead of withLoopContext's normal
      // "BLOCKED — wait" pending block. Everything is RE-VALIDATED fresh here —
      // after the queued gate wait — and the turn is ABORTED (not run through the
      // normal path) when the re-examine no longer applies: mode flipped to off
      // (kill switch), the decision was resolved/cleared/replaced (id mismatch),
      // or it is no longer stale under the CURRENT TTL. Running the fallback
      // prompt instead would waste a turn telling a blocked brain to wait.
      let prompted: string;
      if (runOpts.reExamine) {
        const mode = loadWorkspaceMode(workspaceId);
        const ttlMs = loadDeckHeartbeat().decisionTtlMs;
        // The global auto-wake switch is re-checked here too (round-4 review
        // P1): the heartbeat checked it at fire time, but the queued gate wait
        // above can span minutes — an operator who flipped Auto-wake off during
        // the wait must not get an ambient turn.
        const valid =
          loadAutoWakeEnabled() &&
          mode !== 'off' &&
          injected?.status === 'pending' &&
          injected.id === runOpts.reExamine.expectedId &&
          isDecisionStale(injected, ttlMs);
        if (!valid) {
          return { ok: false, code: 'reexamine_invalidated' as const };
        }
        // TURN LEASE (round-5 review P1): deck_resolve_decision is refused
        // server-side unless THIS re-examine turn for THIS decision is live.
        // Granted here (post-validation, pre-send), revoked in the outer
        // finally — success, error, or abort all die with the turn.
        grantReExamineLease(workspaceId, injected.id);
        const ttlMinutes = Math.max(1, Math.round(ttlMs / 60_000));
        // Same leading context as a normal turn (3-way review P2: the stale block
        // tells the brain to cite a binding policy rule — that rule must be IN
        // this turn): [autonomy] → [policy] → stale [decision] → loop → prompt.
        const blocks: string[] = [];
        const autonomy = renderAutonomyBlock(mode);
        if (autonomy) blocks.push(autonomy);
        const policy = loadDeckPolicyBlock();
        if (policy) blocks.push(policy);
        blocks.push(renderStaleDecisionBlock(injected, { ttlMinutes, mode }));
        const activeWork = loadActiveDeckWork(workspaceId);
        if (activeWork) blocks.push(renderActiveDeckWorkBlock(activeWork));
        const loop = loadWorkspaceLoopState(workspaceId);
        if (loop) blocks.push(renderLoopStateBlock(loop));
        prompted = `${blocks.join('\n\n')}\n\n${prompt}`;
      } else {
        prompted = withLoopContext(workspaceId, prompt);
      }
      emit(workspaceId, { type: 'turn-start', prompt });
      // Every caller of runTurnForWorkspace is an ambient driver (heartbeat,
      // loop, scheduler, decision resume, startup reconcile) — never a human at
      // the composer. Marking the origin lets the terminal brain re-check for a
      // human turn it may have raced before it types into the shared TUI.
      const verdict = await mgr.send(prompted, { origin: 'automation' });
      settleAmbient(workspaceId, verdict);
      if (verdict.ok) {
        if (runOpts.reExamine) {
          // The brain may have self-resolved its OWN decision during this
          // re-examine turn (deck_resolve_decision). It is already awake and has
          // acted on it in-turn, so there is no separate resume to kick (a kick
          // would just busy-reject against this very turn); we only CONSUME the
          // now-resolved record so it doesn't linger and re-inject. Scope the
          // consume to the id this turn actually re-examined AND to the BRAIN's
          // own resolution (resolvedBy === 'brain'). If the HUMAN resolved it
          // while this turn was running, their answer was never in this turn's
          // prompt — consuming it here would silently discard it (3-way review
          // round 2 P1). A human resolution is left on disk so the next natural
          // wake / startup reconcile carries it into a resume turn.
          const after = loadWorkspaceDecision(workspaceId);
          if (
            after?.status === 'resolved' &&
            after.resolvedBy === 'brain' &&
            injected &&
            after.id === injected.id &&
            // Round-4 review P1: send() reports ok:true even when the adapter
            // errored mid-turn (code:'errored'). A self-resolution from a turn
            // that DIED may never have been acted on — keep the durable record
            // so the self-resume path (honest '(self)' provenance) replays it,
            // instead of deleting the only evidence it existed.
            verdict.code !== 'errored'
          ) {
            void clearResolvedDecision(workspaceId, after.id).catch(() => {});
          } else if (after?.status === 'resolved' && injected && after.id === injected.id) {
            // Two ways to land here, both needing a follow-up resume turn:
            //  - the HUMAN answered while this re-examine turn was running
            //    (their resolve kick busy-rejected against this very turn, and
            //    this turn's prompt never carried their answer — round-3 P2), or
            //  - the BRAIN self-resolved but the turn then ERRORED before acting
            //    (round-4 P1: the record was deliberately NOT consumed above).
            // resumePromptFor() picks the honest prompt for each provenance.
            // Deferred a tick so the manager has fully settled to idle before
            // the busy precheck.
            const resumeFor = after;
            setImmediate(() => {
              void runTurnForWorkspace(resumePromptFor(resumeFor), workspaceId, {
                queued: true,
              }).catch(() => {
                /* best-effort — the durable resolved record rides the next turn */
              });
            });
          }
        } else if (injected?.status === 'resolved' && verdict.code !== 'errored') {
          // Same errored guard as the re-examine consume (final review round):
          // a resume turn that DIED mid-stream (code:'errored') may never have
          // acted on the resolution its prompt carried — keep the durable
          // record so the next natural wake / startup reconcile resumes it
          // again, instead of deleting the answer unacted-on.
          void clearResolvedDecision(workspaceId, injected.id).catch(() => {});
        }
      }
      return verdict;
    } finally {
      // The re-examine self-resolve lease dies with the turn, no matter how it
      // ended (round-5 review P1) — revoke BEFORE the slot release so no other
      // turn can observe a stale lease.
      if (runOpts.reExamine) revokeReExamineLease(workspaceId);
      // Release the slot once the turn has fully settled (send resolved/rejected)
      // — never on the synchronous path only, or a long turn would free its slot
      // early and let the cap be exceeded. Release is by token: a slot already
      // reclaimed by lease (a wedged turn) makes this a safe no-op.
      globalTurnGate.release(token);
    }
  };

  // The dock's Wake button (the pty layout has no composer, so this is the
  // human's one-click "take a turn now"). The prompt is deliberately open-ended
  // — the human gave no instruction, they asked the orchestrator to look around.
  const WAKE_BUTTON_PROMPT =
    'The operator pressed the Wake button. Review the current state of your fleet ' +
    'and any pending work or reports, act on anything that needs you (within your ' +
    'autonomy caps), and report briefly — or say all is quiet. Then end your turn.';

  ipcMain.removeHandler(IPC.DECK_WAKE);
  ipcMain.handle(
    IPC.DECK_WAKE,
    wrapHandler(IPC.DECK_WAKE, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean; code?: string }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false, code: 'invalid_workspace' };
      // A pressed Wake button is a human acting: the turn it kicks must meet
      // an ARMED stop gate, whatever state a cap-out went quiet on (rule 5).
      clearGateCapOut(workspaceId);
      // Non-queued on purpose: a button press wants an immediate verdict — a
      // busy reject (this workspace mid-turn, or the fleet gate full) returns
      // right away and the human just presses again later. runTurnForWorkspace
      // announces turn-start and prepends the loop/decision context, so the
      // wake renders in the thread exactly like a scheduled run.
      return runTurnForWorkspace(WAKE_BUTTON_PROMPT, workspaceId);
    }),
  );

  // The first turn a freshly started/resumed loop takes. Without this, START
  // only writes loop-state + caps and RETURNS — the loop sits at status=running
  // waiting for the next pane event or cadence tick, which (with the default
  // "Events only" cadence and no active pane) may be far away or never come.
  // The whole thing reads as "I started a loop and the orchestrator did
  // nothing" (owner dogfood 2026-07-14). Kicking one turn now gets the loop
  // DOING something immediately; its own action then produces the pane events
  // that keep the loop iterating. Neutral across tiers — report-only assesses
  // and reports, continue drives the first pane action.
  const LOOP_KICKOFF_PROMPT =
    'The loop above has just started. Take the first iteration NOW: assess the ' +
    'current state of the relevant panes against the objective, then — if your ' +
    'autonomy caps allow — drive the first concrete action (e.g. terminal_send the ' +
    'next instruction to a pane). Say what you did and what you are waiting on. ' +
    'Activity from your action will wake you to continue the next iteration.';

  // Fire the kickoff turn — fire-and-forget on purpose: START/RESUME must
  // return their verdict immediately (the loop modal awaits it), and a busy
  // reject (a turn already streaming) is fine — the loop's event/cadence
  // drivers take over. runTurnForWorkspace prepends the loop-state block and
  // emits turn-start, so the kick renders in the thread like a scheduled run.
  const kickLoop = (workspaceId: string): void => {
    // Queued acquire (3-way review P1): a loop start/resume is a ONE-SHOT caller
    // — nothing requeues it. On a transient full gate it must AWAIT a slot, not
    // reject and leave the loop sitting idle until an unrelated event happens to
    // wake it. A busy reject (this workspace already streaming) is still fine —
    // the drivers take over.
    void runTurnForWorkspace(LOOP_KICKOFF_PROMPT, workspaceId, { queued: true }).catch(() => {
      /* best-effort — a rejected kick just means the drivers take over */
    });
  };

  // ── Event-push: EventBus → coalescer → orchestrator wake-turn ─────────────
  // The main-process EventBus already carries agent.stop / agent.awaiting_input
  // (hook + detector sourced). Subscribe, coalesce per workspace, and wake the
  // owning orchestrator so it observes fleet lifecycle changes WITHOUT polling.
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
  });
  coalescer = new CommanderEventCoalescer({
    runTurn: (workspaceId, prompt) => runTurnForWorkspace(prompt, workspaceId),
    // Lane F: worker events parked while this workspace had no brain.
    takeOrphanBacklog: (workspaceId) => takeOrphanBacklog(workspaceId),
    isBusy: (workspaceId) =>
      managers.get(workspaceId)?.manager.getStatus().status === 'busy',
    // Fail-closed autonomy caps (summarize on, dangerous caps off by default).
    getAutonomy: (workspaceId) => loadWorkspaceAutonomy(workspaceId),
    // Loop hint: a RUNNING loop's iteration budget replaces the ambient
    // wake budget and flips the wake prompt to loop-runner framing.
    getLoop: (workspaceId) => {
      const loop = loadWorkspaceLoopState(workspaceId);
      return loop ? { running: loop.status === 'running', iterations: loop.iterations } : null;
    },
    // A direct human request is a request-scoped opt-in to follow through even
    // when the workspace's resting mode is off. The coalescer grants only
    // follow-up instructions; approvalPress still comes from the standing mode.
    // LIVE only (#733): a parked record must not raise the wake policy to 'all'
    // or lift the wake budget. At boot the daemon recovers sessions and the
    // recovered panes emit stop/awaiting-input edges immediately; with the
    // parked record counted as work-active, those echoes alone were enough to
    // drive the fleet with nobody having asked for anything this launch.
    getActiveWork: (workspaceId) => loadLiveDeckWork(workspaceId),
    // Global kill switch (Settings): OFF drops ambient wakes; running loops
    // still wake. Read fresh at every flush so the toggle applies immediately.
    isAutoWakeEnabled: () => loadAutoWakeEnabled(),
    // A PENDING decision gate blocks every wake for this workspace (even a
    // running loop) until the human resolves it. Read fresh at each flush.
    hasPendingDecision: (workspaceId) => hasPendingDecision(workspaceId),
    // maxWakesPerMin: left to the coalescer's built-in default (6 accepted wakes
    // per 60s window) — the single unconditional rate ceiling. No store knob
    // yet, so nothing to thread here.
    // One-line fleet summary appended to an edge-wake prompt: counts the mirror's
    // attention panes so the brain sees the wider fleet without a poll. undefined
    // (no line) when the mirror is empty or the fleet is all quiescent.
    getFleetTail: (workspaceId) =>
      buildFleetTailLine(getWorkspaceMirror().getFleetSnapshot(workspaceId)),
  });
  const offBus = eventBus.subscribe((ev) => {
    // Cross-workspace task receipts belong to the SENDER commander. The base
    // workspaceId is server-stamped === from, but use `from` explicitly so a
    // future event-shape change cannot wake the receiver or a third workspace.
    if (ev.type === 'a2a.task') {
      try {
        recordDeckWorkA2aTask(ev.from, {
          taskId: ev.taskId,
          to: ev.to,
          state: ev.state,
          ts: ev.ts,
          ...(ev.verifiedItemCount !== undefined
            ? { verifiedItemCount: ev.verifiedItemCount }
            : {}),
        });
      } catch (err) {
        // The durable A2A task remains canonical; losing the projection must not
        // break EventBus delivery or strand other subscribers.
        // eslint-disable-next-line no-console
        console.warn('[deck] failed to project A2A task into active work:', err);
      }
      // submitted/working are tracked but not wake-worthy: the originating
      // commander waits for a terminal or blocked transition instead of polling.
      if (
        ev.state !== 'completed' &&
        ev.state !== 'failed' &&
        ev.state !== 'input-required' &&
        ev.state !== 'canceled'
      ) return;
      const kind =
        ev.state === 'completed' ? 'a2a.completed' as const
        : ev.state === 'failed' ? 'a2a.failed' as const
        : ev.state === 'input-required' ? 'a2a.input_required' as const
        : 'a2a.canceled' as const;
      coalescer?.push({
        workspaceId: ev.from,
        ptyId: `a2a:${ev.taskId}`,
        kind,
        source: 'a2a',
        agent: null,
        seq: ev.seq,
        ts: ev.ts,
        a2a: {
          taskId: ev.taskId,
          from: ev.from,
          to: ev.to,
          state: ev.state,
          ...(ev.verifiedItemCount !== undefined
            ? { verifiedItemCount: ev.verifiedItemCount }
            : {}),
        },
      });
      return;
    }
    // AO-style CI feedback (owner decision 2026-07-18): a pane's PR went red.
    // Route it into the SAME coalescer as lifecycle events so it inherits the
    // mode/budget/decision-gate policy — auto drives a fix, assist reports, off
    // stays silent. The PR pointer rides through as `detail`.
    if (ev.type === 'pr.ci') {
      coalescer?.push({
        workspaceId: ev.workspaceId,
        ptyId: ev.ptyId,
        kind: 'pr.ci_failed',
        source: 'pr',
        agent: null,
        seq: ev.seq,
        ts: ev.ts,
        detail: { prNumber: ev.prNumber, url: ev.url },
      });
      return;
    }
    // Slice 3: the pane's PR went CONFLICTING — same coalescer, same policy.
    if (ev.type === 'pr.conflict') {
      coalescer?.push({
        workspaceId: ev.workspaceId,
        ptyId: ev.ptyId,
        kind: 'pr.merge_conflict',
        source: 'pr',
        agent: null,
        seq: ev.seq,
        ts: ev.ts,
        detail: { prNumber: ev.prNumber, url: ev.url },
      });
      return;
    }
    // Slice 2: fresh review feedback on a pane's PR — same coalescer, same
    // policy inheritance, review context riding through as detail.
    if (ev.type === 'pr.review') {
      coalescer?.push({
        workspaceId: ev.workspaceId,
        ptyId: ev.ptyId,
        kind: 'pr.review_comment',
        source: 'pr',
        agent: null,
        seq: ev.seq,
        ts: ev.ts,
        detail: {
          prNumber: ev.prNumber,
          url: ev.url,
          count: ev.count,
          author: ev.author,
          snippet: ev.snippet,
        },
      });
      return;
    }
    if (ev.type !== 'agent.lifecycle') return;
    if (ev.kind !== 'agent.stop' && ev.kind !== 'agent.awaiting_input') return;
    // 'internal' traces are turn-end candidates the CompletionAlarm REJECTED
    // (subagent stop, leftover background work, rebutted provisional window).
    // Waking the deck brain on one would announce work that never ended —
    // same class of false "finished" the alarm exists to suppress.
    if (ev.decision === 'internal') return;
    const lifecycleInput = {
      workspaceId: ev.workspaceId,
      ptyId: ev.ptyId,
      kind: ev.kind,
      source: ev.source,
      agent: ev.agent,
      seq: ev.seq,
      ts: ev.ts,
      // Carries the pane's closing words on a hook-sourced stop so the wake
      // prompt can say whether the pane is blocked on a question.
      ...(ev.lastMessage ? { lastMessage: ev.lastMessage } : {}),
    };
    coalescer?.push(lifecycleInput);
    // Lane F: a fan-out task workspace has no brain of its own, so ALSO copy
    // the event to the owning (parent) workspace's coalescer, tagged with the
    // task. The parent's 'none' wake policy lets tagged events through; an
    // owner with no brain gets it parked in the ledger as an orphan backlog.
    routeWorkerEventToOwner(lifecycleInput, {
      hasBrain: (owner) => managers.has(owner) || loadWorkspaceMode(owner) !== 'off',
      push: (copy) => coalescer?.push(copy),
      reconcile: reconcileTaskLedger,
    });
  });

  // ── P3d: orchestrator schedules ─────────────────────────────────────────
  // The tick loop fires due schedules as ordinary brain turns on their OWN
  // workspace's orchestrator (streamed over DECK_STREAM like any typed
  // command). A scheduled turn reuses that workspace's live manager — and its
  // model — or lazily creates one exactly like deck:send.
  const scheduler = new DeckScheduler({
    runTurn: runTurnForWorkspace,
    // A pending decision gate blocks scheduled wakes too (the schedule stays
    // due and retries once resolved).
    hasPendingDecision: (workspaceId) => hasPendingDecision(workspaceId),
  });
  scheduler.start();

  // ── WP4: level-review heartbeat ───────────────────────────────────────────
  // A slow cadence re-reads each armed workspace's CURRENT per-pane state (from
  // the renderer mirror) and hands it to the coalescer's flushSnapshot, which
  // re-runs the full gate stack — the missed-judgment safety net for a pane
  // whose edge event was dropped. Reviewed workspaces are those with a live
  // manager OR a resting mode other than 'off'; the coalescer's own gates decide
  // whether a wake actually fires (the tick conditions only skip obvious no-ops).
  const heartbeatWorkspaceIds = (): string[] => {
    const ids = new Set<string>(managers.keys());
    // Durable direct requests arm the heartbeat even when the workspace's
    // resting autonomy mode is off and no brain manager has been recreated yet.
    // LIVE records only (#733): that bypass exists for a request the human is
    // engaged with right now. A record that merely survived a shutdown must not
    // arm a workspace nobody has spoken to since launch — that turns the
    // safety-net heartbeat into an unattended driver.
    for (const workspaceId of Object.keys(loadLiveDeckWorks())) ids.add(workspaceId);
    // A workspace can be armed (autonomy on) before its brain has ever spawned a
    // manager — include every mirrored workspace whose resting mode isn't 'off'.
    const entries = getWorkspaceMirror().getEntries();
    if (entries) {
      for (const e of entries) {
        if (WORKSPACE_ID_RE.test(e.id) && loadWorkspaceMode(e.id) !== 'off') ids.add(e.id);
      }
    }
    return [...ids];
  };
  // WP3 — the instruction the re-examine wake carries as its ORIGINAL prompt (the
  // stale [decision] block is prepended on the wire by runTurnForWorkspace). Kept
  // short: the stale block already states the re-examine / self-resolve rules.
  const DECISION_REEXAMINE_PROMPT =
    'A decision you raised has been pending too long with no human answer (see the STALE ' +
    '[decision] block above). Re-examine it now per that block, then end your turn.';
  const heartbeatConfig = loadDeckHeartbeat();
  const heartbeat = new DeckHeartbeat({
    getWorkspaceIds: heartbeatWorkspaceIds,
    getAutonomy: (workspaceId) => loadWorkspaceAutonomy(workspaceId),
    isBusy: (workspaceId) =>
      managers.get(workspaceId)?.manager.getStatus().status === 'busy',
    hasPendingDecision: (workspaceId) => hasPendingDecision(workspaceId),
    getFleetSnapshot: (workspaceId) => getWorkspaceMirror().getFleetSnapshot(workspaceId),
    flushSnapshot: (workspaceId, snapshot) => coalescer?.flushSnapshot(workspaceId, snapshot),
    lastWakeAt: (workspaceId) => coalescer?.lastWakeAt(workspaceId) ?? null,
    // WP3: the current decision + TTL let the heartbeat detect a STALE pending
    // decision and fire a bounded re-examine wake that bypasses the wake block.
    getDecision: (workspaceId) => loadWorkspaceDecision(workspaceId),
    decisionTtlMs: heartbeatConfig.decisionTtlMs,
    reExamineDecision: (workspaceId, decision) => {
      // AMBIENT-WAKE CONTROLS (3-way review round 2 P1): this path bypasses
      // ONLY the pending-decision gate — that is the feature. The other
      // ambient controls still apply: the global auto-wake switch (off ⇒ no
      // ambient wakes of any kind) and the coalescer's consecutive-wake
      // budget. The rate ceiling is inherently respected — the heartbeat
      // debounces re-pings to once per TTL (≥ 5 min), far under any per-minute
      // cap.
      if (!loadAutoWakeEnabled()) return;
      if ((coalescer?.getWakeBudgetRemaining(workspaceId) ?? 0) <= 0) return;
      // Capture ONLY the decision id. Mode/TTL/staleness are re-validated
      // FRESH inside runTurnForWorkspace after the queued gate wait, so an
      // off-flip or a replaced decision aborts instead of running stale
      // (3-way review P1).
      void runTurnForWorkspace(DECISION_REEXAMINE_PROMPT, workspaceId, {
        queued: true,
        reExamine: { expectedId: decision.id },
      })
        .then((r) => {
          // Round-3 review P2: an ACCEPTED re-examine consumes the consecutive-
          // wake budget and counts against the rate ceiling like any other
          // ambient wake — an unresolved decision cannot fund an unbounded
          // stream of re-examines. Rejected/aborted turns cost nothing.
          if (r.ok) coalescer?.noteExternalWake(workspaceId);
        })
        .catch(() => {
          /* best-effort — a rejected re-examine just retries after the next TTL */
        });
    },
    // Read the on/off switch fresh each tick so a Settings toggle applies without
    // a restart; the cadence is fixed at construction (a rare change, restart-ok).
    isEnabled: () => loadDeckHeartbeat().enabled,
    intervalMs: heartbeatConfig.intervalMs,
  });
  heartbeat.start();

  // Seed the binding operator-policy file once (never overwrites an existing
  // one). Fire-and-forget: a missing policy file just means no policy block, so
  // a failure here is harmless. Done at init so the file exists for the operator
  // to edit before their first autonomous turn.
  try {
    ensureDeckPolicySeed();
  } catch {
    /* best-effort — deckPolicy already swallows its own IO errors */
  }

  ipcMain.removeHandler(IPC.DECK_SCHEDULES_LIST);
  ipcMain.handle(
    IPC.DECK_SCHEDULES_LIST,
    wrapHandler(IPC.DECK_SCHEDULES_LIST, async (): Promise<{ schedules: DeckSchedule[] }> => {
      return { schedules: loadDeckSchedules() };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_SCHEDULES_CREATE);
  ipcMain.handle(
    IPC.DECK_SCHEDULES_CREATE,
    wrapHandler(IPC.DECK_SCHEDULES_CREATE, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean; schedule?: DeckSchedule; code?: string }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false, code: 'invalid_workspace' };
      const schedules = loadDeckSchedules();
      if (schedules.length >= DECK_SCHEDULE_LIMITS.MAX_SCHEDULES) {
        return { ok: false, code: 'limit' };
      }
      const schedule = createSchedule({
        workspaceId,
        prompt: typeof req.prompt === 'string' ? req.prompt : '',
        nextRunAt: typeof req.nextRunAt === 'number' ? req.nextRunAt : NaN,
        ...(typeof req.intervalMinutes === 'number' ? { intervalMinutes: req.intervalMinutes } : {}),
      });
      if (!schedule) return { ok: false, code: 'invalid' };
      await saveDeckSchedules([...schedules, schedule]);
      return { ok: true, schedule };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_SCHEDULES_UPDATE);
  ipcMain.handle(
    IPC.DECK_SCHEDULES_UPDATE,
    wrapHandler(IPC.DECK_SCHEDULES_UPDATE, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean; code?: string }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const id = typeof req.id === 'string' ? req.id : '';
      const schedules = loadDeckSchedules();
      const idx = schedules.findIndex((s) => s.id === id);
      if (idx === -1) return { ok: false, code: 'not_found' };
      let next = schedules[idx];
      // Re-scoping: a pre-M1.5 schedule (no workspaceId) may be assigned one —
      // exactly once. Owned schedules never migrate between workspaces (delete
      // and recreate instead: the prompt was written for that project).
      const workspaceId = readWorkspaceId(req);
      if (workspaceId && !next.workspaceId) next = { ...next, workspaceId };
      // `enabled` is mutable (pause/resume). Re-enabling a fired one-shot
      // re-arms it at its original time — immediately due. Enabling a schedule
      // that still has no workspace is rejected: there is no orchestrator to
      // run it on.
      if (typeof req.enabled === 'boolean') {
        if (req.enabled && !next.workspaceId) return { ok: false, code: 'no_workspace' };
        next = { ...next, enabled: req.enabled };
      }
      schedules[idx] = next;
      await saveDeckSchedules(schedules);
      return { ok: true };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_SCHEDULES_DELETE);
  ipcMain.handle(
    IPC.DECK_SCHEDULES_DELETE,
    wrapHandler(IPC.DECK_SCHEDULES_DELETE, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const id = typeof req.id === 'string' ? req.id : '';
      const schedules = loadDeckSchedules();
      await saveDeckSchedules(schedules.filter((s) => s.id !== id));
      return { ok: true };
    }),
  );

  // ── Loop engineering v1: the one-click loop ────────────────────────────
  // START is the one click: loop-state + autonomy caps + optional cadence
  // schedule written in a single action. STOP/PAUSE are the OFF contract —
  // caps drop to the workspace MODE (fail-closed) and the cadence schedule is
  // deleted/disabled, so a stopped loop never leaves the brain with Continue
  // authority and no objective, nor a pending schedule that fires later.
  //
  // Cap composition (2026-07-18): a loop's caps are the workspace MODE ceiling
  // NARROWED by the loop tier — `min(modeCeiling, tier)` — never a blanket
  // override. The mode is the standing trust envelope; the loop is a mission
  // that runs INSIDE it:
  //   - `report`   → observe + summarize only (no drive, no press) at any mode.
  //   - `continue` → may drive panes (continueInstruction) AND, only when the
  //                  mode ceiling is `auto`, press approvals — so auto+loop is
  //                  the true unattended supervisor while assist+loop stays
  //                  notify-on-approval.
  // The dangerous press capability therefore stays gated on the MODE (a
  // deliberate, standing, workspace-level choice), never on a per-loop tier
  // dropdown that is easy to fat-finger. off never reaches here (teardown).
  const applyTierCaps = async (workspaceId: string, tier: LoopTier): Promise<void> => {
    const ceiling = modeToCaps(loadWorkspaceMode(workspaceId));
    const driving = tier === 'continue';
    await setWorkspaceAutonomy(workspaceId, {
      summarize: ceiling.summarize,
      continueInstruction: ceiling.continueInstruction && driving,
      approvalPress: ceiling.approvalPress && driving,
    });
  };
  // Loop-stop restores caps to the workspace's CURRENT MODE, not the global
  // DEFAULT — otherwise stopping a loop in an `auto` workspace would
  // silently downgrade it to the default mode's caps. The mode is the source
  // of truth; the loop only ever transiently overrode the caps.
  const dropCaps = async (workspaceId: string): Promise<void> => {
    const mode = loadWorkspaceMode(workspaceId);
    await setWorkspaceAutonomy(workspaceId, modeToCaps(mode));
  };
  // The `off` mode kill-switch teardown: stop any running loop and delete its
  // cadence schedule so nothing autonomous survives. Same posture as loop-stop
  // (which also drops caps — here the mode write owns the caps). Idempotent.
  const tearDownAutomation = async (workspaceId: string): Promise<void> => {
    const loop = loadWorkspaceLoopState(workspaceId);
    if (loop?.scheduleId) {
      await saveDeckSchedules(loadDeckSchedules().filter((s) => s.id !== loop.scheduleId));
    }
    if (loop) await clearLoop(workspaceId);
    // A lingering pending/resolved decision must not survive a teardown into a
    // fresh loop — it would keep blocking wakes with a question about work that
    // is gone (3-way review). Clear it alongside the loop.
    await clearDecision(workspaceId);
  };
  const setLoopScheduleEnabled = async (
    scheduleId: string | undefined,
    enabled: boolean,
  ): Promise<void> => {
    if (!scheduleId) return;
    const schedules = loadDeckSchedules();
    const idx = schedules.findIndex((s) => s.id === scheduleId);
    if (idx === -1) return;
    schedules[idx] = { ...schedules[idx], enabled };
    await saveDeckSchedules(schedules);
  };

  /** Cadence bounds: floor 5 min (no tight loops), ceiling 7 days. */
  const LOOP_INTERVAL_MIN = 5;
  const LOOP_INTERVAL_MAX = 7 * 24 * 60;

  ipcMain.removeHandler(IPC.DECK_LOOP_GET);
  ipcMain.handle(
    IPC.DECK_LOOP_GET,
    wrapHandler(IPC.DECK_LOOP_GET, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{
      loop: WorkspaceLoopState | null;
      /** The live auto-wake budget (loop iterations while running, else the
       *  ambient default) — the status card's `wake r/t` readout. */
      wakeBudget: { remaining: number; total: number } | null;
    }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { loop: null, wakeBudget: null };
      return {
        loop: loadWorkspaceLoopState(workspaceId),
        wakeBudget: coalescer?.getWakeBudget(workspaceId) ?? null,
      };
    }),
  );

  // The HUMAN ticks a done-when item. Deliberately the only writer of `passes`
  // (the brain has no tool for it — v1's no-self-scored-done posture).
  ipcMain.removeHandler(IPC.DECK_LOOP_TASK);
  ipcMain.handle(
    IPC.DECK_LOOP_TASK,
    wrapHandler(IPC.DECK_LOOP_TASK, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean; loop?: WorkspaceLoopState }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      const taskId = typeof req.taskId === 'string' ? req.taskId : '';
      if (!workspaceId || !taskId) return { ok: false };
      const loop = await setTaskPasses(workspaceId, taskId, req.passes === true);
      return loop ? { ok: true, loop } : { ok: false };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_LOOP_START);
  ipcMain.handle(
    IPC.DECK_LOOP_START,
    wrapHandler(IPC.DECK_LOOP_START, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean; loop?: WorkspaceLoopState; code?: string }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false, code: 'invalid_workspace' };
      const objective = typeof req.objective === 'string' ? req.objective.trim() : '';
      if (!objective) return { ok: false, code: 'invalid' };
      // v1 hard cap: only 'report' | 'continue' exist on this surface.
      const tier: LoopTier = req.tier === 'continue' ? 'continue' : 'report';
      const taskTexts = Array.isArray(req.taskTexts)
        ? req.taskTexts.filter((t): t is string => typeof t === 'string')
        : [];
      // 반복 절차(steps) — 문자열 배열만 수용, 정규화·캡은 store가 담당.
      const steps = Array.isArray(req.steps)
        ? req.steps.filter((s): s is string => typeof s === 'string')
        : [];
      // Optional cadence: a HUMAN-authored repeating schedule created at click
      // time (this is NOT P4 brain self-scheduling). Out-of-range is a reject,
      // never a silent clamp.
      let intervalMinutes: number | undefined;
      if (req.intervalMinutes !== undefined) {
        const n = typeof req.intervalMinutes === 'number' ? req.intervalMinutes : NaN;
        if (!Number.isFinite(n) || n < LOOP_INTERVAL_MIN || n > LOOP_INTERVAL_MAX) {
          return { ok: false, code: 'invalid_interval' };
        }
        intervalMinutes = Math.floor(n);
      }
      // Iteration budget (Ralph max-iterations): out-of-range is a reject,
      // never a silent clamp; omitted → the store default.
      let iterations: number | undefined;
      if (req.iterations !== undefined) {
        const n = typeof req.iterations === 'number' ? req.iterations : NaN;
        if (
          !Number.isFinite(n) ||
          n < LOOP_STATE_LIMITS.MIN_ITERATIONS ||
          n > LOOP_STATE_LIMITS.MAX_ITERATIONS
        ) {
          return { ok: false, code: 'invalid_iterations' };
        }
        iterations = Math.floor(n);
      }
      // Replacing an existing loop: clean up its cadence schedule first so two
      // loops never leave two schedules behind, and clear any stale decision so
      // a fresh loop does not start blocked on a prior loop's question.
      const prior = loadWorkspaceLoopState(workspaceId);
      if (prior?.scheduleId) {
        await saveDeckSchedules(loadDeckSchedules().filter((s) => s.id !== prior.scheduleId));
      }
      await clearDecision(workspaceId);
      let scheduleId: string | undefined;
      if (intervalMinutes) {
        const schedules = loadDeckSchedules();
        if (schedules.length >= DECK_SCHEDULE_LIMITS.MAX_SCHEDULES) {
          return { ok: false, code: 'schedule_limit' };
        }
        const schedule = createSchedule({
          workspaceId,
          prompt:
            'Loop check-in: assess fleet progress toward the loop objective above and report. ' +
            'If your autonomy caps allow, nudge stalled panes onward.',
          nextRunAt: Date.now() + intervalMinutes * 60_000,
          intervalMinutes,
        });
        if (schedule) {
          await saveDeckSchedules([...schedules, schedule]);
          scheduleId = schedule.id;
        }
      }
      const loop = await startLoop(workspaceId, {
        objective,
        steps,
        taskTexts,
        tier,
        ...(iterations !== undefined ? { iterations } : {}),
        ...(scheduleId ? { scheduleId } : {}),
      });
      if (!loop) return { ok: false, code: 'invalid' };
      await applyTierCaps(workspaceId, tier);
      // Kick the loop into motion immediately (see kickLoop) so starting a loop
      // visibly does something instead of silently waiting for an event/tick.
      kickLoop(workspaceId);
      return { ok: true, loop };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_LOOP_STOP);
  ipcMain.handle(
    IPC.DECK_LOOP_STOP,
    wrapHandler(IPC.DECK_LOOP_STOP, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false };
      const loop = loadWorkspaceLoopState(workspaceId);
      if (loop?.scheduleId) {
        await saveDeckSchedules(loadDeckSchedules().filter((s) => s.id !== loop.scheduleId));
      }
      await clearLoop(workspaceId);
      await clearDecision(workspaceId);
      await dropCaps(workspaceId);
      return { ok: true };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_LOOP_PAUSE);
  ipcMain.handle(
    IPC.DECK_LOOP_PAUSE,
    wrapHandler(IPC.DECK_LOOP_PAUSE, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false };
      const loop = loadWorkspaceLoopState(workspaceId);
      if (!loop) return { ok: false };
      await setLoopStatus(workspaceId, 'paused');
      await setLoopScheduleEnabled(loop.scheduleId, false);
      await dropCaps(workspaceId);
      return { ok: true };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_LOOP_RESUME);
  ipcMain.handle(
    IPC.DECK_LOOP_RESUME,
    wrapHandler(IPC.DECK_LOOP_RESUME, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false };
      const loop = loadWorkspaceLoopState(workspaceId);
      if (!loop) return { ok: false };
      await setLoopStatus(workspaceId, 'running');
      await setLoopScheduleEnabled(loop.scheduleId, true);
      await applyTierCaps(workspaceId, loop.tier);
      // Resuming re-engages the orchestrator the same way starting does — a
      // paused loop that only re-arms its schedule would sit idle until the
      // next tick.
      kickLoop(workspaceId);
      return { ok: true };
    }),
  );

  // 루프 설정 모달의 스킬 픽커 — pane 에이전트의 스킬/커맨드 카탈로그 스캔
  // (읽기 전용, .claude/skills|commands 디스크 규약. skillCatalogScan 참조).
  ipcMain.removeHandler(IPC.DECK_LOOP_SKILLS);
  ipcMain.handle(
    IPC.DECK_LOOP_SKILLS,
    wrapHandler(IPC.DECK_LOOP_SKILLS, async (
      _event: Electron.IpcMainInvokeEvent,
      cwd: unknown,
    ): Promise<{ skills: SkillCatalogEntry[] }> => {
      return { skills: scanSkillCatalog(typeof cwd === 'string' ? cwd : '') };
    }),
  );

  // ── Embedded brain terminals: the renderer's mount-time hydration ────────
  ipcMain.removeHandler(IPC.DECK_BRAIN_PTY_LIST);
  ipcMain.handle(
    IPC.DECK_BRAIN_PTY_LIST,
    wrapHandler(IPC.DECK_BRAIN_PTY_LIST, async (): Promise<{ ptyIds: Record<string, string> }> => {
      return { ptyIds: Object.fromEntries(brainPtyIds) };
    }),
  );

  // ── Global auto-wake switch (Settings toggle) ─────────────────────────────
  ipcMain.removeHandler(IPC.DECK_AUTOWAKE_GET);
  ipcMain.handle(
    IPC.DECK_AUTOWAKE_GET,
    wrapHandler(IPC.DECK_AUTOWAKE_GET, async (): Promise<{ enabled: boolean }> => {
      return { enabled: loadAutoWakeEnabled() };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_AUTOWAKE_SET);
  ipcMain.handle(
    IPC.DECK_AUTOWAKE_SET,
    wrapHandler(IPC.DECK_AUTOWAKE_SET, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ enabled: boolean }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const enabled = await setAutoWakeEnabled(req.enabled === true);
      return { enabled };
    }),
  );

  // ── Per-workspace agent mode (off/assist/danger) ───────────────────────────
  // The wire accepts only the CURRENT names. A stale renderer sending 'auto'
  // is rejected rather than silently mapped: LEGACY_MODE_MAP migrates values
  // read off disk, and letting a live write take the same path would keep the
  // old name alive on the wire indefinitely.
  const VALID_MODES: ReadonlySet<string> = new Set(['off', 'assist', 'danger']);

  ipcMain.removeHandler(IPC.DECK_MODE_GET);
  ipcMain.handle(
    IPC.DECK_MODE_GET,
    wrapHandler(IPC.DECK_MODE_GET, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ mode: AgentMode | null }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { mode: null };
      return { mode: loadWorkspaceMode(workspaceId) };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_MODE_SET);
  ipcMain.handle(
    IPC.DECK_MODE_SET,
    wrapHandler(IPC.DECK_MODE_SET, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean; mode?: AgentMode; code?: string }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false, code: 'invalid_workspace' };
      const mode = req.mode;
      if (typeof mode !== 'string' || !VALID_MODES.has(mode)) {
        return { ok: false, code: 'invalid_mode' };
      }
      // `off` is the kill switch: tear down running automation BEFORE writing
      // the mode+caps, so a stopped loop can't race a final wake in between.
      if (mode === 'off') {
        await tearDownAutomation(workspaceId);
        // …and stop the brain that is ALREADY running. Refusing the next turn
        // is not enough: a live `claude-pty` brain keeps its TUI on screen, and
        // that terminal is itself an input path — the operator (or anything
        // typing into it) drives on past a mode that says the brain does not
        // run. Nothing else disposes it, so switching to off would leave the
        // one mode that promises silence still holding a live session.
        const entry = managers.get(workspaceId);
        if (entry) {
          entry.manager.dispose();
          retireManager(workspaceId);
          forgetAmbient(workspaceId);
        }
      }
      const next = await setWorkspaceMode(workspaceId, mode as AgentMode);
      // setWorkspaceMode reset caps to the pure mode ceiling. If a loop is still
      // running, re-narrow that new ceiling by the loop tier — otherwise raising
      // the mode mid-loop would silently grant a `report` mission drive/press
      // authority it never asked for (and lowering it would strand stale caps).
      // The mode is the ceiling; the running mission stays capped within it.
      if (mode !== 'off') {
        const loop = loadWorkspaceLoopState(workspaceId);
        if (loop?.status === 'running') await applyTierCaps(workspaceId, loop.tier);
      }
      return { ok: true, mode: next.mode };
    }),
  );

  // ── Decision gate (brain-raised human-in-the-loop) ────────────────────────
  // The brain raises a decision via the deck_ask_decision MCP tool → pipe RPC
  // (deck.rpc.ts); these two renderer-only handlers are the HUMAN's side. GET
  // hydrates the pending/just-resolved decision for the active workspace so the
  // card shows after a reboot. RESOLVE records the answer (durable), un-blocks
  // the wake loop, and kicks a resume turn — withLoopContext injects the
  // resolution so the brain continues from exactly where it paused.
  const DECISION_RESUME_PROMPT =
    'The operator just resolved the decision you raised (see the [decision] block above). ' +
    'Act on their answer now and continue — take the next concrete step, then end the turn. ' +
    'If their resolution corrects your judgment or cites a rule you missed, persist a short ' +
    'memory fact about it (per your memory-write policy) so you do not re-raise that class ' +
    'of question.';
  // Round-3 review P2: a brain-self-resolved record that survived its re-examine
  // turn (turn errored/interrupted after the resolve landed) must NOT replay as
  // "the operator resolved" — that would misattribute the brain's own answer to
  // the human. Same resume mechanics, honest provenance.
  const DECISION_SELF_RESUME_PROMPT =
    'A decision you SELF-RESOLVED earlier (auto-mode, see the [decision] block above) was ' +
    'never acted on — the turn that resolved it did not complete. This is YOUR OWN ' +
    'resolution, not a human answer: if it still holds, act on it now and continue; if it ' +
    'no longer applies, raise a fresh decision instead.';
  const resumePromptFor = (d: WorkspaceDecision): string =>
    d.resolvedBy === 'brain' ? DECISION_SELF_RESUME_PROMPT : DECISION_RESUME_PROMPT;

  ipcMain.removeHandler(IPC.DECK_DECISION_GET);
  ipcMain.handle(
    IPC.DECK_DECISION_GET,
    wrapHandler(IPC.DECK_DECISION_GET, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ decision: WorkspaceDecision | null }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      const decision = workspaceId ? loadWorkspaceDecision(workspaceId) : null;
      // Reboot-stranding guard (minimal): if a resolution was persisted but its
      // resume turn never ran (the app closed between resolve and the
      // fire-and-forget kick), reopening the deck hydrates it here — nudge a
      // resume so the answer is delivered instead of sitting forever. Idempotent:
      // the resumed turn consumes the resolved record, and a busy reject is fine.
      // A full headless (no-deck-open) startup reconcile is the M2 follow-up.
      if (workspaceId && decision?.status === 'resolved') {
        // Queued acquire (P1): a one-shot resume must await a slot, not silently
        // drop on a full gate — the answer would sit forever with autonomy off.
        // Provenance-aware prompt (round-3 P2): a brain self-resolution must not
        // replay as "the operator resolved".
        void runTurnForWorkspace(resumePromptFor(decision), workspaceId, { queued: true }).catch(() => {});
      }
      return { decision };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_DECISION_RESOLVE);
  ipcMain.handle(
    IPC.DECK_DECISION_RESOLVE,
    wrapHandler(IPC.DECK_DECISION_RESOLVE, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean; code?: string; decision?: WorkspaceDecision }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false, code: 'invalid_workspace' };
      const id = typeof req.id === 'string' ? req.id : '';
      const resolution = typeof req.resolution === 'string' ? req.resolution : '';
      if (!id || !resolution.trim()) return { ok: false, code: 'invalid' };
      const decision = await resolveDecision(workspaceId, id, resolution);
      if (!decision || decision.status !== 'resolved') {
        // Stale id, already resolved, or empty answer — nothing to resume.
        return { ok: false, code: 'not_pending' };
      }
      // A human just answered, which is the confirmation parking waits for, so
      // a record that survived the last shutdown becomes live again here. Doing
      // it BEFORE the resume turn matters: the prompt renders the work block,
      // and a still-parked record would render the PARKED text — "ask the human
      // and wait" — at the exact moment the human has answered. The resolution
      // itself rides the prompt, so a "drop it" answer is the brain's to act on;
      // un-parking grants permission to act, not a decision about what to do.
      unparkDeckWork(workspaceId);
      // A human answering IS a human turn for the stop gate's purposes (rule
      // 5): the resume turn that carries this answer must meet an ARMED gate,
      // or a model that no-ops the answer and stops slips through a cap-out
      // suppression recorded before the decision was even raised.
      clearGateCapOut(workspaceId);
      // Un-blocked now (hasPendingDecision is false). Kick a resume turn; a busy
      // reject is fine — the resolution rides withLoopContext on the next turn
      // (event / schedule / human) and is consumed then. Fire-and-forget: the
      // renderer only needs the resolve's accept, not the turn's outcome.
      void runTurnForWorkspace(DECISION_RESUME_PROMPT, workspaceId, { queued: true }).catch(() => {
        /* best-effort resume — the durable resolved decision rides the next turn */
      });
      return { ok: true, decision };
    }),
  );

  // ── D1: deterministic "welcome home" briefing ─────────────────────────────
  // A synchronous main-process READ of existing judgment-engine state — NO brain
  // turn, NO globalTurnGate acquire, renders in every autonomy mode including
  // 'off'. Every feed is a main-singleton read (mirror snapshot/entries,
  // decision, mode, loop) plus the last-viewed snapshot for the delta.
  //
  // READ and ACKNOWLEDGE are deliberately SEPARATE channels. The card fetches on
  // every deck stream tick (and while collapsed), so persisting the baseline
  // inside GET consumed deltas nobody ever saw: "2 finished, 1 now blocked"
  // could be folded into the snapshot while the operator was on another tab and
  // was then unrecoverable. GET is therefore pure; the card calls
  // DECK_BRIEFING_SEEN only once the briefing is actually rendered expanded, and
  // only THAT advances the "what you last saw" baseline.
  //
  // markColdStart returns true the FIRST time a workspace is briefed since this
  // handler registered (process start), false thereafter.
  const briefedSinceStart = new Set<string>();
  const markColdStart = (workspaceId: string): boolean => {
    if (briefedSinceStart.has(workspaceId)) return false;
    briefedSinceStart.add(workspaceId);
    return true;
  };

  // The snapshot each GET *would* persist, held until the renderer acknowledges
  // that build. Keyed by workspace, matched by builtAt so an acknowledge can only
  // ever commit the exact build the operator saw — a newer build that landed in
  // between is not silently consumed, and the renderer never gets to hand main
  // its own snapshot data.
  const pendingSeen = new Map<string, { builtAt: number; snapshot: BriefedSnapshot }>();

  ipcMain.removeHandler(IPC.DECK_BRIEFING_GET);
  ipcMain.handle(
    IPC.DECK_BRIEFING_GET,
    wrapHandler(IPC.DECK_BRIEFING_GET, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ briefing: WorkspaceBriefing | null; autoShow?: boolean; mirrorReady?: boolean }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { briefing: null };
      // Both reads join the store's write chain so a GET that races a queued
      // acknowledge still computes its delta from POST-write state.
      const cfg = await readDeckBriefingConfig();
      if (!cfg.enabled) return { briefing: null };
      const mirror = getWorkspaceMirror();
      // The mirror push waits for paneGate === 'ready', so an early GET during
      // startup sees an EMPTY fleet that is not the truth. Building on it would
      // burn the one-shot cold-start flag and (once acknowledged) seed an empty
      // baseline, leaving recovered panes invisible. Report "not ready" instead
      // and let the card retry — nothing is consumed.
      if (!mirror.hasEverBeenPopulated()) return { briefing: null, mirrorReady: false };
      const snapshot = mirror.getFleetSnapshot(workspaceId);
      const entry = mirror.getEntries()?.find((e) => e.id === workspaceId) ?? null;
      const briefing = buildWorkspaceBriefing({
        workspaceId,
        entry,
        snapshot,
        decision: loadWorkspaceDecision(workspaceId),
        mode: loadWorkspaceMode(workspaceId),
        loop: loadWorkspaceLoopState(workspaceId),
        prior: await readBriefedSnapshot(workspaceId),
        coldStart: markColdStart(workspaceId),
      });
      pendingSeen.set(workspaceId, {
        builtAt: briefing.builtAt,
        snapshot: toBriefedSnapshot(
          snapshot,
          briefing.pendingDecision?.id ?? null,
          briefing.builtAt,
        ),
      });
      return { briefing, autoShow: cfg.autoShow, mirrorReady: true };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_BRIEFING_SEEN);
  ipcMain.handle(
    IPC.DECK_BRIEFING_SEEN,
    wrapHandler(IPC.DECK_BRIEFING_SEEN, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false };
      const builtAt = typeof req.builtAt === 'number' ? req.builtAt : NaN;
      const pending = pendingSeen.get(workspaceId);
      // No-op unless this acknowledges the exact build main handed out. Also
      // makes a repeated ack for the same build free (no disk write).
      if (!pending || pending.builtAt !== builtAt) return { ok: false };
      pendingSeen.delete(workspaceId);
      const live = getWorkspaceMirror().getEntries()?.map((e) => e.id);
      // Fire-and-forget, same never-throw posture as the rest of the store: a
      // failed persist only costs a slightly-stale delta on the next open.
      void saveBriefedSnapshot(workspaceId, pending.snapshot, undefined, {
        ...(live ? { liveWorkspaceIds: live } : {}),
      }).catch(() => undefined);
      return { ok: true };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_BRIEFING_CONFIG_GET);
  ipcMain.handle(
    IPC.DECK_BRIEFING_CONFIG_GET,
    wrapHandler(IPC.DECK_BRIEFING_CONFIG_GET, async (): Promise<DeckBriefingConfig> => {
      return loadDeckBriefingConfig();
    }),
  );

  ipcMain.removeHandler(IPC.DECK_BRIEFING_CONFIG_SET);
  ipcMain.handle(
    IPC.DECK_BRIEFING_CONFIG_SET,
    wrapHandler(IPC.DECK_BRIEFING_CONFIG_SET, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<DeckBriefingConfig> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const patch: Partial<DeckBriefingConfig> = {};
      if (typeof req.enabled === 'boolean') patch.enabled = req.enabled;
      if (typeof req.autoShow === 'boolean') patch.autoShow = req.autoShow;
      return saveDeckBriefingConfig(patch);
    }),
  );

  // M2 — headless startup reconcile. A resolution can be persisted but never
  // consumed if the app closed between resolve and the fire-and-forget resume
  // kick, and the deck may never be reopened (so the GET-hydrate nudge above
  // can't fire). On startup we scan for resolved-but-unconsumed decisions and
  // kick a resume for each, headlessly — the brain acts on the answer even
  // before the deck tab is opened, and each resumed turn consumes its record.
  // Deferred so the daemon's session recovery settles first (a resume turn
  // wants the recovered fleet); unref'd so it never keeps Electron alive.
  const DECISION_RECONCILE_DELAY_MS = 4000;
  const ACTIVE_WORK_RECONCILE_PROMPT =
    'A human request is still active after wmux startup (see [active-work]). Reconcile it now: ' +
    'query every tracked A2A task, inspect current panes, continue or repair incomplete work, ' +
    'and independently verify claimed results. If everything passes, finalize with ' +
    'deck_complete_work({summary, verification}); otherwise leave a precise progress update.';
  const reconcileResolvedDecisions = async (): Promise<void> => {
    // Serial + QUEUED (P1): each resume awaits a fleet slot and runs to
    // completion before the next starts, so >2 resolved decisions ALL process —
    // the old fire-and-forget loop only got the first `cap` past the gate and
    // silently dropped the rest.
    for (const [workspaceId, decision] of Object.entries(loadDeckDecisions())) {
      if (decision.status === 'resolved') {
        // Provenance-aware prompt (round-3 P2): a stranded brain self-resolution
        // resumes as the brain's OWN answer, never as "the operator resolved".
        await runTurnForWorkspace(resumePromptFor(decision), workspaceId, { queued: true }).catch(
          () => {},
        );
      }
    }
    // Direct requests are durable too. Reconcile them after decisions so a
    // resolved human fork is consumed before its parent request continues. A
    // still-pending decision deliberately keeps the request parked.
    // Direct work follows the same absolute global kill switch as edge and
    // heartbeat wakes. Keep the durable record parked so turning auto-wake
    // back on (or a fresh human turn) can resume it without losing ownership.
    if (!loadAutoWakeEnabled()) return;
    for (const [workspaceId, work] of Object.entries(loadActiveDeckWorks())) {
      if (hasPendingDecision(workspaceId)) continue;
      if (isDeckWorkParked(work)) {
        // #733: a record that outlived the last shutdown is NOT permission to
        // drive. This loop runs once, seconds after launch, and used to hand
        // every surviving record an order to "continue or repair incomplete
        // work" — with no autonomy mode and no wake budget consulted. That is
        // what replayed an eight-hour-old objective into a live pane.
        //
        // Ask instead of act. A pending decision also blocks every other wake
        // path for this workspace, so the record stays quiet until the human
        // answers, and resolving it resumes through the normal path above.
        // Guarded on hasPendingDecision because the decision store is
        // last-writer-wins: a real question raised before this timer fired must
        // never be clobbered by our bookkeeping.
        await raiseDecision(workspaceId, {
          question:
            'A request from before this wmux session is still on the books. Resume it, or drop it?',
          options: ['Resume it', 'Drop it'],
          context: renderActiveDeckWorkBlock(work),
        }).catch(() => {
          /* best-effort — the record stays parked either way */
        });
        continue;
      }
      await runTurnForWorkspace(ACTIVE_WORK_RECONCILE_PROMPT, workspaceId, { queued: true }).catch(
        () => {
          /* best-effort — durable active work remains for the next wake */
        },
      );
    }
  };
  const reconcileTimer = setTimeout(
    () => void reconcileResolvedDecisions(),
    opts.reconcileDelayMs ?? DECISION_RECONCILE_DELAY_MS,
  );
  (reconcileTimer as { unref?: () => void }).unref?.();

  const disposeAll = (): void => {
    for (const { manager } of managers.values()) manager.dispose();
    managers.clear();
  };

  // Guarantee the brain subprocesses are torn down on quit even if the caller
  // forgets to invoke the returned cleanup.
  app.once('before-quit', disposeAll);

  return () => {
    app.removeListener('before-quit', disposeAll);
    clearTimeout(reconcileTimer);
    offBus();
    coalescer?.dispose();
    globalTurnGate.dispose();
    scheduler.stop();
    heartbeat.stop();
    disposeAll();
    ipcMain.removeHandler(IPC.DECK_SEND);
    ipcMain.removeHandler(IPC.DECK_INTERRUPT);
    ipcMain.removeHandler(IPC.DECK_WAKE);
    ipcMain.removeHandler(IPC.DECK_STATUS);
    ipcMain.removeHandler(IPC.DECK_FULLPOWER_SET);
    ipcMain.removeHandler(IPC.DECK_MODEL_SET);
    ipcMain.removeHandler(IPC.DECK_BRAIN_VENDOR_SET);
    ipcMain.removeHandler(IPC.DECK_SCHEDULES_LIST);
    ipcMain.removeHandler(IPC.DECK_SCHEDULES_CREATE);
    ipcMain.removeHandler(IPC.DECK_SCHEDULES_UPDATE);
    ipcMain.removeHandler(IPC.DECK_SCHEDULES_DELETE);
    ipcMain.removeHandler(IPC.DECK_LOOP_GET);
    ipcMain.removeHandler(IPC.DECK_LOOP_START);
    ipcMain.removeHandler(IPC.DECK_LOOP_STOP);
    ipcMain.removeHandler(IPC.DECK_LOOP_PAUSE);
    ipcMain.removeHandler(IPC.DECK_LOOP_RESUME);
    ipcMain.removeHandler(IPC.DECK_LOOP_TASK);
    ipcMain.removeHandler(IPC.DECK_LOOP_SKILLS);
    ipcMain.removeHandler(IPC.DECK_BRAIN_PTY_LIST);
    ipcMain.removeHandler(IPC.DECK_AUTOWAKE_GET);
    ipcMain.removeHandler(IPC.DECK_AUTOWAKE_SET);
    ipcMain.removeHandler(IPC.DECK_MODE_GET);
    ipcMain.removeHandler(IPC.DECK_MODE_SET);
    ipcMain.removeHandler(IPC.DECK_DECISION_GET);
    ipcMain.removeHandler(IPC.DECK_DECISION_RESOLVE);
    ipcMain.removeHandler(IPC.DECK_BRIEFING_GET);
    ipcMain.removeHandler(IPC.DECK_BRIEFING_SEEN);
    ipcMain.removeHandler(IPC.DECK_BRIEFING_CONFIG_GET);
    ipcMain.removeHandler(IPC.DECK_BRIEFING_CONFIG_SET);
  };
}
