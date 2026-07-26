import {
  isSessionLocationSnapshotNewer,
  type SessionLocationSnapshot,
} from './sessionLocation';

declare const discoveryBrand: unique symbol;
declare const leaseBrand: unique symbol;

export interface SessionLocationDiscoveryAuthority {
  readonly [discoveryBrand]: true;
}

export interface SessionLocationProjectionLease {
  readonly [leaseBrand]: true;
}

interface DiscoveryState {
  blockedIds: Set<string>;
}

interface ProjectionState {
  lease: SessionLocationProjectionLease;
  snapshot?: SessionLocationSnapshot;
  retiredGeneration?: number;
}

/**
 * Sole owner of generation/revision ordering and lifecycle fencing for projected
 * session locations. Boundary adapters supply lifecycle facts; this class owns
 * every state transition resulting from those facts.
 */
export class OrderedSessionLocationProjection {
  private readonly discoveries = new Map<
    SessionLocationDiscoveryAuthority,
    DiscoveryState
  >();
  private readonly projections = new Map<string, ProjectionState>();

  beginDiscovery(): SessionLocationDiscoveryAuthority {
    const authority = {} as SessionLocationDiscoveryAuthority;
    this.discoveries.set(authority, { blockedIds: new Set() });
    return authority;
  }

  finishDiscovery(authority: SessionLocationDiscoveryAuthority): void {
    this.discoveries.delete(authority);
  }

  begin(
    sessionId: string,
    authority: SessionLocationDiscoveryAuthority,
  ): SessionLocationProjectionLease | undefined {
    const discovery = this.discoveries.get(authority);
    if (!discovery || discovery.blockedIds.has(sessionId)) return undefined;

    const current = this.projections.get(sessionId);
    if (current) return current.lease;

    const lease = {} as SessionLocationProjectionLease;
    this.projections.set(sessionId, { lease });
    return lease;
  }

  lease(sessionId: string): SessionLocationProjectionLease | undefined {
    return this.projections.get(sessionId)?.lease;
  }

  accept(
    sessionId: string,
    snapshot: SessionLocationSnapshot,
    lease: SessionLocationProjectionLease,
  ): boolean {
    const state = this.currentState(sessionId, lease);
    if (!state) return false;
    if (
      state.retiredGeneration !== undefined
      && snapshot.generation <= state.retiredGeneration
    ) {
      return false;
    }
    if (!isSessionLocationSnapshotNewer(snapshot, state.snapshot)) return false;

    state.snapshot = snapshot;
    if (
      state.retiredGeneration !== undefined
      && snapshot.generation > state.retiredGeneration
    ) {
      state.retiredGeneration = undefined;
    }
    return true;
  }

  get(sessionId: string): SessionLocationSnapshot | undefined {
    return this.projections.get(sessionId)?.snapshot;
  }

  retire(
    sessionId: string,
    generation: number,
    lease: SessionLocationProjectionLease,
  ): boolean {
    const state = this.currentState(sessionId, lease);
    if (!state) return false;

    state.retiredGeneration = Math.max(state.retiredGeneration ?? 0, generation);
    if (state.snapshot && state.snapshot.generation <= generation) {
      state.snapshot = undefined;
    }
    return true;
  }

  release(
    sessionId: string,
    lease: SessionLocationProjectionLease,
  ): boolean {
    if (!this.currentState(sessionId, lease)) return false;
    for (const discovery of this.discoveries.values()) {
      discovery.blockedIds.add(sessionId);
    }
    this.projections.delete(sessionId);
    return true;
  }

  reset(): void {
    this.discoveries.clear();
    this.projections.clear();
  }

  retainedSize(): number {
    return this.projections.size;
  }

  private currentState(
    sessionId: string,
    lease: SessionLocationProjectionLease,
  ): ProjectionState | undefined {
    const state = this.projections.get(sessionId);
    return state?.lease === lease ? state : undefined;
  }
}
