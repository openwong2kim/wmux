import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { loadPlaywright } from '../lazyPlaywright';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import { matchSensitiveDomain } from '../security';
import { evalFunctionOrRpc } from '../page-eval';
import { sendRpc } from '../../wmux-client';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.
const BROWSER_COOKIES_SHAPE = {
  action: z
    .enum(['get', 'set', 'clear'])
    .describe('Action to perform on cookies.'),
  url: z
    .string()
    .optional()
    .describe('URL to filter cookies by (for "get" action).'),
  cookies: z
    .array(
      z.object({
        name: z.string().describe('Cookie name'),
        value: z.string().describe('Cookie value'),
        domain: z.string().optional().describe('Cookie domain'),
        path: z.string().optional().describe('Cookie path'),
      }),
    )
    .optional()
    .describe('Cookies to set (for "set" action).'),
  allowSensitiveDomains: z
    .boolean()
    .optional()
    .describe('Allow reading cookies from sensitive domains (email, banking, auth). Default false.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_STORAGE_SHAPE = {
  type: z
    .enum(['local', 'session'])
    .describe('Storage type: "local" for localStorage, "session" for sessionStorage.'),
  action: z
    .enum(['get', 'set', 'clear'])
    .describe('Action to perform.'),
  key: z
    .string()
    .optional()
    .describe('Storage key (for "get" or "set"). Omit for "get" to retrieve all entries.'),
  value: z
    .string()
    .optional()
    .describe('Value to set (for "set" action).'),
  allowSensitiveDomains: z
    .boolean()
    .optional()
    .describe('Allow reading storage on sensitive domains. Default false.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_EMULATE_SHAPE = {
  offline: z
    .boolean()
    .optional()
    .describe('Enable or disable offline mode.'),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe('Extra HTTP headers to send with every request.'),
  credentials: z
    .object({
      username: z.string(),
      password: z.string(),
    })
    .nullable()
    .optional()
    .describe('HTTP credentials for Basic/Digest auth. Pass null to clear.'),
  geo: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      accuracy: z.number().optional(),
    })
    .nullable()
    .optional()
    .describe('Geolocation override. Pass null to clear.'),
  media: z
    .enum(['dark', 'light', 'no-preference'])
    .nullable()
    .optional()
    .describe('Color scheme media emulation. Pass null to reset.'),
  timezone: z
    .string()
    .nullable()
    .optional()
    .describe('Timezone override (e.g. "America/New_York"). Pass null to reset.'),
  locale: z
    .string()
    .nullable()
    .optional()
    .describe('Locale override (e.g. "en-US"). Pass null to reset.'),
  device: z
    .string()
    .nullable()
    .optional()
    .describe('Device preset name from Playwright devices (e.g. "iPhone 13"). Pass null to reset.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_RESIZE_SHAPE = {
  width: z.number().describe('Viewport width in pixels.'),
  height: z.number().describe('Viewport height in pixels.'),
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
async function currentUrl(page: Page | null, surfaceId?: string): Promise<string> {
  if (page) return page.url();
  try {
    const r = (await sendRpc('browser.evaluate', {
      expression: 'location.href',
      ...(surfaceId && { surfaceId }),
    })) as { value: unknown };
    return typeof r.value === 'string' ? r.value : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register state-management MCP tools on the given server.
 *
 * Tools:
 *  - browser_cookies  -- get, set, or clear cookies
 *  - browser_storage  -- get, set, or clear localStorage / sessionStorage
 *  - browser_emulate  -- apply various emulation settings
 *  - browser_resize   -- change the viewport size
 */
export function registerStateTools(server: McpServer): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_cookies
  // -----------------------------------------------------------------------
  server.tool(
    'browser_cookies',
    'Manage browser cookies: get, set, or clear. Reads from sensitive domains (email, banking, auth) are blocked and values from such domains are redacted unless allowSensitiveDomains:true is set.',
    BROWSER_COOKIES_SHAPE,
    async ({ action, url, cookies, allowSensitiveDomains, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        // Playwright Page when available (dev), else CDP over RPC (packaged, #111).
        const page = await engine.getPage(surfaceId).catch(() => null);

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
              : ((await sendRpc('browser.cookies', {
                  action: 'get',
                  urls: url ? [url] : [],
                  ...(surfaceId && { surfaceId }),
                })) as { cookies: Array<{ domain?: string; value: string }> }).cookies;
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
              await sendRpc('browser.cookies', {
                action: 'set',
                cookies: cookiesToAdd,
                ...(surfaceId && { surfaceId }),
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
              await sendRpc('browser.cookies', {
                action: 'clear',
                ...(surfaceId && { surfaceId }),
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
        const message = error instanceof Error ? error.message : String(error);
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
    'Manage localStorage or sessionStorage: get, set, or clear. Reads on sensitive pages (email, banking, auth) are blocked unless allowSensitiveDomains:true is set.',
    BROWSER_STORAGE_SHAPE,
    async ({ type, action, key, value, allowSensitiveDomains, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        // browser_storage is pure page.evaluate, so it unifies over the same
        // evaluate transport the extraction tools use: a Playwright Page when
        // available, else browser.evaluate over RPC (packaged builds, #111).
        const page = await engine.getPage(surfaceId).catch(() => null);

        const storageName = type === 'local' ? 'localStorage' : 'sessionStorage';

        switch (action) {
          case 'get': {
            if (!allowSensitiveDomains) {
              const sensitive = matchSensitiveDomain(await currentUrl(page, surfaceId));
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
              surfaceId,
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
              surfaceId,
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
              surfaceId,
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
        const message = error instanceof Error ? error.message : String(error);
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
    'Apply emulation settings to the browser page: offline mode, custom headers, HTTP credentials, geolocation, color scheme, timezone, locale, or device preset.',
    BROWSER_EMULATE_SHAPE,
    async ({ offline, headers, credentials, geo, media, timezone, locale, device, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);
        const applied: string[] = [];

        // Resolve a device preset (if any) up front: both transports need its
        // viewport + user agent, and the lookup throws on an unknown name before
        // any partial emulation is applied.
        // B0: devices lives in the lazy playwright chunk (first use loads it).
        const deviceDescriptor = device ? loadPlaywright().devices[device] : undefined;
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
              applied.push(`device=${device} (${deviceDescriptor.viewport.width}x${deviceDescriptor.viewport.height})`);
            } else {
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
              };
              emulateParams.deviceLabel = `${device} (${deviceDescriptor.viewport.width}x${deviceDescriptor.viewport.height})`;
              emulateParams.userAgent = deviceDescriptor.userAgent;
            } else {
              emulateParams.deviceReset = true;
            }
          }
          if (surfaceId) emulateParams.surfaceId = surfaceId;

          const res = (await sendRpc('browser.emulate', emulateParams)) as { applied: string[] };
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
        const message = error instanceof Error ? error.message : String(error);
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
    'Resize the browser viewport to the specified dimensions.',
    BROWSER_RESIZE_SHAPE,
    async ({ width, height, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);

        if (page) {
          await page.setViewportSize({ width, height });
        } else {
          // Packaged RPC fallback (#111): CDP Emulation.setDeviceMetricsOverride.
          await sendRpc('browser.resize', {
            width,
            height,
            ...(surfaceId && { surfaceId }),
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
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    }),
  );
}
