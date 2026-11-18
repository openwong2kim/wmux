// @vitest-environment jsdom
// The Remote rail page: this computer on one line, a Needs you block while
// something waits on a person, then one list of every connection. No secret
// or full id on screen, removals ask twice, and the page re-reads while shown.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import RemotePage, { REMOTE_PAGE_POLL_MS } from '../RemotePage';
import type { A2aLinkOfferRecordV1, A2aLinkRecordV1 } from '../../../../shared/a2aRemote';
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
const held = (id: string, reason = 'pane-missing'): Task => ({
  id, kind: 'task', status: { state: 'submitted', timestamp: new Date().toISOString() }, history: [],
  metadata: {
    title: 'check the CI log', from: { workspaceId: 'remote:l1', name: 'office-win/API/codex' },
    to: { workspaceId: 'w1', name: 'B', paneId: 'p1' },
    remote: { v: 1, linkId: 'l1', hostId: PEER_HOST, messageId: 'm', direction: 'inbound', delivered: false, held: reason },
  },
}) as unknown as Task;

interface A2aSeed {
  offers?: A2aLinkOfferRecordV1[];
  links?: A2aLinkRecordV1[];
  hosts?: A2aRemoteHostStatus[];
  held?: Task[];
  /** This PC's approvals setting; absent: the bridge has no approvals calls. */
  approvals?: { hosts: Record<string, string>; damaged?: boolean };
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
      deviceSetInput: vi.fn(async () => ({ ok: true, changed: true })),
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
      offersList: vi.fn(async () => ({ offers: a2a.offers ?? [] })),
      offersWithdraw: vi.fn(async () => ({ ok: false, error: 'invalid-state' })),
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
      ...(a2a.approvals ? {
        approvalsGet: vi.fn(async () => structuredClone(a2a.approvals)),
        approvalsSet: vi.fn(async (hostId: string, level: string) => {
          if (level === 'off') delete a2a.approvals!.hosts[hostId];
          else a2a.approvals!.hosts[hostId] = level;
          a2a.approvals!.damaged = false;
          return { ok: true };
        }),
      } : {}),
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
    remoteWorkspaces: [], workspaces: [ws as never], appRoute: 'remote',
    a2aRemote: { links: [], offers: [], hosts: [], held: [], joined: [], peers: [], loaded: false },
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
    expect($('[data-remote-a2a]')?.textContent).toBe('PC messages on · port 45660');
    const phone = $('[data-remote-entry="phone"]')!;
    expect(phone.getAttribute('data-live')).toBe('true');
    expect(phone.querySelector('[data-remote-viewing]')?.textContent).toBe('Viewing api / build · Can type once input is on');
    // Phones have a direct Revoke, no ⋯ menu.
    expect(phone.querySelector('[data-remote-menu]')).toBeNull();
    expect($('[data-remote-address]')).toBeNull();
    act(() => $<HTMLButtonElement>('[data-remote-details]')!.click());
    expect($('[data-remote-address]')?.textContent).toBe('http://127.0.0.1:7681');
    expect($('[data-remote-fingerprint]')?.textContent).toBe('A7:0D:5E:91:C2:38:4B:F0');
    // The port is a plain mono value, and connecting a computer lives in Connect a PC only.
    expect($('[data-remote-a2a-port]')?.tagName).toBe('CODE');
    expect($('[data-remote-add-host]')).toBeNull();
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

  it('Escape belongs to the open accept dialog of a shared pane, not the page', async () => {
    const offer: A2aLinkOfferRecordV1 = {
      v: 1, offerId: '33333333-3333-4333-8333-333333333333', side: 'in', hostId: HOST,
      end: { kind: 'pane', workspaceId: 'rw', workspaceName: 'Web', paneId: 'rp', label: 'claude' }, allow: { outbound: true, inbound: true },
      state: 'open', createdAt: '', updatedAt: '', expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    };
    stub([], { offers: [offer], hosts: [{ hostId: HOST, name: 'DESK', role: 'joiner', state: 'connected', pending: 0 }] });
    await render();
    await act(async () => { $<HTMLButtonElement>('[data-testid="a2a-offer-accept"]')!.click(); });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => { $('#remote-page-title')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(useStore.getState().appRoute).toBe('remote');
  });

  it('a failed Withdraw on a share row says why under that row', async () => {
    const share: A2aLinkOfferRecordV1 = {
      v: 1, offerId: '44444444-4444-4444-8444-444444444444', side: 'out', hostId: PEER_HOST,
      end: { kind: 'pane', workspaceId: 'w1', workspaceName: 'api', paneId: 'p1', label: 'build' }, allow: { outbound: true, inbound: true },
      state: 'open', createdAt: '', updatedAt: '', expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    };
    stub([], { offers: [share], hosts: [{ hostId: PEER_HOST, name: 'office-win', role: 'server', state: 'connected', pending: 0 }] });
    await render();
    const row = $('[data-testid="a2a-share-row"]')!;
    await act(async () => { row.querySelector<HTMLButtonElement>('[data-testid="a2a-share-row-withdraw"]')!.click(); });
    expect(api.a2aRemote.offersWithdraw).toHaveBeenCalledWith(share.offerId);
    expect($('[data-testid="a2a-share-row"] [role="alert"]')?.textContent).toBe('The link is no longer waiting for that.');
  });

  it('revokes only on the second click', async () => {
    stub([{ deviceId: DEVICE_ID, name: 'Old laptop', kind: 'computer', createdAt: 1, lastSeenAt: 1, allowInput: false }]);
    await render();
    act(() => $<HTMLButtonElement>('[data-remote-remove="computer"]')!.click());
    expect(api.web.deviceRevoke).not.toHaveBeenCalled();
    await act(async () => { $<HTMLButtonElement>('[data-remote-confirm="computer"]')!.click(); });
    expect(api.web.deviceRevoke).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('lets a view-only phone type after one confirmation that says what typing allows', async () => {
    stub([{ deviceId: DEVICE_ID, name: 'Demo iPhone', kind: 'phone', createdAt: 1, lastSeenAt: 1, allowInput: false }]);
    await render();
    act(() => $<HTMLButtonElement>(`[data-remote-grant="${DEVICE_ID}"]`)!.click());
    expect(api.web.deviceSetInput).not.toHaveBeenCalled();
    // This computer serves read-only (status allowInput false): the note says when it takes effect.
    expect($('.wmux-remote-row-note')?.textContent).toBe("Demo iPhone will approve requests and type into panes on this computer once this computer's input is on.");
    // Revoke steps aside while the grant is asked for.
    expect($('[data-remote-remove="phone"]')).toBeNull();
    await act(async () => { $<HTMLButtonElement>(`[data-remote-grant-confirm="${DEVICE_ID}"]`)!.click(); });
    expect(api.web.deviceSetInput).toHaveBeenCalledWith(DEVICE_ID, true);
    expect($('.wmux-remote-row-note')).toBeNull();
    // The row re-reads the roster afterwards.
    expect(api.web.deviceList).toHaveBeenCalledTimes(2);
  });

  it('offers Allow typing for a grant nobody set (older than grants), beside Make view-only', async () => {
    stub([{ deviceId: DEVICE_ID, name: 'Old phone', kind: 'phone', createdAt: 1, lastSeenAt: 1, allowInput: true, inputGrantImplicit: true }]);
    await render();
    expect($(`[data-remote-view-only="${DEVICE_ID}"]`)).not.toBeNull();
    act(() => $<HTMLButtonElement>(`[data-remote-grant="${DEVICE_ID}"]`)!.click());
    await act(async () => { $<HTMLButtonElement>(`[data-remote-grant-confirm="${DEVICE_ID}"]`)!.click(); });
    expect(api.web.deviceSetInput).toHaveBeenCalledWith(DEVICE_ID, true);
  });

  it('keeps the row busy until the roster is read back after a grant change', async () => {
    stub([{ deviceId: DEVICE_ID, name: 'Demo iPhone', kind: 'phone', createdAt: 1, lastSeenAt: 1, allowInput: true }]);
    await render();
    let release: () => void = () => undefined;
    api.web.deviceList.mockImplementationOnce(() => new Promise((r) => { release = () => r({ devices: [] }); }));
    await act(async () => { $<HTMLButtonElement>(`[data-remote-view-only="${DEVICE_ID}"]`)!.click(); });
    expect($<HTMLButtonElement>(`[data-remote-view-only="${DEVICE_ID}"]`)!.disabled).toBe(true);
    await act(async () => { release(); });
    expect($(`[data-remote-view-only="${DEVICE_ID}"]`)).toBeNull();
  });

  it('makes a phone view-only at once, and says why under the row when that fails', async () => {
    stub([{ deviceId: DEVICE_ID, name: 'Demo iPhone', kind: 'phone', createdAt: 1, lastSeenAt: 1, allowInput: true }]);
    api.web.deviceSetInput.mockResolvedValueOnce({ ok: false, reason: 'persist-failed', changed: true });
    await render();
    await act(async () => { $<HTMLButtonElement>(`[data-remote-view-only="${DEVICE_ID}"]`)!.click(); });
    expect(api.web.deviceSetInput).toHaveBeenCalledWith(DEVICE_ID, false);
    expect($('[data-remote-entry="phone"] [role="alert"]')?.textContent).toBe('The change could not be written to disk — it applies now but reverts when the daemon restarts');
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
    expect([...document.querySelectorAll('[data-remote-menu-item]')].map((i) => i.getAttribute('data-remote-menu-item'))).toEqual(['link', 'remove']);
    // The menu is portalled out of the list's clip, and the button points at it.
    const pop = document.querySelector('[role="menu"]')!;
    expect(container.contains(pop)).toBe(false);
    expect(menu.getAttribute('aria-controls')).toBe(pop.id);
    // Escape on the button closes the menu and stays on the page.
    act(() => { menu.focus(); menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(useStore.getState().appRoute).toBe('remote');
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

  it('shows a Moa hold an older daemon reports as a Needs you row for an ended link', async () => {
    stub([], { held: [held('rt-moa', 'brain-unavailable')] });
    await render();
    const row = $('[data-remote-needs] [data-task-id="rt-moa"]')!;
    expect(row.textContent).toContain('Work from office-win is on hold');
    expect(row.querySelector('[data-testid="a2a-delivery-reason"]')?.textContent).toBe('The link to that PC has ended.');
  });

  it('removing a PC says when the other PC was not told, and which side is left on a partial failure', async () => {
    stub([], { hosts: [{ hostId: HOST, name: 'DESK', role: 'joiner', state: 'connected', pending: 0 }] });
    api.a2aRemote.hostsRemove.mockResolvedValue({ ok: true, remoteRevoked: false });
    await render();
    const removeVia = async (hostId: string) => {
      act(() => $(`[data-remote-pc="${hostId}"] [data-remote-menu]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      act(() => document.querySelector<HTMLButtonElement>('[data-remote-menu-item="remove"]')!.click());
      await act(async () => { $<HTMLButtonElement>(`[data-remote-pc="${hostId}"] [data-remote-confirm="pc"]`)!.click(); });
    };
    await removeVia(HOST);
    expect(api.a2aRemote.hostsRemove).toHaveBeenCalledWith(HOST);
    expect($('[data-remote-notice]')?.textContent).toBe('Removed DESK here, but that PC could not be reached. Disconnect this PC there too.');
  });

  it('a PC paired both ways that keeps its peer pairing says so', async () => {
    stub([], { hosts: [{ hostId: PEER_HOST, name: 'office-win', role: 'server', state: 'connected', pending: 0 }] });
    api.a2aRemote.hostsList.mockResolvedValue({ hosts: [{ v: 1, hostId: PEER_HOST, name: 'office-win', addresses: ['10.0.0.2'], port: 45660, fingerprint256: 'AA', peerId: 'x', createdAt: '' }] });
    api.a2aRemote.hostsRemove.mockResolvedValue({ ok: true, remoteRevoked: true });
    api.a2aRemote.peersRevoke.mockResolvedValue({ ok: false });
    await render();
    act(() => $(`[data-remote-pc="${PEER_HOST}"] [data-remote-menu]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => document.querySelector<HTMLButtonElement>('[data-remote-menu-item="remove"]')!.click());
    await act(async () => { $<HTMLButtonElement>(`[data-remote-pc="${PEER_HOST}"] [data-remote-confirm="pc"]`)!.click(); });
    expect(api.a2aRemote.peersRevoke).toHaveBeenCalledWith(`peer-${PEER_HOST}`);
    expect($('[data-remote-notice]')?.textContent).toBe('office-win can still connect to this PC: revoking its pairing here failed. Try Remove again.');
  });

  it('says A2A is listening as soon as Connect a PC turns it on (on its button, never on showing the tab), not at the next poll', async () => {
    stub([]);
    const off = { enabled: false, port: 45660, listening: false, hostId: 'me', name: 'MacBook', fingerprint256: null, lastError: null };
    api.a2aRemote.status.mockResolvedValue(off);
    api.a2aRemote.configure = vi.fn(async () => ({ ...off, enabled: true, listening: true }));
    api.a2aRemote.pairBegin = vi.fn(async () => ({ invite: 'wmux-a2a://x:45660/K7M2QX9P#AA', expiresAt: Date.now() + 600_000, addresses: [] }));
    api.a2aRemote.pairStatus = vi.fn(async () => ({ active: true, expiresAt: null, attemptsLeft: 3, lockedUntil: null }));
    await render();
    expect($('[data-remote-a2a]')?.textContent).toBe('PC messages off');
    await act(async () => { $<HTMLButtonElement>('[data-remote-connect]')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    const invite = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="remote-connect-tabs"] button')].find((b) => b.textContent === 'Invite this PC')!;
    await act(async () => { invite.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    // Showing the Invite tab turns nothing on; its Turn on and create invite button does.
    expect(api.a2aRemote.configure).not.toHaveBeenCalled();
    expect($('[data-remote-a2a]')?.textContent).toBe('PC messages off');
    await act(async () => { $<HTMLButtonElement>('[data-testid="remote-connect-create"]')!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(api.a2aRemote.configure).toHaveBeenCalledWith({ enabled: true });
    expect($('[data-remote-a2a]')?.textContent).toBe('PC messages on · port 45660');
  });

  it('keeps Phone access settings on the line whether or not phone access is on', async () => {
    stub([]);
    let running = false;
    api.web.status.mockImplementation(async () => (running
      ? { running: true, host: '127.0.0.1', port: 7681, allowInput: false, token: 'SECRET-TOKEN', urls: ['http://127.0.0.1:7681/?token=SECRET-TOKEN'] }
      : { running: false }));
    await render();
    const settings = () => $<HTMLButtonElement>('[data-remote-machine] [data-testid="deck-web-toggle"]');
    expect(settings()?.textContent).toBe('Phone access settings…');
    running = true;
    await act(async () => { vi.advanceTimersByTime(REMOTE_PAGE_POLL_MS); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect($('[data-remote-server]')?.textContent).toBe('Phone access: This computer only');
    expect(settings()).not.toBeNull();
    // One button, not a second copy in Details.
    await act(async () => { $<HTMLButtonElement>('[data-remote-details]')!.click(); });
    expect(container.querySelectorAll('[data-testid="deck-web-toggle"]')).toHaveLength(1);
  });

  it('Pair a phone… in the header, on the Phones heading and in the empty state opens the one dialog', async () => {
    stub([]);
    await render();
    for (const sel of ['[data-remote-pair-phone]', '[data-remote-pair-phone-empty]']) {
      useStore.setState({ phonePairOpen: false });
      await act(async () => { $<HTMLButtonElement>(sel)!.click(); });
      expect(useStore.getState().phonePairOpen).toBe(true);
    }
    act(() => root.unmount());
    root = createRoot(container);
    stub([{ deviceId: DEVICE_ID, name: 'Demo iPhone', kind: 'phone', createdAt: 1, lastSeenAt: 1, allowInput: false }]);
    await render();
    useStore.setState({ phonePairOpen: false });
    await act(async () => { $<HTMLButtonElement>('[data-remote-pair-phone-group]')!.click(); });
    expect(useStore.getState().phonePairOpen).toBe(true);
    useStore.setState({ phonePairOpen: false });
  });
});

describe('Remote page: the A2A port', () => {
  function stubPort(problem: 'port-reserved' | 'port-denied' | 'port-in-use') {
    stub([]);
    api.a2aRemote.status.mockResolvedValue({
      enabled: true, port: 45660, listening: false, hostId: 'me', name: 'MacBook', fingerprint256: null,
      lastError: 'EACCES', lastErrorCode: 'EACCES', lastErrorPort: 45660,
    });
    const netFirewall = {
      status: vi.fn(async () => { throw new Error('not in this test'); }),
      listenProblem: vi.fn(async () => ({ problem: { kind: problem, port: 45660 }, holder: null, suggestion: 45661 })),
      fix: vi.fn(),
      remove: vi.fn(),
      open: vi.fn(),
    };
    vi.stubGlobal('electronAPI', { platform: 'darwin', ...api, netFirewall });
  }

  it('a reserved or denied port reads "unavailable" on the band, a held one "in use"', async () => {
    stubPort('port-denied');
    await render();
    expect($('[data-remote-a2a]')?.textContent).toBe('PC messages: port 45660 unavailable');
    act(() => root.unmount());
    root = createRoot(container);
    stubPort('port-in-use');
    await render();
    expect($('[data-remote-a2a]')?.textContent).toBe('PC messages: port 45660 in use');
  });

  it('Use port N that fails while the old listener keeps serving says so beside the notices', async () => {
    stubPort('port-reserved');
    api.a2aRemote.configure = vi.fn(async () => ({
      enabled: true, port: 45659, listening: true, hostId: 'me', name: 'MacBook', fingerprint256: null,
      lastError: 'EADDRINUSE', lastErrorCode: null, lastErrorPort: null,
    }));
    await render();
    await act(async () => { $<HTMLButtonElement>('[data-listen-use-port="45661"]')?.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(api.a2aRemote.configure).toHaveBeenCalledWith({ port: 45661 });
    expect($('[data-remote-firewall]')?.textContent).toContain('Could not use the new port (EADDRINUSE). Still listening on port 45659.');
    expect($('[data-remote-firewall]')?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('Remote page: remote approvals under each paired PC', () => {
  const pcHosts: A2aRemoteHostStatus[] = [
    { hostId: HOST, name: 'DESK', role: 'joiner', state: 'connected', pending: 0 },
    { hostId: PEER_HOST, name: 'office-win', role: 'server', state: 'connected', pending: 0 },
  ];
  const row = (hostId: string) => $(`[data-remote-approvals="${hostId}"]`)!;
  const level = (hostId: string, text: string) => [...row(hostId).querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === text)!;
  const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };

  it('one nested row right under each PC, in its words, with the saved level checked', async () => {
    stub([], { hosts: pcHosts, approvals: { hosts: { [HOST]: 'command' } } });
    await render();
    const desk = $(`[data-remote-pc="${HOST}"]`)!;
    expect(desk.nextElementSibling?.getAttribute('data-remote-approvals')).toBe(HOST);
    expect(row(HOST).textContent).toContain('Agents on DESK can allow or deny permission prompts in tasks they sent here');
    expect(row(HOST).getAttribute('data-level')).toBe('command');
    expect(level(HOST, 'Command').getAttribute('aria-checked')).toBe('true');
    expect(row(PEER_HOST).getAttribute('data-level')).toBe('off');
    // Neither a primary nor a coloured wash: the page's one primary is elsewhere.
    expect(row(HOST).querySelector('.ui-btn-primary')).toBeNull();
  });

  it('raising asks under the row and saves only on Confirm; Cancel saves nothing', async () => {
    stub([], { hosts: pcHosts, approvals: { hosts: {} } });
    await render();
    await act(async () => { level(PEER_HOST, 'Tool only').click(); });
    expect(row(PEER_HOST).querySelector('[data-remote-approvals-ask]')?.textContent).toContain('Agents on office-win will see the tool name');
    expect(api.a2aRemote.approvalsSet).not.toHaveBeenCalled();
    await act(async () => { row(PEER_HOST).querySelector<HTMLButtonElement>('[data-remote-approvals-cancel]')!.click(); });
    expect(row(PEER_HOST).querySelector('[data-remote-approvals-ask]')).toBeNull();
    expect(api.a2aRemote.approvalsSet).not.toHaveBeenCalled();
    await act(async () => { level(PEER_HOST, 'Command').click(); });
    expect(row(PEER_HOST).querySelector('[data-remote-approvals-ask]')?.textContent).toContain('will see the command');
    const ok = row(PEER_HOST).querySelector<HTMLButtonElement>('[data-remote-approvals-confirm]')!;
    expect(ok.className).not.toContain('ui-btn-primary');
    await act(async () => { ok.click(); });
    await settle();
    expect(api.a2aRemote.approvalsSet).toHaveBeenCalledWith(PEER_HOST, 'command');
    expect(row(PEER_HOST).getAttribute('data-level')).toBe('command');
  });

  it('lowering or turning off saves at once, without asking', async () => {
    stub([], { hosts: pcHosts, approvals: { hosts: { [HOST]: 'command' } } });
    await render();
    await act(async () => { level(HOST, 'Tool only').click(); });
    await settle();
    expect(row(HOST).querySelector('[data-remote-approvals-ask]')).toBeNull();
    expect(api.a2aRemote.approvalsSet).toHaveBeenLastCalledWith(HOST, 'tool-only');
    await act(async () => { level(HOST, 'Off').click(); });
    await settle();
    expect(api.a2aRemote.approvalsSet).toHaveBeenLastCalledWith(HOST, 'off');
    expect(row(HOST).getAttribute('data-level')).toBe('off');
  });

  it('a raise waiting on one PC stays while another PC is lowered or raised', async () => {
    stub([], { hosts: pcHosts, approvals: { hosts: { [HOST]: 'command' } } });
    await render();
    await act(async () => { level(PEER_HOST, 'Command').click(); });
    expect(row(PEER_HOST).querySelector('[data-remote-approvals-ask]')).not.toBeNull();
    await act(async () => { level(HOST, 'Off').click(); });
    await settle();
    expect(api.a2aRemote.approvalsSet).toHaveBeenLastCalledWith(HOST, 'off');
    expect(row(PEER_HOST).querySelector('[data-remote-approvals-ask]')).not.toBeNull();
    await act(async () => { level(HOST, 'Tool only').click(); });
    expect(row(HOST).querySelector('[data-remote-approvals-ask]')).not.toBeNull();
    expect(row(PEER_HOST).querySelector('[data-remote-approvals-ask]')).not.toBeNull();
    await act(async () => { row(PEER_HOST).querySelector<HTMLButtonElement>('[data-remote-approvals-confirm]')!.click(); });
    await settle();
    expect(api.a2aRemote.approvalsSet).toHaveBeenLastCalledWith(PEER_HOST, 'command');
    expect(row(HOST).querySelector('[data-remote-approvals-ask]')).not.toBeNull();
  });

  it('a confirmation for a level that changed meanwhile is refused, and the new level shown', async () => {
    const seed = { hosts: {} as Record<string, string> };
    stub([], { hosts: pcHosts, approvals: seed });
    await render();
    await act(async () => { level(HOST, 'Command').click(); });
    seed.hosts[HOST] = 'tool-only';
    await act(async () => { row(HOST).querySelector<HTMLButtonElement>('[data-remote-approvals-confirm]')!.click(); });
    await settle();
    expect(api.a2aRemote.approvalsSet).not.toHaveBeenCalled();
    expect(row(HOST).querySelector('[role="alert"]')?.textContent).toBe('The setting for that PC changed meanwhile. Check it and try again.');
    expect(row(HOST).getAttribute('data-level')).toBe('tool-only');
  });

  it('a damaged settings file: off for every PC, and each row says why', async () => {
    stub([], { hosts: pcHosts, approvals: { hosts: { [HOST]: 'command' }, damaged: true } });
    await render();
    expect(row(HOST).getAttribute('data-level')).toBe('off');
    expect(row(HOST).querySelector('[data-remote-approvals-damaged]')?.textContent).toContain('the approvals settings file was damaged');
  });

  it('with no approvals calls on the bridge (an older main), no row is drawn', async () => {
    stub([], { hosts: pcHosts });
    await render();
    expect($('[data-remote-approvals]')).toBeNull();
  });
});
