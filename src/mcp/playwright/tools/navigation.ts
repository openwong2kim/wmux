import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { validateNavigationUrl } from '../../../shared/types';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

/**
 * Register navigation-related MCP tools on the given server.
 *
 * Tools:
 *  - browser_navigate      — navigate to a URL
 *  - browser_navigate_back — go back in history
 *  - browser_tabs          — list / new / select / close tabs
 */
export function registerNavigationTools(server: McpServer): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_navigate
  // -----------------------------------------------------------------------
  server.tool(
    'browser_navigate',
    'Navigate the browser page to a URL. Returns the final URL after navigation.',
    {
      url: z.string().describe('The URL to navigate to'),
      surfaceId: optionalSurfaceId,
    },
    async ({ url, surfaceId }) => {
      try {
        const urlCheck = validateNavigationUrl(url);
        if (!urlCheck.valid) {
          return {
            content: [{ type: 'text' as const, text: `URL blocked: ${urlCheck.reason}` }],
            isError: true,
          };
        }

        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const finalUrl = page.url();

        return {
          content: [{ type: 'text' as const, text: `Navigated to ${finalUrl}` }],
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
  // browser_navigate_back
  // -----------------------------------------------------------------------
  server.tool(
    'browser_navigate_back',
    'Go back in browser history. Returns the current URL after going back.',
    {
      surfaceId: optionalSurfaceId,
    },
    async ({ surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        await page.goBack();
        const currentUrl = page.url();

        return {
          content: [{ type: 'text' as const, text: `Navigated back to ${currentUrl}` }],
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
  // browser_tabs
  // -----------------------------------------------------------------------
  server.tool(
    'browser_tabs',
    'Manage browser tabs: list all tabs, open a new tab, select a tab, or close a tab.',
    {
      action: z
        .enum(['list', 'new', 'select', 'close'])
        .optional()
        .describe('Action to perform. Defaults to "list".'),
      tabId: z
        .number()
        .optional()
        .describe('Tab index (0-based) for "select" or "close" actions.'),
      url: z
        .string()
        .optional()
        .describe('URL to open when action is "new".'),
    },
    async ({ action, tabId, url }) => {
      try {
        const browser = await engine.getBrowser();
        if (!browser) {
          throw new Error('No browser connected. Call browser_open with a URL first to establish a CDP connection.');
        }

        const resolvedAction = action ?? 'list';

        // Collect all pages across all contexts
        const contexts = browser.contexts();
        const allPages = contexts.flatMap((ctx) => ctx.pages());

        switch (resolvedAction) {
          case 'list': {
            const tabList = allPages.map((p, i) => ({
              tabId: i,
              url: p.url(),
              title: '', // title requires async; filled below
            }));

            // Populate titles
            for (let i = 0; i < allPages.length; i++) {
              try {
                tabList[i].title = await allPages[i].title();
              } catch {
                tabList[i].title = '(unknown)';
              }
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(tabList, null, 2),
                },
              ],
            };
          }

          case 'new': {
            // Use the first context, or fail
            const context = contexts[0];
            if (!context) {
              throw new Error('No browser context available.');
            }

            const newPage = await context.newPage();
            if (url) {
              const urlCheck = validateNavigationUrl(url);
              if (!urlCheck.valid) {
                return {
                  content: [{ type: 'text' as const, text: `URL blocked: ${urlCheck.reason}` }],
                  isError: true,
                };
              }
              await newPage.goto(url, { waitUntil: 'domcontentloaded' });
            }

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Opened new tab (index ${allPages.length}) at ${newPage.url()}`,
                },
              ],
            };
          }

          case 'select': {
            if (tabId === undefined || tabId < 0 || tabId >= allPages.length) {
              throw new Error(
                `Invalid tabId=${tabId}. Available tabs: 0-${allPages.length - 1}`,
              );
            }

            await allPages[tabId].bringToFront();
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Selected tab ${tabId}: ${allPages[tabId].url()}`,
                },
              ],
            };
          }

          case 'close': {
            if (tabId === undefined || tabId < 0 || tabId >= allPages.length) {
              throw new Error(
                `Invalid tabId=${tabId}. Available tabs: 0-${allPages.length - 1}`,
              );
            }

            const closedUrl = allPages[tabId].url();
            await allPages[tabId].close();
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Closed tab ${tabId}: ${closedUrl}`,
                },
              ],
            };
          }

          default:
            throw new Error(`Unknown action: ${resolvedAction}`);
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
}
