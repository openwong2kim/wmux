// @vitest-environment jsdom
// @wmux-lane unit
// `win32` here is only a platform string passed to a pure function; nothing reaches the OS.
//
// Connect a PC › Tailscale, the receiving side: which state the "This PC"
// section shows (derived from the Tailscale check, the open refusal and the
// polled window), and that the pure view draws every one of the 14 states
// in words, never a raw key.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { TailnetDiscoverPanelView, osLabel, refusedListenReport, type TailnetDiscoverPanelViewProps } from '../TailnetDiscoverPanel';
import { receiveViewOf, tailscaleBlocker, tailscaleReady, type ReceiveInputs } from '../../../hooks/useTailnetDiscovery';
import { t } from '../../../i18n';
import type { FirewallController } from '../FirewallNotice';
import type { A2aDiscoverIncoming, A2aDiscoverReceiveView, A2aDiscoverStatus } from '../../../../shared/rpc';
import type { TailscaleChecklist } from '../../../../shared/web';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;
const DEVICE = { name: 'MacBook-Pro', dnsName: 'macbook-pro.tail1.ts.net', login: 'open.wong2kim@gmail.com', os: 'macOS', ip: '100.88.12.4' };
const incoming = (state: 'deciding' | 'allowed', extra: Partial<A2aDiscoverIncoming> = {}): A2aDiscoverIncoming => ({
  requestId: 'r1', state, device: DEVICE, code: '482913', expiresAt: NOW + 120_000, ...extra,
});
const status = (extra: Partial<A2aDiscoverStatus> = {}): A2aDiscoverStatus => ({
  open: true, expiresAt: NOW + 240_000, name: 'DESKTOP-KRO4QJQ', turnedOn: false, incoming: null, lastOutcome: null, ended: null, ...extra,
});
const READY: TailscaleChecklist = {
  ok: true,
  items: [{ id: 'installed', state: 'pass' }, { id: 'signed-in', state: 'pass' }, { id: 'self', state: 'pass' }, { id: 'peer', state: 'pass' }],
};
const failing = (at: number, reason: string, fix: string): TailscaleChecklist => ({
  ok: false,
  items: (['installed', 'signed-in', 'self', 'peer'] as const).map((id, i) =>
    i < at ? { id, state: 'pass' as const } : i === at ? { id, state: 'fail' as const, reason: reason as never, fix: fix as never } : { id, state: 'unchecked' as const }),
});
const inputs = (extra: Partial<ReceiveInputs> = {}): ReceiveInputs => ({
  tailscale: READY, a2aOff: false, starting: false, refusal: null, status: null, opened: false, ...extra,
});

describe('which receiving state the section shows', () => {
  it('Tailscale is ready when this PC is on the tailnet; no other device online neither blocks nor un-readies it', () => {
    expect(tailscaleReady(READY)).toBe(true);
    expect(tailscaleReady(failing(3, 'no-peer', 'peer-help'))).toBe(true);
    expect(tailscaleReady(failing(1, 'signed-out', 'sign-in'))).toBe(false);
    expect(tailscaleReady(null)).toBe(false);
    expect(tailscaleBlocker(failing(3, 'no-peer', 'peer-help'))).toBeNull();
    // An unreadable status says nothing either way: the press goes to the daemon, which reads Tailscale itself.
    expect(tailscaleBlocker(failing(1, 'unreadable', 'open-app'))).toBeNull();
    expect(tailscaleBlocker(failing(1, 'signed-out', 'sign-in'))?.reason).toBe('signed-out');
  });

  it('before any press: idle (saying whether it turns A2A on), or Tailscale not ready with its fix', () => {
    expect(receiveViewOf(inputs())).toEqual({ kind: 'idle', a2aOff: false });
    expect(receiveViewOf(inputs({ a2aOff: true }))).toEqual({ kind: 'idle', a2aOff: true });
    expect(receiveViewOf(inputs({ tailscale: failing(0, 'not-installed', 'download') }))).toMatchObject({ kind: 'tailscale-not-ready', check: { reason: 'not-installed', fix: 'download' } });
    expect(receiveViewOf(inputs({ tailscale: null }))).toEqual({ kind: 'idle', a2aOff: false });
  });

  it('a refused open says why', () => {
    const check = { id: 'signed-in' as const, state: 'fail' as const, reason: 'signed-out' as const, fix: 'sign-in' as const };
    expect(receiveViewOf(inputs({ refusal: { ok: false, reason: 'tailscale-not-ready', check } }))).toEqual({ kind: 'tailscale-not-ready', check });
    expect(receiveViewOf(inputs({ refusal: { ok: false, reason: 'no-tailnet-ipv4' } }))).toEqual({ kind: 'no-tailnet-ipv4' });
    expect(receiveViewOf(inputs({ refusal: { ok: false, reason: 'tailnet-range-on-lan' } }))).toEqual({ kind: 'unavailable', reason: 'tailnet-range-on-lan' });
    expect(receiveViewOf(inputs({ refusal: { ok: false, reason: 'tailscale-whois-unsupported' } }))).toEqual({ kind: 'unavailable', reason: 'tailscale-whois-unsupported' });
    expect(receiveViewOf(inputs({ refusal: { ok: false, reason: 'a2a-off' } }))).toEqual({ kind: 'idle', a2aOff: true });
    // Stopped while it was opening: just the button again.
    expect(receiveViewOf(inputs({ refusal: { ok: false, reason: 'cancelled' } }))).toEqual({ kind: 'idle', a2aOff: false });
    expect(receiveViewOf(inputs({
      refusal: { ok: false, reason: 'listen-failed', listen: { port: 45660, lastError: 'in use', lastErrorCode: 'EADDRINUSE', lastErrorPort: 45661 } },
    }))).toEqual({ kind: 'listen-failed', port: 45661, lastError: 'in use', lastErrorCode: 'EADDRINUSE' });
    expect(receiveViewOf(inputs({ starting: true, refusal: { ok: false, reason: 'no-tailnet-ipv4' } }))).toEqual({ kind: 'starting' });
  });

  it('an open window: the card once a request revealed, else the last request that ended without a pairing, else discoverable', () => {
    expect(receiveViewOf(inputs({ opened: true, status: status() }))).toEqual({ kind: 'discoverable', name: 'DESKTOP-KRO4QJQ', expiresAt: NOW + 240_000 });
    expect(receiveViewOf(inputs({ opened: true, status: status({ incoming: incoming('deciding') }) }))).toMatchObject({ kind: 'approval', incoming: { code: '482913' } });
    expect(receiveViewOf(inputs({ opened: true, status: status({ incoming: incoming('allowed') }) }))).toMatchObject({ kind: 'allowed' });
    const denied = { outcome: 'denied' as const, device: DEVICE, ip: DEVICE.ip, at: NOW };
    expect(receiveViewOf(inputs({ opened: true, status: status({ lastOutcome: denied }) }))).toEqual({ kind: 'denied', device: DEVICE, expiresAt: NOW + 240_000 });
    const refused = { outcome: 'refused' as const, reason: 'other-user' as const, ip: '100.70.1.2', at: NOW };
    expect(receiveViewOf(inputs({ opened: true, status: status({ lastOutcome: refused }) }))).toEqual({ kind: 'refused', reason: 'other-user', ip: '100.70.1.2', expiresAt: NOW + 240_000 });
    // A withdrawn request, or one whose card ran out, leaves the window as it was.
    for (const outcome of ['withdrawn', 'expired'] as const) {
      expect(receiveViewOf(inputs({ opened: true, status: status({ lastOutcome: { outcome, device: DEVICE, ip: DEVICE.ip, at: NOW } }) })).kind).toBe('discoverable');
    }
  });

  it('a window that ended: how, only for a window this panel opened; the person\'s own Stop goes back to the button', () => {
    const ended = (reason: NonNullable<A2aDiscoverStatus['ended']>['reason'], peer?: { hostId: string; name: string }) =>
      status({ open: false, expiresAt: null, ended: { reason, at: NOW, ...(peer ? { peer } : {}) } });
    expect(receiveViewOf(inputs({ opened: true, status: ended('paired', { hostId: 'h1', name: 'MacBook-Pro' }) }))).toEqual({ kind: 'paired', peer: { hostId: 'h1', name: 'MacBook-Pro' } });
    expect(receiveViewOf(inputs({ opened: true, status: ended('grant-expired') }))).toEqual({ kind: 'grant-expired' });
    expect(receiveViewOf(inputs({ opened: true, status: ended('too-many-requests') }))).toEqual({ kind: 'ended', reason: 'too-many-requests' });
    expect(receiveViewOf(inputs({ opened: true, status: ended('stopped') }))).toEqual({ kind: 'idle', a2aOff: false });
    // A window that ended before this dialog opened is not this panel's to report.
    expect(receiveViewOf(inputs({ opened: false, status: ended('timeout') }))).toEqual({ kind: 'idle', a2aOff: false });
  });
});

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = '';
});

function firewall(): FirewallController {
  return {
    status: null, checking: false, readFailed: false, busy: null, outcome: null, fixed: false, copied: false, settled: 0,
    check: vi.fn(), fix: vi.fn(), remove: vi.fn(), copyDetails: vi.fn(), open: vi.fn(),
  };
}

function render(receive: A2aDiscoverReceiveView, extra: Partial<TailnetDiscoverPanelViewProps> = {}) {
  const props: TailnetDiscoverPanelViewProps = {
    receive, a2aOff: false, port: 45660, statusRead: true, selfName: 'DESKTOP-KRO4QJQ', expiresAt: NOW + 232_000, now: NOW,
    busy: false, failed: false, listenProblem: null, firewall: firewall(),
    onMakeDiscoverable: vi.fn(), onStop: vi.fn(), onDecide: vi.fn(), onUsePort: vi.fn(), t, ...extra,
  };
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(<TailnetDiscoverPanelView {...props} />));
  roots.push(root);
  return { el, props };
}
const q = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('the receiving view', () => {
  type Case = [string, A2aDiscoverReceiveView, RegExp];
  // Keyed by kind, so a kind added to the union fails to compile here until it is drawn.
  const cases: Record<A2aDiscoverReceiveView['kind'], Case[]> = {
    idle: [
      ['idle', { kind: 'idle', a2aOff: false }, /Make this PC discoverable/],
      ['idle, A2A off', { kind: 'idle', a2aOff: true }, /Turn on and make discoverable.*port 45660/],
    ],
    'tailscale-not-ready': [['tailscale-not-ready', { kind: 'tailscale-not-ready', check: { id: 'signed-in', state: 'fail', reason: 'signed-out', fix: 'sign-in' } }, /signed out of Tailscale/]],
    'no-tailnet-ipv4': [['no-tailnet-ipv4', { kind: 'no-tailnet-ipv4' }, /no tailnet IPv4 address/]],
    unavailable: [
      ['unavailable, CGNAT LAN', { kind: 'unavailable', reason: 'tailnet-range-on-lan' }, /Use an invite instead/],
      ['unavailable, old Tailscale', { kind: 'unavailable', reason: 'tailscale-whois-unsupported' }, /Update Tailscale/],
    ],
    starting: [['starting', { kind: 'starting' }, /Making this PC discoverable…/]],
    'listen-failed': [['listen-failed', { kind: 'listen-failed', port: 45660, lastError: 'in use', lastErrorCode: 'EADDRINUSE' }, /Not listening: EADDRINUSE/]],
    discoverable: [['discoverable', { kind: 'discoverable', name: 'DESKTOP-KRO4QJQ', expiresAt: NOW + 232_000 }, /This PC can be found · 3:52 left.*\(DESKTOP-KRO4QJQ\)/]],
    approval: [['approval', { kind: 'approval', incoming: incoming('deciding') }, /MacBook-Pro wants to connect/]],
    allowed: [['allowed', { kind: 'allowed', incoming: incoming('allowed') }, /Waiting for MacBook-Pro to finish pairing.*Keep this dialog open until pairing finishes/]],
    paired: [['paired', { kind: 'paired', peer: { hostId: 'h1', name: 'MacBook-Pro' } }, /Paired with MacBook-Pro\./]],
    'grant-expired': [['grant-expired', { kind: 'grant-expired' }, /did not finish pairing within a minute/]],
    denied: [['denied', { kind: 'denied', device: DEVICE, expiresAt: NOW + 100_000 }, /You denied MacBook-Pro/]],
    refused: [
      ['refused, unidentified', { kind: 'refused', reason: 'unidentified', ip: '100.70.1.2', expiresAt: null }, /100\.70\.1\.2.*could not tell which device/],
      ['refused, other user', { kind: 'refused', reason: 'other-user', ip: '100.70.1.2', expiresAt: null }, /another Tailscale account/],
      ['refused, self', { kind: 'refused', reason: 'self', ip: '100.70.1.2', expiresAt: null }, /this PC itself/],
    ],
    ended: (['timeout', 'stopped', 'disconnected', 'failed', 'too-many-requests', 'listener-stopped'] as const).map((reason): Case =>
      [`ended, ${reason}`, { kind: 'ended', reason }, /no longer discoverable|could not finish pairing/]),
  };
  const kinds = Object.values(cases).flat();

  it.each(kinds)('%s: says it in words, never a raw key', (_name, view, text) => {
    const { el } = render(view);
    expect(el.textContent).toMatch(text);
    expect(el.textContent).not.toMatch(/remotePage\.|settings\.|tailscale\.(reason|fix)\./);
  });

  it('the card shows the device as Tailscale identifies it and the code in two groups; Allow is the one primary', () => {
    const { el, props } = render({ kind: 'approval', incoming: incoming('deciding') });
    expect(q(el, 'discover-card-identity')?.textContent).toBe('macOS · Tailscale account open.wong2kim@gmail.com · tailnet address 100.88.12.4');
    expect(q(el, 'discover-card-code')?.textContent).toBe('482 913');
    expect(q(el, 'discover-card-replaces')).toBeNull();
    expect(el.querySelectorAll('.ui-btn-primary')).toHaveLength(1);
    expect(q(el, 'discover-allow')?.className).toContain('ui-btn-primary');
    act(() => q(el, 'discover-allow')!.click());
    expect(props.onDecide).toHaveBeenCalledWith(true);
    act(() => q(el, 'discover-deny')!.click());
    expect(props.onDecide).toHaveBeenLastCalledWith(false);
    // The window keeps its countdown and Stop while the card is up.
    expect(q(el, 'discover-countdown')?.textContent).toBe('This PC can be found · 3:52 left');
  });

  it('a request from a PC already paired here says Allow replaces that pairing', () => {
    const { el } = render({ kind: 'approval', incoming: incoming('deciding', { replaces: 'MacBook-Pro (old)' }) });
    expect(q(el, 'discover-card-replaces')?.textContent).toBe('Allowing replaces the existing pairing with MacBook-Pro (old).');
  });

  it('after a Deny the window stays open: countdown and Stop remain', () => {
    const { el, props } = render({ kind: 'denied', device: DEVICE, expiresAt: NOW + 61_000 });
    expect(q(el, 'discover-countdown')?.textContent).toBe('This PC can be found · 1:01 left');
    act(() => q(el, 'discover-stop')!.click());
    expect(props.onStop).toHaveBeenCalled();
  });

  it('the button waits for the listener read, and makes this PC discoverable when pressed', () => {
    const waiting = render({ kind: 'idle', a2aOff: false }, { statusRead: false });
    act(() => q(waiting.el, 'discover-make')!.click());
    expect(waiting.props.onMakeDiscoverable).not.toHaveBeenCalled();
    const ready = render({ kind: 'idle', a2aOff: false });
    act(() => q(ready.el, 'discover-make')!.click());
    expect(ready.props.onMakeDiscoverable).toHaveBeenCalledTimes(1);
  });

  it('a refused open explains its own port problem when the daemon has none to give', () => {
    const lf = (lastErrorCode: string | null, port = 45660) => ({ kind: 'listen-failed' as const, port, lastError: null, lastErrorCode });
    expect(refusedListenReport(lf('EADDRINUSE'), 'darwin')).toEqual({ problem: { kind: 'port-in-use', port: 45660 }, holder: null, suggestion: 45661 });
    expect(refusedListenReport(lf('EACCES'), 'win32')).toEqual({ problem: { kind: 'port-denied', port: 45660 }, holder: null, suggestion: 45661 });
    expect(refusedListenReport(lf('EADDRINUSE', 65535), 'linux')?.suggestion).toBeNull();
    expect(refusedListenReport(lf('ENOTFOUND'), 'linux')).toEqual({ problem: { kind: 'other', code: 'ENOTFOUND' }, holder: null, suggestion: null });
    expect(refusedListenReport(lf(null), 'linux')).toBeNull();
  });

  it('names the OS as people write it', () => {
    expect(['windows', 'macOS', 'linux', 'freebsd'].map(osLabel)).toEqual(['Windows', 'macOS', 'Linux', 'freebsd']);
  });
});
