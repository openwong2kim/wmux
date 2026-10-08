// @vitest-environment jsdom
// The "Another PC asks to link a pane" toast: Accept right there only for a
// pane link on the same repo as this PC's pane; anything else is reviewed on
// the Remote page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { useStore } from '../../stores';
import type { A2aLinkRecordV1 } from '../../../shared/a2aRemote';
import { sameRepoPaneRequest, useA2aLinkRequestToast } from '../useA2aRemoteSnapshot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST = '11111111-1111-4111-8111-111111111111';
const link = (over: Partial<A2aLinkRecordV1> = {}): A2aLinkRecordV1 => ({
  v: 1, linkId: 'l-1', version: 1, state: 'proposed-in',
  local: { kind: 'pane', workspaceId: 'w1', paneId: 'p1' },
  remote: { hostId: HOST, kind: 'pane', workspaceId: 'rw', paneId: 'rp', gitRemote: 'github.com/o/api' },
  allow: { outbound: true, inbound: true }, proposer: 'remote', createdAt: '', updatedAt: '',
  ...over,
});

let root: Root | null = null;
let fire: ((event: { type: 'a2a.remote.link.proposed'; linkId: string }) => void) | null;
let a2a: Record<string, ReturnType<typeof vi.fn>>;
const t = (key: string) => key;

function Probe(): null {
  useA2aLinkRequestToast(t);
  return null;
}

function setup(record: A2aLinkRecordV1, repo: string | null) {
  fire = null;
  a2a = {
    onLinkEvent: vi.fn((cb) => { fire = cb; return () => undefined; }),
    linksList: vi.fn(async () => ({ links: [record] })),
    linksAccept: vi.fn(async () => ({ ok: true })),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    a2aRemote: a2a,
    github: { repoKey: vi.fn(async () => (repo ? { key: repo } : null)) },
  };
  const el = document.createElement('div');
  root = createRoot(el);
  act(() => root!.render(createElement(Probe)));
}

async function propose() {
  await act(async () => { fire?.({ type: 'a2a.remote.link.proposed', linkId: 'l-1' }); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  return useStore.getState().toasts.at(-1);
}

beforeEach(() => {
  const ws = {
    id: 'w1', name: 'api', metadata: { cwd: '/repo/api' }, activePaneId: 'p1',
    rootPane: { id: 'p1', type: 'leaf', surfaces: [{ id: 's1', ptyId: 'pty-1' }], activeSurfaceId: 's1' },
  };
  useStore.setState({ toasts: [], workspaces: [ws as never], surfaceAgent: {}, appRoute: 'workspaces' });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
});

describe('link request toast', () => {
  it('only a same-repo pane link qualifies', () => {
    expect(sameRepoPaneRequest(link(), 'github.com/o/api')).toBe(true);
    expect(sameRepoPaneRequest(link(), 'github.com/o/web')).toBe(false);
    expect(sameRepoPaneRequest(link(), null)).toBe(false);
    expect(sameRepoPaneRequest(link({ remote: { hostId: HOST, kind: 'pane', workspaceId: 'rw', paneId: 'rp' } }), 'github.com/o/api')).toBe(false);
    expect(sameRepoPaneRequest(link({ local: { kind: 'brain', workspaceId: 'hq' }, remote: { hostId: HOST, kind: 'brain', workspaceId: 'rhq' } }), 'github.com/o/api')).toBe(false);
  });

  it('offers Accept for a same-repo pane link, and accepting calls the daemon', async () => {
    setup(link(), 'github.com/o/api');
    const toast = await propose();
    expect(toast?.action?.label).toBe('a2aLink.accept');
    await act(async () => { toast?.action?.onClick(); });
    expect(a2a.linksAccept).toHaveBeenCalledWith('l-1');
  });

  it('keeps Review for another repo, and Review opens the Remote page', async () => {
    setup(link(), 'github.com/o/web');
    const toast = await propose();
    expect(toast?.action?.label).toBe('a2aLink.requestToastOpen');
    act(() => toast?.action?.onClick());
    expect(useStore.getState().appRoute).toBe('remote');
    expect(a2a.linksAccept).not.toHaveBeenCalled();
  });

  it('keeps Review for a Moa request', async () => {
    setup(link({ local: { kind: 'brain', workspaceId: 'hq' }, remote: { hostId: HOST, kind: 'brain', workspaceId: 'rhq', gitRemote: 'github.com/o/api' } }), 'github.com/o/api');
    expect((await propose())?.action?.label).toBe('a2aLink.requestToastOpen');
  });
});
