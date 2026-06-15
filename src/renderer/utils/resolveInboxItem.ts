import type { InboxItem } from '../stores/selectors/approvalInbox';
import { useStore } from '../stores';
import { resolveExecuteApproval } from './executeApproval';

// ─── S-C2 Approval Inbox — per-source resolve dispatcher ──────────────────────
//
// Guard #3: TWO fully distinct resolve paths, never collapsed into one. The
// switch on `item.source` is the only place the two surfaces meet, and each arm
// settles its own world:
//
//   - mcp → ack the main process via permissionPrompt.resolve(promptId,
//     approved), then optimistically remove the row locally. Both removals are
//     idempotent: the authoritative cross-surface removal is the
//     PERMISSION_PROMPT_CLOSED push the main process emits from inside
//     resolvePrompt/cancelPrompt, so an early local removal + a later push is
//     harmless.
//
//   - a2a → resolveExecuteApproval(approved). Its settle() nulls
//     pendingExecuteApproval, clears the 30s timer, and resolves the parked main
//     Promise. We must NEVER call setPendingExecuteApproval(null) directly here:
//     that would clear the renderer slot while orphaning the main Promise, which
//     would then time out into a silent auto-deny.
export function resolveInboxItem(item: InboxItem, approved: boolean): void {
  switch (item.source) {
    case 'mcp': {
      void window.electronAPI.permissionPrompt?.resolve(item.promptId, approved);
      useStore.getState().removeMcpPrompt(item.promptId);
      return;
    }
    case 'a2a': {
      resolveExecuteApproval(approved);
      return;
    }
  }
}
