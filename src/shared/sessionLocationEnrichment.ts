import type { SessionLocation } from './sessionLocation';

export type WslDistroResolver = (shell: string) => Promise<string | undefined>;

/**
 * Owns the lifecycle of asynchronous WSL distro enrichment.
 *
 * A lease is replaced whenever the same session id is registered again, so a
 * result from an older pane generation cannot land on a reused id. The current
 * location is read again after resolution, which preserves a cwd change that
 * happened while enumeration was in flight.
 */
export class SessionLocationEnricher {
  private readonly leases = new Map<string, object>();

  constructor(private readonly resolveWslDistro: WslDistroResolver) {}

  async enrich(
    sessionId: string,
    readCurrent: () => SessionLocation | undefined,
    accept: (location: SessionLocation) => void,
  ): Promise<boolean> {
    // Re-registration, including a host or explicitly named WSL location,
    // invalidates any result still in flight for the prior generation.
    this.leases.delete(sessionId);
    const initial = readCurrent();
    if (!initial || initial.domain !== 'wsl' || initial.distro) return false;

    const lease = {};
    this.leases.set(sessionId, lease);

    let distro: string | undefined;
    try {
      distro = await this.resolveWslDistro(initial.shell);
    } catch {
      distro = undefined;
    }
    if (!distro || this.leases.get(sessionId) !== lease) return false;

    const current = readCurrent();
    if (
      !current
      || current.domain !== 'wsl'
      || current.shell !== initial.shell
      || current.distro
    ) {
      return false;
    }

    this.leases.delete(sessionId);
    accept({ ...current, distro });
    return true;
  }

  cancel(sessionId: string): void {
    this.leases.delete(sessionId);
  }
}
