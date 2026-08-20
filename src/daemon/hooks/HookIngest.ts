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

import path from 'node:path';
import crypto from 'node:crypto';
import { HookSignalRouter } from '../../shared/hooks/HookSignalRouter';
import {
  CompletionAlarm,
  normalizeHookCue,
  normalizeDetectorCue,
  type AlarmCue,
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
import { ENV_KEYS } from '../../shared/constants';
// Pure regex/lookup module (no electron), already imported by src/daemon/index.ts.
import { agentDisplayToSlug, agentStatusToSignalKind, type AgentEventStatus } from '../../main/pty/AgentDetector';
import type { ResumeBinding, PermissionMode } from '../../shared/agentResume';
import type { ApprovalHookSink } from '../approvals/types';
import { extractAskUserQuestion } from '../approvals/askUserQuestion';
import { checkTranscriptPath } from './transcriptPathGuard';

/** Rolling flood-summary interval. Mirrors the main-side handler. */
const HOOK_FLOOD_LOG_INTERVAL_MS = 30_000;

/** X6 ③: known permission modes, for validating the bridge's payload field. */
const VALID_PERMISSION_MODES: ReadonlySet<string> = new Set([
  'bypassPermissions',
  'acceptEdits',
  'plan',
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
  status: 'complete' | 'awaiting_input' | 'running';
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
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
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
  ) => void;
  /**
   * CompletionAlarm — emit a DETECTOR-sourced `agent.event` whose completion
   * window has just CONFIRMED. The detector emission site (daemon/index.ts
   * `session:agent`) broadcasts immediately for everything else, but a held
   * candidate has already returned `decision:'pending'` to that site, so the
   * only path left for its stash is this callback at window expiry.
   *
   * Optional: only the daemon supplies it, and no hook behaviour depends on it.
   */
  emitDetectorEvent?: (sessionId: string, data: DetectorHeldEventData) => void;
  /**
   * #919 — fired after every resolved signal touches hook authority (both the
   * `handle()` path and the permission-gate interceptor). Gives the daemon a
   * single wiring point to ARM the process tracker for bannerless metadata
   * hooks: a quiet claude mid-tool-call must not wait for a detector banner to
   * become corroborable. The session is resolved; the callback owes the caller
   * nothing back and its failure is non-fatal.
   *
   * Optional: only the daemon supplies it.
   */
  onAuthorityTouched?: (sessionId: string) => void;
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
 *      live pane by id.
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
    if (exact) {
      const ws = exact.env?.[ENV_KEYS.WORKSPACE_ID];
      if (!signal.workspaceId || ws === signal.workspaceId) return exact.id;
    }
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
      const clean = v.replace(/[\x00-\x1f\x7f]/g, '').trim();
      return clean.length > TOOL_INPUT_SUMMARY_MAX
        ? clean.slice(0, TOOL_INPUT_SUMMARY_MAX) + '…'
        : clean;
    }
  }
  return undefined;
}

/**
 * Emit-class kinds — the turn boundaries. These are the only kinds that
 * produce a user-visible event and the only ones that touch the dedup ledger.
 */
function isEmitKind(kind: AgentSignalKind): kind is 'agent.stop' | 'agent.subagent_stop' | 'agent.awaiting_input' {
  return kind === 'agent.stop' || kind === 'agent.subagent_stop' || kind === 'agent.awaiting_input';
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
 * pane is reused. They share `decision:'activity'`; consumers tell them apart
 * by `hookKind`.
 */
function isMetadataKind(kind: AgentSignalKind): kind is
  'agent.activity' | 'agent.session_start' | 'agent.tool_started' | 'agent.awaiting_permission' {
  // #783 — agent.tool_started (non-gated tool passed the gate hook, liveness)
  // and agent.awaiting_permission (gated tool blocked, pane STATE) are metadata-
  // only: they ride the same agent.event family tagged decision:'activity', and
  // never touch the dedup ledger (they are not turn boundaries).
  return kind === 'agent.activity'
    || kind === 'agent.session_start'
    || kind === 'agent.tool_started'
    || kind === 'agent.awaiting_permission';
}

/**
 * The detector-shaped `{status, message}` an emit-class hook kind stands for.
 * `message` is chosen so main's existing `${agent}: ${message}` title builder
 * reproduces the hook titles main used to build itself ("Claude Code: Task
 * finished") verbatim.
 */
function eventShapeFor(
  kind: 'agent.stop' | 'agent.subagent_stop' | 'agent.awaiting_input',
): { status: 'complete' | 'awaiting_input'; message: string } {
  switch (kind) {
    case 'agent.stop':
      return { status: 'complete', message: 'Task finished' };
    case 'agent.subagent_stop':
      return { status: 'complete', message: 'Subagent finished' };
    case 'agent.awaiting_input':
      return { status: 'awaiting_input', message: 'Awaiting input' };
  }
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
      onConfirmed: (_pane, _slug, _cls, resume) => {
        resume();
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
   */
  health(): { latency: LatencyStats; flood: HookFloodSummary | null } {
    return {
      latency: this.meter.getStats(),
      flood: this.floodMeter.peek(HOOK_FLOOD_LOG_INTERVAL_MS),
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
      // Agent running outside any wmux pane — fail open.
      return { ok: false, reason: 'no-workspace-match' };
    }

    // Touch authority on every gate signal — the bridge is alive on this pane.
    // `exact` (#919): only exact-ptyId routing may decide identity alone.
    this.router.touchAuthority(sessionId, signal.agent, this.now(), signal.ptyId === sessionId, signal.kind);
    try {
      this.deps.onAuthorityTouched?.(sessionId);
    } catch (err) {
      this.deps.log?.('warn', `[hooks] authority-touch callback failed for ${sessionId}: ${String(err)}`);
    }

    // Verdict-gate feed (R4): PreToolUse never reaches `handle()` — the RPC
    // interceptor routes awaiting_permission straight here — so this is the
    // ONLY working-evidence feed for tool calls on the daemon path. Both the
    // gated and ungated outcome share it, which is the point: an agent about
    // to run ANY tool is working, and this cue must rebut any open completion
    // window before the tool's own output arrives.
    this.alarm.observe(sessionId, signal.agent, normalizeHookCue(signal));

    // Transcript nudge: a PreToolUse means the agent is active.
    try {
      this.deps.onTranscriptNudge?.(sessionId, signal.kind, signal.agentSessionId);
    } catch (err) {
      this.deps.log?.('warn', `[hooks] transcript nudge failed for ${sessionId}: ${String(err)}`);
    }

    const toolName = typeof signal.payload?.tool_name === 'string'
      ? signal.payload.tool_name
      : null;
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
    const isGated = !bypassing && toolName !== null && gatedTools.includes(toolName);

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
      // The agent is running outside any live wmux pane. Expected for
      // standalone use; the per-pane event is dropped, health still recorded.
      return { ok: false, reason: 'no-workspace-match' };
    }

    // Hook authority: EVERY resolved signal marks the pane hook-governed for
    // this agent, including the non-emit kinds (SessionStart, per-tool
    // activity) — freshness tracks "the bridge is alive on this pane", not
    // "a toast just fired". The detector-emission site consults
    // isGovernedFor before fanning out its own notifications. `exact` (#919):
    // a cwd-prefix-resolved signal may corroborate identity but never stand alone.
    this.router.touchAuthority(sessionId, signal.agent, this.now(), signal.ptyId === sessionId, signal.kind);
    try {
      this.deps.onAuthorityTouched?.(sessionId);
    } catch (err) {
      this.deps.log?.('warn', `[hooks] authority-touch callback failed for ${sessionId}: ${String(err)}`);
    }

    // User answered a pending approval locally — no turn boundary, just expire the request.
    // The alarm is fed FIRST: an `answered` cue cancels a pending ATTENTION
    // window, and these kinds return before any other cue-feeding site below.
    this.alarm.observe(sessionId, signal.agent, normalizeHookCue(signal));
    if (signal.kind === 'agent.input_answered') {
      this.deps.approvals?.expireForSession(sessionId, 'answered-locally', 'awaiting_input');
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
    if (
      (signal.kind === 'agent.session_start'
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
      if (claimedPath) {
        const sessionEnv = sessions.find((s) => s.id === sessionId)?.env;
        const check = checkTranscriptPath(claimedPath, signal.agentSessionId, sessionEnv);
        if (check.ok) {
          transcriptPath = claimedPath;
        } else {
          this.deps.log?.(
            'warn',
            `[hooks] refused transcript_path for ${sessionId}: ${check.reason}`,
          );
        }
      }
      try {
        this.deps.applyResumeBinding(sessionId, {
          agent: signal.agent,
          sessionId: signal.agentSessionId,
          cwd: signal.cwd,
          ...(permissionMode ? { permissionMode } : {}),
          ...(transcriptPath ? { transcriptPath } : {}),
          ts: signal.ts,
        });
      } catch (err) {
        // A binding we failed to persist costs an exact resume after a
        // reboot, never the signal itself.
        this.deps.log?.('warn', `[hooks] resume binding failed for ${sessionId}: ${String(err)}`);
      }
    }

    // Transcript tail nudge. Rides every resolved signal rather than a new
    // hook, and is wrapped because a projector failure must not turn into a
    // fatal hook — the bridge treats an RPC error as one.
    try {
      this.deps.onTranscriptNudge?.(sessionId, signal.kind, signal.agentSessionId);
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
      this.alarm.observe(sessionId, signal.agent, normalizeHookCue(signal));
      // M2: a fresh session on this pane means the question the PREVIOUS
      // session asked will never be answered — the same reasoning that makes
      // session_start clear main's stale pendingQuestion label applies to a
      // pending approval, except here the stale record would let someone press
      // a key into a conversation that no longer exists.
      if (signal.kind === 'agent.session_start') {
        this.deps.approvals?.expireForSession(sessionId, 'session-start');
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
    if (signal.kind === 'agent.subagent_stop') {
      // Never a lead-turn end, and never a verdict about one: the cue is a
      // NO-OP in the alarm — it leaves a window the lead turn's own stop
      // opened untouched, because cancelling there loses that completion with
      // nothing left to re-fire. Status only. The
      // pane's own turn keeps going, so the broadcast says RUNNING — taking a
      // subagent's 'complete' at face value would flip the status dot (and the
      // phone liveness header, which special-cases this hookKind) mid-turn.
      this.alarm.observe(sessionId, signal.agent, cue);
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

    // Awaiting input keeps its phone card IMMEDIATELY (R5): a remote device
    // must see the question while the provisional window runs, not 1.5s later.
    if (signal.kind === 'agent.awaiting_input') {
      this.noteAwaitingInput(signal, sessionId, sessions);
    }

    const { status, message } = eventShapeFor(signal.kind);
    const resume = () => {
      const decision = this.router.recordHook(signal, sessionId, this.now());
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
    const workspaceId = sessions.find((s) => s.id === sessionId)?.env?.[ENV_KEYS.WORKSPACE_ID];
    // A4 — carry WHAT is being asked. Extraction happens here because this is
    // the envelope-aware layer; the registry never learns hook payload shapes.
    // Total and non-throwing (see extractAskUserQuestion): an unusable payload
    // yields absent fields, never a skipped request.
    const asked = extractAskUserQuestion(signal.payload);
    approvals.noteHookAwaitingInput({
      sessionId,
      agent: signal.agent,
      ...(workspaceId ? { workspaceId } : {}),
      ...(asked.question ? { question: asked.question } : {}),
      ...(asked.options ? { options: asked.options } : {}),
      ...(asked.choices ? { choices: asked.choices } : {}),
    });
  }

  /**
   * Fan out one `agent.event`. A broken pipe is reported to the bridge as
   * `internal-error` rather than thrown: the bridge runs inside the agent's
   * process on a hard 2s budget and treats an RPC error as a fatal hook.
   */
  private broadcast(sessionId: string, data: HookAgentEventData): HookSignalResponse {
    try {
      this.deps.emitAgentEvent(sessionId, data);
    } catch (err) {
      this.deps.log?.('warn', `[hooks] agent.event broadcast failed for ${sessionId}: ${String(err)}`);
      return { ok: false, reason: 'internal-error' };
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
   *     proceed?", the permission-mode Y/N gate) have no hook at all, so the
   *     detector regexes are their only signal source. Vetoing them would
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
    // excludes `awaiting_input` (and every non-lifecycle status) and adds the
    // turn-liveness scope that plain `isGovernedFor` lacks: a live bridge on an
    // IDLE pane must not veto the detector's true "ready for input" read.
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
    const resume = () => {
      const decision = this.router.recordDetector(slug, kind, sessionId, this.now());
      try {
        this.deps.emitDetectorEvent?.(sessionId, {
          agent: event.agent,
          status: event.status,
          message: event.message ?? '',
          source,
          decision,
        });
      } catch (err) {
        this.deps.log?.(
          'warn',
          `[hooks] held detector broadcast failed for ${sessionId}: ${String(err)}`,
        );
      }
    };
    const outcome = this.alarm.observe(sessionId, slug, cue, resume);
    if (outcome === 'hold') return { source, decision: 'pending' };
    return { source, decision: 'internal' };
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
   * Drop every ledger + authority entry for a disposed pane. Wired to
   * session:died / session:destroyed so a long daemon lifetime does not
   * accumulate dead-id entries, and so a reused id starts from the detector
   * backstop rather than an inherited hook veto.
   */
  dropPty(sessionId: string): void {
    this.router.dropPty(sessionId);
    // Cancel any open provisional window for the disposed pane — a reused id
    // must start from an empty gate, not an inherited pending confirmation.
    this.alarm.dropPty(sessionId);
    // M2: the pane is gone, so there is no PTY left to press. Without this a
    // phone would keep listing a request whose only possible outcome is a
    // 'prompt-gone' refusal — and a reused session id could inherit it.
    this.deps.approvals?.expireForSession(sessionId, 'pane-gone');
  }

  dispose(): void {
    clearInterval(this.floodTimer);
    this.alarm.dispose();
  }
}
