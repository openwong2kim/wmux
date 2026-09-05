import type { StoreState } from '../index';
import { groupCapabilities } from '../../components/Approval/capabilityGrouping';

// ─── S-C2 Approval Inbox — unified pending-approval list ──────────────────────
//
// Pure derivation (mirrors selectors/fleet.ts): no daemon round-trip, no second
// copy of truth. Folds the two distinct approval sources into one render list:
//   - A2A: pending execute approvals (30s urgency → sorted FIRST).
//   - MCP: the renderer-aggregated `mcpPrompts` keyed by `mcpPromptOrder`.
//
// The discriminated union keeps the two sources structurally distinct so the
// resolve dispatcher (resolveInboxItem) can branch on `source` and NEVER share
// a collapsed resolve path (guard #3).

export type InboxItem =
  | {
      source: 'a2a';
      key: string;
      approvalId: string;
      taskId: string;
      messagePreview: string;
      expiresAt: number;
      senderWorkspaceId: string;
      receiverWorkspaceId: string;
      cwd: string | null;
    }
  | {
      source: 'mcp';
      key: string;
      promptId: string;
      clientName: string;
      declaredCapabilities: string[];
      rationale?: string;
      isCritical: boolean;
    };

/** Minimal store surface the selector reads — keeps the subscription narrow. */
export type ApprovalInboxState = Pick<
  StoreState,
  'mcpPrompts' | 'mcpPromptOrder' | 'pendingExecuteApprovals' | 'pendingExecuteApprovalOrder'
>;

export function selectApprovalInbox(state: ApprovalInboxState): InboxItem[] {
  const items: InboxItem[] = [];

  // A2A FIRST (30s urgency), oldest prompt first.
  for (const approvalId of state.pendingExecuteApprovalOrder) {
    const a2a = state.pendingExecuteApprovals[approvalId];
    if (!a2a) continue;
    items.push({
      source: 'a2a',
      key: `a2a:${a2a.approvalId}`,
      approvalId: a2a.approvalId,
      taskId: a2a.taskId,
      messagePreview: a2a.messagePreview,
      expiresAt: a2a.expiresAt,
      senderWorkspaceId: a2a.senderWorkspaceId,
      receiverWorkspaceId: a2a.receiverWorkspaceId,
      cwd: a2a.cwd,
    });
  }

  // MCP in insertion order. Skip any id missing from the record (defensive —
  // order and record are written together, but a torn intermediate state must
  // never crash the cockpit).
  for (const promptId of state.mcpPromptOrder) {
    const info = state.mcpPrompts[promptId];
    if (!info) continue;
    // isCritical drives keyboard safety (guard #5): Enter approves non-critical
    // only. Reuses the dialog's pure grouping fn so the classification matches
    // exactly what the prompt would render.
    const isCritical = groupCapabilities(info.declaredCapabilities).some(
      (g) => g.copy.severity === 'critical',
    );
    items.push({
      source: 'mcp',
      key: `mcp:${info.promptId}`,
      promptId: info.promptId,
      clientName: info.clientName,
      declaredCapabilities: info.declaredCapabilities,
      rationale: info.rationale,
      isCritical,
    });
  }

  return items;
}

/**
 * Is the Fleet cockpit's Approvals tab the surface that owns the pending
 * approvals right now?
 *
 * DESIGN.md attention grammar: one event, at most TWO renditions. An approval
 * had three — the dialog, the deck header's countdown badge, and the Fleet
 * inbox's own countdown. This is the single signal both suppressors read: the
 * standalone A2A / MCP dialogs (AppLayout) and the deck header badge
 * (DeckApprovalCountdown). Two callers, one rule — the alternative is two
 * copies of it drifting apart.
 */
export function selectInboxOwnsApprovals(
  state: Pick<StoreState, 'fleetViewVisible' | 'fleetActiveTab'>,
  scope?: {
    /** The surface's workspace. Absent ⇒ the caller speaks for every prompt
     *  (the standalone dialogs), and the open tab owns all of them. */
    workspaceId?: string;
    /** Workspaces the inbox is actually listing a row for. */
    listedWorkspaceIds: readonly string[];
  },
): boolean {
  if (!state.fleetViewVisible || state.fleetActiveTab !== 'approvals') return false;
  if (!scope || !scope.workspaceId) return true;
  // An open tab that lists nothing for THIS workspace has not taken over its
  // prompt, and stepping aside for it would leave the operator with no
  // countdown anywhere.
  return scope.listedWorkspaceIds.includes(scope.workspaceId);
}

/**
 * The workspaces the approval inbox draws a row for. Only the A2A execute
 * approvals carry a workspace — an MCP prompt is a client asking for
 * capabilities and belongs to no deck — so an inbox of MCP prompts alone
 * suppresses nobody's badge.
 */
export function selectInboxWorkspaceIds(
  state: Pick<StoreState, 'pendingExecuteApprovals' | 'pendingExecuteApprovalOrder'>,
): string[] {
  const out: string[] = [];
  for (const id of state.pendingExecuteApprovalOrder) {
    const record = state.pendingExecuteApprovals[id];
    if (!record) continue;
    if (record.senderWorkspaceId) out.push(record.senderWorkspaceId);
    if (record.receiverWorkspaceId) out.push(record.receiverWorkspaceId);
  }
  return out;
}
