import {
  locationIdentity,
  prepareLocationCommand,
  type ActiveSessionContext,
  type LocationError,
  type SessionLocation,
} from '../../shared/sessionLocation';

export interface PaneCommandTarget {
  sessionId: string;
  location: SessionLocation;
  activeContext?: ActiveSessionContext;
}

export function paneCommandIdentity(target: PaneCommandTarget): string {
  return locationIdentity(target.location);
}

export function preparePaneCommand(
  target: PaneCommandTarget,
  executable: string,
  args: readonly string[],
): { ok: true; file: string; args: string[]; cwd?: string }
  | { ok: false; error: LocationError } {
  if (
    target.location.domain === 'wsl'
    && (
      !target.activeContext?.active
      || target.activeContext.sessionId !== target.sessionId
    )
  ) {
    return { ok: false, error: 'ACTIVE_CONTEXT_REQUIRED' };
  }
  return prepareLocationCommand(target.location, executable, args, target.activeContext);
}

export function hostCommandTarget(cwd: string): PaneCommandTarget {
  return {
    sessionId: `host:${cwd}`,
    location: { domain: 'host', cwd, shell: '' },
  };
}
