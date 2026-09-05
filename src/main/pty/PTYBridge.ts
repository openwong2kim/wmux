import { BrowserWindow } from 'electron';
import { PTYManager } from './PTYManager';
import { OscParser } from './OscParser';
import { TerminalNotificationParser } from './oscNotification';
import { AgentDetector, agentDisplayToSlug } from './AgentDetector';
import { ActivityMonitor } from './ActivityMonitor';
import { parseOsc7Cwd, detectPromptCwd } from './cwdDetect';
import { sanitizeTitle } from './titleDetect';
import { IPC } from '../../shared/constants';
import {
  updateCwd,
  removeCwd,
  updateBranch,
  removeBranch,
  broadcastMetadataUpdate,
  getLastBroadcastAgentStatus,
  clearLastBroadcastAgentStatus,
} from '../ipc/handlers/metadata.handler';
import { dispatchNotification } from '../notification/dispatchNotification';
import { settleHookTurnToIdle } from '../notification/turnSettle';
import { InterruptKeystrokeDetector } from '../../shared/hooks/interruptKeystroke';
import { recentlyResized, RESIZE_REDRAW_GUARD_MS, clearPty as clearSuppression } from '../notification/idleSuppression';
import { eventBus } from '../events/EventBus';
import type { HookSignalRouter } from '../hooks/HookSignalRouter';
import { normalizeDetectorCue, type CompletionAlarm } from '../../shared/hooks/CompletionAlarm';
import type { AgentStatus } from '../../shared/types';

// How long after an AgentDetector event to suppress the ActivityMonitor idle
// fallback notification. Prevents double-firing when both signals agree
// (agent emits 'waiting' then 5s of silence triggers onActiveToIdle).
const AGENT_EVENT_SUPPRESSION_MS = 10_000;

/**
 * A middleware handler receives raw data from a PTY process.
 * Each middleware is executed in registration order, wrapped in try-catch
 * so that a failure in one does not block subsequent middleware or data forwarding.
 */
export type PTYDataMiddleware = (data: string) => void;

export class PTYBridge {
  private oscParsers = new Map<string, OscParser>();
  private agentDetectors = new Map<string, AgentDetector>();
  private activityMonitor = new ActivityMonitor();
  private ptyCreatedAt = new Map<string, number>();
  private middlewareStacks = new Map<string, PTYDataMiddleware[]>();
  // Per-PTY cleanup hooks for AgentDetector subscriptions. PTYBridge owns
  // exactly one AgentDetector instance per ptyId; these unsubscribes are
  // invoked in cleanupInstance to prevent listener accumulation.
  private agentDetectorCleanups = new Map<string, Array<() => void>>();
  // Most recent AgentDetector event timestamp per PTY. Used to suppress the
  // ActivityMonitor idle fallback notification when the agent already
  // emitted a more precise 'waiting'/'complete' signal a moment earlier.
  private lastAgentEventAt = new Map<string, number>();
  /** Ctrl+C / ESC ESC detection for the interrupt edge — see noteInterruptInput. */
  private interruptKeystrokes = new InterruptKeystrokeDetector();

  // Micro-batch buffers for the data hot-path. Chunks are accumulated and
  // flushed every BATCH_INTERVAL_MS so middlewares + IPC send each fire once
  // per flush instead of once per chunk. Pending buffers are drained on
  // dispose to avoid losing trailing output.
  private pendingData = new Map<string, string[]>();
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static BATCH_INTERVAL_MS = 8;

  constructor(
    private ptyManager: PTYManager,
    private getWindow: () => BrowserWindow | null,
    // Optional lazy accessor for the shared HookSignalRouter. Used to call
    // `recordDetector` before emitting an `agent.lifecycle` event from the
    // detector path so the ledger sees both sides of the dedup window
    // (otherwise back-to-back hook+detector events would both stream
    // `decision:'emit'` and orchestrators filtering on that would run a
    // follow-up twice). Lazy because PTYBridge is constructed before
    // HookSignalRouter in main/index.ts boot order; the closure captures
    // the binding by reference. Tests pass `undefined` and fall through to
    // a bare 'emit' decision — the test rig has no hook bridge anyway.
    private getHookRouter?: () => HookSignalRouter | null,
    // Lazy accessor for the shared CompletionAlarm (same forward-declared
    // pattern as getHookRouter, and for the same reason: the alarm is built
    // later in main/index.ts boot order). MUST be the same instance
    // registerHooksRpc observes — the detector's provisional window and the
    // hook's Stop candidate arbitrate against one shared pane gate. Absent
    // (tests) → the detector path keeps its pre-gate immediate fan-out.
    private getAlarm?: () => CompletionAlarm | null,
  ) {
    this.ptyManager.onDispose((ptyId) => this.cleanupInstance(ptyId));
    // Activity-based fallback: fires when sustained output drops to idle.
    // Suppressed if AgentDetector already emitted a precise status event for
    // this PTY within AGENT_EVENT_SUPPRESSION_MS — that signal is more
    // accurate, AgentDetector's onEvent path already did the
    // sendNotification + toast work, and the agentStatus is already
    // correctly set to 'waiting'/'complete'.
    //
    // When no precise event happened (generic shell command, unsupported
    // agent, missed prompt), the previous 'running' status from onActive
    // must be cleared back to 'idle' — otherwise the sidebar dot pulses
    // forever even though output stopped.
    this.activityMonitor.onActiveToIdle((ptyId) => {
      const now = Date.now();
      // Hook-governed pane: byte silence says nothing about whether the turn
      // ended. Quiet reasoning, a long web search, a slow bash — all of them
      // cross IDLE_DELAY_MS while the agent is very much working, and clearing
      // there is what made a hook-driven pane flicker to idle mid-turn. The
      // hook's own Stop settles it instead; a pane whose agent died without one
      // is settled by the process-death edge, which releases this claim first.
      if (this.getHookRouter?.()?.governsRunningState(ptyId, now)) return;
      const lastAgentAt = this.lastAgentEventAt.get(ptyId) ?? 0;
      // #935 direction 3: defer to a recent precise status ONLY while that
      // status is still what is actually showing. `onActive` broadcasts
      // 'running' unconditionally, so a burst inside this window can
      // overwrite a correct 'complete'/'waiting' with 'running' — once the
      // live status IS 'running', there is nothing precise left to defer to,
      // and continuing to defer would wedge the pane at 'running' forever.
      // #935 direction 3: recorded at the broadcastMetadataUpdate funnel
      // (metadata.handler.ts), not locally — hooks.rpc's turn-boundary and
      // awaiting-input broadcasts go through the same funnel, so a
      // hook-governed pane's precise status is visible here too, not just
      // the ones this class broadcasts itself.
      const stillPrecise = getLastBroadcastAgentStatus(ptyId) !== 'running';
      if (stillPrecise && now - lastAgentAt < AGENT_EVENT_SUPPRESSION_MS) return;
      // Accepted cost of #935 direction 3, do not "fix": a turn that is
      // genuinely still running (a long silent tool call, quiet generation)
      // and happens to cross IDLE_DELAY_MS of byte silence while inside this
      // window now clears to 'idle' with no deferral — roster/stopGate see a
      // brief false idle until the next burst. The alternative (deferring
      // once more here) reopens exactly the wedge this direction closes: the
      // deferred clear would need another burst to retry, and a pane that
      // stays quiet because it is actually done never produces one.
      // No resize/typing gate here: this handler's only job is the status
      // clear, and dropping it wedges the pane at `running` permanently
      // (ActivityMonitor has already consumed the transition, and a quiet pane
      // never produces another burst to re-fire it). See idleSuppression.ts
      // and issue #733. The precise-status deference above still applies.
      try {
        const win = this.getWindow();
        // Clear stale 'running' → 'idle' so the sidebar dot self-heals when a
        // burst-then-quiet PTY has no precise event. This is the ONLY job kept:
        // the byte-silence heuristic must NOT raise a toast — it can't tell a
        // finished turn from a mid-turn tool call / web search / long bash, and
        // fired on plain shells too (the "Task may have finished" false-positive
        // the owner reported). Neither orca nor amirlehmam/wmux has any
        // silence-based completion notification; genuine completions come from
        // the precise Stop/awaiting_input hook + AgentDetector paths, which are
        // untouched. See plans/agent-status-dot-quiet-notifications-2026-07-12.md.
        broadcastMetadataUpdate(win, { ptyId, agentStatus: 'idle', agentName: '' });
      } catch (err) {
        console.warn('[PTYBridge] onActiveToIdle callback error:', err);
      }
    });
  }

  /**
   * Register a data middleware for a specific PTY instance.
   * Middlewares are executed in registration order, each wrapped in try-catch.
   */
  addMiddleware(ptyId: string, handler: PTYDataMiddleware): void {
    let stack = this.middlewareStacks.get(ptyId);
    if (!stack) {
      stack = [];
      this.middlewareStacks.set(ptyId, stack);
    }
    stack.push(handler);
  }

  /**
   * Execute all registered middlewares for a PTY instance.
   * Each middleware is isolated — a failure in one does not block others.
   */
  private runMiddlewares(ptyId: string, data: string): void {
    const stack = this.middlewareStacks.get(ptyId);
    if (!stack) return;
    for (const mw of stack) {
      try {
        mw(data);
      } catch (err) {
        console.error('[PTYBridge] Middleware error:', err);
      }
    }
  }

  /**
   * Clean up all Bridge-side resources for a PTY instance.
   * Called automatically on process exit, but can also be called externally
   * (e.g. from PTYManager.dispose()) to ensure cleanup when onExit is not fired.
   */
  cleanupInstance(ptyId: string): void {
    // Clear agentStatus on every disposal path. onExit already broadcasts
    // 'idle', but the PTYManager.dispose → onDispose path can reach this
    // method WITHOUT going through onExit (e.g. user closes a pane via the
    // UI, MCP destroy, surface swap). Without this idempotent broadcast,
    // the sidebar dot stays stuck on the last 'running'/'waiting' state
    // for a terminal that's already gone.
    try {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        broadcastMetadataUpdate(win, { ptyId, agentStatus: 'idle', agentName: '' });
      }
    } catch (err) {
      console.warn('[PTYBridge] cleanupInstance agentStatus broadcast error:', err);
    }

    // Drain any buffered data before tearing down — preserves trailing output
    // (e.g. final exit lines) that arrived between the last flush and dispose.
    this.flushPending(ptyId);
    const timer = this.pendingTimers.get(ptyId);
    if (timer) clearTimeout(timer);
    this.pendingTimers.delete(ptyId);
    this.pendingData.delete(ptyId);

    // Unsubscribe AgentDetector + ActivityMonitor.onActive listeners. Without
    // this, every PTY create/dispose cycle would accumulate closure-captured
    // callbacks against the same `agentDetector`/`activityMonitor` instances
    // (same leak class as the v2.7.2 PlaywrightEngine CDP session fix).
    const cleanups = this.agentDetectorCleanups.get(ptyId);
    if (cleanups) {
      for (const fn of cleanups) {
        try { fn(); } catch (err) { console.warn('[PTYBridge] cleanup hook error:', err); }
      }
      this.agentDetectorCleanups.delete(ptyId);
    }
    this.lastAgentEventAt.delete(ptyId);
    this.interruptKeystrokes.forget(ptyId);
    clearLastBroadcastAgentStatus(ptyId);
    clearSuppression(ptyId);

    this.oscParsers.delete(ptyId);
    this.agentDetectors.delete(ptyId);
    this.ptyCreatedAt.delete(ptyId);
    this.activityMonitor.stop(ptyId);
    this.middlewareStacks.delete(ptyId);
    removeCwd(ptyId);
    removeBranch(ptyId);

    // Prune HookSignalRouter ledger entries for this PTY. Without this,
    // ledger entries (one per slug × kind seen) linger forever and the
    // map grows monotonically across PTY spawn/dispose cycles. Bridge
    // already owns the hookRouter reference so the call is local.
    try {
      this.getHookRouter?.()?.dropPty(ptyId);
    } catch (err) {
      console.warn('[PTYBridge] hookRouter.dropPty error:', err);
    }

    // Verdict gate: same cleanup discipline — a reused ptyId must start from
    // an empty gate, or a fresh pane's first stop would arbitrate against the
    // dead pane's `announced`/`seenWorking` state.
    try {
      this.getAlarm?.()?.dropPty(ptyId);
    } catch (err) {
      console.warn('[PTYBridge] alarm.dropPty error:', err);
    }

    this.ptyManager.remove(ptyId);
  }

  /**
   * Working-evidence feed for the verdict gate on the LOCAL input path — the
   * mirror of the daemon's session:active → notePaneWorking wiring. Called
   * from the local PTY_WRITE IPC branch (pty.handler.ts): user keystrokes are
   * the primary prompt-arrival rebuttal, and ActivityMonitor's threshold
   * (>2000B/3s of OUTPUT) never fires for a short text-only turn, so without
   * this feed the gate would drop every completion on exactly those panes.
   */
  /**
   * The INTERRUPT edge, fed by every path that writes operator input to a pty
   * in this process (the PTY_WRITE IPC branches for renderer keystrokes, the
   * input.send / input.sendKey RPC for MCP and CLI callers).
   *
   * Live finding (Claude Code 2.1.236): an interrupted turn fires NO Stop hook,
   * and `claude` stays the foreground command so OSC 133 cannot see it either —
   * the keystroke is the pane's only evidence that the turn ended.
   *
   * A pane with no open latch is left alone: a Ctrl+C in a plain shell is not a
   * turn end, and broadcasting there would be the byte heuristic's job anyway.
   */
  noteInterruptInput(ptyId: string, data: string): void {
    try {
      if (!this.interruptKeystrokes.observe(ptyId, data)) return;
      settleHookTurnToIdle(ptyId, this.getHookRouter?.() ?? null, this.getWindow());
    } catch (err) {
      console.warn('[PTYBridge] noteInterruptInput error:', err);
    }
  }

  noteUserInput(ptyId: string): void {
    const alarm = this.getAlarm?.() ?? null;
    if (!alarm) return;
    try {
      const lastAgent = this.agentDetectors.get(ptyId)?.getLastAgent() ?? '';
      const slug = agentDisplayToSlug(lastAgent);
      if (!slug) return; // nothing to key the gate to yet
      alarm.observe(ptyId, slug, { class: 'working' });
    } catch (err) {
      console.warn('[PTYBridge] noteUserInput alarm feed error:', err);
    }
  }

  /**
   * Flush all pending chunks for `ptyId`: run middlewares once and send a
   * single IPC frame to the renderer. Safe to call when there is nothing
   * pending.
   */
  private flushPending(ptyId: string): void {
    const chunks = this.pendingData.get(ptyId);
    if (!chunks || chunks.length === 0) return;
    const joined = chunks.length === 1 ? chunks[0] : chunks.join('');
    chunks.length = 0;

    try {
      this.runMiddlewares(ptyId, joined);
    } finally {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.PTY_DATA, ptyId, joined);
      }
    }
  }

  setupDataForwarding(ptyId: string): void {
    const instance = this.ptyManager.get(ptyId);
    if (!instance) return;
    if (this.oscParsers.has(ptyId)) {
      console.warn(`[PTYBridge] setupDataForwarding already active for ${ptyId} — skipping`);
      return;
    }

    this.ptyCreatedAt.set(ptyId, Date.now());
    this.activityMonitor.start(ptyId);

    // Surface process lifecycle to the EventBus for external tooling. Skip
    // PTYs that were created without a workspace context (CLI/tests) — those
    // can't be polled by workspace-scoped clients anyway.
    if (instance.workspaceId) {
      eventBus.emit({
        type: 'process.started',
        workspaceId: instance.workspaceId,
        ptyId,
        pid: instance.process.pid,
        shell: instance.shell,
      });
    }

    const oscParser = new OscParser();
    this.oscParsers.set(ptyId, oscParser);

    // OSC 7-sticky: flips true on the first OSC 7 from this PTY's shell and
    // never resets — from then on the prompt-scrape fallback below is skipped
    // (the hook re-emits on every prompt; scraping could only add false
    // positives, e.g. agent TUI output shaped like "user@host:path$").
    let oscCwdSeen = false;

    // Desktop-notification sequences (OSC 9/777/99). Stateful for OSC 99
    // chunk assembly, so it lives per-PTY alongside the OscParser. Captured
    // by the onOsc closure below; no separate cleanup needed — it dies with
    // the closure when the parser is dropped in cleanupInstance.
    const notificationParser = new TerminalNotificationParser();

    const agentDetector = new AgentDetector();
    this.agentDetectors.set(ptyId, agentDetector);

    // Handle OSC events
    oscParser.onOsc((event) => {
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;

      switch (event.code) {
        case 0:
        case 2: {
          // OSC 0 (icon + window title) / OSC 2 (window title) — e.g. Claude
          // Code's `/rename`. OSC 1 (icon name only) is intentionally ignored.
          const title = sanitizeTitle(event.data);
          if (title) win.webContents.send(IPC.TERMINAL_TITLE_CHANGED, ptyId, title);
          break;
        }
        case 7: {
          // OSC 7-sticky (2026-07-21): the hook is the authoritative cwd
          // source — permanently disable prompt scraping for this PTY so
          // screen text shaped like a prompt can never override it (twin of
          // the DaemonPTYBridge guard).
          oscCwdSeen = true;
          const cwd = parseOsc7Cwd(event.data);
          updateCwd(ptyId, cwd);
          win.webContents.send(IPC.CWD_CHANGED, ptyId, cwd);
          break;
        }
        case 9:
        case 99:
        case 777: {
          // Desktop-notification sequences, parsed per the frozen rules in
          // docs/internal/fable-window-schema-freeze.md §1 (ConEmu OSC 9
          // subcommand exclusion, OSC 777 `notify` gate, kitty OSC 99
          // chunk assembly + base64). Replaces the previous raw-payload
          // toast, which fired on ConEmu progress spam and showed
          // unsanitized kitty metadata as the body.
          const parsed = notificationParser.handle(event.code, event.data);
          if (!parsed) break;
          const notification = {
            type: 'info' as const,
            title: parsed.title ?? 'Terminal',
            body: parsed.body,
            category: 'terminal' as const,
          };
          dispatchNotification(win, ptyId, notification, { ptyId });
          // X1 — sidebar "latest notification" line (schema-freeze §2),
          // parity with DaemonNotificationRouter's fold.
          broadcastMetadataUpdate(win, {
            ptyId,
            lastNotificationText: {
              ts: Date.now(),
              title: parsed.title,
              body: parsed.body,
              source: parsed.source,
            },
          });
          // EventBus tee shared with daemon mode — see NotificationReceivedEvent.
          if (instance.workspaceId) {
            eventBus.emit({
              type: 'notification.received',
              workspaceId: instance.workspaceId,
              ptyId,
              source: parsed.source,
              title: parsed.title,
              body: parsed.body,
            });
          }
          break;
        }
        case 7727: {
          // Git branch update from shell hook — store in main process and notify renderer
          updateBranch(ptyId, event.data);
          win.webContents.send(IPC.GIT_BRANCH_CHANGED, ptyId, event.data);
          break;
        }
        case 133: {
          // OSC 133 shell integration — semantic prompt boundaries.
          //   A — prompt start (shell ready for user input)
          //   B — prompt end (prompt drawn)
          //   C — command start (Enter pressed, output follows)
          //   D[;<exitCode>] — command end (process finished)
          //
          // Only the D marker is teed to the EventBus today. It's a shell-
          // agnostic, latency-zero signal that any CLI (npm, pytest, make,
          // git...) emits when wrapped by shell integration. Orchestrators
          // can poll wmux_events_poll for `source:'osc133'` lifecycle events
          // instead of round-tripping through `terminal_read_events`, picking
          // up command exits ~1-2s before the regex-based AgentDetector would.
          //
          // OSC 133 doesn't identify the agent — it's a generic shell signal —
          // so `agent` is set to the detector's last-known agent slug for the
          // PTY when one is gated, otherwise null. Hook/detector lifecycle
          // events always carry a non-null agent; null is the discriminator
          // for "no agent context, but a shell command completed".
          //
          // Daemon-side PromptEventLog (src/daemon/PromptEventLog.ts) is the
          // authoritative byte-offset log used by `terminal_read_events`;
          // the EventBus tee here is a parallel projection for the
          // workspaceId-scoped poll path. The two streams may interleave but
          // never disagree about what happened — both parse the same OSC 133
          // bytes from the same PTY data path.
          const payload = event.data || '';
          const parts = payload.split(';');
          if (parts[0] === 'D' && instance.workspaceId) {
            let exitCode: number | null = null;
            if (parts.length > 1 && parts[1].length > 0) {
              const parsed = Number.parseInt(parts[1], 10);
              if (!Number.isNaN(parsed)) {
                exitCode = parsed;
              }
            }
            const agentSlug = agentDisplayToSlug(agentDetector.getLastAgent() ?? '') ?? null;
            eventBus.emit({
              type: 'agent.lifecycle',
              workspaceId: instance.workspaceId,
              ptyId,
              kind: 'agent.stop',
              source: 'osc133',
              agent: agentSlug,
              decision: 'emit',
              exitCode,
            });
          }
          break;
        }
      }
    });

    // Agent status events: emit METADATA_UPDATE (drives sidebar dot) and a
    // NOTIFICATION (drives unread badge + in-app toast + optional OS toast).
    // The 'waiting'/'complete' transition is the strong "task done" signal.
    const unsubAgent = agentDetector.onEvent((agentEvent) => {
      try {
        const win = this.getWindow();
        const status = agentEvent.status as AgentStatus;
        const slug = agentDisplayToSlug(agentEvent.agent);
        const hookRouter = this.getHookRouter?.() ?? null;
        // #935: the status broadcast is governed by the same hook authority as
        // the notification veto below. Claude's bypass-mode footer is on screen
        // for the WHOLE turn, so leaving the metadata ungated wrote a false
        // 'waiting' onto a working pane's roster row and into "N need you".
        // Identity (name/slug) still rides every event — only the lifecycle
        // status is withheld.
        const withholdStatus = hookRouter?.governsDetectorStatus(ptyId, slug, status) === true;
        broadcastMetadataUpdate(win, {
          ptyId,
          ...(withholdStatus ? {} : { agentStatus: status }),
          agentName: agentEvent.agent,
          // P2: carry the slug so the renderer builds the `(<agent>)` auto-name
          // suffix without importing the main-only display→slug map.
          agentSlug: agentDisplayToSlug(agentEvent.agent) ?? null,
        });
        // #935 direction 3: recorded at the broadcastMetadataUpdate funnel —
        // withheld statuses never reach `agentStatus` in that payload, so
        // they never land in the tracker either. No local bookkeeping needed.

        // Verdict-gate feed: a 'running' detection is working evidence — it
        // arms the turn gate on an ungoverned pane and clears `announced`
        // after a confirmed completion (the next turn's boundary). Keyed to
        // the detected slug; an agent-less running event has nothing to arm.
        const alarm = this.getAlarm?.() ?? null;
        if (status === 'running' && alarm && slug) {
          alarm.observe(ptyId, slug, { class: 'working' });
        }

        if (status === 'waiting' || status === 'complete' || status === 'awaiting_input') {
          this.lastAgentEventAt.set(ptyId, Date.now());

          // Hook-authority veto: while this pane has a live hook bridge for
          // the SAME agent, the hook's Stop signal is canonical and the
          // detector's footer heuristics must stay out of the user-visible
          // path entirely. Claude's status footer ("bypass permissions on",
          // "shift+tab to cycle") is visible MID-TURN, so without this veto
          // the detector both re-alerts while the agent is still working
          // AND pre-poisons the HookSignalRouter ledger so the real Stop
          // hook lands as 'dedup' → the true completion goes silent.
          // Skipping recordDetector + the EventBus tee here is the point:
          // the hook path emits the one canonical lifecycle event. The
          // metadata broadcast above rides the SAME rule now (#935) —
          // `governsDetectorStatus` withholds the lifecycle status while
          // still carrying identity, so the roster stops showing a working
          // pane as waiting.
          //
          // codex review catch (round 2): must NOT cover 'awaiting_input'.
          // Claude's hooks.json wires PreToolUse ONLY for the
          // AskUserQuestion tool — the far more common approval prompts
          // ("Do you want to proceed?", "Allow tool use for X", Claude's
          // default permission-mode Y/N gate) have NO hook at all;
          // AgentDetector's regex patterns (matched right below, in
          // `status`) are the ONLY signal source for those. Vetoing here
          // would leave an agent blocked on a real approval prompt
          // completely silent for the full authority TTL (30 minutes).
          // Same predicate the status broadcast above used — one expression of
          // the rule, so the two cannot drift apart. Inside this block the
          // status set is {waiting, complete, awaiting_input}, and
          // `governsDetectorStatus` covers exactly the first two.
          if (withholdStatus) {
            return;
          }

          const title = `${agentEvent.agent}: ${agentEvent.message}`;
          const body = status === 'awaiting_input'
            ? 'Awaiting input'
            : status === 'waiting' ? 'Ready for input' : 'Task finished';
          // The regex detector sees only terminal text, so it can never tell a
          // subagent turn from a main-agent one — everything that isn't an
          // approval prompt lands in 'agent-turn'. Subagent classification
          // requires the hook bridge (#516).
          const category = status === 'awaiting_input' ? 'approval' as const : 'agent-turn' as const;

          // The CONFIRMED fan-out — everything that must only fire on a real
          // turn end. The dedup-ledger write (recordDetector) deliberately
          // lives INSIDE this closure, not at arrival: in the detect-then-hook
          // race the detector's window is replaced by the hook's Stop before
          // it expires, and an arrival-time ledger entry would make the hook's
          // confirmed broadcast land as a stale 'dedup' — killing the toast
          // for a genuine completion. A dropped (rebutted / gate-missed)
          // candidate writes nothing to the ledger at all.
          const fanOutConfirmed = (): void => {
            dispatchNotification(win, ptyId, { type: 'agent', title, body, category }, { ptyId });

            // Tee to EventBus for external observers (orchestrator clients).
            // 'waiting' and 'complete' collapse to kind:'agent.stop' — they
            // represent the same user-visible event ("turn finished, ready
            // for next input"), matching the hook-side dedup mapping in
            // HookSignalRouter. 'awaiting_input' maps to its own kind so
            // orchestrators can distinguish "turn ended, send next task"
            // from "agent paused mid-turn, send y/N answer". Call
            // `recordDetector` before emitting so the ledger sees this side
            // of the dedup window: a hook+detector pair for the same turn
            // now resolves to one 'emit' and one 'dedup', not two emits.
            // Without this, an orchestrator filtering on `decision === 'emit'`
            // would re-run follow-up work twice on the standard
            // plugin-plus-detector setup. Skip when workspaceId is
            // unknown — same gate as the process.started emit above.
            if (instance.workspaceId) {
              if (slug) {
                const lifecycleKind = status === 'awaiting_input'
                  ? 'agent.awaiting_input' as const
                  : 'agent.stop' as const;
                const decision = hookRouter
                  ? hookRouter.recordDetector(slug, lifecycleKind, ptyId)
                  : 'emit';
                eventBus.emit({
                  type: 'agent.lifecycle',
                  workspaceId: instance.workspaceId,
                  ptyId,
                  kind: lifecycleKind,
                  source: 'detector',
                  agent: slug,
                  decision,
                });
              }
            }
          };

          // No verdict gate configured (tests) or nothing to key it to: the
          // legacy immediate path, unchanged.
          const cue = alarm && slug ? normalizeDetectorCue(status) : null;
          if (!alarm || !slug || !cue) {
            fanOutConfirmed();
            return;
          }

          // Hold a provisional window. A working cue (new tool output, user
          // input) inside it rebuts the candidate — no toast, no ledger. A
          // rejected candidate leaves an 'internal' trace only; the status
          // dot above already updated, which is the intended loose surface.
          const outcome = alarm.observe(ptyId, slug, cue, fanOutConfirmed);
          if (outcome === 'hold') {
            return;
          }
          if (instance.workspaceId) {
            eventBus.emit({
              type: 'agent.lifecycle',
              workspaceId: instance.workspaceId,
              ptyId,
              kind: status === 'awaiting_input'
                ? 'agent.awaiting_input' as const
                : 'agent.stop' as const,
              source: 'detector',
              agent: slug,
              decision: 'internal',
            });
          }
        }
      } catch (err) {
        console.warn('[PTYBridge] onEvent callback error:', err);
      }
    });

    // Activity-based 'running' signal: fires once per active cycle. PTYBridge
    // also resets AgentDetector's emission dedup state here so the next turn's
    // 'waiting' prompt fires again even if its text is byte-identical to the
    // previous turn (otherwise turn N+1 would be silently dropped).
    let resizeGuardTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubActive = this.activityMonitor.onActive((id) => {
      if (id !== ptyId) return;
      try {
        const lastAgent = agentDetector.getLastAgent() ?? '';
        // Verdict-gate working feed: sustained output is working evidence —
        // it rebuts a pending completion window and re-arms `announced` for
        // the next turn. Keyed to the pane's last detected agent; a pane with
        // no agent yet has nothing to arm. SKIPPED inside the resize-redraw
        // guard window (the daemon mirror flags this `likelyRepaint`): a
        // refit burst is not work, and letting it rebut would silently kill
        // a real completion alarm. No deferral here, unlike the detector
        // reset below — a deferred working cue landing 3s later would reset
        // `announced` on repaint noise and re-open the door to a duplicate
        // toast for an already-announced turn.
        const activeAlarm = this.getAlarm?.() ?? null;
        const activeSlug = agentDisplayToSlug(lastAgent);
        if (activeAlarm && activeSlug && !recentlyResized(ptyId, RESIZE_REDRAW_GUARD_MS)) {
          activeAlarm.observe(ptyId, activeSlug, { class: 'working' });
        }
        // Hook-governed pane: its bridge reports the turn START, so the
        // heuristic's guess is strictly worse than what the pane already
        // shows. Skipping the broadcast is the point — a redraw burst mid-turn
        // used to overwrite a correct 'complete'/'awaiting_input' with
        // 'running'. Everything else in this handler still runs: the alarm's
        // working cue above (byte activity is still real evidence for the
        // completion gate) and the detector's emission-dedup reset below.
        if (!this.getHookRouter?.()?.governsRunningState(ptyId)) {
          broadcastMetadataUpdate(this.getWindow(), {
            ptyId,
            agentStatus: 'running',
            agentName: lastAgent,
            // P2: slug alongside the periodic 'running' name ('' when no agent is
            // detected yet → agentDisplayToSlug returns undefined → null).
            agentSlug: agentDisplayToSlug(lastAgent) ?? null,
          });
        }
        // #935 direction 3: recorded at the broadcastMetadataUpdate funnel.
        // Resize-redraw guard: a workspace switch / split / zoom refits xterm,
        // fires pty:resize, and TUI agents answer with a multi-KB full redraw —
        // a burst indistinguishable from real activity. Resetting the emission
        // dedup on THAT burst lets the unchanged idle footer re-match and
        // re-fire a stale "Ready for input" for a pane where nothing happened.
        //
        // onActive fires EXACTLY ONCE per active-to-idle cycle (ActivityMonitor
        // re-arms it only on the next idle→active transition). So a plain
        // "skip the reset this one time" would permanently skip it for the
        // REST of this cycle too — if a genuinely new turn's output continues
        // streaming into the SAME cycle (no 5s idle gap between the resize
        // repaint and the real response), that turn's completion would never
        // get a fresh dedup state and would be silently deduped as a repeat
        // of the last-notified turn (codex review catch). Deferring the
        // reset to fire once the guard window elapses — rather than skipping
        // it outright — keeps the repaint itself from re-triggering while
        // still guaranteeing this cycle's real completion (which streams in
        // over at least one network round-trip, essentially always >3s) sees
        // a reset dedup state by the time it arrives.
        if (recentlyResized(ptyId, RESIZE_REDRAW_GUARD_MS)) {
          if (resizeGuardTimer) clearTimeout(resizeGuardTimer);
          resizeGuardTimer = setTimeout(() => {
            resizeGuardTimer = null;
            agentDetector.resetEmissionState();
          }, RESIZE_REDRAW_GUARD_MS);
        } else {
          agentDetector.resetEmissionState();
        }
      } catch (err) {
        console.warn('[PTYBridge] onActive callback error:', err);
      }
    });

    this.agentDetectorCleanups.set(ptyId, [
      unsubAgent,
      unsubActive,
      () => { if (resizeGuardTimer) clearTimeout(resizeGuardTimer); },
    ]);

    // Detect CWD from shell prompt patterns (PowerShell: "PS C:\path>", bash: "user@host:~/path$").
    // Parsing lives in ./cwdDetect (pure + unit-tested); see detectPromptCwd for
    // why the LAST prompt in the buffer is the live one.
    // eslint-disable-next-line no-control-regex
    const ansiStripRegex = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[?]?[0-9;]*[hlm]/g;
    let lastDetectedCwd = '';
    let promptBuffer = '';

    // --- Register per-instance middlewares ---

    // 1. Activity monitor
    this.addMiddleware(ptyId, (data) => {
      this.activityMonitor.feed(ptyId, data.length);
    });

    // 2. OSC parser
    this.addMiddleware(ptyId, (data) => {
      oscParser.process(data);
    });

    // 3. Agent detector
    this.addMiddleware(ptyId, (data) => {
      agentDetector.feed(data);
    });

    // 4. Prompt buffer + CWD detection — fallback for shells WITHOUT the
    // integration hook only (see oscCwdSeen above).
    this.addMiddleware(ptyId, (data) => {
      if (oscCwdSeen) return;
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;

      promptBuffer += data;
      if (promptBuffer.length > 1024) promptBuffer = promptBuffer.slice(-512);

      const clean = promptBuffer.replace(ansiStripRegex, '');
      const detectedCwd = detectPromptCwd(clean);
      if (detectedCwd !== null) {
        if (detectedCwd !== lastDetectedCwd) {
          lastDetectedCwd = detectedCwd;
          updateCwd(ptyId, detectedCwd);
          win.webContents.send(IPC.CWD_CHANGED, ptyId, detectedCwd);
        }
        promptBuffer = '';
      }
    });

    instance.process.onData((data: string) => {
      // Micro-batch: enqueue this chunk and (re)arm a short flush timer.
      // Middlewares + IPC send are deferred to the flush so a torrent of
      // small chunks collapses into one pass. Backpressure here is what
      // breaks the previous "5 sync middlewares per chunk" hot loop.
      let chunks = this.pendingData.get(ptyId);
      if (!chunks) {
        chunks = [];
        this.pendingData.set(ptyId, chunks);
      }
      chunks.push(data);

      if (!this.pendingTimers.has(ptyId)) {
        const timer = setTimeout(() => {
          this.pendingTimers.delete(ptyId);
          try {
            this.flushPending(ptyId);
          } catch (err) {
            console.error('[PTYBridge] Error processing data:', err);
            // Best-effort: drain any remaining bytes raw to the renderer so
            // we never lose user-visible output even if a middleware threw.
            const remaining = this.pendingData.get(ptyId);
            if (remaining && remaining.length > 0) {
              const joined = remaining.length === 1 ? remaining[0] : remaining.join('');
              remaining.length = 0;
              const win = this.getWindow();
              if (win && !win.isDestroyed()) {
                win.webContents.send(IPC.PTY_DATA, ptyId, joined);
              }
            }
          }
        }, PTYBridge.BATCH_INTERVAL_MS);
        this.pendingTimers.set(ptyId, timer);
      }
    });

    instance.process.onExit(({ exitCode, signal }) => {
      // Drain any buffered output before signalling exit so the renderer
      // sees the final lines (e.g. exit banner) before PTY_EXIT.
      this.flushPending(ptyId);

      // Surface process exit to the EventBus before cleanup wipes our state.
      if (instance.workspaceId) {
        eventBus.emit({
          type: 'process.exited',
          workspaceId: instance.workspaceId,
          ptyId,
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          ...(typeof signal === 'number' ? { signal: String(signal) } : {}),
        });
      }

      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.PTY_EXIT, ptyId, exitCode);

        // Clear agentStatus so the sidebar dot stops claiming the agent is
        // still running/waiting after the process is gone. 'idle' is the
        // explicit absence-of-agent state — MiniSidebar hides the dot.
        //
        // pendingQuestion goes with it: the process is GONE, so nothing is
        // waiting for an answer. A terminal exit only prints a marker and does
        // not close the surface, so without this the pane keeps advertising a
        // question on `pane_list` forever. Cleared here — on the explicit
        // process-end — and NOT on generic idle transitions, where a genuinely
        // blocked pane may simply have gone quiet.
        broadcastMetadataUpdate(win, { ptyId, agentStatus: 'idle', agentName: '', pendingQuestion: '' });

        if (exitCode !== 0) {
          const elapsed = Date.now() - (this.ptyCreatedAt.get(ptyId) ?? Date.now());
          const seconds = Math.round(elapsed / 1000);
          const notification = {
            type: 'error' as const,
            title: 'Process exited with error',
            body: `Exit code ${exitCode} after ${seconds}s`,
            category: 'system' as const,
          };
          dispatchNotification(win, ptyId, notification, { ptyId });
        }
      }
      this.cleanupInstance(ptyId);
    });
  }
}
