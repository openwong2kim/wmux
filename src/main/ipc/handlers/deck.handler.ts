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
import type { BrainVendor } from '../../../shared/types';
import { getMemoryRootDir } from '../../deck/commanderMemory';
import {
  CommanderSessionManager,
  type CommanderSendResult,
  type CommanderStatusSnapshot,
} from '../../deck/CommanderSessionManager';
import { loadCommanderSession, saveCommanderSession, clearCommanderSession } from '../../deck/commanderSessionStore';
import { DeckScheduler } from '../../deck/DeckScheduler';
import { CommanderEventCoalescer } from '../../deck/CommanderEventCoalescer';
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
  hasPendingDecision,
  type WorkspaceDecision,
} from '../../deck/deckDecisionStore';
import { scanSkillCatalog, type SkillCatalogEntry } from '../../deck/skillCatalogScan';
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
  }) => BrainAdapter;
  /** M2 startup-reconcile delay (ms) before resolved-but-unconsumed decisions
   *  are resumed headlessly. Deferred so daemon/session recovery settles first;
   *  injected small in tests. */
  reconcileDelayMs?: number;
}

/** Fleet-context token budget (~2KB). A larger snapshot is truncated so the
 *  one-shot injection can't blow the turn's context. */
const FLEET_CONTEXT_MAX_CHARS = 2048;

/** Workspace ids key maps and persisted JSON — reject anything that isn't a
 *  plausible id token before it can become a key. */
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export function registerDeckHandler(
  getWindow: GetWindow,
  opts: RegisterDeckHandlerOptions = {},
): () => void {
  const createAdapter =
    opts.createAdapter ??
    ((adapterOpts: { model?: string; workspaceId: string; fullPower?: boolean; vendor?: BrainVendor }) => {
      // BYOB M0: the vendor picker decides which brain runtime serves this
      // workspace. 'hermes' rides the generic ACP adapter (any ACP agent
      // could — Hermes is simply the first configured spawn spec); everything
      // else is the Claude SDK default. Model/fullPower are Claude-specific
      // and deliberately not forwarded to ACP brains.
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

  // Full-power toggle (BYOB approach A) — MAIN-side authority so scheduled /
  // event-woken turns and toggle changes between typed commands all see the
  // live value (Codex/GLM review round 1: a send-carried flag left autonomous
  // turns on the stale mode, and a restart silently dropped a persisted ON).
  // Synced by DECK_FULLPOWER_SET: on change and once after session hydration.
  let fullPowerEnabled = false;

  // Brain vendor (BYOB M0) — same main-authority contract as full power.
  let brainVendor: BrainVendor = 'claude';

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
    const vendor = brainVendor;
    const existing = managers.get(workspaceId);
    // model/fullPower are Claude-specific — an ACP brain ignores them, so a
    // change must not needlessly dispose+respawn a non-Claude brain (GLM
    // review): only vendor-relevant settings participate in the swap check.
    const claudeSettingsChanged =
      vendor === 'claude' && existing
        ? model !== existing.model || fullPower !== existing.fullPower
        : false;
    if (
      existing &&
      (vendor !== existing.vendor || claudeSettingsChanged) &&
      existing.manager.getStatus().status !== 'busy'
    ) {
      existing.manager.dispose();
      managers.delete(workspaceId);
    }
    const current = managers.get(workspaceId);
    if (current) return current.manager;
    // P3a: resume this workspace's persisted conversation from the previous
    // app run. A dead id is soft — the adapter falls back to a fresh session.
    // BYOB M0: each vendor keeps its OWN conversation thread — a composite
    // store key for non-default vendors, the bare wsId for Claude so existing
    // persisted sessions keep resuming across this change.
    const sessionKey = vendor === 'claude' ? workspaceId : `${workspaceId}::${vendor}`;
    const persisted = loadCommanderSession(sessionKey);
    const manager = new CommanderSessionManager({
      adapter: createAdapter({
        workspaceId,
        vendor,
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
  const withLoopContext = (workspaceId: string, text: string): string => {
    const decision = loadWorkspaceDecision(workspaceId);
    const loop = loadWorkspaceLoopState(workspaceId);
    const blocks: string[] = [];
    // The decision block LEADS — a blocked (or just-resolved) decision is the
    // most urgent trusted context for this turn. Both survive a reboot as
    // atomic JSON, so a resumed brain re-reads exactly where it paused.
    if (decision) blocks.push(renderDecisionBlock(decision));
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
      let fleetContext = typeof req.fleetContext === 'string' ? req.fleetContext : undefined;
      if (fleetContext && fleetContext.length > FLEET_CONTEXT_MAX_CHARS) {
        fleetContext = fleetContext.slice(0, FLEET_CONTEXT_MAX_CHARS) + '\n…(truncated)';
      }
      // Model override: sanitize to a plausible model token — this ends up on
      // the SDK subprocess command line, so reject anything but [A-Za-z0-9._-].
      const rawModel = typeof req.model === 'string' ? req.model.trim() : '';
      const model = /^[A-Za-z0-9._-]{1,64}$/.test(rawModel) ? rawModel : '';
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
        coalescer?.notifyHumanSend(workspaceId);
      }
      // Awaits the full turn (events stream over DECK_STREAM meanwhile); the
      // resolved value is only the accept/reject verdict. The loop + decision
      // blocks ride in front of the typed text — invisible to the renderer's
      // optimistic user bubble, visible to the brain. If this human turn carried
      // a resolved decision's block, consume it (id-scoped) so it never re-injects.
      const injectedDecision = loadWorkspaceDecision(workspaceId);
      const verdict = await mgr.send(withLoopContext(workspaceId, text));
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
        managers.delete(workspaceId);
      }
      const vendor = brainVendor;
      const sessionKey = vendor === 'claude' ? workspaceId : `${workspaceId}::${vendor}`;
      await clearCommanderSession(sessionKey);
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
            managers.delete(workspaceId);
          }
        }
      }
      return { ok: true, enabled };
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
      // Fail closed to the default: only known vendor ids are accepted.
      const vendor: BrainVendor = req.vendor === 'hermes' ? 'hermes' : 'claude';
      if (vendor !== brainVendor) {
        brainVendor = vendor;
        // Retire IDLE stale-vendor brains now (same contract as full power):
        // the next turn on ANY path spawns on the new vendor; busy managers
        // finish their in-flight turn and swap on their next one.
        for (const [workspaceId, entry] of [...managers]) {
          if (entry.vendor !== vendor && entry.manager.getStatus().status !== 'busy') {
            entry.manager.dispose();
            managers.delete(workspaceId);
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
  ): Promise<{ ok: boolean; code?: string }> => {
    if (!WORKSPACE_ID_RE.test(workspaceId)) {
      return { ok: false, code: 'invalid_workspace' as const };
    }
    // Scheduled/event-woken turns reuse the live manager's model (a lazily
    // created one starts with the default). Full power always comes from the
    // main-side authority inside ensureManager — the live toggle applies to
    // autonomous turns too.
    const mgr = ensureManager(workspaceId, undefined, managers.get(workspaceId)?.model ?? '');
    if (mgr.getStatus().status !== 'idle') {
      return { ok: false, code: 'busy' as const };
    }
    // Build the wire prompt (prepends any pending/resolved [decision] block and
    // the loop block) BEFORE the send — the status check and send stay one
    // synchronous sequence (nothing awaits between them).
    // turn-start announces the ORIGINAL prompt (what the human should see as
    // the turn's cause); the context blocks ride only on the wire to the brain,
    // mirroring the DECK_SEND path.
    // Capture the decision THIS turn will inject (withLoopContext reads the same
    // on-disk state synchronously right below) so at turn end we consume ONLY a
    // resolution this turn actually carried — never one RAISED mid-turn, whose
    // prompt this turn was built before (that would silently drop the human's
    // answer and unblock the loop — 3-way review P1).
    const injected = loadWorkspaceDecision(workspaceId);
    const prompted = withLoopContext(workspaceId, prompt);
    emit(workspaceId, { type: 'turn-start', prompt });
    const verdict = await mgr.send(prompted);
    if (verdict.ok && injected?.status === 'resolved') {
      void clearResolvedDecision(workspaceId, injected.id).catch(() => {});
    }
    return verdict;
  };

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
    void runTurnForWorkspace(LOOP_KICKOFF_PROMPT, workspaceId).catch(() => {
      /* best-effort — a rejected kick just means the drivers take over */
    });
  };

  // ── Event-push: EventBus → coalescer → orchestrator wake-turn ─────────────
  // The main-process EventBus already carries agent.stop / agent.awaiting_input
  // (hook + detector sourced). Subscribe, coalesce per workspace, and wake the
  // owning orchestrator so it observes fleet lifecycle changes WITHOUT polling.
  coalescer = new CommanderEventCoalescer({
    runTurn: (workspaceId, prompt) => runTurnForWorkspace(prompt, workspaceId),
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
    // Global kill switch (Settings): OFF drops ambient wakes; running loops
    // still wake. Read fresh at every flush so the toggle applies immediately.
    isAutoWakeEnabled: () => loadAutoWakeEnabled(),
    // A PENDING decision gate blocks every wake for this workspace (even a
    // running loop) until the human resolves it. Read fresh at each flush.
    hasPendingDecision: (workspaceId) => hasPendingDecision(workspaceId),
  });
  const offBus = eventBus.subscribe((ev) => {
    if (ev.type !== 'agent.lifecycle') return;
    if (ev.kind !== 'agent.stop' && ev.kind !== 'agent.awaiting_input') return;
    coalescer?.push({
      workspaceId: ev.workspaceId,
      ptyId: ev.ptyId,
      kind: ev.kind,
      source: ev.source,
      agent: ev.agent,
      seq: ev.seq,
      ts: ev.ts,
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
  // caps drop to DEFAULT (fail-closed) and the cadence schedule is deleted/
  // disabled, so a stopped loop never leaves the brain with Continue authority
  // and no objective, nor a pending schedule that fires later. v1 tiers cap at
  // 'continue'; approval-press is NOT reachable from this surface.
  const applyTierCaps = async (workspaceId: string, tier: LoopTier): Promise<void> => {
    await setWorkspaceAutonomy(workspaceId, {
      summarize: true,
      continueInstruction: tier === 'continue',
      approvalPress: false,
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

  // ── Per-workspace agent mode (off/assist/auto) ─────────────────────────────
  const VALID_MODES: ReadonlySet<string> = new Set(['off', 'assist', 'auto']);

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
      if (mode === 'off') await tearDownAutomation(workspaceId);
      const next = await setWorkspaceMode(workspaceId, mode as AgentMode);
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
    'Act on their answer now and continue — take the next concrete step, then end the turn.';

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
        void runTurnForWorkspace(DECISION_RESUME_PROMPT, workspaceId).catch(() => {});
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
      // Un-blocked now (hasPendingDecision is false). Kick a resume turn; a busy
      // reject is fine — the resolution rides withLoopContext on the next turn
      // (event / schedule / human) and is consumed then. Fire-and-forget: the
      // renderer only needs the resolve's accept, not the turn's outcome.
      void runTurnForWorkspace(DECISION_RESUME_PROMPT, workspaceId).catch(() => {
        /* best-effort resume — the durable resolved decision rides the next turn */
      });
      return { ok: true, decision };
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
  const reconcileResolvedDecisions = (): void => {
    for (const [workspaceId, decision] of Object.entries(loadDeckDecisions())) {
      if (decision.status === 'resolved') {
        void runTurnForWorkspace(DECISION_RESUME_PROMPT, workspaceId).catch(() => {});
      }
    }
  };
  const reconcileTimer = setTimeout(
    reconcileResolvedDecisions,
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
    scheduler.stop();
    disposeAll();
    ipcMain.removeHandler(IPC.DECK_SEND);
    ipcMain.removeHandler(IPC.DECK_INTERRUPT);
    ipcMain.removeHandler(IPC.DECK_STATUS);
    ipcMain.removeHandler(IPC.DECK_FULLPOWER_SET);
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
    ipcMain.removeHandler(IPC.DECK_AUTOWAKE_GET);
    ipcMain.removeHandler(IPC.DECK_AUTOWAKE_SET);
    ipcMain.removeHandler(IPC.DECK_MODE_GET);
    ipcMain.removeHandler(IPC.DECK_MODE_SET);
    ipcMain.removeHandler(IPC.DECK_DECISION_GET);
    ipcMain.removeHandler(IPC.DECK_DECISION_RESOLVE);
  };
}
