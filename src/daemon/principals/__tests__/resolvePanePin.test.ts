import { describe, it, expect } from 'vitest';
import { resolvePanePin } from '../resolvePanePin';
import { panePrincipalId } from '../../../shared/principals';
import type { PrincipalRecord, PrincipalLiveness } from '../../../shared/principals';
import type { DaemonSessionState } from '../../types';

function paneRecord(
  workspaceId: string,
  paneId: string,
  ptyId: string | undefined,
  liveness: PrincipalLiveness = 'live',
): PrincipalRecord {
  return {
    id: panePrincipalId(workspaceId, paneId),
    kind: 'pane-agent',
    display: `${workspaceId}/${paneId}`,
    reachability: 'pty-nudge',
    liveness,
    workspaceId,
    paneId,
    ...(ptyId !== undefined ? { ptyId } : {}),
    createdAt: 0,
    lastSeenAt: 0,
  };
}

function lookups(
  records: PrincipalRecord[],
  sessions: Record<string, DaemonSessionState>,
) {
  const byId = new Map(records.map((r) => [r.id, r]));
  return {
    findPrincipal: (id: string) => byId.get(id),
    sessionState: (ptyId: string) => sessions[ptyId],
  };
}

describe('resolvePanePin — ownership', () => {
  it('returns undefined when the workspace has no such pane', () => {
    const l = lookups([paneRecord('ws-a', 'pane-1', 'pty-1')], { 'pty-1': 'attached' });
    expect(resolvePanePin(l, 'ws-a', 'pane-missing')).toBeUndefined();
  });

  // The registry key embeds the workspace, so pinning another workspace's pane
  // simply misses. This is the cross-workspace paste primitive the gate exists
  // to refuse — assert it at the resolver, not only at the caller.
  it('returns undefined for a pane that belongs to a different workspace', () => {
    const l = lookups([paneRecord('ws-b', 'pane-1', 'pty-1')], { 'pty-1': 'attached' });
    expect(resolvePanePin(l, 'ws-a', 'pane-1')).toBeUndefined();
  });

  it('returns undefined for a principal that is not a pane-agent', () => {
    const human: PrincipalRecord = {
      ...paneRecord('ws-a', 'pane-1', 'pty-1'),
      kind: 'human',
    };
    const l = lookups([human], { 'pty-1': 'attached' });
    expect(resolvePanePin(l, 'ws-a', 'pane-1')).toBeUndefined();
  });
});

describe('resolvePanePin — liveness', () => {
  it.each<DaemonSessionState>(['attached', 'detached'])('proves a %s session', (state) => {
    const l = lookups([paneRecord('ws-a', 'pane-1', 'pty-1')], { 'pty-1': state });
    expect(resolvePanePin(l, 'ws-a', 'pane-1')).toEqual({ ptyId: 'pty-1' });
  });

  // `suspended` is NOT a live PTY. The shutdown-kill classifier demotes an
  // involuntarily-killed session to it and `attachSession` rejects it for
  // exactly this reason — there is no ptyProcess left to write into. Treating
  // it as live would hand out a pin nothing can act on.
  it.each<DaemonSessionState>(['suspended', 'dead'])('refuses a %s session', (state) => {
    const l = lookups([paneRecord('ws-a', 'pane-1', 'pty-1')], { 'pty-1': state });
    expect(resolvePanePin(l, 'ws-a', 'pane-1')).toEqual({});
  });

  it('refuses when the record names a session that no longer exists', () => {
    const l = lookups([paneRecord('ws-a', 'pane-1', 'pty-gone')], {});
    expect(resolvePanePin(l, 'ws-a', 'pane-1')).toEqual({});
  });

  it('refuses a record that carries no ptyId at all', () => {
    const l = lookups([paneRecord('ws-a', 'pane-1', undefined)], { 'pty-1': 'attached' });
    expect(resolvePanePin(l, 'ws-a', 'pane-1')).toEqual({});
  });
});

// REGRESSION (#675 as shipped). The daemon backfills every pane-agent principal
// to `liveness: 'stale'` on its own restart, and only a renderer re-registration
// undoes that. An IDLE agent emits nothing, so nothing re-registers it — reading
// `liveness` meant a pin aimed at an idle agent was refused FOREVER after a
// restart, which is the one case pane-pinned mentions were built to serve. The
// session table is the daemon's own and survives the restart intact.
describe('resolvePanePin — after a daemon restart', () => {
  it('still proves an idle pane whose principal was backfilled to stale', () => {
    const l = lookups([paneRecord('ws-a', 'pane-1', 'pty-1', 'stale')], { 'pty-1': 'detached' });
    expect(resolvePanePin(l, 'ws-a', 'pane-1')).toEqual({ ptyId: 'pty-1' });
  });

  it('does not resurrect a stale principal whose session is genuinely gone', () => {
    const l = lookups([paneRecord('ws-a', 'pane-1', 'pty-1', 'stale')], { 'pty-1': 'dead' });
    expect(resolvePanePin(l, 'ws-a', 'pane-1')).toEqual({});
  });
});
