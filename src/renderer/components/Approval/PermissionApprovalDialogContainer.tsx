// Store-wired container for the Phase 2.2 permission approval dialog
// (pre-commit 6; S-C2 refactor).
//
// Guard #2 (decisions.md): this container is NO LONGER an `onOpen` consumer.
// The SINGLE owner of permissionPrompt.onOpen/onClosed is now the
// useApprovalInboxBridge hook (mounted once in AppLayout, always-on). This
// container reads the latest MCP prompt directly from the approvalInbox slice
// and renders it as the single modal — preserving the original pluginHost
// deadlock-break UX (the modal still appears for any prompt whenever this
// component is mounted, except while the Approvals tab owns the surface; see
// AppLayout delta 5).
//
// Resolve is the inline mcp arm: ack the main process + optimistically remove
// the row locally (both idempotent — the PERMISSION_PROMPT_CLOSED push is the
// authoritative cross-surface removal). This is behavior-identical to
// resolveInboxItem's mcp branch, without constructing a synthetic InboxItem.

import { useStore } from '../../stores';
import { PermissionApprovalDialogView } from './PermissionApprovalDialog';

export default function PermissionApprovalDialogContainer() {
  const order = useStore((s) => s.mcpPromptOrder);
  const prompts = useStore((s) => s.mcpPrompts);

  // Latest declared prompt is the one to surface (insertion-ordered). The
  // ApprovalQueue dedupe guarantees one prompt per promptId, and there is only
  // ever one modal on screen at a time.
  const latest = order[order.length - 1];
  const pending = latest ? prompts[latest] : null;

  if (!pending) return null;

  const respond = (approved: boolean) => {
    void window.electronAPI.permissionPrompt?.resolve(pending.promptId, approved);
    useStore.getState().removeMcpPrompt(pending.promptId);
  };

  return (
    <PermissionApprovalDialogView
      clientName={pending.clientName}
      declaredCapabilities={pending.declaredCapabilities}
      rationale={pending.rationale}
      onApprove={() => respond(true)}
      onDeny={() => respond(false)}
    />
  );
}
