import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_PROTOCOL_SCHEME } from '../../../shared/pluginHost';
import { PREVIEW_PROTOCOL_SCHEME } from '../../../shared/filePreview';
import { MAIN_WINDOW_PRODUCTION_CSP, productionResponseHeaders } from '../createWindow';

function parseDirectives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe('main-window production CSP', () => {
  it('allows the registered plugin scheme only as a frame source', () => {
    const directives = parseDirectives(MAIN_WINDOW_PRODUCTION_CSP);
    const pluginSource = `${PLUGIN_PROTOCOL_SCHEME}:`;

    expect(directives.get('frame-src')).toContain(pluginSource);

    expect(directives.get('default-src'), 'default-src must remain self-only').toEqual(["'self'"]);
    expect(directives.get('connect-src'), 'connect-src: self plus the preview scheme only').toEqual(["'self'", `${PREVIEW_PROTOCOL_SCHEME}:`]);
    // #1641: WebAssembly compilation for the inline-image decoders, nothing
    // more — no 'unsafe-eval', no extra script origins.
    expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);

    for (const [directive, sources] of directives) {
      if (directive !== 'frame-src') {
        expect(sources, `${directive} must not allow plugin resources`).not.toContain(pluginSource);
      }
    }
  });

  it('allows the preview scheme as an image and fetch source only, never a frame', () => {
    const directives = parseDirectives(MAIN_WINDOW_PRODUCTION_CSP);
    const previewSource = `${PREVIEW_PROTOCOL_SCHEME}:`;
    for (const [directive, sources] of directives) {
      const allowed = directive === 'img-src' || directive === 'connect-src';
      expect(sources.includes(previewSource), `${directive} and the preview scheme`).toBe(allowed);
    }
  });

  it('serves a page whose markup carries no inline handler, which script-src would block', () => {
    // An inline on* attribute never runs under this policy, and Chromium logs a violation for each one.
    const html = fs.readFileSync(path.resolve(__dirname, '../../../../index.html'), 'utf8');
    expect(html.match(/\son[a-z]+\s*=/gi) ?? []).toEqual([]);
  });
});

describe('plugin response CSP', () => {
  it('uses the isolated plugin policy without the overriding main policy', () => {
    const headers = productionResponseHeaders('wmux-plugin://example/page.html', {
      'content-security-policy': ['old'], 'Content-Type': ['text/html'],
    });
    expect(headers['content-security-policy']).toBeUndefined();
    expect(headers['Content-Type']).toEqual(['text/html']);
    const policy = parseDirectives(headers['Content-Security-Policy'][0]);
    expect(policy.get('default-src')).toEqual(["'none'"]);
    expect(policy.get('script-src')).toEqual(['wmux-plugin:', "'unsafe-inline'"]);
    expect(policy.has('connect-src')).toBe(false);
    expect(policy.get('frame-src')).toEqual(["'none'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
  });
  it('preserves all origin restrictions on nonplugin responses', () => {
    expect(productionResponseHeaders('https://example.com', {
      'content-security-policy': ["frame-ancestors 'none'"],
      'Content-Security-Policy': ["script-src 'nonce-example'"],
    })['Content-Security-Policy']).toEqual(["frame-ancestors 'none'", "script-src 'nonce-example'", MAIN_WINDOW_PRODUCTION_CSP]);
  });
  it.each(['file:///app/index.html', 'https://example.com', 'https://wmux-plugin.example.com'])('keeps the main policy for %s', (url) => {
    expect(productionResponseHeaders(url)['Content-Security-Policy']).toEqual([MAIN_WINDOW_PRODUCTION_CSP]);
  });
});
