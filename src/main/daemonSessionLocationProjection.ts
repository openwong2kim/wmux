import {
  isSessionLocationSnapshotNewer,
  type SessionLocationSnapshot,
} from '../shared/sessionLocation';

export class DaemonSessionLocationProjection {
  private readonly snapshots = new Map<string, SessionLocationSnapshot>();

  accept(sessionId: string, snapshot: SessionLocationSnapshot): boolean {
    const current = this.snapshots.get(sessionId);
    if (!isSessionLocationSnapshotNewer(snapshot, current)) return false;
    this.snapshots.set(sessionId, snapshot);
    return true;
  }

  get(sessionId: string): SessionLocationSnapshot | undefined {
    return this.snapshots.get(sessionId);
  }

  forget(sessionId: string): void {
    this.snapshots.delete(sessionId);
  }

  reset(): void {
    this.snapshots.clear();
  }
}
