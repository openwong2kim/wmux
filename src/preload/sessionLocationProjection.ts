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

  reset(): void {
    this.owner.reset();
  }

  snapshots(): Array<[string, SessionLocationSnapshot]> {
    return this.owner.snapshots();
  }
}
