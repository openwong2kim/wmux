// Store-wired container for the Phase 2.2 permission approval dialog
// (pre-commit 6).
//
// Subscribes to the `permissionPrompt.onOpen` IPC channel exposed by
// preload.ts. When the main process fires a prompt, the container holds
// the latest info in local state and renders the dialog. Clicking Approve
// or Deny calls `permissionPrompt.resolve(promptId, approved)` and clears
// the local state. Local state is intentional — there's only ever one
// permission prompt visible at a time, and the ApprovalQueue's dedupe
// guarantees no two prompts share a key.

import { useEffect, useState } from 'react';
import { PermissionApprovalDialogView } from './PermissionApprovalDialog';

interface PromptInfo {
  promptId: string;
  clientName: string;
  declaredCapabilities: string[];
  rationale?: string;
}

export default function PermissionApprovalDialogContainer() {
  const [pending, setPending] = useState<PromptInfo | null>(null);

  useEffect(() => {
    const api = window.electronAPI.permissionPrompt;
    if (!api) return; // preload may not expose this in older bundles
    const off = api.onOpen((info) => {
      setPending(info);
    });
    return off;
  }, []);

  if (!pending) return null;

  const respond = async (approved: boolean) => {
    const api = window.electronAPI.permissionPrompt;
    if (!api) {
      setPending(null);
      return;
    }
    try {
      await api.resolve(pending.promptId, approved);
    } catch {
      /* main-side error is non-fatal; UX-wise we still close the dialog */
    }
    setPending(null);
  };

  return (
    <PermissionApprovalDialogView
      clientName={pending.clientName}
      declaredCapabilities={pending.declaredCapabilities}
      rationale={pending.rationale}
      onApprove={() => void respond(true)}
      onDeny={() => void respond(false)}
    />
  );
}
