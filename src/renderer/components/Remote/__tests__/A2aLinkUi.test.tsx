// @vitest-environment jsdom
//
// Cross-PC pane link UI: the matching dialog (same-repo panes first, repo
// mismatch warning, directions) and the Remote page's request rows (Needs
// you) and nested link rows. Pure views, rendered with stub `t`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement, type ReactElement } from 'react';
import type { A2aExposedPane, A2aLinkRecordV1 } from '../../../../shared/a2aRemote';
import { A2aLinkDialogView, type A2aLinkDialogViewProps } from '../A2aLinkDialog';
import { A2aLinkRequestRow, A2aLinkRow, type A2aLinkRequestRowProps, type A2aLinkRowProps } from '../A2aLinksPanel';
import { autoPickPane, rankExposedPanes, remoteAlias, repoMismatch } from '../a2aLinkModel';

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

  it('picks a pane by itself only when there is one choice or one on my repo', () => {
    expect(autoPickPane(rankExposedPanes([pane('a', 'x/o/web')], 'x/o/api'), 'pane')?.paneId).toBe('a');
    expect(autoPickPane(rankExposedPanes([pane('a', 'x/o/web'), pane('b', 'x/o/api')], 'x/o/api'), 'pane')?.paneId).toBe('b');
    expect(autoPickPane(rankExposedPanes([pane('a', 'x/o/api'), pane('b', 'x/o/api')], 'x/o/api'), 'pane')).toBeNull();
    expect(autoPickPane(rankExposedPanes([pane('a'), pane('b')], null), 'pane')).toBeNull();
    // Moa links only with Moa: the panes do not count as choices.
    const moa: A2aExposedPane = { kind: 'brain', workspaceId: 'hq', workspaceName: 'Moa' };
    expect(autoPickPane(rankExposedPanes([moa, pane('a')], null), 'brain')).toBe(moa);
    expect(autoPickPane(null, 'pane')).toBeNull();
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

  it('offers this PC\'s panes when opened without one, and reports the pick', () => {
    const onPickLocal = vi.fn();
    const body = render(createElement(A2aLinkDialogView, dialogProps({
      localChoices: [{ key: 'w1/p1', label: 'API / build' }, { key: 'w2/p2', label: 'Web / w2-1' }],
      localKey: 'w1/p1', onPickLocal,
    })));
    const select = body.querySelector('[data-testid="a2a-link-local"]') as HTMLSelectElement;
    expect(select.value).toBe('w1/p1');
    act(() => {
      select.value = 'w2/p2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onPickLocal).toHaveBeenCalledWith('w2/p2');
  });

  it('says so when that PC shows nothing', () => {
    const body = render(createElement(A2aLinkDialogView, dialogProps({ panes: [] })));
    expect(body.querySelector('[data-testid="a2a-link-none-exposed"]')).not.toBeNull();
  });
});

const HOST2 = '22222222-2222-4222-8222-222222222222';
const HOST3 = '33333333-3333-4333-8333-333333333333';
const host = (hostId: string, name: string) => ({ v: 1 as const, hostId, name, addresses: [name], port: 45660, fingerprint256: 'AA', peerId: name, createdAt: '' });
function key(el: Element, k: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  act(() => { el.dispatchEvent(e); });
  return e;
}
const tabStops = (root: Element, role: string) =>
  [...root.querySelectorAll(`[role="${role}"]`)].map((el) => el.getAttribute('tabindex'));

describe('A2aLinkDialogView keyboard', () => {
  it('the PC picker is one Tab stop; arrows move and select, wrapping; Home/End jump', () => {
    const onPickHost = vi.fn();
    const body = render(createElement(A2aLinkDialogView, dialogProps({
      hosts: [host(HOST, 'DESK'), host(HOST2, 'LAPTOP'), host(HOST3, 'MINI')], hostId: HOST2, onPickHost,
    })));
    const radios = [...body.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(tabStops(body, 'radio')).toEqual(['-1', '0', '-1']);
    radios[1].focus();
    expect(key(radios[1], 'ArrowRight').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(radios[2]);
    expect(onPickHost).toHaveBeenLastCalledWith(HOST3);
    key(radios[2], 'ArrowDown');
    expect(document.activeElement).toBe(radios[0]);
    expect(onPickHost).toHaveBeenLastCalledWith(HOST);
    key(radios[0], 'ArrowLeft');
    expect(onPickHost).toHaveBeenLastCalledWith(HOST3);
    key(radios[2], 'ArrowUp');
    expect(onPickHost).toHaveBeenLastCalledWith(HOST2);
    key(radios[1], 'End');
    expect(document.activeElement).toBe(radios[2]);
    key(radios[2], 'Home');
    expect(document.activeElement).toBe(radios[0]);
    expect(onPickHost).toHaveBeenLastCalledWith(HOST);
    expect(key(radios[0], 'a').defaultPrevented).toBe(false);
  });

  it('with no PC picked yet, the first PC is the Tab stop', () => {
    const body = render(createElement(A2aLinkDialogView, dialogProps({ hosts: [host(HOST, 'DESK'), host(HOST2, 'LAPTOP')], hostId: null })));
    expect(tabStops(body, 'radio')).toEqual(['0', '-1']);
  });

  it('the pane list is one Tab stop; arrows move the active option without picking it', () => {
    const onPickPane = vi.fn();
    const body = render(createElement(A2aLinkDialogView, dialogProps({
      panes: rankExposedPanes([pane('a'), pane('b'), pane('c')], null), selected: pane('b'), onPickPane,
    })));
    const options = () => [...body.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    // The picked pane holds the Tab stop.
    expect(tabStops(body, 'option')).toEqual(['-1', '0', '-1']);
    act(() => options()[1].focus());
    expect(key(options()[1], 'ArrowDown').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(options()[2]);
    // The Tab stop follows the active option while focus is in the list.
    expect(tabStops(body, 'option')).toEqual(['-1', '-1', '0']);
    key(options()[2], 'ArrowDown');
    expect(document.activeElement).toBe(options()[2]);
    key(options()[2], 'Home');
    expect(document.activeElement).toBe(options()[0]);
    key(options()[0], 'ArrowUp');
    expect(document.activeElement).toBe(options()[0]);
    key(options()[0], 'End');
    expect(document.activeElement).toBe(options()[2]);
    expect(onPickPane).not.toHaveBeenCalled();
    // Leaving the list hands the Tab stop back to the picked pane.
    act(() => (body.querySelector('[data-testid="a2a-link-propose"]') as HTMLButtonElement).focus());
    expect(tabStops(body, 'option')).toEqual(['-1', '0', '-1']);
  });

  it('Enter and Space are left to the option button, which picks the active pane', () => {
    const onPickPane = vi.fn();
    const body = render(createElement(A2aLinkDialogView, dialogProps({
      panes: rankExposedPanes([pane('a'), pane('b')], null), onPickPane,
    })));
    const options = [...body.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(tabStops(body, 'option')).toEqual(['0', '-1']);
    act(() => options[0].focus());
    key(options[0], 'ArrowDown');
    // Not prevented, so the browser's own button activation runs (jsdom
    // does not synthesize it); that activation is the click below.
    expect(key(options[1], 'Enter').defaultPrevented).toBe(false);
    expect(key(options[1], ' ').defaultPrevented).toBe(false);
    expect(options[1].type).toBe('button');
    act(() => options[1].click());
    expect(onPickPane).toHaveBeenCalledWith(pane('b'));
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

function requestProps(over: Partial<A2aLinkRequestRowProps> = {}): A2aLinkRequestRowProps {
  return {
    link: link(), pcName: 'DESK', names: { workspaces: [] }, now: Date.parse('2026-10-07T00:02:00.000Z'),
    primary: true, busy: false, onAccept: () => undefined, onReject: () => undefined, t, ...over,
  };
}
const inList = (el: ReactElement) => createElement('ul', null, el);

describe('A2aLinkRequestRow', () => {
  it('names both ends in one sentence with the evidence, flags a repo mismatch, and accepts', () => {
    const onAccept = vi.fn();
    const body = render(inList(createElement(A2aLinkRequestRow, requestProps({ localRepo: 'x/o/api', fingerprint: '3F:9A:12:C0:7B:E4:91:0D', onAccept }))));
    const row = body.querySelector('[data-testid="a2a-link-request"]')!;
    expect(row.textContent).toContain('remotePage.needs.linkSentence(DESK,Web/w2-1,w1 / p1)');
    expect(row.textContent).toContain('3F:9A:12:C0:7B:E4…');
    expect(row.textContent).toContain('a2aLink.dirSend');
    expect(row.querySelector('[data-testid="a2a-link-request-mismatch"]')?.textContent).toBe('a2aLink.repoMismatch(x/o/api,x/o/web)');
    expect(row.querySelector('[data-testid="a2a-link-same-repo"]')).toBeNull();
    const accept = row.querySelector('[data-testid="a2a-link-accept"]') as HTMLButtonElement;
    expect(accept.className).toContain('ui-btn-primary');
    act(() => accept.click());
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it('says so when the panes share a repo; a later request is not the primary', () => {
    const body = render(inList(createElement(A2aLinkRequestRow, requestProps({ localRepo: 'x/o/web', primary: false }))));
    expect(body.querySelector('[data-testid="a2a-link-same-repo"]')?.textContent).toBe('remotePage.needs.sameRepo(x/o/web)');
    expect(body.querySelector('[data-testid="a2a-link-request-mismatch"]')).toBeNull();
    expect((body.querySelector('[data-testid="a2a-link-accept"]') as HTMLElement).className).not.toContain('ui-btn-primary');
  });

  it('renders what the other PC reports as text, marked as theirs, and names this PC\'s pane by the stored ids', () => {
    const ws = {
      id: 'w1', name: 'API', wsOrdinal: 3, activePaneId: 'p1',
      rootPane: { id: 'p1', type: 'leaf' as const, surfaces: [], activeSurfaceId: '', ordinal: 2, metadata: { label: 'build' } },
    };
    const body = render(inList(createElement(A2aLinkRequestRow, requestProps({
      link: link({ remote: { hostId: HOST, kind: 'pane', workspaceId: 'rw', paneId: 'rp', label: '<b>x</b>' } }),
      names: { workspaces: [ws as never] },
    }))));
    const row = body.querySelector('[data-testid="a2a-link-request"]')!;
    expect(row.querySelector('[data-testid="a2a-link-reported"]')?.textContent).toBe('remotePage.needs.reported(DESK)');
    expect(row.querySelector('b')?.textContent).toBe('DESK');
    expect(row.textContent).toContain('rw/<b>x</b>');
    expect(row.textContent).toContain('API / build');
  });

  it('a Moa request says Moa with Moa', () => {
    const body = render(inList(createElement(A2aLinkRequestRow, requestProps({
      link: link({ local: { kind: 'brain', workspaceId: 'hq' }, remote: { hostId: HOST, kind: 'brain', workspaceId: 'rhq' } }),
    }))));
    expect(body.textContent).toContain('remotePage.needs.moaSentence(DESK)');
  });
});

function rowProps(over: Partial<A2aLinkRowProps> = {}): A2aLinkRowProps {
  return {
    link: link({ state: 'active' }), pcName: 'DESK', names: { workspaces: [] }, confirming: false, busy: false,
    onCheck: () => undefined, onAskUnlink: () => undefined, onCancelUnlink: () => undefined, onUnlink: () => undefined, t, ...over,
  };
}

describe('A2aLinkRow', () => {
  it('shows a live link with its direction; Unlink asks first', () => {
    const onAskUnlink = vi.fn();
    const body = render(inList(createElement(A2aLinkRow, rowProps({ onAskUnlink }))));
    const row = body.querySelector('[data-testid="a2a-link-row"]')!;
    expect(row.textContent).toContain('w1 / p1 ↔ DESK/Web/w2-1 · a2aLink.dirSend');
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['a2aLink.unlink']);
    act(() => row.querySelector('button')!.click());
    expect(onAskUnlink).toHaveBeenCalledOnce();
  });

  it('a link this PC proposed waits for the other PC, with Check', () => {
    const body = render(inList(createElement(A2aLinkRow, rowProps({ link: link({ state: 'proposed-out', proposer: 'local' }) }))));
    const row = body.querySelector('[data-testid="a2a-link-row"]')!;
    expect(row.getAttribute('data-state')).toBe('pending');
    expect(row.textContent).toContain('remotePage.linkWaiting(DESK)');
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['a2aLink.check', 'a2aLink.unlink']);
  });

  it('the confirm unlinks', () => {
    const onUnlink = vi.fn();
    const body = render(inList(createElement(A2aLinkRow, rowProps({ confirming: true, onUnlink }))));
    act(() => (body.querySelector('[data-testid="a2a-link-row"] .ui-btn-danger') as HTMLButtonElement).click());
    expect(onUnlink).toHaveBeenCalledOnce();
  });
});
