import type { StoreState } from '../index';
import { groupCapabilities } from '../../components/Approval/capabilityGrouping';

// ─── S-C2 Approval Inbox — unified pending-approval list ──────────────────────
//
// Pure derivation (mirrors selectors/fleet.ts): no daemon round-trip, no second
// copy of truth. Folds the two distinct approval sources into one render list:
//   - A2A: the 0-or-1 `pendingExecuteApproval` (a parked main Promise awaiting
//     the user's execute decision; 30s urgency → sorted FIRST).
//   - MCP: the renderer-aggregated `mcpPrompts` keyed by `mcpPromptOrder`.
//
// The discriminated union keeps the two sources structurally distinct so the
// resolve dispatcher (resolveInboxItem) can branch on `source` and NEVER share
// a collapsed resolve path (guard #3).

export type InboxItem =
  | {
      source: 'a2a';
      key: string;
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
  'mcpPrompts' | 'mcpPromptOrder' | 'pendingExecuteApproval'
>;

export function selectApprovalInbox(state: ApprovalInboxState): InboxItem[] {
  const items: InboxItem[] = [];

  // A2A FIRST (30s urgency). 0-or-1 — pendingExecuteApproval is a single slot.
  const a2a = state.pendingExecuteApproval;
  if (a2a) {
    items.push({
      source: 'a2a',
      key: `a2a:${a2a.taskId}`,
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
