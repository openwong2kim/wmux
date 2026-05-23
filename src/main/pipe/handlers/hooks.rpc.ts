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
//      │ 2. resolve cwd → {workspaceId, ptyId} via workspace.list
//      │ 3. HookSignalRouter.recordHook → 'emit' or 'dedup'
//      │ 4. if emit: sendNotification(win, ptyId, {...})
//      ▼
//   Response: { ok: true } or { ok: false, reason: '...' }

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import { sendNotification } from '../../notification/sendNotification';
import type { HookSignalRouter } from '../../hooks/HookSignalRouter';
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
 */
export function registerHooksRpc(
  router: RpcRouter,
  getWindow: GetWindow,
  hookRouter: HookSignalRouter,
): void {
  router.register('hooks.signal', async (params): Promise<HookSignalResponse> => {
    // 1. Envelope validation. Reject anything that doesn't match the
    //    canonical shape — bridges from older wmux versions, malformed
    //    JSON survivors, etc.
    if (!isAgentSignal(params)) {
      return { ok: false, reason: 'invalid-envelope' };
    }
    const signal: AgentSignal = params;

    // 2. Resolve cwd → ptyId. We query the renderer-side workspace list
    //    every time because the workspace tree changes more often than
    //    hooks fire. A 1-RTT round-trip to the renderer is fine at
    //    the hook fire rate (≤ a few per turn).
    const workspaces = await safeListWorkspaces(getWindow);
    if (!workspaces) {
      return { ok: false, reason: 'internal-error' };
    }

    const ptyId = resolvePtyIdForCwd(signal.cwd, workspaces);
    if (!ptyId) {
      // No wmux workspace owns this cwd. Bridge fired but the user's
      // Claude Code session is running OUTSIDE any wmux-managed dir.
      // This is expected when Claude is used standalone; we just drop.
      return { ok: false, reason: 'no-workspace-match' };
    }

    // 3. Latency observability runs for EVERY signal kind, regardless
    //    of whether the kind is one that emits a user-visible
    //    notification. We always learned something about plugin
    //    health from the round-trip.
    hookRouter.getLatencyMeter().recordSignal(signal.agent, signal.ts);

    // 3b. Forward token usage if the bridge included it. Stop /
    //     SubagentStop bridges read the transcript JSONL and embed a
    //     `usage` block; we reuse the same IPC channel
    //     (TOKEN_UPDATE) the regex-based TokenTracker already uses,
    //     so renderer-side handling (useNotificationListener +
    //     tokenSlice) is unchanged. Hook-derived numbers are
    //     authoritative and arrive on every turn; TokenTracker
    //     remains the fallback for users without the plugin.
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

    // 4. Emit decision. PostToolUse / SessionStart never produce a
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
 * cwd matching strategy:
 *   1. EXACT match against workspace.metadata.cwd → returns activePtyId
 *   2. PREFIX match (signal cwd is a subdirectory of a workspace cwd) →
 *      returns activePtyId of the longest matching prefix
 *   3. No match → null (bridge fired in a non-wmux cwd)
 *
 * Strategy #2 is the practical answer to "user `cd`s into a subdir
 * mid-session" without requiring an env-based resolver. Codex P1 #7
 * (WMUX_WORKSPACE_ID env-first) is deferred — when implemented it
 * becomes step 0, and cwd matching becomes the fallback.
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
