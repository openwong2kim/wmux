import { describe, expect, it, vi } from 'vitest';
import type { A2aExposureCandidate, A2aRemotePaneGoneParams, A2aRemotePaneSnapshot } from '../../../shared/rpc';
import { A2A_BRAIN_GRACE_MS, A2aExposurePublisher, coercePaneSnapshot, diffGonePanes, goneForLinks } from '../exposurePublisher';
import type { A2aLinkRecordV1 } from '../../../shared/a2aRemote';

const snap = (ws: Array<[string, string[]]>): A2aRemotePaneSnapshot => ({
  workspaces: ws.map(([id, panes]) => ({ id, name: `name-${id}`, panes: panes.map((paneId) => ({ paneId, cwd: `/repo/${paneId}` })) })),
});

describe('diffGonePanes', () => {
  it('reports closed panes, moved panes and gone workspaces (not their panes)', () => {
    const prev = snap([['w1', ['a', 'b', 'c']], ['w2', ['d']], ['w3', ['e']]]);
    const next = snap([['w1', ['a']], ['w2', ['d', 'c']]]);
    expect(diffGonePanes(prev, next)).toEqual([
      { workspaceId: 'w1', paneId: 'b', reason: 'pane-closed' },
      { workspaceId: 'w1', paneId: 'c', reason: 'pane-moved' },
      { workspaceId: 'w3', reason: 'workspace-gone' },
    ]);
  });
});

describe('A2aExposurePublisher', () => {
  function rig(exposed: string[]) {
    const published: A2aExposureCandidate[][] = [];
    const gone: A2aRemotePaneGoneParams[] = [];
    const client = {
      a2aRemoteExposureList: vi.fn(async () => ({ exposures: exposed.length ? [{ v: 1 as const, hostId: 'h', workspaceIds: exposed, updatedAt: '' }] : [] })),
      a2aRemoteExposurePublish: vi.fn(async (p: A2aExposureCandidate[]) => void published.push(p)),
      a2aRemotePaneGone: vi.fn(async (p: A2aRemotePaneGoneParams) => void gone.push(p)),
      a2aRemoteLinksList: vi.fn(async () => ({ links: [] })),
    };
    const pub = new A2aExposurePublisher({
      client: () => client,
      repoKey: async (cwd) => (cwd === '/repo/a' ? 'github.com/acme/api' : null),
      log: () => undefined,
    });
    return { pub, published, gone };
  }

  it('publishes only exposed workspaces, with the repo key; the first snapshot is only a baseline', async () => {
    const { pub, published, gone } = rig(['w1']);
    await pub.accept(snap([['w1', ['a']], ['w2', ['d']]]));
    expect(gone).toEqual([]);
    expect(published.at(-1)).toEqual([
      { kind: 'pane', workspaceId: 'w1', workspaceName: 'name-w1', paneId: 'a', cwd: '/repo/a', gitRemote: 'github.com/acme/api' },
    ]);
    await pub.accept(snap([['w1', ['a']]]));
    expect(gone).toEqual([{ workspaceId: 'w2', reason: 'workspace-gone' }]);
  });

  it('an empty tree breaks nothing unless the renderer says its session is restored', async () => {
    const { pub, gone } = rig(['w1']);
    await pub.accept(snap([['w1', ['a']]]));
    await pub.accept({ workspaces: [] });
    expect(gone).toEqual([]);
    // The last workspace really closed.
    await pub.accept({ workspaces: [], sessionRestored: true });
    expect(gone).toEqual([{ workspaceId: 'w1', reason: 'workspace-gone' }]);
  });

  it('publishes nothing while nothing is exposed', async () => {
    const { pub, published } = rig([]);
    await pub.accept(snap([['w1', ['a']]]));
    expect(published).toEqual([[]]);
  });
});

describe('A2aExposurePublisher Moa', () => {
  function rig(brainExposed: boolean) {
    const published: A2aExposureCandidate[][] = [];
    const gone: A2aRemotePaneGoneParams[] = [];
    const client = {
      a2aRemoteExposureList: vi.fn(async () => ({ exposures: [{ v: 1 as const, hostId: 'h', workspaceIds: [], updatedAt: '', ...(brainExposed ? { brain: true } : {}) }] })),
      a2aRemoteExposurePublish: vi.fn(async (p: A2aExposureCandidate[]) => void published.push(p)),
      a2aRemotePaneGone: vi.fn(async (p: A2aRemotePaneGoneParams) => void gone.push(p)),
      a2aRemoteLinksList: vi.fn(async () => ({ links: [] })),
    };
    return { pub: new A2aExposurePublisher({ client: () => client, repoKey: async () => null, log: () => undefined }), published, gone };
  }
  const withMoa = (hq: string | null): A2aRemotePaneSnapshot => ({ ...snap([['hq', []], ['w1', ['a']]]), ...(hq ? { brain: { workspaceId: hq, name: 'Moa' } } : {}) });

  it('publishes Moa only while some PC may see it', async () => {
    const shown = rig(true);
    await shown.pub.accept(withMoa('hq'));
    expect(shown.published.at(-1)).toEqual([{ kind: 'brain', workspaceId: 'hq', workspaceName: 'Moa' }]);
    const hidden = rig(false);
    await hidden.pub.accept(withMoa('hq'));
    expect(hidden.published.at(-1)).toEqual([]);
  });

  it('Moa turning off breaks its links (brain endpoint gone)', async () => {
    const { pub, gone, published } = rig(true);
    await pub.accept(withMoa('hq'));
    await pub.accept(withMoa(null));
    expect(gone).toEqual([{ workspaceId: 'hq', reason: 'workspace-gone', endpoint: 'brain' }]);
    expect(published.at(-1)).toEqual([]);
  });
});

describe('coercePaneSnapshot', () => {
  it('rejects malformed input and drops empty optional fields', () => {
    expect(coercePaneSnapshot(null)).toBeNull();
    expect(coercePaneSnapshot({ workspaces: [{ id: 'w', panes: [{ paneId: '' }] }] })).toBeNull();
    expect(coercePaneSnapshot({ workspaces: [{ id: 'w', name: 'W', panes: [{ paneId: 'p', label: '', agent: 'claude' }] }] }))
      .toEqual({ workspaces: [{ id: 'w', name: 'W', panes: [{ paneId: 'p', agent: 'claude' }] }] });
  });
});

describe('A2aExposurePublisher gone notices survive a daemon outage', () => {
  const link = (local: A2aLinkRecordV1['local']): A2aLinkRecordV1 => ({
    v: 1, linkId: 'l1', version: 2, state: 'active', local, remote: { hostId: 'h', kind: local.kind, workspaceId: 'r', ...(local.kind === 'pane' ? { paneId: 'rp' } : {}) },
    allow: { outbound: true, inbound: true }, proposer: 'local', createdAt: '', updatedAt: '',
  });

  it('retries a notice the daemon did not take', async () => {
    const timers: Array<() => void> = [];
    let fail = true;
    const gone: A2aRemotePaneGoneParams[] = [];
    const client = {
      a2aRemoteExposureList: vi.fn(async () => ({ exposures: [] })),
      a2aRemoteExposurePublish: vi.fn(async () => undefined),
      a2aRemotePaneGone: vi.fn(async (p: A2aRemotePaneGoneParams) => { if (fail) throw new Error('down'); gone.push(p); }),
      a2aRemoteLinksList: vi.fn(async () => ({ links: [] })),
    };
    const pub = new A2aExposurePublisher({ client: () => client, repoKey: async () => null, log: () => undefined, setTimer: (fn) => void timers.push(fn) });
    await pub.accept(snap([['w1', ['a', 'b']]]));
    await pub.accept(snap([['w1', ['a']]]));
    expect(gone).toEqual([]);
    expect(timers).toHaveLength(1);
    fail = false;
    timers[0]();
    await pub.republish();
    expect(gone).toEqual([{ workspaceId: 'w1', paneId: 'b', reason: 'pane-closed' }]);
  });

  it('a pane closed while the daemon was away is found from its live links on reconnect', async () => {
    let connected = false;
    const gone: A2aRemotePaneGoneParams[] = [];
    const client = {
      a2aRemoteExposureList: vi.fn(async () => ({ exposures: [] })),
      a2aRemoteExposurePublish: vi.fn(async () => undefined),
      a2aRemotePaneGone: vi.fn(async (p: A2aRemotePaneGoneParams) => void gone.push(p)),
      a2aRemoteLinksList: vi.fn(async () => ({ links: [link({ kind: 'pane', workspaceId: 'w1', paneId: 'b' }), link({ kind: 'pane', workspaceId: 'w1', paneId: 'a' })] })),
    };
    const pub = new A2aExposurePublisher({ client: () => (connected ? client : null), repoKey: async () => null, log: () => undefined });
    await pub.accept(snap([['w1', ['a', 'b']]]));
    await pub.accept(snap([['w1', ['a']]]));
    connected = true;
    await pub.republish();
    expect(gone).toEqual([{ workspaceId: 'w1', paneId: 'b', reason: 'pane-closed' }]);
  });

  it('goneForLinks: moved, closed, workspace gone, Moa gone', () => {
    const tree: A2aRemotePaneSnapshot = { workspaces: [{ id: 'w1', name: '', panes: [{ paneId: 'a' }] }, { id: 'w2', name: '', panes: [{ paneId: 'm' }] }] };
    expect(goneForLinks([
      link({ kind: 'pane', workspaceId: 'w1', paneId: 'a' }),
      link({ kind: 'pane', workspaceId: 'w1', paneId: 'm' }),
      link({ kind: 'pane', workspaceId: 'w1', paneId: 'x' }),
      link({ kind: 'pane', workspaceId: 'w9', paneId: 'y' }),
      link({ kind: 'brain', workspaceId: 'hq' }),
    ], tree)).toEqual([
      { workspaceId: 'w1', paneId: 'm', reason: 'pane-moved' },
      { workspaceId: 'w1', paneId: 'x', reason: 'pane-closed' },
      { workspaceId: 'w9', reason: 'workspace-gone' },
      { workspaceId: 'hq', reason: 'workspace-gone', endpoint: 'brain' },
    ]);
  });
});

describe('A2aExposurePublisher Moa blips', () => {
  function rig() {
    let now = 1_000;
    const timers: Array<() => void> = [];
    const gone: A2aRemotePaneGoneParams[] = [];
    const client = {
      a2aRemoteExposureList: vi.fn(async () => ({ exposures: [] })),
      a2aRemoteExposurePublish: vi.fn(async () => undefined),
      a2aRemotePaneGone: vi.fn(async (p: A2aRemotePaneGoneParams) => void gone.push(p)),
      a2aRemoteLinksList: vi.fn(async () => ({ links: [] })),
    };
    const pub = new A2aExposurePublisher({
      client: () => client, repoKey: async () => null, log: () => undefined,
      now: () => now, setTimer: (fn) => void timers.push(fn),
    });
    return { pub, gone, timers, advance: (ms: number) => { now += ms; } };
  }
  const tree = (brainState: 'present' | 'off' | 'unknown'): A2aRemotePaneSnapshot => ({
    workspaces: [{ id: 'hq', name: 'Moa', panes: [] }],
    brainState,
    ...(brainState === 'present' ? { brain: { workspaceId: 'hq', name: 'Moa' } } : {}),
  });

  it('keeps Moa through an unknown blip shorter than the grace', async () => {
    const { pub, gone, advance } = rig();
    await pub.accept(tree('present'));
    await pub.accept(tree('unknown'));
    advance(A2A_BRAIN_GRACE_MS - 1);
    await pub.accept(tree('unknown'));
    await pub.accept(tree('present'));
    expect(gone).toEqual([]);
  });

  it('a cold start (Moa not read yet) keeps a live Moa link, and breaks it only once Moa is off', async () => {
    const { pub, gone } = rig();
    const live: A2aLinkRecordV1 = {
      v: 1, linkId: 'l1', version: 2, state: 'active', local: { kind: 'brain', workspaceId: 'hq' },
      remote: { hostId: 'h', kind: 'brain', workspaceId: 'r' },
      allow: { outbound: true, inbound: true }, proposer: 'local', createdAt: '', updatedAt: '',
    };
    // A fresh main process: no earlier snapshot, the daemon still holds the link.
    (pub as unknown as { deps: { client: () => { a2aRemoteLinksList: () => Promise<unknown> } } }).deps.client().a2aRemoteLinksList = async () => ({ links: [live] });
    await pub.accept(tree('unknown'));
    expect(gone).toEqual([]);
    await pub.accept(tree('present'));
    expect(gone).toEqual([]);
    await pub.accept(tree('off'));
    expect(gone).toEqual([{ workspaceId: 'hq', reason: 'workspace-gone', endpoint: 'brain' }]);
  });

  it('gives Moa up after the grace, and at once when it is turned off', async () => {
    const a = rig();
    await a.pub.accept(tree('present'));
    await a.pub.accept(tree('unknown'));
    a.advance(A2A_BRAIN_GRACE_MS);
    a.timers[0]();
    await a.pub.republish();
    expect(a.gone).toEqual([{ workspaceId: 'hq', reason: 'workspace-gone', endpoint: 'brain' }]);
    const b = rig();
    await b.pub.accept(tree('present'));
    await b.pub.accept(tree('off'));
    expect(b.gone).toEqual([{ workspaceId: 'hq', reason: 'workspace-gone', endpoint: 'brain' }]);
  });
});
