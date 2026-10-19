// HookIngest — daemon-side ingestion of `AgentSignal` envelopes (M1).
//
// The hook bridge (`integrations/<agent>/bin/wmux-bridge.mjs`) used to reach
// the Electron MAIN pipe only, and fast-dropped on ENOENT — so with the GUI
// closed there was no hook authority anywhere. The daemon is the always-on
// process AND already runs the AgentDetector (`DaemonPTYBridge`), so moving
// ingest here makes hook-vs-detector dedup LOCAL to one process instead of a
// cross-process race, and gives phone-facing surfaces a hook-authoritative
// signal with no GUI running.
//
// ASCII flow:
//
//   Claude Code Stop event
//      │
//      ▼
//   integrations/claude/bin/wmux-bridge.mjs
//      │ reads ~/.wmux/daemon-auth-token, opens the DAEMON pipe
//      │ sends RPC: daemon.hooks.signal { kind, agent, cwd, ts, payload, ... }
//      ▼
//   DaemonPipeServer auth → ok
//      │
//      ▼
//   daemon.hooks.signal (src/daemon/index.ts) → HookIngest.handle
//      │ 1. isAgentSignal(params) validate
//      │ 2. meter.recordSignal(agent, fireTs) — resolution-agnostic, so a hook
//      │    from a cwd outside any live pane still counts as "plugin alive"
//      │ 3. resolve signal → daemon session id (ptyId), locally
//      │ 4. meter.recordWorkspaceMatch(ptyId != null)
//      │ 5. touchAuthority + resume binding + dedup + emit
//      ▼
//   pipeServer.broadcast({ type: 'agent.event', data: { ..., source: 'hook' } })
//      → DaemonClient → DaemonNotificationRouter (main) → toast / sidebar
//
// Main's handler resolved a signal by asking the RENDERER for `workspace.list`
// — the round-trip that flooded the bridge's 2s budget under load. The daemon
// owns its session table, so resolution here is an in-memory scan: no cache,
// no coalescing, no fast path, no fallback tiers. That is why the flood meter
// below reports every signal as `fastPathed` and never `degraded`.

import { isInternalForkPayload } from '../../shared/hooks/internalFork';
import path from 'node:path';
import crypto from 'node:crypto';
import { HookSignalRouter } from '../../shared/hooks/HookSignalRouter';
import {
  CompletionAlarm,
  normalizeHookCue,
  normalizeDetectorCue,
  isStaleInterruptedStop,
  type AlarmCue,
  type ConfirmedWindow,
} from '../../shared/hooks/CompletionAlarm';
import { SignalLatencyMeter, type LatencyStats } from '../../shared/hooks/SignalLatencyMeter';
import { HookFloodMeter, describeHookFlood, type HookFloodSummary } from '../../shared/hooks/HookFloodMeter';
import {
  isAgentSignal,
  agentSlugToDisplay,
  type AgentSignal,
  type AgentSignalKind,
  type AgentSlug,
  type HookSignalResponse,
} from '../../shared/hooks/signal-types';
import { ENV_KEYS, isBrainPty } from '../../shared/constants';
import { hasCriticalRiskIn } from '../../shared/criticalPatterns';
// Pure regex/lookup module (no electron), already imported by src/daemon/index.ts.
import { agentDisplayToSlug, agentStatusToSignalKind, type AgentEventStatus } from '../../main/pty/AgentDetector';
import { agentSupportsPermissionFlag, isPlausibleResumeSessionId, type ResumeBinding, type PermissionMode } from '../../shared/agentResume';
import type { ApprovalHookSink, TerminalPromptNote } from '../approvals/types';
import { claudeQuestionsForm, extractAskUserQuestion } from '../approvals/askUserQuestion';
import { boundRecordText, isClaudeFamilyAgent, TERMINAL_PROMPT_TOOL_NAME_MAX } from '../approvals/terminalPrompt';
import { checkNativeTranscriptPath } from '../transcript/providers';
import { isWslOwnTranscriptPath } from './transcriptPathGuard';
import type { WslTarget } from '../../shared/wslTarget';

/** Rolling flood-summary interval. Mirrors the main-side handler. */
const HOOK_FLOOD_LOG_INTERVAL_MS = 30_000;

/** X6 ③: known permission modes, for validating the bridge's payload field. */
const VALID_PERMISSION_MODES: ReadonlySet<string> = new Set([
  'bypassPermissions',
  'acceptEdits',
  'plan',
  'auto',
  'default',
]);

/**
 * The subset of a live daemon session HookIngest needs to route a signal.
 * Structurally satisfied by `DaemonSessionManager.listLiveSessions()` entries.
 */
export interface HookIngestSession {
  id: string;
  cwd: string;
  env?: Record<string, string>;
  /** ISO 8601. Tie-break when several panes match the same cwd. */
  lastActivity?: string;
  /**
   * The pane's current resume binding: `agent` guards a guessed route,
   * `sessionId` is only logged (old → new on a rebind).
   */
  resumeBinding?: Pick<ResumeBinding, 'agent'> & { sessionId?: string };
  /** Canonical agent the detector/process tracker last saw in this pane. */
  lastDetectedAgent?: string;
  /** The pane runs in WSL: its agent reports Linux paths. */
  wslTarget?: WslTarget;
}

/**
 * Arbitration outcome the daemon attaches to every `agent.event` it
 * broadcasts, hook- and detector-sourced alike.
 *
 * The daemon is now the ONLY place hook-vs-detector dedup happens, so main
 * must not re-run its own — it reads this instead (see the daemon.hooks.signal
 * contract, decision 4). Three outcomes, matching what main's
 * DaemonNotificationRouter used to compute for itself:
 *   - 'emit'  → fan out the notification AND the `agent.lifecycle` tee
 *   - 'dedup' → the other source already covered this turn: lifecycle tee with
 *               `decision:'dedup'`, NO notification
 *   - 'veto'  → detector-only, hook-governed pane: identity metadata only,
 *               no notification and no lifecycle tee (the hook is canonical
 *               here and the detector's always-visible footer would both
 *               re-fire mid-turn and poison the ledger against the real Stop).
 *               #935: main also withholds the lifecycle STATUS on a veto —
 *               that footer is what put a false 'waiting' on the roster row
 *               and into "N need you". 'internal' does NOT share this (the
 *               alarm's own judgement leaves the status live), so the two
 *               verdicts are no longer interchangeable main-side.
 *               `agent.awaiting_input` is never stamped 'veto' here, and main
 *               enforces that locally too rather than trusting this process.
 *
 * `decision` is absent for DETECTOR statuses that are not emit-class (e.g.
 * 'running'): those never participated in dedup on either side.
 *
 * 'activity' is the hook-only fourth value (A2/A3) and names a CLASS, not one
 * kind: metadata-only. No toast, no lifecycle tee, no dedup ledger — the pane's
 * state changed, nobody is waiting on it. Consumers dispatch on `hookKind` to
 * decide what it means:
 *   - 'agent.activity'      → PostToolUse; feeds the Fleet "running: <tool>" line
 *   - 'agent.session_start' → a fresh session on this pane; CLEARS the previous
 *                             session's stale activity / pendingQuestion labels
 * Treat an unrecognized `hookKind` in this class as a no-op rather than an
 * error: the class is deliberately open so a new metadata kind does not need a
 * new event type.
 *
 * Two verdict-gate values (CompletionAlarm) join the union:
 *   - 'pending' — a provisional completion window is OPEN. The daemon does NOT
 *                 broadcast yet; the stash's resume closure fires the ledger
 *                 write + broadcast at confirmation. This value never leaves
 *                 the daemon — the daemon-side emission site skips the
 *                 broadcast and nothing else consumes it.
 *   - 'internal' — the verdict gate REJECTED the candidate (subagent stop,
 *                 leftover background work, turn-gate miss, already announced,
 *                 or a working cue rebutted the window). Status dot only: no
 *                 toast, no lifecycle tee, and — unlike 'emit'/'dedup' — no
 *                 dedup-ledger write, so a later same-turn candidate can still
 *                 arbitrate cleanly. Main treats it exactly like 'veto'.
 */
export interface HookArbitration {
  source: 'hook' | 'detector';
  /** Present only for source:'hook'. The canonical envelope kind. */
  hookKind?: AgentSignalKind;
  decision?: 'emit' | 'dedup' | 'veto' | 'activity' | 'internal' | 'pending';
}

/**
 * `agent.event` payload shape. The first three fields are the pre-existing
 * detector payload (`AgentEvent`) main already consumes — hook-sourced events
 * deliberately reuse them so `DaemonClient` → `DaemonNotificationRouter` keeps
 * working with no new event type (and no gen-api-reference ripple).
 */
export interface HookAgentEventData extends HookArbitration {
  /** DISPLAY name ("Claude Code"), NOT the slug — see agentSlugToDisplay. */
  agent: string;
  status: 'complete' | 'awaiting_input' | 'running' | 'error';
  /** Empty for `decision:'activity'` — main derives the label from `signal`. */
  message: string;
  /**
   * The validated envelope, carried so main can reproduce the side effects it
   * used to run off its own copy of the signal (fleet activity line, pending
   * question / transcript tail, `agent.lifecycle` tee) without the daemon
   * minting a second event type for each of them.
   */
  signal: AgentSignal;
}

/**
 * How long a Claude PermissionRequest waits for its `Notification`
 * (`permission_prompt`) before the second layer looks at the screen. Claude
 * Code sends that notification once its permission prompt has waited about
 * six seconds (hooks reference); the rest is margin for the hook's own spawn.
 */
export const PERMISSION_NOTIFY_GRACE_MS = 8_000;

/**
 * Second look at the grid after the second layer's first read found no
 * dialog. Claude shows the dialog only once every PermissionRequest hook has
 * returned, so a slow third-party hook can leave the first read empty.
 */
export const DIALOG_RECHECK_MS = 1_500;

/**
 * Claude Code's PermissionRequest hook: a permission dialog it is ABOUT to
 * show. Not proof a human is blocked (see `holdTentativeDialog`).
 */
function isClaudePermissionRequest(signal: AgentSignal): boolean {
  return signal.kind === 'agent.awaiting_input'
    && signal.payload?.['hook_event_name'] === 'PermissionRequest'
    && isClaudeFamilyAgent(signal.agent);
}

/**
 * Claude Code's `Notification` hook of type `permission_prompt`: a permission
 * prompt that has been on screen, unanswered, for about six seconds. The
 * provider's own word that a human is blocked.
 */
function isClaudePermissionNotification(signal: AgentSignal): boolean {
  return signal.kind === 'agent.awaiting_input'
    && signal.payload?.['hook_event_name'] === 'Notification'
    && signal.payload?.['notification_type'] === 'permission_prompt'
    && isClaudeFamilyAgent(signal.agent);
}

export interface HookIngestDeps {
  /** Live daemon sessions, re-read per signal (topology changes constantly). */
  listLiveSessions: () => HookIngestSession[];
  /** Broadcast an `agent.event` DaemonEvent to every connected client. */
  emitAgentEvent: (sessionId: string, data: HookAgentEventData) => void;
  /**
   * Persist a resume binding for a pane. Main used to relay this as
   * `daemon.setResumeBinding` (and spool it to disk when the daemon was
   * unreachable); ingesting here makes it a plain local call with no RPC and
   * no spool window — the daemon IS the destination.
   */
  applyResumeBinding: (ptyId: string, binding: ResumeBinding) => void;
  /** #1823: slug of the agent process alive in the pane right now, if known. */
  liveAgentFor?: (ptyId: string) => string | undefined;
  /**
   * The pid of the pane's tracked top-level agent process
   * (AgentProcessTracker.pidFor), if one is attributed. Compared with the
   * bridge's `agentPid` so a hook from another process — a `claude` nested
   * under the pane's agent — cannot speak for the pane. Optional: without it
   * only the entrypoint decides (see foreignProcessReason).
   */
  agentPidFor?: (ptyId: string) => number | undefined;
  /**
   * Fresh liveness of a pid, read now rather than from the tracker's cache
   * (whose `alive` lags a real exit by up to one ProcessMonitor poll). Asked
   * only on a pid mismatch; a refusal needs it to answer true. Without it a
   * mismatch is never refused.
   */
  isPidRunning?: (pid: number) => boolean;
  /**
   * A mismatched hook was accepted because the tracked pid is gone: the
   * tracker still holds a dead agent, so re-pick the pane's live one.
   */
  onStaleAgentPid?: (ptyId: string) => void;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Injected for test determinism. */
  now?: () => number;
  /** Dedup-window override, for tests. */
  dedupWindowMs?: number;
  /**
   * M2 — the approval registry, driven from the daemon-INTERNAL emission path
   * rather than off the wire. This is the point where hook-vs-detector
   * provenance and the dedup decision are both already known, so gating on
   * `source:'hook'` + `decision:'emit'` is a local read instead of something a
   * downstream consumer has to re-derive (and could get wrong).
   *
   * Optional: only the daemon supplies it, and no hook behaviour depends on it.
   */
  approvals?: ApprovalHookSink;
  /**
   * #783 — the gated-tools list from daemon config. A GETTER so `wmux gate
   * --add` takes effect on the next tool call without a daemon restart: the
   * CLI writes config.json, and this re-reads it per signal. When absent
   * (tests, or a daemon that has not loaded config), EVERY tool passes through
   * ungated (emits agent.tool_started, returns allow). This is the same
   * direction as WMUX_GATE=0: the escape is fail-open, not fail-closed.
   */
  gateConfig?: () => { gatedTools: string[] };
  /**
   * Every resolved signal with its payload, for consumers that read a field
   * the event shapes drop (the usage-limit registry reads a StopFailure's
   * `error` and `last_assistant_message`). Optional; only the daemon supplies it.
   */
  onResolvedSignal?: (sessionId: string, signal: AgentSignal) => void;
  /**
   * Is a dialog on the pane's screen right now? The second layer only: asked
   * when a Claude PermissionRequest got no `permission_prompt` Notification
   * within PERMISSION_NOTIFY_GRACE_MS on a pane that has never sent one (the
   * hook is not registered there). `false` drops the alarm, `null` means the
   * grid could not be read and the hook is trusted. Optional: only the daemon
   * supplies it; without it the hook is trusted after the grace.
   */
  dialogOnScreen?: (sessionId: string) => Promise<boolean | null>;
  /**
   * A tentative Claude PermissionRequest ended without an alert (no
   * Notification, no dialog on screen, or settled first). Its phone record was
   * minted at once and has no other way out, since the pane was never marked
   * awaiting: the daemon retires it if the screen shows no dialog. Optional.
   */
  onTentativeDialogLapsed?: (sessionId: string) => void;
  /**
   * Transcript projection — tell the TranscriptProjector that this pane's
   * transcript may have grown. Fired for EVERY resolved signal, including the
   * non-emit kinds: `agent.activity` is the mid-turn liveness nudge,
   * `agent.session_start` invalidates a reused pane's cached conversation, and
   * the stop kinds are the first nudge that can carry a freshly-captured
   * `transcriptPath`.
   *
   * Fired AFTER the resume-binding capture above, because that capture is what
   * makes the path available at all. Cheap when nobody is subscribed.
   *
   * Optional: only the daemon supplies it, and no hook behaviour depends on it.
   */
  onTranscriptNudge?: (
    sessionId: string,
    kind: AgentSignalKind,
    /** The signal's own agent session id, when it carried one. */
    agentSessionId?: string,
    /** When the hook fired (the bridge's clock). */
    ts?: number,
    /** Claude Code's `prompt_id` on the hook, when it carried one. */
    promptId?: string,
  ) => void;
  /**
   * CompletionAlarm — emit a DETECTOR-sourced `agent.event` whose completion
   * window has just CONFIRMED. The detector emission site (daemon/index.ts
   * `session:agent`) broadcasts immediately for everything else, but a held
   * candidate has already returned `decision:'pending'` to that site, so the
   * only path left for its stash is this callback at window expiry.
   *
   * Returns `false` when the daemon withheld the broadcast (a detection its
   * canonical identity contradicts, #919): a confirmed attention then raises
   * no `terminal_prompt` record either. Anything else counts as delivered.
   *
   * Optional: only the daemon supplies it, and no hook behaviour depends on it.
   */
  emitDetectorEvent?: (sessionId: string, data: DetectorHeldEventData) => boolean | void;
  /**
   * #919 — fired after every resolved signal touches hook authority (both the
   * `handle()` path and the permission-gate interceptor). Gives the daemon a
   * single wiring point to ARM the process tracker for bannerless metadata
   * hooks: a quiet claude mid-tool-call must not wait for a detector banner to
   * become corroborable. The session is resolved; the callback owes the caller
   * nothing back and its failure is non-fatal.
   *
   * Optional: only the daemon supplies it. `signal` is the resolved signal
   * (#1727: a WSL hook's report of its agent process rides on it).
   */
  onAuthorityTouched?: (sessionId: string, signal: AgentSignal) => void;
  /**
   * #1463 — the agent itself reported that the question its pane was blocked
   * on has been answered (`agent.input_answered`, AskUserQuestion's
   * PostToolUse). The daemon releases the pane's awaiting state through the
   * same path a recognised answer key takes, so the status leaves "Needs you"
   * now. Without it, an answer the key check cannot see (a mouse click on an
   * option) waited for the screen verifier or the turn end. `answeredAt` is
   * the hook's fire time. Called only for an EXACT-routed signal: a cwd guess
   * could release a sibling pane's question. Only the daemon supplies it; a
   * failure is non-fatal.
   */
  onInputAnswered?: (sessionId: string, answeredAt: number) => void;
  /**
   * OpenCode — bring the pane's native permission/question records in line
   * with what the wmux TUI plugin lists. `native`: a native record now stands
   * for this request (`requestId`, the hook's `permId`; without one, for what
   * the plugin listed). Anything else — `missing` (not listed, no answerable
   * form), a plugin that predates decisions, no answer — keeps the
   * informational `awaiting_input` card, so a blocked pane always has one.
   * Only the daemon supplies it; a rejection counts as `unavailable`.
   */
  openCodeDecisions?: (sessionId: string, requestId?: string) => Promise<'native' | 'missing' | 'unsupported' | 'unavailable'>;
  /**
   * Scheduled runs — is this pane a live run in the automation engine's
   * registry? Such a pane raises no #783 gate: nobody is at a phone for an
   * unattended run, so a gate would only stall it until the deadline. Its
   * permission boundary is the launch mode (and the agent's own prompt in
   * approval mode). Registry membership, never the id prefix.
   */
  isAutomationPane?: (sessionId: string) => boolean;
  /**
   * One turn has one end. The daemon's id for the pane's latest episode when
   * that episode is over for good (DaemonPTYBridge.endedTurnId: a hard close;
   * a soft close resumes under the same id), else null. Optional: without it
   * no turn end is deduplicated.
   */
  latestEndedTurn?: (sessionId: string) => string | null;
}

/**
 * The confirmed detector event, as `emitDetectorEvent` receives it. Deliberately
 * stringlier than `HookAgentEventData`: the detector vocabulary includes
 * statuses (`waiting`) the hook union never produces, and there is no
 * `AgentSignal` envelope to attach — main's DaemonNotificationRouter reads the
 * same fields off the wire today.
 */
export interface DetectorHeldEventData {
  agent: string;
  status: string;
  message: string;
  source: 'detector';
  decision: 'emit' | 'dedup';
}

function readPermissionMode(payload: Record<string, unknown>): PermissionMode | undefined {
  const m = payload?.permissionMode;
  return typeof m === 'string' && VALID_PERMISSION_MODES.has(m) ? (m as PermissionMode) : undefined;
}

/**
 * Normalize a cwd for routing comparisons: backslashes → forward slashes,
 * lowercase Windows drive letter, collapse `.`/`..`/duplicate separators,
 * strip the trailing separator.
 *
 * The `..` collapse is load-bearing, not cosmetic: an authenticated-but-
 * untrusted bridge payload could otherwise walk past a prefix check with
 * `/repo/../other`. Byte-for-byte the same rules main's hooks.rpc applies, so
 * a signal routes to the same pane whichever pipe it arrives on.
 */
/**
 * #1823: a signal that names claude but whose own session evidence is a Codex
 * rollout (`rollout-*.jsonl` transcript, or the bridge's rollout-stem id).
 * Only a Codex hook invoking the Claude bridge produces that; the stem is
 * matched on the basename so a POSIX or Windows path decides the same way.
 */
function isCrossProviderSignal(signal: AgentSignal): boolean {
  if (signal.agent !== 'claude') return false;
  if (typeof signal.agentSessionId === 'string' && /^rollout-/i.test(signal.agentSessionId)) return true;
  const claimed = signal.payload?.transcript_path;
  if (typeof claimed !== 'string') return false;
  const base = claimed.split(/[\\/]/).pop() ?? '';
  return /^rollout-.*\.jsonl$/i.test(base);
}

/**
 * CLAUDE_CODE_ENTRYPOINT, classified. `interactive` is a person's session (the
 * CLI TUI, the IDE extensions); `headless` is an SDK surface (`claude -p`
 * reports `sdk-cli`, even when started by an interactive `cli` whose env it
 * inherits — measured) or `mcp` (`claude mcp serve`); `unknown` is any other
 * value. Kept equal to classifyEntrypoint in integrations/claude/bin/wmux-bridge.mjs.
 */
export function classifyEntrypoint(entrypoint: string | undefined): 'interactive' | 'headless' | 'unknown' | 'absent' {
  if (!entrypoint) return 'absent';
  if (entrypoint === 'cli' || entrypoint === 'vscode' || entrypoint === 'jetbrains') return 'interactive';
  if (entrypoint.startsWith('sdk-') || entrypoint === 'mcp') return 'headless';
  return 'unknown';
}

/**
 * The bridge's `entrypoint` (CLAUDE_CODE_ENTRYPOINT): an envelope key the
 * shared AgentSignal type does not declare, so it is read defensively.
 */
export function signalEntrypoint(signal: AgentSignal): string | undefined {
  const value = (signal as unknown as Record<string, unknown>).entrypoint;
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : undefined;
}

/**
 * The bridge's `agentPid` — the hook's parent process. OBSERVATIONAL: the
 * bridge sends it only where that parent is measured to be the agent itself
 * (macOS); a shell wrapper (WSL hook.sh, Windows) would make it a shell pid.
 * Undeclared, like `entrypoint`.
 */
export function signalAgentPid(signal: AgentSignal): number | undefined {
  const value = (signal as unknown as Record<string, unknown>).agentPid;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1 ? value : undefined;
}

/**
 * The pid HookIngest may compare a hook's process against: only one the
 * process tracker positively named as an agent (it carries a slug) and still
 * reads alive. A slugless pick — a wrapper, a shell, a helper like gitstatusd —
 * is not the agent, so it yields nothing and no pid test runs.
 */
export function identifiedAgentPid(
  tracked: { alive: boolean; slug?: string } | undefined,
  pid: number | undefined,
): number | undefined {
  return tracked?.alive && tracked.slug ? pid : undefined;
}

function normalizeCwd(p: string): string {
  let out = p.replace(/\\/g, '/');
  if (/^[A-Z]:\//.test(out)) {
    out = out[0].toLowerCase() + out.slice(1);
  }
  out = path.posix.normalize(out);
  if (out.endsWith('/') && out.length > 1) out = out.slice(0, -1);
  return out;
}

/** Most-recently-active session wins a tie. Missing/unparseable → oldest. */
function mostRecent(sessions: HookIngestSession[]): HookIngestSession | null {
  let best: HookIngestSession | null = null;
  let bestAt = -Infinity;
  for (const s of sessions) {
    const at = s.lastActivity ? Date.parse(s.lastActivity) : NaN;
    const score = Number.isFinite(at) ? at : -Infinity;
    if (best === null || score > bestAt) {
      best = s;
      bestAt = score;
    }
  }
  return best;
}

/**
 * Resolve a signal to a live daemon session id, cheapest and strongest key
 * first. Exported for tests.
 *
 *   1. `ptyId` — WMUX_PTY_ID, stamped into every pane env by the daemon at
 *      spawn, so it is the EXACT pane the hook fired from. Trusted only when
 *      it still names a LIVE session, and — when the hook also claims a
 *      workspaceId — only when that session really belongs to the claimed
 *      workspace. Pane env is attacker-writable from inside the pane, so
 *      without the cross-check an authenticated hook could target a different
 *      live pane by id. A signal that claims a ptyId failing either check is
 *      REFUSED (null) — it never falls through to the tiers below (#1523).
 *      Its pane is gone (or it is not who it says), so any other pane the
 *      workspace/cwd tiers would pick is a guess, and a wrong guess hands that
 *      pane another agent's turn and resume binding.
 *   2. `workspaceId` — WMUX_WORKSPACE_ID. Narrow the candidate set to that
 *      workspace, then pick by cwd within it. Main resolves this tier to the
 *      workspace's ACTIVE surface, which the daemon cannot know (focus lives
 *      in the renderer); a lone pane in the workspace stands in for it, and
 *      an ambiguous multi-pane workspace falls through rather than guessing.
 *   3. `cwd` — exact match, then longest directory prefix. The fallback for a
 *      session started outside any wmux pane.
 */
export function resolveSessionIdForSignal(
  signal: AgentSignal,
  sessions: HookIngestSession[],
): string | null {
  if (signal.ptyId) {
    const exact = sessions.find((s) => s.id === signal.ptyId);
    if (!exact) return null;
    const ws = exact.env?.[ENV_KEYS.WORKSPACE_ID];
    return !signal.workspaceId || ws === signal.workspaceId ? exact.id : null;
  }

  if (signal.workspaceId) {
    const inWorkspace = sessions.filter(
      (s) => s.env?.[ENV_KEYS.WORKSPACE_ID] === signal.workspaceId,
    );
    if (inWorkspace.length > 0) {
      const byCwd = resolveSessionIdForCwd(signal.cwd, inWorkspace);
      if (byCwd) return byCwd;
      // A single pane owns the workspace → no ambiguity to resolve.
      if (inWorkspace.length === 1) return inWorkspace[0].id;
      // Otherwise fall through: cwd across ALL sessions may still place it,
      // and guessing between sibling panes would misroute hook authority.
    }
  }

  return resolveSessionIdForCwd(signal.cwd, sessions);
}

/**
 * cwd matching: exact match first, then the longest proper directory prefix
 * (so a pane at `/foo/bar` matches `/foo/bar/baz` but never `/foo/barber`).
 * Ties break to the most recently active pane — the daemon's closest analogue
 * of main's "the workspace's active surface". Exported for tests.
 */
export function resolveSessionIdForCwd(
  signalCwd: string,
  sessions: HookIngestSession[],
): string | null {
  const target = normalizeCwd(signalCwd);
  const exact: HookIngestSession[] = [];
  let bestPrefixLen = -1;
  let bestPrefix: HookIngestSession[] = [];

  for (const s of sessions) {
    if (!s.cwd) continue;
    const cwd = normalizeCwd(s.cwd);
    if (cwd === target) {
      exact.push(s);
      continue;
    }
    const withSep = cwd.endsWith('/') ? cwd : `${cwd}/`;
    if (!target.startsWith(withSep)) continue;
    if (cwd.length > bestPrefixLen) {
      bestPrefixLen = cwd.length;
      bestPrefix = [s];
    } else if (cwd.length === bestPrefixLen) {
      bestPrefix.push(s);
    }
  }

  if (exact.length > 0) return mostRecent(exact)?.id ?? null;
  if (bestPrefix.length > 0) return mostRecent(bestPrefix)?.id ?? null;
  return null;
}

/**
 * #783 — build a short, sanitized summary of a tool's input for the phone card.
 * Shows the shell command for Bash, the file path for Write/Edit, etc. Control
 * chars are stripped and the result is capped so the /api/approvals payload
 * stays bounded. Returns undefined when there is nothing useful to show.
 */
const TOOL_INPUT_SUMMARY_MAX = 200;
function summarizeToolInput(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const toolInput = payload['tool_input'];
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return undefined;
  const ti = toolInput as Record<string, unknown>;
  const fields = ['command', 'file_path', 'path', 'url', 'pattern'];
  for (const f of fields) {
    const v = ti[f];
    if (typeof v === 'string' && v.length > 0) {
      // eslint-disable-next-line no-control-regex
      const clean = v.replace(/[\x00-\x1f\x7f]/g, '').trim();
      return clean.length > TOOL_INPUT_SUMMARY_MAX
        ? clean.slice(0, TOOL_INPUT_SUMMARY_MAX) + '…'
        : clean;
    }
  }
  return undefined;
}

/** Bounds on the critical scan's walk of a tool input. Past either, the input
 *  is treated as critical: an unread remainder is not evidence of safety, and
 *  the cost of the over-fire is one approval going to a human. */
const RISK_SCAN_MAX_CHARS = 1_000_000;
const RISK_SCAN_MAX_NODES = 10_000;

/**
 * Whether the gated call's FULL input names a critical action. Judged before
 * `summarizeToolInput` cuts the text to 200 characters: an `rm -rf` past the
 * cut is still the call being approved. Every string LEAF counts, however
 * deep — MultiEdit's `edits[]` and an MCP tool's nested arguments included. A
 * match in a file's content over-fires, which only sends it to a human.
 *
 * The PowerShell tool's input is read as PowerShell (#1939): there `rm -r` is
 * Remove-Item -Recurse, not the Unix spelling.
 */
export function gateInputIsCritical(payload: Record<string, unknown> | undefined): boolean {
  const root = payload?.['tool_input'];
  if (root === undefined || root === null) return false;
  const shell = payload?.['tool_name'] === 'PowerShell' ? 'powershell' : 'any';
  const stack: unknown[] = [root];
  let nodes = 0;
  let chars = 0;
  while (stack.length > 0) {
    const v = stack.pop();
    if (++nodes > RISK_SCAN_MAX_NODES) return true;
    if (typeof v === 'string') {
      chars += v.length;
      if (chars > RISK_SCAN_MAX_CHARS) return true;
      if (hasCriticalRiskIn(shell, v)) return true;
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (v && typeof v === 'object') {
      for (const item of Object.values(v as Record<string, unknown>)) stack.push(item);
    }
  }
  return false;
}

/**
 * Emit-class kinds — the turn boundaries. These are the only kinds that
 * produce a user-visible event and the only ones that touch the dedup ledger.
 *
 * `agent.stop_failure` is one of them: a turn that died on an API error has
 * ended just as definitively as one that finished, and the operator is owed
 * the same notification. What differs is the STATUS it carries ('error', not
 * 'complete') and the alarm cue it normalizes to (`attention`, not `stop`) —
 * see eventShapeFor and normalizeHookCue.
 */
function isEmitKind(kind: AgentSignalKind): kind is
  'agent.stop' | 'agent.subagent_stop' | 'agent.awaiting_input' | 'agent.stop_failure' {
  return kind === 'agent.stop'
    || kind === 'agent.subagent_stop'
    || kind === 'agent.awaiting_input'
    || kind === 'agent.stop_failure';
}

/**
 * Metadata-only kinds (A2/A3) — broadcast, but never a turn boundary.
 *
 * PostToolUse (`agent.activity`) and SessionStart are pane STATE, not events
 * the user is waiting on. They must never raise a notification, never produce
 * a lifecycle tee, and above all never reach the dedup ledger: a no-emit
 * ledger entry would silently block a same-kind detector emission for the
 * whole 10s window for no benefit.
 *
 * Both still have to reach main, because main used to derive per-pane labels
 * from them locally and can't anymore once the bridge talks to the daemon
 * directly — activity feeds the Fleet "running: <tool>" line, session_start
 * CLEARS the previous session's stale activity/pendingQuestion labels when a
 * pane is reused, and user_prompt_submit turns the pane's status dot on at the
 * exact moment the turn starts. They share `decision:'activity'`; consumers
 * tell them apart by `hookKind`.
 */
function isMetadataKind(kind: AgentSignalKind): kind is
  'agent.activity' | 'agent.session_start' | 'agent.tool_started'
  | 'agent.awaiting_permission' | 'agent.user_prompt_submit' {
  // #783 — agent.tool_started (non-gated tool passed the gate hook, liveness)
  // and agent.awaiting_permission (gated tool blocked, pane STATE) are metadata-
  // only: they ride the same agent.event family tagged decision:'activity', and
  // never touch the dedup ledger (they are not turn boundaries).
  //
  // agent.user_prompt_submit is the TURN START, and it is metadata by exactly
  // the same rule: pane state, no toast, no ledger. Before it was classified
  // here it fell through to the `!isEmitKind` drop below, so the one signal
  // that knows precisely when a turn begins produced no status at all and the
  // pane had to wait for the byte-rate heuristic to guess.
  return kind === 'agent.activity'
    || kind === 'agent.session_start'
    || kind === 'agent.tool_started'
    || kind === 'agent.awaiting_permission'
    || kind === 'agent.user_prompt_submit';
}

/**
 * The detector-shaped `{status, message}` an emit-class hook kind stands for.
 * `message` is chosen so main's existing `${agent}: ${message}` title builder
 * reproduces the hook titles main used to build itself ("Claude Code: Task
 * finished") verbatim.
 */
function eventShapeFor(
  kind: 'agent.stop' | 'agent.subagent_stop' | 'agent.awaiting_input' | 'agent.stop_failure',
): { status: 'complete' | 'awaiting_input' | 'error'; message: string } {
  switch (kind) {
    case 'agent.stop':
      return { status: 'complete', message: 'Task finished' };
    case 'agent.subagent_stop':
      return { status: 'complete', message: 'Subagent finished' };
    case 'agent.awaiting_input':
      return { status: 'awaiting_input', message: 'Awaiting input' };
    // The turn is over but nothing finished, so the pane must NOT wear
    // 'complete' — 'error' is the attention status the roster already draws in
    // red, and the message is the toast title main builds from it.
    case 'agent.stop_failure':
      return { status: 'error', message: 'Turn failed (API error)' };
  }
}

/**
 * What a lead turn end says: its kind, the prompt it belongs to (Claude
 * Code's `prompt_id`, on every hook until the next user prompt; the
 * transcript stand-in reads the same id from the turn's user entry), Claude's
 * error code and its last message (trimmed and bounded as the stand-in
 * bounds it, see daemon/transcript/apiErrorTurnEnd). Two ends of one turn
 * say the same.
 */
function turnEndSignature(signal: AgentSignal): string {
  const field = (key: string): string => (typeof signal.payload?.[key] === 'string' ? signal.payload[key] as string : '');
  return `${signal.kind}|${field('prompt_id')}|${field('error')}|${field('last_assistant_message').trim().slice(0, 2000)}`;
}
/** OpenCode's request id on a bridge 0.3.0 signal (`payload.permId`), when well-formed. */
function openCodeRequestId(signal: AgentSignal): string | undefined {
  const raw = signal.payload?.['permId'];
  return signal.agent === 'opencode' && typeof raw === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(raw) ? raw : undefined;
}

export class HookIngest {
  readonly router: HookSignalRouter;
  private readonly meter: SignalLatencyMeter;
  private readonly floodMeter = new HookFloodMeter();
  private readonly floodTimer: ReturnType<typeof setInterval>;
  private readonly deps: HookIngestDeps;
  private readonly now: () => number;
  /** CompletionAlarm — gates every "turn finished" alarm on real turn end. */
  private readonly alarm: CompletionAlarm;
  /**
   * #1463 — sessions whose lead turn has ENDED as far as this ingest has
   * broadcast (a Stop / StopFailure, or a fresh session with no turn yet), and
   * nothing has reported work since. A `SubagentStop` landing here is not a
   * subagent inside the lead turn: Claude Code runs a background subagent a
   * few seconds after every Stop, and projecting it as `running` repainted a
   * finished pane Running for the full 120 s activity window. Maintained in
   * `broadcast`, the one place every status this ingest writes passes through.
   */
  private readonly leadTurnEnded = new Set<string>();
  /**
   * Per pane, the daemon's id of the latest episode whose end this ingest
   * delivered, and that end closed for good. A further end while that is
   * still the pane's latest episode is a duplicate and is dropped: the real
   * StopFailure after the transcript's stand-in for it
   * (daemon/transcript/apiErrorTurnEnd), the stand-in after the real hook, or
   * any repeat. Keyed on the episode id, never on time: no hook timestamp is
   * read, so a hook clock off the daemon's cannot misplace an end. The end
   * must also say the same thing (`turnEndSignature`): a turn that opened no
   * episode (an autonomous turn with no hook before its end) ends with its
   * own reply and is not taken for a repeat. An end that arrives after a
   * newer episode opened is not caught; it never was.
   */
  private readonly endedTurn = new Map<string, { turn: string; signature: string }>();
  /**
   * When each session's latest UserPromptSubmit landed. An interrupted-turn
   * Stop from the Claude Code mod (integrations/claude-mod) is sent a second
   * or more after the interrupt; a prompt that landed after the interrupt
   * started a new turn the late Stop must not end.
   */
  private readonly lastPromptAt = new Map<string, number>();
  /** Claimed ptyIds already logged as refused, so a closed pane logs once (#1523). */
  private readonly refusedClaims = new Set<string>();
  /**
   * OpenCode requests the agent reported answered (`pane|permId`), so a
   * fallback card decided after that report is not raised for them. Bounded:
   * the oldest go first; a request is answered once.
   */
  private readonly answeredRequests = new Set<string>();
  /**
   * Per pane, bumped ONLY by cues that settle or supersede a dialog: the
   * answered kinds, an answer keystroke (noteAnswered), a lead Stop /
   * StopFailure, SessionStart and a new prompt. Never by working evidence —
   * a subagent's PostToolUse behind a real dialog is not an answer (the same
   * asymmetry CompletionAlarm keeps for firm attention). A tentative
   * PermissionRequest and its second-layer screen read compare the value
   * they captured with the current one and stand down if they differ: both
   * outlast the alarm's own window, so this is their only cancel.
   */
  private readonly dialogEpoch = new Map<string, number>();
  /**
   * Per pane, the open tentative PermissionRequest (see holdTentativeDialog):
   * its grace timer, and the fan-out of the latest request it stands for.
   */
  private readonly tentativeDialogs = new Map<string, { epoch: number; cancel: () => void; fanOut: (repeat?: boolean) => unknown }>();
  /**
   * Panes whose Claude has sent a `permission_prompt` Notification this
   * session: the hook is registered there, so a PermissionRequest that gets
   * no Notification had no prompt left waiting, and no second layer runs.
   * Cleared on SessionStart (the settings may differ) and pane disposal.
   */
  private readonly permissionNotifyPanes = new Set<string>();
  /**
   * Per pane, when the second layer last raised a dialog, at which epoch: a
   * `permission_prompt` Notification for that same dialog (drawn late, so it
   * came after the grace) must not alert a second time.
   */
  private readonly secondLayerRaised = new Map<string, { epoch: number; at: number }>();
  /** Per pane, how many Claude PermissionRequests have landed (see permissionRequestCount). */
  private readonly permissionRequests = new Map<string, number>();
  /** #1823: panes already logged for a provider mismatch (log once per pane). */
  private readonly mismatchLogged = new Set<string>();
  /** Foreign-process senders already logged (`pane|reason`), bounded like the rest. */
  private readonly foreignLogged = new Set<string>();

  /**
   * Why this signal does not come from the pane's own top-level agent, or
   * null when it does (or nothing says otherwise). A headless child — a
   * `claude -p` the pane's agent ran through Bash — inherits WMUX_PTY_ID and so
   * names this pane exactly, yet its session is not the pane's conversation:
   * it must never rebind the pane, mark it hook-governed, or end its turn.
   *
   *   1. A known headless entrypoint (`sdk-cli`, …) is foreign.
   *   2. An interactive entrypoint is the pane's own: a nested child cannot be
   *      interactive, and a pid test here could refuse a legitimate /clear
   *      while the tracker still holds a just-exited agent's pid.
   *   3. An unknown entrypoint keeps its signal (a future interactive surface
   *      must not lose its alarms); only its binding is refused, at the
   *      binding site.
   *   4. No entrypoint (an older bridge or Claude Code): foreign only when the
   *      hook named its process and the tracker attributes a DIFFERENT one to
   *      the pane, and that one is running right now. The tracker's cache can
   *      still hold a just-exited agent when its relaunch reports, so the
   *      cached pid alone never refuses: it is re-read fresh, and a dead one
   *      lets the hook through and re-arms the tracker. Without either pid
   *      there is no evidence, and refusing would leave every un-upgraded pane
   *      with no recovery binding at all — so today's behaviour stands. A WSL
   *      hook is never compared: its parent is the hook.sh shell, and the
   *      tracked pid is a Windows-side view.
   */
  private foreignProcessReason(signal: AgentSignal, sessionId: string): string | null {
    const entrypoint = signalEntrypoint(signal);
    const entrypointClass = classifyEntrypoint(entrypoint);
    if (entrypointClass === 'headless') return `entrypoint ${entrypoint} is not interactive`;
    if (entrypointClass !== 'absent') return null;
    if (signal.wslAgentProcess !== undefined) return null;
    const hookPid = signalAgentPid(signal);
    if (hookPid === undefined) return null;
    const trackedPid = this.deps.agentPidFor?.(sessionId);
    if (trackedPid === undefined || trackedPid === hookPid) return null;
    if (this.deps.isPidRunning?.(trackedPid) !== true) {
      this.deps.onStaleAgentPid?.(sessionId);
      return null;
    }
    return `process ${hookPid} is not the pane's agent process ${trackedPid}`;
  }

  private noteForeignProcess(sessionId: string, signal: AgentSignal, reason: string): void {
    const key = `${sessionId}|${reason}`;
    if (this.foreignLogged.has(key)) return;
    this.foreignLogged.add(key);
    if (this.foreignLogged.size > 1024) this.foreignLogged.delete(this.foreignLogged.values().next().value as string);
    this.deps.log?.('info', `[hooks] ignored ${signal.agent} signals on ${sessionId} from a process that is not the pane's agent: ${reason}`);
  }

  private noteMismatch(sessionId: string, message: string): void {
    if (this.mismatchLogged.has(sessionId)) return;
    this.mismatchLogged.add(sessionId);
    if (this.mismatchLogged.size > 1024) this.mismatchLogged.delete(this.mismatchLogged.values().next().value as string);
    this.deps.log?.('warn', message);
  }
  /** Every signal refused because its claimed pane is not live here. Never decremented. */
  private refusedClaimCount = 0;
  /** Gate ptyIds already logged as allowed-on-refusal (bounded, like refusedClaims). */
  private readonly refusedGateClaims = new Set<string>();
  /** PreToolUse gates allowed (fail-open) because their claimed pane was refused. */
  private refusedGateCount = 0;

  constructor(deps: HookIngestDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.meter = new SignalLatencyMeter();
    this.router = new HookSignalRouter({
      latencyMeter: this.meter,
      ...(deps.dedupWindowMs !== undefined ? { dedupWindowMs: deps.dedupWindowMs } : {}),
    });
    this.alarm = new CompletionAlarm({
      now: this.now,
      // Unref'd timers: an open provisional window must never keep the daemon
      // alive (same rule as the flood logger below).
      schedule: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return () => clearTimeout(t);
      },
      // The window's `firm` flag rides along: the detector resume below uses
      // it to tell a hook-reported dialog from a detector-only one.
      onConfirmed: (_pane, _slug, cls, resume, firm) => {
        resume({ cls, firm });
      },
      log: (level, message) => {
        this.deps.log?.(level === 'warn' ? 'warn' : 'info', message);
      },
    });
    this.floodTimer = setInterval(() => {
      const summary = this.floodMeter.flush(HOOK_FLOOD_LOG_INTERVAL_MS);
      if (!summary) return;
      const { level, message } = describeHookFlood(summary);
      this.deps.log?.(level === 'warn' ? 'warn' : 'info', message);
    }, HOOK_FLOOD_LOG_INTERVAL_MS);
    // Never keep the daemon alive for the flood logger.
    this.floodTimer.unref?.();
  }

  /** The raw meter, for callers that want to subscribe rather than poll. */
  getLatencyMeter(): SignalLatencyMeter {
    return this.meter;
  }

  /**
   * A2 — the `daemon.hooks.health` payload. Exists because after M1 the bridge
   * reaches the daemon directly, so main's own meter (which feeds the Settings
   * "Plugin signal health" card via IPC.SIGNAL_HEALTH_UPDATE) never sees a
   * signal again. This is the daemon's equivalent, shaped for polling.
   *
   * The two halves have DIFFERENT time bases, which a consumer must not mix up:
   *   - `latency` is the same `LatencyStats` main already renders. Cumulative
   *     since daemon start (`total`, `workspaceMatchRate`) over a rolling
   *     100-entry ring (`p50`/`p95`/`count`/`perAgent`).
   *   - `flood` is a PARTIAL window — only what has accumulated since the last
   *     30s log flush, so it is null on an idle daemon and its `total` is not
   *     comparable to `latency.total`. Read non-destructively (`peek`), so
   *     polling this RPC never blanks the daemon's own rolling log line.
   *   - `refused.claimedPaneNotLive` counts signals dropped because the ptyId
   *     they claim is not a live pane here, or lives in another workspace
   *     (#1523). Cumulative since daemon start, like `workspaceMatchRate`.
   *     `refused.gateBypassedOnRefusedClaim` counts the PreToolUse gates among
   *     them separately: those are not dropped silently but ALLOWED (fail-open),
   *     so the tool ran without a wmux gate.
   */
  health(): {
    latency: LatencyStats;
    flood: HookFloodSummary | null;
    refused: { claimedPaneNotLive: number; gateBypassedOnRefusedClaim: number };
  } {
    return {
      latency: this.meter.getStats(),
      flood: this.floodMeter.peek(HOOK_FLOOD_LOG_INTERVAL_MS),
      refused: {
        claimedPaneNotLive: this.refusedClaimCount,
        gateBypassedOnRefusedClaim: this.refusedGateCount,
      },
    };
  }

  /**
   * #783 — handle a PreToolUse permission-gate signal from the bridge. Called
   * by the `daemon.hooks.signal` RPC handler INSTEAD of `handle()` for
   * `agent.awaiting_permission` signals, because the daemon decides gate vs
   * pass-through (the bridge sends one kind; the daemon reclassifies based on
   * `gateConfig.gatedTools`).
   *
   * Returns `{ ok, gateId? }`:
   *   - Tool NOT in gatedTools → broadcasts `agent.tool_started` (liveness),
   *     returns `{ ok: true }` — the RPC handler answers `allow` immediately.
   *   - Tool IS gated → creates a gate record via the approval sink,
   *     broadcasts `agent.awaiting_permission`, returns `{ ok: true, gateId }`
   *     — the RPC handler awaits the GateBroker for that id.
   *   - Unroutable / no sessions → `{ ok: false, reason }` — fail open (allow).
   *
   * Never throws: the bridge is on the hook budget.
   */
  handlePermissionGate(signal: AgentSignal): {
    ok: boolean;
    reason?: string;
    gateId?: string;
    sessionId?: string;
  } {
    this.meter.recordSignal(signal.agent, signal.ts);

    const startedAt = this.now();
    let sessions: HookIngestSession[] = [];
    let sessionId: string | null = null;
    try {
      sessions = this.deps.listLiveSessions();
      sessionId = resolveSessionIdForSignal(signal, sessions);
    } catch {
      this.floodMeter.record({ degraded: true, fetchMs: this.now() - startedAt });
      this.meter.recordWorkspaceMatch(false);
      return { ok: false, reason: 'no-workspace-match' };
    }
    this.floodMeter.record({ degraded: false, fetchMs: this.now() - startedAt, fastPathed: true });
    this.meter.recordWorkspaceMatch(sessionId != null);

    if (!sessionId) {
      // Agent running outside any wmux pane, or its claimed pane is gone — fail open.
      this.noteRefusedGate(signal);
      return { ok: false, reason: 'no-workspace-match' };
    }

    // A nested headless child raises no card for the pane and touches none of
    // its state; the bridge already skips these, this covers any that arrive.
    const foreign = this.foreignProcessReason(signal, sessionId);
    if (foreign) {
      this.noteForeignProcess(sessionId, signal, foreign);
      return { ok: false, reason: 'foreign-process' };
    }

    // Touch authority on every gate signal — the bridge is alive on this pane.
    // `exact` (#919): only exact-ptyId routing may decide identity alone.
    this.router.touchAuthority(sessionId, signal.agent, this.now(), signal.ptyId === sessionId, signal.kind);
    try {
      this.deps.onAuthorityTouched?.(sessionId, signal);
    } catch (err) {
      this.deps.log?.('warn', `[hooks] authority-touch callback failed for ${sessionId}: ${String(err)}`);
    }

    // A tool of Claude Code's own post-turn fork (the recap, the prompt
    // suggestion), about 2 s after the Stop, is not the pane's turn: as
    // working evidence it rebutted that Stop's completion, and its running
    // broadcast lit the pane for good (the fork's SubagentStop is skipped).
    // It gets no opinion here, so it follows the session's own permission
    // flow, and touches no pane state.
    if (isInternalForkPayload(signal.payload)) return { ok: true, sessionId };

    // Verdict-gate feed (R4): PreToolUse never reaches `handle()` — the RPC
    // interceptor routes awaiting_permission straight here — so this is the
    // ONLY working-evidence feed for tool calls on the daemon path. Both the
    // gated and ungated outcome share it, which is the point: an agent about
    // to run ANY tool is working, and this cue must rebut any open completion
    // window before the tool's own output arrives.
    this.alarm.observe(sessionId, signal.agent, normalizeHookCue(signal));

    // Transcript nudge: a PreToolUse means the agent is active.
    try {
      this.deps.onTranscriptNudge?.(sessionId, signal.kind, signal.agentSessionId, signal.ts, typeof signal.payload?.['prompt_id'] === 'string' ? signal.payload['prompt_id'] : undefined);
    } catch (err) {
      this.deps.log?.('warn', `[hooks] transcript nudge failed for ${sessionId}: ${String(err)}`);
    }

    const toolName = typeof signal.payload?.tool_name === 'string'
      ? signal.payload.tool_name
      : null;
    // Another tool is starting on this pane: a question Esc'd away earlier may
    // still be on record. The registry retires it only if the screen shows it
    // gone — a subagent's tool can run while the lead's question is up.
    if (toolName !== null && toolName !== 'AskUserQuestion') {
      this.deps.approvals?.retireStaleQuestion?.(sessionId);
    }
    const gatedTools = this.deps.gateConfig?.().gatedTools ?? [];
    // A `bypassPermissions` session has already declared "never ask me" — the
    // user launched it with `--dangerously-skip-permissions` (or set
    // `permissions.defaultMode`). Gating it anyway re-asks the exact question
    // they opted out of, and when no phone is attached EVERY gated tool call
    // stalls until the gate deadline before falling back to a local prompt.
    // Claude Code stamps the live mode on every PreToolUse payload, so honour
    // it. Only `bypassPermissions` passes through: `acceptEdits` still prompts
    // for Bash and `plan`/`default` prompt for everything, so their gates stay
    // meaningful.
    const bypassing = typeof signal.payload?.permission_mode === 'string'
      && signal.payload.permission_mode === 'bypassPermissions';
    // #1397 — the orchestrator brain's own pane raises no gate card. A record
    // here would carry the brain's tool name and input summary to every paired
    // device and let one answer it, which is exactly what every other
    // device-facing surface (`/api/sessions`, the transcript routes, the
    // critical/notify fan-out) already refuses. Nothing in the approvals
    // pipeline said so until now: the brain simply did not arm these hooks,
    // because `ClaudePtyBrainAdapter` spawns it with `WMUX_HOOKS_TO_MAIN=1`.
    // That is a property of how one adapter spawns a process, not a gate — a
    // different spawn profile, or a hook that reaches the daemon anyway, and
    // the record appears. Refused as NOT GATED, so the tool is allowed and the
    // agent keeps its own local permission prompt, which is what happens today.
    const isBrain = isBrainPty({
      id: sessionId,
      env: sessions.find((s) => s.id === sessionId)?.env,
    });
    const isAutomation = this.deps.isAutomationPane?.(sessionId) === true;
    const isGated = !bypassing && !isBrain && !isAutomation && toolName !== null && gatedTools.includes(toolName);

    if (!isGated) {
      // Non-gated tool (or a bypass session) — emit tool_started for the phone
      // liveness header, allow.
      this.broadcast(sessionId, {
        agent: agentSlugToDisplay(signal.agent),
        status: 'running',
        message: '',
        source: 'hook',
        hookKind: 'agent.tool_started',
        decision: 'activity',
        signal,
      });
      return { ok: true, sessionId };
    }

    // Gated tool — create a gate record and broadcast awaiting_permission.
    const workspaceId = sessions.find((s) => s.id === sessionId)?.env?.[ENV_KEYS.WORKSPACE_ID];
    const toolInputSummary = summarizeToolInput(signal.payload);
    const gateId = this.deps.approvals?.noteGateAwaiting({
      sessionId,
      agent: signal.agent,
      ...(workspaceId ? { workspaceId } : {}),
      toolName,
      ...(toolInputSummary ? { toolInputSummary } : {}),
      ...(gateInputIsCritical(signal.payload) ? { risk: 'critical' as const } : {}),
      // Only a hook that named this pane exactly may be approved by a machine.
      attribution: signal.ptyId === sessionId ? 'exact' : 'inexact',
    }) ?? crypto.randomUUID();

    this.broadcast(sessionId, {
      agent: agentSlugToDisplay(signal.agent),
      status: 'running',
      message: '',
      source: 'hook',
      hookKind: 'agent.awaiting_permission',
      decision: 'activity',
      signal,
    });

    return { ok: true, gateId, sessionId };
  }

  /**
   * Ingest one envelope. Never throws — a malformed or unroutable signal is a
   * response code, not an error, because the bridge runs inside the agent's
   * process on a hard 2s budget and treats a rejection as a fatal hook.
   */
  handle(params: unknown): HookSignalResponse {
    if (!isAgentSignal(params)) {
      return { ok: false, reason: 'invalid-envelope' };
    }
    const signal: AgentSignal = params;

    // Health observability runs BEFORE resolution so a hook fired from a cwd
    // no live pane owns still counts toward "the plugin is alive". The
    // resolution outcome is a separate counter (recordWorkspaceMatch).
    this.meter.recordSignal(signal.agent, signal.ts);

    const startedAt = this.now();
    let sessionId: string | null = null;
    // Hoisted out of the resolve call so the M2 approval path can read the
    // RESOLVED session's workspace off its env. The envelope's own
    // `workspaceId` is authenticated but not trusted — the cwd resolution tier
    // never validates it — and a request tagged with the wrong workspace would
    // group under the wrong heading on a phone.
    let sessions: HookIngestSession[] = [];
    try {
      sessions = this.deps.listLiveSessions();
      sessionId = resolveSessionIdForSignal(signal, sessions);
    } catch (err) {
      this.deps.log?.('warn', `[hooks] session resolution failed: ${String(err)}`);
      this.floodMeter.record({ degraded: true, fetchMs: this.now() - startedAt });
      this.meter.recordWorkspaceMatch(false);
      return { ok: false, reason: 'internal-error' };
    }
    // Resolution is an in-process scan, so it is never "degraded" the way
    // main's renderer round-trip could be — every daemon-side signal is by
    // construction the fast path the main-side fix had to engineer.
    this.floodMeter.record({ degraded: false, fetchMs: this.now() - startedAt, fastPathed: true });

    this.meter.recordWorkspaceMatch(sessionId != null);
    if (!sessionId) {
      // The agent is running outside any live wmux pane (expected for
      // standalone use), or the pane it claims is gone. The per-pane event is
      // dropped, health still recorded.
      this.noteRefusedClaim(signal);
      return { ok: false, reason: 'no-workspace-match' };
    }

    // #1823: a Claude-bridge signal carrying a Codex rollout (a Codex hook
    // pointed at the Claude bridge) contradicts itself. Dropped before it can
    // mark the pane hook-governed for claude or bind a `claude --resume` to a
    // rollout filename stem. ok:true so the bridge has nothing to retry.
    if (isCrossProviderSignal(signal)) {
      this.noteMismatch(sessionId, `[hooks] dropped ${signal.agent} signals on ${sessionId}: they carry a Codex rollout (a Codex hook is invoking the Claude bridge)`);
      return { ok: true };
    }

    // A signal from a process that is not the pane's own top-level agent (a
    // headless `claude -p` the agent started) is dropped HERE, before any of
    // its effects: hook authority, the completion alarm, approvals expiry on
    // session_start, the resume binding, the transcript nudge and the event
    // broadcast. ok:true — the bridge has nothing to retry.
    const foreign = this.foreignProcessReason(signal, sessionId);
    if (foreign) {
      this.noteForeignProcess(sessionId, signal, foreign);
      return { ok: true };
    }

    // An interrupted-turn Stop (from the Claude Code mod) that lost the race
    // to the next prompt: that prompt's turn owns the pane now, so this Stop
    // must have no effect at all — not on the alarm's gate, the dedup ledger
    // or the status.
    if (isStaleInterruptedStop(signal, this.lastPromptAt.get(sessionId))) {
      this.deps.log?.('debug', `[hooks] dropped interrupted Stop for ${sessionId}: a newer prompt started a turn`);
      return { ok: true };
    }

    // Hook authority: EVERY resolved signal marks the pane hook-governed for
    // this agent, including the non-emit kinds (SessionStart, per-tool
    // activity) — freshness tracks "the bridge is alive on this pane", not
    // "a toast just fired". The detector-emission site consults
    // isGovernedFor before fanning out its own notifications. `exact` (#919):
    // a cwd-prefix-resolved signal may corroborate identity but never stand alone.
    this.router.touchAuthority(sessionId, signal.agent, this.now(), signal.ptyId === sessionId, signal.kind);
    try {
      this.deps.onAuthorityTouched?.(sessionId, signal);
    } catch (err) {
      this.deps.log?.('warn', `[hooks] authority-touch callback failed for ${sessionId}: ${String(err)}`);
    }
    try {
      this.deps.onResolvedSignal?.(sessionId, signal);
    } catch (err) {
      this.deps.log?.('warn', `[hooks] resolved-signal callback failed for ${sessionId}: ${String(err)}`);
    }

    // User answered a pending approval locally — no turn boundary, just expire the request.
    // The alarm is fed FIRST: an `answered` cue cancels a pending ATTENTION
    // window, and these kinds return before any other cue-feeding site below.
    // Claude's permission request and Notification feed the alarm below, on
    // their own terms: a firm attention cue here, with no resume, would
    // replace a real dialog's pending window (a tentative request's, or a
    // Notification the second layer already raised).
    if (signal.kind === 'agent.input_answered' || signal.kind === 'agent.permission_answered') this.bumpDialogEpoch(sessionId);
    // One turn, one end: checked before the alarm is fed, so a duplicate
    // changes no window another cue opened. It still reaches the binding
    // capture and the transcript nudge below; only its outcome is dropped.
    const duplicateEnd = this.isDuplicateTurnEnd(sessionId, signal);
    const claudeNotification = signal.kind === 'agent.awaiting_input'
      && signal.payload?.['hook_event_name'] === 'Notification' && isClaudeFamilyAgent(signal.agent);
    if (!isClaudePermissionRequest(signal) && !claudeNotification && !duplicateEnd) {
      this.alarm.observe(sessionId, signal.agent, normalizeHookCue(signal));
    }
    if (signal.kind === 'agent.input_answered') {
      const permId = openCodeRequestId(signal);
      if (permId && this.deps.approvals?.expireHookAwaiting) {
        // One OpenCode request answered: only its own card goes, not a card
        // another pending request on the pane still needs.
        this.answeredRequests.add(`${sessionId}|${permId}`);
        if (this.answeredRequests.size > 1024) this.answeredRequests.delete(this.answeredRequests.values().next().value as string);
        void Promise.resolve(this.deps.approvals.expireHookAwaiting(sessionId, [permId])).catch(() => undefined);
      } else {
        // Claude's AskUserQuestion reports what was answered: an answer the
        // phone typed but could not confirm is settled by it.
        this.deps.approvals?.expireForSession(sessionId, 'answered-locally', 'awaiting_input', reportedAnswers(signal.payload));
      }
      // A native request answered at the terminal: the plugin is the judge of
      // which ones are gone (a screen-inferred expiry never touches them).
      if (signal.agent === 'opencode' && this.deps.openCodeDecisions) {
        void this.deps.openCodeDecisions(sessionId).catch(() => undefined);
      }
      try {
        if (signal.ptyId === sessionId) this.deps.onInputAnswered?.(sessionId, signal.ts);
      } catch (err) {
        this.deps.log?.('warn', `[hooks] input-answered callback failed for ${sessionId}: ${String(err)}`);
      }
      return { ok: true };
    }

    // #783 — a permission gate was answered locally (the bridge self-deferred
    // after the harness deadline, or the user answered in the TUI). Same
    // pattern as agent.input_answered: expire the gate record so a late phone
    // tap gets a 410. This does NOT wake the waiter — the bridge already
    // returned 'defer' to Claude Code and is gone. The expiry is for the
    // /api/approvals list so the phone stops showing the card.
    if (signal.kind === 'agent.permission_answered') {
      this.deps.approvals?.expireForSession(sessionId, 'answered-locally', 'awaiting_permission');
      return { ok: true };
    }

    // X6 ③: capture the resume binding on session-LIFECYCLE kinds. Runs
    // BEFORE the emit-kind gate on purpose — SessionStart is dropped for the
    // notification path but is the EARLIEST point the origin session id is
    // known. agentSessionId is the #12235-safe id (transcript basename) the
    // bridge derived; cwd + permissionMode complete the binding (F5/F7).
    // A turn start binds too: it carries the mode that turn runs in, and is the
    // only hook with a mode for a worker whose task ends before its first Stop
    // (a WSL agent's SessionStart has none). The latest mode wins. Only an
    // agent with permission modes (Claude): its bridge puts the mode there.
    if (
      (signal.kind === 'agent.session_start'
        || (signal.kind === 'agent.user_prompt_submit' && agentSupportsPermissionFlag(signal.agent))
        || signal.kind === 'agent.stop'
        || signal.kind === 'agent.subagent_stop')
      && signal.agentSessionId
    ) {
      const permissionMode = readPermissionMode(signal.payload);
      // The envelope is authenticated but NOT trusted (same rule as
      // `workspaceId` above). This value is persisted, then opened and read by
      // the daemon and projected as the pane's conversation, so an unvalidated
      // path is an arbitrary-file-read with a UI attached. Refused ⇒ the binding
      // is stored WITHOUT a transcript path, i.e. projection is unavailable for
      // the pane; nothing else about the signal changes.
      const claimedPath = typeof signal.payload?.transcript_path === 'string'
        ? signal.payload.transcript_path
        : undefined;
      let transcriptPath: string | undefined;
      const routed = sessions.find((s) => s.id === sessionId);
      if (claimedPath && routed?.wslTarget && isWslOwnTranscriptPath(claimedPath, signal.agentSessionId, routed.wslTarget)) {
        // #2270: the WSL pane's own transcript, inside its distro. This process
        // cannot open that path, so the binding goes without it, as before,
        // but it is not a refusal.
        this.deps.log?.('debug', `[hooks] ${sessionId}: transcript is in WSL ${routed.wslTarget.distribution}; not stored`);
      } else if (claimedPath) {
        const sessionEnv = routed?.env;
        const check = checkNativeTranscriptPath(signal.agent, claimedPath, signal.agentSessionId, sessionEnv);
        if (check.ok) {
          transcriptPath = claimedPath;
        } else {
          this.deps.log?.(
            'warn',
            `[hooks] refused transcript_path for ${sessionId}: ${check.reason}`,
          );
        }
      }
      // A guessed route (workspace/cwd tier) never replaces a DIFFERENT agent's
      // binding: only a signal whose ptyId named this pane may rebind it. A
      // claimed-ptyId signal is exact-or-refused above, so this only ever
      // holds back senders that carry no ptyId at all.
      // The pane switching agents is not a clobber: when the detector/process
      // tracker already sees `signal.agent` running there, the old binding is
      // the stale one and the new session must be captured.
      const prevAgent = routed?.resumeBinding?.agent;
      // #1823: the binding is only as good as the pane's agent. A different
      // agent's process alive in the pane, or an id the agent's resume grammar
      // cannot take, means the signal is not about this pane's conversation.
      // An exited agent reports no live slug, so switching agents still binds.
      const liveAgent = this.deps.liveAgentFor?.(sessionId);
      const entrypoint = signalEntrypoint(signal);
      if (classifyEntrypoint(entrypoint) === 'unknown') {
        // The bridge strips these already; an older or foreign sender may not.
        this.noteMismatch(sessionId, `[hooks] refused ${signal.agent} resume binding on ${sessionId}: entrypoint ${entrypoint} is not a known interactive surface`);
      } else if (liveAgent && liveAgent !== signal.agent) {
        this.noteMismatch(sessionId, `[hooks] refused ${signal.agent} resume binding on ${sessionId}: ${liveAgent} is the agent running there`);
      } else if (!isPlausibleResumeSessionId(signal.agent, signal.agentSessionId)) {
        this.noteMismatch(sessionId, `[hooks] refused ${signal.agent} resume binding on ${sessionId}: session id is not ${signal.agent}-shaped`);
      } else if (signal.ptyId !== sessionId && prevAgent && prevAgent !== signal.agent
          && routed?.lastDetectedAgent !== signal.agent) {
        this.deps.log?.(
          'info',
          `[hooks] kept ${prevAgent} resume binding on ${sessionId}: ${signal.agent} signal was not pane-exact`,
        );
      } else {
        const prevSessionId = routed?.resumeBinding?.sessionId;
        try {
          this.deps.applyResumeBinding(sessionId, {
            agent: signal.agent,
            sessionId: signal.agentSessionId,
            cwd: signal.cwd,
            ...(permissionMode ? { permissionMode } : {}),
            ...(transcriptPath ? { transcriptPath } : {}),
            ts: signal.ts,
          });
          // Refusals are logged above; a rebind is logged too, so a pane that
          // switched conversations shows which signal moved it.
          if (prevSessionId !== signal.agentSessionId) {
            this.deps.log?.(
              'debug',
              `[hooks] rebound ${sessionId} (${signal.kind}): ${prevSessionId ?? 'none'} -> ${signal.agentSessionId}`,
            );
          }
        } catch (err) {
          // A binding we failed to persist costs an exact resume after a
          // reboot, never the signal itself.
          this.deps.log?.('warn', `[hooks] resume binding failed for ${sessionId}: ${String(err)}`);
        }
      }
    }

    // Transcript tail nudge. Rides every resolved signal rather than a new
    // hook, and is wrapped because a projector failure must not turn into a
    // fatal hook — the bridge treats an RPC error as one.
    try {
      this.deps.onTranscriptNudge?.(sessionId, signal.kind, signal.agentSessionId, signal.ts, typeof signal.payload?.['prompt_id'] === 'string' ? signal.payload['prompt_id'] : undefined);
    } catch (err) {
      this.deps.log?.('warn', `[hooks] transcript nudge failed for ${sessionId}: ${String(err)}`);
    }

    // A2/A3 — metadata-only kinds ride the SAME agent.event family rather than
    // one new event type each, tagged `decision:'activity'` so a consumer can
    // tell them from a turn boundary at a glance and dispatch on `hookKind`
    // (see isMetadataKind for what each one drives main-side).
    //
    // No throttling and no summarization here on purpose — the daemon stays
    // dumb. The bridge already rate-limits activity at the source
    // (ACTIVITY_STAMP_THROTTLE_MS = 2500ms in wmux-bridge.mjs, ~1 activity RPC
    // per pane per window no matter how many agents run, chosen to sit just
    // under main's 3s leading-edge window), and main derives its labels from
    // `signal.payload` where that logic already lives.
    if (isMetadataKind(signal.kind)) {
      // Verdict-gate feed: every metadata kind carries alarm semantics — the
      // activity/permission kinds are WORKING evidence (they rebut any open
      // completion window and arm the turn gate), session_start is a SESSION
      // boundary (resets the gate so a fresh session must work before any
      // stop can announce).
      if (signal.kind === 'agent.session_start' || signal.kind === 'agent.user_prompt_submit') this.bumpDialogEpoch(sessionId);
      if (signal.kind === 'agent.session_start') this.permissionNotifyPanes.delete(sessionId);
      // A submitted prompt means no dialog is up any more. As a working cue it
      // cannot rebut a firm attention window, which would then still confirm a
      // stale "needs you" (and a detector report that replaced the window's
      // callback carries no epoch guard of its own), so it answers the window.
      if (signal.kind === 'agent.user_prompt_submit') this.alarm.observe(sessionId, signal.agent, { class: 'answered' });
      this.alarm.observe(sessionId, signal.agent, normalizeHookCue(signal));
      // M2: a fresh session on this pane means the question the PREVIOUS
      // session asked will never be answered — the same reasoning that makes
      // session_start clear main's stale pendingQuestion label applies to a
      // pending approval, except here the stale record would let someone press
      // a key into a conversation that no longer exists.
      if (signal.kind === 'agent.session_start') {
        this.deps.approvals?.expireForSession(sessionId, 'session-start');
      }
      // A submitted prompt means the input box is back, so a question still
      // on record was dismissed (Esc sends no hook of its own). Only the
      // question kind: a gate or permission dialog has its own lifecycle.
      if (signal.kind === 'agent.user_prompt_submit') {
        this.deps.approvals?.expireForSession(sessionId, 'prompt-submitted', 'awaiting_input');
        this.lastPromptAt.set(sessionId, this.now());
      }
      return this.broadcast(sessionId, {
        agent: agentSlugToDisplay(signal.agent),
        status: 'running',
        message: '',
        source: 'hook',
        hookKind: signal.kind,
        decision: 'activity',
        signal,
      });
    }

    // Defensive: a kind added to AgentSignalKind by a future bridge that is
    // neither a turn boundary nor classified above is dropped rather than
    // guessed at.
    if (!isEmitKind(signal.kind)) {
      return { ok: true };
    }

    // ---- Emit-class kinds: turn boundaries, now behind the verdict gate ----
    //
    // R1 (ledger at confirmation): a stop/attention candidate that the alarm
    // HOLDS writes nothing to the dedup ledger yet and returns `{ok:true}` to
    // the bridge immediately (the 2s hook budget must never wait out a 1.5s
    // window). The resume closure below runs at confirmation: ledger write,
    // turn-ended approval expiry (R5 — a rebutted stop must leave the phone's
    // card alive), then the broadcast. A candidate the alarm DROPS (subagent,
    // leftover work, gate miss, already announced) broadcasts immediately with
    // `decision:'internal'` and never touches the ledger — main renders the
    // status dot and nothing else, and a later same-turn candidate can still
    // arbitrate cleanly instead of finding a ghost 'emit'.
    const cue = normalizeHookCue(signal);
    if (duplicateEnd) return { ok: true };
    // Only a stop that ends the turn: one with background work still running
    // (#1096) is not, and a background agent's dialog may be up behind it.
    if (cue.class === 'stop' && !cue.child && cue.leftoverWork === 0) this.bumpDialogEpoch(sessionId);
    if (signal.kind === 'agent.stop_failure') this.bumpDialogEpoch(sessionId);
    if (signal.kind === 'agent.subagent_stop') {
      // Never a lead-turn end, and never a verdict about one: the cue is a
      // NO-OP in the alarm — it leaves a window the lead turn's own stop
      // opened untouched, because cancelling there loses that completion with
      // nothing left to re-fire. Status only. The
      // pane's own turn keeps going, so the broadcast says RUNNING — taking a
      // subagent's 'complete' at face value would flip the status dot (and the
      // phone liveness header, which special-cases this hookKind) mid-turn.
      this.alarm.observe(sessionId, signal.agent, cue);
      // #1463 — after the lead turn ended there is no turn for it to be
      // running in: say nothing rather than reopen a finished pane.
      if (this.leadTurnEnded.has(sessionId)) return { ok: true };
      return this.broadcast(sessionId, {
        agent: agentSlugToDisplay(signal.agent),
        status: 'running',
        message: 'Subagent finished',
        source: 'hook',
        hookKind: signal.kind,
        decision: 'internal',
        signal,
      });
    }

    // #1096 — a lead stop with background work still running is not a turn
    // end, and the STATUS must say so, not just the alarm. The #907 verdict
    // gate already judges this cue correctly ("treat as working evidence"),
    // but the projection below would still broadcast eventShapeFor's
    // 'complete', and 'internal' leaves the status dot live — so the roster
    // wore Completed for the whole `Waiting for N background agent(s)` hold.
    // Same shape as the subagent branch above: the pane's own turn keeps
    // going, so the broadcast says RUNNING. observe() still feeds the cue so
    // `seenWorking` lets the eventual real stop (leftoverWork 0) pass the
    // gate; no resume closure — this candidate must never write the ledger or
    // expire approvals, exactly like today's drop path.
    if (signal.kind === 'agent.stop' && cue.class === 'stop' && cue.leftoverWork > 0) {
      this.alarm.observe(sessionId, signal.agent, cue);
      return this.broadcast(sessionId, {
        agent: agentSlugToDisplay(signal.agent),
        status: 'running',
        message: 'Waiting on background agents',
        source: 'hook',
        hookKind: signal.kind,
        decision: 'internal',
        signal,
      });
    }

    // Awaiting input keeps its phone card IMMEDIATELY (R5): a remote device
    // must see the question while the provisional window runs, not 1.5s later.
    // Not for the permission Notification: it names no tool, and the dialog
    // it reports already got its record from the PermissionRequest (or, with
    // no hook before it, from the detector's screen read).
    const permissionNotification = isClaudePermissionNotification(signal);
    // The bridge forwards no other notification type; one from an older or
    // foreign sender (idle, auth, elicitation) says nothing about a dialog.
    if (claudeNotification && !permissionNotification) {
      return { ok: true };
    }
    if (signal.kind === 'agent.awaiting_input' && !permissionNotification) {
      this.noteAwaitingInput(signal, sessionId, sessions);
    }

    const { status, message } = eventShapeFor(signal.kind);
    // `repeat`: the second layer re-raising a dialog it already raised, which
    // refreshes the pane's state but is no new toast (see holdTentativeDialog).
    const fanOut = (repeat = false): HookSignalResponse => {
      const routed = this.router.recordHook(signal, sessionId, this.now());
      const decision = repeat ? 'dedup' : routed;
      if (signal.kind === 'agent.stop') {
        this.deps.approvals?.expireForSession(sessionId, 'turn-ended');
      }
      // Broadcast on BOTH decisions. 'dedup' is not a drop: the detector
      // already fanned out this turn, and a forensic consumer still wants to
      // see that the hook landed. Suppression is the CONSUMER's job, gated on
      // `decision` — see HookArbitration.
      return this.broadcast(sessionId, {
        agent: agentSlugToDisplay(signal.agent),
        status,
        message,
        source: 'hook',
        hookKind: signal.kind,
        decision,
        signal,
      });
    };
    // Claude's PermissionRequest is a dialog it is ABOUT to show, and it fires
    // for ones nobody ever sees: a request another hook or the SDK host
    // decides, one auto-denied because the session cannot prompt, one
    // answered at once. Taken as firm attention, each such hook confirmed a
    // "needs you" toast ~1.5 s later while the agent visibly kept working —
    // reported as "notified every 2 seconds that input is required; when I
    // click, the AI is still working". It is tentative now: no window, no
    // broadcast, no pane status. The firm signal is Claude's own Notification
    // of type `permission_prompt`, sent once the prompt has really waited.
    if (isClaudePermissionRequest(signal)) {
      this.holdTentativeDialog(sessionId, signal.agent, fanOut);
      return { ok: true };
    }
    // Called bare: the alarm hands its resume a ConfirmedWindow, never `repeat`.
    let resume: () => unknown = () => fanOut();
    if (permissionNotification) {
      // The root signal took over: no second layer for this dialog, and none
      // on this pane while its session lasts.
      this.permissionNotifyPanes.add(sessionId);
      this.clearTentativeDialog(sessionId);
      const raised = this.secondLayerRaised.get(sessionId);
      this.secondLayerRaised.delete(sessionId);
      if (raised !== undefined && raised.epoch === this.dialogEpoch.get(sessionId)
          && this.now() - raised.at < PERMISSION_NOTIFY_GRACE_MS) {
        // The second layer already raised this dialog (drawn late, so the
        // Notification came after the grace): one alert per dialog, and its
        // window, if still open, is left to confirm.
        this.deps.log?.('debug', `[hooks] permission_prompt Notification on ${sessionId}: already raised by the screen check`);
        return { ok: true };
      }
      // Stands down a second-layer screen read already in flight.
      this.bumpDialogEpoch(sessionId);
      resume = this.unlessSettled(sessionId, fanOut);
      // The phone record, read off the screen, for a prompt no request came
      // before (a sandboxed network request) or whose record was retired
      // meanwhile. The registry refuses it while one is pending, and a
      // detector report that replaces this window inherits its firmness and
      // so skips its own note.
      this.noteDetectorTerminalPrompt(sessionId, signal.agent);
    }
    const outcome = this.alarm.observe(sessionId, signal.agent, cue, resume);
    if (outcome === 'hold') {
      // The bridge is answered NOW; the broadcast fires at confirmation (or
      // never, if a rebuttal cue lands inside the window).
      return { ok: true };
    }
    return this.broadcast(sessionId, {
      agent: agentSlugToDisplay(signal.agent),
      status,
      message,
      source: 'hook',
      hookKind: signal.kind,
      decision: 'internal',
      signal,
    });
  }

  /**
   * The awaiting_input half of the old driveApprovals, kept immediate while the
   * stop half moved into the confirmation closure. Creates the phone card the
   * moment the hook lands — a rebutted window may supersede it later, but a
   * 1.5s delay on "the agent is blocked on you" is the wrong trade.
   */
  private noteAwaitingInput(
    signal: AgentSignal,
    sessionId: string,
    sessions: HookIngestSession[],
  ): void {
    const approvals = this.deps.approvals;
    if (!approvals) return;
    const session = sessions.find((s) => s.id === sessionId);
    // #1397 — same refusal as the gate path: the orchestrator brain's own pane
    // gets no approval record, so its prompt text never reaches a paired device
    // and no device can answer on its behalf.
    if (isBrainPty({ id: sessionId, env: session?.env })) return;
    const workspaceId = session?.env?.[ENV_KEYS.WORKSPACE_ID];
    // Claude Code's own permission dialog is never an `awaiting_input` card:
    // that card's keystroke map and screen check are built for an
    // AskUserQuestion select (approvalKeystrokes.ts), and its "approve" would
    // press `1` on a Bash command nobody on the phone has read. It is recorded
    // as a `terminal_prompt` instead, so the phone knows the pane is blocked (a
    // bypassPermissions session that hits a `permissions.ask` rule used to
    // leave it with nothing at all for hours). The registry parses the dialog
    // off the screen; the record is answerable only from a capable client, only
    // as a plain Yes/No, and only while the live screen still shows that exact
    // dialog — the registry re-reads it and fences the one-byte write. Anything
    // less is a card with nothing to press (see ApprovalRegistry.resolveTerminalPrompt).
    if (isClaudeFamilyAgent(signal.agent) && signal.payload?.hook_event_name === 'PermissionRequest') {
      const toolName = boundRecordText(signal.payload?.tool_name, TERMINAL_PROMPT_TOOL_NAME_MAX);
      const summary = summarizeToolInput(signal.payload);
      const rawInput = signal.payload?.tool_input;
      const toolInput = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? rawInput as Record<string, unknown>
        : undefined;
      const toolUseId = typeof signal.payload?.tool_use_id === 'string' ? signal.payload.tool_use_id : undefined;
      const hookSessionId = typeof signal.payload?.session_id === 'string' ? signal.payload.session_id : undefined;
      const promptId = typeof signal.payload?.prompt_id === 'string' ? signal.payload.prompt_id : undefined;
      this.recordTerminalPrompt({
        sessionId,
        agent: signal.agent,
        ...(workspaceId ? { workspaceId } : {}),
        ...(toolName ? { toolName } : {}),
        ...(summary ? { summary } : {}),
        ...(toolInput ? { toolInput } : {}),
        ...(toolUseId ? { toolUseId } : {}),
        ...(hookSessionId ? { hookSessionId } : {}),
        ...(promptId ? { promptId } : {}),
        source: 'hook',
      });
      return;
    }
    // A4 — carry WHAT is being asked. Extraction happens here because this is
    // the envelope-aware layer; the registry never learns hook payload shapes.
    // Total and non-throwing (see extractAskUserQuestion): an unusable payload
    // yields absent fields, never a skipped request.
    const asked = extractAskUserQuestion(signal.payload);
    const permId = signal.agent === 'opencode' ? openCodeRequestId(signal) : undefined;
    // The whole prompt as a `decision-v2` form: Claude's picker is what the
    // registry's stepwise driver knows how to answer.
    const form = isClaudeFamilyAgent(signal.agent) ? claudeQuestionsForm(signal.payload) : null;
    const legacy = (): void => approvals.noteHookAwaitingInput({
      sessionId,
      agent: signal.agent,
      attribution: signal.ptyId === sessionId ? 'exact' : 'inexact',
      ...(workspaceId ? { workspaceId } : {}),
      ...(permId ? { requestId: permId } : {}),
      ...(asked.question ? { question: asked.question } : {}),
      ...(asked.options ? { options: asked.options } : {}),
      ...(asked.choices ? { choices: asked.choices } : {}),
      ...(asked.questionShape ? { questionShape: asked.questionShape } : {}),
      ...(form ? { form } : {}),
    });
    // OpenCode's plugin, when it lists decisions, makes the records itself:
    // the hook then only marks the pane blocked (the broadcast below).
    if (signal.agent === 'opencode' && this.deps.openCodeDecisions) {
      // Decided after the plugin round trip: a request answered meanwhile
      // gets no card.
      const fallback = (): void => { if (!permId || !this.answeredRequests.has(`${sessionId}|${permId}`)) legacy(); };
      void this.deps.openCodeDecisions(sessionId, permId).then(
        (outcome) => { if (outcome !== 'native') fallback(); },
        fallback,
      );
      return;
    }
    legacy();
  }

  /** Count a refused claimed-pane signal; log it once per ptyId (bounded set). */
  private noteRefusedClaim(signal: AgentSignal): void {
    const ptyId = signal.ptyId;
    if (!ptyId) return;
    this.refusedClaimCount += 1;
    if (this.refusedClaims.has(ptyId)) return;
    if (this.refusedClaims.size >= 256) this.refusedClaims.clear();
    this.refusedClaims.add(ptyId);
    this.deps.log?.('info', `[hooks] refused ${signal.agent} ${signal.kind} for ${ptyId}: claimed-pane-not-live`);
  }

  /** Count a gate allowed because its claimed pane was refused; log once per ptyId with the tool. */
  private noteRefusedGate(signal: AgentSignal): void {
    const ptyId = signal.ptyId;
    if (!ptyId) return;
    this.refusedGateCount += 1;
    if (this.refusedGateClaims.has(ptyId)) return;
    if (this.refusedGateClaims.size >= 256) this.refusedGateClaims.clear();
    this.refusedGateClaims.add(ptyId);
    const tool = typeof signal.payload?.tool_name === 'string' ? signal.payload.tool_name.slice(0, 64).replace(/[^\w.:-]/g, '_') : 'unknown';
    this.deps.log?.(
      'info',
      `[hooks] allowed ${signal.agent} tool ${tool} ungated for ${ptyId}: claimed-pane-not-live`,
    );
  }

  /**
   * Fan out one `agent.event`. A broken pipe is reported to the bridge as
   * `internal-error` rather than thrown: the bridge runs inside the agent's
   * process on a hard 2s budget and treats an RPC error as a fatal hook.
   */
  private broadcast(sessionId: string, data: HookAgentEventData): HookSignalResponse {
    // #1463 — track whether the lead turn is over (see `leadTurnEnded`). A
    // Stop that still projects `running` (background agents left) is not an end.
    if (data.hookKind === 'agent.session_start'
      || ((data.hookKind === 'agent.stop' || data.hookKind === 'agent.stop_failure') && data.status !== 'running')) {
      this.leadTurnEnded.add(sessionId);
    } else if (data.hookKind !== 'agent.subagent_stop') {
      this.leadTurnEnded.delete(sessionId);
    }
    try {
      this.deps.emitAgentEvent(sessionId, data);
    } catch (err) {
      this.deps.log?.('warn', `[hooks] agent.event broadcast failed for ${sessionId}: ${String(err)}`);
      return { ok: false, reason: 'internal-error' };
    }
    // A delivered turn outcome (not status-only or held) that the daemon took
    // as a close for good: that episode has had its end. A soft close (a Codex
    // stop the rollout has not confirmed) records nothing.
    if ((data.hookKind === 'agent.stop' || data.hookKind === 'agent.stop_failure') && data.status !== 'running'
      && !['internal', 'veto', 'pending'].includes(data.decision ?? '')) {
      const ended = this.deps.latestEndedTurn?.(sessionId) ?? null;
      if (ended !== null) this.endedTurn.set(sessionId, { turn: ended, signature: turnEndSignature(data.signal) });
    }
    return { ok: true };
  }

  /**
   * Settle a DETECTOR-sourced agent event against the same ledger the hook
   * path writes, and report the outcome so main can stop deciding it for
   * itself. Called from the daemon's `session:agent` broadcast site — the
   * daemon's detector emission point.
   *
   * A port of main's DaemonNotificationRouter.onAgent, semantics unchanged:
   *   - only emit-class statuses (waiting / complete / awaiting_input)
   *     arbitrate; 'running' and friends are metadata and carry no decision,
   *     exactly as main never arbitrated them.
   *   - 'awaiting_input' is deliberately EXEMPT from the hook-authority veto.
   *     Claude's hooks.json wires PreToolUse for the AskUserQuestion tool
   *     ONLY — the far more common approval prompts ("Do you want to
   *     proceed?", the permission-mode Y/N gate) are reported by a hook only
   *     where the PermissionRequest hook was installed (a user-run install),
   *     so the detector regexes are often their only signal source. Where
   *     both report one dialog, CompletionAlarm carries them in a single
   *     attention window (a later attention supersedes). Vetoing them would
   *     leave a pane blocked on a real approval silent for the full 30-minute
   *     authority TTL, which is worse than the double-toast this arbitration
   *     exists to prevent.
   *   - an unknown agent display name falls back to the bare `source` tag:
   *     the legacy always-emit behavior main assumed before the ledger.
   */
  arbitrateDetector(sessionId: string, event: { agent: string; status: string; message?: string }): HookArbitration {
    const source = 'detector' as const;
    const slug = agentDisplayToSlug(event.agent);
    if (!slug) return { source };
    const kind = agentStatusToSignalKind(event.status as AgentEventStatus);
    if (!kind || kind === 'agent.activity') {
      // 'running' and friends: not a turn boundary — but for an UNGOVERNED
      // pane (no bridge) this is the only working-evidence feed the alarm
      // gets, without which the turn gate would reject every detector stop.
      const cue = normalizeDetectorCue(event.status);
      if (cue) this.alarm.observe(sessionId, slug, cue);
      return { source };
    }
    // #935 — one predicate, both processes. `governsDetectorStatus` already
    // excludes `awaiting_input` (and every non-lifecycle status). Its scope is
    // asymmetric by kind now: `complete` is released back to the detector on a
    // pane whose bridge has only said SessionStart (a real turn-end read the
    // hook has not claimed yet), while `waiting` is withheld for the WHOLE
    // authority window — Claude paints its "ready for input" footer before the
    // session has done anything, so on a governed pane that read can only cry
    // wolf. Main tees an 'internal' trace on the vetoed event so an external
    // observer still sees the boundary; the toast and the dot are what the
    // veto withholds.
    if (this.router.governsDetectorStatus(sessionId, slug, event.status, this.now())) {
      return { source, decision: 'veto' };
    }
    // Verdict gate (R1): the candidate holds a provisional window before it
    // may write the ledger or broadcast. `pending` tells the emission site to
    // skip its broadcast — everything it does BEFORE arbitration (agent
    // persistence, resume-chip arm) already ran and stays. The stash's resume
    // closure performs the ledger write + broadcast at confirmation.
    const cue: AlarmCue | null = normalizeDetectorCue(event.status);
    if (!cue) {
      // Unreachable for the kind-filtered statuses above; kept defensive.
      return { source, decision: this.router.recordDetector(slug, kind, sessionId, this.now()) };
    }
    const resume = (confirmed?: ConfirmedWindow) => {
      const decision = this.router.recordDetector(slug, kind, sessionId, this.now());
      let delivered = false;
      try {
        delivered = this.deps.emitDetectorEvent?.(sessionId, {
          agent: event.agent,
          status: event.status,
          message: event.message ?? '',
          source,
          decision,
        }) !== false;
      } catch (err) {
        this.deps.log?.(
          'warn',
          `[hooks] held detector broadcast failed for ${sessionId}: ${String(err)}`,
        );
      }
      // Detector attention that survived its window: the agent's own dialog
      // is on screen, so record it for the phone as a `terminal_prompt`.
      //
      // Not for a FIRM window. Firm means the agent's hook reported this
      // dialog (an AskUserQuestion, or the PermissionRequest behind "Do you
      // want to proceed?"), and the hook path already created the record the
      // moment the hook landed — `noteAwaitingInput` runs before the hold, not
      // at confirmation. A window stays firm when a detector report replaces a
      // hook-reported one, so this skip covers both arrival orders.
      if (
        delivered
        && confirmed?.cls === 'attention'
        && !confirmed.firm
        && event.status === 'awaiting_input'
      ) {
        this.noteDetectorTerminalPrompt(sessionId, slug);
      }
    };
    const outcome = this.alarm.observe(sessionId, slug, cue, resume);
    if (outcome === 'hold') return { source, decision: 'pending' };
    return { source, decision: 'internal' };
  }

  /**
   * The detector half of `terminal_prompt` creation (the hook half is in
   * `noteAwaitingInput`). Same refusals: not for the brain's own pane, not for
   * an agent outside the Claude family, not for a pane that is gone. The
   * registry adds the rest (anything already pending, the cooldown).
   */
  private noteDetectorTerminalPrompt(sessionId: string, slug: string): void {
    const approvals = this.deps.approvals;
    if (!approvals?.noteTerminalPrompt || !isClaudeFamilyAgent(slug)) return;
    let session: HookIngestSession | undefined;
    try {
      session = this.deps.listLiveSessions().find((s) => s.id === sessionId);
    } catch {
      return;
    }
    if (!session) return;
    if (isBrainPty({ id: sessionId, env: session.env })) return;
    const workspaceId = session.env?.[ENV_KEYS.WORKSPACE_ID];
    this.recordTerminalPrompt({
      sessionId,
      agent: slug,
      ...(workspaceId ? { workspaceId } : {}),
      source: 'detector',
    });
  }

  /** Hand a `terminal_prompt` to the registry; its async work never escapes unhandled. */
  private recordTerminalPrompt(note: TerminalPromptNote): void {
    const fail = (err: unknown): void => {
      this.deps.log?.('warn', `[hooks] terminal prompt record failed for ${note.sessionId}: ${String(err)}`);
    };
    try {
      Promise.resolve(this.deps.approvals?.noteTerminalPrompt?.(note)).catch(fail);
    } catch (err) {
      fail(err);
    }
  }

  /**
   * #919 — hook-tier identity input for the canonical tier rule. Thin delegate:
   * the ingest owns the router; daemon/index.ts never touches it directly.
   * Undefined when no authority is on record (or past the 30-min map TTL) —
   * the caller applies the shorter IDENTITY_TTL and the `exact` gate on the
   * uncorroborated path only.
   */
  authorityAgentFor(
    sessionId: string,
  ): { slug: AgentSlug; ageMs: number; exact: boolean } | undefined {
    return this.router.authorityAgentFor(sessionId);
  }

  /**
   * #919 — expire the pane's authority on CONFIRMED process death. The 30-min
   * detector veto belongs to the dead launch's generation: left alone it keeps
   * suppressing every completion of a relaunched same-slug agent whose hooks
   * are broken. `onlyAgent` scopes the expiry so a death of process A never
   * strips process B's authority.
   */
  expireAuthorityFor(sessionId: string, onlyAgent?: string): void {
    this.router.expireAuthorityFor(sessionId, onlyAgent);
  }

  /**
   * Byte-activity backstop (brief rule 4 / D3): the wiring layer calls this
   * from `session:active`, so any PTY output — a prompt being typed, a
   * background build chattering — rebuts an open completion window and arms
   * the turn gate for panes the hooks cannot see. Keyed to ONE slug: the
   * caller passes the agent the pane is known to run (detected name, else the
   * persisted lastDetectedAgent), because a keyless "working" cue would arm
   * every agent's gate on the pane and let noise announce for the wrong one.
   */
  notePaneWorking(sessionId: string, slug?: string): void {
    if (!slug) return;
    this.alarm.observe(sessionId, slug, { class: 'working' });
  }

  /**
   * A human answered the dialog the pane was blocked on (DaemonPTYBridge saw
   * the answer keystroke). Cancels a still-held awaiting window: confirming it
   * after the answer would re-mark the pane "needs you" and re-arm the
   * bridge's awaiting state with nothing left on screen to answer.
   */
  noteAnswered(sessionId: string, slug?: string): void {
    // The dialog is settled whatever the slug: a tentative PermissionRequest
    // or a second-layer screen read still in flight must not raise it now.
    this.bumpDialogEpoch(sessionId);
    if (!slug) return;
    this.alarm.observe(sessionId, slug, { class: 'answered' });
  }

  /** Monotonic across panes, so a disposed pane's id can never read as current again. */
  private dialogEpochClock = 0;

  private bumpDialogEpoch(sessionId: string): void {
    this.dialogEpoch.set(sessionId, ++this.dialogEpochClock);
  }

  /** The pane's current epoch, minted on first use so a fresh pane is never 0. */
  private dialogEpochOf(sessionId: string): number {
    const current = this.dialogEpoch.get(sessionId);
    if (current !== undefined) return current;
    this.bumpDialogEpoch(sessionId);
    return this.dialogEpoch.get(sessionId) as number;
  }

  /**
   * A Claude PermissionRequest: a dialog that MAY be coming. It raises
   * nothing by itself; the `permission_prompt` Notification Claude sends once
   * the prompt has waited is the firm signal (handled in `handle`).
   *
   * Second layer, for a pane that has never sent that Notification (wmux's
   * Notification hook is not registered there yet: an install from before
   * it, a hand-written settings file): after PERMISSION_NOTIFY_GRACE_MS with
   * no answer, turn end or new prompt, the screen decides (confirmAgainstScreen)
   * and a dialog still up opens the firm attention window. A pane that has
   * sent one gets no second layer: no Notification means no prompt waited.
   *
   * One timer per pane. A later request while it runs only replaces the
   * fan-out: a stream of requests (the reported storm, one every 2 s) must
   * not postpone the check forever behind a dialog that is really up.
   */
  private holdTentativeDialog(sessionId: string, slug: string, fanOut: (repeat?: boolean) => unknown): void {
    this.permissionRequests.set(sessionId, (this.permissionRequests.get(sessionId) ?? 0) + 1);
    const epoch = this.dialogEpochOf(sessionId);
    const open = this.tentativeDialogs.get(sessionId);
    if (open && open.epoch === epoch) {
      open.fanOut = fanOut;
      return;
    }
    this.clearTentativeDialog(sessionId);
    const entry: { epoch: number; cancel: () => void; fanOut: (repeat?: boolean) => unknown } = { epoch, cancel: () => undefined, fanOut };
    // Asked while a dialog this layer raised is still open: this request waits
    // behind it, and the next epoch move may be that dialog's close, not this
    // one's. The screen decides then, instead of the epoch.
    const raised = this.secondLayerRaised.get(sessionId);
    const behindRaised = raised !== undefined && raised.epoch === epoch;
    const timer = setTimeout(() => {
      if (this.tentativeDialogs.get(sessionId) !== entry) return;
      this.tentativeDialogs.delete(sessionId);
      // A request that ends without an alert may still hold its phone record
      // (noteAwaitingInput mints it at once), and nothing else retires it:
      // with no awaiting broadcast, the awaiting verifier never looks.
      const lapse = (): void => {
        try {
          this.deps.onTentativeDialogLapsed?.(sessionId);
        } catch (err) {
          this.deps.log?.('warn', `[hooks] tentative dialog lapse failed for ${sessionId}: ${String(err)}`);
        }
      };
      if (this.permissionNotifyPanes.has(sessionId)) {
        // The Notification hook is registered here and none came: no prompt
        // waited (or someone is typing at it, which the lapse's screen read
        // tells apart).
        this.deps.log?.('debug', `[hooks] PermissionRequest on ${sessionId} lapsed: no permission_prompt Notification`);
        lapse();
        return;
      }
      const moved = this.dialogEpoch.get(sessionId) !== epoch;
      if (moved && !behindRaised) {
        lapse();
        return;
      }
      const raise = (): void => {
        // Judged when the dialog would be raised, not when the request came:
        // a dialog this layer already raised that is still unsettled is most
        // likely the one on screen (Claude shows one at a time), and another
        // request (a background agent's) must not toast it again. Its close
        // usually moves the epoch within seconds (the answer keystroke, or the
        // awaiting verifier's screen-cleared release, both reach
        // noteAnswered), but not always (a click answer, a next dialog drawn
        // at once), so the repeat still goes out, as a `dedup`: the pane's
        // "needs you" is refreshed, only the second toast is withheld.
        const raised = this.secondLayerRaised.get(sessionId);
        const repeat = raised !== undefined && raised.epoch === this.dialogEpoch.get(sessionId);
        // Recorded as the window opens. Whatever closes a firm window either
        // moves the epoch (an answer, a turn-ending stop, a prompt, a session
        // boundary) or replaces it with one that still alerts (the detector's
        // report, the Notification), so the record never outlives its alert.
        if (!repeat) this.secondLayerRaised.set(sessionId, { epoch: this.dialogEpochOf(sessionId), at: this.now() });
        this.alarm.observe(sessionId, slug, { class: 'attention', firm: true }, this.unlessSettled(sessionId, () => entry.fanOut(repeat)));
      };
      const verifyOnScreen = this.deps.dialogOnScreen;
      if (!verifyOnScreen) {
        raise();
        return;
      }
      // Behind a dialog that has since been settled, only a dialog actually
      // seen on screen counts: the settle may have been this one's too (a
      // turn end clears both), so an unreadable grid is not trusted here.
      this.confirmAgainstScreen(sessionId, verifyOnScreen, raise, moved, lapse);
    }, PERMISSION_NOTIFY_GRACE_MS);
    timer.unref?.();
    entry.cancel = () => clearTimeout(timer);
    this.tentativeDialogs.set(sessionId, entry);
  }

  /**
   * How many Claude PermissionRequests this pane has had. The daemon's lapse
   * sweep compares it across its reads: a newer request owns whatever record
   * is pending now (its dialog may not be drawn yet), so the sweep waits for
   * that request's own lapse instead of expiring under it.
   */
  permissionRequestCount(sessionId: string): number {
    return this.permissionRequests.get(sessionId) ?? 0;
  }

  /**
   * `fanOut`, unless the dialog was settled (answered, turn ended, new prompt)
   * while its firm window ran: working cues cannot rebut a firm window, so a
   * new prompt would otherwise still be followed by a stale "needs you".
   */
  private unlessSettled(sessionId: string, fanOut: () => unknown): () => void {
    const epoch = this.dialogEpochOf(sessionId);
    return () => {
      if (this.dialogEpoch.get(sessionId) !== epoch) {
        this.deps.log?.('info', `[hooks] awaiting_input for ${sessionId} stood down: settled before it confirmed`);
        return;
      }
      fanOut();
    };
  }

  private clearTentativeDialog(sessionId: string): void {
    this.tentativeDialogs.get(sessionId)?.cancel();
    this.tentativeDialogs.delete(sessionId);
  }

  /**
   * The second layer's screen check: `raise` runs only if the dialog is
   * really on the screen.
   *
   *   - The read is asynchronous, so an answer (a hook or the answer
   *     keystroke), a turn end, a new prompt or the root Notification that
   *     lands meanwhile is honoured here: the epoch captured first must still
   *     be current when the read returns, else nothing is raised.
   *   - One miss is not proof. Claude draws the dialog only after every
   *     PermissionRequest hook has returned, so a slow third-party hook can
   *     leave the grid dialog-free. A miss is re-read once after
   *     DIALOG_RECHECK_MS; only a second miss drops the alarm.
   *   - `null` (unreadable or narrow grid, #1901) and a thrown check trust
   *     the hook, unless `seenOnly` asks for a dialog actually seen.
   */
  private confirmAgainstScreen(
    sessionId: string,
    verifyOnScreen: NonNullable<HookIngestDeps['dialogOnScreen']>,
    raise: () => void,
    seenOnly = false,
    dropped: () => void = () => undefined,
  ): void {
    const epoch = this.dialogEpochOf(sessionId);
    // A pane dropped meanwhile has no entry: stale, never a broadcast.
    const stale = (): boolean => this.dialogEpoch.get(sessionId) !== epoch;
    const send = (seen: boolean): void => {
      if (seenOnly && !seen) {
        this.deps.log?.('info', `[hooks] awaiting_input for ${sessionId} dropped: queued behind a settled dialog and none seen on screen`);
        dropped();
        return;
      }
      if (stale()) {
        this.deps.log?.('info', `[hooks] awaiting_input for ${sessionId} stood down: answered or superseded during the screen read`);
        dropped();
        return;
      }
      try {
        raise();
      } catch (err) {
        this.deps.log?.('warn', `[hooks] awaiting_input fan-out for ${sessionId} threw: ${String(err)}`);
      }
    };
    const read = (attempt: 1 | 2): void => {
      if (stale()) { dropped(); return; }
      let result: Promise<boolean | null>;
      try {
        result = verifyOnScreen(sessionId);
      } catch (err) {
        this.deps.log?.('warn', `[hooks] dialog screen check failed for ${sessionId}: ${String(err)}`);
        send(false);
        return;
      }
      result.then((up) => {
        if (up !== false) { send(up === true); return; }
        if (stale()) { dropped(); return; }
        if (attempt === 1) {
          const t = setTimeout(() => read(2), DIALOG_RECHECK_MS);
          t.unref?.();
          return;
        }
        this.deps.log?.('info', `[hooks] awaiting_input for ${sessionId} dropped: no permission_prompt Notification and no dialog on screen`);
        dropped();
      }, (err: unknown) => {
        this.deps.log?.('warn', `[hooks] dialog screen check failed for ${sessionId}: ${String(err)}`);
        send(false);
      });
    };
    read(1);
  }

  /**
   * Drop every ledger + authority entry for a disposed pane. Wired to
   * session:died / session:destroyed so a long daemon lifetime does not
   * accumulate dead-id entries, and so a reused id starts from the detector
   * backstop rather than an inherited hook veto.
   */
  dropPty(sessionId: string): void {
    this.dialogEpoch.delete(sessionId);
    this.clearTentativeDialog(sessionId);
    this.permissionNotifyPanes.delete(sessionId);
    this.secondLayerRaised.delete(sessionId);
    this.permissionRequests.delete(sessionId);
    this.router.dropPty(sessionId);
    this.leadTurnEnded.delete(sessionId);
    this.endedTurn.delete(sessionId);
    this.lastPromptAt.delete(sessionId);
    // Cancel any open provisional window for the disposed pane — a reused id
    // must start from an empty gate, not an inherited pending confirmation.
    this.alarm.dropPty(sessionId);
    // M2: the pane is gone, so there is no PTY left to press. Without this a
    // phone would keep listing a request whose only possible outcome is a
    // 'prompt-gone' refusal — and a reused session id could inherit it.
    this.deps.approvals?.expireForSession(sessionId, 'pane-gone');
  }

  /** A lead turn end while the pane's latest episode already had its end. */
  private isDuplicateTurnEnd(sessionId: string, signal: AgentSignal): boolean {
    if (signal.kind !== 'agent.stop' && signal.kind !== 'agent.stop_failure') return false;
    const cue = normalizeHookCue(signal);
    if (signal.kind === 'agent.stop' && !(cue.class === 'stop' && !cue.child && cue.leftoverWork === 0)) return false;
    const ended = this.deps.latestEndedTurn?.(sessionId) ?? null;
    const last = this.endedTurn.get(sessionId);
    if (ended === null || last?.turn !== ended || last.signature !== turnEndSignature(signal)) return false;
    this.deps.log?.('info', `[hooks] ${signal.kind} for ${sessionId} dropped: turn ${ended} already ended`);
    return true;
  }

  dispose(): void {
    clearInterval(this.floodTimer);
    for (const entry of this.tentativeDialogs.values()) entry.cancel();
    this.tentativeDialogs.clear();
    this.alarm.dispose();
  }
}

/** Most questions an AskUserQuestion answer report is read for (Claude asks at most four). */
const REPORTED_ANSWERS_MAX = 8;

/**
 * The answers a Claude AskUserQuestion PostToolUse reports
 * (`tool_response.answers`: question text → answer), or undefined when the
 * payload carries none in that shape.
 */
export function reportedAnswers(payload: unknown): Readonly<Record<string, string>> | undefined {
  const response = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>)['tool_response'] : undefined;
  const answers = response !== null && typeof response === 'object' && !Array.isArray(response)
    ? (response as Record<string, unknown>)['answers']
    : undefined;
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return undefined;
  const entries = Object.entries(answers as Record<string, unknown>);
  if (entries.length === 0 || entries.length > REPORTED_ANSWERS_MAX) return undefined;
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [question, answer] of entries) {
    if (typeof answer !== 'string') return undefined;
    out[question] = answer;
  }
  return out;
}
