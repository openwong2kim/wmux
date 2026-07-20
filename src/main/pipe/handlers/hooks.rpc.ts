// hooks.signal RPC handler.
//
// Receives an AgentSignal envelope from `integrations/<agent>/bin/wmux-bridge.mjs`
// (or any future bridge), resolves cwd → ptyId via workspace.list, then
// hands off to HookSignalRouter for dedup. On 'emit' decisions, calls
// sendNotification so the renderer fan-out (toast/sound/ring/etc.) fires.
//
// Authentication is handled at the PipeServer layer (see PipeServer.ts —
// every connection must present WMUX_AUTH_TOKEN read from ~/.wmux-auth-token).
// By the time a request reaches this handler, the caller is trusted.
//
// ASCII flow:
//
//   Claude Code Stop event
//      │
//      ▼
//   integrations/claude/bin/wmux-bridge.mjs
//      │ reads ~/.wmux-auth-token, opens main pipe
//      │ sends RPC: hooks.signal { kind, agent, cwd, ts, payload, ... }
//      ▼
//   PipeServer.verifyAuth → ok
//      │
//      ▼
//   RpcRouter.dispatch('hooks.signal') → THIS HANDLER
//      │ 1. isAgentSignal(params) validate
//      │ 2. meter.recordSignal(agent, fireTs) — workspace-match-agnostic
//      │    (Codex P1#2: surface plugin health even for cwds outside any
//      │    wmux workspace)
//      │ 3. resolve cwd → {workspaceId, ptyId} via workspace.list
//      │ 4. meter.recordWorkspaceMatch(ptyId != null) — separate counter
//      │ 5. if matched: forward token usage, run dedup, emit notification
//      │    if not matched: respond with no-workspace-match
//      ▼
//   Response: { ok: true } or { ok: false, reason: '...' }
//
// Separately, registerHooksRpc subscribes to meter.onStatsChange and
// pushes LatencyStats snapshots to the renderer via
// IPC.SIGNAL_HEALTH_UPDATE (1Hz throttle). The renderer feeds them into
// uiSlice.setHookSignalHealth for the Settings → Claude integration card.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import { dispatchNotification } from '../../notification/dispatchNotification';
import { broadcastMetadataUpdate } from '../../ipc/handlers/metadata.handler';
import type { HookSignalRouter } from '../../hooks/HookSignalRouter';
import { HookFloodMeter, describeHookFlood } from '../../hooks/HookFloodMeter';
import { eventBus } from '../../events/EventBus';
import { IPC, dataSuffix } from '../../../shared/constants';
import { summarizeActivity } from '../../../shared/activitySummary';
import type { DaemonClient } from '../../DaemonClient';
import type { ResumeBinding, PermissionMode } from '../../../shared/agentResume';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  isAgentSignal,
  type AgentSignal,
  type HookSignalResponse,
} from '../../../../integrations/shared/signal-types';

type GetWindow = () => BrowserWindow | null;

/** X6 ③: known permission modes, for validating the bridge's payload field. */
const VALID_PERMISSION_MODES: ReadonlySet<string> = new Set([
  'bypassPermissions',
  'acceptEdits',
  'plan',
  'default',
]);

function readPermissionMode(payload: Record<string, unknown>): PermissionMode | undefined {
  const m = payload?.permissionMode;
  return typeof m === 'string' && VALID_PERMISSION_MODES.has(m) ? (m as PermissionMode) : undefined;
}

/**
 * X6 ③ (codex P2): durable spool written by MAIN when the daemon.setResumeBinding
 * relay can't land (daemon down / restarting). The bridge already spools when the
 * MAIN pipe is down; this closes the symmetric hole where main is up and resolved
 * the pane but the daemon isn't reachable. Same record shape + ptyId key + atomic
 * temp→rename + don't-replace-newer rule the daemon's ingest expects. Writes under
 * the suffix-aware ~/.wmux dir the daemon actually reads (main owns WMUX_DATA_SUFFIX,
 * unlike the bridge). Best-effort: never throws into the hook path.
 */
function writeMainResumeSpool(ptyId: string, binding: ResumeBinding): void {
  try {
    const dir = path.join(os.homedir(), `.wmux${dataSuffix()}`, 'resume-spool');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safe = String(ptyId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    if (!safe) return;
    const file = path.join(dir, `${safe}.json`);
    const tmp = path.join(dir, `${safe}.${process.pid}.${Date.now()}.json.tmp`);
    const record = {
      ptyId,
      agent: binding.agent,
      sessionId: binding.sessionId,
      cwd: binding.cwd,
      ts: binding.ts,
      ...(binding.permissionMode ? { permissionMode: binding.permissionMode } : {}),
      ...(binding.transcriptPath ? { transcriptPath: binding.transcriptPath } : {}),
    };
    fs.writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    try {
      if (fs.existsSync(file)) {
        const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof existing?.ts === 'number' && existing.ts > record.ts) {
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          return;
        }
      }
    } catch { /* replace a corrupt existing spool */ }
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[hooks.signal] main resume-spool write failed: ${String(err)}`);
  }
}

interface WorkspaceListEntry {
  id: string;
  name: string;
  metadata?: { cwd?: string | null };
  activePtyId?: string | null;
  ptyIds?: string[];
}

// RCA (2026-05-29 dogfood, bridge.log): the handler used to do a renderer
// `workspace.list` round-trip on EVERY hook signal. PostToolUse fires per
// tool call, so a tool-heavy turn — especially with the window backgrounded
// (Chromium throttles renderer timers/IPC) or the renderer busy flushing a
// large terminal buffer — made every hook's round-trip (sendToRenderer
// default 5s) exceed the bridge's 2s hard timeout. Result: bridge.log floods
// with `timeout` (~11.6% of signals, 94% PostToolUse) and notifications /
// token-tracking silently drop; in the worst bursts the daemon event loop is
// blocked enough that daemon.ping fails 3× and the main-process supervisor
// force-respawns the daemon. The workspace tree changes far less often than
// hooks fire, so we serve a short-TTL cache and coalesce concurrent fetches
// into a single round-trip, and fall back to the last-known list when a
// refresh times out (renderer throttled) rather than dropping the hook.
export const WORKSPACE_LIST_CACHE_TTL_MS = 2_000;
// Keep the per-fetch cap under the bridge's HOOK_TIMEOUT_MS (2s) so a cache
// miss against a slow renderer still returns (stale) before the bridge bails.
const WORKSPACE_LIST_FETCH_TIMEOUT_MS = 1_500;

// Env-routed fast path (Fix B): the longest a peeked (un-refreshed) workspace
// list may be trusted for routing a hook that carries WMUX_PTY_ID. Beyond it,
// the handler falls back to a blocking fetch rather than routing off an
// arbitrarily stale map (codex P0 #3). Comfortably above the TTL so the fast
// path stays hot under normal load (prime() refreshes at ~TTL); only a renderer
// unresponsive for >STALE_TRUST_MS forces the blocking path.
export const STALE_TRUST_MS = 10_000;

// Observability (HookFloodMeter): a hook is "degraded" when its workspace.list
// resolution took longer than this — i.e. it missed the cache and the renderer
// was slow to answer (the flood precursor). Logged in a rolling summary.
const HOOK_DEGRADED_FETCH_MS = 500;
const HOOK_FLOOD_LOG_INTERVAL_MS = 30_000;

// Fleet View activity line (fleet-activity-line-hook.md): PostToolUse
// (`agent.activity`) fires on EVERY tool call, so a tool-heavy turn = many per
// second per agent. We rate-limit the activity broadcast with the MINIMUM
// machinery: a per-ptyId LEADING-EDGE timestamp throttle. On each activity, if
// `now - (lastSent.get(ptyId) ?? 0) >= ACTIVITY_THROTTLE_MS` we broadcast +
// stamp; else we drop. No timers, no EventBus subscription, no process.exited
// sweep — the only residue is a `number` per dead ptyId (microscopic), cleared
// wholesale on handler teardown. (eng-review + adversarial review decision: a
// trailing throttler-instance map would need timers + a leaky sweep for no
// real gain over `tail`'s plain 750ms renderer poll.)
export const ACTIVITY_THROTTLE_MS = 3_000;

/**
 * Register `hooks.signal` on the router. Must be called once at boot
 * (main/index.ts) after both the PipeServer and HookSignalRouter exist.
 *
 * `getWindow` returns the active BrowserWindow so we can:
 *   a) call workspace.list via sendToRenderer to resolve cwd
 *   b) call sendNotification with the resolved ptyId
 *   c) push SIGNAL_HEALTH_UPDATE snapshots
 *
 * Returns an unsubscribe function that detaches the signal-health
 * listener. The caller (main/index.ts) MUST invoke it on shutdown so
 * HMR / test teardown does not leak subscriptions. Idempotent on
 * repeated invocation.
 */
export function registerHooksRpc(
  router: RpcRouter,
  getWindow: GetWindow,
  hookRouter: HookSignalRouter,
  getDaemonClient?: () => DaemonClient | null,
  // M2: fired once per resolved claude `agent.stop`, carrying the workspace that
  // owns the pane. main resolves it to the bound account and hook-gates a usage
  // probe. Kept as a decoupled callback so this handler stays account-agnostic.
  onClaudeTurnEnd?: (workspaceId: string) => void,
): () => void {
  const meter = hookRouter.getLatencyMeter();
  // Short-TTL, coalescing cache so a burst of hooks in one turn collapses to
  // a single workspace.list round-trip (see WORKSPACE_LIST_CACHE_TTL_MS note).
  const workspaceCache = createWorkspaceListCache(() => safeListWorkspaces(getWindow));

  // Fleet activity leading-edge throttle: ptyId → lastSentMs. Scoped to this
  // registration (like workspaceCache/floodMeter) so it lives for the handler's
  // lifetime and is cleared wholesale on the returned cleanup — no per-ptyId GC
  // needed (see ACTIVITY_THROTTLE_MS).
  const activityLastSent = new Map<string, number>();

  // Observability: surface a hook-RPC flood in the main log (postmortem
  // visible) by tallying slow/failed workspace.list resolutions per window.
  const floodMeter = new HookFloodMeter();
  const floodTimer = setInterval(() => {
    const summary = floodMeter.flush(HOOK_FLOOD_LOG_INTERVAL_MS);
    if (!summary) return;
    const { level, message } = describeHookFlood(summary);
    if (level === 'warn') console.warn(message);
    else console.log(message);
  }, HOOK_FLOOD_LOG_INTERVAL_MS);
  // Never keep the process alive for the flood logger.
  floodTimer.unref?.();

  router.register('hooks.signal', async (params): Promise<HookSignalResponse> => {
    // 1. Envelope validation. Reject anything that doesn't match the
    //    canonical shape — bridges from older wmux versions, malformed
    //    JSON survivors, etc.
    if (!isAgentSignal(params)) {
      return { ok: false, reason: 'invalid-envelope' };
    }
    const signal: AgentSignal = params;

    // 2. Latency observability runs BEFORE workspace match so that
    //    plugin signals from cwds outside any wmux workspace still
    //    count toward "plugin is alive" (Codex P1#2). The workspace
    //    match outcome is tracked as a separate counter below.
    meter.recordSignal(signal.agent, signal.ts);

    // 3. Resolve signal → ptyId. Env-first (workspaceId/surfaceId from
    //    WMUX_* env vars that wmux PTYManager injects into the shell)
    //    with cwd matching as the fallback for sessions started outside
    //    a wmux pane. The workspace list comes from a short-TTL coalescing
    //    cache (NOT a fresh round-trip per hook — that flooded the bridge
    //    with 2s timeouts under load; see the cache note above).
    // Env-routed fast path (Fix B) lives in resolveWorkspacesForSignal: an
    // in-pane hook carrying WMUX_PTY_ID routes from a fresh-enough last-known
    // list without a renderer round-trip (that round-trip is exactly what a
    // large-buffer flush storm starves, timing out the bridge's 2s cap). See
    // that function for the topology-stability + bounded-staleness rules.
    const { workspaces, fetchMs, fastPathed } = await resolveWorkspacesForSignal(signal, workspaceCache);
    floodMeter.record({ degraded: fetchMs > HOOK_DEGRADED_FETCH_MS || !workspaces, fetchMs, fastPathed });
    if (!workspaces) {
      // Record as a miss because we couldn't determine match either
      // way — better than silently skewing the counter to "matched".
      meter.recordWorkspaceMatch(false);
      return { ok: false, reason: 'internal-error' };
    }

    const ptyId = resolvePtyIdForSignal(signal, workspaces);
    meter.recordWorkspaceMatch(ptyId != null);
    if (!ptyId) {
      // No wmux workspace owns this cwd. Bridge fired but the user's
      // Claude Code session is running OUTSIDE any wmux-managed dir.
      // This is expected when Claude is used standalone; we just drop
      // the per-pane notification. Signal health (above) still records.
      return { ok: false, reason: 'no-workspace-match' };
    }

    // Hook authority: EVERY resolved bridge signal (emit-class or not —
    // SessionStart and per-tool agent.activity count) marks this pane as
    // hook-governed for this agent. PTYBridge / DaemonNotificationRouter
    // consult isGovernedFor before fanning out detector-sourced
    // notifications: while the bridge is alive, its Stop/awaiting_input
    // signals are canonical and the detector's footer heuristics (which
    // match Claude's ALWAYS-visible status footer and would both re-alert
    // mid-turn and pre-poison the dedup ledger against the real Stop) are
    // notification-suppressed. Detector metadata/status broadcasts are
    // unaffected. See HOOK_AUTHORITY_TTL_MS for staleness.
    hookRouter.touchAuthority(ptyId, signal.agent);

    // X6 ③: persist the resume binding for session-LIFECYCLE kinds. This runs
    // BEFORE the isEmitKind gate below, which drops SessionStart for the
    // notification path — but SessionStart is a key live-capture point (the
    // earliest the origin id is known). Fire-and-forget: the daemon does the
    // durable saveImmediate, and the hook's 2s budget must never block on it.
    // agentSessionId is the #12235-safe origin id (transcript basename) the
    // bridge derived; cwd + permissionMode complete the binding (F5/F7).
    if (
      (signal.kind === 'agent.session_start'
        || signal.kind === 'agent.stop'
        || signal.kind === 'agent.subagent_stop')
      && signal.agentSessionId
    ) {
      const permissionMode = readPermissionMode(signal.payload);
      const transcriptPath = typeof signal.payload?.transcript_path === 'string'
        ? signal.payload.transcript_path
        : undefined;
      const resumeBinding: ResumeBinding = {
        agent: signal.agent,
        sessionId: signal.agentSessionId,
        cwd: signal.cwd,
        ...(permissionMode ? { permissionMode } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ts: signal.ts,
      };
      const client = getDaemonClient?.();
      if (client) {
        client
          .rpc('daemon.setResumeBinding', { id: ptyId, resumeBinding }, { timeoutMs: WORKSPACE_LIST_FETCH_TIMEOUT_MS })
          // codex P2: the relay is fire-and-forget, so a daemon down/restarting
          // here would lose the capture entirely (the bridge already saw ok). Spool
          // it from main so the daemon reconciles it on its next boot/connect.
          .catch((err) => {
            console.warn(`[hooks.signal] setResumeBinding failed, spooling: ${String(err)}`);
            writeMainResumeSpool(ptyId, resumeBinding);
          });
      } else {
        // No daemon client (daemon down / not yet connected) — spool directly.
        writeMainResumeSpool(ptyId, resumeBinding);
      }
    }

    // (Per-pane token usage forwarding was removed in B6: the StatusBar token
    // chip it fed was discarded as an unreliable, partly-heuristic display.
    // The bridge may still embed a `usage` block in the payload — it is simply
    // ignored here now. Signal-health recording above is unaffected.)

    // Fleet View activity line (fleet-activity-line-hook.md). PostToolUse maps
    // to `agent.activity` and the bridge already ships the full Claude payload
    // (tool_name/tool_input) — currently discarded at the isEmitKind early-return
    // below. We surface it as a per-pane "what is this agent doing" string via
    // the SAME metadata funnel the renderer already consumes (no new RPC/IPC).
    //
    // This is purely ADDITIVE and sits BEFORE the early-return: it does NOT
    // touch the dedup ledger, does NOT emit to the EventBus, and does NOT call
    // sendNotification. Activity is per-ptyId only (never workspace state).
    // Throttled leading-edge per ptyId (see ACTIVITY_THROTTLE_MS) so a tool-heavy
    // turn doesn't flood IPC. ptyId is already guaranteed non-null here (the
    // !ptyId early-return ran above).
    if (signal.kind === 'agent.activity') {
      const now = Date.now();
      const lastSent = activityLastSent.get(ptyId) ?? 0;
      if (now - lastSent >= ACTIVITY_THROTTLE_MS) {
        activityLastSent.set(ptyId, now);
        const activity = summarizeActivity(signal.payload?.tool_name, signal.payload?.tool_input);
        const win = getWindow();
        if (win) {
          broadcastMetadataUpdate(win, { ptyId, activity });
        }
      }
    }

    // Codex review catch: PostToolUse populates surfaceActivity (+ its
    // freshness stamp), but nothing ever cleared it. A turn that ends
    // without the final prompt matching the detector (hook-only agents, or
    // any turn once the hook-authority veto suppresses the detector) left
    // Fleet View showing the pane as "running: <last tool>" for the full
    // HOOK_RUNNING_TTL_MS (120s) after the turn was actually done — a stale
    // status that reads as "still working" right when it finished. Clear on
    // agent.stop (the turn definitively ended) and agent.session_start
    // (fresh session on this ptyId — a previous session's tool label must
    // not leak in). NOT on agent.subagent_stop: a Task-tool subagent
    // finishing happens WITHIN the parent turn, which may still have more
    // tool calls coming — clearing there would erase live activity.
    // `activity: ''` is the established clear signal (setSurfaceActivity
    // deletes both the string and its freshness timestamp on a falsy value).
    if (signal.kind === 'agent.stop' || signal.kind === 'agent.session_start') {
      const win = getWindow();
      if (win) {
        broadcastMetadataUpdate(win, { ptyId, activity: '' });
      }
    }

    // 4. Emit decision. PostToolUse / SessionStart never produce a
    //    toast (would be spam — codex round-2 P1 #5). They also
    //    DO NOT write to the dedup ledger (claude review 2026-05-23
    //    P2 #6) because a no-emit ledger entry would silently block
    //    a same-kind detector emission for 10s with no benefit. Only
    //    emit-class kinds participate in dedup.
    const isEmitKind = signal.kind === 'agent.stop'
      || signal.kind === 'agent.subagent_stop'
      || signal.kind === 'agent.awaiting_input';
    if (!isEmitKind) {
      return { ok: true };
    }

    const decision = hookRouter.recordHook(signal, ptyId);

    // 5. Tee to EventBus for external observers (orchestrator clients via
    //    `wmux_events_poll`). Emits BOTH 'emit' and 'dedup' decisions so
    //    a forensic consumer can see the dedup ledger's behavior; the
    //    fan-out notification below is the only side effect gated on
    //    `decision === 'emit'`.
    //
    //    NOTE: This is additive at the EVENT-TEE level but the wider PR
    //    also wires detector emits into the ledger (PTYBridge.onEvent +
    //    DaemonNotificationRouter), which activates `recordHook`'s
    //    detector-dedup branch (HookSignalRouter.ts L109). Before this
    //    PR, `recordDetector` had no production caller and that branch
    //    was effectively dead code. After: when the detector fires
    //    ~50-100ms ahead of the hook (typical), the hook now returns
    //    'dedup' and the `if (decision === 'dedup') return` above
    //    suppresses the SECOND sendNotification for the same turn.
    //    This collapses a latent double-toast that was always possible
    //    when hook+detector both ran, and is the intended consequence
    //    of round-2 cross-model review feedback — not an accident.
    //    SIGNAL_HEALTH_UPDATE is unchanged.
    //
    //    Carries ptyId only (no paneId). The workspaceId attached here is
    //    the one that owns the resolved ptyId — needed so events.poll
    //    workspace filtering works for orchestrator clients scoped to a
    //    single claimed workspace.
    const workspaceId = findWorkspaceIdForPty(ptyId, workspaces);
    if (workspaceId) {
      eventBus.emit({
        type: 'agent.lifecycle',
        workspaceId,
        ptyId,
        kind: signal.kind,
        source: 'hook',
        agent: signal.agent,
        decision,
      });
      // M2: a claude turn just ended in this workspace — the usage number for its
      // bound account may have moved. Hook-gate a per-account probe (main applies
      // the enabled/cooldown/inflight gates). Fires on BOTH emit and dedup: the
      // turn genuinely ended regardless of which signal source won the toast.
      if (signal.kind === 'agent.stop' && signal.agent === 'claude') {
        onClaudeTurnEnd?.(workspaceId);
      }
    }

    if (decision === 'dedup') {
      // Hook arrived too late — detector already emitted. We measured
      // the latency (above) but don't fan out a second time.
      return { ok: true };
    }

    // dispatchNotification: renderer alive → IPC only (its policy decides
    // every surface INCLUDING the OS toast — hook completions finally get
    // one); renderer gone → direct-toast fallback so the completion isn't
    // silently lost during a window teardown.
    dispatchNotification(
      getWindow(),
      ptyId,
      { type: 'agent', title: titleFor(signal), body: bodyFor(signal) },
      { ptyId },
    );
    const win = getWindow();
    if (win) {
      // Hook path (unlike the detector path in DaemonNotificationRouter) does
      // not otherwise touch agentStatus. For awaiting_input, set it so the
      // sidebar dot turns yellow — the part users see at a glance.
      if (signal.kind === 'agent.awaiting_input') {
        broadcastMetadataUpdate(win, { ptyId, agentStatus: 'awaiting_input' });
      }
    }
    return { ok: true };
  });

  // ─── Signal-health push to renderer ─────────────────────────────────────
  //
  // Subscribe once. Every recordSignal / recordWorkspaceMatch fires the
  // listener with a fresh stats snapshot. Wrap in a 1Hz leading+trailing
  // throttle so burst events (a tool-call-heavy turn) don't flood the
  // renderer with redundant IPC traffic; the user-visible card refreshes
  // at most once per second, which is well below the human perception
  // threshold and well above the renderer's measured re-render cost.
  const throttledPush = throttle1Hz((stats) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.SIGNAL_HEALTH_UPDATE, stats);
    }
  });
  const unsubscribe = meter.onStatsChange(throttledPush);

  // Push the current snapshot once so a freshly-reloaded renderer
  // doesn't sit with an empty/stale uiSlice until the next hook fires.
  // Same guard as the throttled handler — getWindow() may not be ready
  // yet at registration time (registerHooksRpc runs before BrowserWindow
  // is fully constructed in main/index.ts), in which case the next real
  // signal will populate it.
  const initialWin = getWindow();
  if (initialWin && !initialWin.isDestroyed()) {
    initialWin.webContents.send(IPC.SIGNAL_HEALTH_UPDATE, meter.getStats());
  }

  return () => {
    unsubscribe();
    throttledPush.cancel();
    clearInterval(floodTimer);
    // Drop the activity throttle state wholesale (no per-ptyId sweep needed).
    activityLastSent.clear();
  };
}

/**
 * 1Hz leading + trailing throttle. Inline so this handler stays
 * dependency-free (no lodash pull-in for one tiny helper).
 *
 * Behavior:
 *  - Leading: first call fires immediately.
 *  - Trailing: if more calls arrive within the 1s window, the LAST one
 *    fires once the window closes. Intermediate values are dropped —
 *    safe because each LatencyStats snapshot is a full state replacement,
 *    not a delta.
 *  - cancel() clears any pending trailing fire (used at unsubscribe).
 */
function throttle1Hz<T>(fn: (arg: T) => void): ((arg: T) => void) & { cancel: () => void } {
  const WINDOW_MS = 1000;
  let lastFiredAt = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingArg: T | null = null;

  const wrapped = ((arg: T): void => {
    const now = Date.now();
    const elapsed = now - lastFiredAt;
    if (elapsed >= WINDOW_MS) {
      // Leading edge.
      lastFiredAt = now;
      pendingArg = null;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      fn(arg);
    } else {
      // Schedule trailing fire, replacing any previously-pending arg.
      pendingArg = arg;
      if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          if (pendingArg !== null) {
            lastFiredAt = Date.now();
            const finalArg = pendingArg;
            pendingArg = null;
            fn(finalArg);
          }
        }, WINDOW_MS - elapsed);
      }
    }
  }) as ((arg: T) => void) & { cancel: () => void };

  wrapped.cancel = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingArg = null;
  };

  return wrapped;
}

/**
 * Pull the workspace list from the renderer. Errors surface as null so
 * the caller can return a single 'internal-error' code without leaking
 * BrowserWindow / IPC implementation details to the bridge.
 */
async function safeListWorkspaces(getWindow: GetWindow): Promise<WorkspaceListEntry[] | null> {
  try {
    const result = (await sendToRenderer(getWindow, 'workspace.list', {}, {
      timeoutMs: WORKSPACE_LIST_FETCH_TIMEOUT_MS,
    })) as unknown;
    if (!Array.isArray(result)) return null;
    return result as WorkspaceListEntry[];
  } catch (err) {
    console.warn('[hooks.rpc] workspace.list failed:', err);
    return null;
  }
}

interface WorkspaceListCache {
  /**
   * Resolve the workspace list, serving a cached snapshot when it is younger
   * than WORKSPACE_LIST_CACHE_TTL_MS and coalescing concurrent misses into a
   * single round-trip. Returns the last-known list if a refresh fails/times
   * out (renderer throttled), or null if nothing has ever been fetched.
   */
  get(): Promise<WorkspaceListEntry[] | null>;
  /**
   * Env-routed fast path (Fix B): the last-known list plus its age in ms,
   * WITHOUT triggering a fetch. null when nothing has ever been cached (cold
   * start — the caller must `get()` once). Never blocks on the renderer.
   */
  peek(): { list: WorkspaceListEntry[]; ageMs: number } | null;
  /**
   * Fire-and-forget refresh to keep the cache warm for `peek()` consumers.
   * No-op when already fresh or a refresh is in flight; coalesces with `get()`.
   * Never throws into the caller and never blocks it.
   */
  prime(): void;
}

/**
 * Build a workspace.list cache. Created once in registerHooksRpc so its
 * closure state (cached value, timestamp, in-flight promise) lives for the
 * handler's lifetime. See WORKSPACE_LIST_CACHE_TTL_MS for the why.
 *
 * `fetchList` and `now` are injected so the TTL + coalescing behavior is
 * unit-testable without an electron BrowserWindow / IPC mock.
 */
export function createWorkspaceListCache(
  fetchList: () => Promise<WorkspaceListEntry[] | null>,
  now: () => number = Date.now,
): WorkspaceListCache {
  let cached: WorkspaceListEntry[] | null = null;
  let cachedAt = 0;
  let inFlight: Promise<WorkspaceListEntry[] | null> | null = null;

  const isFresh = (): boolean =>
    cached !== null && now() - cachedAt < WORKSPACE_LIST_CACHE_TTL_MS;

  // Single coalesced renderer round-trip. `inFlight` is cleared in `finally`
  // so an unexpected rejection can never permanently wedge coalescing (codex
  // #3) — a wedged inFlight would freeze the cache at boot state forever.
  const refresh = (): Promise<WorkspaceListEntry[] | null> => {
    if (inFlight) return inFlight; // coalesce a burst into one round-trip
    inFlight = (async () => {
      try {
        const fresh = await fetchList();
        if (fresh) {
          cached = fresh;
          cachedAt = now();
        }
        // On a failed/timed-out refresh, serve the last-known list rather than
        // dropping the hook — a stale workspace map routes correctly in the
        // overwhelmingly common case (tree rarely changes).
        return fresh ?? cached;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    async get(): Promise<WorkspaceListEntry[] | null> {
      if (isFresh()) return cached; // fresh hit — no renderer round-trip
      return refresh();
    },
    peek(): { list: WorkspaceListEntry[]; ageMs: number } | null {
      if (cached === null) return null;
      return { list: cached, ageMs: now() - cachedAt };
    },
    prime(): void {
      // Keep the cache warm for the env-routed fast path without blocking the
      // caller. No-op when already fresh or a refresh is already in flight.
      // The catch keeps a rejected background refresh from surfacing as an
      // unhandled rejection (codex #3); refresh() already swallows fetch
      // failures, so this is belt-and-suspenders.
      if (isFresh() || inFlight) return;
      void refresh().catch(() => { /* background refresh failure is non-fatal */ });
    },
  };
}

/**
 * Env-routed fast path (Fix B). Decide whether this signal can be routed from
 * the cache's last-known workspace list WITHOUT a renderer round-trip.
 *
 * The round-trip (`workspace.list` → renderer) is what a large-buffer flush
 * storm starves: while the renderer is pegged parsing a multi-MB terminal
 * flush, it can't answer, the fetch times out, and the bridge's 2s hard cap
 * trips (~24% of hooks in the v3.24.0 dogfood). We remove that dependency for
 * the common case.
 *
 * Fast path is taken ONLY when ALL hold:
 *   - the signal carries WMUX_PTY_ID. A pane's daemon session id is
 *     topology-STABLE: it does not change when the active surface switches, so
 *     resolving it against a slightly stale list is safe. A `workspaceId`-only
 *     hook resolves to the workspace's `activePtyId`, which IS focus-sensitive —
 *     a stale value would misroute hook authority / dedup / lifecycle, not just
 *     a toast — so those keep the authoritative fetch.
 *   - the last-known list is younger than STALE_TRUST_MS. Beyond that we stop
 *     trusting an arbitrarily old map and block on a fresh fetch (a renderer
 *     dead >10s is exactly when we SHOULD wait for it).
 *   - the cached list contains the pane's OWN id — checked via
 *     `resolvePtyIdForSignal(...) === signal.ptyId`. This is the load-bearing
 *     guard (codex + GLM P1/P2): it must NOT be a bare truthiness check on the
 *     resolver, because the resolver's workspaceId/cwd FALLBACK would resolve a
 *     newly-created pane (whose ptyId isn't cached yet) to some OTHER pane's id.
 *     Fast-pathing on that would route the new pane's authority / resume-binding
 *     / dedup to the wrong pane until the next refresh — the exact cross-pane
 *     resume-binding clobber the X6③ exact-ptyId routing was added to prevent.
 *     The resolver returns EXACTLY `signal.ptyId` only when its exact-ptyId
 *     branch fires (id present in the list + workspace cross-check), which is
 *     the topology-stable case; any fallback returns a different id.
 *
 * On the fast path we `prime()` the cache (fire-and-forget) so it stays warm
 * for the next hook without blocking this one. `fetchMs` is 0 (no round-trip)
 * and `fastPathed` is true so the flood meter can report how many hooks the
 * cache absorbed — a green "0 degraded" during a real flush storm would
 * otherwise hide the saturation (GLM P2).
 */
export async function resolveWorkspacesForSignal(
  signal: AgentSignal,
  cache: Pick<WorkspaceListCache, 'get' | 'peek' | 'prime'>,
): Promise<{ workspaces: WorkspaceListEntry[] | null; fetchMs: number; fastPathed: boolean }> {
  const peeked = signal.ptyId ? cache.peek() : null;
  if (
    peeked &&
    peeked.ageMs < STALE_TRUST_MS &&
    resolvePtyIdForSignal(signal, peeked.list) === signal.ptyId
  ) {
    cache.prime(); // keep the cache warm without blocking this hook
    return { workspaces: peeked.list, fetchMs: 0, fastPathed: true };
  }
  const fetchStart = Date.now();
  const workspaces = await cache.get();
  return { workspaces, fetchMs: Date.now() - fetchStart, fastPathed: false };
}

/**
 * Resolve an AgentSignal to a ptyId using env-first routing.
 *
 * Priority:
 *   1. `signal.workspaceId` matches a workspace.id → use that workspace's
 *      activePtyId (refined by `signal.surfaceId` when the workspace.list
 *      response carries surface metadata — currently it doesn't; surfaceId
 *      is forensic-only until workspace.list is extended).
 *   2. cwd-based matching (resolvePtyIdForCwd) — exact then longest-prefix.
 *      Used when the bridge ran outside a wmux pane (no env vars) OR
 *      when the env workspaceId is stale (workspace closed but the
 *      bridge subprocess still has the inherited env).
 *   3. null — caller emits 'no-workspace-match'.
 *
 * Codex P1 #7 + user dogfood 2026-05-24 (workspace 4 turn-end was
 * landing in workspace 2's toast because both workspaces had the same
 * cwd) — cwd alone is ambiguous when two panes share a path. Env-first
 * makes the routing deterministic for the in-pane case.
 */
export function resolvePtyIdForSignal(
  signal: AgentSignal,
  workspaces: WorkspaceListEntry[],
): string | null {
  // X6 ③: EXACT per-pane routing. The daemon stamps WMUX_PTY_ID (its own session
  // id) into every pane's env, so a hook carries the precise ptyId it fired from.
  // Trust it ONLY when it still maps to a live workspace pane — that bounds a
  // stale/spoofed id to a currently-open pane (the auth-gated hooks path is
  // lower-trust than the MCP terminal-IO resolver, so an unverified id must never
  // target a session). This resolves the split-workspace / shared-cwd collapse
  // where every pane's hook would otherwise land on the workspace's ACTIVE
  // surface — the dominant cross-pane resume-binding clobber.
  if (signal.ptyId) {
    const ptyWorkspaceId = findWorkspaceIdForPty(signal.ptyId, workspaces);
    // Trust the exact ptyId only when it maps to a LIVE pane AND — when the hook
    // also carries a workspaceId — that pane belongs to the CLAIMED workspace.
    // WMUX_PTY_ID is pane-env-controlled, so without the workspace cross-check an
    // authenticated hook could target another live pane by id (codex P2). A hook
    // with no workspaceId (older bridge / standalone) still trusts a live ptyId.
    if (ptyWorkspaceId && (!signal.workspaceId || ptyWorkspaceId === signal.workspaceId)) {
      return signal.ptyId;
    }
  }
  if (signal.workspaceId) {
    const match = workspaces.find((w) => w.id === signal.workspaceId);
    if (match) {
      // surfaceId-aware routing requires workspace.list to expose a
      // surface→ptyId mapping. Until that extension lands, surfaceId is
      // forensic only and we fall through to activePtyId. (See plan
      // follow-up #5: workspace.list surfaces extension.)
      const ptyId = match.activePtyId ?? match.ptyIds?.[0] ?? null;
      if (ptyId) return ptyId;
      // workspaceId matched a known workspace but the workspace has no
      // ptyId. Fall through to cwd matching as a defensive recovery —
      // a freshly-created workspace with the env set but no surfaces
      // yet would land here.
    }
  }
  return resolvePtyIdForCwd(signal.cwd, workspaces);
}

/**
 * cwd matching strategy:
 *   1. EXACT match against workspace.metadata.cwd → returns activePtyId
 *   2. PREFIX match (signal cwd is a subdirectory of a workspace cwd) →
 *      returns activePtyId of the longest matching prefix
 *   3. No match → null (bridge fired in a non-wmux cwd)
 *
 * Strategy #2 is the practical answer to "user `cd`s into a subdir
 * mid-session" without requiring an env-based resolver. Used as the
 * fallback by `resolvePtyIdForSignal` when env vars are absent.
 */
export function resolvePtyIdForCwd(
  signalCwd: string,
  workspaces: WorkspaceListEntry[],
): string | null {
  const normalizedSignal = normalizeCwd(signalCwd);

  let bestPtyId: string | null = null;
  let bestPrefixLen = -1;

  for (const w of workspaces) {
    const wsCwd = w.metadata?.cwd;
    if (!wsCwd) continue;
    const normalizedWs = normalizeCwd(wsCwd);
    // Exact match short-circuit.
    if (normalizedSignal === normalizedWs) {
      // Prefer the active surface, fall back to first ptyId, else null.
      return w.activePtyId ?? w.ptyIds?.[0] ?? null;
    }
    // Prefix match. We require the wsCwd to be a proper directory prefix
    // (so a workspace at `/foo/bar` matches `/foo/bar/baz` but NOT
    // `/foo/barber`). Standard trick: append the separator.
    const wsCwdWithSep = normalizedWs.endsWith('/') ? normalizedWs : normalizedWs + '/';
    if (normalizedSignal.startsWith(wsCwdWithSep) && normalizedWs.length > bestPrefixLen) {
      bestPrefixLen = normalizedWs.length;
      bestPtyId = w.activePtyId ?? w.ptyIds?.[0] ?? null;
    }
  }

  return bestPtyId;
}

/**
 * Reverse lookup: given a ptyId we already resolved via
 * `resolvePtyIdForSignal`, find the workspaceId that owns it. Used by the
 * `agent.lifecycle` event tee to attach workspace scope so external
 * orchestrators can filter `events.poll` to their claimed workspace.
 *
 * Returns null when the ptyId is no longer in any workspace (race: pane
 * closed between resolve and emit). Caller skips the emit in that case —
 * an event with a stale workspaceId would route to the wrong subscriber.
 */
export function findWorkspaceIdForPty(
  ptyId: string,
  workspaces: WorkspaceListEntry[],
): string | null {
  for (const w of workspaces) {
    if (w.activePtyId === ptyId) return w.id;
    if (w.ptyIds && w.ptyIds.includes(ptyId)) return w.id;
  }
  return null;
}

/**
 * Normalize Windows-style paths to forward slashes, lowercase the
 * drive letter, AND collapse `.` / `..` segments (codex round-2 P1 #8).
 *
 * Without segment collapse, a malicious authenticated signal can
 * route past prefix checks via `/repo/../other`. We do not trust the
 * bridge's cwd as already-canonical because the bridge runs in
 * Claude Code's process and the payload can be anything.
 *
 * Implementation uses Node's path.posix.normalize after backslash
 * substitution. `path.posix` is used unconditionally so the same
 * normalized output is produced regardless of which OS the daemon
 * is running on.
 */
function normalizeCwd(p: string): string {
  // Replace backslashes with forward slashes.
  let out = p.replace(/\\/g, '/');
  // Lowercase Windows drive letter (e.g., D:/... → d:/...). No effect
  // on POSIX paths.
  if (/^[A-Z]:\//.test(out)) {
    out = out[0].toLowerCase() + out.slice(1);
  }
  // Canonicalize: collapse `./`, `../`, and duplicate separators.
  // Lazy require to keep this module testable without a Node mock.
  const posix = require('path').posix as { normalize(s: string): string };
  out = posix.normalize(out);
  // Strip trailing slash to make prefix logic uniform.
  if (out.endsWith('/') && out.length > 1) out = out.slice(0, -1);
  return out;
}

function titleFor(signal: AgentSignal): string {
  const display = agentDisplayName(signal.agent);
  switch (signal.kind) {
    case 'agent.stop':
      return `${display}: Task finished`;
    case 'agent.subagent_stop':
      return `${display}: Subagent finished`;
    case 'agent.activity':
      return `${display}: Activity`;
    case 'agent.session_start':
      return `${display}: Session started`;
    case 'agent.awaiting_input':
      return `${display}: Awaiting input`;
  }
}

function bodyFor(signal: AgentSignal): string {
  // Future: pull richer body text from signal.payload (tool name, file
  // count, etc.). For Phase 1, keep it simple and let the title carry
  // the meaningful signal.
  switch (signal.kind) {
    case 'agent.stop':
      return 'Ready for next input';
    case 'agent.subagent_stop':
      return 'Subagent turn complete';
    case 'agent.activity':
      return 'Tool call completed';
    case 'agent.session_start':
      return 'Session initialized';
    case 'agent.awaiting_input':
      return 'Approval requested';
  }
}

function agentDisplayName(slug: AgentSignal['agent']): string {
  switch (slug) {
    case 'claude': return 'Claude Code';
    case 'codex': return 'Codex CLI';
    case 'gemini': return 'Gemini CLI';
    case 'aider': return 'Aider';
    case 'opencode': return 'OpenCode';
    case 'copilot': return 'GitHub Copilot CLI';
  }
}
