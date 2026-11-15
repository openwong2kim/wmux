/**
 * The key path's "draft in the composer" flag, checked against the screen.
 *
 * DaemonPTYBridge marks a draft on any printable input and clears it only on a
 * submit or Ctrl+C / Ctrl+U, so a draft erased with Backspace (or a `!` mode
 * left with Backspace) stays marked, and every delivery that waits for the
 * person to stop typing is held. The screen is the ground truth here, and only
 * ever in one direction: an empty plain prompt, drawn now (the cursor on the
 * composer's own rows), clears the mark; nothing on screen ever sets it.
 *
 * Only for an agent whose composer and cursor wmux has measured (the screen
 * tier's agents); any other keeps the key path's answer. A frame read at most
 * once per pane per DRAFT_SCREEN_READ_MIN_MS, and only while the mark is set.
 */

import type { AgentSlug } from '../shared/events';
import { cursorInComposer, hasPlainPrompt, readComposer, type DeliveryFrame } from './deliveryComposer';
import { SCREEN_TIER_AGENTS } from './deliveryPresence';

export const DRAFT_SCREEN_READ_MIN_MS = 1_000;

export interface DraftScreenBridge {
  hasDraft(): boolean;
  getKeyInputRevision(): number;
  /** Clears the mark unless a key arrived since `keyRevision` was read. */
  clearDraftIfUnchanged(keyRevision: number): boolean;
}

export interface DraftScreenDeps {
  bridge: (sessionId: string) => DraftScreenBridge | undefined;
  /** The agent the pane runs, as the daemon names it. */
  slug: (sessionId: string) => AgentSlug | undefined;
  frame: (sessionId: string) => Promise<DeliveryFrame | null>;
  now?: () => number;
}

/** Whether the pane holds a draft, after the screen had its say. */
export type DraftCheck = (sessionId: string) => Promise<boolean>;

export function draftScreenCheck(deps: DraftScreenDeps): DraftCheck {
  const now = deps.now ?? Date.now;
  const lastRead = new Map<string, number>();
  const inflight = new Map<string, Promise<boolean>>();
  return async (sessionId) => {
    const bridge = deps.bridge(sessionId);
    if (!bridge?.hasDraft()) {
      lastRead.delete(sessionId);
      return false;
    }
    const slug = deps.slug(sessionId);
    if (!slug || !hasPlainPrompt(slug) || !SCREEN_TIER_AGENTS.has(slug)) return true;
    const running = inflight.get(sessionId);
    if (running) return running;
    const at = now();
    const last = lastRead.get(sessionId);
    if (last !== undefined && at - last < DRAFT_SCREEN_READ_MIN_MS) return true;
    lastRead.set(sessionId, at);
    const check = (async () => {
      // Read before the frame: a key typed while it is read keeps the mark.
      const keyRevision = bridge.getKeyInputRevision();
      const frame = await deps.frame(sessionId).catch(() => null);
      if (!frame) return bridge.hasDraft();
      const read = readComposer(frame, slug, 'paste');
      if (read.verdict === 'plain' && cursorInComposer(frame, read) && bridge.clearDraftIfUnchanged(keyRevision)) return false;
      return bridge.hasDraft();
    })().finally(() => inflight.delete(sessionId));
    inflight.set(sessionId, check);
    return check;
  };
}
