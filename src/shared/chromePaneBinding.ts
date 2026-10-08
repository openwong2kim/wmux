// Per-pane Chrome profile bindings — the contract shared by main (store +
// resolution), the MCP client (envelope stamp) and the renderer (pane menu).
//
// A workspace binding gives every pane in a workspace one Chrome (one set of
// logins). A pane binding narrows that to one pane: the pane's agent drives a
// Chrome of its own, so two panes in one workspace can be signed into two
// different accounts. Like the workspace binding it is a USER action, never an
// agent-selectable parameter — the binding itself is the authorization.

/** One pane's binding. `workspaceId` is the workspace the pane lived in when
 *  bound; a lookup from any other workspace ignores the binding. */
export interface ChromePaneBinding {
  workspaceId: string;
  profile: string;
}

/** paneId → binding. Persisted in chrome-profiles.json (schema v2). */
export type ChromePaneBindings = Record<string, ChromePaneBinding>;

/** `browser:chrome-profiles:list` reply. `paneBindings` is absent from an old main. */
export interface ChromeProfilesListResult {
  profiles: string[];
  bindings: Record<string, string>;
  paneBindings?: ChromePaneBindings;
}

/**
 * Error code main throws when the caller's workspace HAS pane bindings but the
 * caller's pane cannot be resolved (no callerPtyId, or a PTY no pane owns).
 * Fail closed: falling back to the workspace profile would act — post, buy,
 * message — as a different account than the pane was bound to.
 */
export const PANE_PROFILE_UNRESOLVED_CODE = 'PANE_PROFILE_UNRESOLVED';

/** IPC channels (renderer → main). Replies are `{ ok: boolean; error?: string }`. */
export const CHROME_PANE_IPC = {
  /** payload `{ paneId, workspaceId, profileName: string | null }` (null unbinds). */
  bind: 'browser:chrome-profiles:bind-pane',
  /** payload `{ paneId, workspaceId }` — bring that pane's newest Chrome tab to the front. */
  reveal: 'browser:chrome-profiles:reveal-pane',
} as const;
