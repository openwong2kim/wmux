// fmux-plugin:// protocol — serves UI plugin bundle files to sandboxed
// iframes. Read-only, GET-only, loaded-plugins-only.
//
// URL shape: fmux-plugin://<plugin-name>/<bundle-relative-path>
//
// Security properties (the iframe sandbox depends on these):
//   - only plugins the PluginHostLoader actually loaded resolve — an
//     arbitrary directory name in the URL is a 404, not a probe primitive
//   - the loader's resolveBundlePath enforces realpath containment, so
//     `..`, encoded traversal, and symlinked bundles can't escape the dir
//   - responses carry a restrictive CSP: plugin pages may run their own
//     bundled scripts and styles but cannot fetch the network or frame
//     other origins. Bridge communication is postMessage-only.
//
// Scheme privileges (standard/secure/supportFetchAPI) must be registered
// before app ready — see registerPluginSchemePrivileges, called at module
// scope in main/index.ts.

import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';
import { PLUGIN_PROTOCOL_SCHEME, PLUGIN_NAME_REGEX } from '../../shared/pluginHost';
import type { PluginHostLoader } from './PluginHostLoader';

/**
 * Must run before `app.whenReady()`. Without `standard`, relative asset
 * URLs inside plugin HTML don't resolve; without `secure`, Chromium
 * treats the page as an insecure context and degrades web APIs.
 */
export function registerPluginSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

const PLUGIN_PAGE_CSP = [
  "default-src 'none'",
  // Bundled assets + inline. 'unsafe-inline' is deliberate for BOTH scripts
  // and styles: the page runs in an opaque-origin sandbox with no
  // connect-src, so an inline script has exactly the same reach as a
  // bundled one (the postMessage bridge) — banning it would only force
  // single-file plugins to split out a .js with zero security gain.
  // The CSP's real job here is blocking network exfil and foreign frames.
  `script-src ${PLUGIN_PROTOCOL_SCHEME}: 'unsafe-inline'`,
  `style-src ${PLUGIN_PROTOCOL_SCHEME}: 'unsafe-inline'`,
  `img-src ${PLUGIN_PROTOCOL_SCHEME}: data:`,
  `font-src ${PLUGIN_PROTOCOL_SCHEME}:`,
  // No connect-src: plugins reach the world through the bridge, not fetch.
  "frame-src 'none'",
  "object-src 'none'",
].join('; ');

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * Register the request handler. Must run after `app.whenReady()`.
 * The loader reference is read per-request so a future plugin reload
 * doesn't need re-registration.
 */
export function registerPluginProtocolHandler(getLoader: () => PluginHostLoader | null): void {
  protocol.handle(PLUGIN_PROTOCOL_SCHEME, async (request) => {
    if (request.method !== 'GET') {
      return new Response('method not allowed', { status: 405 });
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    // With `standard` privileges Chromium lowercases the host for us, but
    // re-validate anyway — the regex is the contract, not Chromium.
    const pluginName = url.hostname;
    if (!PLUGIN_NAME_REGEX.test(pluginName)) {
      return new Response('not found', { status: 404 });
    }
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(url.pathname);
    } catch {
      return new Response('bad request', { status: 400 });
    }

    const loader = getLoader();
    const filePath = loader?.resolveBundlePath(pluginName, urlPath) ?? null;
    if (!filePath) {
      return new Response('not found', { status: 404 });
    }

    try {
      const response = await net.fetch(pathToFileURL(filePath).toString());
      if (!response.ok) return new Response('not found', { status: 404 });
      const headers = new Headers();
      headers.set('content-type', contentTypeFor(filePath));
      headers.set('content-security-policy', PLUGIN_PAGE_CSP);
      headers.set('x-content-type-options', 'nosniff');
      return new Response(response.body, { status: 200, headers });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}
