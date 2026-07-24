import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateNavigationUrl } from '../../../shared/types';
import { sendRpc } from '../../wmux-client';
import {
  browserTabsError,
  isBrowserTabsResult,
  type BrowserTabDescriptor,
  type BrowserTabsAction,
  type BrowserTabsErrorResult,
  type BrowserTabsSuccessResult,
} from '../../../shared/browserTabs';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects
// (per-connection memory reduction). Shapes carry no per-call state — only the
// handlers (which stay inside the register* functions) close over runtime deps.
const BROWSER_NAVIGATE_SHAPE = {
  url: z.string().describe('The URL to navigate to'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_NAVIGATE_BACK_SHAPE = {
  surfaceId: optionalSurfaceId,
};

export const BROWSER_TABS_SHAPE = {
  action: z
    .enum(['list', 'new', 'select', 'close'])
    .optional()
    .describe('Action to perform. Defaults to "list".'),
  surfaceId: z
    .string()
    .min(1)
    .optional()
    .describe('Stable browser surface ID returned by "list" or "new". Required for "select" and "close".'),
  url: z
    .string()
    .optional()
    .describe('URL to open when action is "new".'),
  tabId: z
    .never()
    .optional()
    .describe('Removed unsafe numeric index. Use surfaceId returned by "list" or "new".'),
};

export interface NavigationToolDeps {
  /** Strict per-connection resolver. It throws rather than falling back to the UI-active workspace. */
  resolveWorkspaceId: () => Promise<string>;
}

function tabsToolError(result: BrowserTabsErrorResult) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error [${result.error.code}]: ${result.error.message}`,
      },
    ],
    isError: true,
  };
}

function publicTab(tab: BrowserTabDescriptor): BrowserTabDescriptor {
  return {
    surfaceId: tab.surfaceId,
    paneId: tab.paneId,
    url: tab.url,
    title: tab.title,
    selected: tab.selected,
  };
}

function tabsToolSuccess(result: BrowserTabsSuccessResult) {
  let payload: Record<string, unknown>;
  switch (result.action) {
    case 'list':
      payload = { action: result.action, tabs: result.tabs.map(publicTab) };
      break;
    case 'new':
    case 'select':
      payload = { action: result.action, tab: publicTab(result.tab) };
      break;
    case 'close':
      payload = { action: result.action, closed: publicTab(result.closed) };
      break;
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Register navigation-related MCP tools on the given server.
 *
 * Tools:
 *  - browser_navigate      — navigate to a URL
 *  - browser_navigate_back — go back in history
 *  - browser_tabs          — list / new / select / close tabs
 */
export function registerNavigationTools(server: McpServer, deps: NavigationToolDeps): void {
  // -----------------------------------------------------------------------
  // browser_navigate
  // -----------------------------------------------------------------------
  server.tool(
    'browser_navigate',
    'Navigate the browser page to a URL. Returns the final URL after navigation.',
    BROWSER_NAVIGATE_SHAPE,
    async ({ url, surfaceId }) => {
      try {
        const urlCheck = validateNavigationUrl(url);
        if (!urlCheck.valid) {
          return {
            content: [{ type: 'text' as const, text: `URL blocked: ${urlCheck.reason}` }],
            isError: true,
          };
        }

        // Use RPC for fast, reliable navigation (bypasses Playwright CDP discovery)
        await sendRpc('browser.navigate', { url, ...(surfaceId && { surfaceId }) });
        return {
          content: [{ type: 'text' as const, text: `Navigated to ${url}` }],
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
    BROWSER_NAVIGATE_BACK_SHAPE,
    async ({ surfaceId }) => {
      try {
        await sendRpc('browser.goBack', {
          ...(surfaceId && { surfaceId }),
        });

        await new Promise((resolve) => setTimeout(resolve, 300));

        // Get current URL
        const urlResult = await sendRpc('browser.evaluate', {
          expression: 'location.href',
          ...(surfaceId && { surfaceId }),
        }) as { value: string };

        return {
          content: [{ type: 'text' as const, text: `Navigated back to ${urlResult.value}` }],
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
    'Manage browser surfaces in the calling workspace. Address a surface only by the opaque surfaceId returned by list or new — a list position is never an address. select moves this workspace\'s UI focus only: it does NOT change which surface the other browser tools act on when they omit surfaceId, so pass surfaceId explicitly on every follow-up browser call.',
    BROWSER_TABS_SHAPE,
    async ({ action, surfaceId, url }) => {
      const resolvedAction: BrowserTabsAction = action ?? 'list';
      try {
        if ((resolvedAction === 'select' || resolvedAction === 'close') && !surfaceId) {
          return tabsToolError(
            browserTabsError(
              'BROWSER_TABS_INVALID_ARGUMENT',
              `browser_tabs ${resolvedAction} requires a surfaceId returned by browser_tabs list.`,
            ),
          );
        }
        if ((resolvedAction === 'list' || resolvedAction === 'new') && surfaceId) {
          return tabsToolError(
            browserTabsError(
              'BROWSER_TABS_INVALID_ARGUMENT',
              `browser_tabs ${resolvedAction} does not accept surfaceId.`,
            ),
          );
        }
        if (resolvedAction !== 'new' && url !== undefined) {
          return tabsToolError(
            browserTabsError(
              'BROWSER_TABS_INVALID_ARGUMENT',
              `browser_tabs ${resolvedAction} does not accept url.`,
            ),
          );
        }
        if (resolvedAction === 'new' && url !== undefined) {
          const urlCheck = validateNavigationUrl(url);
          if (!urlCheck.valid) {
            return tabsToolError(
              browserTabsError(
                'BROWSER_TAB_URL_BLOCKED',
                urlCheck.reason ?? 'Browser tab URL is not allowed.',
              ),
            );
          }
        }

        let workspaceId: string;
        try {
          workspaceId = await deps.resolveWorkspaceId();
        } catch {
          return tabsToolError(
            browserTabsError(
              'BROWSER_TABS_WORKSPACE_UNRESOLVED',
              'The calling workspace is unavailable.',
            ),
          );
        }
        if (!workspaceId) {
          return tabsToolError(
            browserTabsError(
              'BROWSER_TABS_WORKSPACE_UNRESOLVED',
              'The calling workspace is unavailable.',
            ),
          );
        }

        const result = await sendRpc('browser.tabs', {
          action: resolvedAction,
          workspaceId,
          ...(surfaceId && { surfaceId }),
          ...(url !== undefined && { url }),
        });
        if (!isBrowserTabsResult(result)) {
          throw new Error('Invalid browser.tabs response from wmux main.');
        }
        return result.ok ? tabsToolSuccess(result) : tabsToolError(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Unknown method:\s*browser\.tabs/i.test(message)) {
          return tabsToolError(
            browserTabsError(
              'BROWSER_TABS_UNSUPPORTED',
              'The connected wmux main process does not support workspace-scoped browser tabs.',
            ),
          );
        }
        return tabsToolError(
          browserTabsError(
            'BROWSER_TABS_UNAVAILABLE',
            'Workspace-scoped browser tabs are temporarily unavailable.',
          ),
        );
      }
    },
  );
}
