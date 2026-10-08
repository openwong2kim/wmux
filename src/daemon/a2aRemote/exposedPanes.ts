import { A2A_BRAIN_ALIAS, type A2aExposedPane, type HostId } from '../../shared/a2aRemote';
import { isPlainObject, isSafeId, sanitizeName, sanitizeRepoKey } from './storeFile';

/**
 * What the app last told the daemon about its exposure candidates
 * (`a2a.remote.exposure.publish`): workspace name, pane label, agent, cwd and
 * git info for the panes of exposed workspaces. Only the renderer and main
 * know these; the daemon keeps the latest snapshot in memory and serves it,
 * filtered per peer by the exposure store, on `GET /api/a2a/exposed`. At most
 * one `brain` entry (this PC's Moa, present while Moa is on and its HQ exists).
 *
 * In memory on purpose: while the app is away the last snapshot keeps
 * serving, and a daemon restart starts empty (nothing listed) until the app
 * publishes again.
 */

/** Panes one snapshot may carry; the rest are dropped. */
export const EXPOSED_PANES_MAX = 512;
/** Max length of a published cwd. */
export const EXPOSED_CWD_MAX = 1024;

export interface ExposureCheck {
  isPaneExposed(hostId: HostId, workspaceId: string, paneId: string): boolean;
  isBrainExposed(hostId: HostId): boolean;
}

export class ExposedPaneCache {
  private panes: A2aExposedPane[] = [];

  /** Replace the snapshot. Malformed entries are dropped. Returns how many were kept. */
  publish(raw: unknown): number {
    const list = Array.isArray(raw) ? raw : [];
    const next: A2aExposedPane[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      if (next.length >= EXPOSED_PANES_MAX) break;
      const pane = cleanExposedPane(entry);
      if (!pane) continue;
      const key = pane.kind === 'brain' ? 'brain' : `${pane.workspaceId}\0${pane.paneId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(pane);
    }
    this.panes = next;
    return next.length;
  }

  all(): A2aExposedPane[] {
    return this.panes.map((p) => ({ ...p }));
  }

  /** The snapshot as `hostId` may see it right now (the exposure store decides). */
  visibleTo(hostId: HostId, exposures: ExposureCheck): A2aExposedPane[] {
    return this.panes
      .filter((p) => (p.kind === 'brain' ? exposures.isBrainExposed(hostId) : exposures.isPaneExposed(hostId, p.workspaceId, p.paneId ?? '')))
      .map((p) => ({ ...p }));
  }

  /** This PC's Moa as last published (its HQ workspace), or null. */
  brain(): A2aExposedPane | null {
    const b = this.panes.find((p) => p.kind === 'brain');
    return b ? { ...b } : null;
  }

  forgetPane(paneId: string): void {
    this.panes = this.panes.filter((p) => p.paneId !== paneId);
  }

  forgetBrain(): void {
    this.panes = this.panes.filter((p) => p.kind !== 'brain');
  }

  forgetWorkspace(workspaceId: string): void {
    this.panes = this.panes.filter((p) => p.workspaceId !== workspaceId);
  }
}

/**
 * Validate one exposed pane, from the app or (joiner side) from a remote
 * server's answer: ids bounded, names sanitized, optional fields dropped when
 * empty or malformed.
 */
export function cleanExposedPane(raw: unknown): A2aExposedPane | null {
  if (!isPlainObject(raw) || !isSafeId(raw['workspaceId'])) return null;
  if (raw['kind'] === 'brain') {
    // Moa: the HQ's id and a name, nothing pane-shaped.
    if (raw['paneId'] !== undefined) return null;
    return { kind: 'brain', workspaceId: raw['workspaceId'], workspaceName: sanitizeName(raw['workspaceName'], A2A_BRAIN_ALIAS) };
  }
  if (raw['kind'] !== 'pane' || !isSafeId(raw['paneId'])) return null;
  const pane: A2aExposedPane = {
    kind: 'pane',
    workspaceId: raw['workspaceId'],
    workspaceName: sanitizeName(raw['workspaceName'], raw['workspaceId']),
    paneId: raw['paneId'],
  };
  const label = sanitizeName(raw['label'], '');
  if (label) pane.label = label;
  const agent = sanitizeName(raw['agent'], '');
  if (agent) pane.agent = agent;
  const cwd = cleanCwd(raw['cwd']);
  if (cwd) pane.cwd = cwd;
  const gitRemote = sanitizeRepoKey(raw['gitRemote']);
  if (gitRemote) pane.gitRemote = gitRemote;
  const gitBranch = sanitizeName(raw['gitBranch'], '');
  if (gitBranch) pane.gitBranch = gitBranch;
  return pane;
}

function cleanCwd(v: unknown): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  const cwd = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cwd.length > EXPOSED_CWD_MAX ? '' : cwd;
}
