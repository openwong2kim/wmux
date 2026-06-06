import { BrowserWindow } from 'electron';
import { PTYManager } from './PTYManager';
import { OscParser } from './OscParser';
import { AgentDetector, agentDisplayToSlug } from './AgentDetector';
import { ActivityMonitor } from './ActivityMonitor';
import { parseOsc7Cwd, detectPromptCwd } from './cwdDetect';
import { toastManager } from '../pipe/handlers/notify.rpc';
import { IPC } from '../../shared/constants';
import { updateCwd, removeCwd, updateBranch, removeBranch, broadcastMetadataUpdate } from '../ipc/handlers/metadata.handler';
import { sendNotification } from '../notification/sendNotification';
import { recentlySuppressed, clearPty as clearSuppression } from '../notification/idleSuppression';
import { eventBus } from '../events/EventBus';
import type { HookSignalRouter } from '../hooks/HookSignalRouter';
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
      const lastAgentAt = this.lastAgentEventAt.get(ptyId) ?? 0;
      if (now - lastAgentAt < AGENT_EVENT_SUPPRESSION_MS) return;
      // Suppress the activity fallback when the recent burst was actually
      // a pty:resize redraw (workspace switch) or user keystroke echo —
      // both spike ActivityMonitor's byte counter without being a real
      // agent task ending. See idleSuppression.ts for rationale.
      if (recentlySuppressed(ptyId, now)) return;
      try {
        const win = this.getWindow();
        // Clear stale 'running' before emitting the generic notification.
        broadcastMetadataUpdate(win, { ptyId, agentStatus: 'idle', agentName: '' });
        const notification = {
          type: 'agent' as const,
          title: 'Task may have finished',
          body: 'Terminal output stopped after active period',
        };
        sendNotification(win, ptyId, notification);
        toastManager.show(notification.title, notification.body);
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

    this.ptyManager.remove(ptyId);
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

    const agentDetector = new AgentDetector();
    this.agentDetectors.set(ptyId, agentDetector);

    // Handle OSC events
    oscParser.onOsc((event) => {
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;

      switch (event.code) {
        case 7: {
          const cwd = parseOsc7Cwd(event.data);
          updateCwd(ptyId, cwd);
          win.webContents.send(IPC.CWD_CHANGED, ptyId, cwd);
          break;
        }
        case 9:
        case 99: {
          const notification = { type: 'info' as const, title: 'Terminal', body: event.data };
          sendNotification(win, ptyId, notification);
          toastManager.show(notification.title, notification.body);
          break;
        }
        case 777: {
          const parts = event.data.split(';');
          const title = parts[1] || 'Notification';
          const body = parts.slice(2).join(';') || '';
          const notification = { type: 'info' as const, title, body };
          sendNotification(win, ptyId, notification);
          toastManager.show(title, body);
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

    // Critical action detection (kept — this is precise and valuable)
    const unsubCritical = agentDetector.onCritical((criticalEvent) => {
      try {
        const win = this.getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send(IPC.APPROVAL_REQUEST, ptyId, {
          action: criticalEvent.action,
          riskLevel: criticalEvent.riskLevel,
        });
      } catch (err) {
        console.warn('[PTYBridge] onCritical callback error:', err);
      }
    });

    // Agent status events: emit METADATA_UPDATE (drives sidebar dot) and a
    // NOTIFICATION (drives unread badge + in-app toast + optional OS toast).
    // The 'waiting'/'complete' transition is the strong "task done" signal.
    const unsubAgent = agentDetector.onEvent((agentEvent) => {
      try {
        const win = this.getWindow();
        const status = agentEvent.status as AgentStatus;
        broadcastMetadataUpdate(win, {
          ptyId,
          agentStatus: status,
          agentName: agentEvent.agent,
        });

        if (status === 'waiting' || status === 'complete' || status === 'awaiting_input') {
          this.lastAgentEventAt.set(ptyId, Date.now());
          const title = `${agentEvent.agent}: ${agentEvent.message}`;
          const body = status === 'awaiting_input'
            ? 'Awaiting input'
            : status === 'waiting' ? 'Ready for input' : 'Task finished';
          sendNotification(win, ptyId, { type: 'agent', title, body });
          toastManager.show(title, body);

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
          // plugin-plus-detector setup. The existing sendNotification/toast
          // above is unchanged — that dedup gate lives in the hook path,
          // not here, and is pre-existing scope. Skip when workspaceId is
          // unknown — same gate as the process.started emit above.
          if (instance.workspaceId) {
            const slug = agentDisplayToSlug(agentEvent.agent);
            if (slug) {
              const lifecycleKind = status === 'awaiting_input'
                ? 'agent.awaiting_input' as const
                : 'agent.stop' as const;
              const hookRouter = this.getHookRouter?.() ?? null;
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
        }
      } catch (err) {
        console.warn('[PTYBridge] onEvent callback error:', err);
      }
    });

    // Activity-based 'running' signal: fires once per active cycle. PTYBridge
    // also resets AgentDetector's emission dedup state here so the next turn's
    // 'waiting' prompt fires again even if its text is byte-identical to the
    // previous turn (otherwise turn N+1 would be silently dropped).
    const unsubActive = this.activityMonitor.onActive((id) => {
      if (id !== ptyId) return;
      try {
        const lastAgent = agentDetector.getLastAgent() ?? '';
        broadcastMetadataUpdate(this.getWindow(), {
          ptyId,
          agentStatus: 'running',
          agentName: lastAgent,
        });
        agentDetector.resetEmissionState();
      } catch (err) {
        console.warn('[PTYBridge] onActive callback error:', err);
      }
    });

    this.agentDetectorCleanups.set(ptyId, [unsubCritical, unsubAgent, unsubActive]);

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

    // 4. Prompt buffer + CWD detection
    this.addMiddleware(ptyId, (data) => {
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
        broadcastMetadataUpdate(win, { ptyId, agentStatus: 'idle', agentName: '' });

        if (exitCode !== 0) {
          const elapsed = Date.now() - (this.ptyCreatedAt.get(ptyId) ?? Date.now());
          const seconds = Math.round(elapsed / 1000);
          const notification = {
            type: 'error' as const,
            title: 'Process exited with error',
            body: `Exit code ${exitCode} after ${seconds}s`,
          };
          sendNotification(win, ptyId, notification);
          toastManager.show(notification.title, notification.body);
        }
      }
      this.cleanupInstance(ptyId);
    });
  }
}
