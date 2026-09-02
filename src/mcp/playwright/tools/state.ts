import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { loadPlaywright } from '../lazyPlaywright';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import { matchSensitiveDomain } from '../security';
import { evalFunctionOrRpc } from '../page-eval';
import { isChromiumUserAgent } from '../../../shared/uaMetadata';
import { describeToolError } from '../toolError';
import {
  applyUserAgentEmulation,
  clearUserAgentEmulation,
  hasUserAgentEmulation,
} from '../ua-emulation';
import {
  allowScopedRpcFallback,
  sendScopedBrowserRpc,
  type BrowserTargetScope,
  type BrowserToolDeps,
} from '../browserScope';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Omit for the active surface.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.
const BROWSER_COOKIES_SHAPE = {
  action: z.enum(['get', 'set', 'clear']),
  url: z
    .string()
    .optional()
    .describe('Filter by URL, for "get".'),
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string().optional(),
        path: z.string().optional(),
      }),
    )
    .optional()
    .describe('For "set".'),
  allowSensitiveDomains: z
    .boolean()
    .optional()
    .describe('Allow sensitive-domain reads. Default false.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_STORAGE_SHAPE = {
  type: z.enum(['local', 'session']),
  action: z.enum(['get', 'set', 'clear']),
  key: z
    .string()
    .optional()
    .describe('Omit on "get" to return every entry.'),
  value: z
    .string()
    .optional()
    .describe('For "set".'),
  allowSensitiveDomains: z
    .boolean()
    .optional()
    .describe('Allow sensitive-domain reads. Default false.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_EMULATE_SHAPE = {
  offline: z.boolean().optional(),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe('Extra headers on every request.'),
  credentials: z
    .object({
      username: z.string(),
      password: z.string(),
    })
    .nullable()
    .optional()
    .describe('Basic/Digest auth; null clears.'),
  geo: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      accuracy: z.number().optional(),
    })
    .nullable()
    .optional()
    .describe('Geolocation; null clears.'),
  media: z
    .enum(['dark', 'light', 'no-preference'])
    .nullable()
    .optional()
    .describe('Color-scheme emulation; null resets.'),
  timezone: z
    .string()
    .nullable()
    .optional()
    .describe('e.g. "America/New_York"; null resets.'),
  locale: z
    .string()
    .nullable()
    .optional()
    .describe('e.g. "en-US"; null resets.'),
  device: z
    .string()
    .nullable()
    .optional()
    .describe('Playwright device preset, e.g. "iPhone 13"; null resets.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_RESIZE_SHAPE = {
  width: z.number().describe('Pixels.'),
  height: z.number().describe('Pixels.'),
  surfaceId: optionalSurfaceId,
};

// ---------------------------------------------------------------------------
// Packaged RPC fallback (#111)
// ---------------------------------------------------------------------------
//
// On packaged builds playwright-core cannot surface the guest <webview> as a
// Playwright Page, so engine.getPage() returns null. These state tools then
// route the same operation through the main-process CDP channel (browser.* RPC),
// exactly as the extraction/capture tools already do (#105/#106). Each tool tries
// the Playwright Page first and falls back to RPC only when no Page is available.

/** Current page URL, transport-agnostic. Used for sensitive-domain checks. */
async function currentUrl(page: Page | null, scope: BrowserTargetScope): Promise<string> {
  if (page) return page.url();
  try {
    const r = await sendScopedBrowserRpc<{ value: unknown }>('browser.evaluate', scope, {
      expression: 'location.href',
    });
    return typeof r.value === 'string' ? r.value : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * A device preset's screen size, which differs from its viewport (an iPhone 13
 * is 390x664 of viewport inside a 390x844 screen). Playwright's device table
 * ships it, but its public `DeviceDescriptor` type does not list the field, so
 * it is read through a narrowing rather than assumed present.
 */
function screenOf(
  descriptor: { viewport: { width: number; height: number } },
): { width: number; height: number } | undefined {
  const screen = (descriptor as { screen?: { width?: number; height?: number } }).screen;
  return typeof screen?.width === 'number' && typeof screen?.height === 'number'
    ? { width: screen.width, height: screen.height }
    : undefined;
}

/**
 * Register state-management MCP tools on the given server.
 *
 * Tools:
 *  - browser_cookies  -- get, set, or clear cookies
 *  - browser_storage  -- get, set, or clear localStorage / sessionStorage
 *  - browser_emulate  -- apply various emulation settings
 *  - browser_resize   -- change the viewport size
 */
export function registerStateTools(server: McpServer, deps: BrowserToolDeps): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_cookies
  // -----------------------------------------------------------------------
  server.tool(
    'browser_cookies',
    'Get, set, or clear cookies. Sensitive domains (email, banking, auth) are blocked on read and redacted unless allowSensitiveDomains:true.',
    BROWSER_COOKIES_SHAPE,
    async ({ action, url, cookies, allowSensitiveDomains, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        // Playwright Page when available (dev), else CDP over RPC (packaged, #111).
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        switch (action) {
          case 'get': {
            if (url) {
              const sensitive = matchSensitiveDomain(url);
              if (sensitive && !allowSensitiveDomains) {
                throw new Error(
                  `browser_cookies get blocked: "${sensitive}" is on the sensitive-domain blocklist (email / banking / auth). ` +
                  `Pass allowSensitiveDomains:true if the caller has user consent.`,
                );
              }
            }
            const allCookies: Array<{ domain?: string; value: string; [k: string]: unknown }> = page
              ? await page.context().cookies(url ? [url] : [])
              : (await sendScopedBrowserRpc<{
                  cookies: Array<{ domain?: string; value: string }>;
                }>('browser.cookies', scope, {
                  action: 'get',
                  urls: url ? [url] : [],
                })).cookies;
            const safe = allCookies.map((c) => {
              const hit = matchSensitiveDomain(c.domain ?? '');
              if (hit && !allowSensitiveDomains) {
                return { ...c, value: '<REDACTED sensitive-domain>' };
              }
              return c;
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(safe, null, 2),
                },
              ],
            };
          }

          case 'set': {
            if (!cookies || cookies.length === 0) {
              throw new Error('No cookies provided for "set" action.');
            }

            // Playwright (and CDP Network.setCookies) require url or domain+path
            // per cookie. In RPC mode page is null, so we leave url undefined for
            // bare cookies and the handler defaults it to the live page URL.
            const cookiesToAdd = cookies.map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path ?? '/',
              url: !c.domain ? (url ?? (page ? page.url() : undefined)) : undefined,
            }));

            if (page) {
              await page.context().addCookies(cookiesToAdd);
            } else {
              await sendScopedBrowserRpc('browser.cookies', scope, {
                action: 'set',
                cookies: cookiesToAdd,
              });
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Set ${cookies.length} cookie(s).`,
                },
              ],
            };
          }

          case 'clear': {
            if (page) {
              await page.context().clearCookies();
            } else {
              await sendScopedBrowserRpc('browser.cookies', scope, {
                action: 'clear',
              });
            }
            return {
              content: [{ type: 'text' as const, text: 'Cookies cleared.' }],
            };
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        const message = describeToolError(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    }),
  );

  // -----------------------------------------------------------------------
  // browser_storage
  // -----------------------------------------------------------------------
  server.tool(
    'browser_storage',
    'Get, set, or clear local or session storage. Reads on sensitive pages (email, banking, auth) are blocked unless allowSensitiveDomains:true.',
    BROWSER_STORAGE_SHAPE,
    async ({ type, action, key, value, allowSensitiveDomains, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        // browser_storage is pure page.evaluate, so it unifies over the same
        // evaluate transport the extraction tools use: a Playwright Page when
        // available, else browser.evaluate over RPC (packaged builds, #111).
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        const storageName = type === 'local' ? 'localStorage' : 'sessionStorage';

        switch (action) {
          case 'get': {
            if (!allowSensitiveDomains) {
              const sensitive = matchSensitiveDomain(await currentUrl(page, scope));
              if (sensitive) {
                throw new Error(
                  `browser_storage get blocked: current page "${sensitive}" is on the sensitive-domain blocklist (email / banking / auth). ` +
                  `Pass allowSensitiveDomains:true if the caller has user consent.`,
                );
              }
            }
            const result = await evalFunctionOrRpc(
              page,
              ([sName, sKey]: [string, string | undefined]) => {
                const storage = (window as any)[sName] as Storage;
                if (sKey) {
                  return storage.getItem(sKey);
                }
                // Return all entries
                const entries: Record<string, string> = {};
                for (let i = 0; i < storage.length; i++) {
                  const k = storage.key(i);
                  if (k !== null) {
                    entries[k] = storage.getItem(k) ?? '';
                  }
                }
                return entries;
              },
              [storageName, key] as [string, string | undefined],
              scope,
            );

            const text =
              typeof result === 'string' ? result : JSON.stringify(result, null, 2);

            return {
              content: [{ type: 'text' as const, text: text ?? 'null' }],
            };
          }

          case 'set': {
            if (!key) {
              throw new Error('Key is required for "set" action.');
            }

            await evalFunctionOrRpc(
              page,
              ([sName, sKey, sValue]: [string, string, string]) => {
                const storage = (window as any)[sName] as Storage;
                storage.setItem(sKey, sValue);
              },
              [storageName, key, value ?? ''] as [string, string, string],
              scope,
            );

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `${storageName}.${key} = "${value ?? ''}"`,
                },
              ],
            };
          }

          case 'clear': {
            await evalFunctionOrRpc(
              page,
              (sName: string) => {
                const storage = (window as any)[sName] as Storage;
                storage.clear();
              },
              storageName,
              scope,
            );

            return {
              content: [
                { type: 'text' as const, text: `${storageName} cleared.` },
              ],
            };
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        const message = describeToolError(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    }),
  );

  // -----------------------------------------------------------------------
  // browser_emulate
  // -----------------------------------------------------------------------
  server.tool(
    'browser_emulate',
    'Apply page emulation settings. Pass only the fields to change.',
    BROWSER_EMULATE_SHAPE,
    async ({ offline, headers, credentials, geo, media, timezone, locale, device, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);
        const applied: string[] = [];

        // Resolve a device preset (if any) up front: both transports need its
        // viewport + user agent, and the lookup throws on an unknown name before
        // any partial emulation is applied.
        // B0: devices lives in the lazy playwright chunk (first use loads it).
        const deviceDescriptor = device ? loadPlaywright().devices[device] : undefined;
        const deviceScreen = deviceDescriptor ? screenOf(deviceDescriptor) : undefined;
        if (device && !deviceDescriptor) {
          throw new Error(
            `Unknown device "${device}". Use a name from Playwright's device list (e.g. "iPhone 13", "Pixel 5").`,
          );
        }

        if (page) {
          const context = page.context();

          // offline
          if (offline !== undefined) {
            await context.setOffline(offline);
            applied.push(`offline=${offline}`);
          }

          // headers
          if (headers !== undefined) {
            await context.setExtraHTTPHeaders(headers);
            applied.push(`headers=${Object.keys(headers).length} header(s)`);
          }

          // credentials
          if (credentials !== undefined) {
            try {
              await context.setHTTPCredentials(credentials as { username: string; password: string } | null);
              applied.push(credentials ? 'credentials=set' : 'credentials=cleared');
            } catch {
              applied.push(
                'credentials=failed (HTTP credentials via context is not supported in CDP mode. Use browser_emulate headers with a Base64-encoded Authorization header instead.)',
              );
            }
          }

          // geo
          if (geo !== undefined) {
            if (geo) {
              await context.setGeolocation(geo);
              await context.grantPermissions(['geolocation']);
              applied.push(`geo=${geo.latitude},${geo.longitude}`);
            } else {
              await context.setGeolocation(null as any);
              applied.push('geo=cleared');
            }
          }

          // media / color scheme
          if (media !== undefined) {
            await page.emulateMedia({
              colorScheme: media as 'dark' | 'light' | 'no-preference' | null,
            });
            applied.push(media ? `colorScheme=${media}` : 'colorScheme=reset');
          }

          // timezone via CDP
          if (timezone !== undefined) {
            const client = await context.newCDPSession(page);
            try {
              await client.send('Emulation.setTimezoneOverride', {
                timezoneId: timezone || '',
              });
              applied.push(timezone ? `timezone=${timezone}` : 'timezone=reset');
            } finally {
              await client.detach().catch(() => {});
            }
          }

          // locale via CDP
          if (locale !== undefined) {
            const client = await context.newCDPSession(page);
            try {
              await client.send('Emulation.setLocaleOverride', {
                locale: locale || '',
              });
              applied.push(locale ? `locale=${locale}` : 'locale=reset');
            } finally {
              await client.detach().catch(() => {});
            }
          }

          // device preset
          if (device !== undefined) {
            if (deviceDescriptor) {
              await page.setViewportSize(deviceDescriptor.viewport);
              // Apply user agent via extra headers
              await context.setExtraHTTPHeaders({
                ...(headers ?? {}),
                'User-Agent': deviceDescriptor.userAgent,
              });
              // The header alone leaves navigator.userAgentData — and the
              // Sec-CH-UA* headers built from it — answering out of the REAL
              // browser, so an emulated phone announced itself as a phone in
              // one place and as this desktop in the other. ua-emulation holds
              // the CDP session open (the override dies with its session) and
              // re-applies to tabs opened later, matching the context-wide
              // reach of the header above.
              // The UA string and the viewport were the whole of the preset;
              // navigator.platform, devicePixelRatio, maxTouchPoints and the
              // mobile flag stayed on the real machine and contradicted it.
              // The descriptor already carries all four, so hand them over
              // with the UA rather than applying half a device.
              const ok = await applyUserAgentEmulation(
                context,
                page,
                deviceDescriptor.userAgent,
                locale ?? undefined,
                {
                  width: deviceDescriptor.viewport.width,
                  height: deviceDescriptor.viewport.height,
                  deviceScaleFactor: deviceDescriptor.deviceScaleFactor,
                  mobile: deviceDescriptor.isMobile,
                  hasTouch: deviceDescriptor.hasTouch,
                  ...(deviceScreen && {
                    screenWidth: deviceScreen.width,
                    screenHeight: deviceScreen.height,
                  }),
                },
              );
              if (!ok) {
                // Client Hints stay on the real browser's values; the UA header
                // is still applied. Worth reporting, not worth failing on.
                applied.push('clientHints=unavailable (UA header applied without matching hints or device metrics)');
              }
              applied.push(`device=${device} (${deviceDescriptor.viewport.width}x${deviceDescriptor.viewport.height})`);
              // A Safari/iOS preset on a Chromium browser cannot be made whole:
              // navigator.userAgentData and the Sec-CH-UA* headers are
              // Chromium's own and there is no Safari value to give them. Say
              // so where the caller reads the result, rather than let them
              // assume the identity is seamless.
              // Two things a preset does not reach, said here rather than left
              // for the caller to discover: navigator.platform keeps this
              // machine's value on a page under automation, and a
              // non-Chromium preset cannot fill the Client Hints surface at
              // all.
              applied.push('note=navigator.platform still reports the host platform');
              if (!isChromiumUserAgent(deviceDescriptor.userAgent)) {
                applied.push(
                  'note=this preset emulates a non-Chromium browser; navigator.userAgentData and Sec-CH-UA* still report Chromium. A Chrome-based preset (e.g. "Pixel 7") gives a consistent mobile identity.',
                );
              }
            } else {
              // A reset has to undo the UA too. Leaving the override and the
              // User-Agent header in place meant a caller who switched to a
              // phone preset and then reset stayed on the mobile identity for
              // every subsequent page.
              if (hasUserAgentEmulation(context)) {
                await clearUserAgentEmulation(context);
                // Re-send the caller's headers without the preset's User-Agent.
                // setExtraHTTPHeaders replaces the whole set, so passing the
                // rest back is what removes just that one.
                await context.setExtraHTTPHeaders({ ...(headers ?? {}) });
                applied.push('userAgent=reset');
              }
              applied.push('device=reset (use browser_resize to set viewport)');
            }
          }
        } else {
          // Packaged RPC fallback (#111). The main-process handler applies each
          // setting over CDP and returns the same `applied` summary. Device
          // presets are resolved here so playwright-core's device table stays out
          // of the main process — only the viewport + UA cross the wire.
          const emulateParams: Record<string, unknown> = {};
          if (offline !== undefined) emulateParams.offline = offline;
          if (headers !== undefined) emulateParams.headers = headers;
          if (credentials !== undefined) emulateParams.credentialsRequested = true;
          if (geo !== undefined) emulateParams.geo = geo;
          if (media !== undefined) emulateParams.media = media;
          if (timezone !== undefined) emulateParams.timezone = timezone;
          if (locale !== undefined) emulateParams.locale = locale;
          if (device !== undefined) {
            if (deviceDescriptor) {
              emulateParams.deviceMetrics = {
                width: deviceDescriptor.viewport.width,
                height: deviceDescriptor.viewport.height,
                // Same reason as the Playwright branch above: without these the
                // packaged lane emulates a phone's UA on a desktop's pixel
                // ratio, touch points and viewport semantics.
                deviceScaleFactor: deviceDescriptor.deviceScaleFactor,
                mobile: deviceDescriptor.isMobile,
                hasTouch: deviceDescriptor.hasTouch,
                ...(deviceScreen && {
                  screenWidth: deviceScreen.width,
                  screenHeight: deviceScreen.height,
                }),
              };
              emulateParams.deviceLabel = `${device} (${deviceDescriptor.viewport.width}x${deviceDescriptor.viewport.height})`;
              emulateParams.userAgent = deviceDescriptor.userAgent;
            } else {
              emulateParams.deviceReset = true;
            }
          }
          const res = await sendScopedBrowserRpc<{ applied: string[] }>(
            'browser.emulate',
            scope,
            emulateParams,
          );
          applied.push(...res.applied);
        }

        if (applied.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No emulation settings provided. Pass at least one option.',
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Emulation applied:\n${applied.map((a) => `  - ${a}`).join('\n')}`,
            },
          ],
        };
      } catch (error) {
        const message = describeToolError(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    }),
  );

  // -----------------------------------------------------------------------
  // browser_resize
  // -----------------------------------------------------------------------
  server.tool(
    'browser_resize',
    'Resize the viewport.',
    BROWSER_RESIZE_SHAPE,
    async ({ width, height, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        if (page) {
          await page.setViewportSize({ width, height });
        } else {
          // Packaged RPC fallback (#111): CDP Emulation.setDeviceMetricsOverride.
          await sendScopedBrowserRpc('browser.resize', scope, {
            width,
            height,
          });
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Viewport resized to ${width}x${height}`,
            },
          ],
        };
      } catch (error) {
        const message = describeToolError(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    }),
  );
}
