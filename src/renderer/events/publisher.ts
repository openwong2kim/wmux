// === Renderer-side EventBus publisher ===
//
// Thin shim around the preload IPC channel. Slice methods call these helpers
// inside their state mutations so external tooling can poll the EventBus on
// main and see pane lifecycle. Failures are swallowed — telemetry never
// breaks a state mutation.
//
// NOTE on `pane.metadata.changed`: There is intentionally no renderer-side
// publisher for this event. As of v2.9.0 (M0-d) the renderer no longer owns
// the metadata write path; `MetadataStore` (main process) is the sole writer
// and emits `pane.metadata.changed` directly on the main-process EventBus
// from inside its synchronous critical section. A renderer publisher would
// race the store's own emit and could surface stale `version` values to
// subscribers. If you need to react to metadata changes, poll the EventBus
// or rely on `pane.list` reconciliation.

import type { WorkspaceMetadata, TaskState } from '../../shared/types';
import type { WmuxEventType } from '../../shared/events';

interface ElectronEventsAPI {
  publish: (input: { type: string; workspaceId: string; [k: string]: unknown }) => void;
}

interface ElectronAPIMaybe {
  events?: ElectronEventsAPI;
}

declare const window: { electronAPI?: ElectronAPIMaybe } & Window;

function publish(input: { type: WmuxEventType; workspaceId: string; [k: string]: unknown }): void {
  try {
    const api = (typeof window !== 'undefined' ? window.electronAPI : undefined)?.events;
    api?.publish?.(input);
  } catch {
    // Swallow — never let publish failure surface into the state mutation.
  }
}

export function publishPaneCreated(workspaceId: string, paneId: string, parentBranchId?: string): void {
  publish({ type: 'pane.created', workspaceId, paneId, ...(parentBranchId ? { parentBranchId } : {}) });
}

export function publishPaneClosed(workspaceId: string, paneId: string): void {
  publish({ type: 'pane.closed', workspaceId, paneId });
}

export function publishPaneFocused(workspaceId: string, paneId: string, previousPaneId?: string): void {
  publish({ type: 'pane.focused', workspaceId, paneId, ...(previousPaneId ? { previousPaneId } : {}) });
}

/**
 * #977 — the pane left the layout but NOT the workspace, and its session is
 * still running. `docs/api/stability.md` documents pane.list + events.poll as a
 * complete recovery path, so a structural transition that never reaches the
 * stream would silently break that promise: a poller would see the pane vanish
 * from the default list with no event explaining why.
 */
export function publishPaneStashed(workspaceId: string, paneId: string): void {
  publish({ type: 'pane.stashed', workspaceId, paneId });
}

/** The pane is back in the layout. Paired with {@link publishPaneStashed}. */
export function publishPaneUnstashed(workspaceId: string, paneId: string): void {
  publish({ type: 'pane.unstashed', workspaceId, paneId });
}

export function publishWorkspaceMetadataChanged(
  workspaceId: string,
  metadata: WorkspaceMetadata,
  patch: Partial<WorkspaceMetadata>,
): void {
  publish({ type: 'workspace.metadata.changed', workspaceId, metadata, patch });
}

/**
 * A2A (agent-to-agent) task lifecycle tee. A dual-party event: it carries
 * explicit `from` (sender) + `to` (receiver) workspaceIds, and the base
 * `workspaceId` is ALWAYS stamped === `from` (fail-safe scoping — see the
 * A2aTaskEvent doc in shared/events.ts and the dual-party post-filter in
 * events.rpc.ts). The event is a POINTER: by default it carries no
 * `messagePreview` (the party fetches the body via a2a_task_query). The
 * preview param is accepted but only attached when explicitly provided.
 *
 * The publish trust boundary (registerHandlers.ts) re-stamps workspaceId=from
 * and allow-lists the shape server-side, so a renderer-supplied workspaceId
 * that disagrees with `from` can never broaden scope. Emitting `from` as the
 * base here keeps the two in agreement on the happy path.
 *
 * `verifiedItemCount` (§6.M PR-C): count of verified completion-evidence items,
 * attached on completed/failed transitions only. `0` is a meaningful signal
 * (unverified completion), so it is included when present — the guard is
 * `!== undefined`, NOT truthiness (same pattern as messagePreview).
 */
export function publishA2aTask(
  from: string,
  to: string,
  taskId: string,
  state: TaskState,
  kind: 'created' | 'updated' | 'cancelled',
  messagePreview?: string,
  verifiedItemCount?: number,
): void {
  publish({
    type: 'a2a.task',
    workspaceId: from, // base scope === sender (fail-safe invariant)
    from,
    to,
    taskId,
    state,
    kind,
    // Pointer-only by default: only include the preview when a caller
    // explicitly opts in. Omitted otherwise so the body never rides a bare
    // events.subscribe poll.
    ...(messagePreview !== undefined ? { messagePreview } : {}),
    // Grade pointer, not body: 0 = unverified completion (distinct from absent
    // on created/cancelled) so `!== undefined` includes an honest 0.
    ...(verifiedItemCount !== undefined ? { verifiedItemCount } : {}),
  });
}
