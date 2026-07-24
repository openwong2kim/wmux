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
    busy: false,
    copied: null,
    onToggleAllowInput: vi.fn(),
    onToggleExpose: vi.fn(),
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
    expect(html).toContain('web.newPairCode');
  });

  it('offers both connection paths: an openable URL and a token-free pair address', () => {
    const html = renderBody({ info: runningInfo });
    expect(html).toContain('web.openHere');
    expect(html).toContain('web.onPhone');
    // The phone address must not carry the token — that is the point of the code.
    expect(html).toContain('/pair');
  });
});
