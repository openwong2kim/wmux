// Session records the daemon keeps on disk without managing them: the ones
// recovery left untouched (a session the recovery cap excluded, a record not
// recovered this boot). They are written back by every save until a later
// launch recovers them or the suspended TTL prunes them on load (#2493).
//
// The periodic snapshot keeps them by merging what is on disk; every other
// save writes only the managed sessions, so before this the first such save
// (a cwd change, a create, a close) erased them for good.

import type { DaemonSession } from './types';

/**
 * The disk-only records the manager has not taken: one it adopted (a promoted
 * pane, a recreated id) is its own from then on, so a later close or TTL reap
 * of it is never undone by the old record.
 */
export function retireAdopted(managed: readonly DaemonSession[], diskOnly: DaemonSession[]): DaemonSession[] {
  if (diskOnly.length === 0) return diskOnly;
  const ids = new Set(managed.map((s) => s.id));
  return diskOnly.some((s) => ids.has(s.id)) ? diskOnly.filter((s) => !ids.has(s.id)) : diskOnly;
}

/** The managed sessions, authoritative for their ids, then every disk-only record no managed session has taken. */
export function withDiskOnlySessions(managed: DaemonSession[], diskOnly: readonly DaemonSession[]): DaemonSession[] {
  if (diskOnly.length === 0) return managed;
  const ids = new Set(managed.map((s) => s.id));
  return [...managed, ...diskOnly.filter((s) => !ids.has(s.id))];
}
