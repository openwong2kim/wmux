import type { SessionLocationSnapshot } from '../shared/sessionLocation';
import {
  OrderedSessionLocationProjection,
  type SessionLocationDiscoveryAuthority,
} from '../shared/orderedSessionLocationProjection';

/**
 * Preload boundary adapter. Electron supplies request/event ordering facts;
 * the shared owner supplies every snapshot and lifecycle decision.
 */
export class PreloadSessionLocationProjection {
  private readonly owner = new OrderedSessionLocationProjection();

  beginDiscovery(): SessionLocationDiscoveryAuthority {
    return this.owner.beginDiscovery();
  }

  finishDiscovery(authority: SessionLocationDiscoveryAuthority): void {
    this.owner.finishDiscovery(authority);
  }

  accept(
    ptyId: string,
    snapshot: SessionLocationSnapshot,
    authority: SessionLocationDiscoveryAuthority,
  ): boolean {
    const lease = this.owner.begin(ptyId, authority);
    return lease ? this.owner.accept(ptyId, snapshot, lease) : false;
  }

  projectResponse<T extends {
    id?: string;
    locationSnapshot?: SessionLocationSnapshot;
  }>(
    response: T,
    authority: SessionLocationDiscoveryAuthority,
  ): { response: T; accepted: boolean } {
    const { id, locationSnapshot } = response;
    if (!id || !locationSnapshot) return { response, accepted: false };

    const accepted = this.accept(id, locationSnapshot, authority);
    return {
      response: accepted
        ? response
        : { ...response, locationSnapshot: undefined },
      accepted,
    };
  }

  acceptEvent(ptyId: string, snapshot: SessionLocationSnapshot): boolean {
    const authority = this.owner.beginDiscovery();
    try {
      return this.accept(ptyId, snapshot, authority);
    } finally {
      this.owner.finishDiscovery(authority);
    }
  }

  release(ptyId: string): void {
    let lease = this.owner.lease(ptyId);
    if (!lease) {
      const authority = this.owner.beginDiscovery();
      lease = this.owner.begin(ptyId, authority);
      this.owner.finishDiscovery(authority);
    }
    if (lease) this.owner.release(ptyId, lease);
  }

  retireAndRelease(ptyId: string, generation: number): boolean {
    const authority = this.owner.beginDiscovery();
    try {
      const lease = this.owner.begin(ptyId, authority);
      if (!lease || !this.owner.retire(ptyId, generation, lease)) return false;
      return this.owner.release(ptyId, lease);
    } finally {
      this.owner.finishDiscovery(authority);
    }
  }

  reset(): void {
    this.owner.reset();
  }

  snapshots(): Array<[string, SessionLocationSnapshot]> {
    return this.owner.snapshots();
  }
}
