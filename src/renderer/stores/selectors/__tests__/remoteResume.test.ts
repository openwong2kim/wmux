import { describe, it, expect } from 'vitest';
import { remoteAgentKey, type RemotePaneSummary } from '../../../../shared/remoteHosts';
import {
  selectRemoteResumePane,
  selectRemoteResumePanesByKey,
} from '../remoteResume';

const resume = { agent: 'claude', sessionId: 'conv-1', cwdMatches: true } as const;

function pane(sessionId: string, extra: Partial<RemotePaneSummary> = {}): RemotePaneSummary {
  return { sessionId, ...extra };
}

function stateWith(entries: Array<{ hostId: string; stale?: boolean; panes: RemotePaneSummary[] }>) {
  return {
    remoteWorkspaces: entries.map((e, i) => ({
      key: `${e.hostId}:ws${i}`,
      hostId: e.hostId,
      workspaceId: `ws${i}`,
      panes: e.panes,
      stale: e.stale ?? false,
    })),
  } as unknown as Parameters<typeof selectRemoteResumePanesByKey>[0];
}

describe('remote resume keying (#1342)', () => {
  // A remote-terminal surface has ptyId '' by contract, so the offer is keyed
  // by the roster's synthetic identity instead — it can never collide with a
  // local ptyId, and it distinguishes the same session id on two hosts.
  it('keys resume-bearing panes as remote:{hostId}:{sessionId}', () => {
    const byKey = selectRemoteResumePanesByKey(stateWith([
      { hostId: 'h1', panes: [pane('s1', { resume }), pane('s2')] },
      { hostId: 'h2', panes: [pane('s1', { resume, commandRunning: false })] },
    ]));

    expect(Object.keys(byKey).sort()).toEqual(['remote:h1:s1', 'remote:h2:s1']);
    expect(byKey[remoteAgentKey('h1', 's1')]?.resume).toEqual(resume);
    // A pane with no offer is not keyed at all.
    expect(byKey['remote:h1:s2']).toBeUndefined();

    expect(selectRemoteResumePane(stateWith([
      { hostId: 'h1', panes: [pane('s1', { resume })] },
    ]), 'h1', 's1')?.resume).toEqual(resume);
  });

  // A host we can no longer reach has its snapshot frozen: its liveness
  // signals stopped updating, so gating a "never type into a live agent"
  // decision on them would be gating on a guess.
  it('offers nothing from a stale host entry', () => {
    const state = stateWith([{ hostId: 'h1', stale: true, panes: [pane('s1', { resume })] }]);
    expect(selectRemoteResumePanesByKey(state)).toEqual({});
    expect(selectRemoteResumePane(state, 'h1', 's1')).toBeUndefined();
  });
});
