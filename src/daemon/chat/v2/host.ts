import { chatV2Error } from '../../../shared/chatv2/ipc';
import type { ChatV2Host, ChatV2HostDeps } from './types';

/**
 * The chat-v2 host the daemon wires in. Until the Claude driver lands this is
 * a stub: every RPC answers `not-implemented`, there are no records, and a
 * native answer for a `claude` decision is `unavailable` (nothing delivered).
 */
export function createChatV2Host(_deps: ChatV2HostDeps): ChatV2Host {
  return {
    async call(method) {
      return chatV2Error('not-implemented', `chatv2.${method} is not implemented yet.`) as never;
    },
    async answerNative() {
      return 'unavailable';
    },
    clientGone() {
      // No subscriptions to drop.
    },
    bindingForPane() {
      return null;
    },
    sessionForPane() {
      return null;
    },
    statusForPane() {
      return null;
    },
    onPush() {
      return () => {
        // Nothing was registered.
      };
    },
    async start() {
      // No driver processes to sweep.
    },
    async dispose() {
      // No driver processes to stop.
    },
  };
}
