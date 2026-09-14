import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { validateNavigationUrl } from '../../../shared/types';
import { sendRpc } from '../../wmux-client';
import { PlaywrightEngine } from '../PlaywrightEngine';
import {
  ensureOwnSurfaceScope,
  requireBrowserTargetScope,
  sendScopedBrowserRpc,
  type BrowserToolDeps,
} from '../browserScope';
import { domainFromUrl } from '../../../shared/browserMemory/siteMemory';
import { normalizeUrlKey } from '../../../shared/browserReplay/actionTrace';
import { withAutomationLease } from '../automationLease';
import { describeToolError } from '../toolError';
import { redactPasswordParams } from '../redact';
import { recordAction } from '../../browser-replay/actionRing';
import { refererFor } from '../../../shared/referer';
import { NavigationNotCommittedError, navigateFromPage } from '../link-navigation';
import { getOpenerKey, noteOpenedSurface } from '../surfaceRouting';
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
  .describe('Omit for the surface you opened last.');

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

/**
 * The error CLASS behind a failed navigation, or null if it was not one.
 *
 * This is the whole attribution rule for the navigation write hook. Several
 * paths in this file return `isError: true` for reasons that are wmux's own —
 * a tabs-tool error, no live page, an unresolved scope — and none of them say
 * anything about the host. Recording those would fill a site's memory with
 * this application's problems.
 *
 * So only two classes qualify, and both mean "the browser actually issued a
 * request to that host and it did not come back": a Playwright TimeoutError,
 * and a Chromium `net::ERR_*` code. The code string itself is the only thing
 * kept — never the message body, never page text.
 */
function navigationErrorClass(error: unknown): string | null {
  const err = error as { name?: unknown; message?: unknown } | null | undefined;
  const message = typeof err?.message === 'string' ? err.message : '';
  const netCode = /net::ERR_[A-Z0-9_]+/.exec(message);
  if (netCode) return netCode[0];
  if (err?.name === 'TimeoutError' || /\bTimeoutError\b/.test(message)) return 'TimeoutError';
  return null;
}

/**
 * How long a navigation result waits for its own failure to be recorded.
 *
 * Fire-and-forget lost the record outright: a stdio MCP process can exit as
 * soon as it has written the tool response, and an in-flight RPC goes with it.
 * Measured — no file at all without a hold, the file present with one — so the
 * write is awaited, briefly.
 *
 * Short, because the cost is paid on a path the agent is already waiting on,
 * and one-and-a-half seconds is generous for a local pipe write. If the bound
 * is hit, the record is abandoned rather than chased: the failure will happen
 * again if it is real, and the agent's error is the thing that must not be
 * held up.
 */
const SITE_MEMORY_RECORD_TIMEOUT_MS = 1500;

/**
 * File a failed navigation against the host that was attempted.
 *
 * Awaited with a bound, never allowed to throw: a navigation that already
 * failed must not fail twice, and must not hang either.
 */
async function recordNavigationFailure(
  deps: BrowserToolDeps,
  surfaceId: string | undefined,
  url: string,
  error: unknown,
): Promise<void> {
  const errorClass = navigationErrorClass(error);
  if (!errorClass) return;
  const domain = domainFromUrl(url);
  if (!domain) return;
  const write = requireBrowserTargetScope(deps, surfaceId).then((scope) =>
    sendScopedBrowserRpc('browser.siteMemory.record', scope, {
      domain,
      kind: 'failure',
      source: 'navigate',
      // normalizeUrlKey drops the query and the userinfo, so the stored key
      // can never carry a credential or a one-time token.
      urlKey: normalizeUrlKey(url),
      what: 'navigation failed',
      cause: errorClass,
      tryInstead: 'check the host is reachable before starting a flow here',
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      write,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SITE_MEMORY_RECORD_TIMEOUT_MS);
        // The bound must not be the reason the process stays alive.
        timer.unref?.();
      }),
    ]);
  } catch {
    /* memory is bookkeeping; it never fails a navigation */
  } finally {
    if (timer) clearTimeout(timer);
  }
  // The race leaves `write` unhandled when the timeout won, and an unhandled
  // rejection would be reported against a navigation that already returned.
  write.catch(() => {});
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

/**
 * Who opened this tab, from the caller's point of view.
 *
 * `true` — this connection opened it, so it is where an omitted surfaceId
 * lands. `false` — another connection opened it: still reachable by passing
 * its surfaceId (ownership is not a permission boundary), just never the
 * silent default. `"unknown"` — nobody claims it (restored after a restart,
 * opened by a person, or opened before openers were recorded), which makes it
 * the fallback default when this connection has opened nothing.
 *
 * The opener key itself is dropped here: it answers exactly one question, and
 * that answer is this field.
 */
function mineFlag(tab: BrowserTabDescriptor): boolean | 'unknown' {
  if (tab.opener === undefined) return 'unknown';
  return tab.opener === 'mine';
}

function publicTab(tab: BrowserTabDescriptor) {
  return {
    surfaceId: tab.surfaceId,
    paneId: tab.paneId,
    // Every rendered tab URL passes through here (list / new / select / close),
    // so this is the single place a credential in a query string or in
    // `scheme://user:pass@host` gets masked before the agent reads it.
    url: redactPasswordParams(tab.url),
    title: tab.title,
    selected: tab.selected,
    mine: mineFlag(tab),
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
        // Set when the in-page (referer-carrying) route did not commit and the
        // plain navigation was used instead: the agent asked for one request
        // and got a differently-shaped one, so the result says so.
        let refererRetryNote: string | undefined;
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
              // A person reaching this URL by clicking a link arrives with the
              // page they left in the Referer header; page.goto() sends none
              // unless told to. refererFor() decides when there is a real one
              // to send — see shared/referer.
              //
              // But goto with a referer is not a link click: it is an
              // address-bar navigation carrying someone else's Referer, and
              // Chromium labels it `Sec-Fetch-Site: none` + `Sec-Fetch-User:
              // ?1` — a combination that contradicts the header it was given.
              // So when there IS a referer to send, navigate from inside the
              // page instead and let Chromium fill the whole set in agreement
              // (see link-navigation). goto keeps the first navigation, the
              // ones leaving about:blank, and anything the in-page route
              // cannot do.
              const referer = refererFor(page.url(), url);
              if (referer) {
                try {
                  await navigateFromPage(page, url);
                } catch (error) {
                  // Only one failure may be retried: the one where nothing was
                  // requested. A navigation that was attempted and failed is
                  // the caller's answer — repeating it would issue the same
                  // request twice, which for a download or a one-time token
                  // URL is not a retry but a second consumption.
                  if (!(error instanceof NavigationNotCommittedError)) throw error;
                  refererRetryNote =
                    'referer navigation did not commit; retried without a referer';
                  // Plain address-bar navigation, WITHOUT a referer: the
                  // contradictory pair is worse than the missing header.
                  await page.goto(url, { waitUntil: 'domcontentloaded' });
                }
              } else {
                await page.goto(url, { waitUntil: 'domcontentloaded' });
              }
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
                content: [
                  {
                    type: 'text' as const,
                    text: refererRetryNote
                      ? `Navigated to ${redactPasswordParams(finalUrl)}\n${refererRetryNote}`
                      : `Navigated to ${redactPasswordParams(finalUrl)}`,
                  },
                ],
              };
            }
            // Builtin RPC lane: settle WHICH surface first. This lane never
            // asks for a Page, so nothing else in the call would resolve the
            // caller's surface, and main answers an unnamed navigate with the
            // workspace's first live session — another agent's tab as often as
            // this one's (live dogfood: agent B's navigate landed on agent A's
            // page). Resolving here also means the recorded action and the
            // baseline keys below describe the surface actually navigated.
            const target = await ensureOwnSurfaceScope(scope);
            // Use RPC for fast, reliable navigation (bypasses Playwright CDP discovery)
            await sendScopedBrowserRpc('browser.navigate', target, { url });
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
            finalUrl = await sendScopedBrowserRpc<{ value: string }>('browser.evaluate', target, {
              expression: 'location.href',
            }).then((r) => r?.value || url).catch(() => url);
            recordAction(deps, {
              scope: target,
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
        // Only a real network failure to the requested host is remembered —
        // see navigationErrorClass. wmux's own errors reach here too and are
        // deliberately not this site's problem.
        //
        // Awaited: the MCP process may exit the moment this response is
        // written, taking an in-flight RPC with it.
        await recordNavigationFailure(deps, surfaceId, url, error);
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
            // Same reason as browser_navigate's builtin lane: this one never
            // asks for a Page, so the surface is settled here rather than left
            // for main to guess.
            const target = await ensureOwnSurfaceScope(scope);
            await sendScopedBrowserRpc('browser.goBack', target);

            await new Promise((resolve) => setTimeout(resolve, 300));

            // Get current URL
            const urlResult = await sendScopedBrowserRpc<{ value: string }>('browser.evaluate', target, {
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
    'Manage browser surfaces in the calling workspace. Address one only by the opaque surfaceId from list or new, never by list position. select moves UI focus only and does NOT retarget the other browser tools, so pass surfaceId explicitly on follow-up calls. selected likewise reports UI focus (always false on the chrome backend), not tool targeting. list rows carry mine: true (you opened it), false (another agent did), or "unknown" (nobody claims it). Omitting surfaceId targets the surface YOU most recently opened; if you opened none, one no other agent opened, or a new one — so to act on any earlier tab pass its surfaceId explicitly.',
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
          // Only `new` opens something, but the key rides along on every action
          // so main can answer "is this one mine?" per row on `list` — as a
          // verdict; the key itself never comes back.
          openerKey: getOpenerKey(),
        });
        if (!isBrowserTabsResult(result)) {
          throw new Error('Invalid browser.tabs response from wmux main.');
        }
        // A tab this call created becomes this connection's default target,
        // the same promise browser_open makes. Only creation moves it: select
        // is UI focus, and close leaves the pin to be re-resolved.
        if (result.ok && result.action === 'new' && 'tab' in result) {
          noteOpenedSurface(workspaceId, result.tab.surfaceId);
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
