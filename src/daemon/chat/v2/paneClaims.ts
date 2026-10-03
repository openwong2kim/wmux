/**
 * Panes that hold a chat-v2 record. The chat-v2 host is the only writer; the
 * older managed-chat service reads it so its `respond` can never answer a
 * request on a pane whose decisions belong to a chat-v2 driver (those go
 * through the ApprovalRegistry and nothing else).
 */
const claimed = new Set<string>();

export function claimChatV2Pane(paneId: string): void {
  claimed.add(paneId);
}

export function releaseChatV2Pane(paneId: string): void {
  claimed.delete(paneId);
}

export function chatV2OwnsPane(paneId: string): boolean {
  return claimed.has(paneId);
}
