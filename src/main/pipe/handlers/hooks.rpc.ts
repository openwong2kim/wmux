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
import { sendNotification } from '../../notification/sendNotification';
import type { HookSignalRouter } from '../../hooks/HookSignalRouter';
import { eventBus } from '../../events/EventBus';
import { IPC } from '../../../shared/constants';
import {
  isAgentSignal,
  type AgentSignal,
  type HookSignalResponse,
} from '../../../../integrations/shared/signal-types';

type GetWindow = () => BrowserWindow | null;

interface WorkspaceListEntry {
  id: string;
  name: string;
  metadata?: { cwd?: string | null };
  activePtyId?: string | null;
  ptyIds?: string[];
}

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
): () => void {
  const meter = hookRouter.getLatencyMeter();

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
    //    a wmux pane. We query the renderer-side workspace list every
    //    time because the workspace tree changes more often than hooks
    //    fire; a 1-RTT round-trip to the renderer is fine at the hook
    //    fire rate (≤ a few per turn).
    const workspaces = await safeListWorkspaces(getWindow);
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

    // 4. Forward token usage if the bridge included it. Stop /
    //    SubagentStop bridges read the transcript JSONL and embed a
    //    `usage` block; we reuse the same IPC channel
    //    (TOKEN_UPDATE) the regex-based TokenTracker already uses,
    //    so renderer-side handling (useNotificationListener +
    //    tokenSlice) is unchanged. Hook-derived numbers are
    //    authoritative and arrive on every turn; TokenTracker
    //    remains the fallback for users without the plugin.
    //
    //    NOTE: Token IPC is intentionally workspace-match-gated (unlike
    //    signal-health above). Token data is per-pane (needs a ptyId
    //    target); signal-health is global plugin status (no target
    //    required). Two consumers, two data shapes. Don't conflate.
    const usage = extractUsageFromPayload(signal.payload);
    if (usage) {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.TOKEN_UPDATE, ptyId, {
          totalTokens: usage.totalTokens,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          timestamp: Date.now(),
        });
      }
    }

    // 5. Emit decision. PostToolUse / SessionStart never produce a
    //    toast (would be spam — codex round-2 P1 #5). They also
    //    DO NOT write to the dedup ledger (claude review 2026-05-23
    //    P2 #6) because a no-emit ledger entry would silently block
    //    a same-kind detector emission for 10s with no benefit. Only
    //    emit-class kinds participate in dedup.
    const isEmitKind = signal.kind === 'agent.stop' || signal.kind === 'agent.subagent_stop';
    if (!isEmitKind) {
      return { ok: true };
    }

    const decision = hookRouter.recordHook(signal, ptyId);

    // 6. Tee to EventBus for external observers (orchestrator clients via
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
    //    SIGNAL_HEALTH_UPDATE and TOKEN_UPDATE are unchanged.
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
    }

    if (decision === 'dedup') {
      // Hook arrived too late — detector already emitted. We measured
      // the latency (above) but don't fan out a second time.
      return { ok: true };
    }

    const win = getWindow();
    if (win) {
      sendNotification(win, ptyId, {
        type: 'agent',
        title: titleFor(signal),
        body: bodyFor(signal),
      });
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
    const result = (await sendToRenderer(getWindow, 'workspace.list')) as unknown;
    if (!Array.isArray(result)) return null;
    return result as WorkspaceListEntry[];
  } catch (err) {
    console.warn('[hooks.rpc] workspace.list failed:', err);
    return null;
  }
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

/**
 * Pull the `usage` block out of a hook payload if the bridge embedded
 * it. The bridge script (integrations/claude/bin/wmux-bridge.mjs) reads
 * the Stop hook's transcript_path JSONL and writes the cumulative
 * counts under `payload.usage` as {inputTokens, outputTokens,
 * totalTokens}. We re-validate types defensively because the bridge
 * runs in Claude Code's process and can be on a different version
 * than the daemon.
 */
interface UsageBlock {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export function extractUsageFromPayload(payload: Record<string, unknown>): UsageBlock | null {
  const raw = (payload as { usage?: unknown }).usage;
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const inputTokens = typeof u['inputTokens'] === 'number' ? u['inputTokens'] : null;
  const outputTokens = typeof u['outputTokens'] === 'number' ? u['outputTokens'] : null;
  const totalTokens = typeof u['totalTokens'] === 'number' ? u['totalTokens'] : null;
  if (inputTokens === null || outputTokens === null || totalTokens === null) return null;
  // Defend against negative / NaN / infinity, all of which would
  // produce nonsense in the StatusBar formatter.
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return null;
  if (!Number.isFinite(outputTokens) || outputTokens < 0) return null;
  if (!Number.isFinite(totalTokens) || totalTokens < 0) return null;
  return { inputTokens, outputTokens, totalTokens };
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
