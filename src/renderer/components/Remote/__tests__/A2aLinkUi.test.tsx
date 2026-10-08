// @vitest-environment jsdom
//
// Cross-PC pane link UI: the matching dialog (same-repo panes first, repo
// mismatch warning, directions) and the Remote page's request cards and link
// list. Pure views, rendered with stub `t`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement, type ReactElement } from 'react';
import type { A2aExposedPane, A2aLinkRecordV1 } from '../../../../shared/a2aRemote';
import { A2aLinkDialogView, type A2aLinkDialogViewProps } from '../A2aLinkDialog';
import { A2aLinksView, type A2aLinksViewProps } from '../A2aLinksPanel';
import { rankExposedPanes, remoteAlias, repoMismatch } from '../a2aLinkModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;

const roots: Array<{ root: Root; el: HTMLElement }> = [];
function render(ui: ReactElement): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(ui));
  roots.push({ root, el });
  return document.body;
}
afterEach(() => {
  for (const { root, el } of roots.splice(0)) {
    act(() => root.unmount());
    el.remove();
  }
});

const HOST = '11111111-1111-4111-8111-111111111111';
const pane = (id: string, gitRemote?: string): A2aExposedPane => ({
  kind: 'pane', workspaceId: 'ws', workspaceName: 'API', paneId: id, label: id, ...(gitRemote ? { gitRemote } : {}),
});

describe('rankExposedPanes', () => {
  it('puts panes on my repo first, marked recommended, keeping order within groups', () => {
    const ranked = rankExposedPanes([pane('a', 'x/o/other'), pane('b', 'x/o/api'), pane('c'), pane('d', 'x/o/api')], 'x/o/api');
    expect(ranked.map((r) => [r.pane.paneId, r.recommended])).toEqual([['b', true], ['d', true], ['a', false], ['c', false]]);
    expect(rankExposedPanes([pane('a', 'x/o/api')], null)[0].recommended).toBe(false);
  });

  it('only flags a mismatch when both repos are known', () => {
    expect(repoMismatch('a', 'b')).toBe(true);
    expect(repoMismatch('a', 'a')).toBe(false);
    expect(repoMismatch(null, 'b')).toBe(false);
  });

  it('builds the <PC>/<workspace>/<pane> alias', () => {
    expect(remoteAlias('DESK', { hostId: HOST, kind: 'pane', workspaceId: 'w', paneId: 'p', workspaceName: 'API', label: 'w1-1' })).toBe('DESK/API/w1-1');
    expect(remoteAlias('DESK', { hostId: HOST, kind: 'pane', workspaceId: 'w', paneId: 'p' })).toBe('DESK/w/p');
    expect(remoteAlias('DESK', { hostId: HOST, kind: 'brain', workspaceId: 'hq' })).toBe('DESK/Moa');
  });
});

function dialogProps(over: Partial<A2aLinkDialogViewProps> = {}): A2aLinkDialogViewProps {
  return {
    localKind: 'pane', localName: 'Web / w1-1', localRemote: 'x/o/api',
    hosts: [{ v: 1, hostId: HOST, name: 'DESK', addresses: ['desk'], port: 45660, fingerprint256: 'AA', peerId: 'p', createdAt: '' }],
    hostId: HOST, onPickHost: () => undefined,
    panes: rankExposedPanes([pane('other', 'x/o/web'), pane('same', 'x/o/api')], 'x/o/api'),
    panesError: null, selected: null, onPickPane: () => undefined,
    send: true, receive: true, onSend: () => undefined, onReceive: () => undefined,
    busy: false, outcome: null, onPropose: () => undefined, onClose: () => undefined, t,
    ...over,
  };
}

describe('A2aLinkDialogView', () => {
  it('lists the recommended pane first and sends nothing until a pane is picked', () => {
    const body = render(createElement(A2aLinkDialogView, dialogProps()));
    const options = [...body.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-pane-id'));
    expect(options).toEqual(['same', 'other']);
    expect(body.querySelectorAll('[data-testid="a2a-link-recommended"]')).toHaveLength(1);
    expect((body.querySelector('[data-testid="a2a-link-propose"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns when the picked pane is on another repo, and proposes with both directions on by default', () => {
    const onPropose = vi.fn();
    const body = render(createElement(A2aLinkDialogView, dialogProps({ selected: pane('other', 'x/o/web'), onPropose })));
    expect(body.querySelector('[data-testid="a2a-link-mismatch"]')?.textContent).toContain('x/o/web');
    expect([...body.querySelectorAll('[role="checkbox"]')].map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'true']);
    act(() => (body.querySelector('[data-testid="a2a-link-propose"]') as HTMLButtonElement).click());
    expect(onPropose).toHaveBeenCalledOnce();
  });

  it('cannot send with no direction', () => {
    const body = render(createElement(A2aLinkDialogView, dialogProps({ selected: pane('same', 'x/o/api'), send: false, receive: false })));
    expect((body.querySelector('[data-testid="a2a-link-propose"]') as HTMLButtonElement).disabled).toBe(true);
    expect(body.querySelector('[data-testid="a2a-link-mismatch"]')).toBeNull();
  });

  it('a pane lists only panes; that PC\'s Moa is left out with a note', () => {
    const moa: A2aExposedPane = { kind: 'brain', workspaceId: 'hq', workspaceName: 'Moa' };
    const body = render(createElement(A2aLinkDialogView, dialogProps({ panes: rankExposedPanes([moa, pane('same', 'x/o/api')], 'x/o/api') })));
    expect([...body.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-pane-id'))).toEqual(['same']);
    expect(body.querySelector('[data-testid="a2a-link-kind-note"]')?.textContent).toBe('a2aLink.paneOnlyNote');
  });

  it('Moa lists only that PC\'s Moa, without a repo warning', () => {
    const moa: A2aExposedPane = { kind: 'brain', workspaceId: 'hq', workspaceName: 'Moa' };
    const body = render(createElement(A2aLinkDialogView, dialogProps({
      localKind: 'brain', localRemote: null, panes: rankExposedPanes([moa, pane('same', 'x/o/api')], null), selected: moa,
    })));
    const options = [...body.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.getAttribute('data-pane-id'))).toEqual(['moa']);
    expect(options[0].textContent).toContain('a2aLink.moaOf(DESK)');
    expect(body.querySelector('[data-testid="a2a-link-mismatch"]')).toBeNull();
    expect((body.querySelector('[data-testid="a2a-link-propose"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('an unanswered proposal says it may have arrived, and offers no resend', () => {
    const body = render(createElement(A2aLinkDialogView, dialogProps({ selected: pane('same', 'x/o/api'), outcome: { ok: false, error: 'timeout', uncertain: true } })));
    expect(body.querySelector('[data-testid="a2a-link-outcome"]')?.textContent).toBe('a2aLink.uncertain');
    expect(body.querySelector('[data-testid="a2a-link-propose"]')).toBeNull();
  });

  it('says so when that PC shows nothing', () => {
    const body = render(createElement(A2aLinkDialogView, dialogProps({ panes: [] })));
    expect(body.querySelector('[data-testid="a2a-link-none-exposed"]')).not.toBeNull();
  });
});

const link = (over: Partial<A2aLinkRecordV1> = {}): A2aLinkRecordV1 => ({
  v: 1, linkId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1, state: 'proposed-in',
  local: { kind: 'pane', workspaceId: 'w1', paneId: 'p1' },
  remote: { hostId: HOST, kind: 'pane', workspaceId: 'rw', paneId: 'rp', workspaceName: 'Web', label: 'w2-1', gitRemote: 'x/o/web' },
  allow: { outbound: true, inbound: false }, proposer: 'remote',
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z',
  ...over,
});

function linksProps(over: Partial<A2aLinksViewProps> = {}): A2aLinksViewProps {
  return {
    links: [], pcNames: { [HOST]: 'DESK' }, workspaces: [], localRepos: {}, busy: null, confirming: null, error: null,
    onAccept: () => undefined, onReject: () => undefined, onAskRevoke: () => undefined, onCancelRevoke: () => undefined,
    onRevoke: () => undefined, onCheck: () => undefined, t, ...over,
  };
}

describe('A2aLinksView', () => {
  it('draws nothing with no link', () => {
    const el = document.createElement('div');
    roots.push({ root: createRoot(el), el });
    act(() => roots[roots.length - 1].root.render(createElement(A2aLinksView, linksProps())));
    expect(el.innerHTML).toBe('');
  });

  it('a request card shows both sides, the direction and a repo mismatch, and accepts', () => {
    const onAccept = vi.fn();
    const body = render(createElement(A2aLinksView, linksProps({
      links: [link()], localRepos: { 'w1/p1': 'x/o/api' }, onAccept,
    })));
    const card = body.querySelector('[data-testid="a2a-link-requests"]')!;
    expect(card.textContent).toContain('a2aLink.requestTitle(DESK)');
    expect(card.textContent).toContain('DESK/Web/w2-1');
    expect(card.textContent).toContain('a2aLink.dirSend');
    expect(body.querySelector('[data-testid="a2a-link-request-mismatch"]')).not.toBeNull();
    act(() => (body.querySelector('[data-testid="a2a-link-accept"]') as HTMLButtonElement).click());
    expect(onAccept).toHaveBeenCalledWith(link().linkId);
  });

  it('a request card marks the other PC\'s fields as reported, renders them as text, and names this PC\'s pane by the stored ids', () => {
    const ws = {
      id: 'w1', name: 'API', wsOrdinal: 3, activePaneId: 'p1',
      rootPane: { id: 'p1', type: 'leaf' as const, surfaces: [], activeSurfaceId: '', ordinal: 2, metadata: { label: 'build' } },
    };
    const body = render(createElement(A2aLinksView, linksProps({
      links: [link({ remote: { hostId: HOST, kind: 'pane', workspaceId: 'rw', paneId: 'rp', label: '<b>x</b>' } })],
      workspaces: [ws as never],
    })));
    const card = body.querySelector('[data-testid="a2a-link-requests"]')!;
    expect(card.querySelector('[data-testid="a2a-link-reported"]')?.textContent).toBe('a2aLink.reportedBy(DESK)');
    expect(card.querySelector('b')).toBeNull();
    expect(card.textContent).toContain('<b>x</b>');
    expect(card.textContent).toContain('a2aLink.yourPane(API / build)');
  });

  it('offers Check on a live link this PC proposed, not on one it received', () => {
    const body = render(createElement(A2aLinksView, linksProps({
      links: [link({ state: 'active', proposer: 'local' }), link({ linkId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', state: 'active', proposer: 'remote', local: { kind: 'pane', workspaceId: 'w2', paneId: 'p2' } })],
    })));
    const checks = [...body.querySelectorAll('[data-testid="a2a-link-list"] button')].filter((b) => b.textContent === 'a2aLink.check');
    expect(checks).toHaveLength(1);
  });

  it('a Moa request card says Moa <-> Moa', () => {
    const body = render(createElement(A2aLinksView, linksProps({
      links: [link({ local: { kind: 'brain', workspaceId: 'hq' }, remote: { hostId: HOST, kind: 'brain', workspaceId: 'rhq' } })],
    })));
    const card = body.querySelector('[data-testid="a2a-link-requests"]')!;
    expect(card.textContent).toContain('a2aLink.moaRequestTitle(DESK)');
    expect(card.textContent).toContain('DESK/Moa');
    expect(card.textContent).toContain('a2aLink.thisMoa');
  });

  it('offers "Link Moa" only when this PC has a Moa, even with no link yet', () => {
    const onLinkMoa = vi.fn();
    const body = render(createElement(A2aLinksView, linksProps({ onLinkMoa })));
    act(() => (body.querySelector('[data-testid="a2a-link-moa"]') as HTMLButtonElement).click());
    expect(onLinkMoa).toHaveBeenCalledOnce();
  });

  it('lists links with their state; unlinking asks twice', () => {
    const onAskRevoke = vi.fn();
    const active = link({ state: 'active', version: 2 });
    const body = render(createElement(A2aLinksView, linksProps({ links: [active, link({ linkId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'broken', endedReason: 'pane-closed' })], onAskRevoke })));
    const list = body.querySelector('[data-testid="a2a-link-list"]')!;
    expect([...list.querySelectorAll('[data-state]')].map((b) => b.getAttribute('data-state'))).toEqual(['active', 'broken']);
    expect(list.textContent).toContain('a2aLink.ended.pane-closed');
    const unlink = [...list.querySelectorAll('button')].find((b) => b.textContent === 'a2aLink.unlink')!;
    act(() => unlink.click());
    expect(onAskRevoke).toHaveBeenCalledWith(active.linkId);
  });
});
