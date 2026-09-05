// Canonical agent signal envelope.
//
// Any AI coding agent (Claude Code, Codex, Gemini, Aider, OpenCode, Copilot)
// that integrates with wmux via the hook plugin pattern emits signals
// shaped like AgentSignal. HookSignalRouter dispatches on `kind`, never
// on `agent`. Per-agent quirks live in the bridge script that translates
// the agent's native hook payload into this envelope.
//
// This file is wmux-INTERNAL. Bridge scripts in integrations/<agent>/bin/
// are .mjs (self-contained, no TS imports possible from the plugin runtime).
// Bridges duplicate-declare these shapes locally as plain object literals.
//
// M1: this module used to live at `integrations/shared/signal-types.ts`. The
// daemon ingests hook signals now, and tsconfig.daemon.json pins `rootDir` to
// `src` — a file outside `src` is unreachable from the daemon build. So the
// canonical definitions moved here and the old path is a re-export shim, which
// keeps every existing main-side import (and the bridge boundary test that
// lives next to it) compiling untouched.

/**
 * The kind of signal. Dispatch keys at the daemon side.
 *
 * - agent.stop            — agent finished its turn. Strongest "task done" signal.
 * - agent.activity        — per-tool-call activity ping (optional, may be dropped if too noisy).
 * - agent.subagent_stop   — subagent finished (e.g. /team mode coordinator).
 * - agent.session_start   — agent session began. Used to clear stale metadata.
 * - agent.awaiting_input  — agent paused for input. Two emitters: the regex
 *                           AgentDetector (single-line y/N or approval prompts),
 *                           AND the Claude Code hook bridge, which maps a
 *                           PreToolUse hook on the AskUserQuestion tool to this
 *                           kind (the boxed multi-line question UI never matched
 *                           a detector regex). Both route through the same
 *                           HookSignalRouter ledger shape used for `agent.stop`.
 */
export type AgentSignalKind =
  | 'agent.stop'
  | 'agent.activity'
  | 'agent.subagent_stop'
  | 'agent.session_start'
  | 'agent.awaiting_input'
  // User answered a pending AskUserQuestion locally (on the same machine the
  // agent is running on). Emitted on PostToolUse: AskUserQuestion to expire
  // approval requests that are still pending on remote devices.
  | 'agent.input_answered'
  // A prompt was submitted INSIDE the agent's own TUI. Only the deck's brain
  // pty configures this hook, and the brain-pty lane claims the signal before
  // it can reach the fleet ledger — it exists so the orchestrator's "one turn
  // at a time" contract still holds when the human types into the TUI directly.
  | 'agent.user_prompt_submit'
  // #783 — PreToolUse permission gate. A high-risk tool call is pending and the
  // daemon is holding the bridge RPC open until a phone (or the gate deadline)
  // resolves it. Metadata-only: it is pane STATE ("blocked on permission"), not
  // a turn boundary, so it never enters the dedup ledger.
  | 'agent.awaiting_permission'
  // #783 — a permission gate was resolved (phone answered, deferred, or
  // expired). Expire the gate record so a late phone tap gets a 410/409, and
  // clear the pane's "blocked" label. Same early-expiry pattern as
  // agent.input_answered.
  | 'agent.permission_answered'
  // #783 — liveness: a non-gated tool call passed through the permission hook
  // and is running now. Feeds the phone header "tool running · elapsed". A
  // PreToolUse that the daemon decided NOT to gate emits this instead of
  // agent.awaiting_permission. Metadata-only (same class as agent.activity).
  | 'agent.tool_started'
  // The turn ended on an API ERROR — Claude Code's `StopFailure` hook, which
  // fires INSTEAD of `Stop` when the turn dies that way. A turn boundary
  // exactly like `agent.stop` (the pane has stopped working), but never a
  // completion: nothing finished and the operator has to retry. Without it a
  // hook-governed pane sat amber until the agent process died or the
  // 30-minute hook-authority TTL lapsed, because a failed turn fires no Stop.
  | 'agent.stop_failure';

/**
 * SLUG-form agent identifiers, and the slug → display name lookup.
 *
 * Both are re-exported from `src/shared/agentIdentity.ts`, which owns the
 * single table. They stay exported from here because bridge-boundary callers
 * (and the `integrations/shared/signal-types.ts` shim) import them from this
 * module, and the envelope contract is what this file documents.
 *
 * Display names are NOT carried in the envelope — envelopes stay lowercase and
 * whitespace-free so routing keys are safe to build. The daemon still needs
 * `agentSlugToDisplay` because a hook-sourced signal is broadcast on the SAME
 * `agent.event` wire family the detector uses, and that payload's `agent` field
 * IS a display name: main reads it straight into the sidebar label and back
 * through `agentDisplayToSlug`. Emitting the raw slug there would show "claude"
 * in the UI and break the reverse lookup.
 */
export type { AgentSlug } from '../agentIdentity';
export { agentSlugToDisplay } from '../agentIdentity';

import { AGENT_SLUG_SET, type AgentSlug } from '../agentIdentity';

/**
 * Canonical envelope. All fields are required UNLESS marked optional.
 *
 * Routing priority (main-side, `resolvePtyIdForSignal`):
 *   1. `ptyId` (from WMUX_PTY_ID env, injected by the daemon at spawn) —
 *      EXACT per-pane key. Trusted only when it still maps to a live
 *      workspace pane. Resolves the multi-pane-in-one-workspace and
 *      shared-cwd cases that workspaceId+cwd alone collapse (every pane's
 *      hook would otherwise route to the workspace's active surface).
 *   2. `workspaceId` (from WMUX_WORKSPACE_ID env, set by wmux PTYManager)
 *      — strong signal. When the user runs Claude inside a wmux pane,
 *      the env propagates through Claude Code's subprocess spawn and
 *      lands here. Deterministic regardless of cwd overlap between
 *      workspaces, but resolves only to the workspace's active surface.
 *   3. `cwd` — fallback for sessions started outside a wmux pane, OR
 *      for older bridges that don't fill the env fields. Resolved via
 *      exact + longest-prefix match against `workspace.metadata.cwd`.
 *
 * `surfaceId` is carried for forensic continuity but is NOT a routing key:
 * the renderer mints a surface only AFTER pty.create returns, so WMUX_SURFACE_ID
 * is never actually injected into the pane env. WMUX_PTY_ID supersedes it.
 *
 * Bridges MUST set `cwd` (workflow user expects), MAY set `workspaceId` /
 * `surfaceId` when the env is available. Codex round 1 P1 #7 + user
 * dogfood report 2026-05-24 (workspace 4 turn-end → workspace 2 toast)
 * promoted env-first from deferred TODO to required.
 *
 * `ts` is the hook FIRE time in Unix ms, captured by the bridge before
 * the RPC roundtrip. Used by SignalLatencyMeter to compute the
 * (hook fire → wmux receive) delta. The wmux daemon adds its own
 * receive timestamp at HookSignalRouter and stores both.
 *
 * `agentSessionId` is opaque to wmux. For Claude Code it's the session
 * id from the hook payload; for codex it would be the process pid.
 * Carried for forensic logging only — routing never depends on it.
 */
export interface AgentSignal {
  kind: AgentSignalKind;
  agent: AgentSlug;
  agentSessionId?: string;
  /** WMUX_WORKSPACE_ID env value when the bridge runs inside a wmux pane. */
  workspaceId?: string;
  /** WMUX_SURFACE_ID env value. Refines workspaceId for multi-surface workspaces. */
  surfaceId?: string;
  /**
   * X6 ③: WMUX_PTY_ID env value — the EXACT daemon session id of the pane the
   * hook fired from, injected by the daemon at spawn. The strongest routing key:
   * when present and still live, it pins the capture to the exact pane, fixing
   * the split-workspace / shared-cwd collapse where workspaceId+cwd alone route
   * every pane's hook to the workspace's active surface. (surfaceId is never set
   * in practice — the renderer mints a surface only AFTER pty.create returns.)
   */
  ptyId?: string;
  cwd: string;
  payload: Record<string, unknown>;
  ts: number;
}

/**
 * Shape returned by the `hooks.signal` RPC handler. An ordinary bridge
 * invocation does not care about the response beyond ok/error; it does not
 * retry and reads nothing back.
 *
 * The ONE exception is a bridge run with `--gate` (the terminal orchestrator's
 * Stop hook), which reads `block` and exits 2 when it is present. The verdict
 * has to ride this response rather than a second, independent hook: Claude Code
 * runs one event's hooks in parallel, so a separate blocking hook would race
 * the signal that ends the turn. One authority, one round trip.
 */
export interface HookSignalResponse {
  ok: boolean;
  /** Present only for a gated hook whose handler declined to let the turn end.
   *  `reason` is shown to the model verbatim (the bridge writes it to stderr,
   *  which Claude Code feeds back on exit 2). */
  block?: { reason: string };
  /**
   * #783 — PreToolUse permission gate verdict. Present ONLY when a real
   * decision was reached: `allow` = proceed without prompting, `deny` = block.
   * The bridge translates it into the modern PreToolUse
   * `hookSpecificOutput.permissionDecision` JSON on stdout.
   *
   * #898 — there is no "no opinion" VALUE; absence is how that is expressed.
   * A non-gate signal, a non-gated tool, a disarmed gate, or a broker that
   * self-deferred all omit this field, and the bridge then writes nothing at
   * all so the tool call follows the session's own permission flow. `ask` used
   * to be sent for those cases; it is not neutral — it forces a prompt and
   * overrides permission modes like `bypassPermissions`.
   */
  permissionDecision?: 'allow' | 'deny';
  /** Reason hint when ok=false. Logged by the bridge to ~/.wmux/bridge.log. */
  reason?:
    | 'no-workspace-match'
    | 'auth-rejected'
    | 'rate-limited'
    | 'invalid-envelope'
    | 'internal-error';
}

/**
 * Type guard for runtime validation at the daemon RPC boundary.
 * Bridges may send malformed envelopes (e.g. older bridge.mjs vs newer
 * wmux build); HookSignalRouter validates with this function before
 * forwarding to AgentDetector dedup + sendNotification.
 */
/** Closed set of allowed agent slugs. Used by isAgentSignal to reject
 *  unknown agent values rather than accepting any string (codex round-2
 *  review P2 #9). Derived from the identity table, so it cannot drift from
 *  the union. */
const ALLOWED_AGENT_SLUGS: ReadonlySet<string> = AGENT_SLUG_SET;

export function isAgentSignal(value: unknown): value is AgentSignal {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (
    v['kind'] !== 'agent.stop' &&
    v['kind'] !== 'agent.activity' &&
    v['kind'] !== 'agent.subagent_stop' &&
    v['kind'] !== 'agent.session_start' &&
    v['kind'] !== 'agent.awaiting_input' &&
    v['kind'] !== 'agent.input_answered' &&
    v['kind'] !== 'agent.user_prompt_submit' &&
    v['kind'] !== 'agent.awaiting_permission' &&
    v['kind'] !== 'agent.permission_answered' &&
    v['kind'] !== 'agent.tool_started' &&
    v['kind'] !== 'agent.stop_failure'
  ) return false;
  if (typeof v['agent'] !== 'string' || !ALLOWED_AGENT_SLUGS.has(v['agent'])) return false;
  if (typeof v['cwd'] !== 'string' || v['cwd'].length === 0) return false;
  if (typeof v['ts'] !== 'number' || !Number.isFinite(v['ts'])) return false;
  // Reject arrays — typeof [] === 'object' but the declared payload type
  // is Record<string, unknown> and downstream code assumes object semantics.
  // (claude review 2026-05-23 P2 #5.)
  if (v['payload'] === null || typeof v['payload'] !== 'object' || Array.isArray(v['payload'])) return false;
  if (v['agentSessionId'] !== undefined && typeof v['agentSessionId'] !== 'string') return false;
  // Env-first routing fields (optional). Empty string is rejected so a
  // misconfigured bridge can't accidentally tunnel routing through cwd
  // by sending an obviously-bad workspaceId.
  if (v['workspaceId'] !== undefined && (typeof v['workspaceId'] !== 'string' || v['workspaceId'].length === 0)) return false;
  if (v['surfaceId'] !== undefined && (typeof v['surfaceId'] !== 'string' || v['surfaceId'].length === 0)) return false;
  if (v['ptyId'] !== undefined && (typeof v['ptyId'] !== 'string' || v['ptyId'].length === 0)) return false;
  return true;
}
