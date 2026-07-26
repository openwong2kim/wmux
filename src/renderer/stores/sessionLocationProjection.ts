import {
  isSessionLocationSnapshotNewer,
  type SessionLocationSnapshot,
} from '../../shared/sessionLocation';

const snapshots = new Map<string, SessionLocationSnapshot>();

export function rememberSessionLocation(
  ptyId: string,
  snapshot: SessionLocationSnapshot,
): boolean {
  const current = snapshots.get(ptyId);
  if (!isSessionLocationSnapshotNewer(snapshot, current)) return false;
  snapshots.set(ptyId, snapshot);
  return true;
}

export function getRememberedSessionLocation(
  ptyId: string,
): SessionLocationSnapshot | undefined {
  return snapshots.get(ptyId);
}

export function forgetSessionLocation(ptyId: string): void {
  snapshots.delete(ptyId);
}

export function resetSessionLocationProjections(): void {
  snapshots.clear();
}
