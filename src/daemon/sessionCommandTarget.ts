import {
  createSessionCommandTarget,
  type SessionCommandTarget,
  type SessionLocation,
} from '../shared/sessionLocation';
import type { DaemonSession } from './types';

/** Read the normalized durable location without reclassifying live state. */
export function daemonSessionLocation(
  session: Pick<DaemonSession, 'id' | 'location'>,
): SessionLocation {
  if (!session.location) {
    throw new Error(`Session '${session.id}' has no normalized location`);
  }
  return session.location;
}

/** Sole daemon-side constructor for a live session command target. */
export function daemonSessionCommandTarget(
  session: Pick<DaemonSession, 'id' | 'location'>,
): SessionCommandTarget {
  return createSessionCommandTarget(session.id, daemonSessionLocation(session));
}
