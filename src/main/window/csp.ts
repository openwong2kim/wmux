// Production Content-Security-Policy for the main renderer.
//
// Split out of createWindow.ts so the policy is assertable in tests: #848
// shipped a policy whose `frame-src` had no `wmux-plugin:` entry, which
// silently broke every UI plugin (see buildProductionCsp below).

import { PLUGIN_PROTOCOL_SCHEME } from '../../shared/pluginHost';

/**
 * The renderer's own policy. Note what this does NOT cover: a plugin page is
 * served by `protocol.handle` with its own, stricter CSP
 * (`PLUGIN_PAGE_CSP` in main/plugins/pluginProtocol.ts). This policy only has
 * to permit the *framing* of that page — the plugin's scripts and styles are
 * governed by the plugin response's own header, not by this one.
 *
 * `frame-src` therefore names the plugin scheme, and nothing else here does.
 * Adding `wmux-plugin:` to `script-src`/`style-src` would be wrong: it would
 * let the renderer document itself pull code out of a plugin bundle.
 */
export function buildProductionCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // 'unsafe-inline' is required because Tailwind CSS and xterm.js inject
    // inline styles at runtime; removing it breaks UI rendering.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    // 'self' — the app's own frames. https:/http: — the browser surface.
    // wmux-plugin: — sandboxed UI plugin panels/widgets (#848). Without it
    // the iframe in renderer/plugins/PluginFrame.tsx is blocked outright and
    // the panel retries forever.
    `frame-src 'self' https: http: ${PLUGIN_PROTOCOL_SCHEME}:`,
  ].join('; ');
}

/**
 * Responses this policy must not be stamped onto.
 *
 * Plugin bundle responses already carry the tighter `PLUGIN_PAGE_CSP`, which
 * has no `connect-src` at all. Overwriting it with the renderer policy would
 * both break the plugin (its bundled scripts are not `'self'` to an opaque
 * origin) and relax the sandbox. Whether `onHeadersReceived` fires for a
 * `protocol.handle` scheme is a Chromium implementation detail we would
 * rather not depend on either way.
 */
export function ownsResponseCsp(url: string): boolean {
  return !url.startsWith(`${PLUGIN_PROTOCOL_SCHEME}://`);
}
