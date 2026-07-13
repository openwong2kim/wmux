// ─── Command Deck — global auto-wake switch (event-push kill switch) ─────────
//
// The event-push coalescer wakes a workspace's brain on pane lifecycle events
// (agent.stop / agent.awaiting_input) — each wake is a real SDK turn that
// costs tokens. This store is the ONE global off switch for those ambient
// wakes (owner request 2026-07-13: unrequested summary turns burn tokens).
//
// Scope contract (enforced in CommanderEventCoalescer.attemptFlush):
//   - OFF suppresses AMBIENT wakes only. A RUNNING loop still wakes — a loop
//     is an explicit user opt-in whose iteration budget already bounds it,
//     and silently starving it would break the loop feature.
//   - Schedules are untouched (explicit user requests, different plumbing).
//
// Default is ON (missing/corrupt file → enabled): this preserves the shipped
// behavior; the toggle exists to opt OUT. Same storage shape as
// deck-autonomy.json (atomic JSON in the wmux data dir, WMUX_DATA_SUFFIX
// isolated), and the same never-throw posture.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';

export const DEFAULT_AUTO_WAKE_ENABLED = true;

export function getDeckAutoWakePath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-autowake.json');
}

/** Read the global switch. Anything uncertain (missing file, torn JSON, wrong
 *  shape) resolves to the default (enabled). Never throws. */
export function loadAutoWakeEnabled(dir?: string): boolean {
  try {
    const raw = atomicReadJSONSync<unknown>(getDeckAutoWakePath(dir));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return DEFAULT_AUTO_WAKE_ENABLED;
    }
    const enabled = (raw as Record<string, unknown>).enabled;
    return typeof enabled === 'boolean' ? enabled : DEFAULT_AUTO_WAKE_ENABLED;
  } catch {
    return DEFAULT_AUTO_WAKE_ENABLED;
  }
}

/** Persist the global switch. Returns the value now in force. */
export async function setAutoWakeEnabled(enabled: boolean, dir?: string): Promise<boolean> {
  const next = enabled === true;
  await atomicWriteJSON(getDeckAutoWakePath(dir), { enabled: next });
  return next;
}
