/**
 * WebToggle — wmux web titlebar toggle.
 *
 * vitest runs in `node` env (no jsdom / @testing-library), so — like
 * StatusBar.test.tsx — this tests:
 *   1. Pure helpers (primaryWebUrl, webBindLabel) directly.
 *   2. The presentational WebPopoverBody via renderToStaticMarkup, driven by
 *      controlled props (effects don't run at the module boundary).
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  primaryWebUrl,
  splitLinkedLine,
  webQrPayload,
  webBindLabel,
  uniqueDeviceName,
  oneClickReachable,
  WebPopoverBody,
  type WebPopoverBodyProps,
} from '../WebToggle';
import type { WebTerminalInfo } from '../../../../shared/web';

// Identity translator: return the key so assertions can match on it. The real
// strings live in en.ts; the markup structure is what matters here.
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

describe('splitLinkedLine', () => {
  it('splits out the one URL and keeps the text either side', () => {
    expect(splitLinkedLine('  • Install it from https://tailscale.com/download, then run x.')).toEqual({
      before: '  • Install it from ',
      url: 'https://tailscale.com/download',
      after: ', then run x.',
    });
  });

  it('leaves a plain line alone', () => {
    expect(splitLinkedLine('Error: tailscale is not on PATH.')).toEqual({
      before: 'Error: tailscale is not on PATH.',
      url: '',
      after: '',
    });
  });

  it('stops the URL at a comma or paren, which these lines use as punctuation', () => {
    expect(splitLinkedLine('see https://a.b/c) now').url).toBe('https://a.b/c');
    expect(splitLinkedLine('see https://a.b/c, now').url).toBe('https://a.b/c');
  });
});

describe('webQrPayload', () => {
  it('carries the address AND the code, so the phone types nothing', () => {
    expect(
      webQrPayload({
        running: true,
        urls: ['https://box.tail1234.ts.net/?token=t'],
        pairCode: 'ABCD2345',
      }),
    ).toBe('https://box.tail1234.ts.net/pair?code=ABCD2345');
  });

  it('is empty without a code — a QR that still needs typing is a half-measure', () => {
    expect(
      webQrPayload({ running: true, urls: ['https://box.tail1234.ts.net/?token=t'] }),
    ).toBe('');
  });

  it('is empty when no address is reachable', () => {
    expect(webQrPayload({ running: true, urls: [], pairCode: 'ABCD2345' })).toBe('');
  });

  it('percent-encodes the code rather than trusting it', () => {
    expect(
      webQrPayload({
        running: true,
        urls: ['https://box.tail1234.ts.net/?token=t'],
        pairCode: 'A B&C',
      }),
    ).toBe('https://box.tail1234.ts.net/pair?code=A%20B%26C');
  });
});

describe('WebToggle pure helpers', () => {
  it('primaryWebUrl returns the first URL or empty string', () => {
    expect(primaryWebUrl({ running: true, urls: ['http://a', 'http://b'] })).toBe('http://a');
    expect(primaryWebUrl({ running: true, urls: [] })).toBe('');
    expect(primaryWebUrl({ running: false })).toBe('');
  });

  it('webBindLabel formats host:port and tolerates partials', () => {
    expect(webBindLabel({ running: true, host: '127.0.0.1', port: 7681 })).toBe('127.0.0.1:7681');
    expect(webBindLabel({ running: false })).toBe('');
  });
});

describe('uniqueDeviceName', () => {
  const device = (name: string, revokedAt?: number) => ({
    deviceId: name,
    name,
    createdAt: 1,
    lastSeenAt: 1,
    allowInput: false,
    ...(revokedAt !== undefined ? { revokedAt } : {}),
  });

  it('is the bare base on an empty or unread roster', () => {
    expect(uniqueDeviceName('Phone', [])).toBe('Phone');
    expect(uniqueDeviceName('Phone', null)).toBe('Phone');
  });

  it('counts up past live names, case-insensitively, and the pending one', () => {
    expect(uniqueDeviceName('Phone', [device('phone'), device('Phone 2')])).toBe('Phone 3');
    expect(uniqueDeviceName('Phone', [device('Phone')], 'Phone 2')).toBe('Phone 3');
  });

  it('a revoked device frees its name', () => {
    expect(uniqueDeviceName('Phone', [device('Phone', 5)])).toBe('Phone');
  });

  it('stays inside the name cap', () => {
    const long = 'x'.repeat(40);
    const name = uniqueDeviceName(long, [device('x'.repeat(32))]);
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name.endsWith(' 2')).toBe(true);
  });
});

describe('oneClickReachable', () => {
  it('the LAN when ticked, or a ticked tailnet known to work', () => {
    expect(oneClickReachable(true, false, { state: 'checking' })).toBe(true);
    expect(oneClickReachable(false, true, { state: 'ok' })).toBe(true);
    expect(oneClickReachable(false, true, { state: 'checking' })).toBe(false);
    expect(oneClickReachable(false, true, { state: 'problem', lines: [] })).toBe(false);
    // Loopback only: a code minted there reaches nothing off this machine.
    expect(oneClickReachable(false, false, { state: 'ok' })).toBe(false);
  });

  it('trusts the ticked box when this bridge cannot check', () => {
    expect(oneClickReachable(false, true, undefined)).toBe(true);
    expect(oneClickReachable(false, false, undefined)).toBe(false);
  });
});

describe('WebPopoverBody — stopped readiness', () => {
  const stopped = { info: { running: false } } as const;

  it('while Tailscale is being checked: says so, nothing is primary', () => {
    const html = renderBody({ ...stopped, tailscale: false, tailscaleCheck: { state: 'checking' } });
    expect(html).toContain('web.wizardChecking');
    expect(html).not.toContain('ui-btn-primary');
  });

  it('when Tailscale cannot front it: quotes why, with the link', () => {
    const html = renderBody({
      ...stopped,
      tailscaleCheck: { state: 'problem', lines: ['Install it from https://tailscale.com/download, then sign in.'] },
    });
    expect(html).toContain('>https://tailscale.com/download</button>');
    expect(html).not.toContain('web.computerTurnOnHttps');
  });

  it('usable but unticked: the inline fix is the primary', () => {
    const html = renderBody({ ...stopped, tailscale: false, tailscaleCheck: { state: 'ok' }, onTurnOnHttps: vi.fn() });
    expect(html).toContain('web.connectPhoneNeedsTailscale');
    expect(html).toMatch(/ui-btn-primary[^>]*>web\.computerTurnOnHttps/);
    expect(html.split('ui-btn-primary').length - 1).toBe(1);
  });

  it('a ticked LAN makes Start the primary (the daemon then says why a phone cannot pair)', () => {
    const html = renderBody({ ...stopped, expose: true, tailscaleCheck: { state: 'problem', lines: [] } });
    expect(html).toMatch(/ui-btn-primary[^>]*>web\.start/);
  });
});

describe('WebPopoverBody — off state', () => {
  const html = renderBody({ info: { running: false }, tailscale: true, tailscaleCheck: { state: 'ok' } });

  it('keeps the options and Start, and pairs nothing', () => {
    expect(html).not.toContain('<input');
    expect(html).toContain('web.shareThisComputer');
    expect(html).toContain('web.allowInput');
    expect(html).toContain('web.expose');
    expect(html).toContain('web.start');
  });

  it('surfaces the scrollback-exposure warning', () => {
    expect(html).toContain('web.scrollbackWarning');
  });

  it('Start uses the single amber primary fill', () => {
    expect(html).toMatch(/ui-btn-primary[^>]*>web\.start/);
    // One primary per surface: nothing else in the stopped body is filled.
    expect(html.split('ui-btn-primary').length - 1).toBe(1);
  });

  it('draws the options as token checkboxes, not native OS boxes', () => {
    expect(html).not.toContain('type="checkbox"');
    // Input, tailnet, expose, conversation access, photo upload.
    expect(html.split('role="checkbox"').length - 1).toBe(5);
    expect(html).toContain('aria-checked="false"');
    expect(renderBody({ info: { running: false }, allowInput: true })).toContain('aria-checked="true"');
  });

  it('shows the actual control error instead of misreporting every failure as offline', () => {
    const offline = renderBody({ info: { running: false, error: 'boom' } });
    expect(offline).toContain('boom');
    expect(offline).not.toContain('web.daemonOffline');
  });

  it('reflects a busy Start as "starting"', () => {
    const busy = renderBody({ info: { running: false }, busy: true });
    expect(busy).toContain('web.starting');
    expect(busy).toContain('disabled');
    // An in-flight action is never the primary.
    expect(busy).not.toContain('ui-btn-primary');
  });
});

describe('WebPopoverBody — on state', () => {
  const runningInfo: WebTerminalInfo = {
    running: true,
    host: '127.0.0.1',
    port: 7681,
    clients: 2,
    urls: ['http://127.0.0.1:7681/'],
    pairCode: '48293576',
    pendingDeviceName: 'my iPhone',
    allowInput: false,
  };

  it('shows bind label, viewers, URL and copy button, and never the live pair code', () => {
    const html = renderBody({ info: runningInfo });
    expect(html).toContain('127.0.0.1:7681');
    expect(html).toContain('web.viewers');
    expect(html).toContain('http://127.0.0.1:7681/');
    expect(html).toContain('web.copy');
    // Settings pairs nothing: the code is the Pair a phone dialog's.
    expect(html).not.toContain('48293576');
  });

  it('read-only mode shows the read-only line, not INPUT ENABLED', () => {
    const html = renderBody({ info: runningInfo });
    expect(html).toContain('web.readOnly');
    expect(html).not.toContain('web.inputEnabled');
  });

  it('input-enabled mode shows INPUT ENABLED as the warning badge', () => {
    const html = renderBody({ info: { ...runningInfo, allowInput: true } });
    expect(html).toContain('web.inputEnabled');
    expect(html).toContain('data-tone="warning"');
  });

  it('exposed bind surfaces the 0.0.0.0 warning; loopback does not', () => {
    const exposed = renderBody({ info: { ...runningInfo, host: '0.0.0.0' } });
    expect(exposed).toContain('web.exposeWarning');
    const loopback = renderBody({ info: runningInfo });
    expect(loopback).not.toContain('web.exposeWarning');
  });

  it('Stop is a neutral secondary button (not red, not the amber primary)', () => {
    const html = renderBody({ info: runningInfo });
    expect(html).toContain('web.stop');
    expect(html).toContain('ui-btn-secondary');
    expect(html).not.toContain('ui-btn-primary');
    expect(html).not.toContain('accent-red');
  });

  it('shows the exact stop error when the listener is still running', () => {
    const html = renderBody({
      info: { ...runningInfo, error: 'listener close failed' },
    });
    expect(html).toContain('listener close failed');
    expect(html).toContain('<p class="ui-row-error">listener close failed</p>');
    expect(html).toContain('web.stop');
  });

  it('only the copied field swaps its label', () => {
    const html = renderBody({ info: runningInfo, copied: 'url' });
    // Exactly one button reads "Copied"; the others still offer to copy.
    expect(html.split('web.copied').length - 1).toBe(1);
    expect(renderBody({ info: runningInfo })).toContain('web.copy');
  });

  it('offers the tailnet transport before the server is started', () => {
    const html = renderBody({ info: { running: false } });
    expect(html).toContain('web.tailscale');
    expect(html).toContain('web.expose');
  });

  it('says what Expose does NOT buy, but only once it is ticked', () => {
    expect(renderBody({ info: { running: false }, expose: false })).not.toContain(
      'web.exposeNoPairing',
    );
    // Since #616 a plaintext bind serves panes but cannot pair a phone. A
    // checkbox that silently means "watch only" is how someone hits a 403.
    expect(renderBody({ info: { running: false }, expose: true })).toContain(
      'web.exposeNoPairing',
    );
  });

  it('surfaces a failed transport start instead of failing silently', () => {
    const html = renderBody({
      info: {
        running: false,
        transportError: { reason: 'not-installed', lines: ['tailscale is not installed'] },
      },
    });
    expect(html).toContain('tailscale is not installed');
  });

  it('★ makes the install link clickable instead of something to retype', () => {
    // describeTailscaleProblem writes for a terminal, where a URL can be
    // selected and pasted. In a popover the whole point of the line is "go
    // install this", so leaving it as dead text is the worst last step.
    const html = renderBody({
      info: {
        running: false,
        transportError: {
          reason: 'not-installed',
          lines: ['  • Install it from https://tailscale.com/download, then run `tailscale up`.'],
        },
      },
    });
    expect(html).toContain('<button');
    expect(html).toContain('https://tailscale.com/download');
    // The text around it survives — the trailing instruction matters as much
    // as the link.
    expect(html).toContain('then run');
  });
});

describe('WebPopoverBody — phone grants', () => {
  const running: WebTerminalInfo = {
    running: true,
    host: '127.0.0.1',
    port: 7681,
    urls: ['http://127.0.0.1:7681/?token=t'],
  };

  it('offers conversation access and photo upload before a start', () => {
    const html = renderBody({ allowInput: true, allowTranscript: true });
    expect(html).toContain('web.allowTranscript');
    expect(html).toContain('web.allowTranscriptHint');
    expect(html).toContain('web.allowUpload');
    expect(html).toContain('web.allowUploadHint');
  });

  it('shows the running server\'s effective grants, not the next-start choice', () => {
    const html = renderBody({
      info: { ...running, allowTranscript: true, allowUpload: false },
      // The local next-start state disagrees on purpose: status must win.
      allowTranscript: false,
      allowUpload: true,
    });
    expect(html).toContain('web.phoneAccess');
    const checked = [...html.matchAll(/role="checkbox"[^>]*aria-checked="(true|false)"/g)].map((m) => m[1]);
    // Order: transcript, upload (the device grant is a choice now, not a box).
    expect(checked.slice(-2)).toEqual(['true', 'false']);
  });

  it('never hides a dangerous launch that is on, even with the disclosure closed', () => {
    const html = renderBody({ info: { ...running, allowDangerousLaunch: true }, advancedOpen: false });
    expect(html).toContain('web.allowDangerousLaunchWarning');
    expect(renderBody({ allowDangerousLaunch: true, advancedOpen: false })).toContain('web.allowDangerousLaunchWarning');
  });

  it('keeps dangerous launch behind a closed Advanced disclosure by default', () => {
    const closed = renderBody({});
    expect(closed).toContain('web.advanced');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('web.allowDangerousLaunch');
  });

  it('an open Advanced disclosure shows the toggle with its warning, bound to status while running', () => {
    const html = renderBody({
      info: { ...running, allowDangerousLaunch: true },
      allowDangerousLaunch: false,
      advancedOpen: true,
    });
    expect(html).toContain('web.allowDangerousLaunch');
    expect(html).toContain('web.allowDangerousLaunchWarning');
    const checked = [...html.matchAll(/role="checkbox"[^>]*aria-checked="(true|false)"/g)].map((m) => m[1]);
    expect(checked[checked.length - 1]).toBe('true');
  });
});

describe('WebPopoverBody — port and firewall notices', () => {
  const slot = (id: string) => createElement('div', { 'data-slot': id });

  it('stopped: the explained bind failure replaces the raw error', () => {
    const html = renderBody({ info: { running: false, error: 'listen EADDRINUSE: address already in use 127.0.0.1:7681' }, listenNotice: slot('listen') });
    expect(html).toContain('data-slot="listen"');
    expect(html).not.toContain('listen EADDRINUSE');
  });

  it('running and exposed: the firewall notice; on loopback: none', () => {
    const exposed = renderBody({ info: { running: true, port: 7681, host: '0.0.0.0', token: 'tok' }, firewallNotice: slot('firewall') });
    expect(exposed).toContain('data-slot="firewall"');
    const loopback = renderBody({ info: { running: true, port: 7681, host: '127.0.0.1', token: 'tok' }, firewallNotice: slot('firewall') });
    expect(loopback).not.toContain('data-slot="firewall"');
  });
});
