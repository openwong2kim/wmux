/**
 * Phone access settings (the Remote hub's settings view): sharing and its
 * grants with no pairing in it, the computer link the clipboard clear reads,
 * and the device-status line.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  pendingPairFlow,
  summarizeRoster,
  webComputerLink,
  webQrPayload,
  WebPopoverBody,
  type WebPopoverBodyProps,
} from '../WebToggle';
import type { WebTerminalInfo } from '../../../../shared/web';

const t = (key: string): string => key;

function renderBody(overrides: Partial<WebPopoverBodyProps>): string {
  const base: WebPopoverBodyProps = {
    info: { running: false },
    allowInput: false,
    expose: false,
    tailscale: false,
    allowTranscript: false,
    allowUpload: false,
    allowDangerousLaunch: false,
    advancedOpen: false,
    onToggleAdvanced: vi.fn(),
    busy: false,
    copied: null,
    onToggleAllowInput: vi.fn(),
    onToggleExpose: vi.fn(),
    onToggleTailscale: vi.fn(),
    onToggleAllowTranscript: vi.fn(),
    onToggleAllowUpload: vi.fn(),
    onToggleAllowDangerousLaunch: vi.fn(),
    onOpenLink: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onCopyUrl: vi.fn(),
    onOpenUrl: vi.fn(),
    onOpenDevices: vi.fn(),
    t,
  };
  return renderToStaticMarkup(createElement(WebPopoverBody, { ...base, ...overrides }));
}

/** A tailnet server: loopback bind behind an HTTPS front another machine can reach. */
const tailnet: WebTerminalInfo = {
  running: true,
  host: '127.0.0.1',
  port: 7681,
  urls: ['https://desk.tail1234.ts.net/?token=T', 'http://127.0.0.1:7681/?token=T'],
  allowedHosts: ['desk.tail1234.ts.net'],
  tailscale: true,
};

describe('computer pairing link', () => {
  it('builds the fragment link on the secure origin only for the computer card', () => {
    const computer = { ...tailnet, pairCode: 'QWXZ7K9M', pendingDeviceName: 'Computer', pendingPairFlow: 'computer' as const };
    expect(webComputerLink(computer)).toBe('https://desk.tail1234.ts.net/pair#wmux-desktop-code=QWXZ7K9M');
    // The phone QR never carries a computer code.
    expect(webQrPayload(computer)).toBe('');
    const phone = { ...computer, pendingPairFlow: 'phone' as const };
    expect(webComputerLink(phone)).toBe('');
    expect(webQrPayload(phone)).toContain('/pair?code=QWXZ7K9M');
  });

  it('offers no link without an HTTPS origin another machine can reach', () => {
    const loopback: WebTerminalInfo = {
      running: true,
      host: '127.0.0.1',
      urls: ['http://127.0.0.1:7681/?token=T'],
      pairCode: 'QWXZ7K9M',
      pendingDeviceName: 'Computer',
      pendingPairFlow: 'computer',
    };
    expect(webComputerLink(loopback)).toBe('');
    const exposedPlain = { ...loopback, host: '0.0.0.0', urls: ['http://192.168.1.5:7681/?token=T'] };
    expect(webComputerLink(exposedPlain)).toBe('');
    const tls = { ...loopback, host: '0.0.0.0', tls: true, urls: ['https://192.168.1.5:7681/?token=T'] };
    expect(webComputerLink(tls)).toBe('https://192.168.1.5:7681/pair#wmux-desktop-code=QWXZ7K9M');
  });

  it('offers no link once the code has expired, rather than a dead link at 0:00', () => {
    const computer = {
      ...tailnet,
      pairCode: 'QWXZ7K9M',
      pairExpiresAt: 1_000,
      pendingDeviceName: 'Computer',
      pendingPairFlow: 'computer' as const,
    };
    expect(webComputerLink(computer, 999)).toContain('QWXZ7K9M');
    expect(webComputerLink(computer, 1_001)).toBe('');
  });

  it('reads a daemon that predates flows as the phone card', () => {
    expect(pendingPairFlow({ running: true, pairCode: 'X', pendingDeviceName: 'n' })).toBe('phone');
    expect(pendingPairFlow({ running: true, pairCode: 'X' })).toBeNull();
  });

});

describe('Phone access settings — no pairing in it', () => {
  const PAIRING = ['web.phonePairing', 'web.connectComputer', 'web.qrAlt', 'wmux-desktop-code', '<input'];

  it('running: share state, open here, the grants and Stop, and nothing that mints a code', () => {
    const html = renderBody({ info: tailnet });
    for (const k of ['web.shareThisComputer', 'web.openHere', 'web.phoneAccess', 'web.allowInput', 'web.stop']) expect(html).toContain(k);
    for (const k of PAIRING) expect(html).not.toContain(k);
  });

  it('running with a live code: the code stays out of settings (the dialog shows it)', () => {
    const html = renderBody({ info: { ...tailnet, pairCode: 'QWXZ7K9M', pendingDeviceName: 'iPhone', pendingPairFlow: 'phone' } });
    expect(html).not.toContain('QWXZ7K9M');
  });

  it('stopped: the Tailscale fix sits above the options and is the one primary until a start is reachable', () => {
    const unticked = renderBody({ tailscaleCheck: { state: 'ok' }, onTurnOnHttps: vi.fn() });
    expect(unticked.indexOf('web.computerTurnOnHttps')).toBeLessThan(unticked.indexOf('web.allowInput'));
    expect(unticked).toMatch(/ui-btn-primary[^>]*>web\.computerTurnOnHttps/);
    expect(unticked.split('ui-btn-primary').length - 1).toBe(1);
    const ticked = renderBody({ tailscale: true, tailscaleCheck: { state: 'ok' }, onTurnOnHttps: vi.fn() });
    expect(ticked).toMatch(/<button[^>]*class="ui-btn ui-btn-primary[^"]*"[^>]*>web\.start</);
    expect(ticked.split('ui-btn-primary').length - 1).toBe(1);
    for (const k of PAIRING) expect(unticked).not.toContain(k);
  });

  it('a running server without HTTPS is not restarted from here', () => {
    const html = renderBody({
      info: { running: true, host: '127.0.0.1', urls: ['http://127.0.0.1:7681/?token=T'] },
      tailscaleCheck: { state: 'ok' },
      onTurnOnHttps: vi.fn(),
    });
    expect(html).not.toContain('web.computerTurnOnHttps');
    expect(html).toContain('web.stop');
  });
});

describe('device status line', () => {
  it('counts live devices by kind and how many are here now; revoked ones never count', () => {
    const summary = summarizeRoster([
      { deviceId: 'a', name: 'iPhone', createdAt: 1, lastSeenAt: 1, allowInput: false, kind: 'phone', activeNow: true },
      { deviceId: 'b', name: 'Laptop', createdAt: 1, lastSeenAt: 1, allowInput: true, kind: 'computer', activeNow: false },
      { deviceId: 'c', name: 'Old', createdAt: 1, lastSeenAt: 1, allowInput: true, kind: 'unknown' },
      { deviceId: 'd', name: 'Gone', createdAt: 1, lastSeenAt: 1, allowInput: true, kind: 'phone', activeNow: true, revokedAt: 2 },
    ]);
    expect(summary).toEqual({ total: 3, active: 1, phones: 1, computers: 1, other: 1 });
  });

  it('renders "N paired · M active now" with kind glyphs once the roster is read', () => {
    const html = renderBody({ info: tailnet, roster: { total: 3, active: 1, phones: 2, computers: 1, other: 0 } });
    expect(html).toContain('web.devicesCount · web.devicesActive');
    expect(html).not.toContain('>web.devicesLink<');
  });

  it('falls back to the plain roster link before (or without) a successful read', () => {
    const html = renderBody({ info: tailnet, roster: null });
    expect(html).toContain('>web.devicesLink<');
  });
});
