import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import { generateSnapshot, resolveRef } from '../snapshot';
import { buildDomSnapshotExpression } from '../dom-intelligence';
import { evaluateWithGesture } from '../anti-detection';
import { detectDangerousPatterns } from '../security';
import { sanitizeRef } from './interaction';
import { sendRpc } from '../../wmux-client';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.
const BROWSER_SNAPSHOT_SHAPE = {
  format: z
    .enum(['ai', 'aria'])
    .optional()
    .describe(
      'Snapshot format. "ai" annotates interactive elements with ref numbers (default). "aria" returns the full tree.',
    ),
  ref: z
    .string()
    .optional()
    .describe('Reserved for future use: ref number to scope the snapshot to a subtree.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_SCREENSHOT_SHAPE = {
  fullPage: z
    .boolean()
    .optional()
    .describe('Capture the full scrollable page instead of just the viewport (default false).'),
  ref: z
    .string()
    .optional()
    .describe('Ref number of an element to screenshot (from browser_snapshot). Omit for full page.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_EVALUATE_SHAPE = {
  expression: z.string().describe('The JavaScript expression to evaluate.'),
  allowDangerous: z
    .boolean()
    .optional()
    .describe('Allow execution even if the expression contains dangerous patterns (fetch, cookies, storage, eval). Default false. Use only with trusted input.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_CONSOLE_SHAPE = {
  level: z
    .enum(['error', 'warn', 'info', 'all'])
    .optional()
    .describe('Filter by message level. Defaults to "all".'),
  clear: z
    .boolean()
    .optional()
    .describe('Clear collected messages after returning them.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_NETWORK_SHAPE = {
  filter: z
    .string()
    .optional()
    .describe('URL glob pattern to filter requests (e.g. "*api*", "*.json").'),
  clear: z
    .boolean()
    .optional()
    .describe('Clear collected requests (and any retained response bodies) after returning them.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_RESPONSE_BODY_SHAPE = {
  urlPattern: z
    .string()
    .describe('URL glob pattern to match (e.g. "*api/users*").'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_HIGHLIGHT_SHAPE = {
  ref: z.string().describe('Ref number of the element to highlight (from browser_snapshot).'),
  surfaceId: optionalSurfaceId,
};

// ---------------------------------------------------------------------------
// Module-level storage for console messages and network requests
// ---------------------------------------------------------------------------

interface ConsoleEntry {
  level: string;
  text: string;
}

interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  response?: {
    headers: Record<string, string>;
    body?: string;
  };
}

// Capture buffers are keyed by the Page object itself, not by surfaceId. A Page is the
// true identity: an omitted surfaceId and an explicit surfaceId can resolve to the SAME
// Page (one buffer, no stranding), and two DISTINCT Pages never collide on an alias key
// like '__default__' (so closing one page cannot delete another's data). WeakMap also
// lets a closed/GC'd Page drop its buffers automatically.
const consoleMessages = new WeakMap<Page, ConsoleEntry[]>();
const networkRequests = new WeakMap<Page, NetworkEntry[]>();

// Bound the per-page capture arrays so a long-lived MCP server process does not grow
// without limit on a chatty / polling page. Oldest entries are dropped first.
const MAX_CAPTURE_ENTRIES = 1000;
// Cap each retained response body so a single large payload cannot pin unbounded RAM.
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;

// Track which pages already have listeners attached. Keyed by the Page object so a
// closed/GC'd page drops its guard automatically.
const attachedConsolePages = new WeakSet<Page>();
const attachedNetworkPages = new WeakSet<Page>();
const cleanupBoundPages = new WeakSet<Page>();

/** Append to a capped ring: drop the oldest entries once MAX_CAPTURE_ENTRIES is exceeded. */
function pushCapped<T>(entries: T[], item: T): void {
  entries.push(item);
  if (entries.length > MAX_CAPTURE_ENTRIES) {
    entries.splice(0, entries.length - MAX_CAPTURE_ENTRIES);
  }
}

/**
 * Eagerly drop a page's capture buffers when it closes. The WeakMap would reclaim them
 * once the Page is GC'd, but the engine may retain the Page object past close, so we
 * delete on 'close' to free the (potentially large) retained response bodies promptly.
 * Bound once per page.
 */
function ensurePageCloseCleanup(page: Page): void {
  if (cleanupBoundPages.has(page)) return;
  cleanupBoundPages.add(page);

  page.on('close', () => {
    consoleMessages.delete(page);
    networkRequests.delete(page);
  });
}

function ensureConsoleListener(page: Page): void {
  ensurePageCloseCleanup(page);
  if (attachedConsolePages.has(page)) return;
  attachedConsolePages.add(page);

  if (!consoleMessages.has(page)) {
    consoleMessages.set(page, []);
  }

  page.on('console', (msg) => {
    const entries = consoleMessages.get(page);
    if (entries) {
      pushCapped(entries, { level: msg.type(), text: msg.text() });
    }
  });
}

function ensureNetworkListener(page: Page): void {
  ensurePageCloseCleanup(page);
  if (attachedNetworkPages.has(page)) return;
  attachedNetworkPages.add(page);

  if (!networkRequests.has(page)) {
    networkRequests.set(page, []);
  }

  page.on('request', (request) => {
    const entries = networkRequests.get(page);
    if (entries) {
      pushCapped(entries, {
        url: request.url(),
        method: request.method(),
      });
    }
  });

  page.on('response', (response) => {
    const entries = networkRequests.get(page);
    if (!entries) return;

    const url = response.url();
    // Find the matching request entry (last one with same URL and no status yet)
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].url === url && entries[i].status === undefined) {
        // Capture a stable reference to the entry object: the capture array is a
        // capped ring (pushCapped), so positional indices can shift while the async
        // response.text() below is in flight.
        const entry = entries[i];
        entry.status = response.status();
        // Store response headers for later body retrieval
        const headers = response.headers();
        entry.response = { headers };
        // Only eagerly capture body for text-based content types
        const contentType = headers['content-type'] ?? '';
        const isTextual =
          contentType.startsWith('text/') ||
          contentType.includes('application/json') ||
          contentType.includes('application/xml') ||
          contentType.includes('application/xhtml') ||
          contentType.includes('+json') ||
          contentType.includes('+xml');
        if (isTextual) {
          response
            .text()
            .then((body) => {
              if (entry.response) {
                entry.response.body =
                  body.length > MAX_RESPONSE_BODY_BYTES
                    ? body.slice(0, MAX_RESPONSE_BODY_BYTES) +
                      `\n... [truncated ${body.length - MAX_RESPONSE_BODY_BYTES} chars]`
                    : body;
              }
            })
            .catch(() => {
              // Body may not be available for all responses
            });
        }
        break;
      }
    }
  });
}

/**
 * Simple glob-like URL matching.
 * Supports '*' as wildcard for any sequence of characters.
 */
function matchesGlob(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$', 'i');
  return regex.test(url);
}

// --- Shared formatters: used by both the Playwright path and the RPC fallback
// (#106) so console/network render identically regardless of transport. ---

function filterConsole(entries: ConsoleEntry[], level?: string): ConsoleEntry[] {
  const filterLevel = level ?? 'all';
  if (filterLevel === 'all') return entries;
  return entries.filter((e) => {
    if (filterLevel === 'info') return e.level === 'log' || e.level === 'info';
    return e.level === filterLevel;
  });
}

function formatConsole(entries: ConsoleEntry[]): string {
  return entries.length === 0
    ? 'No console messages collected.'
    : entries.map((e) => `[${e.level}] ${e.text}`).join('\n');
}

/** Filter by URL glob and render the {url, method, status} summary JSON. */
function formatNetwork(
  entries: Array<{ url: string; method: string; status?: number }>,
  filter?: string,
): string {
  const filtered = filter ? entries.filter((e) => matchesGlob(e.url, filter)) : entries;
  const summary = filtered.map((e) => ({
    url: e.url,
    method: e.method,
    status: e.status ?? '(pending)',
  }));
  return summary.length === 0 ? 'No network requests collected.' : JSON.stringify(summary, null, 2);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register inspection-related MCP tools on the given server.
 *
 * Tools:
 *  - browser_snapshot       -- accessibility tree snapshot
 *  - browser_screenshot     -- page or element screenshot
 *  - browser_evaluate       -- evaluate JS expression
 *  - browser_console        -- retrieve console messages
 *  - browser_network        -- retrieve network requests
 *  - browser_response_body  -- retrieve response body by URL pattern
 *  - browser_highlight      -- visually highlight an element
 */
export function registerInspectionTools(server: McpServer): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_snapshot
  // -----------------------------------------------------------------------
  server.tool(
    'browser_snapshot',
    'Take an accessibility tree snapshot of the current page. Returns a text representation of the page structure with interactive elements annotated with ref numbers.',
    BROWSER_SNAPSHOT_SHAPE,
    async ({ format, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        // Try Playwright for full snapshot
        const page = await engine.getPage(surfaceId).catch(() => null);
        if (page) {
          const snapshot = await generateSnapshot(page, { format: format ?? 'ai' });
          return {
            content: [{ type: 'text' as const, text: snapshot }],
          };
        }

        // Fallback: extract page structure via RPC evaluation. Tags interactive
        // elements with data-wmux-ref so interaction tools can resolve them.
        // Same expression the page-mode root-only fallthrough runs (snapshot.ts),
        // via the shared buildDomSnapshotExpression() helper.
        const result = await sendRpc('browser.evaluate', {
          expression: buildDomSnapshotExpression(),
          ...(surfaceId && { surfaceId }),
        }) as { value: string };

        return {
          content: [{ type: 'text' as const, text: result.value }],
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
  // browser_screenshot
  // -----------------------------------------------------------------------
  server.tool(
    'browser_screenshot',
    'Take a screenshot of the current page or a specific element. Returns the image as base64-encoded PNG. Requires browser_open to be called first to establish a connection, even if a browser panel is already visible.',
    BROWSER_SCREENSHOT_SHAPE,
    async ({ fullPage, ref, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        // Try Playwright for element-level screenshots (ref)
        if (ref) {
          const page = await engine.getPage(surfaceId);
          if (page) {
            const el = await resolveRef(page, ref);
            if (!el) {
              throw new Error(`Could not resolve ref="${ref}" to an element.`);
            }
            const buffer = (await el.screenshot()) as Buffer;
            return {
              content: [{ type: 'image' as const, data: buffer.toString('base64'), mimeType: 'image/png' as const }],
            };
          }
        }

        // Use RPC for fast, reliable screenshots (bypasses Playwright CDP discovery)
        const result = await sendRpc('browser.screenshot', {
          ...(surfaceId && { surfaceId }),
          ...(fullPage && { fullPage }),
        }) as { data: string };

        return {
          content: [
            {
              type: 'image' as const,
              data: result.data,
              mimeType: 'image/png' as const,
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
  // browser_evaluate
  // -----------------------------------------------------------------------
  server.tool(
    'browser_evaluate',
    'Evaluate a JavaScript expression in the browser page context. Dangerous patterns (fetch, XHR, cookies, storage, eval, Function) are BLOCKED by default to mitigate prompt injection; pass allowDangerous:true to override when the caller has verified the expression is trusted.',
    BROWSER_EVALUATE_SHAPE,
    async ({ expression, allowDangerous, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        const warnings = detectDangerousPatterns(expression);
        if (warnings.length > 0 && !allowDangerous) {
          const blockedMsg =
            `browser_evaluate blocked: expression contains dangerous patterns (${warnings.join(', ')}). ` +
            `Pass allowDangerous:true to execute anyway.`;
          return {
            content: [{ type: 'text' as const, text: blockedMsg }],
            isError: true,
          };
        }
        if (warnings.length > 0) {
          console.warn(`[browser_evaluate] allowDangerous override for: ${warnings.join(', ')}`);
        }

        let result: unknown;

        // Try Playwright first for gesture-aware evaluation
        const page = await engine.getPage(surfaceId).catch(() => null);
        if (page) {
          result = await evaluateWithGesture(page, expression);
        } else {
          // Fallback: RPC evaluation via main process webContents
          const rpcResult = await sendRpc('browser.evaluate', {
            expression,
            ...(surfaceId && { surfaceId }),
          }) as { value: unknown };
          result = rpcResult.value;
        }

        const text =
          typeof result === 'string' ? result : (JSON.stringify(result, null, 2) ?? 'undefined');

        return {
          content: [{ type: 'text' as const, text: text ?? 'undefined' }],
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
  // browser_console
  // -----------------------------------------------------------------------
  server.tool(
    'browser_console',
    'Retrieve console messages collected from the browser page. Messages are accumulated over time; use clear=true to reset.',
    BROWSER_CONSOLE_SHAPE,
    async ({ level, clear, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);

        let entries: ConsoleEntry[];
        if (page) {
          ensureConsoleListener(page);
          entries = consoleMessages.get(page) ?? [];
          if (clear) consoleMessages.set(page, []);
        } else {
          // RPC fallback (packaged builds): drain the main-process CDP capture.
          const result = await sendRpc('browser.console.get', {
            ...(surfaceId && { surfaceId }),
            ...(clear && { clear: true }),
          }) as { entries: ConsoleEntry[] };
          entries = result.entries ?? [];
        }

        const text = formatConsole(filterConsole(entries, level));

        return {
          content: [{ type: 'text' as const, text }],
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
  // browser_network
  // -----------------------------------------------------------------------
  server.tool(
    'browser_network',
    'Retrieve network requests collected from the browser page. Requests are accumulated over time; use clear=true to reset. Use a URL glob pattern to filter.',
    BROWSER_NETWORK_SHAPE,
    async ({ filter, clear, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);

        let entries: Array<{ url: string; method: string; status?: number }>;
        if (page) {
          ensureNetworkListener(page);
          entries = networkRequests.get(page) ?? [];
          if (clear) networkRequests.set(page, []);
        } else {
          // RPC fallback (packaged builds): drain the main-process CDP capture.
          const result = await sendRpc('browser.network.get', {
            ...(surfaceId && { surfaceId }),
            ...(clear && { clear: true }),
          }) as { entries: Array<{ url: string; method: string; status?: number }> };
          entries = result.entries ?? [];
        }

        const text = formatNetwork(entries, filter);

        return {
          content: [{ type: 'text' as const, text }],
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
  // browser_response_body
  // -----------------------------------------------------------------------
  server.tool(
    'browser_response_body',
    'Retrieve the response body for a previously captured network request matching a URL pattern.',
    BROWSER_RESPONSE_BODY_SHAPE,
    async ({ urlPattern, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);

        let body: string | null = null;
        if (page) {
          ensureNetworkListener(page);
          const entries = networkRequests.get(page) ?? [];
          // Find the last matching entry with a captured body
          for (let i = entries.length - 1; i >= 0; i--) {
            const candidate = entries[i].response?.body;
            if (candidate !== undefined && matchesGlob(entries[i].url, urlPattern)) {
              body = candidate;
              break;
            }
          }
        } else {
          // RPC fallback (packaged builds): the main process matches and returns
          // the body from its CDP capture buffer.
          const result = await sendRpc('browser.responseBody.get', {
            urlPattern,
            ...(surfaceId && { surfaceId }),
          }) as { body: string | null };
          body = result.body ?? null;
        }

        if (body === null) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No response body found for pattern "${urlPattern}". Ensure the request has been made and the response was captured.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: body,
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
  // browser_highlight
  // -----------------------------------------------------------------------
  server.tool(
    'browser_highlight',
    'Visually highlight an element on the page by its ref number. Adds a red outline around the element.',
    BROWSER_HIGHLIGHT_SHAPE,
    async ({ ref, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) {
            throw new Error(`Could not resolve ref="${ref}" to an element.`);
          }

          await el.evaluate(
            (element: Element) => {
              (element as HTMLElement).style.outline = '3px solid red';
              (element as HTMLElement).style.outlineOffset = '2px';
            },
          );
        } else {
          // RPC fallback (packaged builds): resolve via the data-wmux-ref tag set
          // by browser_snapshot / browser_smart_snapshot and set the outline inline.
          const safeRef = sanitizeRef(ref);
          const result = await sendRpc('browser.evaluate', {
            expression: `(() => {
              const el = document.querySelector('[data-wmux-ref="${safeRef}"]');
              if (!el) return 'not_found';
              el.style.outline = '3px solid red';
              el.style.outlineOffset = '2px';
              return 'ok';
            })()`,
            ...(surfaceId && { surfaceId }),
          }) as { value: string };
          if (result.value === 'not_found') {
            throw new Error(`Could not resolve ref="${ref}" to an element.`);
          }
        }

        return {
          content: [{ type: 'text' as const, text: 'Element highlighted' }],
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
