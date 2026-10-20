// Session records the daemon keeps on disk without managing them: the ones
// recovery left untouched (a session the recovery cap excluded, a record not
// recovered this boot). They are written back by every save until a later
// launch recovers them or the suspended TTL prunes them on load (#2493).
//
// The periodic snapshot keeps them by merging what is on disk; every other
// save writes only the managed sessions, so before this the first such save
// (a cwd change, a create, a close) erased them for good.

import type { DaemonSession } from './types';

/** The managed sessions, authoritative for their ids, then every disk-only record no managed session has taken. */
export function withDiskOnlySessions(managed: DaemonSession[], diskOnly: readonly DaemonSession[]): DaemonSession[] {
  if (diskOnly.length === 0) return managed;
  const ids = new Set(managed.map((s) => s.id));
  return [...managed, ...diskOnly.filter((s) => !ids.has(s.id))];
}
