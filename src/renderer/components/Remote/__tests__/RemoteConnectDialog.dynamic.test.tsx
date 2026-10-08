// @vitest-environment jsdom
// "Connect a PC…": one dialog, two tabs. Invite turns A2A on, opens and copies
// an invite at once, and turns into the new PC's checklist when it joins;
// Paste routes a wmux-a2a:// invite to the A2A join and a pairing link to the
// remote-host pairing, and never connects before Connect is pressed.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import RemoteConnectDialog, { CONNECT_PAIR_POLL_MS, maskPasted, pastedKind } from '../RemoteConnectDialog';

const INVITE = 'wmux-a2a://desk.tail1.ts.net:45660/K7M2QX9P#A7:0D:5E:91';
const HOST = '11111111-1111-4111-8111-111111111111';
let container: HTMLDivElement;
let root: Root;
let a2a: Record<string, ReturnType<typeof vi.fn>>;
let remote: Record<string, ReturnType<typeof vi.fn>>;
let clipboard: { readText: ReturnType<typeof vi.fn>; writeText: ReturnType<typeof vi.fn> };

function stub(clip: string, enabled = true) {
  a2a = {
    status: vi.fn(async () => ({ enabled, port: 45660, listening: enabled, hostId: 'me', name: 'MAC', fingerprint256: null, lastError: null })),
    configure: vi.fn(async () => ({ enabled: true, port: 45660, listening: true, hostId: 'me', name: 'MAC', fingerprint256: null, lastError: null })),
    peersList: vi.fn(async () => ({ peers: [] })),
    pairBegin: vi.fn(async () => ({
      invite: INVITE, expiresAt: Date.now() + 600_000,
      addresses: ['desk.tail1.ts.net', '100.101.12.4', '192.168.0.12'], tailnet: ['desk.tail1.ts.net', '100.101.12.4'],
    })),
    pairCancel: vi.fn(async () => ({ ok: true })),
    pairStatus: vi.fn(async () => ({ active: true, expiresAt: null, attemptsLeft: 3, lockedUntil: null })),
    join: vi.fn(async () => ({ ok: true, host: { v: 1, hostId: HOST, name: 'DESK', addresses: [], port: 45660, fingerprint256: 'AA', peerId: 'p', createdAt: '' } })),
    exposureGet: vi.fn(async () => ({ exposure: null })),
    exposureSet: vi.fn(),
  };
  remote = {
    hostsPair: vi.fn(async () => ({ ok: true, host: { id: 'h1', label: 'office', origin: 'https://office.ts.net', addedAt: 1 } })),
    hostsAdd: vi.fn(),
  };
  clipboard = { readText: vi.fn(async () => clip), writeText: vi.fn(async () => undefined) };
  vi.stubGlobal('electronAPI', { a2aRemote: a2a, remote });
  vi.stubGlobal('clipboardAPI', clipboard);
}

const onClose = vi.fn();
const onLinkPane = vi.fn();
async function render(props: { initialTab?: 'invite' | 'paste' } = {}) {
  await act(async () => root.render(<RemoteConnectDialog onClose={onClose} onLinkPane={onLinkPane} {...props} />));
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
const q = <E extends Element = HTMLElement>(id: string) => document.querySelector<E>(`[data-testid="${id}"]`);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({ workspaces: [], moa: null });
  onClose.mockReset();
  onLinkPane.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('pasted text', () => {
  it('tells an A2A invite from a pairing link, and dots out the secret', () => {
    expect(pastedKind(INVITE)).toBe('a2a');
    expect(pastedKind('https://office.ts.net/pair#wmux-desktop-code=ABCD2345')).toBe('link');
    expect(pastedKind('hello')).toBeNull();
    expect(maskPasted(INVITE)).toBe('wmux-a2a://desk.tail1.ts.net:45660/••••••••#A7:0D:5E:91');
    expect(maskPasted('https://office.ts.net/pair#wmux-desktop-code=ABCD2345')).not.toContain('ABCD2345');
  });
});

describe('Connect a PC dialog', () => {
  it('opens on Paste with a copied invite, masked, and joins only on Connect; then offers to link a pane', async () => {
    stub(INVITE);
    await render();
    expect(q('remote-connect-paste')).not.toBeNull();
    expect(q('remote-connect-pasted')?.textContent).not.toContain('K7M2QX9P');
    expect(a2a.join).not.toHaveBeenCalled();
    expect(a2a.pairBegin).not.toHaveBeenCalled();
    await act(async () => { q<HTMLButtonElement>('remote-connect-submit')!.click(); });
    expect(a2a.join).toHaveBeenCalledWith(INVITE);
    expect(q('remote-connect-message')?.textContent).toBe('Paired with DESK.');
    act(() => q<HTMLButtonElement>('remote-connect-link-pane')!.click());
    expect(onLinkPane).toHaveBeenCalledWith(HOST);
  });

  it('routes a pairing link to the remote-host pairing', async () => {
    stub('https://office.ts.net/pair#wmux-desktop-code=ABCD2345');
    await render();
    await act(async () => { q<HTMLButtonElement>('remote-connect-submit')!.click(); });
    expect(remote.hostsPair).toHaveBeenCalledWith('https://office.ts.net', 'ABCD2345');
    expect(a2a.join).not.toHaveBeenCalled();
  });

  it('opens on Invite otherwise: turns A2A on, copies the invite at once, labels tailnet addresses, discards', async () => {
    stub('', false);
    await render();
    expect(a2a.configure).toHaveBeenCalledWith({ enabled: true });
    expect(q('remote-connect-turned-on')).not.toBeNull();
    expect(q('remote-connect-code')?.textContent).toBe(INVITE);
    expect(clipboard.writeText).toHaveBeenCalledWith(INVITE);
    expect(q('remote-connect-copy')?.textContent).toBe('Copied');
    expect(q('remote-connect-copy')?.className).toContain('ui-btn-primary');
    const rows = [...q('remote-connect-addresses')!.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows).toEqual(['1desk.tail1.ts.netTailscale', '2100.101.12.4Tailscale', '3192.168.0.12']);
    expect(q('remote-connect-expiry')?.textContent).toMatch(/in (9:5\d|10:00)$/);
    await act(async () => { q<HTMLButtonElement>('remote-connect-discard')!.click(); });
    expect(a2a.pairCancel).toHaveBeenCalled();
    expect(q('remote-connect-new-code')).not.toBeNull();
  });

  it('turns into the checklist for the PC that redeemed the invite, with nothing ticked', async () => {
    stub('');
    await render({ initialTab: 'invite' });
    expect(a2a.configure).not.toHaveBeenCalled();
    a2a.pairStatus.mockResolvedValue({ active: false, expiresAt: null, attemptsLeft: 3, lockedUntil: null });
    a2a.peersList.mockResolvedValue({ peers: [{ v: 1, peerId: 'p1', hostId: HOST, name: 'DESK', createdAt: '' }] });
    await act(async () => { vi.advanceTimersByTime(CONNECT_PAIR_POLL_MS); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    const joined = q('remote-connect-joined');
    expect(joined?.textContent).toContain('DESK joined');
    expect(joined?.querySelector('[data-testid="a2a-exposure-checklist"]')).not.toBeNull();
    expect(a2a.exposureGet).toHaveBeenCalledWith(HOST);
    expect(a2a.exposureSet).not.toHaveBeenCalled();
    expect([...joined!.querySelectorAll('[role="checkbox"]')].some((c) => c.getAttribute('aria-checked') === 'true')).toBe(false);
  });
});
