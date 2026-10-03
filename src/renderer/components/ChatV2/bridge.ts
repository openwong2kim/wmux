import type { ChatV2BridgeApi } from '../../../shared/chatv2/ipc';

// One accessor for the chat-v2 bridge, so tests (and a dev instance before the
// daemon host lands) can drive the view with a host that follows the contract.
let override: ChatV2BridgeApi | null = null;

export function getChatV2Bridge(): ChatV2BridgeApi | null {
  return override ?? (typeof window !== 'undefined' ? window.electronAPI?.chatv2 ?? null : null);
}

export function setChatV2BridgeForTests(bridge: ChatV2BridgeApi | null): void {
  override = bridge;
}
