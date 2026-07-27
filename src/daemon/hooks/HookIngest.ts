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
import { HookSignalRouter } from '../../shared/hooks/HookSignalRouter';
import { SignalLatencyMeter, type LatencyStats } from '../../shared/hooks/SignalLatencyMeter';
import { HookFloodMeter, describeHookFlood, type HookFloodSummary } from '../../shared/hooks/HookFloodMeter';
import {
  isAgentSignal,
  agentSlugToDisplay,
  type AgentSignal,
  type AgentSignalKind,
  type HookSignalResponse,
} from '../../shared/hooks/signal-types';
import { ENV_KEYS } from '../../shared/constants';
// Pure regex/lookup module (no electron), already imported by src/daemon/index.ts.
import { agentDisplayToSlug, agentStatusToSignalKind, type AgentEventStatus } from '../../main/pty/AgentDetector';
import type { ResumeBinding, PermissionMode } from '../../shared/agentResume';
import type { ApprovalHookSink } from '../approvals/types';
import { extractAskUserQuestion } from '../approvals/askUserQuestion';

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
 *   - 'veto'  → detector-only, hook-governed pane: metadata/status dot only,
 *               no notification and no lifecycle tee (the hook is canonical
 *               here and the detector's always-visible footer would both
 *               re-fire mid-turn and poison the ledger against the real Stop)
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
 */
export interface HookArbitration {
  source: 'hook' | 'detector';
  /** Present only for source:'hook'. The canonical envelope kind. */
  hookKind?: AgentSignalKind;
  decision?: 'emit' | 'dedup' | 'veto' | 'activity';
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
   * Chat View — tell the TranscriptProjector that this pane's transcript may
   * have grown. Fired for EVERY resolved signal, including the non-emit kinds:
   * `agent.activity` is the mid-turn liveness nudge, `agent.session_start`
   * invalidates a reused pane's cached conversation, and the stop kinds are the
   * first nudge that can carry a freshly-captured `transcriptPath`.
   *
   * Fired AFTER the resume-binding capture above, because that capture is what
   * makes the path available at all. Cheap when nobody is subscribed.
   *
   * Optional: only the daemon supplies it, and no hook behaviour depends on it.
   */
  onTranscriptNudge?: (sessionId: string, kind: AgentSignalKind) => void;
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
function isMetadataKind(kind: AgentSignalKind): kind is 'agent.activity' | 'agent.session_start' {
  return kind === 'agent.activity' || kind === 'agent.session_start';
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

  constructor(deps: HookIngestDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.meter = new SignalLatencyMeter();
    this.router = new HookSignalRouter({
      latencyMeter: this.meter,
      ...(deps.dedupWindowMs !== undefined ? { dedupWindowMs: deps.dedupWindowMs } : {}),
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
    // isGovernedFor before fanning out its own notifications.
    this.router.touchAuthority(sessionId, signal.agent, this.now());

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
      const transcriptPath = typeof signal.payload?.transcript_path === 'string'
        ? signal.payload.transcript_path
        : undefined;
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

    // Chat View tail nudge. Rides every resolved signal rather than a new hook,
    // and is wrapped because a projector failure must not turn into a fatal
    // hook — the bridge treats an RPC error as one.
    try {
      this.deps.onTranscriptNudge?.(sessionId, signal.kind);
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

    const decision = this.router.recordHook(signal, sessionId, this.now());
    this.driveApprovals(signal, sessionId, decision, sessions);
    const { status, message } = eventShapeFor(signal.kind);
    // Broadcast on BOTH decisions. 'dedup' is not a drop: the detector already
    // fanned out this turn, and a forensic consumer still wants to see that the
    // hook landed. Suppression is the CONSUMER's job, gated on `decision` —
    // see HookArbitration.
    return this.broadcast(sessionId, {
      agent: agentSlugToDisplay(signal.agent),
      status,
      message,
      source: 'hook',
      hookKind: signal.kind,
      decision,
      signal,
    });
  }

  /**
   * M2 — drive the approval registry off an emit-class hook signal.
   *
   *   awaiting_input, decision 'emit' → create a request (superseding any
   *                                     pending one on the same pane)
   *   agent.stop                      → expire whatever was pending
   *
   * Why `decision:'emit'` only: a 'dedup' awaiting_input is the SAME turn
   * boundary the detector already reported, not a second question. Creating on
   * it would mint a duplicate request for one prompt and — through the
   * supersede rule — immediately kill the record a phone might already be
   * looking at. A genuine re-prompt arrives as a fresh emit and supersedes
   * properly.
   *
   * Why stop expires on ANY decision: a dedup'd stop is still a turn that
   * ended, so the question is moot either way. `agent.subagent_stop`
   * deliberately does NOT expire — a subagent finishing says nothing about the
   * main agent's prompt still sitting on screen.
   *
   * Detector-sourced awaiting_input never reaches here at all (this is the hook
   * path), which is the CommanderEventCoalescer bar enforced structurally: a
   * regex match is a suspicion, and this registry writes bytes into terminals.
   */
  private driveApprovals(
    signal: AgentSignal,
    sessionId: string,
    decision: 'emit' | 'dedup',
    sessions: HookIngestSession[],
  ): void {
    const approvals = this.deps.approvals;
    if (!approvals) return;
    if (signal.kind === 'agent.stop') {
      approvals.expireForSession(sessionId, 'turn-ended');
      return;
    }
    if (signal.kind !== 'agent.awaiting_input' || decision !== 'emit') return;
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
  arbitrateDetector(sessionId: string, event: { agent: string; status: string }): HookArbitration {
    const source = 'detector' as const;
    const slug = agentDisplayToSlug(event.agent);
    if (!slug) return { source };
    const kind = agentStatusToSignalKind(event.status as AgentEventStatus);
    if (!kind || kind === 'agent.activity') return { source };
    if (kind !== 'agent.awaiting_input' && this.router.isGovernedFor(sessionId, slug, this.now())) {
      return { source, decision: 'veto' };
    }
    return { source, decision: this.router.recordDetector(slug, kind, sessionId, this.now()) };
  }

  /**
   * Drop every ledger + authority entry for a disposed pane. Wired to
   * session:died / session:destroyed so a long daemon lifetime does not
   * accumulate dead-id entries, and so a reused id starts from the detector
   * backstop rather than an inherited hook veto.
   */
  dropPty(sessionId: string): void {
    this.router.dropPty(sessionId);
    // M2: the pane is gone, so there is no PTY left to press. Without this a
    // phone would keep listing a request whose only possible outcome is a
    // 'prompt-gone' refusal — and a reused session id could inherit it.
    this.deps.approvals?.expireForSession(sessionId, 'pane-gone');
  }

  dispose(): void {
    clearInterval(this.floodTimer);
  }
}
