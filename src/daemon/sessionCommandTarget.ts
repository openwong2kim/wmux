import type { ActiveSessionContext, SessionLocation } from '../shared/sessionLocation';
import type { DaemonSession } from './types';

export interface DaemonSessionCommandTarget {
  sessionId: string;
  location: SessionLocation;
  activeContext?: ActiveSessionContext;
}

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
): DaemonSessionCommandTarget {
  const location = daemonSessionLocation(session);
  if (location.domain !== 'wsl') {
    return { sessionId: session.id, location };
  }
  return {
    sessionId: session.id,
    location,
    activeContext: {
      sessionId: session.id,
      active: true,
      ...(location.distro ? { distro: location.distro } : {}),
    },
  };
}
