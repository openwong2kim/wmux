/**
 * #1342 — the resume half of local/remote parity, renderer side.
 *
 * A remote-terminal surface carries `ptyId: ''` by contract, so every
 * PTY-keyed resume map (resumeBindingByPtyId, commandRunningByPtyId,
 * agentAliveByPtyId) is structurally blind to it. Rather than smuggle a
 * synthetic id into those maps, remote resume state is read straight off the
 * host's own pane snapshot and addressed by the roster's synthetic identity,
 * `remote:{hostId}:{sessionId}` (remoteAgentKey — the #1163 convention), which
 * can never collide with a local ptyId.
 *
 * STALE entries are excluded for the same reason the roster excludes them: a
 * host we can no longer reach has its last snapshot frozen, and offering a
 * resume from it would gate on liveness signals that stopped updating.
 */

import { remoteAgentKey, type RemotePaneSummary } from '../../../shared/remoteHosts';
import type { StoreState } from '../index';

type RemoteResumeState = Pick<StoreState, 'remoteWorkspaces'>;

/**
 * Every remote pane that currently carries a resume offer, keyed by
 * `remote:{hostId}:{sessionId}`. Values are the stored pane objects, so a
 * caller can subscribe on one without minting a new identity per render.
 */
export function selectRemoteResumePanesByKey(
  state: RemoteResumeState,
): Record<string, RemotePaneSummary> {
  const byKey: Record<string, RemotePaneSummary> = {};
  for (const attached of state.remoteWorkspaces) {
    if (attached.stale) continue;
    for (const pane of attached.panes) {
      if (!pane.resume) continue;
      byKey[remoteAgentKey(attached.hostId, pane.sessionId)] = pane;
    }
  }
  return byKey;
}

/**
 * The resume-bearing snapshot for one remote session, or undefined.
 *
 * Looked up directly rather than through the map above: this runs inside a
 * zustand selector, which re-runs on EVERY store update (terminal output, hook
 * events, agent status — none of them remote), and building a whole map to
 * read one cell of it would do that work per mounted remote surface per store
 * event. The returned value is the STORED pane object, so its identity is
 * stable between polls and the subscription does not re-render on unrelated
 * updates.
 */
export function selectRemoteResumePane(
  state: RemoteResumeState,
  hostId: string,
  sessionId: string,
): RemotePaneSummary | undefined {
  if (!hostId || !sessionId) return undefined;
  for (const attached of state.remoteWorkspaces) {
    if (attached.stale || attached.hostId !== hostId) continue;
    const pane = attached.panes.find((p) => p.sessionId === sessionId);
    if (pane?.resume) return pane;
  }
  return undefined;
}
