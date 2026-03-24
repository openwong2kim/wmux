import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { generateSnapshot, resolveRef } from '../snapshot';
import { evaluateWithGesture } from '../anti-detection';
import { detectDangerousPatterns } from '../security';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

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

const consoleMessages = new Map<string, ConsoleEntry[]>();
const networkRequests = new Map<string, NetworkEntry[]>();

// Track which pages already have listeners attached
const attachedConsolePages = new WeakSet<Page>();
const attachedNetworkPages = new WeakSet<Page>();

function ensureConsoleListener(page: Page, surfaceKey: string): void {
  if (attachedConsolePages.has(page)) return;
  attachedConsolePages.add(page);

  if (!consoleMessages.has(surfaceKey)) {
    consoleMessages.set(surfaceKey, []);
  }

  page.on('console', (msg) => {
    const entries = consoleMessages.get(surfaceKey);
    if (entries) {
      entries.push({ level: msg.type(), text: msg.text() });
    }
  });
}

function ensureNetworkListener(page: Page, surfaceKey: string): void {
  if (attachedNetworkPages.has(page)) return;
  attachedNetworkPages.add(page);

  if (!networkRequests.has(surfaceKey)) {
    networkRequests.set(surfaceKey, []);
  }

  page.on('request', (request) => {
    const entries = networkRequests.get(surfaceKey);
    if (entries) {
      entries.push({
        url: request.url(),
        method: request.method(),
      });
    }
  });

  page.on('response', (response) => {
    const entries = networkRequests.get(surfaceKey);
    if (!entries) return;

    const url = response.url();
    // Find the matching request entry (last one with same URL and no status yet)
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].url === url && entries[i].status === undefined) {
        entries[i].status = response.status();
        // Store response headers for later body retrieval
        const headers = response.headers();
        entries[i].response = { headers };
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
              if (entries[i].response) {
                entries[i].response!.body = body;
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

function surfaceKey(surfaceId?: string): string {
  return surfaceId ?? '__default__';
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
    {
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
    },
    async ({ format, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const snapshot = await generateSnapshot(page, { format: format ?? 'ai' });

        return {
          content: [{ type: 'text' as const, text: snapshot }],
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
  // browser_screenshot
  // -----------------------------------------------------------------------
  server.tool(
    'browser_screenshot',
    'Take a screenshot of the current page or a specific element. Returns the image as base64-encoded PNG. Requires browser_open to be called first to establish a connection, even if a browser panel is already visible.',
    {
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture the full scrollable page instead of just the viewport (default false).'),
      ref: z
        .string()
        .optional()
        .describe('Ref number of an element to screenshot (from browser_snapshot). Omit for full page.'),
      surfaceId: optionalSurfaceId,
    },
    async ({ fullPage, ref, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        let buffer: Buffer;

        if (ref) {
          const el = await resolveRef(page, ref);
          if (!el) {
            throw new Error(`Could not resolve ref="${ref}" to an element.`);
          }
          buffer = (await el.screenshot()) as Buffer;
        } else {
          buffer = (await page.screenshot({ fullPage: fullPage ?? false })) as Buffer;
        }

        const base64 = buffer.toString('base64');

        return {
          content: [
            {
              type: 'image' as const,
              data: base64,
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
    },
  );

  // -----------------------------------------------------------------------
  // browser_evaluate
  // -----------------------------------------------------------------------
  server.tool(
    'browser_evaluate',
    'Evaluate a JavaScript expression in the browser page context. Uses userGesture mode for actions requiring user activation.',
    {
      expression: z.string().describe('The JavaScript expression to evaluate.'),
      surfaceId: optionalSurfaceId,
    },
    async ({ expression, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const warnings = detectDangerousPatterns(expression);
        if (warnings.length > 0) {
          console.warn(`[browser_evaluate] Dangerous patterns detected: ${warnings.join(', ')}`);
        }

        const result = await evaluateWithGesture(page, expression);
        const text =
          typeof result === 'string' ? result : (JSON.stringify(result, null, 2) ?? 'undefined');

        if (warnings.length > 0) {
          const warningText = `\u26A0 Security warning: expression contains potentially dangerous patterns: ${warnings.join(', ')}. Exercise caution with untrusted input.\n\n`;
          return {
            content: [{ type: 'text' as const, text: warningText + text }],
          };
        }

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
    },
  );

  // -----------------------------------------------------------------------
  // browser_console
  // -----------------------------------------------------------------------
  server.tool(
    'browser_console',
    'Retrieve console messages collected from the browser page. Messages are accumulated over time; use clear=true to reset.',
    {
      level: z
        .enum(['error', 'warn', 'info', 'all'])
        .optional()
        .describe('Filter by message level. Defaults to "all".'),
      clear: z
        .boolean()
        .optional()
        .describe('Clear collected messages after returning them.'),
      surfaceId: optionalSurfaceId,
    },
    async ({ level, clear, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const key = surfaceKey(surfaceId);
        ensureConsoleListener(page, key);

        const entries = consoleMessages.get(key) ?? [];

        const filterLevel = level ?? 'all';
        const filtered =
          filterLevel === 'all'
            ? entries
            : entries.filter((e) => {
                if (filterLevel === 'info') {
                  return e.level === 'log' || e.level === 'info';
                }
                return e.level === filterLevel;
              });

        const text =
          filtered.length === 0
            ? 'No console messages collected.'
            : filtered.map((e) => `[${e.level}] ${e.text}`).join('\n');

        if (clear) {
          consoleMessages.set(key, []);
        }

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
    },
  );

  // -----------------------------------------------------------------------
  // browser_network
  // -----------------------------------------------------------------------
  server.tool(
    'browser_network',
    'Retrieve network requests collected from the browser page. Requests are accumulated over time. Use a URL glob pattern to filter.',
    {
      filter: z
        .string()
        .optional()
        .describe('URL glob pattern to filter requests (e.g. "*api*", "*.json").'),
      surfaceId: optionalSurfaceId,
    },
    async ({ filter, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const key = surfaceKey(surfaceId);
        ensureNetworkListener(page, key);

        const entries = networkRequests.get(key) ?? [];

        const filtered = filter
          ? entries.filter((e) => matchesGlob(e.url, filter))
          : entries;

        const summary = filtered.map((e) => ({
          url: e.url,
          method: e.method,
          status: e.status ?? '(pending)',
        }));

        const text =
          summary.length === 0
            ? 'No network requests collected.'
            : JSON.stringify(summary, null, 2);

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
    },
  );

  // -----------------------------------------------------------------------
  // browser_response_body
  // -----------------------------------------------------------------------
  server.tool(
    'browser_response_body',
    'Retrieve the response body for a previously captured network request matching a URL pattern.',
    {
      urlPattern: z
        .string()
        .describe('URL glob pattern to match (e.g. "*api/users*").'),
      surfaceId: optionalSurfaceId,
    },
    async ({ urlPattern, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const key = surfaceKey(surfaceId);
        ensureNetworkListener(page, key);

        const entries = networkRequests.get(key) ?? [];

        // Find the last matching entry with a captured body
        let matchedEntry: NetworkEntry | undefined;
        for (let i = entries.length - 1; i >= 0; i--) {
          if (matchesGlob(entries[i].url, urlPattern) && entries[i].response?.body !== undefined) {
            matchedEntry = entries[i];
            break;
          }
        }

        if (!matchedEntry || !matchedEntry.response?.body) {
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
              text: matchedEntry.response.body,
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
  // browser_highlight
  // -----------------------------------------------------------------------
  server.tool(
    'browser_highlight',
    'Visually highlight an element on the page by its ref number. Adds a red outline around the element.',
    {
      ref: z.string().describe('Ref number of the element to highlight (from browser_snapshot).'),
      surfaceId: optionalSurfaceId,
    },
    async ({ ref, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

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
    },
  );
}
