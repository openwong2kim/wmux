// Which pane-bound Chrome profiles the phone preview may show for a workspace
// (PhoneBrowserChrome): every tab of such a profile, the ones another CDP
// client or a person opened included. A profile qualifies only when it is
// bound to exactly one pane, that pane lives in this workspace, no workspace
// is bound to it, and no browser policy applies to it. A protected pane's
// policy rides on that pane's own calls, which the phone's CDP would skip.

import type { ChromePaneBindings } from '../../shared/chromePaneBinding';
import { DEFAULT_CHROME_PROFILE, LIVE_CHROME_PROFILE } from '../browser-session/ChromeProfileStore';

export interface PhonePaneProfiles {
  /** The qualifying profiles. */
  profiles: string[];
  /** A pane bound in this workspace whose workspace the layout does not tell yet (no PTY, or no layout). */
  unknown: boolean;
}

export interface PhonePaneProfileSources {
  paneBindings(): ChromePaneBindings;
  /** workspaceId → profile. */
  workspaceBindings(): Record<string, string>;
  /** paneId → workspace, from the live layout; null while it is not known. */
  paneWorkspaces(): ReadonlyMap<string, string> | null;
  /** Whether the layout came from the restored session (its workspace ids are the ones on disk). */
  sessionRestored(): boolean;
  /** Whether any browser policy applies to the profile (protected, refused or unconfirmed). */
  isProtected(profile: string): boolean;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function phonePaneProfiles(workspaceId: string, src: PhonePaneProfileSources): PhonePaneProfiles {
  const panes = Object.entries(src.paneBindings());
  const mine = panes.filter(([, b]) => b.workspaceId === workspaceId);
  if (mine.length === 0) return { profiles: [], unknown: false };
  const workspaceBound = Object.values(src.workspaceBindings());
  const where = src.sessionRestored() ? src.paneWorkspaces() : null;
  const profiles: string[] = [];
  let unknown = false;
  for (const [paneId, { profile }] of mine) {
    if (same(profile, DEFAULT_CHROME_PROFILE) || same(profile, LIVE_CHROME_PROFILE)) continue;
    if (panes.filter(([, b]) => same(b.profile, profile)).length !== 1) continue;
    if (workspaceBound.some((p) => same(p, profile))) continue;
    let guarded = true;
    try {
      guarded = src.isProtected(profile);
    } catch {
      // A question that cannot be answered reads as protected.
    }
    if (guarded) continue;
    // The binding names the workspace the pane was in; the layout says where it is now.
    const at = where?.get(paneId);
    if (at === undefined) {
      unknown = true;
      continue;
    }
    if (at === workspaceId) profiles.push(profile);
  }
  return { profiles, unknown };
}
