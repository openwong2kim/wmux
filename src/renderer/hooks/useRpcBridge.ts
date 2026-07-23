import { useEffect } from 'react';
import { useStore } from '../stores';
import { resolveStartupCwd, shellDisplayName, withDefaultShell, withWorkspaceProfile } from '../utils/ptyCreateOptions';
import type { Pane, PaneLeaf, Surface, Workspace } from '../../shared/types';
import { computePaneAutoName, paneDisplayName } from '../utils/paneNaming';
import { validateMessage } from '../../shared/types';
import type { Message, Part, TaskState, Artifact, AgentSkill, Task, CompletionEvidence } from '../../shared/types';
import { normalizeCompletionEvidenceWire, isVerifiedItem } from '../../shared/completionEvidence';
import type { PaneSearchResult, PaneSearchResponse } from '../../shared/types';
import { generateId } from '../../shared/types';
import { normalizeRoleBinding } from '../../shared/orchestratorRole';
import { handleCompanyRpc } from '../../company/renderer/rpcHandlers';
import { formatA2aMessage, formatA2aBroadcast, sanitizeA2aName } from '../utils/a2aFormat';
import type { A2aPriority } from '../utils/a2aFormat';
import { requestExecuteApproval } from '../utils/executeApprovalGate';
import { openUrlInBrowserPane } from '../utils/browserPaneActions';
import {
  closeBrowserTabInWorkspace,
  handleBrowserTabsRpc,
} from '../utils/browserTabs';
import { terminalRegistry, hydrateTerminalForRead } from './useTerminal';
import { readPtyBufferLines, readPtyBufferTail, DEFAULT_READ_TAIL_LINES } from '../utils/terminalTail';
import { searchInBuffer, type SearchableBuffer } from '../utils/searchEngine';
import { submitBracketedPasteToPty } from '../utils/ptyMessageDelivery';
import { publishA2aTask } from '../events/publisher';
import { resolvePaneAddress, activePaneTerminalPty, decideSameWsSend, isTerminalPtyInLeaves, resolveSelfPaneIdentity, resolveSenderPaneAddress, resolvePaneRole, findLeafPanes, type PaneAddress } from './a2aAddressing';
import { resolveWorkspaceTarget } from './workspaceTargeting';
import { findActivePtyId, collectAllPtyIds, buildWorkspaceListEntries } from './workspaceMirrorSnapshot';

// ---------------------------------------------------------------------------
// Cold-park (TASK-9) daemon-backed read fallback
// ---------------------------------------------------------------------------
//
// A cold-parked workspace has no renderer xterm buffer (its terminals were
// unmounted to reclaim RAM), so pane.search and input.readScreen would silently
// skip its panes. These helpers pull the pane's grid from the daemon ring as
// plain-text rows and adapt them so the SAME search engine / read path runs —
// no silent misses (hard AC). Fails soft to null: a legacy daemon, local mode,
// or a gone session degrades to "skip this pane" exactly as before the feature.

interface DaemonTextRow { text: string; wrapped: boolean }
interface ParkedPaneRead { rows: DaemonTextRow[]; truncated: boolean }

/** Fetch a parked pane's grid from the daemon as plain-text rows, or null.
 *  `truncated` is true when the daemon dropped oldest rows to fit the RPC frame
 *  budget — the caller propagates it so coverage is reported as incomplete. */
async function fetchParkedPaneRows(ptyId: string, scrollback?: number): Promise<ParkedPaneRead | null> {
  const api = window.electronAPI?.pty;
  if (!api || typeof api.readText !== 'function') return null; // stale preload
  try {
    const res = await api.readText(ptyId, scrollback !== undefined ? { scrollback } : undefined);
    return res?.success ? { rows: res.rows, truncated: res.truncated === true } : null;
  } catch {
    return null;
  }
}

/** Adapt daemon text rows to the SearchableBuffer surface searchInBuffer needs. */
function rowsToSearchableBuffer(rows: DaemonTextRow[]): SearchableBuffer {
  return {
    length: rows.length,
    getLine(idx: number) {
      const row = rows[idx];
      if (!row) return undefined;
      return {
        isWrapped: row.wrapped,
        translateToString: () => row.text,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Pane tree utilities
// ---------------------------------------------------------------------------

// `findActivePtyId` / `collectAllPtyIds` were lifted to
// ./workspaceMirrorSnapshot so the WorkspaceMirror push payload (which mirrors
// the `workspace.list` reply) shares one source of truth for them. Imported
// above; the workspace.list handler and line-492 pty sweep use them unchanged.

function findPaneById(root: Pane, id: string): Pane | null {
  if (root.id === id) return root;
  if (root.type === 'branch') {
    for (const child of root.children) {
      const found = findPaneById(child, id);
      if (found) return found;
    }
  }
  return null;
}

/** Find which leaf pane contains the given surfaceId. */
function findLeafBySurfaceId(root: Pane, surfaceId: string): PaneLeaf | null {
  const leaves = findLeafPanes(root);
  return leaves.find((l) => l.surfaces.some((s) => s.id === surfaceId)) ?? null;
}

/**
 * Find the workspace whose pane tree contains `paneId` (paneIds are globally
 * unique). Used by the address-resolution focus handlers — the counterpart to
 * the all-ws scan in `pane.close` — so an external caller can focus a pane in
 * its own background workspace by id alone. Returns the first owner or null.
 */
function findOwningWorkspace(workspaces: Workspace[], paneId: string): Workspace | null {
  for (const ws of workspaces) {
    if (findPaneById(ws.rootPane, paneId)) return ws;
  }
  return null;
}

/**
 * Find the workspace + leaf owning `surfaceId` (surfaceIds are globally unique).
 * The surface counterpart to findOwningWorkspace, mirroring `surface.close`'s
 * all-ws scan. Returns `{ ws, leaf }` for the first owner or null.
 */
function findOwningWorkspaceBySurface(
  workspaces: Workspace[],
  surfaceId: string,
): { ws: Workspace; leaf: PaneLeaf } | null {
  for (const ws of workspaces) {
    const leaf = findLeafBySurfaceId(ws.rootPane, surfaceId);
    if (leaf) return { ws, leaf };
  }
  return null;
}

// ---------------------------------------------------------------------------
// PTY submit helper — paste structured inter-agent messages through bracketed
// paste before submitting, so receiver-controlled shells/readline prompts treat
// the envelope as pasted data instead of executing embedded line breaks as
// individual keystrokes.
// ---------------------------------------------------------------------------

function submitToPty(ptyId: string, text: string): void {
  submitBracketedPasteToPty(ptyId, text);
}

// ---------------------------------------------------------------------------
// RPC method handler type
// ---------------------------------------------------------------------------

type RpcParams = Record<string, unknown>;
type RpcResult = unknown;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRpcBridge(): void {
  useEffect(() => {
    // ── RPC command listener ─────────────────────────────────────────────────
    const cleanupRpc = window.electronAPI.rpc.onCommand(
      async (requestId: string, method: string, params: RpcParams) => {
        let result: RpcResult;
        try {
          result = await handleRpcMethod(method, params);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        window.electronAPI.rpc.respond(requestId, result);
      },
    );

    // ── In-renderer entry point for searchSlice ─────────────────────────────
    // The search engine reads from xterm.js Terminal instances which only
    // exist in the renderer. Exposing a thin global lets the zustand slice
    // invoke `pane.search` directly without a useless renderer→main→renderer
    // IPC round trip.
    (window as unknown as { __wmuxRunPaneSearch: (q: string, r: boolean) => Promise<RpcResult> })
      .__wmuxRunPaneSearch = (query: string, regex: boolean) =>
        handleRpcMethod('pane.search', { query, regex });

    // ── In-renderer entry point for useChannelsEventSubscription ─────────
    // The channel-message subscription hook (see
    // src/renderer/hooks/useChannelsEventSubscription.ts) runs a 1 Hz
    // events.poll loop — mirroring PluginFrame's forwardEvents cadence —
    // and dispatches results into channelsSlice.appendMessageFromEvent. It
    // needs to reach events.poll without the slice having to know about
    // the IPC layer, so we expose a thin global here. The bridge calls
    // `electronAPI.rpc.invoke('events.poll', params)` which routes
    // through main into the live pipe RpcRouter → the daemon-side
    // `events.poll` handler registered in `src/main/pipe/handlers/events.rpc.ts`.
    // The renderer-side `useStore((s) => s.company)?.ceoWorkspaceId` is
    // injected by the hook as the per-recipient scoping key (see plan
    // U3); the daemon's per-workspace filter at events.rpc.ts:115-124
    // admits the renderer's own workspace's events on that basis.
    (window as unknown as {
      __wmuxEventsPoll: (params: {
        cursor: number;
        types: string[];
        max?: number;
        workspaceId: string;
      }) => Promise<RpcResult>;
    }).__wmuxEventsPoll = (params) =>
      window.electronAPI.rpc.invoke('events.poll', params) as Promise<RpcResult>;

    // ── In-renderer entry point for channelsSlice *Daemon thunks ─────────
    // The renderer's create/post/join/leave/archive actions (U4, R4+R11)
    // round-trip through the pipe RpcRouter to reach
    // ChannelService.create/post/join/leave/archive. Parallel to
    // `__wmuxEventsPoll` — same `electronAPI.rpc.invoke` plumbing — but
    // exposed as an object with a `rpc(method, params)` method so the
    // slice can call `a2a.channel.<method>` without concatenating the
    // namespace at every call site (events.poll is a single method, so
    // the function-shaped global is enough; channels has 9 methods, so
    // a per-method wrapper is cleaner).
    (window as unknown as {
      __wmuxChannelsRpc: {
        rpc: (
          method:
            | 'a2a.channel.list'
            | 'a2a.channel.get'
            | 'a2a.channel.getMessages'
            | 'a2a.channel.getMembers'
            | 'a2a.channel.create'
            | 'a2a.channel.archive'
            | 'a2a.channel.join'
            | 'a2a.channel.leave'
            | 'a2a.channel.post',
          params: Record<string, unknown>,
        ) => Promise<RpcResult>;
        // D5 — mutating channel ops from the first-party UI. Routes the
        // renderer-only `channels:mutate-local` IPC (NOT the pipe RpcRouter),
        // which trusts the renderer-supplied verifiedWorkspaceId and forwards
        // to the daemon. Reads stay on `rpc` above.
        mutateLocal: (
          method:
            | 'a2a.channel.create'
            | 'a2a.channel.post'
            | 'a2a.channel.join'
            | 'a2a.channel.leave'
            | 'a2a.channel.archive'
            // operator-join (설계 §2.1/§2.2) — humans-only, 렌더러 전용 mutateLocal
            // 경로로만 도달(파이프 미등록). operatorList는 읽기지만 같은 트랜스포트.
            | 'a2a.channel.operatorJoin'
            | 'a2a.channel.operatorList',
          params: Record<string, unknown>,
        ) => Promise<RpcResult>;
      };
    }).__wmuxChannelsRpc = {
      rpc: (method, params) =>
        window.electronAPI.rpc.invoke(method, params) as Promise<RpcResult>,
      mutateLocal: (method, params) =>
        window.electronAPI.rpc.mutateChannelLocal(method, params) as Promise<RpcResult>,
    };

    // ── In-renderer entry point for workTaskSlice / useMissionsPolling ────
    // Mission (WorkTask) reads for the sidebar "Missions" section + FleetCard
    // mission line. `task.mission.list` is owner-scoped (the daemon returns
    // only tasks whose owner == the passed workspace), so the parent workspace
    // that fanned out queries its own children. Read-only, same `rpc.invoke`
    // plumbing as `__wmuxEventsPoll` — a no-senderPtyId renderer read keeps its
    // caller-supplied verifiedWorkspaceId (process-boundary trust; see the
    // header of src/main/pipe/handlers/a2a.channel.rpc.ts). No mission mutation
    // ever rides this bridge (materialization is FanOutService's internal path).
    (window as unknown as {
      __wmuxMissionRpc: {
        list: (params: { verifiedWorkspaceId: string }) => Promise<RpcResult>;
      };
    }).__wmuxMissionRpc = {
      list: (params) =>
        window.electronAPI.rpc.invoke('task.mission.list', params) as Promise<RpcResult>,
    };

    // A2A task garbage collection timer — prune terminal-state tasks every 5 min
    const gcTimer = setInterval(() => {
      useStore.getState().gcTerminalTasks();
    }, 5 * 60 * 1000);

    return () => {
      cleanupRpc();
      clearInterval(gcTimer);
      delete (window as unknown as { __wmuxRunPaneSearch?: unknown }).__wmuxRunPaneSearch;
      delete (window as unknown as { __wmuxEventsPoll?: unknown }).__wmuxEventsPoll;
      delete (window as unknown as { __wmuxChannelsRpc?: unknown }).__wmuxChannelsRpc;
      delete (window as unknown as { __wmuxMissionRpc?: unknown }).__wmuxMissionRpc;
    };
  }, []);
}

// ---------------------------------------------------------------------------
// PTY notification helper — delivers a formatted A2A message to a workspace's
// active terminal. Extracted to avoid duplication across send/reply/update.
// ---------------------------------------------------------------------------

function deliverPtyNotification(
  targetWs: { rootPane: Pane; activePaneId: string; name: string },
  senderName: string,
  message: string,
  explicitPtyId?: string,
): void {
  const ptyId = explicitPtyId ?? activePaneTerminalPty(findLeafPanes(targetWs.rootPane), targetWs.activePaneId);
  if (ptyId) {
    submitToPty(ptyId, formatA2aMessage(senderName, targetWs.name, message));
  }
}

// ---------------------------------------------------------------------------
// PTY nudge helper — pastes a single-line pointer (no body) to the receiver's
// active terminal. Used for the live-TUI-agent silent-default: the receiver
// learns a task arrived (and to run a2a_task_query) without its prompt being
// flooded with the full message body. Same pane-resolution as
// deliverPtyNotification; the text is a one-liner with no embedded newlines so
// it cannot corrupt a multi-line readline state.
// ---------------------------------------------------------------------------

function deliverPtyNudge(
  targetWs: { rootPane: Pane; activePaneId: string },
  nudge: string,
  explicitPtyId?: string,
): void {
  const ptyId = explicitPtyId ?? activePaneTerminalPty(findLeafPanes(targetWs.rootPane), targetWs.activePaneId);
  if (ptyId) {
    submitToPty(ptyId, nudge);
  }
}

// ---------------------------------------------------------------------------
// A2A silent-default for TUI receivers (S-C2 ②). A receiver running a live
// TUI agent gets its input box corrupted by a full bracketed-paste; for those
// we DEFAULT to the EventBus pointer + a one-line nudge instead of the body.
// A receiver with NO live agent keeps today's loud full-body paste (never
// regress a peer that never polls). An explicit params.silent === true still
// fully suppresses (handled at the call sites).
//
// "live TUI agent" = an agentName is present AND agentStatus is one of the
// active states (running / waiting / awaiting_input). 'complete'/'error'/'idle'
// (or absent) are NOT live — those receivers get the loud paste.
// ---------------------------------------------------------------------------

const LIVE_AGENT_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting', 'awaiting_input']);

function isLiveTuiAgent(meta: { agentName?: string; agentStatus?: string } | undefined): boolean {
  if (!meta) return false;
  return !!meta.agentName && meta.agentStatus != null && LIVE_AGENT_STATUSES.has(meta.agentStatus);
}

// Liveness metadata for an A2A delivery decision (nudge vs full paste). When an
// explicit pane/surface was addressed, the decision must reflect THAT pane's
// agent (a workspace can host more than one agent) — read it from the
// per-ptyId surfaceAgent map. Falls back to ws-level metadata when no explicit
// pty was resolved (the active-pane heuristic path).
function deliveryLiveMeta(
  surfaceAgent: Record<string, { name: string; status: string }>,
  explicitPty: string | undefined,
  fallbackMeta: { agentName?: string; agentStatus?: string } | undefined,
): { agentName?: string; agentStatus?: string } | undefined {
  if (!explicitPty) return fallbackMeta;
  const a = surfaceAgent[explicitPty];
  return a ? { agentName: a.name, agentStatus: a.status } : undefined;
}

/**
 * One-line nudge for a live-agent receiver. SINGLE LINE — no embedded
 * newlines, no message body (the body rides the dual-party-scoped task store,
 * fetched via a2a_task_query). Kept short so it doesn't wrap the prompt.
 */
function buildA2aNudge(taskId: string, senderName: string): string {
  const id8 = taskId.replace(/^task[-_]?/, '').slice(0, 8);
  // Sanitize the user-editable workspace name: a CR/LF in it would otherwise
  // split this "single line" into a multi-line bracketed paste (submitted with
  // `\r\r`) and inject text into the very live-agent prompt this path protects.
  return `[wmux] new A2A task ${id8} from ${sanitizeA2aName(senderName)} — a2a_task_query`;
}

// ---------------------------------------------------------------------------
// A2A EventBus tee — publish an `a2a.task` pointer onto the bus so the
// receiver can be notified WITHOUT a terminal paste and the sender gets a
// delivery/status receipt (S-C2 ②). DUAL-PARTY: reads from/to off the task
// metadata and forwards them as explicit keys; publishA2aTask stamps the base
// workspaceId === from (fail-safe scoping). The event is a POINTER — no
// messagePreview is attached (body is fetched via a2a_task_query).
//
// Cadence: STATE TRANSITIONS only (created/updated/cancelled). NOT once per
// addTaskMessage — a chatty conversation must never flood the 1024-event ring
// (the same reason agent.activity is excluded from the bus).
//
// Single funnel: the ONLY a2a.task emitter. The main-side execute/deny path
// (a2a.rpc.ts) and the background ClaudeWorker both route back through these
// renderer handlers (a2a.task.send / a2a.task.cancel / a2a.task.update), so
// there is intentionally no second main-side emit — that would double-publish.
//
// Call STRICTLY AFTER the store set() that drives the transition, so the task
// is queryable when a poller follows the pointer (created-before-queryable
// race guard). Best-effort: a missing/partial metadata never throws here.
function emitA2aTaskEvent(
  task: Task,
  kind: 'created' | 'updated' | 'cancelled',
  state?: TaskState,
): void {
  const from = task.metadata?.from?.workspaceId;
  const to = task.metadata?.to?.workspaceId;
  const taskId = task.id;
  // from/to are validated non-empty at the publish trust boundary too, but
  // skip locally to avoid emitting a degenerate (third-party-blind) pointer.
  if (!from || !to || !taskId) return;
  // verifiedItemCount(§6.M PR-C)는 **종단 전이(completed/failed)**의 등급이다.
  // 데몬은 비종단 전이(working)에도 evidence를 수용하므로(PR-B else-if), evidence
  // 존재만으로 파생하면 working 이벤트가 등급을 달고 나가 계약("completed/failed
  // only")을 깬다(리뷰 Codex+GLM) — state로 게이트한다. evidence 자체는 데몬 커밋
  // 경로(committedTask)와 렌더러 폴백 경로 양쪽이 task.status.evidence에 싣는 단일
  // 정본이라 소스는 경로 무관 일관하다. items 방어(?.): 타입상 배열이나 폴백 wire
  // 변형에서 undefined면 부재로 안전 처리(크래시 금지).
  const effectiveState = state ?? task.status.state;
  const evidence = task.status.evidence;
  const verifiedItemCount =
    (effectiveState === 'completed' || effectiveState === 'failed') && evidence?.items
      ? evidence.items.filter(isVerifiedItem).length
      : undefined;
  publishA2aTask(from, to, taskId, effectiveState, kind, undefined, verifiedItemCount);
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

// Defense-in-depth: renderer profile switches should not mount arbitrary
// persistent Electron partitions if a malformed bridge message is received.
function isSelectableBrowserPartition(partition: string): boolean {
  return (
    partition === 'persist:wmux-default'
    || /^wmux-[A-Za-z0-9](?:[A-Za-z0-9_-]{0,63})$/.test(partition)
  );
}

async function handleRpcMethod(method: string, params: RpcParams): Promise<RpcResult> {
  // Always read the freshest state via getState() to avoid stale closures.
  const store = useStore.getState();

  // Fix 0 — block external RPC during startup reconcile. Even read-only
  // RPCs (workspace.list) return surface.ptyId fields that the external
  // caller may use for a follow-up write — and during the pending
  // window those ptyIds may be stale, cleared by reconcile mid-flight,
  // or about to be cleared by the fallback. Returning a structured
  // error lets the caller retry once the gate flips.
  if (store.paneGate !== 'ready') {
    return { error: 'wmux is still starting (paneGate=pending)', retryable: true };
  }

  // -------------------------------------------------------------------------
  // workspace.*
  // -------------------------------------------------------------------------

  if (method === 'workspace.list') {
    // Phase 1 hook plugin support — bridge scripts resolve hook payload's
    // cwd → workspace → activePtyId. Shared with the WorkspaceMirror push so
    // the mirror snapshot can never diverge from this reply (see
    // buildWorkspaceListEntries).
    return buildWorkspaceListEntries(store.workspaces);
  }

  if (method === 'workspace.new') {
    const name = typeof params.name === 'string' ? params.name : undefined;
    store.addWorkspace(name);
    // After mutation, fetch updated state.
    const updated = useStore.getState();
    const created = updated.workspaces.find((w) => w.id === updated.activeWorkspaceId);
    return created ? { id: created.id, name: created.name } : null;
  }

  if (method === 'workspace.focus') {
    const id = String(params.id ?? '');
    store.setActiveWorkspace(id);
    return { ok: true };
  }

  if (method === 'workspace.close') {
    const id = String(params.id ?? '');
    // Dispose the workspace's PTY sessions before dropping it from the UI.
    // The UI close paths (Sidebar X, Ctrl+Shift+W, Settings reset) already
    // dispose every surface's PTY; without the same step here an external
    // CLI/MCP `workspace.close` would leave each pane's shell — and any agent
    // process running inside it — alive in the daemon with no UI to reattach,
    // accumulating until a full daemon shutdown. Best-effort: a failed dispose
    // (session already dead, daemon mid-respawn) must not block the removal.
    //
    // Guard on workspaces.length > 1: removeWorkspace refuses to drop the final
    // workspace (the store always keeps at least one). Without this check the
    // RPC would dispose the only workspace's PTYs — killing its shells and any
    // agent inside them — while the workspace stays in the UI with dead
    // surfaces. Mirror the slice's guard so dispose only runs when the removal
    // will actually happen. (codex review P2)
    const ws = store.workspaces.find((w) => w.id === id);
    if (ws && store.workspaces.length > 1) {
      for (const ptyId of collectAllPtyIds(ws.rootPane)) {
        // dispose() returns an IPC Promise, so a daemon-side failure (mid-
        // respawn, session already dead) rejects asynchronously — a plain
        // try/catch wouldn't catch it and workspace.close would emit an
        // unhandled rejection while still reporting success. Swallow the
        // rejection via .catch; the outer try guards a synchronous throw
        // (e.g. electronAPI missing). Best-effort either way. (codex review P2)
        try {
          void window.electronAPI.pty.dispose(ptyId).catch(() => { /* best-effort */ });
        } catch { /* best-effort */ }
      }
    }
    store.removeWorkspace(id);
    return { ok: true };
  }

  if (method === 'workspace.current') {
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    return ws ? { id: ws.id, name: ws.name } : null;
  }

  if (method === 'mcp.claimWorkspace') {
    // Spawn a dedicated workspace + PTY for an external MCP caller without
    // stealing the user's focus. addWorkspace flips activeWorkspaceId to the
    // new workspace as a side effect, so we snapshot the prior active id and
    // restore it after PTY creation completes.
    const previousActiveId = store.activeWorkspaceId;
    const name = typeof params.name === 'string' && params.name.length > 0
      ? params.name
      : undefined;

    store.addWorkspace(name);

    const afterAdd = useStore.getState();
    const newWs = afterAdd.workspaces.find((w) => w.id === afterAdd.activeWorkspaceId);
    if (!newWs) {
      // Should never happen — addWorkspace just set activeWorkspaceId.
      return { error: 'mcp.claimWorkspace: workspace creation failed' };
    }

    const newWsId = newWs.id;
    const paneId = newWs.activePaneId;

    let ptyId: string;
    try {
      const created = await window.electronAPI.pty.create(
        withDefaultShell({ workspaceId: newWsId }, useStore.getState().defaultShell)
      );
      ptyId = created.id;
    } catch (err) {
      // Roll back: remove the empty workspace so we don't leave orphans.
      const rollback = useStore.getState();
      rollback.removeWorkspace(newWsId);
      rollback.setActiveWorkspace(previousActiveId);
      return { error: `mcp.claimWorkspace: PTY create failed — ${err instanceof Error ? err.message : String(err)}` };
    }

    // Re-read state: pane may have been removed during the async gap.
    const afterPty = useStore.getState();
    const freshWs = afterPty.workspaces.find((w) => w.id === newWsId);
    if (!freshWs || !findPaneById(freshWs.rootPane, paneId)) {
      try { await window.electronAPI.pty.dispose(ptyId); } catch { /* best-effort */ }
      afterPty.removeWorkspace(newWsId);
      afterPty.setActiveWorkspace(previousActiveId);
      return { error: 'mcp.claimWorkspace: pane disappeared during PTY creation' };
    }
    afterPty.addSurface(paneId, ptyId, '', '');

    // Restore focus to whatever the user was looking at before — claim must
    // never steal the active view.
    useStore.getState().setActiveWorkspace(previousActiveId);

    return { ptyId, workspaceId: newWsId, workspaceName: newWs.name };
  }

  if (method === 'fanout.spawnWorkspace') {
    // J1 §2 ③ — fan-out 태스크의 전용 워크스페이스 + 에이전트 페인 스폰. main의
    // FanOutService가 sendToRenderer로 호출한다. mcp.claimWorkspace와 동형이나
    // cwd=worktreePath + initialCommand(프롬프트 파일 치환)를 추가로 싣는다. 실제
    // workspaceId를 회수 반환(핸드셰이크 C3). 사람 포커스를 훔치지 않는다(이전 활성
    // 복원). 워크스페이스 트리 정본은 렌더러라 이 경로가 정본 우회 없는 스폰이다.
    const previousActiveId = store.activeWorkspaceId;
    const name = typeof params.name === 'string' && params.name.length > 0 ? params.name : undefined;
    const cwd = typeof params.cwd === 'string' ? params.cwd : '';
    const initialCommand = typeof params.initialCommand === 'string' ? params.initialCommand : '';

    store.addWorkspace(name);
    const afterAdd = useStore.getState();
    const newWs = afterAdd.workspaces.find((w) => w.id === afterAdd.activeWorkspaceId);
    if (!newWs) {
      return { error: 'fanout.spawnWorkspace: workspace creation failed' };
    }
    const newWsId = newWs.id;
    const paneId = newWs.activePaneId;

    let ptyId: string;
    try {
      const created = await window.electronAPI.pty.create(
        withWorkspaceProfile(
          withDefaultShell(
            {
              workspaceId: newWsId,
              cwd: cwd || undefined,
              ...(initialCommand ? { initialCommand } : {}),
            },
            useStore.getState().defaultShell,
          ),
          // profile.startupCwd = worktreePath 힌트(§1 — 초기 편의). split 상속에
          // 밀리는 tolerant 힌트라 방어가 아니라 편의로만 계상한다.
          { ...newWs.profile, startupCwd: cwd || newWs.profile?.startupCwd },
        ),
      );
      ptyId = created.id;
    } catch (err) {
      const rollback = useStore.getState();
      rollback.removeWorkspace(newWsId);
      rollback.setActiveWorkspace(previousActiveId);
      return { error: `fanout.spawnWorkspace: PTY create failed — ${err instanceof Error ? err.message : String(err)}` };
    }

    const afterPty = useStore.getState();
    const freshWs = afterPty.workspaces.find((w) => w.id === newWsId);
    if (!freshWs || !findPaneById(freshWs.rootPane, paneId)) {
      try { await window.electronAPI.pty.dispose(ptyId); } catch { /* best-effort */ }
      afterPty.removeWorkspace(newWsId);
      afterPty.setActiveWorkspace(previousActiveId);
      return { error: 'fanout.spawnWorkspace: pane disappeared during PTY creation' };
    }
    afterPty.addSurface(paneId, ptyId, '', cwd, newWsId);

    // 포커스 복원 — fan-out 스폰이 사람 화면을 훔치지 않는다.
    useStore.getState().setActiveWorkspace(previousActiveId);

    return { workspaceId: newWsId, ptyId };
  }

  // -------------------------------------------------------------------------
  // surface.*
  // -------------------------------------------------------------------------

  if (method === 'surface.list') {
    const targetWsId = typeof params.workspaceId === 'string' ? params.workspaceId : store.activeWorkspaceId;
    const ws = store.workspaces.find((w) => w.id === targetWsId);
    if (!ws) return [];
    // Search ALL leaf panes, not just active — so MCP can find browser surfaces anywhere
    const leaves = findLeafPanes(ws.rootPane);
    // X1 cwd-staleness fix: the per-surface cwd (live-updated via OSC 7 /
    // prompt scrape through updateSurfaceCwd) is authoritative. The
    // workspace-level metadata cwd is whichever ACTIVE surface last changed
    // directory — using it first stamped that one path onto every surface
    // in the workspace, which is exactly the stale `surface_list` cwd bug.
    const liveCwd = ws.metadata?.cwd;
    const liveGitBranch = ws.metadata?.gitBranch;
    const surfaces = [];
    for (const leaf of leaves) {
      for (const s of leaf.surfaces) {
        // Part A: per-surface agent label so a workspace hosting >1 agent is
        // distinguishable without the buffer-fingerprint workaround (gap 3).
        const agent = store.surfaceAgent[s.ptyId];
        surfaces.push({
          id: s.id,
          ptyId: s.ptyId,
          title: s.title,
          shell: s.shell,
          cwd: s.cwd || liveCwd,
          gitBranch: liveGitBranch,
          surfaceType: s.surfaceType || 'terminal',
          browserUrl: s.browserUrl,
          paneId: leaf.id,
          isActive: s.id === leaf.activeSurfaceId,
          agentName: agent?.name ?? null,
          agentStatus: agent?.status ?? null,
        });
      }
    }
    return surfaces;
  }

  if (method === 'surface.new') {
    // #236 family: honor an explicit workspaceId so a multi-agent caller opens
    // the surface in ITS OWN workspace, not whichever the user is viewing.
    // Fail CLOSED on an explicit-but-unknown id (never fall back to active —
    // that would open the terminal in the wrong agent's workspace).
    const requestedWsId =
      typeof params.workspaceId === 'string' && params.workspaceId.length > 0
        ? params.workspaceId
        : store.activeWorkspaceId;
    const ws = store.workspaces.find((w) => w.id === requestedWsId);
    if (!ws) {
      if (typeof params.workspaceId === 'string' && params.workspaceId.length > 0) {
        return { error: `surface.new: workspace "${requestedWsId}" not found` };
      }
      return { error: 'surface.new: no active workspace' };
    }

    const paneId = ws.activePaneId;
    const shell = typeof params.shell === 'string' ? params.shell : '';
    // #515: when the caller supplies no cwd, apply the same profile.startupCwd >
    // global startupDirectory fallback chain the Ctrl+T / palette paths use,
    // instead of spawning in home. An explicit caller cwd still wins.
    const cwd =
      typeof params.cwd === 'string' && params.cwd.length > 0
        ? params.cwd
        : resolveStartupCwd({ splitInheritsCwd: false, profile: ws.profile, startupDirectory: store.startupDirectory }) ?? '';

    const created = await window.electronAPI.pty.create(
      withWorkspaceProfile(
        {
          ...withDefaultShell({ shell: shell || undefined }, store.defaultShell),
          cwd: cwd || undefined,
          workspaceId: ws.id,
        },
        ws.profile,
      ),
    );
    const ptyId = created.id;

    // Re-read state after async gap — the pane may have been removed. Look up
    // the SAME workspace by id (NOT the active one, which may have changed).
    const freshAfterCreate = useStore.getState();
    const freshWsAfterCreate = freshAfterCreate.workspaces.find((w) => w.id === ws.id);
    if (!freshWsAfterCreate || !findPaneById(freshWsAfterCreate.rootPane, paneId)) {
      // Pane was removed during async gap — dispose the orphaned PTY
      try { await window.electronAPI.pty.dispose(ptyId); } catch { /* best-effort */ }
      return { error: 'pane was removed during PTY creation' };
    }
    // #515: adopt the cwd main actually spawned in (validated/home-fallback
    // applied) so the surface tracks its real dir and later splits seed correctly.
    freshAfterCreate.addSurface(paneId, ptyId, shell, created.cwd || cwd, ws.id);

    const fresh = useStore.getState();
    const freshWs = fresh.workspaces.find((w) => w.id === ws.id);
    if (!freshWs) return { ptyId };
    const pane = findPaneById(freshWs.rootPane, paneId);
    if (!pane || pane.type !== 'leaf') return { ptyId };
    const surface = pane.surfaces.find((s) => s.ptyId === ptyId);
    return surface
      ? { id: surface.id, ptyId: surface.ptyId, title: surface.title, shell: surface.shell, cwd: surface.cwd }
      : { ptyId };
  }

  if (method === 'surface.focus') {
    // surfaceIds are globally unique → resolve across ALL workspaces (mirrors
    // surface.close / pane.focus below), never the UI-active one. focusPaneSurface
    // sets the owning ws's active pane + surface atomically and is non-yank
    // (activeWorkspaceId is untouched), so a background agent can focus its own
    // surface without stealing the user's screen.
    const surfaceId = String(params.id ?? '');
    const owner = findOwningWorkspaceBySurface(store.workspaces, surfaceId);
    if (!owner) return { error: `surface.focus: surface ${surfaceId} not found` };
    store.focusPaneSurface(owner.ws.id, owner.leaf.id, surfaceId);
    return { ok: true };
  }

  if (method === 'pane.close') {
    // paneIds are globally unique → resolve across ALL workspaces (mirrors
    // surface.close), so an external caller can close a worker pane it created
    // (via pane.split) in its own background workspace. No active-ws fallback.
    const paneId = String(params.id ?? '');
    if (!paneId) return { error: 'pane.close: missing required param "id"' };

    let targetWs: Workspace | null = null;
    for (const ws of store.workspaces) {
      if (findPaneById(ws.rootPane, paneId)) { targetWs = ws; break; }
    }
    if (!targetWs) return { error: `pane.close: pane ${paneId} not found` };

    // Only leaf panes are closable, and never the root: closePane is a no-op for
    // the root pane (findParent returns null), so disposing its PTYs would orphan
    // live surfaces with dead PTYs (CodeRabbit). Reject non-leaf / root up front.
    const pane = findPaneById(targetWs.rootPane, paneId);
    if (!pane || pane.type !== 'leaf') {
      return { error: `pane.close: pane ${paneId} is not a closable leaf` };
    }
    if (paneId === targetWs.rootPane.id) {
      return { error: 'pane.close: cannot close the root pane' };
    }
    const ptyIds = pane.surfaces.map((s) => s.ptyId).filter((p): p is string => !!p);

    store.closePane(paneId, targetWs.id);

    for (const ptyId of ptyIds) {
      try { await window.electronAPI.pty.dispose(ptyId); } catch { /* best-effort */ }
    }
    return { ok: true };
  }

  if (method === 'surface.close') {
    const surfaceId = String(params.id ?? '');

    // Surface ids are globally unique, so an explicit id is an unambiguous
    // target — search every workspace, not just the UI-active one. The old
    // active-only lookup made CLI/MCP closes of a background workspace's
    // surface fail with "surface not found" (see cli/utils.ts).
    let targetWs: Workspace | null = null;
    let targetLeaf: PaneLeaf | null = null;
    for (const ws of store.workspaces) {
      const leaf = findLeafBySurfaceId(ws.rootPane, surfaceId);
      if (leaf) {
        targetWs = ws;
        targetLeaf = leaf;
        break;
      }
    }
    if (!targetWs || !targetLeaf) return { error: `surface ${surfaceId} not found` };

    const surface = targetLeaf.surfaces.find((s) => s.id === surfaceId);
    const ptyId = surface?.ptyId;

    store.closeSurface(targetLeaf.id, surfaceId, targetWs.id);

    if (ptyId) {
      try {
        await window.electronAPI.pty.dispose(ptyId);
      } catch {
        // Best-effort: PTY may already be gone.
      }
    }

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // pane.*
  // -------------------------------------------------------------------------

  if (method === 'pane.list') {
    const targetWsId = typeof params.workspaceId === 'string' ? params.workspaceId : store.activeWorkspaceId;
    const ws = store.workspaces.find((w) => w.id === targetWsId);
    if (!ws) return [];
    const liveCwd = ws.metadata?.cwd;
    const liveGitBranch = ws.metadata?.gitBranch;
    const leaves = findLeafPanes(ws.rootPane);
    return leaves.map((l) => {
      // X1 cwd-staleness fix (same as surface.list): per-surface cwd is
      // authoritative; workspace metadata cwd is only the fallback.
      const firstSurface = l.surfaces.find((s) => s.surfaceType !== 'browser');
      return {
        id: l.id,
        surfaceCount: l.surfaces.length,
        active: l.id === ws.activePaneId,
        cwd: firstSurface?.cwd || liveCwd,
        gitBranch: liveGitBranch,
        metadata: l.metadata,
        // X8 — surface ptyIds so the main-side pane.list join (pane.rpc.ts) can
        // match a daemon supervised session to its pane. Additive; the text
        // CLI table and external readers that ignore unknown fields are
        // unaffected.
        surfacePtyIds: l.surfaces.map((s) => s.ptyId).filter((id): id is string => Boolean(id)),
        // Part A: per-surface agent labels for this leaf. A split pane can hold
        // more than one terminal surface; each detected agent is listed so the
        // pane is individually addressable (gaps 1/8).
        agents: l.surfaces.flatMap((s) => {
          const a = store.surfaceAgent[s.ptyId];
          // pendingQuestion answers "is this pane blocked on me?" — a status of
          // 'waiting' alone can't, and reading the terminal to find out is what
          // makes an orchestrator mistake a printed question for pending input.
          // Omitted when there is none, so existing readers are unaffected.
          const q = store.surfacePendingQuestion[s.ptyId];
          // A hook-sourced stop publishes the question but carries no agent
          // identity, so a pane whose agent was never DETECTED would otherwise
          // drop out of this list entirely and take its question with it —
          // silently defeating the poll path for exactly the panes that need
          // it. Emit on either signal; the agent fields stay nullable.
          if (!a && !q) return [];
          return [{
            ptyId: s.ptyId,
            surfaceId: s.id,
            agentName: a?.name ?? null,
            agentStatus: a?.status ?? null,
            ...(q ? { pendingQuestion: q } : {}),
          }];
        }),
      };
    });
  }

  if (method === 'pane.focus') {
    // paneIds are globally unique → resolve across ALL workspaces (mirrors
    // pane.close), never the UI-active one. focusPaneSurface is non-yank
    // (activeWorkspaceId untouched) so an external agent can focus a pane in its
    // own background workspace. The old direct setActivePane call silently
    // no-op'd for any non-active workspace yet still returned {ok:true} (false
    // success); resolve-then-error surfaces the miss via getResultError.
    const paneId = String(params.id ?? '');
    const ownerWs = findOwningWorkspace(store.workspaces, paneId);
    if (!ownerWs) return { error: `pane.focus: pane ${paneId} not found` };
    // BYOB P4: an orchestrator brain is confined to its own workspace (the
    // §4.0 blast-radius invariant, generalized server-side — eng review P1).
    // `confineWorkspaceId` is stamped by MAIN from the VALIDATED commander
    // token binding (never caller-supplied): a brain focusing a pane it does
    // not own is refused instead of mutating another workspace's focus state.
    const confine =
      typeof params.confineWorkspaceId === 'string' && params.confineWorkspaceId.length > 0
        ? params.confineWorkspaceId
        : null;
    if (confine && ownerWs.id !== confine) {
      return { error: `pane.focus: pane ${paneId} is outside the commander's workspace` };
    }
    const ok = store.focusPaneSurface(ownerWs.id, paneId);
    if (!ok) return { error: `pane.focus: pane ${paneId} is not a focusable leaf` };
    return { ok: true };
  }

  if (method === 'pane.split') {
    // ─── Workspace scope + fail-closed (#236, mirrors pane.search) ───────
    // An external multi-agent caller passes `workspaceId` so the split lands
    // in the CALLING workspace, not whichever the user is currently viewing.
    // The human keybind / first-party CLI omit it → active workspace.
    const requestedWsId =
      typeof params.workspaceId === 'string' && params.workspaceId.length > 0
        ? params.workspaceId
        : store.activeWorkspaceId;
    const ws = store.workspaces.find((w) => w.id === requestedWsId);
    if (!ws) {
      // Fail CLOSED on an explicit-but-unknown workspaceId — never silently
      // fall back to the active ws (that would split the wrong agent's
      // workspace, the exact #236 bug). Unlike browser.open this method has no
      // requireWorkspaceId() MCP guard upstream, so the check lives here.
      if (typeof params.workspaceId === 'string' && params.workspaceId.length > 0) {
        return { error: `pane.split: workspace "${requestedWsId}" not found` };
      }
      return { error: 'pane.split: no active workspace' };
    }

    const direction =
      params.direction === 'vertical' ? 'vertical' : 'horizontal';

    // splitPane returns the exact new leaf id, so there is no need to diff the
    // empty-leaf set before/after (that heuristic could pick the wrong leaf if a
    // reentrant subscriber emptied another pane during the split's set()).
    const newPaneId = store.splitPane(ws.activePaneId, direction, ws.id);
    if (!newPaneId) return { error: 'pane.split: pane cap reached (max 20 per workspace)' };

    const afterSplit = useStore.getState();
    const splitWs = afterSplit.workspaces.find((w) => w.id === ws.id);
    if (!splitWs) return { ok: true }; // ws vanished in the async gap; split still happened

    // Active-ws split: the AppLayout empty-leaf funnel owns PTY creation (it
    // carries the full startup-cwd / project-seed / X8-supervision chain), so
    // we do NOT duplicate it here. The ptyId is only known after that async
    // create, hence it is omitted from the return for the active-ws path.
    if (splitWs.id === afterSplit.activeWorkspaceId) {
      return { ok: true, paneId: newPaneId };
    }

    // ─── Background-ws split: eager-spawn the PTY (#236 P0) ──────────────
    // The funnel is gated on the ACTIVE workspace (AppLayout effect dep =
    // activeWorkspace.id), so a pane split into a background ws would stay
    // surface-less — no terminal — until the user activates that workspace. An
    // external agent that splits-then-sends needs a live PTY immediately, so
    // spawn it here, mirroring surface.new's create + orphan-guard + adopt.

    // Same cwd precedence the funnel applies (split-inherited > profile
    // startupCwd > global startupDirectory > main-side homedir). Consume the
    // seed so a later activation's funnel can't double-create on this pane.
    const startupCwd = resolveStartupCwd({
      splitSeed: afterSplit.splitCwdSeed[newPaneId],
      splitInheritsCwd: afterSplit.splitInheritsCwd,
      profile: splitWs.profile,
      startupDirectory: afterSplit.startupDirectory,
    });
    if (afterSplit.splitCwdSeed[newPaneId]) afterSplit.clearSplitCwdSeed(newPaneId);

    let created: { id: string; shell?: string; cwd?: string };
    try {
      created = await window.electronAPI.pty.create(
        withWorkspaceProfile(
          withDefaultShell(
            { workspaceId: splitWs.id, cwd: startupCwd || undefined },
            useStore.getState().defaultShell,
          ),
          splitWs.profile,
        ),
      );
    } catch (err) {
      // The tree split already succeeded and is valid — surface the PTY failure
      // but do NOT roll back (the agent asked for the pane; the funnel will
      // backfill it if the ws is later activated).
      return {
        ok: true,
        paneId: newPaneId,
        ptyWarning: `pane.split: PTY create failed — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Orphan guard (mirror surface.new / funnel): adopt the PTY only if the
    // pane still exists AND is still empty. If the user switched to the ws
    // mid-create and the funnel already filled it, dispose ours.
    const afterPty = useStore.getState();
    const freshWs = afterPty.workspaces.find((w) => w.id === splitWs.id);
    const livePane = freshWs ? findPaneById(freshWs.rootPane, newPaneId) : null;
    if (!livePane || livePane.type !== 'leaf' || livePane.surfaces.length > 0) {
      try { await window.electronAPI.pty.dispose(created.id); } catch { /* best-effort */ }
      return { ok: true, paneId: newPaneId };
    }
    const shellName = created.shell ? shellDisplayName(created.shell) : 'Terminal';
    afterPty.addSurface(newPaneId, created.id, shellName, created.cwd || '', splitWs.id);
    return { ok: true, paneId: newPaneId, ptyId: created.id };
  }

  if (method === 'pane.resolveActiveLeaf') {
    // M0-b internal IPC: main asks the renderer to resolve the active leaf
    // pane for a workspace. Used when an external RPC caller omits `paneId`
    // and we need to forward the active selection to MetadataStore. Read-only
    // — does not write to paneSlice; only returns the current active leaf id
    // and the resolved workspaceId so the next write hits the right pane.
    //
    // This channel keeps MetadataStore as the sole metadata writer: the
    // renderer never sees the patch, it only answers "which leaf is active?".
    const wsId = typeof params.workspaceId === 'string' && params.workspaceId.length > 0
      ? params.workspaceId
      : store.activeWorkspaceId;
    const ws = store.workspaces.find((w) => w.id === wsId);
    if (!ws) return { error: `pane.resolveActiveLeaf: workspace "${wsId}" not found` };
    const target = findPaneById(ws.rootPane, ws.activePaneId);
    if (!target || target.type !== 'leaf') {
      return { error: `pane.resolveActiveLeaf: active pane is not a leaf in workspace "${wsId}"` };
    }
    return { paneId: target.id, workspaceId: wsId };
  }

  if (method === 'pane.validateWorkspace') {
    // M0-d follow-up (codex P1): main asks the renderer to confirm that a
    // caller-supplied `paneId` actually belongs to the caller's `workspaceId`.
    // MetadataStore is keyed by paneId only, so without this check an MCP
    // scoped to workspace A could pass B's paneId together with its own
    // workspaceId and quietly read/write B's metadata via the paneId-present
    // branch of `resolveTarget` in `pane.rpc.ts`. The renderer holds the
    // authoritative pane tree, so we ask it.
    //
    // Read-only — does not mutate paneSlice. Returns the authoritative
    // workspaceId on success so the handler can scope events even if the
    // caller omitted `workspaceId` (paneId-only legacy calls).
    const paneId = typeof params.paneId === 'string' ? params.paneId : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (paneId.length === 0) {
      return { error: 'pane.validateWorkspace: paneId required' };
    }
    // When the caller passed an explicit workspaceId, we MUST scope the
    // lookup to it — otherwise we'd defeat the whole check (finding the
    // pane in another workspace and then claiming it belonged to the
    // caller's). When workspaceId is omitted, we scan every workspace so
    // a legacy paneId-only call still works.
    const ws = workspaceId.length > 0
      ? store.workspaces.find((w) => w.id === workspaceId)
      : store.workspaces.find((w) => findPaneById(w.rootPane, paneId) !== null);
    if (!ws) {
      return {
        error: workspaceId.length > 0
          ? `pane.validateWorkspace: workspace "${workspaceId}" not found`
          : `pane.validateWorkspace: paneId "${paneId}" not in any workspace`,
      };
    }
    const target = findPaneById(ws.rootPane, paneId);
    if (!target || target.type !== 'leaf') {
      return {
        error: `pane.validateWorkspace: leaf "${paneId}" not in workspace "${ws.id}"`,
      };
    }
    return { paneId, workspaceId: ws.id };
  }

  // M0-d: pane.setMetadata / pane.getMetadata / pane.clearMetadata handlers
  // were removed. After M0-b the main process routes those RPCs straight
  // through MetadataStore and never calls sendToRenderer for them, so these
  // branches were unreachable dead code. MetadataStore is the sole writer.

  if (method === 'pane.search') {
    const query = String(params['query'] ?? '');
    const regex = params['regex'] === true;
    if (query.length === 0) return { error: 'pane.search: empty query' };

    // ─── Workspace scope (C1, decisions D9) ──────────────────────────────
    // External MCP callers pass `workspaceId` via T-D so the search is
    // scoped to the CALLING workspace, not whichever the user is currently
    // viewing in the UI. Internal renderer callers (SearchBar) omit
    // `workspaceId` and fall back to the active workspace.
    const requestedWsId =
      typeof params['workspaceId'] === 'string' && (params['workspaceId'] as string).length > 0
        ? (params['workspaceId'] as string)
        : store.activeWorkspaceId;
    const ws = store.workspaces.find((w) => w.id === requestedWsId);
    if (!ws) {
      // Validate explicitly so an external caller passing a stale/invalid
      // workspaceId gets a clear error instead of silently empty results.
      if (typeof params['workspaceId'] === 'string' && (params['workspaceId'] as string).length > 0) {
        return { error: `pane.search: workspace "${requestedWsId}" not found` };
      }
      return { error: 'pane.search: no active workspace' };
    }

    // Build ptyId → workspaceId reverse map (current ws only — D9, v1 scope='workspace')
    // and ptyId → paneId map for result tagging.
    const ptyToPaneId = new Map<string, string>();
    const ptyToSurfaceId = new Map<string, string>();
    // P2: per-surface display name = pane rename ?? auto name `w<ws>-<pane>(<agent>)`.
    // The renderer is authoritative for labels (paneLabel mirror) and ordinals
    // (layout state), so compute the resolved name here and ship it — the daemon
    // paneLabel is ignored. Each surface's own agent slug names its suffix.
    const ptyToPaneLabel = new Map<string, string>();
    const wsOrdinal = ws.wsOrdinal ?? 0;
    const leaves = findLeafPanes(ws.rootPane);
    for (const leaf of leaves) {
      const leafLabel = store.paneLabel[leaf.id];
      const paneOrdinal = leaf.ordinal ?? 0;
      for (const s of leaf.surfaces) {
        if (s.ptyId) {
          ptyToPaneId.set(s.ptyId, leaf.id);
          ptyToSurfaceId.set(s.ptyId, s.id);
          const autoName = computePaneAutoName(wsOrdinal, paneOrdinal, store.surfaceAgent[s.ptyId]?.slug);
          ptyToPaneLabel.set(s.ptyId, paneDisplayName(leafLabel, autoName));
        }
      }
    }

    const TOTAL_BUDGET = 200;
    let remainingBudget = TOTAL_BUDGET;
    const results: PaneSearchResult[] = [];
    let totalMatches = 0;
    // ─── Truncation tracking (I1) ────────────────────────────────────────
    // We can't know "true total" without re-scanning post-cap, so semantics
    // are: truncated=true iff the budget hit zero AND there were panes left
    // to scan (or the per-pane engine returned exactly `remainingBudget`
    // matches, signalling more were available). This is the closest honest
    // approximation without a second-pass scan.
    let truncated = false;

    // Snapshot registry keys to make mutation during iteration safe (N2).
    const ptyIds = Array.from(terminalRegistry.keys());
    // Keep only ptyIds that belong to the resolved workspace so the
    // "panes-left" check below is meaningful.
    const scannablePtyIds = ptyIds.filter((id) => ptyToPaneId.has(id));
    // Phase 3 hydrate-before-read: with hidden-pane retention on, a hidden
    // pane's xterm buffer can lag its PTY stream (retained backlog) or be
    // stale outright (dirty after overflow). Searching it would silently
    // return old output to agents. Hydration is a no-op for clean visible
    // panes and bounded for dirty ones (daemon resync ≤ scrollback lines).
    await Promise.all(scannablePtyIds.map((id) => hydrateTerminalForRead(id).catch(() => { /* per-pane best effort */ })));
    for (let pIdx = 0; pIdx < scannablePtyIds.length; pIdx++) {
      const ptyId = scannablePtyIds[pIdx];
      if (remainingBudget <= 0) {
        // Budget exhausted before we got to this pane → more matches likely.
        truncated = true;
        break;
      }
      const paneId = ptyToPaneId.get(ptyId);
      if (!paneId) continue; // belt-and-braces; filtered above already
      const term = terminalRegistry.get(ptyId);
      if (!term) continue; // unmounted between snapshot and read
      try {
        // Adapt xterm Buffer to SearchableBuffer (it already conforms structurally)
        const requestedBudget = remainingBudget;
        const matches = searchInBuffer(
          term.buffer.active as unknown as SearchableBuffer,
          query,
          { regex, contextLines: 2, perBufferLineCap: 20_000, remainingBudget },
        );
        totalMatches += matches.length;
        for (const m of matches) {
          const label = ptyToPaneLabel.get(ptyId);
          const result: PaneSearchResult = {
            paneId,
            surfaceId: ptyToSurfaceId.get(ptyId)!,
            ptyId,
            lineIdx: m.lineIdx,
            physicalBaseY: m.physicalBaseY,
            text: m.text,
            contextBefore: m.contextBefore,
            contextAfter: m.contextAfter,
            ...(label !== undefined && { paneLabel: label }),
          };
          results.push(result);
          remainingBudget--;
          if (remainingBudget <= 0) break;
        }
        // If the engine returned EXACTLY the budget we gave it, more matches
        // may exist in this same buffer that were cut off — truncated.
        if (matches.length === requestedBudget && remainingBudget <= 0) {
          // There may also be unscanned panes after this — both flag as truncated.
          truncated = true;
        }
      } catch (err) {
        // SyntaxError from invalid regex — propagate as RPC error
        if (err instanceof SyntaxError) {
          return { error: `pane.search: invalid regex: ${err.message}` };
        }
        // Per-pane errors (e.g., disposed terminal): skip silently (N2)
      }
    }

    // ─── Cold-park fallback (TASK-9) ─────────────────────────────────────
    // Panes in this workspace whose terminals are unmounted (cold-parked) are
    // absent from terminalRegistry and were skipped above. Read their grid from
    // the daemon ring so they are still searched — a parked pane must not be a
    // silent miss (hard AC). Sequential (not Promise.all) so the shared budget
    // is honored and the daemon's concurrency-1 snapshot queue isn't stormed.
    const parkedPtyIds = Array.from(ptyToPaneId.keys()).filter((id) => !terminalRegistry.has(id));
    // Wall-clock deadline: each parked read can take seconds on the daemon's
    // concurrency-1 snapshot queue, and 3+ heavy panes would blow the outer 10s
    // MCP RPC timeout. Stop issuing reads past ~6s and report truncated rather
    // than let the whole search time out to empty.
    const PARKED_DEADLINE_MS = 6000;
    const parkedStart = Date.now();
    for (const ptyId of parkedPtyIds) {
      if (remainingBudget <= 0) { truncated = true; break; }
      if (Date.now() - parkedStart > PARKED_DEADLINE_MS) { truncated = true; break; }
      const paneId = ptyToPaneId.get(ptyId);
      if (!paneId) continue;
      // Request the renderer's configured scrollback depth (daemon clamps to
      // MAX_SCROLLBACK) — a hard 5000 would miss the older half of a 10k buffer
      // while still reporting truncated:false.
      const read = await fetchParkedPaneRows(ptyId, store.scrollbackLines);
      if (!read) {
        // Legacy daemon / local mode / gone session: this parked pane could not
        // be read, so coverage is incomplete — flag truncated so callers know
        // the result set is partial rather than treating it as authoritative.
        truncated = true;
        continue;
      }
      // The daemon dropped oldest rows to fit the RPC frame → partial coverage.
      if (read.truncated) truncated = true;
      try {
        const requestedBudget = remainingBudget;
        const matches = searchInBuffer(
          rowsToSearchableBuffer(read.rows),
          query,
          { regex, contextLines: 2, perBufferLineCap: 20_000, remainingBudget },
        );
        totalMatches += matches.length;
        for (const m of matches) {
          const label = ptyToPaneLabel.get(ptyId);
          results.push({
            paneId,
            surfaceId: ptyToSurfaceId.get(ptyId)!,
            ptyId,
            lineIdx: m.lineIdx,
            physicalBaseY: m.physicalBaseY,
            text: m.text,
            contextBefore: m.contextBefore,
            contextAfter: m.contextAfter,
            ...(label !== undefined && { paneLabel: label }),
          });
          remainingBudget--;
          if (remainingBudget <= 0) break;
        }
        if (matches.length === requestedBudget && remainingBudget <= 0) {
          truncated = true;
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          return { error: `pane.search: invalid regex: ${err.message}` };
        }
        // Per-pane fallback errors — skip silently, same as the live path.
      }
    }

    const response: PaneSearchResponse = {
      resultShapeVersion: 1,
      results,
      truncated,
      totalMatches,
      workspaceId: ws.id, // C1: echo the RESOLVED workspace, not the active one.
    };
    return response;
  }

  // -------------------------------------------------------------------------
  // input.*
  // -------------------------------------------------------------------------

  // input.findOwnerWorkspace — returns the workspace that owns a given ptyId,
  // or null if no surface in any workspace is bound to that PTY. Main-side
  // validators use this to gate cross-workspace terminal access (defense
  // against PTY-id leaks bypassing the metadata-layer isolation).
  //
  // D2: also returns the owning paneId and its resolved role→model binding (if
  // any), so main's input.send rewrite can enforce the bound model without a
  // second round-trip. Both the role mirror (paneRole) and the operator binding
  // map (orchestratorRoleBindings) live in the renderer store, so the renderer
  // is the natural place to resolve the pair. Fields are additive — legacy
  // callers that read only `workspaceId` are unaffected.
  if (method === 'input.findOwnerWorkspace') {
    const ptyId = typeof params.ptyId === 'string' ? params.ptyId : '';
    if (!ptyId) return { workspaceId: null };
    for (const ws of store.workspaces) {
      const leaves = findLeafPanes(ws.rootPane);
      for (const leaf of leaves) {
        for (const s of leaf.surfaces) {
          if (s.ptyId === ptyId) {
            const role = store.paneRole[leaf.id];
            const binding = role ? normalizeRoleBinding(store.orchestratorRoleBindings[role]) : undefined;
            return {
              workspaceId: ws.id,
              paneId: leaf.id,
              ...(binding ? { roleBinding: binding } : {}),
            };
          }
        }
      }
    }
    return { workspaceId: null };
  }

  if (method === 'input.readScreen') {
    // Workspace scoping: external MCP callers MUST pass workspaceId so reads
    // can't be hijacked into whichever workspace the user happens to focus.
    // Internal callers may omit it and fall back to the active workspace.
    const callerWsId =
      typeof params.workspaceId === 'string' && params.workspaceId.length > 0
        ? params.workspaceId
        : store.activeWorkspaceId;

    let ptyId: string | null = typeof params.ptyId === 'string' ? params.ptyId : null;
    if (!ptyId) {
      const ws = store.workspaces.find((w) => w.id === callerWsId);
      if (ws) {
        const activePane = findPaneById(ws.rootPane, ws.activePaneId);
        if (activePane && activePane.type === 'leaf') {
          const surface = activePane.surfaces.find(
            (s) => s.id === activePane.activeSurfaceId,
          );
          ptyId = surface?.ptyId ?? null;
        }
      }
    } else if (typeof params.workspaceId === 'string' && params.workspaceId.length > 0) {
      // Caller passed both — validate the PTY belongs to that workspace.
      const targetWs = store.workspaces.find((w) => w.id === callerWsId);
      const owned =
        targetWs &&
        findLeafPanes(targetWs.rootPane).some((leaf) =>
          leaf.surfaces.some((s) => s.ptyId === ptyId),
        );
      if (!owned) {
        return {
          error: `input.readScreen: PTY "${ptyId}" not in workspace "${callerWsId}"`,
        };
      }
    }
    if (!ptyId) return { ptyId: null, text: '' };

    const raw = params as Record<string, unknown>;

    const terminal = terminalRegistry.get(ptyId);
    if (!terminal) {
      // Cold-park fallback (TASK-9): the pane's terminal is unmounted (parked).
      // Read its grid from the daemon ring instead of returning empty — an agent
      // reading a parked pane must see its content, not a silent blank.
      const wantsFull = raw.full_scrollback === true;
      const rawTailP = raw.tail_lines;
      const capP =
        typeof rawTailP === 'number' && Number.isFinite(rawTailP) && rawTailP > 0
          ? Math.floor(rawTailP)
          : DEFAULT_READ_TAIL_LINES;
      // Request only as deep as the read needs: a bounded tail read fetches
      // `capP` rows, not the whole configured scrollback — avoids the big daemon
      // payload for the common case. full_scrollback opts into the full depth.
      const depth = wantsFull ? store.scrollbackLines : capP;
      const read = await fetchParkedPaneRows(ptyId, depth);
      if (!read) return { ptyId, text: '' }; // legacy daemon / local / gone
      const texts = read.rows.map((r) => r.text);
      if (wantsFull) {
        // full_scrollback promises the ENTIRE backlog — if the daemon dropped
        // oldest rows to fit the RPC frame, surface truncated so the caller
        // doesn't read partial history as complete (callRpc serializes the whole
        // result object, so the field reaches the agent).
        return { ptyId, text: texts.join('\n'), ...(read.truncated && { truncated: true }) };
      }
      // Bounded tail read: only the last capP rows were requested, so older
      // history missing is by design, not a truncation to report.
      return { ptyId, text: texts.slice(-capP).join('\n') };
    }

    // Phase 3 hydrate-before-read — see pane.search above. Agents reading a
    // hidden pane must see its live state, not a retention-stale buffer.
    await hydrateTerminalForRead(ptyId).catch(() => { /* best effort */ });

    // Read cost is bounded by DEFAULT unless the caller opts into the full
    // scrollback. RCA (2026-07-14 orchestrator lag): the old path always walked
    // the WHOLE buffer (0..baseY+cursorY, up to scrollbackLines=10,000 rows)
    // synchronously on the renderer thread, and even an explicit `tail_lines`
    // only trimmed the RESULT — the expensive walk still ran. An orchestrator
    // that bursts terminal_read then pinned the render thread and starved
    // input/switch/paint ("terminal read 폭발할때"). Now:
    //   - full_scrollback:true → the exact whole-buffer read (old behavior),
    //   - tail_lines:N         → the last N rows, read in O(N),
    //   - neither              → the last DEFAULT rows, read in O(DEFAULT).
    // The bounded reader never walks past its window, so a 10k-row backlog costs
    // the same as a fresh pane.
    const fullScrollback = raw.full_scrollback === true;
    if (fullScrollback) {
      // Explicit opt-in to the exact, unbounded read (walk 0..baseY+cursorY).
      const lines = readPtyBufferLines(ptyId);
      return { ptyId, text: lines.join('\n') };
    }
    const rawTail = raw.tail_lines;
    const cap =
      typeof rawTail === 'number' && Number.isFinite(rawTail) && rawTail > 0
        ? Math.floor(rawTail)
        : DEFAULT_READ_TAIL_LINES;
    const lines = readPtyBufferTail(ptyId, cap);
    return { ptyId, text: lines.join('\n') };
  }

  if (method === 'input.getActivePtyId') {
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    if (!ws) return { ptyId: null };
    const activePane = findPaneById(ws.rootPane, ws.activePaneId);
    if (!activePane || activePane.type !== 'leaf') return { ptyId: null };
    const surface = activePane.surfaces.find(
      (s) => s.id === activePane.activeSurfaceId,
    );
    return { ptyId: surface?.ptyId ?? null };
  }

  // -------------------------------------------------------------------------
  // meta.*
  // -------------------------------------------------------------------------

  if (method === 'meta.setStatus') {
    const text = String(params.text ?? '');
    store.updateWorkspaceMetadata(store.activeWorkspaceId, { status: text });
    return { ok: true };
  }

  if (method === 'meta.setProgress') {
    const value = typeof params.value === 'number' ? params.value : Number(params.value ?? 0);
    store.updateWorkspaceMetadata(store.activeWorkspaceId, { progress: value });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // browser.*
  // -------------------------------------------------------------------------

  if (method === 'browser.tabs') {
    return handleBrowserTabsRpc(params, {
      getState: () => useStore.getState(),
      openUrl: openUrlInBrowserPane,
    });
  }

  if (method === 'browser.open') {
    const targetWsId = typeof params.workspaceId === 'string'
      ? params.workspaceId
      : store.activeWorkspaceId;
    const url = typeof params.url === 'string' ? params.url : undefined;
    // Forward the partition only when the caller named one — the old reuse
    // path force-reset an unspecified partition to the default, remounting
    // the webview (the partition is part of BrowserPanel's key) and dropping
    // the login session.
    const partition = typeof params.partition === 'string' ? params.partition : undefined;

    // Shared open-or-reuse algorithm (terminal links / port badges use the
    // same one). focusPane:false keeps the user's terminal pane focused.
    // Reuse now actually navigates the webview (store write + navigate
    // event) — the old in-place setState only changed browserUrl, which the
    // mounted webview never reads.
    const result = openUrlInBrowserPane(url, {
      workspaceId: targetWsId,
      partition,
      focusPane: false,
    });

    if (!result.ok) {
      if (result.error === 'pane-cap') return { error: 'pane cap reached (max 20 per workspace)' };
      if (result.error === 'invalid-url') return { error: 'browser.open: invalid url (http/https only)' };
      return { error: 'no active workspace' };
    }
    return result.reused
      ? { ok: true, surfaceId: result.surfaceId, url: result.url, reused: true }
      : { ok: true, surfaceId: result.surfaceId, url: result.url };
  }

  if (method === 'browser.session.applyProfile') {
    const partition = typeof params.partition === 'string' ? params.partition : '';
    if (!partition) return { error: 'browser.session.applyProfile: missing partition' };
    if (!isSelectableBrowserPartition(partition)) {
      return { error: 'browser.session.applyProfile: invalid partition' };
    }
    const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
    store.updateBrowserPartition(partition, surfaceId);
    return { ok: true, partition, ...(surfaceId && { surfaceId }) };
  }

  if (method === 'browser.close') {
    const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
    // Workspace routing mirrors browser.open (lines above): an explicit
    // workspaceId (MCP requireWorkspaceId / CLI verified identity) pins the
    // close to the CALLER's workspace; absent, fall back to the UI-active one.
    // Without this, an agent in workspace A issuing browser_close closed
    // whatever browser the USER happened to be looking at in workspace B —
    // the open path was fixed in #193, close kept the asymmetry.
    const targetWsId = typeof params.workspaceId === 'string'
      ? params.workspaceId
      : store.activeWorkspaceId;

    let targetWs: Workspace | null = null;
    let targetLeaf: PaneLeaf | null = null;
    let targetSurfaceId: string | null = null;

    if (surfaceId) {
      // Explicit surface id — unambiguous target, so search EVERY workspace.
      // Scoping an explicit id to one workspace only manufactures false
      // "not found" errors (the surface.close lesson — see cli/utils.ts).
      for (const ws of store.workspaces) {
        for (const leaf of findLeafPanes(ws.rootPane)) {
          const surface = leaf.surfaces.find((s) => s.id === surfaceId && s.surfaceType === 'browser');
          if (surface) {
            targetWs = ws;
            targetLeaf = leaf;
            targetSurfaceId = surface.id;
            break;
          }
        }
        if (targetLeaf) break;
      }
    } else {
      // No surface id — "the browser pane" is ambiguous, so resolve it inside
      // the routed workspace only. Never reach into other workspaces here.
      const ws = store.workspaces.find((w) => w.id === targetWsId);
      if (!ws) return { error: 'browser.close: workspace not found' };
      for (const leaf of findLeafPanes(ws.rootPane)) {
        const surface = leaf.surfaces.find((s) => s.surfaceType === 'browser');
        if (surface) {
          targetWs = ws;
          targetLeaf = leaf;
          targetSurfaceId = surface.id;
          break;
        }
      }
    }

    if (!targetWs || !targetLeaf || !targetSurfaceId) {
      return { error: 'browser.close: no browser surface found' };
    }

    // Shared with browser.tabs close so both paths preserve the exact UI
    // last-surface cascade. The helper re-resolves within targetWs immediately
    // before mutation; browser.close keeps its legacy global explicit-id
    // resolution above, while browser.tabs never leaves caller scope.
    if (!closeBrowserTabInWorkspace(store, targetWs.id, targetSurfaceId)) {
      return { error: 'browser.close: no browser surface found' };
    }
    return { ok: true };
  }

  if (method === 'browser.navigate') {
    const url = typeof params.url === 'string' ? params.url : '';
    if (!url) return { error: 'browser.navigate: missing url' };
    // Security: block dangerous URL schemes that could execute code
    const normalizedUrl = url.trim().toLowerCase();
    if (
      normalizedUrl.startsWith('javascript:') ||
      normalizedUrl.startsWith('data:') ||
      normalizedUrl.startsWith('vbscript:') ||
      normalizedUrl.startsWith('file:') ||
      normalizedUrl.startsWith('blob:')
    ) {
      return { error: `browser.navigate: blocked URL scheme in "${url}"` };
    }
    const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
    return handleBrowserNavigate(store, url, surfaceId);
  }

  // -------------------------------------------------------------------------
  // a2a.*
  // -------------------------------------------------------------------------

  if (method === 'a2a.resolve.identity') {
    // Resolve workspace from PTY workspace ID passed via env var
    const ptyWorkspaceId = typeof params.ptyWorkspaceId === 'string' ? params.ptyWorkspaceId : '';
    if (ptyWorkspaceId) {
      const ws = store.workspaces.find((w) => w.id === ptyWorkspaceId);
      if (ws) return { workspaceId: ws.id };
    }
    // Fallback: try to match by PID through surfaces' PTY IDs
    // (future: PTYManager could track PID→workspace mapping)
    return { workspaceId: '' };
  }

  if (method === 'a2a.whoami') {
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!workspaceId) {
      return { error: 'a2a.whoami: workspaceId is required. Ensure WMUX_WORKSPACE_ID is set in the environment.' };
    }
    const ws = store.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return { error: `no workspace found for ${workspaceId}` };
    const base = {
      workspaceId: ws.id,
      name: ws.name,
      metadata: ws.metadata ?? {},
    };
    // Pane-level identity: when the MCP server forwarded our OWN verified ptyId
    // (senderPtyId — populated only on a verified PID-map hit), resolve which of
    // THIS workspace's panes is the caller and return its pane address + the
    // agent detected on that specific pane (ws.metadata.agentName is a single
    // ws-level aggregate that collapses N agents into one). resolveSelfPaneIdentity
    // is scoped to ws.rootPane's own leaves, so a forged/foreign ptyId yields null
    // and we degrade to the ws-level answer (never an error, never echoing a
    // client-supplied selector as trusted identity). Read-only: these fields grant
    // no capability — whoami output never flows into terminal routing.
    const rawSenderPtyId = typeof params.senderPtyId === 'string' ? params.senderPtyId : '';
    const self = resolveSelfPaneIdentity(
      findLeafPanes(ws.rootPane),
      (ptyId) => store.surfaceAgent[ptyId],
      rawSenderPtyId,
    );
    return self ? { ...base, ...self } : base;
  }

  if (method === 'a2a.discover') {
    return {
      agents: store.workspaces.map((w) => {
        // null  → never registered skills (getAgentSkills returns null)
        // []    → registered, but explicitly empty
        // Distinguish the two instead of collapsing both to [] so a sender can
        // tell "this agent hasn't advertised yet" from "it has no skills".
        // null → never registered skills (getAgentSkills returns null); a
        // non-null array → registered (possibly empty). The AgentCard contract
        // (src/shared/types.ts) declares `skills: AgentSkill[]`, so `skills`
        // below is ALWAYS an array — the never-registered vs registered-empty
        // distinction rides the separate `skillsRegistered` boolean instead of
        // a contract-breaking null that crashes clients iterating agent.skills.
        const skills = store.getAgentSkills(w.id);
        const skillsRegistered = skills !== null;
        // Advisory liveness hint (③). Derived from store metadata — a live TUI
        // agent has an agentName AND an active agentStatus. ADVISORY ONLY:
        // never gate sending on this, it just lets a sender pre-check whether
        // the receiver is likely to react to a paste vs. needs the inbox poll.
        const live = isLiveTuiAgent(w.metadata);
        // Part A — per-pane agent labels (gaps 1/3/8). Each terminal surface in
        // the workspace becomes an addressable entry (paneId/surfaceId/ptyId)
        // carrying its detected agent (null when undetected). Clients that need
        // to talk to a SPECIFIC agent in a multi-agent workspace iterate
        // `panes` and address `a2a_task_send` with the surface_id/pane_id; the
        // ws-level fields below stay for back-compat single-agent callers.
        const panes: Array<{
          paneId: string;
          surfaceId: string;
          ptyId: string;
          agentName: string | null;
          agentStatus: string | null;
        }> = [];
        for (const leaf of findLeafPanes(w.rootPane)) {
          for (const s of leaf.surfaces) {
            if (s.surfaceType === 'browser' || !s.ptyId) continue;
            const a = store.surfaceAgent[s.ptyId];
            panes.push({
              paneId: leaf.id,
              surfaceId: s.id,
              ptyId: s.ptyId,
              agentName: a?.name ?? null,
              agentStatus: a?.status ?? null,
            });
          }
        }
        return {
          name: w.name,
          description: w.metadata?.agentName ?? w.name,
          url: w.id,
          version: '1.0',
          capabilities: { stateTransitionHistory: true },
          skills: skills
            ? skills.map((s) => (typeof s === 'string' ? { id: s, name: s } : s))
            : [], // never registered OR registered-empty — skillsRegistered disambiguates
          skillsRegistered,
          // Advisory only — see comment above. `liveSource` records what the
          // hint is derived from (store metadata in v1); a future
          // resolve.identity PID→ws cross-check would set a stronger source.
          live,
          liveSource: live ? 'store-metadata' : undefined,
          panes,
          metadata: {
            workspaceId: w.id,
            status: (w.metadata?.agentStatus as string) ?? 'idle',
            agentName: w.metadata?.agentName ?? null,
            live,
          },
        };
      }),
    };
  }

  if (method === 'a2a.task.send') {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    const executeRequested = params.execute === true;
    const rawMessage = typeof params.message === 'string' ? params.message : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!workspaceId) return { error: 'a2a.task.send: missing "workspaceId". Ensure WMUX_WORKSPACE_ID is set.' };

    if (!rawMessage) return { error: 'a2a.task.send: missing "message"' };
    let message: string;
    try { message = validateMessage(rawMessage); } catch (e) {
      return { error: `a2a.task.send: ${e instanceof Error ? e.message : 'invalid'}` };
    }

    // `silent: true` suppresses the PTY paste delivery so the receiver's
    // terminal (and any running TUI agent) is not disturbed. The task is
    // still persisted in the store and remains queryable via
    // a2a_task_query — this is the canonical "inbox" path that avoids
    // injecting message content into the receiver's prompt stream.
    const silent = params.silent === true;
    // Was `silent` set explicitly at all? When it is NOT, we pick the delivery
    // mode per-receiver: a live TUI agent gets the EventBus pointer + a
    // one-line nudge (its prompt is not flooded); a receiver with no live
    // agent keeps today's loud full-body paste (don't regress a non-poller).
    // An explicit silent (true OR false) is honored verbatim — explicit true
    // = full suppression, explicit false = loud full paste.
    //
    // Only a real BOOLEAN counts as explicit. A direct main-pipe RPC client
    // (which bypasses the MCP zod schema) may serialize an omitted optional as
    // `null` — `!== undefined` would mis-read that as an explicit override and
    // loud-paste into a live agent's prompt, defeating the silent-default. Any
    // non-boolean (null, string, missing) falls through to the live-aware
    // default.
    const silentExplicit = typeof params.silent === 'boolean';

    // Build parts (A2A standard: kind discriminant)
    const parts: Part[] = [{ kind: 'text', text: message }];
    if (params.data && typeof params.data === 'object') {
      parts.push({
        kind: 'data',
        data: params.data as Record<string, unknown>,
        metadata: { mimeType: typeof params.dataMimeType === 'string' ? params.dataMimeType : 'application/json' },
      });
    }

    if (taskId && executeRequested) {
      return { error: 'a2a.task.send: execute is only supported for new tasks' };
    }

    // ── Reply branch: taskId exists → add message to existing task ──
    if (taskId) {
      const task = store.getTask(taskId);
      if (!task) return { error: `a2a.task.send: task "${taskId}" not found` };
      // Verify caller is sender or receiver of this task
      if (task.metadata.from.workspaceId !== workspaceId && task.metadata.to.workspaceId !== workspaceId) {
        return { error: 'a2a.task.send: not authorized to reply to this task' };
      }
      // S-C2: resolve the CALLER's own pane (verified senderPtyId in the caller's
      // OWN ws tree — same guard as the send path) so the history role is computed
      // per-pane and the reply pins back to the originating pane. callerAddr null
      // (absent/forged senderPtyId, or a ws-only task side) → ws-level role
      // fallback, preserving cross-ws behavior exactly.
      const callerWsForReply = store.workspaces.find((w) => w.id === workspaceId);
      const callerLeaves = callerWsForReply ? findLeafPanes(callerWsForReply.rootPane) : [];
      const rawCallerPtyId = typeof params.senderPtyId === 'string' ? params.senderPtyId : '';
      const callerPtyId = isTerminalPtyInLeaves(callerLeaves, rawCallerPtyId) ? rawCallerPtyId : '';
      const callerAddr = resolveSenderPaneAddress(callerLeaves, callerPtyId);
      const paneRole = resolvePaneRole(task.metadata, callerAddr);
      // In a fully pane-anchored SAME-ws task, only the addressed `from`/`to`
      // panes participate. A VERIFIED caller pane (callerAddr) that matches
      // neither is a third-party non-participant — reject, rather than fall back
      // to the ws-level 'user' role, which would store its message as the
      // sender's and nudge the receiver as if it came from `from`. Cross-ws keeps
      // the ws-level model (the whole `from` ws is the sender side); an unverified
      // caller is handled by the suppress path below, not here.
      if (task.metadata.from.workspaceId === task.metadata.to.workspaceId
          && task.metadata.from.paneId && callerAddr && paneRole === null) {
        return { error: 'a2a.task.send: caller pane is not a participant of this task' };
      }
      const role = paneRole ?? (task.metadata.from.workspaceId === workspaceId ? 'user' : 'agent');
      const msg: Message = { kind: 'message', messageId: generateId('msg'), role, parts };
      store.addTaskMessage(taskId, msg);

      // Deliver the reply to the OTHER party, pinned symmetrically: a reply FROM
      // the sender (role 'user') targets the receiver's `to` anchor; a reply FROM
      // the receiver (role 'agent') targets the original sender's `from` anchor
      // (S-C2 — previously the `from` side had no anchor → active-pane fallback,
      // misrouting on a multi-agent sender). Fail CLOSED on a lost pin (no
      // active-pane fallback — could hit the wrong agent on a typo / closed pane).
      // Same-ws safety: suppress the paste when the addressed pane can't be proven
      // a non-self sibling — no anchor to pin (would fall back to the active pane =
      // the #239 loop) or it resolves to the caller's own pty (self) — so we never
      // re-enter "paste into your own prompt". The reply is still persisted +
      // teed onto the bus (pollable via a2a_task_query). Same-ws delivery is a
      // one-line NUDGE only, never a full-body paste into a sibling agent's prompt.
      if (!silent) {
        const replyingToReceiver = role === 'user';
        const targetWsId = replyingToReceiver ? task.metadata.to.workspaceId : task.metadata.from.workspaceId;
        const targetWs = store.workspaces.find((w) => w.id === targetWsId);
        if (targetWs) {
          const senderWs = store.workspaces.find((w) => w.id === workspaceId);
          const senderName = senderWs?.name ?? 'unknown';
          const sameWsTask = task.metadata.from.workspaceId === task.metadata.to.workspaceId;
          const pinAnchor = replyingToReceiver ? task.metadata.to : task.metadata.from;
          const hasAnchor = !!(pinAnchor.paneId || pinAnchor.surfaceId);
          let explicitPty: string | undefined;
          let pinnedAddressLost = false;
          if (hasAnchor) {
            const addr = resolvePaneAddress(findLeafPanes(targetWs.rootPane), pinAnchor.paneId ?? '', pinAnchor.surfaceId ?? '');
            if ('error' in addr) pinnedAddressLost = true;
            else explicitPty = addr.ptyId;
          }
          const selfLoop = !!explicitPty && !!callerPtyId && explicitPty === callerPtyId;
          const sameWsNoAnchor = sameWsTask && !hasAnchor;
          // Same-ws with an UNVERIFIED caller (no senderPtyId): we cannot tell the
          // sender pane from the receiver pane, so the ws-level role defaults to
          // 'user' and would route the nudge to `to` — which is the caller ITSELF
          // when the receiver is the one replying (self-route), and the selfLoop
          // guard can't catch it because callerPtyId is empty. Suppress, mirroring
          // decideSameWsSend's absent-senderPtyId rule. The reply is still
          // persisted + teed onto the bus (pollable via a2a_task_query).
          const sameWsUnverified = sameWsTask && !callerPtyId;
          if (!pinnedAddressLost && !sameWsNoAnchor && !selfLoop && !sameWsUnverified) {
            if (sameWsTask) {
              // Same-ws sibling: pointer-only nudge (no full-body injection).
              deliverPtyNudge(targetWs, buildA2aNudge(taskId, senderName), explicitPty);
            } else {
              const liveMeta = deliveryLiveMeta(store.surfaceAgent, explicitPty, targetWs.metadata);
              if (!silentExplicit && isLiveTuiAgent(liveMeta)) {
                deliverPtyNudge(targetWs, buildA2aNudge(taskId, senderName), explicitPty);
              } else {
                deliverPtyNotification(targetWs, senderName, message, explicitPty);
              }
            }
          }
        }
      }
      return { ok: true, taskId, silent };
    }

    // ── New task branch ──
    const to = typeof params.to === 'string' ? params.to : '';
    const title = typeof params.title === 'string' ? params.title : '';
    if (!to) return { error: 'a2a.task.send: missing "to"' };

    const sender = store.workspaces.find((w) => w.id === workspaceId);
    const fromName = sender?.name ?? `unknown-${workspaceId.substring(0, 8)}`;

    // Resolve the target workspace by id / exact name / number / substring. A
    // DUPLICATE EXACT NAME is REFUSED (ambiguous) rather than silently picking
    // whichever appears first — two same-named workspaces previously misrouted a
    // send. Number/substring stay first-match (the documented "N번"/partial
    // addressing contract).
    const targetResult = resolveWorkspaceTarget(store.workspaces, to);
    if (targetResult.kind === 'ambiguous') {
      const ids = targetResult.matches.map((w) => `"${w.name}" (${w.id})`).join(', ');
      return {
        error:
          `a2a.task.send: target "${to}" is ambiguous — ${targetResult.matches.length} ` +
          `workspaces share that name: ${ids}. Re-send addressing the workspace by ID.`,
      };
    }
    const target =
      targetResult.kind === 'resolved'
        ? store.workspaces.find((w) => w.id === targetResult.id)
        : undefined;
    if (!target) {
      const available = store.workspaces.map((w) => w.name).join(', ');
      return { error: `a2a.task.send: target "${to}" not found. Available: ${available}` };
    }
    // The same-workspace self-guard moved BELOW pane-address resolution (see
    // decideSameWsSend) so a precise sibling-pane address is honored. A same-ws
    // send is now rejected only when it has NO address (ambiguous) or resolves to
    // the sender's OWN pane (true self). Cross-ws sends are unaffected.

    // Part A — optional pane-level addressing. Resolve paneId/surfaceId to a
    // concrete pty INSIDE the target ws (cross-ws ids fail-closed: only
    // target's tree is searched). An explicit-but-invalid address is a hard
    // error — never silently fall back to the active pane (that would deliver
    // to the wrong agent on a typo).
    // Fail closed on a present-but-non-string address: coercing to '' would
    // silently drop it and fall back to active-pane delivery (wrong agent).
    if (params.paneId !== undefined && typeof params.paneId !== 'string') {
      return { error: 'a2a.task.send: "pane_id" must be a string' };
    }
    if (params.surfaceId !== undefined && typeof params.surfaceId !== 'string') {
      return { error: 'a2a.task.send: "surface_id" must be a string' };
    }
    const reqPaneId = typeof params.paneId === 'string' ? params.paneId : '';
    const reqSurfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : '';
    let resolvedAddr: PaneAddress | undefined;
    if (reqPaneId || reqSurfaceId) {
      const addr = resolvePaneAddress(findLeafPanes(target.rootPane), reqPaneId, reqSurfaceId);
      if ('error' in addr) return { error: `a2a.task.send: ${addr.error}` };
      resolvedAddr = addr;
    }

    // Same-workspace send policy (relocated self-guard + KS-1 true-self guard).
    // senderPtyId is the caller's OWN pane anchor, supplied by the MCP server on
    // a verified PID-map hit (absent on the env-hint fallback → fail closed on
    // the paste, see suppressPaste below). It is NOT an agent-settable tool param;
    // as defense-in-depth for the main-pipe/token path, only trust it if it
    // resolves to a real terminal pty in the SENDER's own workspace — a bogus /
    // foreign value is treated as ABSENT (→ silent), never as a loud-paste enabler.
    const rawSenderPtyId = typeof params.senderPtyId === 'string' ? params.senderPtyId : '';
    const senderLeaves = sender ? findLeafPanes(sender.rootPane) : [];
    const senderPtyId = isTerminalPtyInLeaves(senderLeaves, rawSenderPtyId) ? rawSenderPtyId : '';
    const sameWsDecision = decideSameWsSend(target.id === workspaceId, resolvedAddr?.ptyId, senderPtyId);
    if (sameWsDecision.kind === 'reject') return { error: `a2a.task.send: ${sameWsDecision.error}` };

    // S-C2: capture the sender's pane anchor (symmetric with `to`) so a reply can
    // return to THIS exact pane and the stored history role is computed per-pane.
    // senderPtyId is already validated against the sender's own tree above, so an
    // absent/forged value resolves to null → `from` stays ws-only (no regression).
    const senderAddr = resolveSenderPaneAddress(senderLeaves, senderPtyId);

    const initialMessage: Message = { kind: 'message', messageId: generateId('msg'), role: 'user', parts };
    const newTaskId = generateId('task');

    if (executeRequested) {
      const cwd = typeof params.cwd === 'string' ? params.cwd : null;
      const approved = await requestExecuteApproval({
        taskId: newTaskId,
        senderWorkspaceId: workspaceId,
        receiverWorkspaceId: target.id,
        messagePreview: message.slice(0, 500),
        cwd,
      });
      if (!approved) {
        return { ok: false, error: 'a2a.task.send: execute approval denied' };
      }
    }

    store.createA2aTask({
      id: newTaskId,
      title: title || message.slice(0, 100),
      from: {
        workspaceId,
        name: fromName,
        ...(senderAddr && { paneId: senderAddr.paneId, surfaceId: senderAddr.surfaceId }),
      },
      to: {
        workspaceId: target.id,
        name: target.name,
        ...(resolvedAddr && { paneId: resolvedAddr.paneId, surfaceId: resolvedAddr.surfaceId }),
      },
      history: [initialMessage],
      artifacts: [],
    });

    // Deliver message to target workspace's terminal (unless silent).
    // When silent, the task is only persisted in the store and the
    // receiver must poll via a2a_task_query to discover it. silent-default:
    // an unset silent + live-TUI receiver gets a one-line nudge (prompt not
    // flooded); no live agent (or explicit silent:false) keeps the loud paste.
    // Suppress the PTY paste when the user asked (silent) OR when a same-ws send
    // can't be proven non-self (decideSameWsSend → suppressPaste). The task is
    // still created + teed onto the EventBus below, so a sibling can poll it via
    // a2a_task_query — only the loud prompt injection is withheld.
    const suppressPaste = silent || sameWsDecision.suppressPaste;
    if (!suppressPaste) {
      const explicitPty = resolvedAddr?.ptyId;
      // Liveness for the nudge-vs-paste choice must reflect the ADDRESSED pane's
      // agent (a workspace can host >1 agent), not ws-level metadata.
      const liveMeta = deliveryLiveMeta(store.surfaceAgent, explicitPty, target.metadata);
      if (!silentExplicit && isLiveTuiAgent(liveMeta)) {
        deliverPtyNudge(target, buildA2aNudge(newTaskId, fromName), explicitPty);
      } else {
        deliverPtyNotification(target, fromName, message, explicitPty);
      }
    }

    // Tee the new task onto the EventBus (created). Read it BACK from the
    // store so the emit lands strictly AFTER createA2aTask's set() — the
    // pointer is queryable the moment a receiver follows it. createA2aTask
    // seeds status.state='submitted'.
    const createdTask = store.getTask(newTaskId);
    if (createdTask) emitA2aTaskEvent(createdTask, 'created');

    // Return the RESOLVED target workspaceId so the main-side a2a.rpc handler
    // uses it for execute:true ClaudeWorker spawn, instead of the raw fuzzy `to`
    // string (which could be a number/partial name).
    // `task`: 확정된 태스크 스냅샷(주소 해석 반영) — main이 데몬 A2aTaskService에
    // 정본 미러-생성(envelope PR4)할 때 쓰고, 파이프 호출자에게 반환하기 전에
    // main이 제거한다(응답 계약 불변).
    return { ok: true, taskId: newTaskId, silent, toWorkspaceId: target.id, executeApproved: executeRequested, task: createdTask };
  }

  if (method === 'a2a.task.query') {
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!workspaceId) return { error: 'a2a.task.query: missing "workspaceId". Ensure WMUX_WORKSPACE_ID is set.' };
    const status = typeof params.status === 'string' ? params.status as TaskState : undefined;
    const role = typeof params.role === 'string' ? params.role as 'user' | 'agent' : undefined;
    // Normalize the incremental cursor to canonical UTC ISO (new Date().toISOString())
    // so the lexicographic compare in queryTasks is sound regardless of the caller's
    // format. Without this, an offset cursor ("...+09:00") or a different ms precision
    // ("...:00Z" vs "...:00.000Z") silently mis-compares → missed/duplicate tasks. An
    // unparseable (or empty) cursor is rejected rather than silently treated as "no
    // filter". (Review A9 P2/P3.)
    let updatedSince: string | undefined;
    {
      const raw = typeof params.updatedSince === 'string' ? params.updatedSince.trim() : '';
      // Empty/whitespace = "no lower bound" = no filter (return all) — matches
      // the pre-cursor behavior + the common `updatedSince: cursor || ''` first-poll
      // idiom (review U1 P2). Only a NON-empty, unparseable cursor is an error.
      if (raw) {
        const ms = Date.parse(raw);
        if (Number.isNaN(ms)) {
          return { error: 'a2a.task.query: updatedSince must be a parseable ISO-8601 timestamp' };
        }
        updatedSince = new Date(ms).toISOString();
      }
    }
    const tasks = store.queryTasks(workspaceId, { status, role, updatedSince });
    return { workspaceId, tasks };
  }

  if (method === 'a2a.task.update') {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!taskId) return { error: 'a2a.task.update: missing "taskId"' };
    if (!workspaceId) return { error: 'a2a.task.update: missing "workspaceId". Ensure WMUX_WORKSPACE_ID is set.' };

    // ── Validate ALL inputs up front, BEFORE any store mutation ──
    // Validating the message before applying the status keeps a status+message
    // update atomic: a bad message rejects the whole call instead of leaving a
    // committed status transition behind (which would also have emitted a
    // pointer for a half-applied task).
    let nextState: TaskState | undefined;
    if (typeof params.status === 'string') {
      // Block 'canceled' — must use a2a.task.cancel instead
      if (params.status === 'canceled') {
        return { error: 'a2a.task.update: use a2a.task.cancel instead' };
      }
      // Validate status value
      const validStatuses = ['working', 'completed', 'failed', 'input-required'];
      if (!validStatuses.includes(params.status)) {
        return { error: `a2a.task.update: invalid status "${params.status}"` };
      }
      nextState = params.status as TaskState;
    }

    let message: string | undefined;
    if (typeof params.message === 'string') {
      try { message = validateMessage(params.message); } catch (e) {
        return { error: `a2a.task.update: ${e instanceof Error ? e.message : 'invalid'}` };
      }
    }

    // 완료증거(evidence)는 사람용 message와 분리된 기계용 1급 입력이다. 전이 적용
    // 전에 untrusted-wire를 정규화한다 — 실패(null)면 오염된 shape가 스토어에 닿기
    // 전에 차단한다(거부 게이트가 아니라 위생: 저장 자체가 오염이므로. recordedBy 등
    // 서버 전용 스탬프·미지 키는 normalize가 드롭한다).
    let evidence: CompletionEvidence | undefined;
    if (params.evidence !== undefined) {
      const normalized = normalizeCompletionEvidenceWire(params.evidence);
      if (!normalized) {
        return { error: 'a2a.task.update: completion_evidence_malformed: evidence must be a plain object with string summary and well-formed items' };
      }
      evidence = normalized;
    }

    // S-C2: resolve the caller's own pane ONCE, up front, so the SAME pane-level
    // decision drives BOTH the status-transition authz (P2) and the message
    // append role/delivery below — no split ws-vs-pane model across the two store
    // writes. callerAddr null (absent senderPtyId — the headless ClaudeWorker and
    // token clients inject none; or a forged/foreign value) → ws-level authz +
    // role, exactly today's behavior. This is load-bearing: the worker reports
    // working→completed with no senderPtyId, so pane-gating on `to.paneId` alone
    // would lock it out and hang every pane-addressed execute task in `working`.
    const callerWsUpdate = store.workspaces.find((w) => w.id === workspaceId);
    const callerLeavesUpdate = callerWsUpdate ? findLeafPanes(callerWsUpdate.rootPane) : [];
    const rawCallerPtyIdUpdate = typeof params.senderPtyId === 'string' ? params.senderPtyId : '';
    const callerPtyIdUpdate = isTerminalPtyInLeaves(callerLeavesUpdate, rawCallerPtyIdUpdate) ? rawCallerPtyIdUpdate : '';
    const callerAddrUpdate = resolveSenderPaneAddress(callerLeavesUpdate, callerPtyIdUpdate);

    // ── Apply the status transition ──
    // envelope PR4(§6.M C6): main이 데몬 A2aTaskService에 이미 커밋한 전이는
    // daemonCommitted 마커 + committedTask 스냅샷으로 도착한다 — 캐시는 이를
    // **재검증 없이 verbatim 적용**한다(재검증하면 데몬 force-fail 커밋을 거부해
    // split-brain). 마커가 없으면(데몬 미가용/미시드 태스크) 기존 검증 writer로 폴백.
    const committedTask =
      params.daemonCommitted === true &&
      params.committedTask && typeof params.committedTask === 'object' &&
      typeof (params.committedTask as { id?: unknown }).id === 'string'
        ? (params.committedTask as Task)
        : undefined;
    let transitioned = false;
    if (nextState) {
      if (committedTask) {
        store.applyDaemonTaskUpdate(committedTask);
        transitioned = true;
      } else {
        const result = store.updateTaskStatus(taskId, nextState, workspaceId, callerAddrUpdate, undefined, evidence);
        if (!result.ok) return { error: `a2a.task.update: ${result.error}` };
        transitioned = true;
      }
    }

    // ── Append message + deliver to the other party ──
    if (message !== undefined) {
      // Verify caller is sender or receiver of this task
      const task = store.getTask(taskId);
      if (!task) return { error: 'a2a.task.update: task not found' };
      if (task.metadata.from.workspaceId !== workspaceId && task.metadata.to.workspaceId !== workspaceId) {
        return { error: 'a2a.task.update: not authorized' };
      }
      // Per-pane role (S-C2): same model as the a2a.task.send reply branch, using
      // the callerAddr resolved above. Falls back to the ws-level role when the
      // caller's pane is unknown (preserves cross-ws behavior exactly).
      const paneRole = resolvePaneRole(task.metadata, callerAddrUpdate);
      // A fully pane-anchored same-ws task only admits its from/to panes (mirror
      // of the reply branch). A verified non-participant pane is rejected rather
      // than defaulting to the ws-level 'user' role. (A status-only update from a
      // non-participant is already rejected by updateTaskStatus's pane authz
      // above; this covers a message-only update.)
      if (task.metadata.from.workspaceId === task.metadata.to.workspaceId
          && task.metadata.from.paneId && callerAddrUpdate && paneRole === null) {
        return { error: 'a2a.task.update: caller pane is not a participant of this task' };
      }
      const role = paneRole ?? (task.metadata.from.workspaceId === workspaceId ? 'user' : 'agent');

      const parts: Part[] = [{ kind: 'text', text: message }];
      const msg: Message = { kind: 'message', messageId: generateId('msg'), role, parts };
      store.addTaskMessage(taskId, msg);

      // Deliver the update to the OTHER party, symmetric pin (mirrors the reply
      // branch): reply-from-sender → `to` anchor, reply-from-receiver → `from`
      // anchor. Fail CLOSED on a lost pin (no active-pane fallback). Same-ws is
      // suppressed unless a non-self sibling is provable (no anchor → would loop,
      // or self-pty → skip) and is delivered as a one-line NUDGE only. The update
      // is still persisted + teed onto the bus regardless, so the other pane sees
      // it via a2a_task_query.
      const replyingToReceiver = role === 'user';
      const targetWsId = replyingToReceiver ? task.metadata.to.workspaceId : task.metadata.from.workspaceId;
      const targetWs = store.workspaces.find((w) => w.id === targetWsId);
      if (targetWs) {
        const callerWs = store.workspaces.find((w) => w.id === workspaceId);
        const callerName = callerWs?.name ?? 'unknown';
        const sameWsTask = task.metadata.from.workspaceId === task.metadata.to.workspaceId;
        const pinAnchor = replyingToReceiver ? task.metadata.to : task.metadata.from;
        const hasAnchor = !!(pinAnchor.paneId || pinAnchor.surfaceId);
        let explicitPty: string | undefined;
        let pinnedAddressLost = false;
        if (hasAnchor) {
          const addr = resolvePaneAddress(findLeafPanes(targetWs.rootPane), pinAnchor.paneId ?? '', pinAnchor.surfaceId ?? '');
          if ('error' in addr) pinnedAddressLost = true;
          else explicitPty = addr.ptyId;
        }
        const selfLoop = !!explicitPty && !!callerPtyIdUpdate && explicitPty === callerPtyIdUpdate;
        const sameWsNoAnchor = sameWsTask && !hasAnchor;
        // Same-ws with an UNVERIFIED caller (no senderPtyId) → suppress: the
        // ws-level role defaults to 'user' and would self-route the nudge to the
        // caller's own pane (mirror of the reply branch + decideSameWsSend).
        const sameWsUnverified = sameWsTask && !callerPtyIdUpdate;
        if (!pinnedAddressLost && !sameWsNoAnchor && !selfLoop && !sameWsUnverified) {
          if (sameWsTask) {
            deliverPtyNudge(targetWs, buildA2aNudge(taskId, callerName), explicitPty);
          } else {
            const liveMeta = deliveryLiveMeta(store.surfaceAgent, explicitPty, targetWs.metadata);
            if (isLiveTuiAgent(liveMeta)) {
              deliverPtyNudge(targetWs, buildA2aNudge(taskId, callerName), explicitPty);
            } else {
              deliverPtyNotification(targetWs, callerName, message, explicitPty);
            }
          }
        }
      }
    }

    // ── Append artifact ──
    if (params.artifact && typeof params.artifact === 'object') {
      const artifact = params.artifact as { name?: string; parts?: Part[] };
      if (artifact.parts) {
        store.addTaskArtifact(taskId, { name: artifact.name, parts: artifact.parts });
      }
    }

    // Tee the status transition onto the bus (updated) — STATE TRANSITION ONLY,
    // and STRICTLY AFTER every store mutation above (status + message +
    // artifact). A poller that follows this pointer and calls a2a_task_query
    // then sees the FULLY-updated task, never a half-applied one missing the
    // message/artifact that landed in the same call. addTaskMessage/
    // addTaskArtifact never emit on their own (that would flood the 1024-event
    // ring), so this single status emit is the only update pointer — it MUST
    // fire last.
    if (transitioned && nextState) {
      const updatedTask = store.getTask(taskId);
      if (updatedTask) emitA2aTaskEvent(updatedTask, 'updated', nextState);
    }

    return { ok: true, taskId };
  }

  if (method === 'a2a.task.cancel') {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!taskId) return { error: 'a2a.task.cancel: missing "taskId"' };
    if (!workspaceId) return { error: 'a2a.task.cancel: missing "workspaceId". Ensure WMUX_WORKSPACE_ID is set.' };
    // envelope PR4(C6): 데몬이 이미 커밋한 취소는 verbatim 적용(재검증 없음 —
    // update 경로와 동일 계약). 마커 없으면 기존 검증 writer 폴백.
    const committedCancel =
      params.daemonCommitted === true &&
      params.committedTask && typeof params.committedTask === 'object' &&
      typeof (params.committedTask as { id?: unknown }).id === 'string'
        ? (params.committedTask as Task)
        : undefined;
    if (committedCancel) {
      store.applyDaemonTaskUpdate(committedCancel);
      const cached = store.getTask(taskId);
      if (cached) emitA2aTaskEvent(cached, 'cancelled', 'canceled');
      return { ok: true, taskId };
    }
    // Snapshot from/to BEFORE the cancel so the pointer's dual-party scope is
    // read off pre-mutation metadata (cancelTask flips status in place today,
    // but a future GC/eviction could remove the task — capture first).
    const cancelTarget = store.getTask(taskId);
    const result = store.cancelTask(taskId, workspaceId);
    if (!result.ok) return { error: `a2a.task.cancel: ${result.error}` };
    // Tee the cancellation onto the bus (cancelled), strictly AFTER the
    // store set(). State is terminal 'canceled'; reuse the pre-cancel snapshot
    // for from/to (immutable identity).
    if (cancelTarget) emitA2aTaskEvent(cancelTarget, 'cancelled', 'canceled');
    return { ok: true, taskId };
  }

  if (method === 'a2a.broadcast') {
    const rawMessage = typeof params.message === 'string' ? params.message : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!workspaceId) return { error: 'a2a.broadcast: missing "workspaceId". Ensure WMUX_WORKSPACE_ID is set.' };
    if (!rawMessage) return { error: 'a2a.broadcast: missing "message"' };
    let message: string;
    try { message = validateMessage(rawMessage); } catch (e) {
      return { error: `a2a.broadcast: ${e instanceof Error ? e.message : 'invalid'}` };
    }

    const sender = store.workspaces.find((w) => w.id === workspaceId);
    const fromName = sender?.name ?? workspaceId.substring(0, 8);

    // Deliver to all other workspaces via PTY paste
    let sent = 0;
    for (const ws of store.workspaces) {
      if (ws.id === workspaceId) continue;
      const leaves = findLeafPanes(ws.rootPane);
      for (const leaf of leaves) {
        const termSurface = leaf.surfaces.find((s) => s.surfaceType !== 'browser' && s.ptyId);
        if (termSurface) {
          const formatted = formatA2aBroadcast(fromName, message);
          submitToPty(termSurface.ptyId, formatted);
          break;
        }
      }
      sent++;
    }
    return { ok: true, sent };
  }

  if (method === 'meta.setSkills') {
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    const rawSkills = Array.isArray(params.skills) ? params.skills : [];
    if (!workspaceId) return { error: 'meta.setSkills: missing "workspaceId". Ensure WMUX_WORKSPACE_ID is set.' };
    // Accept string[] (from MCP) and convert to AgentSkill[]
    const skills: AgentSkill[] = rawSkills.map((s: unknown) =>
      typeof s === 'string' ? { id: s, name: s } : s as AgentSkill,
    );
    store.setAgentSkills(workspaceId, skills);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // company.* — Company mode handlers
  // -------------------------------------------------------------------------

  if (method.startsWith('company.')) {
    const result = await handleCompanyRpc(method, params, store);
    if (result !== null) return result;
  }

  // -------------------------------------------------------------------------
  // Unknown method
  // -------------------------------------------------------------------------

  return { error: `unknown method: ${method}` };
}

// ---------------------------------------------------------------------------
// Browser Surface helpers
// ---------------------------------------------------------------------------

/**
 * Finds the active browser Surface in the given workspace state.
 * Returns the surface's ptyId (used as a DOM element ID key) and the webview
 * element, or an error string when nothing is found.
 */
function findActiveBrowserWebview(
  store: ReturnType<typeof import('../stores').useStore.getState>,
): HTMLElement | { error: string } {
  const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
  if (!ws) return { error: 'browser: no active workspace' };

  // Walk through all leaf panes and look for a browser surface.
  function findLeaves(pane: import('../../shared/types').Pane): import('../../shared/types').PaneLeaf[] {
    if (pane.type === 'leaf') return [pane];
    return pane.children.flatMap(findLeaves);
  }

  const leaves = findLeaves(ws.rootPane);
  for (const leaf of leaves) {
    const activeSurface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
    if (activeSurface?.surfaceType === 'browser') {
      // The Pane component renders a webview with data-surface-id attribute.
      // Escape surfaceId to prevent CSS selector injection
      const safeSurfaceId = CSS.escape(activeSurface.id);
      const webview = document.querySelector<HTMLElement>(
        `webview[data-surface-id="${safeSurfaceId}"]`,
      );
      if (webview) return webview;
    }
  }

  return { error: 'browser: no active browser surface found' };
}

/**
 * Finds a specific browser Surface's webview by surfaceId.
 * Falls back to findActiveBrowserWebview if surfaceId is not provided.
 */
function findBrowserWebviewBySurfaceId(
  store: ReturnType<typeof import('../stores').useStore.getState>,
  surfaceId?: string,
): HTMLElement | { error: string } {
  if (!surfaceId) return findActiveBrowserWebview(store);

  const safeSurfaceId = CSS.escape(surfaceId);
  const webview = document.querySelector<HTMLElement>(
    `webview[data-surface-id="${safeSurfaceId}"]`,
  );
  if (webview) return webview;
  return { error: `browser: surface ${surfaceId} not found or not a browser` };
}

async function handleBrowserNavigate(
  store: ReturnType<typeof import('../stores').useStore.getState>,
  url: string,
  surfaceId?: string,
): Promise<unknown> {
  const webview = findBrowserWebviewBySurfaceId(store, surfaceId);
  if ('error' in webview) return webview;

  const wv = webview as HTMLElement & { loadURL: (url: string) => Promise<void> };
  await wv.loadURL(url);
  return { ok: true, url };
}
