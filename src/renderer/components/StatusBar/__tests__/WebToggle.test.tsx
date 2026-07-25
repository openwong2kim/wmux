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
    busy: false,
    copied: null,
    deviceName: '',
    qr: null,
    onToggleAllowInput: vi.fn(),
    onToggleExpose: vi.fn(),
    onToggleTailscale: vi.fn(),
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
        pairCode: 'ABC123',
      }),
    ).toBe('https://box.tail1234.ts.net/pair?code=ABC123');
  });

  it('is empty without a code — a QR that still needs typing is a half-measure', () => {
    expect(
      webQrPayload({ running: true, urls: ['https://box.tail1234.ts.net/?token=t'] }),
    ).toBe('');
  });

  it('is empty when no address is reachable', () => {
    expect(webQrPayload({ running: true, urls: [], pairCode: 'ABC123' })).toBe('');
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

describe('WebPopoverBody — off state', () => {
  const html = renderBody({ info: { running: false } });

  it('shows the headline, both checkboxes and the Start primary', () => {
    expect(html).toContain('web.headline');
    expect(html).toContain('web.allowInput');
    expect(html).toContain('web.expose');
    expect(html).toContain('web.start');
  });

  it('surfaces the scrollback-exposure warning', () => {
    expect(html).toContain('web.scrollbackWarning');
  });

  it('Start uses the single amber primary fill', () => {
    expect(html).toContain('bg-[var(--accent)]');
  });

  it('shows the daemon-offline note when info carries an error', () => {
    const offline = renderBody({ info: { running: false, error: 'boom' } });
    expect(offline).toContain('web.daemonOffline');
  });

  it('reflects a busy Start as "starting"', () => {
    const busy = renderBody({ info: { running: false }, busy: true });
    expect(busy).toContain('web.starting');
    expect(busy).toContain('disabled');
  });
});

describe('WebPopoverBody — on state', () => {
  const runningInfo: WebTerminalInfo = {
    running: true,
    host: '127.0.0.1',
    port: 7681,
    clients: 2,
    urls: ['http://127.0.0.1:7681/'],
    pairCode: '482913',
    // A code only reaches the operator once a device has been named. An
    // unnamed one is withheld on purpose — see the naming tests below.
    pendingDeviceName: 'my iPhone',
    allowInput: false,
  };

  it('shows bind label, viewers, URL, copy button and the LARGE pair code', () => {
    const html = renderBody({ info: runningInfo });
    expect(html).toContain('127.0.0.1:7681');
    expect(html).toContain('web.viewers');
    expect(html).toContain('http://127.0.0.1:7681/');
    expect(html).toContain('web.copy');
    expect(html).toContain('482913');
    expect(html).toContain('text-[22px]'); // pair code rendered large
    expect(html).toContain('web.pairValidity');
  });

  it('read-only mode shows the read-only line, not INPUT ENABLED', () => {
    const html = renderBody({ info: runningInfo });
    expect(html).toContain('web.readOnly');
    expect(html).not.toContain('web.inputEnabled');
  });

  it('input-enabled mode shows INPUT ENABLED in amber', () => {
    const html = renderBody({ info: { ...runningInfo, allowInput: true } });
    expect(html).toContain('web.inputEnabled');
    expect(html).toContain('text-[var(--accent)]');
  });

  it('exposed bind surfaces the 0.0.0.0 warning; loopback does not', () => {
    const exposed = renderBody({ info: { ...runningInfo, host: '0.0.0.0' } });
    expect(exposed).toContain('web.exposeWarning');
    const loopback = renderBody({ info: runningInfo });
    expect(loopback).not.toContain('web.exposeWarning');
  });

  it('Stop is a neutral raised button (not red)', () => {
    const html = renderBody({ info: runningInfo });
    expect(html).toContain('web.stop');
    expect(html).toContain('bg-[var(--bg-surface)]');
    expect(html).not.toContain('accent-red');
  });

  it('only the copied field swaps its label', () => {
    const html = renderBody({ info: runningInfo, copied: 'pairCode' });
    // Exactly one button reads "Copied"; the others still offer to copy.
    expect(html.split('web.copied').length - 1).toBe(1);
    expect(html).toContain('web.copy');
  });

  it('offers a way back when the pairing code is spent, instead of hiding the section', () => {
    const html = renderBody({ info: { ...runningInfo, pairCode: undefined } });
    expect(html).toContain('web.onPhone');
    // A spent code lands back on the name field, which IS the way back: the
    // next device needs a name anyway, and minting from there gives it one.
    expect(html).toContain('web.showPairCode');
  });

  it('★ the QR replaces the address text, and copy stays reachable', () => {
    const html = renderBody({
      info: runningInfo,
      qr: { d: 'M0 0h1v1h-1z', size: 21 },
    });
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox="0 0 21 21"');
    // The address as text is redundant once a scan carries it AND the code, and
    // this popover is a fixed 288px box — so it is replaced, not stacked on.
    expect(html).not.toContain('/pair</span>');
    // A phone that will not scan still needs the link.
    expect(html).toContain('web.copyLink');
  });

  it('falls back to the address text when there is no QR', () => {
    const html = renderBody({ info: runningInfo, qr: null });
    expect(html).not.toContain('<svg');
    expect(html).toContain('/pair');
  });

  it('★ withholds the code until a device has been named', () => {
    // A code exists from the moment the server starts. Showing that one is how
    // a roster fills with "Unnamed device" rows nobody can tell apart, which
    // makes revoking a single device impossible.
    const html = renderBody({
      info: { ...runningInfo, pendingDeviceName: undefined },
      deviceName: '',
    });
    expect(html).not.toContain('482913');
    expect(html).toContain('web.nameHint');
    expect(html).toContain('web.showPairCode');
  });

  it('names the device the code will register, next to the code', () => {
    // The shared identity translator returns the KEY, which carries no
    // `{name}` placeholder, so interpolation would silently no-op. This one
    // case needs a translator shaped like the real string to test at all.
    const html = renderBody({
      info: runningInfo,
      t: (key: string) => (key === 'web.pairingAs' ? 'Pairing as {name}' : key),
    });
    expect(html).toContain('482913');
    // The code outlives the moment the name was typed by ten minutes, and a
    // mis-labelled roster is only discovered when one entry of eight must go.
    expect(html).toContain('Pairing as my iPhone');
  });

  it('cannot mint without a name', () => {
    const empty = renderBody({ info: { ...runningInfo, pendingDeviceName: undefined }, deviceName: '   ' });
    expect(empty).toContain('disabled=""');
    const named = renderBody({
      info: { ...runningInfo, pendingDeviceName: undefined },
      deviceName: 'phone',
    });
    // Same button, now reachable.
    expect(named).toContain('web.showPairCode');
    expect(named.split('disabled=""').length).toBeLessThan(empty.split('disabled=""').length);
  });

  it('offers both connection paths: an openable URL and a token-free pair address', () => {
    const html = renderBody({ info: runningInfo });
    expect(html).toContain('web.openHere');
    expect(html).toContain('web.onPhone');
    // The phone address must not carry the token — that is the point of the code.
    expect(html).toContain('/pair');
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

  it('★ a refusal REPLACES the pairing code rather than sitting beside it', () => {
    // The code is left LIVE on purpose. Blanking it would test that a missing
    // code renders nothing, which is not the invariant — the invariant is that
    // a refusal wins over a code that does exist, because that is the state a
    // server on a plaintext bind is actually in (start() always mints one).
    const html = renderBody({
      info: {
        ...runningInfo,
        pairRefusal: { reason: 'insecure-transport', detail: 'plaintext bind' },
      },
    });
    expect(html).toContain('web.refusalInsecure');
    expect(html).toContain('web.refusalInsecureFix');
    // A code shown next to "pairing is unavailable" is still a code someone
    // will read onto a phone. The whole fix is that it is not there.
    //
    // Asserted against the FIXTURE's code (482913). An earlier version checked
    // for 'ABC123', which this fixture never contains — so it passed no matter
    // what the component rendered, leaving the regression it names unguarded.
    expect(html).not.toContain('482913');
    expect(html).not.toContain('web.newPairCode');
  });

  it('★ a vanished tailnet front gets its own reason, not the plaintext one', () => {
    const html = renderBody({
      info: {
        ...runningInfo,
        pairCode: undefined,
        pairRefusal: { reason: 'no-front', detail: 'serve config missing' },
      },
    });
    expect(html).toContain('web.refusalNoFront');
    expect(html).not.toContain('web.refusalInsecure');
  });
});
