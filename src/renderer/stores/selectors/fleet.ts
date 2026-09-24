import type { AgentStatus, Task, PaneLeaf, Surface } from '../../../shared/types';
import { getLeafPanes, getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { stashedPaneLiveness } from '../../../shared/paneStash';
import { isBrainPtyId } from '../../../shared/constants';
import { remoteAgentKey } from '../../../shared/remoteHosts';
import type { AttachedRemoteWorkspace } from '../slices/remoteWorkspacesSlice';
import type { StoreState } from '../index';
import { flattenAgentText } from '../../../shared/assistantPreview';
import type { WorkTask } from '../../../shared/workTask';

// ─── S-C1 Fleet View — derived "all agents, all workspaces" model ────────────
//
// Pure derivation over `state.workspaces`. Every workspace is eagerly loaded
// with its full pane tree (workspaceSlice.loadSession sets
// `state.workspaces = data.workspaces`), so background workspaces are complete
// data structures — just unrendered. There is therefore no daemon round-trip
// and no dedicated `fleetSlice`: duplicating the tree into a second store would
// only invite staleness. Fleet View adds a UI flag (uiSlice) and this selector.

export interface FleetPane {
  workspaceId: string;
  workspaceName: string;
  paneId: string;
  surfaceId: string;
  /** Active surface's PTY id. '' when the surface has not spawned a PTY yet. */
  ptyId: string;
  agentStatus: AgentStatus;
  /** Only populated for the workspace's ACTIVE pane — see status fidelity note. */
  agentName?: string;
  /** P2 — the user's pane rename (paneLabel mirror), if any. The card's
   *  displayName prefers this so a rename shows in the cockpit too; undefined
   *  falls back to agentName/title. */
  paneLabel?: string;
  cwd?: string;
  title: string;
  surfaceType: 'terminal' | 'browser' | 'editor' | 'diff' | 'git' | 'review' | 'remote-terminal';
  /** True when this leaf is its workspace's active pane (badge fidelity hint). */
  isActivePane: boolean;
  /**
   * Hook-driven activity line for the active surface's PTY (fleet-activity-line
   * -hook.md). Sourced from the per-ptyId `surfaceActivity` map (PostToolUse →
   * summarizeActivity → throttled in main). Present only for panes whose agent
   * emits PostToolUse hooks; FleetCard falls back to the raw scrollback tail
   * when absent. Reflects the most recent FINISHED tool, not the live one.
   */
  activity?: string;
  /**
   * X8 supervision mirror for this pane's active-surface PTY, from the per-ptyId
   * `supervisionByPtyId` slice (daemon PaneSupervisor sticky status + restart
   * count). Undefined when the pane is unsupervised. Lets the cockpit show that
   * a declared/unattended agent is armed (and how many times it has restarted)
   * or that its runaway guard tripped (`stopped` — the supervisor gave up and a
   * human is needed).
   */
  supervision?: { status: 'armed' | 'stopped'; restartCount: number };
  /**
   * True when this pane is stashed (#977) — owned and running, but not in the
   * layout. Fleet is deliberately layout-independent (README: "every roster in
   * the app derives from this one selector"), so a stashed agent that starts
   * waiting on the user must still light the workspace dot and the "N need you"
   * chip. Consumers use the flag to unstash before jumping, since every focus
   * path filters on the visible tree and would otherwise no-op in silence.
   */
  stashed?: boolean;
  /**
   * DISPLAY state, not a status: this pane reads 'running' but nothing has
   * reported in for UNVERIFIABLE_AFTER_MS, so "busy" is no longer a claim the
   * app can stand behind. Deliberately NOT a new AgentStatus value — the
   * roll-up ranking, the needs-you ordering and the pane_list schema all stay
   * exactly as they are; only the rendition changes (hollow amber ring +
   * "No update for 34m").
   */
  unverifiable: boolean;
  /** Milliseconds since this pane's last activity stamp. Only set when
   *  `unverifiable` — it is that state's evidence, and its label. */
  staleForMs?: number;
  /**
   * #1343 — this row is an agent session running on a REMOTE host, mirrored in
   * as a remote-terminal surface. Present only when the caller supplied
   * `remoteWorkspaces` AND a live (non-stale) host entry carries agent
   * metadata for the session. `ptyId` is then the synthetic
   * `remote:{hostId}:{sessionId}` key, never a local ptyId.
   *
   * Consumers that COMMAND panes (DeckFleet) must not list these: a remote
   * pane is only drivable through the host's own input API, not the local
   * input path. They already exclude them twice over — by not passing
   * `remoteWorkspaces` at all, and by filtering on `surfaceType === 'terminal'`
   * (a remote row keeps `surfaceType: 'remote-terminal'`).
   */
  remote?: { hostId: string; hostLabel: string };
  /**
   * The local ptyId of the BACKGROUND tab whose attention status won this
   * row's rollup (a background tab awaiting input while the active tab is
   * idle). Set only when it differs from `ptyId`. Whatever acts on or reads
   * the row's urgent state — its question, its last message, a Message verb,
   * a jump — targets this pty (`fleetTargetPtyId`), not the active tab.
   */
  attentionPtyId?: string;
}

/** The pty a row's urgent state lives on: the winning background tab, else
 *  the active surface. */
export function fleetTargetPtyId(pane: Pick<FleetPane, 'ptyId' | 'attentionPtyId'>): string {
  return pane.attentionPtyId ?? pane.ptyId;
}

/** Minimal store surface the selector reads — keeps the fixture trivial and the
 *  subscription narrow (the FleetView memoizes on exactly these fields). */
export type FleetSelectorState = Pick<StoreState, 'workspaces' | 'surfaceAgentStatus' | 'surfaceActivity'> & {
  /** P2 — pane rename mirror. Optional so existing fixtures stay terse; the
   *  live FleetView always passes the real map. */
  paneLabel?: StoreState['paneLabel'];
  /** X8 supervision mirror (per-ptyId). Optional so existing fixtures stay
   *  terse; the live FleetView always passes the real map. */
  supervisionByPtyId?: StoreState['supervisionByPtyId'];
  /** Hook-driven 'running' inputs (orca-style). Both optional so existing
   *  fixtures/tests get the pre-existing behavior (no hook-freshness); the live
   *  store always provides them. `agentClockMs` is the read-time clock so a
   *  stale stamp decays without a new event (bumped by useAgentActivityClock). */
  surfaceActivityAt?: StoreState['surfaceActivityAt'];
  agentClockMs?: StoreState['agentClockMs'];
  /** Per-PTY agent identity — gates workspace-level metadata inheritance so a
   *  non-agent active pane (e.g. btop) never borrows the agent's name/status.
   *  Optional so existing fixtures stay terse. */
  surfaceAgent?: StoreState['surfaceAgent'];
  /** #1168 — per-PTY transcript-derived pending question. The roster promotes
   *  this straight to `awaiting_input` ("the strongest evidence that this agent
   *  needs input"); this pass has to read the same signal or the dot above the
   *  roster contradicts it. Optional so existing fixtures stay terse. */
  surfacePendingQuestion?: StoreState['surfacePendingQuestion'];
  /** Liveness inputs for the `unverifiable` display state — the same two maps
   *  `isPaneAgentBusy` ranks above the heuristic. A pane whose shell is back at
   *  a prompt or whose agent process is gone is IDLE, not unverifiable, so a
   *  `false` in either map vetoes the ring. Optional so existing fixtures stay
   *  terse; the live store always provides them. */
  commandRunningByPtyId?: StoreState['commandRunningByPtyId'];
  agentAliveByPtyId?: StoreState['agentAliveByPtyId'];
  /** The hook turn latch — ptyId → turn-start stamp, present only while the
   *  pane's agent has an open turn nobody has ended. See surfaceTurnOpenAt in
   *  paneSlice: this is a CLAIM the selector must not age out, unlike
   *  `surfaceActivityAt`, which is evidence and decays at HOOK_RUNNING_TTL_MS.
   *  Optional so existing fixtures stay terse. */
  surfaceTurnOpenAt?: StoreState['surfaceTurnOpenAt'];
  /**
   * PRECOMPUTED hook-'running' verdicts, ptyId → true. Supplied instead of
   * `agentClockMs` by a consumer that must not re-run on every clock tick: the
   * decay clock bumps every 2 s while any agent is fresh, and the ONLY thing it
   * can change about a roster row is whether that row's activity stamp has aged
   * past HOOK_RUNNING_TTL_MS — which is precisely this map. Subscribing to it
   * shallowly turns "re-derive the fleet every 2 s" into "re-derive it when a
   * dot actually flips".
   *
   * Produced by `selectHookRunningByPtyId`, which calls the same `isHookRunning`
   * this selector would have called, so the two cannot drift. When absent the
   * selector derives it inline from the clock, exactly as before.
   */
  hookRunningByPtyId?: Record<string, boolean>;
  /**
   * #1343 — attached remote-host mirrors. Supplied ONLY by consumers that
   * should see remote agents (Fleet View, the titlebar vitals chip). Left out,
   * remote-terminal surfaces derive exactly as before: an anonymous idle row
   * with an empty ptyId. See FleetPane.remote.
   */
  remoteWorkspaces?: AttachedRemoteWorkspace[];
  /** ptyId → the agent's last reported message (the Fleet row's one-line
   *  detail for finished and idle turns). Optional so existing fixtures stay
   *  terse; the live store always provides it. */
  surfaceLastMessage?: StoreState['surfaceLastMessage'];
};

/**
 * The agent metadata a remote-terminal surface can claim, or undefined.
 *
 * Shared by the sidebar roster (#1163) and the fleet pass (#1343) so the two
 * can never disagree about which remote sessions count as agents.
 *
 * Two rules, both load-bearing:
 *   - Search EVERY entry on the host, not just the first: multiple attached
 *     workspaces per host are supported (the dedup key is hostId:workspaceId),
 *     so a session in the host's second workspace must still resolve.
 *   - A STALE entry (host unreachable) keeps its last pane snapshot for the
 *     mirror, but its agent status is frozen at the last successful poll —
 *     counting it would report a disconnected agent as live (or as needing
 *     you) indefinitely. No live metadata, no agent.
 */
export function resolveRemoteAgent(
  remoteWorkspaces: AttachedRemoteWorkspace[] | undefined,
  hostId: string | undefined,
  sessionId: string | undefined,
): { agentName: string; status: AgentStatus; hostLabel: string } | undefined {
  if (!remoteWorkspaces || !hostId || !sessionId) return undefined;
  const attached = remoteWorkspaces.find(
    (r) => r.hostId === hostId && !r.stale && r.panes.some((p) => p.sessionId === sessionId),
  );
  const pane = attached?.panes.find((p) => p.sessionId === sessionId);
  if (!pane?.agentName) return undefined;
  return {
    agentName: pane.agentName,
    status: pane.agentStatus ?? 'idle',
    hostLabel: attached?.hostLabel ?? hostId,
  };
}

/**
 * How long after a pane's last PostToolUse hook it still counts as 'running'
 * with no further signal. Generous on purpose (orca uses a 30-min safety net):
 * a real Claude turn ends via the Stop hook → 'complete' (an attention status
 * that outranks this), so this window only governs the "agent is thinking
 * between tools / a hook-less agent is working" case. Long enough to survive a
 * quiet reasoning gap or a multi-second tool, short enough that a crashed agent
 * (no Stop) settles to idle promptly.
 */
export const HOOK_RUNNING_TTL_MS = 120_000;

/**
 * The 'running' claim, from the two things that can make it — shared so every
 * per-pane consumer derives it identically.
 *
 * Two inputs, and the difference between them is the whole point:
 *   - `turnOpenAt` is a CLAIM. The agent's own turn-start hook said a turn
 *     began and nothing has said it ended, so it does not decay: a quiet turn
 *     (a long bash, a web search, silent reasoning) is still a turn.
 *   - `activityAt` is EVIDENCE, and evidence goes stale. It carries panes whose
 *     agent reports no turn start at all, and only within HOOK_RUNNING_TTL_MS.
 *
 * A consumer that reads only the second one disagrees with the workspace dot
 * about the same pane the moment a turn goes quiet past the TTL — live-observed
 * as an amber workspace row over a roster row reading "Idle".
 */
export function isHookRunning(args: {
  /** `surfaceActivityAt[ptyId]` — last agent-activity stamp (ms), if any. */
  activityAt: number | undefined;
  /** `surfaceTurnOpenAt[ptyId]` — the open-turn latch stamp, if any. */
  turnOpenAt: number | undefined;
  /** The reactive decay clock (`state.agentClockMs`). */
  agentClockMs: number | undefined;
}): boolean {
  const { activityAt, turnOpenAt, agentClockMs } = args;
  if (turnOpenAt !== undefined && turnOpenAt > 0) return true;
  return (
    activityAt !== undefined
    && activityAt > 0
    && agentClockMs !== undefined
    && agentClockMs - activityAt <= HOOK_RUNNING_TTL_MS
  );
}

/**
 * How long a pane may sit at 'running' with no signal of any kind before the
 * UI stops repeating the claim and says so instead ("No update for 34m").
 *
 * Mirrors `HOOK_AUTHORITY_TTL_MS` in `src/shared/hooks/HookSignalRouter.ts`:
 * past that window main no longer treats the hook stream as the authority on
 * this pane, so the renderer should not keep painting a confident amber dot
 * from it either. Deliberately a copy of the number rather than an import —
 * this file is renderer-pure and must not reach into main.
 */
export const UNVERIFIABLE_AFTER_MS = 30 * 60_000;

/**
 * Whole minutes of silence → the compact duration the ring's tooltip names.
 *
 * Caps at "30m+" rather than counting on: UNVERIFIABLE_AFTER_MS is 30 minutes,
 * so every value this is ever called with is already ≥ 30, and the precise
 * figure past that point is not something the app can stand behind either — the
 * clock that produces it ticks every 30 s only while a turn latch is open, and
 * exact minutes would be a second confident claim layered on top of the one the
 * ring exists to withdraw. "30m+" is the honest reading, and it is stable, so
 * the label stops re-rendering the sidebar for a number nobody is watching.
 */
export function formatStaleMinutes(minutes: number): string {
  return minutes >= 30 ? '30m+' : `${minutes}m`;
}

/**
 * Whether an agent is actively occupying a pane's active surface — the gate the
 * persistent resume chip (ResumeInfoChip) uses to stay hidden while a live agent
 * TUI owns the pane. Typing a resume command into a running agent would land in
 * the agent's input, not a shell, so the chip only surfaces once the agent has
 * settled or exited.
 *
 * Three tiers:
 *   1. AUTHORITATIVE — the OSC 133 shell-integration signal (`commandRunning`),
 *      when the pane's shell emits markers. `true` = a foreground command owns
 *      the PTY (busy); `false` = at a shell prompt (idle). This closes the gap
 *      the heuristic can't: a `claude` that sits idle past the activity TTL is
 *      still `commandRunning: true`, so the chip stays hidden the whole time it
 *      is up, and reappears the moment the shell is back at a prompt.
 *   2. PROCESS TRUTH (`agentProcessAlive`, daemon AgentProcessTracker) — the
 *      edge trigger for panes WITHOUT shell integration. `true` = the agent
 *      process is observed alive (a quiet claude past the TTL is still busy);
 *      `false` = it was observed and DIED — the alive→dead edge, however the
 *      agent exited (double Ctrl+C, /exit, crash). `undefined` = never
 *      attributed → fall through.
 *   3. HEURISTIC FALLBACK (both above undefined) — an OPEN HOOK TURN
 *      (`turnOpen`, which does not decay: the agent's own hook said a turn
 *      started and nothing has said it ended) OR
 *      recent hook activity within the TTL (focus-safe — `surfaceActivityAt` is
 *      NOT cleared on focus the way `surfaceAgentStatus` is) OR a live attention
 *      status still carried on a non-focused pane. `agentClockMs` freezes at
 *      `activityAt + TTL + grace` once every agent settles, so
 *      `agentClockMs - activityAt` exceeds the TTL and this flips false.
 */
export function isPaneAgentBusy(args: {
  /** `surfaceActivityAt[ptyId] ?? 0` — last agent-activity stamp (ms). */
  activityAt: number;
  /** The reactive decay clock (`state.agentClockMs`). */
  agentClockMs: number;
  /** `surfaceAgentStatus[ptyId]` — the pane's live attention status, if any. */
  status: AgentStatus | undefined;
  /**
   * `commandRunningByPtyId[ptyId]` — OSC 133 shell state. `true`/`false` is
   * authoritative and short-circuits; `undefined` (no shell integration) falls
   * through to the process-truth tier.
   */
  commandRunning?: boolean;
  /**
   * `agentAliveByPtyId[ptyId]` — process-truth agent liveness. `true`/`false`
   * short-circuits the heuristic; `undefined` (never attributed) falls through.
   */
  agentProcessAlive?: boolean;
  /**
   * `surfaceTurnOpenAt[ptyId] > 0` — the pane's hook reported a turn start and
   * nothing has reported its end. Sits inside tier 3 rather than above it: the
   * two authoritative tiers observe the PROCESS, and a process that is provably
   * gone outranks a claim its own hook left dangling.
   */
  turnOpen?: boolean;
}): boolean {
  const { activityAt, agentClockMs, status, commandRunning, agentProcessAlive, turnOpen } = args;
  // Tier 1 — authoritative OSC 133 signal. Ranked above process truth: when
  // the shell says it is back at a prompt, typing is safe even if some
  // background descendant lingers — and vice versa, a foreground non-agent
  // command (the agent died, the user ran `npm test`) must keep the chip away.
  if (commandRunning === true) return true;
  if (commandRunning === false) return false;
  // Tier 2 — process truth (the edge trigger).
  if (agentProcessAlive === true) return true;
  if (agentProcessAlive === false) return false;
  // Tier 3 — the hook's open-turn latch, then the activity heuristic.
  const hookRunning =
    turnOpen === true
    || (activityAt > 0 && agentClockMs - activityAt <= HOOK_RUNNING_TTL_MS);
  return (
    hookRunning ||
    status === 'running' ||
    status === 'waiting' ||
    status === 'awaiting_input' ||
    status === 'error'
  );
}

// Priority of each status for "which one wants the user most". Lower = more
// urgent. Drives both the per-leaf attention scan (a background tab can be
// awaiting_input while the active tab is idle) and the grid sort.
const STATUS_RANK: Record<AgentStatus, number> = {
  awaiting_input: 0,
  waiting: 1,
  error: 2,
  complete: 3,
  running: 4,
  idle: 5,
};

/**
 * Status fidelity (S-C1 v1, confirmed scope):
 * `surfaceAgentStatus` only retains the ATTENTION statuses
 * (complete / waiting / awaiting_input / error) keyed per-ptyId — see paneSlice
 * ATTENTION_STATUSES. `running` / `idle` are *deleted* from that map,
 * so they are not available per background pane. Resolution order:
 *   1. surfaceAgentStatus[ptyId]  — accurate for attention states everywhere
 *   2. ws.metadata.agentStatus    — workspace-level, only valid for the ACTIVE pane
 *   3. 'idle'                      — default
 * `agentName` is likewise workspace-level (active-pane-derived), so it is
 * exposed only for the active pane to avoid mislabeling background panes.
 */
/**
 * The tab that represents a STASHED pane in single-row rollups (#977) — shared
 * by the sidebar roster and the fleet selector so the two can never disagree
 * about the same pane. The remembered active tab wins WHILE IT IS ALIVE; if
 * that session died with a sibling still running, deferring to it would report
 * the whole pane as exited with an agent working behind it. Order: the active
 * tab if live, then a live tab with a detected agent, then any live tab, then
 * the dead remnants. Visible panes keep the plain active-tab rule — on screen,
 * the dead active tab IS the thing the user is looking at.
 */
export function pickStashedRepresentativeSurface(
  leaf: PaneLeaf,
  surfaceAgent: Record<string, { name?: string } | undefined>,
): Surface | undefined {
  const terminals = leaf.surfaces.filter((s) => (s.surfaceType ?? 'terminal') === 'terminal');
  const live = terminals.filter((s) => !!s.ptyId);
  return (
    live.find((s) => s.id === leaf.activeSurfaceId)
    ?? live.find((s) => !!surfaceAgent[s.ptyId]?.name)
    ?? live[0]
    ?? terminals.find((s) => s.id === leaf.activeSurfaceId)
    ?? terminals[0]
    ?? leaf.surfaces[0]
  );
}

/**
 * ptyId → true for every pane the hook derivation currently calls 'running'.
 *
 * The clock-dependent half of `selectFleetPanes`, pulled out so a consumer can
 * subscribe to it SHALLOWLY and stop re-deriving the whole roster on a decay
 * tick that flips nothing. Cheap by construction: it walks the two per-pty
 * stamp maps, not the workspace tree.
 *
 * Uses `isHookRunning` — the same function the inline path calls — so a roster
 * fed this map and a roster fed the raw clock cannot disagree.
 */
export function selectHookRunningByPtyId(state: FleetSelectorState): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const turnOpen = state.surfaceTurnOpenAt ?? {};
  const activity = state.surfaceActivityAt ?? {};
  for (const ptyId of new Set([...Object.keys(turnOpen), ...Object.keys(activity)])) {
    if (isHookRunning({
      activityAt: activity[ptyId],
      turnOpenAt: turnOpen[ptyId],
      agentClockMs: state.agentClockMs,
    })) {
      // Only TRUE entries are kept: a shallow compare over a map that also
      // carried `false` would change identity for every pane that ever ran.
      out[ptyId] = true;
    }
  }
  return out;
}

export function selectFleetPanes(state: FleetSelectorState): FleetPane[] {
  const result: FleetPane[] = [];
  for (const ws of state.workspaces) {
    const wsMeta = ws.metadata;
    // Workspace-wide (#977): a stashed agent is off-screen, not off-duty.
    const visibleIds = new Set(getLeafPanes(ws.rootPane).map((l) => l.id));
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      const stashed = !visibleIds.has(leaf.id);
      // Stashed rows use the shared #977 picker (see above) so this card and
      // the sidebar roster can never disagree; visible rows keep the plain
      // active-tab rule the tests pin.
      const surf = stashed
        ? pickStashedRepresentativeSurface(leaf, state.surfaceAgent ?? {})
        : leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId) ?? leaf.surfaces[0];
      const ptyId = surf?.ptyId ?? '';
      // #1343 — a remote-terminal surface has ptyId '' by contract and is
      // invisible to every local PTY-keyed map below, so without this it lands
      // as an anonymous idle card. Resolve it against the attached host mirror
      // instead, with the same rules the sidebar roster uses.
      //
      // IDENTITY is keyed on the leaf's ACTIVE surface, like every other field
      // on this row: this pass is one row per leaf, the roster is one row per
      // surface, so a background tab's agent NAME does not reach the card —
      // exactly as it does not for a background local agent. Its STATUS does,
      // through the rollup below.
      const remoteAgent =
        surf?.surfaceType === 'remote-terminal'
          ? resolveRemoteAgent(state.remoteWorkspaces, surf.remoteHostId, surf.remoteSessionId)
          : undefined;
      // The orchestrator's own brain pty is never a fleet member. It should
      // never reach a surface at all (pty.list filters it), so this is the
      // belt to that braces: every roster in the app — DeckFleet, FleetView,
      // the titlebar vitals chip, the mirror snapshot that feeds the deck
      // briefing — derives from this one selector, so excluding it here keeps
      // the brain from ever listing itself as an agent it can command.
      if (isBrainPtyId(ptyId)) continue;
      const isActivePane = ws.activePaneId === leaf.id;
      // Surface the most-urgent attention status across ANY of the leaf's
      // surfaces (a background TAB can be awaiting_input while the active tab
      // is idle), so a multi-tab pane that needs the user is never silently
      // shown as idle. The card otherwise stays keyed on the active surface.
      let attention: AgentStatus | undefined;
      // The local pty that set `attention` (undefined when a remote tab won).
      let attentionPty: string | undefined;
      // #1343 — the same rollup over the leaf's REMOTE tabs, tracked separately
      // so a remote row is never given a local agent's status (and vice versa)
      // while both still reach the workspace dot and the vitals chip.
      let remoteAttention: AgentStatus | undefined;
      for (const s of leaf.surfaces) {
        if (!s.ptyId) {
          // A remote tab has no ptyId, so the PTY-keyed scan below can never
          // see it. Without this a remote agent asking for the user from a
          // BACKGROUND tab is visible in the sidebar roster (which is per
          // surface) and nowhere else — the exact split this issue exists to
          // close, just one tab deeper.
          const rs = s.surfaceType === 'remote-terminal'
            ? resolveRemoteAgent(state.remoteWorkspaces, s.remoteHostId, s.remoteSessionId)?.status
            : undefined;
          if (rs && (remoteAttention === undefined || STATUS_RANK[rs] < STATUS_RANK[remoteAttention])) {
            remoteAttention = rs;
          }
          if (rs && (attention === undefined || STATUS_RANK[rs] < STATUS_RANK[attention])) {
            attention = rs;
            attentionPty = undefined;
          }
          continue;
        }
        // #1168 — a transcript-derived pending question outranks whatever the
        // stop payload settled this surface to, exactly as it does in
        // workspaceAgentRoster. Without it a payload carrying `complete`
        // alongside an unanswered question painted a green "nothing to see"
        // dot over a red roster row that was printing the question.
        const st = state.surfacePendingQuestion?.[s.ptyId]?.trim()
          ? 'awaiting_input'
          : state.surfaceAgentStatus[s.ptyId];
        // On a tie the active surface wins: equal urgency gives no reason to
        // point the row (detail, Message, Jump) at a background tab.
        if (st && (
          attention === undefined
          || STATUS_RANK[st] < STATUS_RANK[attention]
          || (STATUS_RANK[st] === STATUS_RANK[attention] && s.ptyId === ptyId)
        )) {
          attention = st;
          attentionPty = s.ptyId;
        }
      }
      // Resolution order (most → least authoritative):
      //   1. a retained ATTENTION status on any surface (waiting/complete/…)
      //   2. the active pane's workspace-level status, when it's a live non-idle
      //      state (e.g. detector/byte 'running')
      //   3. hook-driven 'running' — a PostToolUse fired within the TTL, so the
      //      agent is working even if the terminal is quiet (fixes "thinking
      //      mid-turn read as idle"; also lights BACKGROUND running panes, which
      //      never reached workspace metadata). Uses the in-state clock so it
      //      decays on its own. Absent inputs → skipped (legacy behavior).
      //   4. idle.
      // #850: only inherit workspace-level agent metadata when the active
      // pane's PTY has been independently confirmed as an agent (surfaceAgent
      // identity exists). Without this guard a non-agent active pane (btop,
      // vim, a plain shell) inherits the name and status of the workspace's
      // real agent, producing a false "Claude Code · Needs you" card.
      const paneAgentName = ptyId ? state.surfaceAgent?.[ptyId]?.name : undefined;
      const paneIsAgent = !!paneAgentName;
      // Only inherit workspace-level status when this pane IS the agent that
      // set that status — prevents multi-agent workspaces from cross-polluting
      // (#837: one pane's 'running' bleeding into another agent's card).
      const metaMatchesPane = paneIsAgent && wsMeta?.agentName === paneAgentName;
      // #837's 'running' veto stays in force, and the name match above does NOT
      // replace it. `agentStatus` is ONE slot per workspace, so a name match
      // cannot prove the value came from THIS pane whenever two panes run the
      // same agent — an orchestrator and its worker are both "Claude Code",
      // which is the normal shape here, not an exotic one. The worker's
      // 'running' would land in the shared slot and get painted onto the active
      // pane, which is exactly the misattribution #837 fixed. Tier 3's per-pty
      // clock is what carries running, so vetoing it here costs no coverage.
      // `error` is still inherited here, but no longer as its ONLY carrier:
      // it is an ATTENTION status now, so the per-pty attention scan above
      // reaches it on background panes too.
      const metaStatus =
        isActivePane && metaMatchesPane && wsMeta?.agentStatus !== 'running'
          ? wsMeta?.agentStatus
          : undefined;
      const activityAt = ptyId ? state.surfaceActivityAt?.[ptyId] : undefined;
      // The hook's TURN LATCH — set by a `UserPromptSubmit` broadcast, cleared
      // by whatever ends the turn. It does NOT ride the TTL, and that is the
      // whole point: on a hook-governed pane the byte heuristic no longer
      // broadcasts 'running' at all, so a quiet turn (a long bash, a web
      // search, silent reasoning) crossed the 120 s window and went idle
      // MID-TURN with nothing able to bring it back. A latch says "the agent
      // says it is working"; only a turn end takes that back.
      const turnOpenAt = ptyId ? state.surfaceTurnOpenAt?.[ptyId] : undefined;
      const turnOpen = turnOpenAt !== undefined && turnOpenAt > 0;
      const hookRunning = state.hookRunningByPtyId
        ? (!!ptyId && state.hookRunningByPtyId[ptyId] === true)
        : isHookRunning({ activityAt, turnOpenAt, agentClockMs: state.agentClockMs });
      // #1168 — a stashed pane whose every terminal surface has lost its pty is
      // a session the daemon has confirmed gone. The roster reports that as
      // `error` / needs-you and offers recovery; this pass had no liveness
      // handling at all, so the workspace's only entry being a dead stash left
      // the dot neutral grey — "nothing here" for the one state that most wants
      // the user. It cannot contradict the attention scan above, which is why it
      // can sit in front of it: `stashedPaneLiveness` weighs only TERMINAL
      // surfaces, but the only other type a pane may hold and still be stashable
      // is `browser` (STASHABLE_SURFACE_TYPES), and a browser surface is created
      // with `ptyId: ''` and never assigned one — `updateSurfacePtyId` is
      // reached only from the terminal spawn callback and from reconcile. So
      // `exited` really does mean no surface in this leaf holds a ptyId, and
      // every attention source is keyed by one.
      const stashedExited = stashed && stashedPaneLiveness(leaf) === 'exited';
      const status: AgentStatus = stashedExited
        ? 'error'
        : (attention
          ?? (metaStatus && metaStatus !== 'idle' ? metaStatus : undefined)
          ?? (hookRunning ? 'running' : undefined)
          ?? 'idle');
      // ── The 'running' claim's expiry date (display only) ──────────────────
      // Only an OPEN LATCH can get here, and that is the point: a latched
      // 'running' never decays, so a crashed or wedged agent would otherwise
      // keep a confident amber dot forever. Past UNVERIFIABLE_AFTER_MS the
      // renderer says what it actually knows — "no update for 30m+" — without
      // inventing a status. An UNGOVERNED running pane cannot reach this at
      // all: its status comes from the 120 s activity TTL, so it has already
      // gone idle long before 30 minutes of silence.
      // The clock runs from the LATER of the two stamps: a turn that opened
      // quietly and then ran a tool has been heard from at the tool, and a
      // turn opened after an older tool call has been heard from at the prompt.
      // `!== false` on both liveness maps: a shell back at its prompt or an
      // agent process observed dead is IDLE, and the status derivation above
      // owns that case; `undefined` (no shell integration / never attributed)
      // must not veto, or the ring would never appear where it matters most.
      const lastHeardAt = Math.max(activityAt ?? 0, turnOpenAt ?? 0);
      const staleForMs =
        status === 'running' && turnOpen && state.agentClockMs !== undefined
          ? state.agentClockMs - lastHeardAt
          : 0;
      const unverifiable =
        staleForMs > UNVERIFIABLE_AFTER_MS &&
        (ptyId ? state.commandRunningByPtyId?.[ptyId] : undefined) !== false &&
        (ptyId ? state.agentAliveByPtyId?.[ptyId] : undefined) !== false;
      result.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        paneId: leaf.id,
        surfaceId: surf?.id ?? '',
        // The synthetic remote key, so a remote row has a stable non-empty
        // identity for consumers that key on ptyId. It is never a local ptyId,
        // so the PTY-keyed reads below still all miss — which is correct: the
        // host snapshot has no hooks, no activity line, no supervision.
        ptyId: remoteAgent ? remoteAgentKey(surf?.remoteHostId ?? '', surf?.remoteSessionId ?? '') : ptyId,
        // The host poll IS the whole signal for a remote agent: no latch and no
        // workspace-metadata inheritance apply to it, only the rollup over this
        // leaf's own remote tabs.
        agentStatus: remoteAgent ? (remoteAttention ?? remoteAgent.status) : status,
        agentName: remoteAgent
          ? remoteAgent.agentName
          : isActivePane && metaMatchesPane ? wsMeta?.agentName : undefined,
        paneLabel: state.paneLabel?.[leaf.id],
        cwd: surf?.cwd,
        title: surf?.title ?? '',
        surfaceType: surf?.surfaceType ?? 'terminal',
        isActivePane,
        // Per-ptyId activity line for the active surface (keyed like the card
        // itself). Undefined when the agent emits no PostToolUse hook — the
        // card then shows the raw tail. Empty ptyId never has an entry.
        activity: ptyId ? state.surfaceActivity[ptyId] : undefined,
        // X8 supervision mirror for the active surface's PTY (same key as the
        // pane badge). Only supervised panes have an entry; unsupervised →
        // undefined. An unspawned surface (empty ptyId) never carries one.
        supervision: ptyId ? state.supervisionByPtyId?.[ptyId] : undefined,
        unverifiable,
        ...(unverifiable ? { staleForMs } : {}),
        ...(stashed ? { stashed: true } : {}),
        ...(remoteAgent
          ? { remote: { hostId: surf?.remoteHostId ?? '', hostLabel: remoteAgent.hostLabel } }
          : {}),
        ...(!remoteAgent && !stashedExited && attentionPty && attentionPty !== ptyId
          ? { attentionPtyId: attentionPty }
          : {}),
      });
    }
  }
  return result;
}

/** Situational sort mode for the cockpit grid (uiSlice.fleetSortMode). */
export type FleetSortMode = 'attention' | 'workspace';

// Sort order for the cockpit grid — two situational modes:
//   - 'attention' (default): the agents that want the user float to the top
//     (awaiting_input first — the unattended-loop money state, via STATUS_RANK
//     above), idle terminals sink. WITHIN a status tier, panes keep the
//     selector's emission order, which is `state.workspaces` (sidebar) order
//     then leaf order.
//   - 'workspace': mirror the sidebar exactly — pure workspace+leaf order,
//     status ignored. For users who navigate the fleet spatially.
//
// Both break ties by the original index (selector order == sidebar order), NOT
// by workspaceName/title: the old alphabetical localeCompare reordered the grid
// away from the sidebar, which read as "the fleet is in the wrong order". The
// index tie-break is explicit (no reliance on Array.sort stability).
export function sortFleetPanes(
  panes: FleetPane[],
  mode: FleetSortMode = 'attention',
): FleetPane[] {
  return panes
    .map((pane, index) => ({ pane, index }))
    .sort((a, b) => {
      if (mode === 'attention') {
        const r = STATUS_RANK[a.pane.agentStatus] - STATUS_RANK[b.pane.agentStatus];
        if (r !== 0) return r;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.pane);
}

// ─── NB3 trust surface — completion-evidence badge source ────────────────────
//
// The Fleet cockpit's promise is "trust an agent to run unattended". Completion
// evidence (§6.M) is the durable proof an agent left when it finished a
// delegated A2A task; surfacing it on the card is what makes that trust
// legible. This selector answers, per card, "what is the most recent COMPLETED
// A2A task addressed to this pane that carries evidence?" — read straight off
// the existing a2aTasks store (no new store/RPC).
//
// It returns the STORE's own Task reference (never a fresh object) so a
// card-local `useStore` subscription stays reference-stable across unrelated
// store writes: Object.is holds when the winning task is unchanged, so the
// memoized FleetCard does not re-render on every a2a mutation — only when THIS
// pane's latest evidence task actually changes. The card derives the display
// counts from the returned task (see FleetCardEvidenceBadge).
//
// Addressing mirrors the selector's active-pane fidelity rule for `agentName`:
// a pane-pinned task (to.paneId) matches only that exact pane; a workspace-only
// task matches the workspace's ACTIVE pane, so a ws-level completion is not
// duplicated across background sibling panes.
export function selectLatestCompletionEvidenceTask(
  a2aTasks: Record<string, Task>,
  workspaceId: string,
  paneId: string,
  isActivePane: boolean,
): Task | undefined {
  let best: Task | undefined;
  for (const task of Object.values(a2aTasks)) {
    if (task.status.state !== 'completed') continue;
    const evidence = task.status.evidence;
    if (!evidence || evidence.items.length === 0) continue;
    const to = task.metadata.to;
    if (to.workspaceId !== workspaceId) continue;
    // Pane precision: a pinned receiver pane must BE this card; an unpinned
    // (ws-only) task lands on the active pane only.
    if (to.paneId ? to.paneId !== paneId : !isActivePane) continue;
    // "Most recent" = latest completion timestamp (status.timestamp is stamped
    // at the completed transition). Lexicographic compare is chronological for
    // canonical ISO-8601 UTC strings (both produced by isoNow()).
    if (!best || task.status.timestamp > best.status.timestamp) best = task;
  }
  return best;
}

// Statuses that count toward the "N need you" header chip: awaiting_input is the
// precise blocked-mid-turn state; waiting means the turn ended and a fresh
// instruction is wanted. Both are "the agent is idle on you".
export function countNeedsAttention(panes: FleetPane[]): number {
  return panes.filter(
    (p) => p.agentStatus === 'awaiting_input' || p.agentStatus === 'waiting',
  ).length;
}

// ─── Per-workspace status roll-up — the sidebar dot's source ─────────────────
//
// The sidebar workspace dot must reflect the WHOLE workspace, not just its
// active pane. Reading `ws.metadata.agentStatus` directly (the old path) only
// ever saw the active pane and never self-healed, so an agent awaiting input in
// a background split, or a completed turn the user hasn't visited, left the dot
// wrong. This rolls the same per-surface attention scan `selectFleetPanes`
// already does (used by the deck Fleet roster + titlebar vitals) down to a
// single most-urgent status per workspace, via the shared STATUS_RANK.
//
// Returns 'idle' for a workspace with no panes or all-idle panes, so the caller
// renders the neutral dot exactly as before for quiet workspaces.
export function selectWorkspaceAgentStatus(
  state: FleetSelectorState,
  workspaceId: string,
): AgentStatus {
  return workspaceRollups(state).status[workspaceId] ?? 'idle';
}

/**
 * All-workspaces variant — one `selectFleetPanes` pass rolled up to a
 * `{ workspaceId → most-urgent status }` map. For loop renderers (MiniSidebar)
 * that would otherwise call the single-workspace version O(N) times, each a
 * fresh full scan. Workspaces with no non-idle pane are omitted; the caller
 * defaults a missing entry to 'idle'.
 */
export function selectAllWorkspaceAgentStatus(
  state: FleetSelectorState,
): Record<string, AgentStatus> {
  return workspaceRollups(state).status;
}

// ─── Unverifiable roll-ups — the hollow-ring rendition's source ──────────────
//
// All of these report WHOLE MINUTES of silence, not milliseconds: the label is
// minute-granular and capped ("30m+"), and a ms value would change on every
// clock tick, defeating the shallow-compare subscriptions these feed and re-
// rendering the sidebar for a number nobody can see move. 0 = not unverifiable,
// so callers read the value as both the flag and the label.

/**
 * Minutes of silence for a workspace whose whole story is "running, but nobody
 * has heard anything". Returns 0 unless the workspace's roll-up status IS
 * 'running' (so any attention state — needs-you, error, a finished turn —
 * outranks the ring exactly as it outranks the running dot) AND every running
 * pane in it is unverifiable. One live pane working alongside a wedged one
 * means the workspace really is being worked on; claiming "no update for 30m+"
 * over it would be false. The reported number is the FRESHEST stale pane's, the
 * only figure true of the workspace as a whole.
 */
export function selectWorkspaceUnverifiableMinutes(
  state: FleetSelectorState,
  workspaceId: string,
): number {
  return workspaceRollups(state).unverifiableByWorkspace[workspaceId] ?? 0;
}

/**
 * All-workspaces variant of the above — for loop renderers (MiniSidebar), which
 * would otherwise re-scan per row. Workspaces that are not unverifiable are
 * omitted; the caller defaults to 0.
 */
export function selectAllWorkspaceUnverifiableMinutes(
  state: FleetSelectorState,
): Record<string, number> {
  return workspaceRollups(state).unverifiableByWorkspace;
}

/**
 * Per-PTY variant for the surfaces that draw one dot PER PANE (the sidebar
 * agent roster, the deck Fleet roster) rather than one per workspace. Keyed by
 * ptyId because that is the id those rows carry. Verifiable panes are omitted.
 */
export function selectUnverifiablePaneMinutes(
  state: FleetSelectorState,
): Record<string, number> {
  return workspaceRollups(state).unverifiableByPty;
}

interface WorkspaceRollups {
  /** workspaceId → most-urgent pane status. Idle workspaces omitted. */
  status: Record<string, AgentStatus>;
  /** workspaceId → whole minutes of unreported silence. Verifiable ones omitted. */
  unverifiableByWorkspace: Record<string, number>;
  /** ptyId → whole minutes of unreported silence. Verifiable panes omitted. */
  unverifiableByPty: Record<string, number>;
}

/**
 * Every workspace-level roll-up in ONE `selectFleetPanes` pass, memoized on the
 * state object's identity.
 *
 * Each of the five exported roll-ups is a zustand subscription, and the sidebar
 * mounts two of them PER WORKSPACE ROW plus one per roster. Computed
 * independently that was a full fleet scan per row per store update — and the
 * decay clock makes a store update every 2 s. Zustand hands every subscriber
 * the same state object within one update, and immer replaces that object on
 * every `set`, so a WeakMap keyed on it collapses the whole fan-out to a single
 * pass and invalidates exactly when the store changes.
 */
const rollupCache = new WeakMap<FleetSelectorState, WorkspaceRollups>();

function workspaceRollups(state: FleetSelectorState): WorkspaceRollups {
  const cached = rollupCache.get(state);
  if (cached) return cached;
  const status: Record<string, AgentStatus> = {};
  const unverifiableByWorkspace: Record<string, number> = {};
  const unverifiableByPty: Record<string, number> = {};
  const quietest: Record<string, number> = {};
  const verifiableRunning = new Set<string>();
  for (const pane of selectFleetPanes(state)) {
    const cur = status[pane.workspaceId] ?? 'idle';
    if (STATUS_RANK[pane.agentStatus] < STATUS_RANK[cur]) status[pane.workspaceId] = pane.agentStatus;
    if (pane.agentStatus !== 'running') continue;
    if (!pane.unverifiable) { verifiableRunning.add(pane.workspaceId); continue; }
    const mins = Math.floor((pane.staleForMs ?? 0) / 60_000);
    if (pane.ptyId) unverifiableByPty[pane.ptyId] = mins;
    const prev = quietest[pane.workspaceId];
    if (prev === undefined || mins < prev) quietest[pane.workspaceId] = mins;
  }
  for (const workspaceId in quietest) {
    if (status[workspaceId] !== 'running' || verifiableRunning.has(workspaceId)) continue;
    unverifiableByWorkspace[workspaceId] = quietest[workspaceId];
  }
  const out = { status, unverifiableByWorkspace, unverifiableByPty };
  rollupCache.set(state, out);
  return out;
}

/** The agent's last reported message for a pty, trimmed; undefined when the
 *  pty has no message. */
export function selectSurfaceLastMessage(
  state: Pick<FleetSelectorState, 'surfaceLastMessage'>,
  ptyId: string,
): string | undefined {
  if (!ptyId) return undefined;
  return state.surfaceLastMessage?.[ptyId]?.trim() || undefined;
}

// ─── Fleet attention board — needs you / running / idle ──────────────────────
//
// The single source for which section a Fleet row lands in and which one-line
// detail it shows. Pure over the fleet rows plus a small context so a non-UI
// consumer (an MCP tool) can reuse the exact same triage.

export type FleetSection = 'needsYou' | 'running' | 'idle';

/** Fallback detail keys — the renderer translates them. */
export type FleetDetailKey =
  | 'fleet.needsYourInput'
  | 'fleet.detail.error'
  | 'fleet.detail.unconfirmed'
  | 'fleet.detail.supervisionStopped'
  | 'fleet.detail.complete'
  | 'fleet.detail.running'
  | 'fleet.detail.idle';

export interface FleetRow {
  pane: FleetPane;
  section: FleetSection;
  /** Reported text for the row (question, last message, tool activity). */
  detail?: string;
  /** Where `detail` came from; undefined when the row shows `detailKey`. */
  detailSource?: 'question' | 'lastMessage' | 'activity';
  /** Translation key shown when there is no reported text. */
  detailKey: FleetDetailKey;
  /** Milliseconds since the pane's last activity/output/turn stamp; undefined
   *  when none of them exists (no elapsed time shown, sorted last). */
  idleForMs?: number;
}

export interface FleetGroups {
  needsYou: FleetRow[];
  running: FleetRow[];
  idle: FleetRow[];
}

export type FleetGroupContext = Pick<
  FleetSelectorState,
  'surfacePendingQuestion' | 'surfaceLastMessage' | 'surfaceActivityAt' | 'surfaceTurnOpenAt'
> & {
  /** Read-time clock for elapsed time. Absent → no elapsed time on any row. */
  now?: number;
  /** ptyId → last terminal output stamp (paneSlice.surfaceOutputAt). */
  surfaceOutputAt?: Record<string, number>;
  /** 'attention' ranks by status then recency; 'workspace' keeps input order. */
  sortMode?: FleetSortMode;
};

/** Elapsed ms since the newest of the pane's activity / output / turn stamps;
 *  undefined when none exists (never NaN). */
export function fleetIdleForMs(ptyId: string, ctx: FleetGroupContext): number | undefined {
  if (!ptyId || ctx.now === undefined) return undefined;
  let newest: number | undefined;
  for (const stamp of [ctx.surfaceActivityAt?.[ptyId], ctx.surfaceOutputAt?.[ptyId], ctx.surfaceTurnOpenAt?.[ptyId]]) {
    if (typeof stamp === 'number' && Number.isFinite(stamp) && (newest === undefined || stamp > newest)) newest = stamp;
  }
  return newest === undefined ? undefined : Math.max(0, ctx.now - newest);
}

/** One row's section and detail — `groupFleetPanes` without the grouping. */
export function fleetRow(pane: FleetPane, ctx: FleetGroupContext = {}): FleetRow {
  const target = fleetTargetPtyId(pane);
  const question = target ? ctx.surfacePendingQuestion?.[target]?.trim() || undefined : undefined;
  const lastMessage = selectSurfaceLastMessage(ctx, target);
  // Agent-authored; flattened at display time so bidi / zero-width characters
  // cannot reorder how a tool path reads.
  const activity = pane.surfaceType === 'terminal' ? flattenAgentText(pane.activity ?? '') || undefined : undefined;
  const idleForMs = fleetIdleForMs(target, ctx);
  const base = { pane, idleForMs };
  if (pane.supervision?.status === 'stopped') {
    return { ...base, section: 'needsYou', detailKey: 'fleet.detail.supervisionStopped' };
  }
  if (pane.unverifiable) {
    return { ...base, section: 'needsYou', detailKey: 'fleet.detail.unconfirmed' };
  }
  switch (pane.agentStatus) {
    case 'awaiting_input':
      return question
        ? { ...base, section: 'needsYou', detail: question, detailSource: 'question', detailKey: 'fleet.needsYourInput' }
        : { ...base, section: 'needsYou', detailKey: 'fleet.needsYourInput' };
    case 'waiting':
      return question
        ? { ...base, section: 'needsYou', detail: question, detailSource: 'question', detailKey: 'fleet.needsYourInput' }
        : lastMessage
          ? { ...base, section: 'idle', detail: lastMessage, detailSource: 'lastMessage', detailKey: 'fleet.detail.idle' }
          : { ...base, section: 'idle', detailKey: 'fleet.detail.idle' };
    case 'error':
      return { ...base, section: 'needsYou', detailKey: 'fleet.detail.error' };
    case 'complete':
      return lastMessage
        ? { ...base, section: 'needsYou', detail: lastMessage, detailSource: 'lastMessage', detailKey: 'fleet.detail.complete' }
        : { ...base, section: 'needsYou', detailKey: 'fleet.detail.complete' };
    case 'running':
      return activity
        ? { ...base, section: 'running', detail: activity, detailSource: 'activity', detailKey: 'fleet.detail.running' }
        : { ...base, section: 'running', detailKey: 'fleet.detail.running' };
    default:
      return lastMessage
        ? { ...base, section: 'idle', detail: lastMessage, detailSource: 'lastMessage', detailKey: 'fleet.detail.idle' }
        : { ...base, section: 'idle', detailKey: 'fleet.detail.idle' };
  }
}

/** Severity inside Needs you: a stopped supervisor, then a request for
 *  input, then an error, then an unconfirmed turn, then a finished one. */
function needsYouRank(row: FleetRow): number {
  if (row.pane.supervision?.status === 'stopped') return 0;
  if (row.pane.unverifiable) return 3;
  switch (row.pane.agentStatus) {
    case 'awaiting_input':
    case 'waiting':
      return 1;
    case 'error':
      return 2;
    default:
      return 4;
  }
}

/**
 * Group fleet rows into the three attention-board sections. Within a section
 * ('attention' mode): Needs you ranks by severity (needsYouRank), the other
 * sections by STATUS_RANK; then the most recent activity first, rows with no
 * timestamps last, then input order. 'workspace' mode keeps the input
 * (sidebar) order inside each section.
 */
export function groupFleetPanes(panes: FleetPane[], ctx: FleetGroupContext = {}): FleetGroups {
  const groups: FleetGroups = { needsYou: [], running: [], idle: [] };
  const order = new Map<FleetRow, number>();
  panes.forEach((pane, index) => {
    const row = fleetRow(pane, ctx);
    order.set(row, index);
    groups[row.section].push(row);
  });
  if (ctx.sortMode !== 'workspace') {
    const compare = (a: FleetRow, b: FleetRow): number => {
      const r = a.section === 'needsYou'
        ? needsYouRank(a) - needsYouRank(b)
        : STATUS_RANK[a.pane.agentStatus] - STATUS_RANK[b.pane.agentStatus];
      if (r !== 0) return r;
      const ai = a.idleForMs;
      const bi = b.idleForMs;
      if (ai !== undefined && bi !== undefined && ai !== bi) return ai - bi;
      if (ai === undefined && bi !== undefined) return 1;
      if (ai !== undefined && bi === undefined) return -1;
      return (order.get(a) ?? 0) - (order.get(b) ?? 0);
    };
    groups.needsYou.sort(compare);
    groups.running.sort(compare);
    groups.idle.sort(compare);
  }
  return groups;
}

/** A terminal's application name is context, not a task title. Never invent
 * a task from output; use the user's label, mission, or terminal title. */
export function fleetTitle(pane: FleetPane, mission?: WorkTask): string {
  if (pane.paneLabel?.trim()) return pane.paneLabel.trim();
  if (mission?.title.trim()) return mission.title.trim();
  const title = pane.title.replace(/^[✳✻✽✶✢*]\s*/, '').trim();
  const generic = /^(claude(?: code)?|codex(?: cli)?|gemini(?: cli)?|terminal|shell|zsh|bash|pwsh|powershell|cmd(?:\.exe)?)$/i;
  if (title && !generic.test(title) && title.toLowerCase() !== pane.agentName?.toLowerCase()) return title;
  return pane.workspaceName;
}

/** Everything the Fleet board reads. The two precomputed maps are optional:
 *  FleetView subscribes to them shallowly (so the 2 s decay clock does not
 *  re-derive the board) and passes them in; a caller holding the live store
 *  omits them and they are derived from the same state here. */
export type FleetBoardState = FleetSelectorState & Pick<StoreState, 'surfaceOutputAt'> & {
  /** Produced by `selectUnverifiablePaneMinutes`; derived when absent. */
  unverifiablePaneMinutes?: Record<string, number>;
};

export interface FleetBoard {
  panes: FleetPane[];
  groups: FleetGroups;
}

/**
 * The Fleet attention board — the rows and sections the Fleet overlay shows.
 * The one place its inputs are assembled, so the overlay and the fleet.triage
 * RPC (an agent asking "who needs me?") cannot disagree.
 */
export function selectFleetBoard(
  state: FleetBoardState,
  opts: { now: number; sortMode: FleetSortMode },
): FleetBoard {
  const unverifiable = state.unverifiablePaneMinutes ?? selectUnverifiablePaneMinutes(state);
  const surfaceAgent = state.surfaceAgent ?? {};
  // Use the same turn/liveness inputs as the sidebar and Deck roster. Missing
  // these optional inputs silently classified active hook-driven turns as idle.
  const panes = selectFleetPanes({
    workspaces: state.workspaces,
    surfaceAgentStatus: state.surfaceAgentStatus,
    surfaceActivity: state.surfaceActivity,
    paneLabel: state.paneLabel,
    supervisionByPtyId: state.supervisionByPtyId,
    surfaceAgent: state.surfaceAgent,
    surfacePendingQuestion: state.surfacePendingQuestion,
    surfaceActivityAt: state.surfaceActivityAt,
    surfaceTurnOpenAt: state.surfaceTurnOpenAt,
    commandRunningByPtyId: state.commandRunningByPtyId,
    agentAliveByPtyId: state.agentAliveByPtyId,
    hookRunningByPtyId: state.hookRunningByPtyId ?? selectHookRunningByPtyId(state),
    remoteWorkspaces: state.remoteWorkspaces,
  }).map((pane) => ({
    ...pane,
    agentName: surfaceAgent[pane.ptyId]?.name || pane.agentName,
    unverifiable: !!unverifiable[pane.ptyId],
  }));
  const groups = groupFleetPanes(panes, {
    now: opts.now,
    surfaceActivityAt: state.surfaceActivityAt,
    surfaceOutputAt: state.surfaceOutputAt,
    surfaceTurnOpenAt: state.surfaceTurnOpenAt,
    surfacePendingQuestion: state.surfacePendingQuestion,
    surfaceLastMessage: state.surfaceLastMessage,
    sortMode: opts.sortMode,
  });
  return { panes, groups };
}

/**
 * #1481 — workspace id → newest activity/output stamp across ALL its terminal
 * surfaces (stashed included), floored to the minute, for the sidebar's
 * "Recent activity" order. Minute granularity so a shallow-compared
 * subscription does not re-sort the list on every byte of output.
 */
export function selectAllWorkspaceLastActivityMinute(state: FleetSelectorState & {
  surfaceOutputAt?: Record<string, number>;
}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ws of state.workspaces) {
    let last = 0;
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      for (const surf of leaf.surfaces) {
        if (!surf.ptyId) continue;
        const at = Math.max(state.surfaceActivityAt?.[surf.ptyId] ?? 0, state.surfaceOutputAt?.[surf.ptyId] ?? 0);
        if (at > last) last = at;
      }
    }
    out[ws.id] = Math.floor(last / 60_000);
  }
  return out;
}
