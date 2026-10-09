// @vitest-environment jsdom
// "Connect a PC…": one dialog, two tabs. Opening it changes nothing: it starts
// on Invite only when A2A already listens, and choosing Invite is what turns
// A2A on; Invite opens and copies an invite and turns into the new PC's
// checklist when it joins. Paste reads the clipboard only on its button and
// routes a wmux-a2a:// invite to the A2A join and every remote-host shape to
// the remote-host pairing, never connecting before Connect is pressed.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import RemoteConnectDialog, { CONNECT_PAIR_POLL_MS, CONNECT_REDEEM_GRACE_TICKS, maskPasted, pastedKind, pastedParts } from '../RemoteConnectDialog';
import { COPIED_MS } from '../../../hooks/useA2aInvite';

const INVITE = 'wmux-a2a://desk.tail1.ts.net:45660/K7M2QX9P#A7:0D:5E:91';
const HOST = '11111111-1111-4111-8111-111111111111';
const LINK = 'https://office.ts.net/pair#wmux-desktop-code=ABCD2345';
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

  it('splits a bundled invite into its lines, but keeps an address and a code on two lines as one', () => {
    const bundle = `${INVITE}\r\n${LINK}\n`;
    expect(pastedParts(bundle)).toEqual([INVITE, LINK]);
    expect(pastedKind(bundle)).toBe('bundle');
    expect(maskPasted(bundle)).not.toMatch(/K7M2QX9P|ABCD2345/);
    expect(maskPasted(bundle).split('\n')).toHaveLength(2);
    expect(pastedParts('https://office.ts.net:7681\nABCD2345')).toEqual(['https://office.ts.net:7681\nABCD2345']);
    expect(pastedParts(`${INVITE}\nhello`)).toEqual([`${INVITE}\nhello`]);
  });
});

describe('Connect a PC dialog', () => {
  const tab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="remote-connect-tabs"] button')].find((b) => b.textContent === label)!;
  const pasteButton = () => q<HTMLButtonElement>('remote-connect-paste-button')!;

  it('with A2A off, opens on Paste with no side effect; the clipboard is read only on Paste, masked, and joins on Connect', async () => {
    stub(INVITE, false);
    await render();
    expect(q('remote-connect-paste')).not.toBeNull();
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(a2a.configure).not.toHaveBeenCalled();
    expect(a2a.pairBegin).not.toHaveBeenCalled();
    await act(async () => { pasteButton().click(); });
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(q('remote-connect-pasted')?.textContent).not.toContain('K7M2QX9P');
    expect(a2a.join).not.toHaveBeenCalled();
    await act(async () => { q<HTMLButtonElement>('remote-connect-submit')!.click(); });
    expect(a2a.join).toHaveBeenCalledWith(INVITE);
    expect(q('remote-connect-message')?.textContent).toBe('Paired with DESK.');
    act(() => q<HTMLButtonElement>('remote-connect-link-pane')!.click());
    expect(onLinkPane).toHaveBeenCalledWith(HOST);
  });

  it('routes every remote-host shape to the remote-host pairing: a pairing link, a token URL, an address and a code', async () => {
    for (const [text, call, args] of [
      ['https://office.ts.net/pair#wmux-desktop-code=ABCD2345', 'hostsPair', ['https://office.ts.net', 'ABCD2345']],
      ['https://office.ts.net:7681 ABCD2345', 'hostsPair', ['https://office.ts.net:7681', 'ABCD2345']],
      ['https://office.ts.net:7681/?token=tok123', 'hostsAdd', ['https://office.ts.net:7681/?token=tok123']],
    ] as const) {
      stub(text, false);
      remote.hostsAdd.mockResolvedValue({ ok: true, host: { id: 'h2', label: 'office', origin: 'https://office.ts.net:7681', addedAt: 1 } });
      await render();
      await act(async () => { pasteButton().click(); });
      await act(async () => { q<HTMLButtonElement>('remote-connect-submit')!.click(); });
      expect(remote[call]).toHaveBeenCalledWith(...args);
      expect(a2a.join).not.toHaveBeenCalled();
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it('with A2A off, choosing Invite turns it on, tells the page, copies the invite at once, labels tailnet addresses, discards', async () => {
    stub('', false);
    const onA2aStatus = vi.fn();
    await act(async () => root.render(<RemoteConnectDialog onClose={onClose} onLinkPane={onLinkPane} onA2aStatus={onA2aStatus} />));
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    await act(async () => { tab('Invite this PC').click(); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
    expect(a2a.configure).toHaveBeenCalledWith({ enabled: true });
    expect(onA2aStatus).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, listening: true }));
    expect(q('remote-connect-turned-on')).not.toBeNull();
    expect(q('remote-connect-code')?.textContent).toBe(INVITE);
    expect(clipboard.writeText).toHaveBeenCalledWith(INVITE);
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(q('remote-connect-copy')?.textContent).toBe('Copied');
    expect(q('remote-connect-copy')?.className).toContain('ui-btn-primary');
    const rows = [...q('remote-connect-addresses')!.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows).toEqual(['1desk.tail1.ts.netTailscale', '2100.101.12.4Tailscale', '3192.168.0.12']);
    expect(q('remote-connect-expiry')?.textContent).toMatch(/in (9:5\d|10:00)$/);
    await act(async () => { vi.advanceTimersByTime(COPIED_MS); });
    expect(q('remote-connect-copy')?.textContent).toBe('Copy');
    await act(async () => { q<HTMLButtonElement>('remote-connect-discard')!.click(); });
    expect(a2a.pairCancel).toHaveBeenCalled();
    expect(q('remote-connect-new-code')).not.toBeNull();
  });

  it('with A2A already listening, opens on Invite and copies without touching the listener', async () => {
    stub('');
    await render();
    expect(q('remote-connect-invite')).not.toBeNull();
    expect(a2a.configure).not.toHaveBeenCalled();
    expect(clipboard.writeText).toHaveBeenCalledWith(INVITE);
    expect(q('remote-connect-copy')?.textContent).toBe('Copied');
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

  const tick = async () => {
    await act(async () => { vi.advanceTimersByTime(CONNECT_PAIR_POLL_MS); });
    for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
  };
  const redeemed = () => a2a.pairStatus.mockResolvedValue({ active: false, expiresAt: null, attemptsLeft: 0, lockedUntil: null });

  it('a PC that pairs again (same hostId, new pairing) still gets its checklist', async () => {
    stub('');
    // That PC removed this one on its side only: its old pairing here is still live.
    a2a.peersList.mockResolvedValue({ peers: [{ v: 1, peerId: 'p0', hostId: HOST, name: 'DESK', createdAt: '' }] });
    await render({ initialTab: 'invite' });
    redeemed();
    a2a.peersList.mockResolvedValue({ peers: [
      { v: 1, peerId: 'p0', hostId: HOST, name: 'DESK', createdAt: '', revokedAt: '2026-10-09T00:00:00.000Z' },
      { v: 1, peerId: 'p1', hostId: HOST, name: 'DESK', createdAt: '' },
    ] });
    await tick();
    expect(q('remote-connect-joined')?.textContent).toContain('DESK joined');
  });

  it('keeps looking when the invite is gone before the new PC is stored', async () => {
    stub('');
    await render({ initialTab: 'invite' });
    redeemed();
    // The daemon consumed the code and is still deriving the new PC's key.
    await tick();
    expect(q('remote-connect-joined')).toBeNull();
    expect(q('remote-connect-code')?.textContent).toBe(INVITE);
    a2a.peersList.mockResolvedValue({ peers: [{ v: 1, peerId: 'p1', hostId: HOST, name: 'DESK', createdAt: '' }] });
    await tick();
    expect(q('remote-connect-joined')?.textContent).toContain('DESK joined');
  });

  it('an invite gone with nobody joining is let go after the grace ticks, and at once once it expired', async () => {
    stub('');
    await render({ initialTab: 'invite' });
    redeemed();
    for (let i = 0; i < CONNECT_REDEEM_GRACE_TICKS; i++) await tick();
    expect(q('remote-connect-code')).not.toBeNull();
    await tick();
    expect(q('remote-connect-code')).toBeNull();
    expect(q('remote-connect-new-code')).not.toBeNull();
    expect(q('remote-connect-joined')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    stub('');
    a2a.pairBegin.mockResolvedValue({ invite: INVITE, expiresAt: Date.now() + 1_000, addresses: [], tailnet: [] });
    await render({ initialTab: 'invite' });
    redeemed();
    await tick();
    expect(q('remote-connect-code')).toBeNull();
    expect(q('remote-connect-new-code')).not.toBeNull();
  });
});

describe('one invite for A2A and the workspaces', () => {
  const MINE = 'https://mac.tail1.ts.net/pair#wmux-desktop-code=WXYZ6789';
  let web: Record<string, ReturnType<typeof vi.fn>>;
  let writeEphemeral: ReturnType<typeof vi.fn>;
  const pending = () => ({
    running: true, urls: ['https://mac.tail1.ts.net'], pairCode: 'WXYZ6789', pendingDeviceName: 'Computer',
    pendingPairFlow: 'computer', pairExpiresAt: Date.now() + 600_000,
  });
  function stubWeb(running = true) {
    web = {
      status: vi.fn(async () => (running ? pending() : { running: false })),
      deviceList: vi.fn(async () => ({ devices: [] })),
      pairStart: vi.fn(async () => pending()),
      pairCancel: vi.fn(async () => ({ running: true })),
    };
    writeEphemeral = vi.fn(async () => undefined);
    vi.stubGlobal('electronAPI', { a2aRemote: a2a, remote, web });
    vi.stubGlobal('clipboardAPI', { ...clipboard, writeEphemeral });
  }
  const share = () => q<HTMLButtonElement>('remote-connect-share')!;
  const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };

  it('is off by default; ticking mints a view-only computer link and copies both lines as an expiring credential; unticking cancels it', async () => {
    stub('');
    stubWeb();
    await render({ initialTab: 'invite' });
    await settle();
    expect(share().getAttribute('aria-checked')).toBe('false');
    expect(web.pairStart).not.toHaveBeenCalled();
    expect(clipboard.writeText).toHaveBeenCalledWith(INVITE);

    await act(async () => { share().click(); });
    await settle();
    expect(web.pairStart).toHaveBeenCalledWith('Computer', false, 'computer');
    expect(writeEphemeral).toHaveBeenCalledWith(`${INVITE}\n${MINE}`, expect.any(Number));
    expect(writeEphemeral.mock.calls[0][1]).toBeGreaterThan(0);
    expect(q('remote-connect-code')?.textContent).toBe(`${INVITE}\n${MINE}`);

    clipboard.writeText.mockClear();
    await act(async () => { share().click(); });
    await settle();
    expect(web.pairCancel).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledWith(INVITE);
    expect(q('remote-connect-code')?.textContent).toBe(INVITE);
  });

  it('does not cancel a code Share & pair minted since', async () => {
    stub('');
    stubWeb();
    await render({ initialTab: 'invite' });
    await settle();
    await act(async () => { share().click(); });
    await settle();
    web.status.mockResolvedValue({ ...pending(), pairCode: 'NEWCODE2' });
    await act(async () => { share().click(); });
    await settle();
    expect(web.pairCancel).not.toHaveBeenCalled();
  });

  it('is offered only while Share & pair answers over HTTPS', async () => {
    stub('');
    stubWeb(false);
    await render({ initialTab: 'invite' });
    await settle();
    expect(share().getAttribute('aria-disabled') === 'true' || share().hasAttribute('disabled')).toBe(true);
    expect(q('remote-connect-invite')?.textContent).toContain('Turn on Share & pair over Tailscale or HTTPS first.');
  });

  it('a pasted bundle connects both; what failed stays for another try', async () => {
    stub(`${INVITE}\n${LINK}`, false);
    await render();
    await act(async () => { q<HTMLButtonElement>('remote-connect-paste-button')!.click(); });
    await act(async () => { q<HTMLButtonElement>('remote-connect-submit')!.click(); });
    await settle();
    expect(a2a.join).toHaveBeenCalledWith(INVITE);
    expect(remote.hostsPair).toHaveBeenCalledWith('https://office.ts.net', 'ABCD2345');
    expect(q('remote-connect-message')?.textContent).toBe('Paired with DESK. Connected to office. Its workspaces are listed under Other PCs.');
    expect(q('remote-connect-link-pane')).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    stub(`${INVITE}\n${LINK}`, false);
    remote.hostsPair.mockResolvedValue({ ok: false, error: 'nope' });
    await render();
    await act(async () => { q<HTMLButtonElement>('remote-connect-paste-button')!.click(); });
    await act(async () => { q<HTMLButtonElement>('remote-connect-submit')!.click(); });
    await settle();
    expect(q('remote-connect-message')?.getAttribute('role')).toBe('alert');
    expect(q('remote-connect-pasted')?.textContent).not.toContain('wmux-a2a://');
    expect(q('remote-connect-pasted')?.textContent).toContain('office.ts.net');
  });
});
