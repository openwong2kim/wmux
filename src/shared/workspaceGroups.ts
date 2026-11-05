// === Workspace groups ===
// Named, collapsible headers in the sidebar that the user files workspaces
// under (#3069). A group is DISPLAY-ONLY: it changes where a row is listed and
// nothing else. Sessions, agents, settle / snooze and the stored workspace
// order are untouched, so a settled workspace still goes to Settled and comes
// back under its group when it un-settles.
//
// Storage: each workspace carries an optional `groupId` (persisted with the
// workspace, like `color`), and the session holds the list of groups in the
// order they are shown. session.json is user-editable and may come from a
// newer build, so everything read from it passes through the normalizers
// below, which drop what they cannot use instead of failing the load.

export interface WorkspaceGroup {
  id: string;
  /** User-chosen label, trimmed, 1..WORKSPACE_GROUP_NAME_MAX chars. */
  name: string;
  /** Folded in the sidebar. Absent = expanded. */
  collapsed?: boolean;
}

export const WORKSPACE_GROUP_NAME_MAX = 64;
/** Ids are generated (`generateId('grp')`); anything longer is not ours. */
export const WORKSPACE_GROUP_ID_MAX = 64;
/** A sanity cap for a hand-edited file, far above any real sidebar. */
export const WORKSPACE_GROUPS_MAX = 200;

/** The name as stored, or null when nothing usable is left. */
export function normalizeWorkspaceGroupName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // One line: a pasted newline or tab would break the one-row header.
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, WORKSPACE_GROUP_NAME_MAX).trim();
  return name.length > 0 ? name : null;
}

function isGroupId(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= WORKSPACE_GROUP_ID_MAX;
}

/**
 * The groups as loaded: well-formed entries only, each id once (first wins),
 * order kept. `collapsed` is kept only when it is exactly `true`.
 */
export function normalizeWorkspaceGroups(raw: unknown): WorkspaceGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkspaceGroup[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= WORKSPACE_GROUPS_MAX) break;
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, collapsed } = entry as Record<string, unknown>;
    if (!isGroupId(id) || seen.has(id)) continue;
    const label = normalizeWorkspaceGroupName(name);
    if (!label) continue;
    seen.add(id);
    out.push({ id, name: label, ...(collapsed === true ? { collapsed: true } : {}) });
  }
  return out;
}

/** The workspace's group id if that group exists, else undefined. */
export function resolveWorkspaceGroupId(raw: unknown, groupIds: ReadonlySet<string>): string | undefined {
  return isGroupId(raw) && groupIds.has(raw) ? raw : undefined;
}
