/**
 * The Remote hub's "Share this computer" section: phone and computer cards on
 * one code slot, the computer link, and the device-status line.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatCountdown,
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
    deviceName: '',
    qr: null,
    onToggleAllowInput: vi.fn(),
    onToggleExpose: vi.fn(),
    onToggleTailscale: vi.fn(),
    onToggleAllowTranscript: vi.fn(),
    onToggleAllowUpload: vi.fn(),
    onToggleAllowDangerousLaunch: vi.fn(),
    onDeviceNameChange: vi.fn(),
    onStartPairing: vi.fn(),
    onOpenLink: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onCopyUrl: vi.fn(),
    onCopyPairUrl: vi.fn(),
    onCopyPairCode: vi.fn(),
    onOpenUrl: vi.fn(),
    onNewPairCode: vi.fn(),
    onOpenDevices: vi.fn(),
    pairAllowInput: false,
    onTogglePairAllowInput: vi.fn(),
    computerDeviceName: 'Computer',
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

  it('draws a refused start in the design error colour, not muted text', () => {
    const html = renderBody({ info: { ...tailnet, pairStartError: 'refused' }, pairErrorFlow: 'computer' });
    expect(html).toContain('<p class="ui-row-error">refused</p>');
  });

  it('reads a daemon that predates flows as the phone card', () => {
    expect(pendingPairFlow({ running: true, pairCode: 'X', pendingDeviceName: 'n' })).toBe('phone');
    expect(pendingPairFlow({ running: true, pairCode: 'X' })).toBeNull();
  });

  it('formats the countdown as m:ss and never negative', () => {
    expect(formatCountdown(600_000)).toBe('10:00');
    expect(formatCountdown(61_001)).toBe('1:02');
    expect(formatCountdown(9_000)).toBe('0:09');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('Share this computer — the two cards', () => {
  it('a running server without HTTPS keeps the Stop/Start note — no in-place restart', () => {
    const html = renderBody({
      info: { running: true, host: '127.0.0.1', urls: ['http://127.0.0.1:7681/?token=T'] },
      tailscaleCheck: { state: 'ok' },
      onTurnOnHttps: vi.fn(),
    });
    expect(html).toContain('web.connectComputer');
    expect(html).toContain('web.computerNeedsHttps');
    expect(html).toMatch(/disabled="">web\.computerCopyNewLink/);
    expect(html).not.toContain('web.computerTurnOnHttps');
  });

  it('names the transport refusal instead of the generic reason when one applies', () => {
    const html = renderBody({
      info: { running: true, host: '0.0.0.0', urls: ['http://192.168.1.5:7681/?token=T'], pairRefusal: { reason: 'insecure-transport', detail: 'x' } },
    });
    expect(html).toContain('web.refusalInsecure');
    expect(html).not.toContain('web.computerNeedsHttps');
  });

  it('shows the computer form, prefilled and enabled, on a secure origin', () => {
    const html = renderBody({ info: tailnet });
    expect(html).toContain('value="Computer"');
    expect(html).toMatch(/<button[^>]*class="ui-btn ui-btn-secondary[^"]*"[^>]*>web\.computerCopyNewLink</);
    expect(html).not.toMatch(/disabled="">web\.computerCopyNewLink/);
    expect(html).toContain('web.pairAllowInput');
  });

  it('while a PHONE pairing is live, the computer card offers only to cancel it', () => {
    const html = renderBody({ info: { ...tailnet, pairCode: 'QWXZ7K9M', pendingDeviceName: 'iPhone', pendingPairFlow: 'phone' } });
    expect(html).toContain('web.phonePairingInProgress');
    expect(html).toContain('web.cancelPairing');
    expect(html).not.toContain('web.computerCopyNewLink');
    expect(html).not.toContain('wmux-desktop-code');
  });

  it('while a COMPUTER pairing is live, the phone card offers only to cancel it and shows no code', () => {
    const html = renderBody({
      info: { ...tailnet, pairCode: 'QWXZ7K9M', pendingDeviceName: 'Computer', pendingPairFlow: 'computer' },
      pairRemainingMs: 581_000,
    });
    expect(html).toContain('web.computerPairingInProgress');
    expect(html).not.toContain('web.connectPhonePair');
    // Exactly one place shows the code: the computer link.
    expect(html.match(/QWXZ7K9M/g)).toHaveLength(1);
    expect(html).toContain('https://desk.tail1234.ts.net/pair#wmux-desktop-code=QWXZ7K9M');
    expect(html).toContain('web.computerLinkExpires');
    expect(html).toContain('web.copyLink');
  });

  it('lands a refused start under the card that asked', () => {
    const info = { ...tailnet, pairStartError: 'another pairing is in progress — cancel it first' };
    const asComputer = renderBody({ info, pairErrorFlow: 'computer' });
    const asPhone = renderBody({ info, pairErrorFlow: 'phone' });
    const idx = (html: string) => [html.indexOf('web.connectComputer'), html.indexOf('another pairing')];
    const [computerHeader, computerErr] = idx(asComputer);
    expect(computerErr).toBeGreaterThan(computerHeader);
    const [phoneCardHeader, phoneErr] = idx(asPhone);
    expect(phoneErr).toBeLessThan(phoneCardHeader);
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
