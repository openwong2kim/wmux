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
import { findLeaf } from '../../../shared/paneUtils';
import { leafDisplayName } from '../../utils/paneNaming';

export default function PermissionApprovalDialogContainer() {
  const order = useStore((s) => s.mcpPromptOrder);
  const prompts = useStore((s) => s.mcpPrompts);

  // Latest declared prompt is the one to surface (insertion-ordered). The
  // ApprovalQueue dedupe guarantees one prompt per promptId, and there is only
  // ever one modal on screen at a time.
  const latest = order[order.length - 1];
  const pending = latest ? prompts[latest] : null;
  const action = pending?.kind === 'browser-action' ? pending.browserAction : undefined;
  // The pane's name as its header shows it; main only knows its id.
  const paneName = useStore((s) => {
    if (!action) return undefined;
    const ws = s.workspaces.find((w) => w.id === action.workspaceId);
    const leaf = ws ? findLeaf(ws.rootPane, action.paneId) : null;
    return ws && leaf ? leafDisplayName(s.paneLabel, ws, leaf) : undefined;
  });

  if (!pending) return null;

  const respond = (approved: boolean, remember = false) => {
    // `remember` is sent only when set, so every other prompt resolves as before.
    if (remember) void window.electronAPI.permissionPrompt?.resolve(pending.promptId, approved, { remember: true });
    else void window.electronAPI.permissionPrompt?.resolve(pending.promptId, approved);
    useStore.getState().removeMcpPrompt(pending.promptId);
  };

  return (
    // Keyed by prompt: the next queued prompt mounts fresh, so nothing the
    // previous one had focused can answer it.
    <PermissionApprovalDialogView
      key={pending.promptId}
      clientName={pending.clientName}
      declaredCapabilities={pending.declaredCapabilities}
      rationale={pending.rationale}
      {...(pending.title !== undefined && { title: pending.title })}
      {...(pending.kind !== undefined && { kind: pending.kind })}
      {...(action && { browserAction: action, onApproveAlways: () => respond(true, true) })}
      {...(paneName !== undefined && { paneName })}
      onApprove={() => respond(true)}
      onDeny={() => respond(false)}
    />
  );
}
