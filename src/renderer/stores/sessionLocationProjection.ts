import type { SessionLocationSnapshot } from '../../shared/sessionLocation';
import { OrderedSessionLocationProjection } from '../../shared/orderedSessionLocationProjection';

const projection = new OrderedSessionLocationProjection();

export function beginSessionLocationProjection(ptyId: string): boolean {
  const authority = projection.beginDiscovery();
  const lease = projection.begin(ptyId, authority);
  projection.finishDiscovery(authority);
  return lease !== undefined;
}

export function rememberSessionLocation(
  ptyId: string,
  snapshot: SessionLocationSnapshot,
): boolean {
  const lease = projection.lease(ptyId);
  return lease ? projection.accept(ptyId, snapshot, lease) : false;
}

export function getRememberedSessionLocation(
  ptyId: string,
): SessionLocationSnapshot | undefined {
  return projection.get(ptyId);
}

export function forgetSessionLocation(ptyId: string): void {
  const lease = projection.lease(ptyId);
  if (lease) projection.release(ptyId, lease);
}

export function resetSessionLocationProjections(): void {
  projection.reset();
}
