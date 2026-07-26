import {
  isSessionLocationSnapshotNewer,
  type SessionLocationSnapshot,
} from '../shared/sessionLocation';

export class DaemonSessionLocationProjection {
  private readonly snapshots = new Map<string, SessionLocationSnapshot>();
  private readonly retiredGenerations = new Map<string, number>();

  accept(sessionId: string, snapshot: SessionLocationSnapshot): boolean {
    const retiredGeneration = this.retiredGenerations.get(sessionId);
    if (retiredGeneration !== undefined) {
      if (snapshot.generation <= retiredGeneration) return false;
      this.retiredGenerations.delete(sessionId);
    }
    const current = this.snapshots.get(sessionId);
    if (!isSessionLocationSnapshotNewer(snapshot, current)) return false;
    this.snapshots.set(sessionId, snapshot);
    return true;
  }

  get(sessionId: string): SessionLocationSnapshot | undefined {
    return this.snapshots.get(sessionId);
  }

  retire(sessionId: string, generation: number): void {
    const current = this.snapshots.get(sessionId);
    this.retiredGenerations.set(
      sessionId,
      Math.max(
        this.retiredGenerations.get(sessionId) ?? 0,
        current?.generation ?? 0,
        generation,
      ),
    );
    this.snapshots.delete(sessionId);
  }

  reset(): void {
    this.snapshots.clear();
    this.retiredGenerations.clear();
  }
}
