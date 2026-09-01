import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateNavigationUrl } from '../../../shared/types';
import { sendRpc } from '../../wmux-client';
import { PlaywrightEngine } from '../PlaywrightEngine';
import {
  sendScopedBrowserRpc,
  type BrowserToolDeps,
} from '../browserScope';
import { withAutomationLease } from '../automationLease';
import { describeToolError } from '../toolError';
import { redactPasswordParams } from '../redact';
import { recordAction } from '../../browser-replay/actionRing';
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
  .describe('Omit for the active surface.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects
// (per-connection memory reduction). Shapes carry no per-call state — only the
// handlers (which stay inside the register* functions) close over runtime deps.
const BROWSER_NAVIGATE_SHAPE = {
  url: z.string(),
  surfaceId: optionalSurfaceId,
};

const BROWSER_NAVIGATE_BACK_SHAPE = {
  surfaceId: optionalSurfaceId,
};

export const BROWSER_TABS_SHAPE = {
  action: z
    .enum(['list', 'new', 'select', 'close'])
    .optional()
    .describe('Defaults to "list".'),
  surfaceId: z
    .string()
    .min(1)
    .optional()
    .describe('Opaque ID from "list" or "new". Required for "select" and "close".'),
  url: z
    .string()
    .optional()
    .describe('For "new".'),
  tabId: z
    .never()
    .optional()
    .describe('Removed. Use surfaceId.'),
};

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
    // Every rendered tab URL passes through here (list / new / select / close),
    // so this is the single place a credential in a query string or in
    // `scheme://user:pass@host` gets masked before the agent reads it.
    url: redactPasswordParams(tab.url),
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
      // #517 external backend: the tab opened in the OS default browser and
      // wmux holds no handle on it — report the delegation honestly instead of
      // inventing a descriptor.
      payload = 'backend' in result
        ? { action: result.action, backend: result.backend, opened: result.opened, url: redactPasswordParams(result.url) }
        : { action: result.action, tab: publicTab(result.tab) };
      break;
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
export function registerNavigationTools(server: McpServer, deps: BrowserToolDeps): void {
  // -----------------------------------------------------------------------
  // browser_navigate
  // -----------------------------------------------------------------------
  server.tool(
    'browser_navigate',
    'Navigate to a URL. Returns the final URL after any redirects.',
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

        // Leased like every other browser tool (#1063 follow-up): the lease's
        // post-body drain is what attributes this call's own `navigated`
        // events (redirect chains included) to this result instead of the
        // next tool call. The self-echo — a lone navigated matching the URL
        // this result already reports — is suppressed via opts.
        let finalUrl: string | undefined;
        return await withAutomationLease(
          deps,
          surfaceId,
          async (scope) => {
            // Chrome backend (dogfood P1): the RPC lane cannot target a chrome
            // tab — its fallback would open a NEW tab and report success while
            // the agent keeps reading the old page. Navigate the resolved page
            // over Playwright instead. Builtin keeps the fast RPC lane.
            const engine = PlaywrightEngine.getInstance();
            if ((await engine.resolveWorkspaceBackend(scope.workspaceId)) === 'chrome') {
              const page = await engine.getPageForScope(scope);
              if (!page) throw new Error('browser_navigate: no chrome page resolved for this scope.');
              await page.goto(url, { waitUntil: 'domcontentloaded' });
              finalUrl = page.url();
              // The landing URL, not the requested one: a trace filed under a
              // redirect's source would never match the page it actually runs
              // against. `url` is what the step replays, so both are kept.
              recordAction(deps, {
                scope,
                tool: 'browser_navigate',
                page,
                args: { url },
                url: finalUrl,
              });
              return {
                content: [{ type: 'text' as const, text: `Navigated to ${redactPasswordParams(finalUrl)}` }],
              };
            }
            // Use RPC for fast, reliable navigation (bypasses Playwright CDP discovery)
            await sendScopedBrowserRpc('browser.navigate', scope, { url });
            // The RPC resolves on commit (#756); the CDP Page.frameNavigated
            // that feeds the lifecycle ring races it. A short settle lets the
            // post-body drain catch this call's own events — a miss is only a
            // delay (next op's pre-drain), not a loss. Chrome needs none: its
            // in-process mirror is populated before goto() resolves.
            await new Promise((resolve) => setTimeout(resolve, 150));
            // Report where the page actually LANDED (navigate_back's existing
            // pattern): on a redirect the requested URL is not the final one,
            // and the self-echo match needs the final URL to fire. Fall back
            // to the requested URL when the read fails mid-load.
            finalUrl = await sendScopedBrowserRpc<{ value: string }>('browser.evaluate', scope, {
              expression: 'location.href',
            }).then((r) => r?.value || url).catch(() => url);
            recordAction(deps, {
              scope,
              tool: 'browser_navigate',
              page: null,
              args: { url },
              url: finalUrl,
            });
            return {
              content: [{ type: 'text' as const, text: `Navigated to ${redactPasswordParams(finalUrl)}` }],
            };
          },
          { redundantNavigationUrl: () => finalUrl },
        );
      } catch (error) {
        const message = describeToolError(error);
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
    'Go back in history. Returns the resulting URL.',
    BROWSER_NAVIGATE_BACK_SHAPE,
    async ({ surfaceId }) => {
      try {
        // Leased for the same reason as browser_navigate above: the post-body
        // drain attributes this call's own navigation to this result.
        let finalUrl: string | undefined;
        return await withAutomationLease(
          deps,
          surfaceId,
          async (scope) => {
            // Chrome backend: browser.goBack has no chrome lane — go back on the
            // resolved page over Playwright (dogfood P2).
            const engine = PlaywrightEngine.getInstance();
            if ((await engine.resolveWorkspaceBackend(scope.workspaceId)) === 'chrome') {
              const page = await engine.getPageForScope(scope);
              if (!page) throw new Error('browser_navigate_back: no chrome page resolved for this scope.');
              await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => null);
              finalUrl = page.url();
              return {
                content: [{ type: 'text' as const, text: `Went back. Current URL: ${redactPasswordParams(finalUrl)}` }],
              };
            }
            await sendScopedBrowserRpc('browser.goBack', scope);

            await new Promise((resolve) => setTimeout(resolve, 300));

            // Get current URL
            const urlResult = await sendScopedBrowserRpc<{ value: string }>('browser.evaluate', scope, {
              expression: 'location.href',
            });

            finalUrl = urlResult.value;
            return {
              content: [{ type: 'text' as const, text: `Navigated back to ${redactPasswordParams(finalUrl)}` }],
            };
          },
          { redundantNavigationUrl: () => finalUrl },
        );
      } catch (error) {
        const message = describeToolError(error);
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
    'Manage browser surfaces in the calling workspace. Address one only by the opaque surfaceId from list or new, never by list position. select moves UI focus only and does NOT retarget the other browser tools, so pass surfaceId explicitly on follow-up calls. selected likewise reports UI focus (always false on the chrome backend), not tool targeting. Omitting surfaceId targets your MOST RECENTLY opened surface — a just-created new tab, or browser_open, becomes that default — so to act on any earlier tab pass its surfaceId explicitly.',
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
        const message = describeToolError(error);
        if (/Unknown method:\s*browser\.tabs/i.test(message)) {
          return tabsToolError(
            browserTabsError(
              'BROWSER_TABS_UNSUPPORTED',
              'The connected wmux main process does not support workspace-scoped browser tabs.',
            ),
          );
        }
        // A workspace-scope refusal is TERMINAL and carries its own remedy
        // ("omit workspaceId and this resolves to…", "Do not retry unchanged").
        // #922 PR-C routed browser.tabs through the caller-scope table, which
        // reports a refusal by THROWING — so without this branch the catch-all
        // below would relabel it "temporarily unavailable" and the agent would
        // retry a call that can never succeed, never seeing the one sentence
        // that says how to fix it. Pass the message through verbatim: rewriting
        // a terminal refusal as a transient failure is the exact anti-pattern
        // `scopeRefusalError` exists to prevent.
        if (/BROWSER_SCOPE_REFUSED/.test(message)) {
          return tabsToolError(
            browserTabsError('BROWSER_TABS_SCOPE_REFUSED', message),
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
