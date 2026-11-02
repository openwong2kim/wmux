// @vitest-environment jsdom
//
// "Add a seat on another PC…": the PCs it may ask (and why none, with a way
// to the Remote page), the exact ask Send makes (replies to the CEO pane, the
// seat name as the label, the seat intro as the first message), the review
// step when the final pass would change that message, the seat name's rules,
// and no ask at all while the CEO seat is vacant.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import type { Pane, Surface, Workspace } from '../../../../shared/types';
import type { A2aSpawnAskResult, A2aSpawnOutgoingList, A2aSpawnPlace, A2aSpawnUiAsk } from '../../../../shared/a2aSpawn';
import { remoteSeatIntro } from '../../../../shared/company';
import { finalizeSpawnPrompt } from '../../../../shared/a2aSpawnPrompt';
import AddRemoteSeatDialog, { defaultSeatName } from '../AddRemoteSeatDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DESK = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const LAPTOP = '7a2b3c4d-5e6f-4a70-8b8c-9d0e1f2a3b4c';
const OLD = '8b3c4d5e-6f70-4b81-9c9d-0e1f2a3b4c5d';
const desk: A2aSpawnPlace = {
  hostId: DESK, name: 'DESK', online: true, supported: true,
  targets: { v: 1, version: 3, roots: [{ id: 'web', label: 'Web app' }, { id: 'api', label: 'API' }], agents: ['claude', 'codex'] },
};
const laptop: A2aSpawnPlace = { ...desk, hostId: LAPTOP, name: 'LAPTOP', online: false };
const old: A2aSpawnPlace = { hostId: OLD, name: 'OLD', online: true, supported: false };
const closed: A2aSpawnPlace = { hostId: LAPTOP, name: 'LAPTOP', online: true, supported: true, targets: { v: 1, version: 4, roots: [], agents: ['claude'] } };

const surface = (id: string, ptyId: string): Surface => ({ id, ptyId, title: '', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal' });
const leaf = (id: string, ordinal: number, s: Surface): Pane => ({ id, type: 'leaf', ordinal, surfaces: [s], activeSurfaceId: s.id }) as Pane;
const company = (coordinatorPaneId: string | null): Workspace => ({
  id: 'ws-co',
  name: 'Acme',
  wsOrdinal: 1,
  activePaneId: 'p1',
  company: { v: 1, id: 'co-1', coordinatorPaneId, mission: 'Ship it', standingOrders: 'Live check first.' },
  rootPane: {
    id: 'split', type: 'branch', direction: 'horizontal', sizes: [50, 50],
    children: [leaf('p1', 1, surface('s1', 'pty-1')), leaf('p2', 2, surface('s2', 'pty-2'))],
  } as unknown as Pane,
}) as Workspace;

let el: HTMLDivElement;
let root: Root;
let outgoing: A2aSpawnOutgoingList;
let spawnAsk: ReturnType<typeof vi.fn<(ask: A2aSpawnUiAsk) => Promise<A2aSpawnAskResult>>>;
const onClose = vi.fn();

const q = <E extends Element = HTMLElement>(id: string) => document.body.querySelector<E>(`[data-testid="${id}"]`);
const qa = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const send = () => q<HTMLButtonElement>('add-remote-seat-send');
const text = () => q<HTMLTextAreaElement>('add-remote-seat-text')?.value;

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};

async function render(): Promise<void> {
  act(() => root.render(createElement(AddRemoteSeatDialog, { workspaceId: 'ws-co', onClose })));
  await flush();
}

function type(id: string, value: string): void {
  const node = q<HTMLInputElement>(id)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pick(id: string, value: string): void {
  const node = q<HTMLSelectElement>(id)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  outgoing = { requests: [], places: [desk, laptop, old] };
  spawnAsk = vi.fn<(ask: A2aSpawnUiAsk) => Promise<A2aSpawnAskResult>>();
  onClose.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    a2aRemote: {
      spawnAsk,
      spawnOutgoing: () => Promise.resolve(outgoing),
      onLinkEvent: () => () => undefined,
    },
  };
  act(() => useStore.setState({
    ...useStore.getInitialState(),
    locale: 'en',
    workspaces: [company('p1')],
    activeWorkspaceId: 'ws-co',
    paneLabel: { p1: 'pm', p2: 'desk-dev' },
    surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'idle' } },
  }));
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});

afterEach(() => {
  act(() => root.unmount());
  el.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('AddRemoteSeatDialog', () => {
  it('offers the PCs this PC may ask, and says why for each when none can be asked, with the way to the Remote page', async () => {
    await render();
    expect([...q<HTMLSelectElement>('add-remote-seat-pc')!.options].map((o) => o.value)).toEqual([DESK, LAPTOP]);
    expect(q('add-remote-seat-block')).toBeNull();
    // The offline PC: the ask still goes and waits for it.
    pick('add-remote-seat-pc', LAPTOP);
    expect(q('add-remote-seat-offline')).not.toBeNull();
    expect(send()).not.toBeNull();

    outgoing = { requests: [], places: [old, closed] };
    act(() => root.unmount());
    root = createRoot(el);
    await render();
    expect(qa('add-remote-seat-block').map((n) => n.dataset.block)).toEqual(['unsupported', 'nothing']);
    expect(qa('add-remote-seat-block')[0].textContent).toBe("OLD's wmux cannot start agents for other PCs yet.");
    expect(q('add-remote-seat-pc')).toBeNull();
    expect(send()).toBeNull();
    act(() => { q<HTMLButtonElement>('add-remote-seat-open-remote')!.click(); });
    expect(onClose).toHaveBeenCalled();
    expect(useStore.getState().appRoute).toBe('remote');
  });

  it('asks with replies to the CEO pane, the seat name as the label, and the seat intro exactly as shown', async () => {
    spawnAsk.mockResolvedValue({ ok: true, online: true, spawn: {} as never });
    await render();
    // The default name is free: `desk-dev` is a pane's label already.
    expect(q<HTMLInputElement>('add-remote-seat-name')?.value).toBe('desk-dev-2');
    pick('add-remote-seat-agent', 'codex');
    pick('add-remote-seat-root', 'api');
    type('add-remote-seat-sub', './packages//web/');
    pick('add-remote-seat-hours', '4');
    type('add-remote-seat-owns', 'Windows checks');
    const intro = remoteSeatIntro({
      name: 'desk-dev-2', company: 'Acme', mission: 'Ship it', owns: 'Windows checks',
      ceo: 'pm', standingOrders: 'Live check first.',
    });
    expect(text()).toBe(intro);
    expect(q<HTMLTextAreaElement>('add-remote-seat-text')?.readOnly).toBe(true);
    await act(async () => { send()!.click(); });
    expect(spawnAsk).toHaveBeenCalledWith({
      hostId: DESK,
      agent: 'codex',
      folder: { root: 'api', sub: 'packages/web' },
      text: intro,
      expiresInHours: 4,
      end: { workspaceId: 'ws-co', paneId: 'p1' },
      label: 'desk-dev-2',
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 1000 });
  });

  it('shows a message the final pass would change, and sends it only on the next Send', async () => {
    spawnAsk.mockResolvedValue({ ok: true, online: true, spawn: {} as never });
    await render();
    const bare = ['xK9mQ2pL7vR4nT8wZ3yB6c', 'F1hJ5'].join('');
    type('add-remote-seat-owns', `deploys with Bearer ${bare} on Fridays`);
    const before = text()!;
    expect(before).toContain(bare);
    expect(q('add-remote-seat-will-mask')).not.toBeNull();
    await act(async () => { send()!.click(); });
    expect(spawnAsk).not.toHaveBeenCalled();
    expect(text()).toBe(finalizeSpawnPrompt(before).text);
    expect(text()).not.toContain(bare);
    expect(q('add-remote-seat-reviewing')).not.toBeNull();
    await act(async () => { send()!.click(); });
    expect(spawnAsk.mock.calls[0][0].text).toBe(finalizeSpawnPrompt(before).text);
  });

  it('a retry of the same ask reuses its key; an edit makes a new one', async () => {
    spawnAsk.mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ ok: true, online: true, spawn: {} as never });
    await render();
    await act(async () => { send()!.click(); });
    await vi.waitFor(() => expect(q('add-remote-seat-error')).not.toBeNull(), { timeout: 1000 });
    await act(async () => { send()!.click(); });
    expect(spawnAsk.mock.calls[1][0].requestKey).toBe(spawnAsk.mock.calls[0][0].requestKey);
    type('add-remote-seat-owns', 'Builds');
    await act(async () => { send()!.click(); });
    expect(spawnAsk.mock.calls[2][0].requestKey).not.toBe(spawnAsk.mock.calls[0][0].requestKey);
  });

  it('holds the seat name to the pane-label rules and keeps it free', async () => {
    await render();
    for (const bad of ['w1-2', 'has space', '#pm', '9lives', 'PM']) {
      type('add-remote-seat-name', bad);
      expect(q('add-remote-seat-name-error'), bad).not.toBeNull();
      expect(send()?.disabled, bad).toBe(true);
    }
    type('add-remote-seat-name', '');
    expect(send()?.disabled).toBe(true);
    type('add-remote-seat-name', 'windows');
    expect(q('add-remote-seat-name-error')).toBeNull();
    expect(send()?.disabled).toBe(false);
  });

  it('keeps the name of an ask that may still start: waiting, or expired but still listed', async () => {
    const ask = (label: string, state: 'waiting' | 'expired' | 'refused') => ({
      hostId: DESK, spawnId: `sp-${label}`, agent: 'claude', rootId: 'web', from: { workspaceId: 'ws-co', paneId: 'p1' },
      label, state, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    }) as A2aSpawnOutgoingList['requests'][number];
    outgoing = { requests: [ask('builder', 'waiting'), ask('linux', 'expired'), ask('tester', 'refused')], places: [desk] };
    await render();
    for (const name of ['builder', 'linux']) {
      type('add-remote-seat-name', name);
      expect(q('add-remote-seat-name-error'), name).not.toBeNull();
    }
    type('add-remote-seat-name', 'tester');
    expect(q('add-remote-seat-name-error')).toBeNull();
  });

  it('asks nothing while the CEO seat is vacant', async () => {
    act(() => useStore.setState({ workspaces: [company(null)] }));
    await render();
    expect(q('add-remote-seat-no-ceo')).not.toBeNull();
    expect(q('add-remote-seat-pc')).toBeNull();
    expect(send()).toBeNull();
  });
});

describe('defaultSeatName', () => {
  it('makes a pane label of the PC\'s name, then -dev, free of the taken names', () => {
    expect(defaultSeatName('Linux build box', [])).toBe('linux-build-box-dev');
    expect(defaultSeatName('Linux build box', ['linux-build-box-dev'])).toBe('linux-build-box-dev-2');
    expect(defaultSeatName('2nd Mac', [])).toBe('pc-2nd-mac-dev');
    expect(defaultSeatName('W1-2', [])).toBe('pc-w1-2-dev');
    expect(defaultSeatName('  ', [])).toBe('seat-dev');
  });
});
