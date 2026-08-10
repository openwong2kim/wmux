import { describe, it, expect } from 'vitest';
import { buildProductionCsp, ownsResponseCsp } from '../csp';
import { PLUGIN_PROTOCOL_SCHEME } from '../../../shared/pluginHost';

/**
 * #848 — enabling a UI plugin put its panel into an endless restore loop in
 * production builds only, because the renderer's `frame-src` did not name the
 * `wmux-plugin:` scheme that PluginFrame.tsx points its iframe at. Dev builds
 * skip the CSP entirely, so nothing caught it before release.
 */

function directive(csp: string, name: string): string {
  const found = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  if (!found) throw new Error(`no ${name} directive in: ${csp}`);
  return found;
}

describe('buildProductionCsp', () => {
  it('lets the renderer frame a plugin page', () => {
    expect(directive(buildProductionCsp(), 'frame-src')).toContain(`${PLUGIN_PROTOCOL_SCHEME}:`);
  });

  it('does not let the renderer document itself load plugin code', () => {
    // The plugin scheme belongs in frame-src and nowhere else: a plugin
    // bundle is a framed document, never a source for the host document.
    const csp = buildProductionCsp();
    for (const name of ['script-src', 'style-src', 'connect-src', 'img-src', 'font-src']) {
      expect(directive(csp, name)).not.toContain(PLUGIN_PROTOCOL_SCHEME);
    }
  });

  it('keeps the directives the renderer needs to render at all', () => {
    const csp = buildProductionCsp();
    // Tailwind and xterm.js inject inline styles at runtime.
    expect(directive(csp, 'style-src')).toContain("'unsafe-inline'");
    // Strict where it counts: no eval, and no inline script.
    expect(csp).not.toContain('unsafe-eval');
    expect(directive(csp, 'script-src')).toBe("script-src 'self'");
    // The browser surface frames real sites.
    expect(directive(csp, 'frame-src')).toContain('https:');
  });
});

describe('ownsResponseCsp', () => {
  it('leaves a plugin response its own, stricter policy', () => {
    expect(ownsResponseCsp(`${PLUGIN_PROTOCOL_SCHEME}://hello-panel/index.html`)).toBe(false);
  });

  it('stamps the renderer policy on everything else', () => {
    expect(ownsResponseCsp('file:///C:/app/index.html')).toBe(true);
    expect(ownsResponseCsp('https://example.com/')).toBe(true);
  });
});
