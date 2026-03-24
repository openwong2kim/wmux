import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { devices } from 'playwright-core';
import { PlaywrightEngine } from '../PlaywrightEngine';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

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
    'Manage browser cookies: get, set, or clear cookies for the current browser context.',
    {
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
      surfaceId: optionalSurfaceId,
    },
    async ({ action, url, cookies, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const context = page.context();

        switch (action) {
          case 'get': {
            const allCookies = await context.cookies(url ? [url] : []);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(allCookies, null, 2),
                },
              ],
            };
          }

          case 'set': {
            if (!cookies || cookies.length === 0) {
              throw new Error('No cookies provided for "set" action.');
            }

            // Playwright requires url or domain+path for each cookie
            const cookiesToAdd = cookies.map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path ?? '/',
              url: !c.domain ? (url ?? page.url()) : undefined,
            }));

            await context.addCookies(cookiesToAdd);

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
            await context.clearCookies();
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
    },
  );

  // -----------------------------------------------------------------------
  // browser_storage
  // -----------------------------------------------------------------------
  server.tool(
    'browser_storage',
    'Manage localStorage or sessionStorage: get, set, or clear values.',
    {
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
      surfaceId: optionalSurfaceId,
    },
    async ({ type, action, key, value, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const storageName = type === 'local' ? 'localStorage' : 'sessionStorage';

        switch (action) {
          case 'get': {
            const result = await page.evaluate(
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

            await page.evaluate(
              ([sName, sKey, sValue]: [string, string, string]) => {
                const storage = (window as any)[sName] as Storage;
                storage.setItem(sKey, sValue);
              },
              [storageName, key, value ?? ''] as [string, string, string],
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
            await page.evaluate(
              (sName: string) => {
                const storage = (window as any)[sName] as Storage;
                storage.clear();
              },
              storageName,
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
    },
  );

  // -----------------------------------------------------------------------
  // browser_emulate
  // -----------------------------------------------------------------------
  server.tool(
    'browser_emulate',
    'Apply emulation settings to the browser page: offline mode, custom headers, HTTP credentials, geolocation, color scheme, timezone, locale, or device preset.',
    {
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
    },
    async ({ offline, headers, credentials, geo, media, timezone, locale, device, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const context = page.context();
        const applied: string[] = [];

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
            if (timezone) {
              await client.send('Emulation.setTimezoneOverride', {
                timezoneId: timezone,
              });
              applied.push(`timezone=${timezone}`);
            } else {
              await client.send('Emulation.setTimezoneOverride', {
                timezoneId: '',
              });
              applied.push('timezone=reset');
            }
          } finally {
            await client.detach().catch(() => {});
          }
        }

        // locale via CDP
        if (locale !== undefined) {
          const client = await context.newCDPSession(page);
          try {
            if (locale) {
              await client.send('Emulation.setLocaleOverride', {
                locale,
              });
              applied.push(`locale=${locale}`);
            } else {
              await client.send('Emulation.setLocaleOverride', {
                locale: '',
              });
              applied.push('locale=reset');
            }
          } finally {
            await client.detach().catch(() => {});
          }
        }

        // device preset
        if (device !== undefined) {
          if (device) {
            const deviceDescriptor = devices[device];
            if (!deviceDescriptor) {
              throw new Error(
                `Unknown device "${device}". Use a name from Playwright's device list (e.g. "iPhone 13", "Pixel 5").`,
              );
            }
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
    },
  );

  // -----------------------------------------------------------------------
  // browser_resize
  // -----------------------------------------------------------------------
  server.tool(
    'browser_resize',
    'Resize the browser viewport to the specified dimensions.',
    {
      width: z.number().describe('Viewport width in pixels.'),
      height: z.number().describe('Viewport height in pixels.'),
      surfaceId: optionalSurfaceId,
    },
    async ({ width, height, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        await page.setViewportSize({ width, height });

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
    },
  );
}
