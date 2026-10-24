// @vitest-environment jsdom
// Connect a PC › LAN: the LanLink PIN pairing moved from Settings › LAN. It
// starts nothing on open, shows the PIN with its countdown and this PC's
// address, joins another PC by address and PIN, and a pairing window it
// opened is closed when the dialog closes, so none is left half-finished.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import RemoteConnectDialog, { CONNECT_PAIR_POLL_MS, inviteCodeGroups } from '../RemoteConnectDialog';
import LanLinkPairPanel, { groupPin } from '../LanLinkPairPanel';

let container: HTMLDivElement;
let root: Root;
let lanlink: Record<string, ReturnType<typeof vi.fn>>;
let pairActive = false;

function stub(opts: { enabled?: boolean; nic?: boolean; listening?: boolean; stopReason?: string | null } = {}) {
  const { enabled = true, nic = true, listening = true, stopReason = null } = opts;
  pairActive = false;
  lanlink = {
    status: vi.fn(async () => ({
      enabled, nic: nic ? { name: 'en0', mac: 'aa:bb' } : null, port: null, effectivePort: 45651,
      listening, stopReason,
      nics: [{ name: 'en0', mac: 'aa:bb', addresses: ['192.168.1.5'] }],
    })),
    pairBegin: vi.fn(async () => { pairActive = true; return { pin: '482913', expiresInMs: 120_000 }; }),
    pairStatus: vi.fn(async () => ({ active: pairActive, expiresInMs: pairActive ? 100_000 : null, failCount: 0 })),
    pairCancel: vi.fn(async () => { pairActive = false; return { ok: true }; }),
    pairJoin: vi.fn(async () => ({ peerUuid: 'u1', peerName: 'LAB-PC' })),
    peersList: vi.fn(async () => ({ peers: [] })),
  };
  vi.stubGlobal('electronAPI', {
    lanlink,
    a2aRemote: {
      status: vi.fn(async () => ({ enabled: false, port: 45660, listening: false, hostId: 'me', name: 'MAC', fingerprint256: null, lastError: null })),
    },
  });
  vi.stubGlobal('clipboardAPI', { readText: vi.fn(async () => ''), writeText: vi.fn(async () => undefined) });
}

/** What the daemon would answer to `lanlink.pairStatus` now. */
const readPairStatus = () => (lanlink.pairStatus as unknown as () => Promise<{ active: boolean }>)();

const onClose = vi.fn();
const onLanPaired = vi.fn();
async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
async function render(initialTab?: 'lan' | 'paste') {
  await act(async () => root.render(<RemoteConnectDialog onClose={onClose} onLinkPane={() => undefined} onLanPaired={onLanPaired} initialTab={initialTab} />));
  await settle();
}
const q = <E extends Element = HTMLElement>(id: string) => document.querySelector<E>(`[data-testid="${id}"]`);
const tab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="remote-connect-tabs"] button')].find((b) => b.textContent === label)!;
const type = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({ workspaces: [], appRoute: 'remote' });
  onClose.mockReset();
  onLanPaired.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('grouping', () => {
  it('reads the invite code as ABCD-EFGH and a PIN as two groups of three, for display only', () => {
    expect(inviteCodeGroups('wmux-a2a://desk.tail1.ts.net:45660/K7M2QX9P#sha256=A7:0D')).toBe('K7M2-QX9P');
    expect(inviteCodeGroups('not an invite')).toBeNull();
    expect(groupPin('482913')).toBe('482 913');
    expect(groupPin('12')).toBe('12');
  });
});

describe('Connect a PC › LAN', () => {
  it('is a third tab that starts nothing on open', async () => {
    stub();
    await render('paste');
    await act(async () => { tab('LAN').click(); });
    await settle();
    expect(q('remote-connect-lan')).not.toBeNull();
    expect(q('remote-connect-lan-begin')?.textContent).toBe('Generate PIN');
    expect(lanlink.pairBegin).not.toHaveBeenCalled();
  });

  it('with LAN off, says so and points at Settings › LAN', async () => {
    stub({ enabled: false });
    await render('lan');
    expect(q('remote-connect-lan-off')).not.toBeNull();
    expect(q('remote-connect-lan-begin')).toBeNull();
    await act(async () => { q<HTMLButtonElement>('remote-connect-lan-settings')!.click(); });
    expect(useStore.getState().appRoute).toBe('settings');
  });

  it('on a network LanLink does not listen on, says why instead of offering a PIN; joining still works', async () => {
    stub({ listening: false, stopReason: 'network-public' });
    await render('lan');
    expect(q('remote-connect-lan-stop-reason')?.textContent).toContain('this network is Public');
    expect(q('remote-connect-lan-begin')).toBeNull();
    expect(q('remote-connect-lan-join')).not.toBeNull();
  });

  it('shows the PIN, its countdown and this PC\'s address; switching tabs keeps it', async () => {
    stub();
    await render('lan');
    await act(async () => { q<HTMLButtonElement>('remote-connect-lan-begin')!.click(); });
    await settle();
    expect(q('remote-connect-lan-pin')?.textContent).toBe('482 913');
    expect(q('remote-connect-lan-countdown')?.textContent).toMatch(/expires in 1[12]\ds/);
    expect(q('remote-connect-lan-self')?.textContent).toContain('192.168.1.5:45651');
    await act(async () => { tab('Paste an invite').click(); });
    await act(async () => { tab('LAN').click(); });
    expect(q('remote-connect-lan-pin')?.textContent).toBe('482 913');
    expect(lanlink.pairCancel).not.toHaveBeenCalled();
  });

  it('a half-finished pairing is closed when the dialog closes', async () => {
    stub();
    await render('lan');
    await act(async () => { q<HTMLButtonElement>('remote-connect-lan-begin')!.click(); });
    await settle();
    expect((await readPairStatus()).active).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);
    await settle();
    expect(lanlink.pairCancel).toHaveBeenCalledTimes(1);
    expect((await readPairStatus()).active).toBe(false);
  });

  it('closes a window that finished opening after the dialog closed', async () => {
    stub();
    let resolve: (v: { pin: string; expiresInMs: number }) => void = () => undefined;
    lanlink.pairBegin.mockImplementation(() => new Promise((r) => { resolve = (v) => { pairActive = true; r(v); }; }));
    await render('lan');
    await act(async () => { q<HTMLButtonElement>('remote-connect-lan-begin')!.click(); });
    act(() => root.unmount());
    root = createRoot(container);
    expect(lanlink.pairCancel).not.toHaveBeenCalled();
    await act(async () => { resolve({ pin: '482913', expiresInMs: 120_000 }); });
    await settle();
    expect(lanlink.pairCancel).toHaveBeenCalledTimes(1);
    expect((await readPairStatus()).active).toBe(false);
  });

  it('keeps counting down while its parent re-renders faster than once a second', async () => {
    stub();
    const Parent = ({ n }: { n: number }) => <div data-n={n}><LanLinkPairPanel onPaired={() => undefined} /></div>;
    await act(async () => root.render(<Parent n={0} />));
    await settle();
    await act(async () => { q<HTMLButtonElement>('remote-connect-lan-begin')!.click(); });
    await settle();
    const seconds = () => Number(/(\d+)s/.exec(q('remote-connect-lan-countdown')?.textContent ?? '')?.[1]);
    const start = seconds();
    // A new onPaired every 300 ms, as a page whose store keeps changing passes it.
    for (let i = 1; i <= 12; i++) {
      await act(async () => { vi.advanceTimersByTime(300); root.render(<Parent n={i} />); });
    }
    await settle();
    expect(start - seconds()).toBeGreaterThanOrEqual(3);
    expect(lanlink.pairStatus.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('a PC redeeming the A2A invite does not end a LAN PIN that is still open', async () => {
    stub();
    const a2a = {
      status: vi.fn(async () => ({ enabled: true, port: 45660, listening: true, hostId: 'me', name: 'MAC', fingerprint256: null, lastError: null })),
      peersList: vi.fn(async () => ({ peers: [] as unknown[] })),
      pairBegin: vi.fn(async () => ({ invite: 'wmux-a2a://desk:45660/K7M2QX9P#sha256=AA', expiresAt: Date.now() + 600_000, addresses: [], tailnet: [] })),
      pairStatus: vi.fn(async () => ({ active: true, expiresAt: null, attemptsLeft: 3, lockedUntil: null })),
      pairCancel: vi.fn(async () => ({ ok: true })),
      exposureGet: vi.fn(async () => ({ exposure: null })),
      exposureSet: vi.fn(),
    };
    vi.stubGlobal('electronAPI', { lanlink, a2aRemote: a2a });
    await render('lan');
    await act(async () => { q<HTMLButtonElement>('remote-connect-lan-begin')!.click(); });
    await settle();
    await act(async () => { tab('Invite this PC').click(); });
    await settle();
    a2a.pairStatus.mockResolvedValue({ active: false, expiresAt: null, attemptsLeft: 3, lockedUntil: null });
    a2a.peersList.mockResolvedValue({ peers: [{ v: 1, peerId: 'p1', hostId: 'h1', name: 'DESK', createdAt: '' }] });
    await act(async () => { vi.advanceTimersByTime(CONNECT_PAIR_POLL_MS); });
    await settle();
    expect(q('remote-connect-joined')).not.toBeNull();
    expect(lanlink.pairCancel).not.toHaveBeenCalled();
    expect((await readPairStatus()).active).toBe(true);
    // Closing the dialog still ends it.
    act(() => root.unmount());
    root = createRoot(container);
    await settle();
    expect(lanlink.pairCancel).toHaveBeenCalledTimes(1);
  });

  it('leaves alone a pairing window it did not open', async () => {
    stub();
    await render('lan');
    act(() => root.unmount());
    root = createRoot(container);
    await settle();
    expect(lanlink.pairCancel).not.toHaveBeenCalled();
  });

  it('joins another PC by its address, port and PIN, and tells the page', async () => {
    stub();
    await render('lan');
    act(() => {
      type(q<HTMLInputElement>('remote-connect-lan-host')!, ' 192.168.1.42 ');
      type(q<HTMLInputElement>('remote-connect-lan-port')!, '45651');
      type(q<HTMLInputElement>('remote-connect-lan-join-pin')!, '123456');
    });
    await act(async () => { q<HTMLButtonElement>('remote-connect-lan-join')!.click(); });
    await settle();
    expect(lanlink.pairJoin).toHaveBeenCalledWith({ host: '192.168.1.42', port: 45651, pin: '123456' });
    expect(q('remote-connect-lan-joined')?.textContent).toContain('LAB-PC');
    expect(onLanPaired).toHaveBeenCalled();
  });

  it('refuses a join with a missing field before asking the daemon', async () => {
    stub();
    await render('lan');
    await act(async () => { q<HTMLButtonElement>('remote-connect-lan-join')!.click(); });
    expect(lanlink.pairJoin).not.toHaveBeenCalled();
    expect(q('remote-connect-lan-error')).not.toBeNull();
  });
});
