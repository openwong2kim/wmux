import type { AgentStatus, Task, PaneLeaf, Surface } from '../../../shared/types';
import { getLeafPanes, getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { stashedPaneLiveness } from '../../../shared/paneStash';
import { isBrainPtyId } from '../../../shared/constants';
import type { StoreState } from '../index';

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
};

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
 * (complete / waiting / awaiting_input) keyed per-ptyId — see paneSlice
 * ATTENTION_STATUSES. `running` / `idle` / `error` are *deleted* from that map,
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
      for (const s of leaf.surfaces) {
        if (!s.ptyId) continue;
        // #1168 — a transcript-derived pending question outranks whatever the
        // stop payload settled this surface to, exactly as it does in
        // workspaceAgentRoster. Without it a payload carrying `complete`
        // alongside an unanswered question painted a green "nothing to see"
        // dot over a red roster row that was printing the question.
        const st = state.surfacePendingQuestion?.[s.ptyId]?.trim()
          ? 'awaiting_input'
          : state.surfaceAgentStatus[s.ptyId];
        if (st && (attention === undefined || STATUS_RANK[st] < STATUS_RANK[attention])) {
          attention = st;
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
      // `error` is still inherited: it is not an ATTENTION status, so the
      // workspace slot is its only carrier for the active pane.
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
      const hookRunning = isHookRunning({ activityAt, turnOpenAt, agentClockMs: state.agentClockMs });
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
        ptyId,
        agentStatus: status,
        agentName: isActivePane && metaMatchesPane ? wsMeta?.agentName : undefined,
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
