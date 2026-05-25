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

/**
 * The kind of signal. Dispatch keys at the daemon side.
 *
 * - agent.stop          — agent finished its turn. Strongest "task done" signal.
 * - agent.activity      — per-tool-call activity ping (optional, may be dropped if too noisy).
 * - agent.subagent_stop — subagent finished (e.g. /team mode coordinator).
 * - agent.session_start — agent session began. Used to clear stale metadata.
 */
export type AgentSignalKind =
  | 'agent.stop'
  | 'agent.activity'
  | 'agent.subagent_stop'
  | 'agent.session_start';

/**
 * SLUG-form agent identifiers. Matches AgentPattern.slug in AgentDetector.ts.
 *
 * New agents added here MUST also be added to:
 *   1. AgentDetector.AGENT_PATTERNS  (with matching slug)
 *   2. HookSignalRouter dedup key derivation
 *
 * Display names (e.g. "Claude Code") are derived from this slug at the
 * renderer layer, NOT carried in the envelope. This keeps envelopes
 * lowercase + whitespace-free for safe routing key construction.
 */
export type AgentSlug = 'claude' | 'codex' | 'gemini' | 'aider' | 'opencode' | 'copilot';

/**
 * Canonical envelope. All fields are required UNLESS marked optional.
 *
 * Routing priority (daemon-side, `resolvePtyIdForSignal`):
 *   1. `workspaceId` (from WMUX_WORKSPACE_ID env, set by wmux PTYManager)
 *      — strongest signal. When the user runs Claude inside a wmux pane,
 *      the env propagates through Claude Code's subprocess spawn and
 *      lands here. Routing is deterministic regardless of cwd overlap
 *      between workspaces.
 *   2. `surfaceId` (from WMUX_SURFACE_ID env) — refines workspaceId when
 *      a workspace has multiple surfaces. Optional even when workspaceId
 *      is present.
 *   3. `cwd` — fallback for sessions started outside a wmux pane, OR
 *      for older bridges that don't fill the env fields. Resolved via
 *      exact + longest-prefix match against `workspace.metadata.cwd`.
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
  cwd: string;
  payload: Record<string, unknown>;
  ts: number;
}

/**
 * Shape returned by the `hooks.signal` RPC handler. The bridge does not
 * care about the response beyond ok/error; it does not retry, does not
 * read back any data.
 */
export interface HookSignalResponse {
  ok: boolean;
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
 *  review P2 #9). Keep this in sync with the AgentSlug union above. */
const ALLOWED_AGENT_SLUGS: ReadonlySet<string> = new Set([
  'claude', 'codex', 'gemini', 'aider', 'opencode', 'copilot',
]);

export function isAgentSignal(value: unknown): value is AgentSignal {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (
    v['kind'] !== 'agent.stop' &&
    v['kind'] !== 'agent.activity' &&
    v['kind'] !== 'agent.subagent_stop' &&
    v['kind'] !== 'agent.session_start'
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
  return true;
}
