// @vitest-environment jsdom
// The Remote rail page: this computer on one line, a Needs you block while
// something waits on a person, then one list of every connection. No secret
// or full id on screen, removals ask twice, and the page re-reads while shown.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import RemotePage, { REMOTE_PAGE_POLL_MS } from '../RemotePage';
import type { A2aLinkRecordV1 } from '../../../../shared/a2aRemote';
import type { A2aRemoteHostStatus } from '../../../../shared/rpc';
import type { Task } from '../../../../shared/types';

const DEVICE_ID = '9c1e77b0-4d2e-4a10-b6c7-d8e9f0a1b2c3';
const HOST = '11111111-1111-4111-8111-111111111111';
const PEER_HOST = '22222222-2222-4222-8222-222222222222';
let container: HTMLDivElement;
let root: Root;
type Fns = Record<string, ReturnType<typeof vi.fn>>;
let api: { web: Fns; remote: Fns; lanlink: Fns; a2aRemote: Fns };

const link = (over: Partial<A2aLinkRecordV1> = {}): A2aLinkRecordV1 => ({
  v: 1, linkId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1, state: 'proposed-in',
  local: { kind: 'pane', workspaceId: 'w1', paneId: 'p1' },
  remote: { hostId: HOST, kind: 'pane', workspaceId: 'rw', paneId: 'rp', workspaceName: 'Web', label: 'claude' },
  allow: { outbound: true, inbound: true }, proposer: 'remote',
  createdAt: new Date(Date.now() - 120_000).toISOString(), updatedAt: '2026-10-07T00:00:00.000Z',
  ...over,
});
const held = (id: string): Task => ({
  id, kind: 'task', status: { state: 'submitted', timestamp: new Date().toISOString() }, history: [],
  metadata: {
    title: 'check the CI log', from: { workspaceId: 'remote:l1', name: 'office-win/API/codex' },
    to: { workspaceId: 'w1', name: 'B', paneId: 'p1' },
    remote: { v: 1, linkId: 'l1', hostId: PEER_HOST, messageId: 'm', direction: 'inbound', delivered: false, held: 'pane-missing' },
  },
}) as unknown as Task;

interface A2aSeed {
  links?: A2aLinkRecordV1[];
  hosts?: A2aRemoteHostStatus[];
  held?: Task[];
}

function stub(devices: unknown[], a2a: A2aSeed = {}, extra: { remoteHosts?: unknown[] } = {}) {
  api = {
    web: {
      status: vi.fn(async () => ({
        running: true, host: '127.0.0.1', port: 7681, allowInput: false, token: 'SECRET-TOKEN',
        urls: ['http://127.0.0.1:7681/?token=SECRET-TOKEN'],
      })),
      deviceList: vi.fn(async () => ({ devices })),
      deviceRevoke: vi.fn(async () => ({ ok: true })),
    },
    remote: {
      hostsList: vi.fn(async () => extra.remoteHosts ?? []),
      hostsStatus: vi.fn(async () => ({})),
      hostsRemove: vi.fn(),
      workspacesList: vi.fn(async () => ({ ok: true, workspaces: [{ id: 'rws-1', name: 'backend', panes: [{ sessionId: 's1' }] }] })),
    },
    lanlink: { peersList: vi.fn(async () => ({ peers: [] })), peersRemove: vi.fn() },
    a2aRemote: {
      status: vi.fn(async () => ({ enabled: true, port: 45660, listening: true, hostId: 'me', name: 'MacBook', fingerprint256: 'A7:0D:5E:91:C2:38:4B:F0', lastError: null })),
      linksList: vi.fn(async () => ({ links: a2a.links ?? [] })),
      hostsStatus: vi.fn(async () => ({ hosts: a2a.hosts ?? [] })),
      heldList: vi.fn(async () => ({ tasks: a2a.held ?? [] })),
      hostsList: vi.fn(async () => ({
        hosts: (a2a.hosts ?? []).filter((h) => h.role === 'joiner').map((h) => ({
          v: 1, hostId: h.hostId, name: h.name, addresses: ['desk.tail1.ts.net'], port: 45660, fingerprint256: '3F:9A:12:C0:7B:E4:91:0D:AA', peerId: 'x', createdAt: '',
        })),
      })),
      peersList: vi.fn(async () => ({
        peers: (a2a.hosts ?? []).filter((h) => h.role === 'server').map((h) => ({ v: 1, peerId: `peer-${h.hostId}`, hostId: h.hostId, name: h.name, createdAt: '' })),
      })),
      linksAccept: vi.fn(async () => ({ ok: true })),
      linksReject: vi.fn(async () => ({ ok: true })),
      linksRevoke: vi.fn(async () => ({ ok: true })),
      heldRetry: vi.fn(async () => ({ ok: true, results: [] })),
      heldReject: vi.fn(async () => ({ ok: true })),
      hostsRemove: vi.fn(async () => ({ ok: true })),
      peersRevoke: vi.fn(async () => ({ ok: true })),
    },
  };
  vi.stubGlobal('electronAPI', { platform: 'darwin', ...api });
  vi.stubGlobal('clipboardAPI', { readText: vi.fn(async () => ''), writeText: vi.fn(async () => undefined) });
}

async function render() {
  await act(async () => root.render(<RemotePage />));
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const $ = <E extends Element = HTMLElement>(sel: string) => container.querySelector<E>(sel);
const byText = (sel: string, text: string) => [...container.querySelectorAll<HTMLButtonElement>(sel)].find((b) => b.textContent === text);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = {
    id: 'w1', name: 'api', wsOrdinal: 1, activePaneId: 'p1',
    rootPane: { id: 'p1', type: 'leaf', ordinal: 1, metadata: { label: 'build' }, activeSurfaceId: 's1', surfaces: [{ id: 's1', ptyId: 'pty-1' }] },
  };
  useStore.setState({
    remoteWorkspaces: [], workspaces: [ws as never], moa: null, appRoute: 'remote',
    a2aRemote: { links: [], hosts: [], held: [], joined: [], peers: [], loaded: false },
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Remote page', () => {
  it('sums up, shows this computer on one line and each phone with what it is viewing, without secrets or full ids', async () => {
    stub([{ deviceId: DEVICE_ID, name: 'Demo iPhone', kind: 'phone', createdAt: 1, lastSeenAt: Date.now(), allowInput: true, activeNow: true, viewingSessions: ['pty-1'] }]);
    await render();
    expect($('[data-remote-summary]')?.textContent).toBe('1 of 1 phones connected');
    expect($('[data-remote-machine]')?.textContent).toContain('MacBook');
    expect($('[data-remote-server]')?.textContent).toBe('Phone access: This computer only');
    expect($('[data-remote-a2a]')?.textContent).toBe('A2A :45660 listening');
    const phone = $('[data-remote-entry="phone"]')!;
    expect(phone.getAttribute('data-live')).toBe('true');
    expect(phone.querySelector('[data-remote-viewing]')?.textContent).toBe('Viewing api / build · Can type once input is on');
    // Phones have a direct Revoke, no ⋯ menu.
    expect(phone.querySelector('[data-remote-menu]')).toBeNull();
    expect($('[data-remote-address]')).toBeNull();
    act(() => $<HTMLButtonElement>('[data-remote-details]')!.click());
    expect($('[data-remote-address]')?.textContent).toBe('http://127.0.0.1:7681');
    expect($('[data-remote-fingerprint]')?.textContent).toBe('A7:0D:5E:91:C2:38:4B:F0');
    const text = container.textContent ?? '';
    expect(text).not.toContain(DEVICE_ID);
    expect(text).not.toContain('SECRET-TOKEN');
    expect($('[data-remote-activity]')?.textContent).toContain('Paired Demo iPhone');
    // Nothing waits: no Needs you block, no orange.
    expect($('[data-remote-needs]')).toBeNull();
  });

  it('Escape returns to Workspaces, after cancelling an open confirmation', async () => {
    stub([{ deviceId: DEVICE_ID, name: 'Old laptop', kind: 'computer', createdAt: 1, lastSeenAt: 1, allowInput: false }]);
    await render();
    const escape = (from: Element) => act(() => {
      from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    act(() => $<HTMLButtonElement>('[data-remote-remove="computer"]')!.click());
    const confirm = $<HTMLButtonElement>('[data-remote-confirm="computer"]')!;
    expect(confirm.textContent).toBe('Revoke for good?');
    escape(confirm);
    expect($('[data-remote-confirm="computer"]')).toBeNull();
    expect(useStore.getState().appRoute).toBe('remote');
    escape($('[data-remote-remove="computer"]')!);
    expect(useStore.getState().appRoute).toBe('workspaces');
    expect(api.web.deviceRevoke).not.toHaveBeenCalled();
  });

  it('Escape leaves the page alone while the palette or notifications are open', async () => {
    stub([]);
    await render();
    const title = $('#remote-page-title')!;
    for (const over of [{ commandPaletteVisible: true }, { notificationPanelVisible: true }]) {
      useStore.setState({ commandPaletteVisible: false, notificationPanelVisible: false, ...over });
      act(() => { title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
      expect(useStore.getState().appRoute).toBe('remote');
    }
    useStore.setState({ commandPaletteVisible: false, notificationPanelVisible: false });
  });

  it('revokes only on the second click', async () => {
    stub([{ deviceId: DEVICE_ID, name: 'Old laptop', kind: 'computer', createdAt: 1, lastSeenAt: 1, allowInput: false }]);
    await render();
    act(() => $<HTMLButtonElement>('[data-remote-remove="computer"]')!.click());
    expect(api.web.deviceRevoke).not.toHaveBeenCalled();
    await act(async () => { $<HTMLButtonElement>('[data-remote-confirm="computer"]')!.click(); });
    expect(api.web.deviceRevoke).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('explains how to connect a PC when nothing is, and re-reads on an interval', async () => {
    stub([]);
    await render();
    const empty = $('[data-remote-empty]')!;
    expect(empty.textContent).toContain('Connect another PC');
    expect(empty.querySelector('.ui-btn-primary')?.textContent).toBe('Connect a PC…');
    expect($('[data-remote-summary]')?.textContent).toBe('Nothing connected yet');
    expect(api.web.deviceList).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(REMOTE_PAGE_POLL_MS); });
    expect(api.web.deviceList).toHaveBeenCalledTimes(2);
    expect(api.a2aRemote.linksList).toHaveBeenCalledTimes(2);
  });

  it('accepts or declines a link request from the Needs you block; only the first Accept is primary', async () => {
    const second = link({ linkId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    stub([], { links: [link(), second], hosts: [{ hostId: HOST, name: 'DESK', role: 'joiner', state: 'connected', pending: 0 }] });
    await render();
    const needs = $('[data-remote-needs]')!;
    expect(needs.parentElement?.getAttribute('aria-live')).toBe('polite');
    expect(needs.textContent).toContain('DESK wants to link its Web/claude with this PC\'s api / build.');
    expect(needs.textContent).toContain('2m');
    expect(needs.textContent).toContain('3F:9A:12:C0:7B:E4…');
    const accepts = [...needs.querySelectorAll<HTMLButtonElement>('[data-testid="a2a-link-accept"]')];
    expect(accepts.map((b) => b.className.includes('ui-btn-primary'))).toEqual([true, false]);
    expect(container.querySelectorAll('.ui-btn-primary')).toHaveLength(1);
    await act(async () => { accepts[0].click(); });
    expect(api.a2aRemote.linksAccept).toHaveBeenCalledWith(link().linkId);
    await act(async () => { byText('[data-remote-needs] button', 'Decline')!.click(); });
    expect(api.a2aRemote.linksReject).toHaveBeenCalledWith(link().linkId);
  });

  it('delivers held work to the pane now, or sends it back', async () => {
    stub([], { held: [held('rt-1')], hosts: [{ hostId: PEER_HOST, name: 'office-win', role: 'server', state: 'disconnected', pending: 2 }] });
    await render();
    const row = $('[data-testid="a2a-held"]')!;
    expect(row.textContent).toContain('Work from office-win is on hold');
    expect(row.textContent).toContain('“check the CI log”');
    await act(async () => { row.querySelector<HTMLButtonElement>('[data-testid="a2a-delivery-retry"]')!.click(); });
    expect(api.a2aRemote.heldRetry).toHaveBeenCalledWith('rt-1');
    await act(async () => { $<HTMLButtonElement>('[data-testid="a2a-delivery-reject"]')!.click(); });
    expect(api.a2aRemote.heldReject).toHaveBeenCalledWith('rt-1');
    // The PC row says what it still owes.
    expect($(`[data-remote-pc="${PEER_HOST}"]`)?.textContent).toContain('Messages to send 2');
  });

  it('a PC whose certificate changed says how many links removing it ends, and Pair again opens the right tab', async () => {
    stub([], {
      links: [link({ state: 'active' })],
      hosts: [{ hostId: HOST, name: 'DESK', role: 'joiner', state: 'identity-changed', pending: 0 }],
    });
    await render();
    const row = $('[data-testid="a2a-identity"]')!;
    expect(row.querySelector('[data-testid="a2a-identity-links"]')?.textContent).toBe('Removing it ends 1 link(s).');
    await act(async () => { row.querySelector<HTMLButtonElement>('[data-testid="a2a-identity-pair-again"]')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    // This PC joined DESK: DESK has to send a new invite.
    expect(document.querySelector('[data-testid="remote-connect-paste"]')).not.toBeNull();
  });

  it('nests a PC\'s links under it, unlinks on the second click, and names the ⋯ menu after the PC', async () => {
    stub([], { links: [link({ state: 'active' })], hosts: [{ hostId: HOST, name: 'DESK', role: 'joiner', state: 'connected', pending: 0 }] });
    await render();
    const pc = $(`[data-remote-pc="${HOST}"]`)!;
    expect(pc.textContent).toContain('desk.tail1.ts.net · Pane links 1');
    expect(pc.textContent).toContain('Connected');
    // Tailscale is the default path: no path chip.
    expect(pc.textContent).not.toContain('LAN');
    const menu = pc.querySelector<HTMLButtonElement>('[data-remote-menu]')!;
    expect(menu.getAttribute('aria-label')).toBe('DESK: more actions');
    act(() => menu.click());
    expect([...container.querySelectorAll('[data-remote-menu-item]')].map((i) => i.getAttribute('data-remote-menu-item'))).toEqual(['link', 'remove']);
    const linkRow = $('[data-testid="a2a-link-row"]')!;
    expect(linkRow.textContent).toContain('api / build ↔ DESK/Web/claude · Both ways');
    act(() => byText('[data-testid="a2a-link-row"] button', 'Unlink')!.click());
    expect(api.a2aRemote.linksRevoke).not.toHaveBeenCalled();
    await act(async () => { byText('[data-testid="a2a-link-row"] .ui-btn-danger', 'Unlink')!.click(); });
    expect(api.a2aRemote.linksRevoke).toHaveBeenCalledWith(link().linkId);
  });

  it('opens a workspace share in place and attaches the workspace picked there', async () => {
    stub([], {}, { remoteHosts: [{ id: 'host-1', label: 'wy-mini', origin: 'https://wy-mini.ts.net', addedAt: 1, allowInput: true }] });
    await render();
    const row = $('[data-remote-entry="host"]')!;
    expect(row.textContent).toContain('Workspace share');
    await act(async () => { row.querySelector<HTMLButtonElement>('[data-remote-open="host-1"]')!.click(); });
    expect(api.remote.workspacesList).toHaveBeenCalledWith('host-1');
    const ws = $('[data-remote-workspace="rws-1"]')!;
    expect(ws.textContent).toContain('backend');
    act(() => ws.querySelector('button')!.click());
    expect(useStore.getState().remoteWorkspaces.map((w) => w.key)).toEqual(['host-1:rws-1']);
    expect(useStore.getState().appRoute).toBe('workspaces');
  });
});
