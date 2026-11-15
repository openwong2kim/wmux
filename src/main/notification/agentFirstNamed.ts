/**
 * A pane's agent named for the first time, as the metadata broadcast records
 * it (metadata.handler.ts broadcastMetadataUpdate): a name arrives while none
 * was recorded for the PTY. Repeated broadcasts of a known name do not count;
 * a name cleared (or the PTY torn down) and given again does. Kept apart from
 * the handler so a subscriber does not import it.
 */

const listeners = new Set<(ptyId: string) => void>();

/** Calls `listener` once for each first naming. Returns the unsubscribe. */
export function onAgentFirstNamed(listener: (ptyId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyAgentFirstNamed(ptyId: string): void {
  for (const listener of listeners) {
    try {
      listener(ptyId);
    } catch {
      // One listener's failure never stops the broadcast or the others.
    }
  }
}

const unnamedListeners = new Set<(ptyId: string) => void>();

/**
 * Calls `listener` when a PTY's record is dropped (pane teardown, session
 * end): a later name there is a new agent. Not on an idle broadcast that
 * clears the name only. Returns the unsubscribe.
 */
export function onAgentRecordDropped(listener: (ptyId: string) => void): () => void {
  unnamedListeners.add(listener);
  return () => { unnamedListeners.delete(listener); };
}

export function notifyAgentRecordDropped(ptyId: string): void {
  for (const listener of unnamedListeners) {
    try {
      listener(ptyId);
    } catch {
      // One listener's failure never stops the teardown or the others.
    }
  }
}
