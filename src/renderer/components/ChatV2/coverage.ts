// Panes whose anchor terminal is covered by the chat-v2 view. Anything that
// would type into the active pane's PTY (macros, prefix pass-through, palette
// commands, file drops) checks this first: the shell under the chat is hidden,
// so bytes sent there are input the user cannot see.
const covered = new Map<string, number>();

export function markChatV2Covering(ptyId: string): () => void {
  covered.set(ptyId, (covered.get(ptyId) ?? 0) + 1);
  return () => {
    const left = (covered.get(ptyId) ?? 1) - 1;
    if (left > 0) covered.set(ptyId, left); else covered.delete(ptyId);
  };
}

export function isChatV2Covering(ptyId: string | undefined): boolean {
  return !!ptyId && covered.has(ptyId);
}
