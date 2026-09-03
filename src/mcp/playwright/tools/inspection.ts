import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import {
  generateScopedSnapshot,
  generateSnapshot,
  browserScopeKey,
  markDomRefsActive,
  noteFrameRefsForScope,
  resolveRef,
} from '../snapshot';
import { buildDomSnapshotExpression } from '../dom-intelligence';
import { pageEvaluator, rpcEvaluator } from '../page-eval';
import { formatSnapshotResult } from '../snapshotDiff';
import { getSnapshotBaseline, setSnapshotBaseline, snapshotSurfaceKey } from '../snapshotCache';
import { captureSnapshotListing } from '../snapshotListing';
import { evaluateWithGesture } from '../user-gesture';
import { evaluateIsolated } from '../isolated-eval';
import { detectDangerousPatterns } from '../security';
import { redactPasswordParams } from '../redact';
import { sanitizeRef } from './interaction';
import {
  allowScopedRpcFallback,
  sendScopedBrowserRpc,
  type BrowserToolDeps,
  type BrowserTargetScope,
} from '../browserScope';
import {
  clearConsoleCapture,
  clearNetworkCapture,
  ensurePageCapture,
  type CaptureWindow,
  type ConsoleEntry,
} from '../pageCapture';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Omit for the active surface.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.
const BROWSER_SNAPSHOT_SHAPE = {
  format: z
    .enum(['ai', 'aria'])
    .optional()
    .describe(
      '"ai" annotates interactive elements with refs (default); "aria" returns the full tree, without refs.',
    ),
  selector: z
    .string()
    .optional()
    .describe(
      'Scope to the first match (e.g. "[role=dialog]"), falling back to a DOM listing of that element when the tree cannot be scoped.',
    ),
  filter: z
    .enum(['interactive'])
    .optional()
    .describe('Strips non-interactive nodes — much smaller output. Ignored by "aria".'),
  full: z.boolean().optional().describe('Force the complete tree instead of a diff.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_SCREENSHOT_SHAPE = {
  fullPage: z
    .boolean()
    .optional()
    .describe('Capture the full scrollable page (default false).'),
  ref: z
    .string()
    .optional()
    .describe('Element to capture; omit for the whole page.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_EVALUATE_SHAPE = {
  expression: z.string(),
  allowDangerous: z
    .boolean()
    .optional()
    .describe('Run a blocked pattern anyway. Default false; trusted input only.'),
  mainWorld: z
    .boolean()
    .optional()
    .describe("Run in the page's own JS world to reach its globals (e.g. window.__NEXT_DATA__). Default false."),
  surfaceId: optionalSurfaceId,
};

const BROWSER_CONSOLE_SHAPE = {
  level: z
    .enum(['error', 'warn', 'info', 'all'])
    .optional()
    .describe('Defaults to "all".'),
  clear: z
    .boolean()
    .optional()
    .describe('Clear after returning.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_NETWORK_SHAPE = {
  filter: z
    .string()
    .optional()
    .describe('URL glob, e.g. "*api*".'),
  clear: z
    .boolean()
    .optional()
    .describe('Clear requests and retained response bodies after returning.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_RESPONSE_BODY_SHAPE = {
  urlPattern: z
    .string()
    .describe('URL glob, e.g. "*api/users*".'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_HIGHLIGHT_SHAPE = {
  ref: z.string(),
  surfaceId: optionalSurfaceId,
};

// ---------------------------------------------------------------------------
// Capture buffers
// ---------------------------------------------------------------------------
//
// The buffers themselves live in ../pageCapture: collection has to start when
// the ENGINE first resolves a page, long before this file is asked to read it
// (#1081). What is left here is the read side — which of the two transports'
// buffers serves a given scope, and how an empty one is reported.

/**
 * Simple glob-like URL matching.
 * Supports '*' as wildcard for any sequence of characters.
 */
function matchesGlob(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$', 'i');
  return regex.test(url);
}

/**
 * Read one of the two capture buffers for a scope.
 *
 * There are two, and they start at different moments. Main's webContents
 * capture (BrowserCaptureManager) is enabled when a builtin guest attaches, so
 * it covers the whole page life; the engine-side Playwright buffer only exists
 * where main has no guest to watch — a chrome-backend tab. Preferring main's
 * for everything but 'chrome' is what makes a dev build and a packaged build
 * answer browser_console identically: before #1081 a dev build read the
 * Playwright buffer, which only started at the first read call.
 *
 * The RPC lane still falls back to the page lane if main cannot serve it (an
 * older main, a target that just went away), and that fallback attaches
 * lazily, exactly as every path did before.
 */
async function readCapture<T>(
  scope: BrowserTargetScope,
  fromRpc: () => Promise<T>,
  fromPage: (page: Page) => T,
): Promise<T> {
  const engine = PlaywrightEngine.getInstance();
  const resolvePage = () => engine.getPageForScope(scope).catch(allowScopedRpcFallback);

  let backend: string | undefined;
  try {
    backend = await engine.resolveWorkspaceBackend(scope.workspaceId);
  } catch {
    // Backend unknown (older main, cdp info disabled) — treat as builtin.
  }

  if (backend === 'chrome') {
    const page = await resolvePage();
    // No page under 'chrome' means resolution failed; let the RPC lane raise
    // its own contract error rather than inventing one here.
    return page ? fromPage(page) : fromRpc();
  }

  try {
    return await fromRpc();
  } catch (error) {
    const page = await resolvePage();
    if (!page) throw error;
    return fromPage(page);
  }
}

/**
 * State the collection window whenever it is known, so an empty buffer stops
 * reading like a clean page (#1081). Two different facts hide behind "nothing
 * here": collection has been running and the page really has been quiet, or
 * collection started after the interesting part had already happened.
 */
function describeWindow(window: CaptureWindow | undefined, noun: string): string {
  if (!window) return '';
  const since = new Date(window.since).toISOString();
  const gap = window.missedBefore
    ? ` The page was already open when collection started, so ${noun} from before then are not included.`
    : '';
  return `Collecting since ${since}.${gap}`;
}

/** Trailing note for a NON-empty result that still has an uncovered window. */
function windowFootnote(window: CaptureWindow | undefined, noun: string): string {
  if (!window?.missedBefore) return '';
  const since = new Date(window.since).toISOString();
  return `\n\n[collection started ${since}; ${noun} from before then are not included]`;
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

/**
 * Render collected console messages.
 *
 * Console text gets the same redaction as a network body: a page that logs its
 * own login payload would otherwise hand the credential straight over. The
 * masking is key-scoped rather than content-scoped — it rewrites only the value
 * of a `password`-family parameter — so ordinary log lines pass through byte
 * for byte.
 */
function formatConsole(entries: ConsoleEntry[], window?: CaptureWindow): string {
  if (entries.length === 0) {
    const detail = describeWindow(window, 'messages');
    return detail ? `No console messages. ${detail}` : 'No console messages collected.';
  }
  return (
    entries.map((e) => `[${e.level}] ${redactPasswordParams(e.text)}`).join('\n') +
    windowFootnote(window, 'messages')
  );
}

/**
 * Filter by URL glob and render the {url, method, status} summary JSON.
 *
 * Request bodies are never captured, so the only credential that can reach this
 * listing is one a page put in the query string of a GET — which redaction
 * strips from the rendered URL. The glob still matches against the REAL url:
 * filtering is the caller's own pattern, not something the agent reads back.
 */
function formatNetwork(
  entries: Array<{ url: string; method: string; status?: number }>,
  filter?: string,
  window?: CaptureWindow,
): string {
  const filtered = filter ? entries.filter((e) => matchesGlob(e.url, filter)) : entries;
  const summary = filtered.map((e) => ({
    url: redactPasswordParams(e.url),
    method: e.method,
    status: e.status ?? '(pending)',
  }));
  if (summary.length === 0) {
    const detail = describeWindow(window, 'requests');
    return detail ? `No network requests. ${detail}` : 'No network requests collected.';
  }
  return JSON.stringify(summary, null, 2) + windowFootnote(window, 'requests');
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
export function registerInspectionTools(server: McpServer, deps: BrowserToolDeps): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_snapshot
  // -----------------------------------------------------------------------
  server.tool(
    'browser_snapshot',
    'Accessibility-tree snapshot of the page, with interactive elements annotated with ref numbers. A repeat snapshot of the same page returns a diff against the previous one when that is smaller — pass full:true for the complete tree. Line markers: "focused" on the focused node; while an overlay covers the page, a note names the layer, "overlay" marks it in the tree, and "clickable" marks the only controls still reachable behind it; an iframe line is a boundary — its contents are a separate document, not in this snapshot. Password field values read as "[redacted:password]" (the field is still listed and fillable); an empty field has no value at all, so a redacted one means it IS filled. "ai" drops the duplicate StaticText/InlineTextBox lines Chrome stacks under every piece of text; "aria" keeps them.',
    BROWSER_SNAPSHOT_SHAPE,
    async ({ format, selector, filter, full, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        let text: string;
        // Which route served a SCOPED snapshot. Part of the diff key: an a11y
        // subtree and a DOM listing of the same selector are different
        // renderings, so a call that falls back must not diff against a baseline
        // the other route produced. Stays empty for unscoped calls, whose diff
        // key is unchanged.
        let scopeRoute = '';
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);
        if (selector) {
          // Scope through the a11y tree first when a live Page can give us CDP.
          // The DOM expression is layout-blind — it mints refs for hidden
          // elements that then time out on click (dogfood P0) — and cannot
          // render aria at all. generateScopedSnapshot returns null (never a
          // wrong-scope result) whenever the a11y route can't serve the call,
          // which keeps the DOM listing as the fail-open fallback below.
          const scoped = page
            ? await generateScopedSnapshot(page, selector, {
                format: format ?? 'ai',
                ...(filter && { filter }),
              }).catch(() => null)
            : null;

          if (scoped !== null) {
            text = scoped;
            scopeRoute = '|ax';
          } else {
            // Fallback: selector scoping DOM-side, the only option on the RPC
            // transport (no Page → no CDP). The expression tags data-wmux-ref
            // within the subtree, so refs resolve via the data-attr locator —
            // mark any live Page's a11y refMap stale so resolveRef cannot use it.
            scopeRoute = '|dom';
            const evaluate = page ? pageEvaluator(page) : rpcEvaluator(scope);
            // The DOM listing carries the page URL and every link href verbatim,
            // so it gets the same URL redaction the network listing does.
            text = redactPasswordParams(
              String(await evaluate(buildDomSnapshotExpression(selector, { filter }))),
            );
            if (text.startsWith('No element matches selector:')) {
              // A miss is an error, not a snapshot — and must never become the
              // diff baseline for the next call (review consensus).
              return {
                content: [{ type: 'text' as const, text }],
                isError: true,
              };
            }
            if (page) markDomRefsActive(page);
            // filter is honored by the DOM listing (#1066); aria is not — be
            // honest about it instead of silently ignoring the param (review
            // consensus). 'ai' needs no note: the listing IS ai-style.
            if (format === 'aria') {
              text = `(note: aria format unavailable for this selector — the a11y tree could not be scoped, returning the DOM interactive listing)\n${text}`;
            }
          }
        } else if (page) {
          text = await generateSnapshot(page, {
            format: format ?? 'ai',
            ...(filter && { filter }),
          });
        } else {
          // Fallback: extract page structure via RPC evaluation. Tags interactive
          // elements with data-wmux-ref so interaction tools can resolve them.
          // Same expression the page-mode root-only fallthrough runs (snapshot.ts),
          // via the shared buildDomSnapshotExpression() helper — filter honored,
          // aria noted, same as there (#1066).
          const result = await sendScopedBrowserRpc<{ value: string }>('browser.evaluate', scope, {
            expression: buildDomSnapshotExpression(undefined, { filter }),
          });
          // Same URL redaction as the scoped DOM listing above.
          text = redactPasswordParams(result.value);
          if (format === 'aria') {
            text = `(note: aria format unavailable — no live page, returning the DOM interactive listing)\n${text}`;
          }
        }

        // What this surface's refs are, for the RPC lane's fail-closed guard.
        // Registered here rather than inside generateSnapshot because the scope
        // is a tool-layer fact, and every route that mints refs for a surface —
        // a11y, scoped, DOM listing, RPC — passes through this one handler.
        // A route that mints no frame refs clears the surface, which is what
        // keeps a later DOM snapshot's tags resolvable.
        noteFrameRefsForScope(browserScopeKey(scope), page ?? null);

        // Auto-diff: a repeat snapshot with the same attributes returns a diff
        // against the previous one when that is genuinely smaller (D1). The
        // fresh text always becomes the new baseline — including on full:true.
        // URL guard (3-model review): never diff across different page URLs —
        // Playwright pages report url() directly, the DOM listing embeds a
        // "URL: …" line to parse.
        let currentUrl: string | undefined;
        if (page && typeof (page as { url?: () => string }).url === 'function') {
          currentUrl = page.url();
        } else {
          currentUrl = /^URL: (.+)$/m.exec(text)?.[1];
        }
        const key = snapshotSurfaceKey(scope.workspaceId, scope.surfaceId);
        const attrs = `${format ?? 'ai'}|${selector ?? ''}|${filter ?? ''}${scopeRoute}`;
        const baseline = full ? null : getSnapshotBaseline(key, attrs, currentUrl);
        const rendered = formatSnapshotResult(baseline?.text ?? null, text);
        setSnapshotBaseline(key, attrs, text, currentUrl);
        // `text` is the whole tree whatever `rendered` turned out to be; a
        // caller that needs every ref (browser_repl) reads it from here
        // instead of forcing full:true (snapshotListing.ts).
        captureSnapshotListing(text);

        return {
          content: [{ type: 'text' as const, text: rendered.text }],
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

  /**
   * The coordinate basis of a screenshot, stated in the result.
   *
   * browser_click x/y are VIEWPORT CSS pixels, while a PNG is in device pixels
   * — off by the devicePixelRatio on every retina display — and a fullPage or
   * element shot is not in viewport space at all. Without this line an agent
   * reading pixels off the image clicks the wrong place and cannot tell why.
   * Adding a text part changes the result shape (image-only before), which is
   * called out in the changelog.
   */
  const coordinateBasis = (
    kind: 'viewport' | 'fullPage' | 'element' | 'unsupported',
    dpr: number | null,
  ): string => {
    if (kind === 'fullPage') {
      return 'Coordinates in this image are DOCUMENT coordinates — NOT usable for browser_click x/y (which are viewport CSS px). Take a viewport screenshot (omit fullPage) if you need to click by coordinate.';
    }
    if (kind === 'element') {
      return 'Coordinates in this image are ELEMENT-relative — NOT usable for browser_click x/y (which are viewport CSS px).';
    }
    if (kind === 'unsupported') {
      return 'This backend does not support coordinate clicks (browser_click resolves elements by ref here), so no coordinate can be read off this image.';
    }
    return dpr === null
      ? 'This is a viewport capture. browser_click x/y are viewport CSS px; this image may be scaled by the display\'s devicePixelRatio, which could not be read here — divide image pixels by it before clicking.'
      : `This is a viewport capture at devicePixelRatio ${dpr}. browser_click x/y are viewport CSS px = image pixels / ${dpr}.`;
  };

  /** Read the ratio at capture time, so the note describes THIS image. */
  const readDpr = async (page: Page | null): Promise<number | null> => {
    if (!page) return null;
    // devicePixelRatio is a property of the frame, not of the main world's
    // globals, so the isolated world reads the same number.
    const value = await evaluateIsolated(page, 'window.devicePixelRatio').catch(() => null);
    return typeof value === 'number' && value > 0 ? value : null;
  };

  server.tool(
    'browser_screenshot',
    'Screenshot the page or one element as a base64-encoded PNG. Requires browser_open first, even if a browser panel is already visible.',
    BROWSER_SCREENSHOT_SHAPE,
    async ({ fullPage, ref, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        // Chrome backend (dogfood P2): browser.screenshot has no chrome lane —
        // whole-page shots go over the resolved Playwright page instead.
        if (!ref && (await engine.resolveWorkspaceBackend(scope.workspaceId)) === 'chrome') {
          const page = await engine.getPageForScope(scope);
          if (page) {
            // Read the ratio immediately before the capture: a display change
            // between the two would otherwise mislabel the image.
            const dpr = fullPage ? null : await readDpr(page);
            const buf = await page.screenshot({ ...(fullPage && { fullPage: true }), type: 'png' });
            return {
              content: [
                { type: 'image' as const, data: buf.toString('base64'), mimeType: 'image/png' },
                {
                  type: 'text' as const,
                  text: coordinateBasis(fullPage ? 'fullPage' : 'viewport', dpr),
                },
              ],
            };
          }
        }
        // Try Playwright for element-level screenshots (ref)
        if (ref) {
          const page = await engine.getPageForScope(scope);
          if (page) {
            const el = await resolveRef(page, ref);
            if (!el) {
              throw new Error(`Could not resolve ref="${ref}" to an element.`);
            }
            const buffer = (await el.screenshot()) as Buffer;
            return {
              content: [
                { type: 'image' as const, data: buffer.toString('base64'), mimeType: 'image/png' as const },
                { type: 'text' as const, text: coordinateBasis('element', null) },
              ],
            };
          }
        }

        // Use RPC for fast, reliable screenshots (bypasses Playwright CDP discovery)
        const result = await sendScopedBrowserRpc<{ data: string }>('browser.screenshot', scope, {
          ...(fullPage && { fullPage }),
        });

        return {
          content: [
            {
              type: 'image' as const,
              data: result.data,
              mimeType: 'image/png' as const,
            },
            {
              // The RPC lane cannot click by coordinate at all, so telling the
              // caller how to convert pixels here would contradict itself.
              type: 'text' as const,
              text: coordinateBasis(fullPage ? 'fullPage' : 'unsupported', null),
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
    'Evaluate a JavaScript expression in the page. Patterns that enable prompt-injection exfiltration (fetch, XHR, cookies, storage, eval, Function) are BLOCKED unless allowDangerous:true. Blocking is a case-sensitive whole-word text scan that reads strings and comments too: the call forms (fetch/eval/require/import) need a "(" next, whitespace allowed — retrieval, evaluateScore(), prefetch() and myFetch() all pass, while both window.fetch(url) and fetch (url) are blocked — while the rest (localStorage, WebSocket, document.cookie) match the bare word anywhere, even in a comment. Strings return verbatim, everything else as JSON (DOM nodes/Map/functions become {}); a returned Promise is awaited, top-level await is a SyntaxError. On the Chrome backend it runs in an isolated world that shares the DOM but not the page\'s JS globals; pass mainWorld:true to read those.',
    BROWSER_EVALUATE_SHAPE,
    async ({ expression, allowDangerous, mainWorld, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
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
        // Set when the isolated world was asked for and could not be had, so
        // the answer says which world it actually came from.
        let worldNote = '';

        // Try Playwright first for gesture-aware evaluation
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);
        if (page) {
          // Isolated world by default: the page can neither see the script nor
          // hand it doctored built-ins. mainWorld:true opts back into the
          // page's own realm for scripts that need its globals.
          result = mainWorld
            ? await evaluateWithGesture(page, expression)
            : await evaluateIsolated(page, expression);
        } else {
          // Fallback: RPC evaluation via main process webContents. This lane
          // drives a guest webContents and has no isolated world at all, so
          // say so rather than let the tool description imply one.
          const rpcResult = await sendScopedBrowserRpc<{ value: unknown }>('browser.evaluate', scope, {
            expression,
          });
          result = rpcResult.value;
          if (!mainWorld) {
            worldNote = "\n(ran in the page's main world: this backend has no isolated world)";
          }
        }

        const text =
          typeof result === 'string' ? result : (JSON.stringify(result, null, 2) ?? 'undefined');

        return {
          content: [{ type: 'text' as const, text: (text ?? 'undefined') + worldNote }],
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
    'Read console messages. Collection starts when the page is opened/attached, not at this call; clear:true resets.',
    BROWSER_CONSOLE_SHAPE,
    async ({ level, clear, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const { entries, window } = await readCapture<{
          entries: ConsoleEntry[];
          window?: CaptureWindow;
        }>(
          scope,
          async () => {
            // Main-process CDP capture, enabled when the guest attached.
            const result = await sendScopedBrowserRpc<{
              entries: ConsoleEntry[];
              since?: number;
              missedBefore?: boolean;
            }>('browser.console.get', scope, { ...(clear && { clear: true }) });
            return {
              entries: result.entries ?? [],
              // An older main reports no window; say nothing rather than guess.
              ...(typeof result.since === 'number' && {
                window: { since: result.since, missedBefore: result.missedBefore === true },
              }),
            };
          },
          (page) => {
            const state = ensurePageCapture(page);
            const entries = state.console;
            const window = state.consoleWindow;
            if (clear) clearConsoleCapture(state);
            return { entries, window };
          },
        );

        const text = formatConsole(filterConsole(entries, level), window);

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
    'Read network requests. Collection starts when the page is opened/attached, not at this call; clear:true resets.',
    BROWSER_NETWORK_SHAPE,
    async ({ filter, clear, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        type NetworkSummary = { url: string; method: string; status?: number };
        const { entries, window } = await readCapture<{
          entries: NetworkSummary[];
          window?: CaptureWindow;
        }>(
          scope,
          async () => {
            // Main-process CDP capture, enabled when the guest attached.
            const result = await sendScopedBrowserRpc<{
              entries: NetworkSummary[];
              since?: number;
              missedBefore?: boolean;
            }>('browser.network.get', scope, { ...(clear && { clear: true }) });
            return {
              entries: result.entries ?? [],
              ...(typeof result.since === 'number' && {
                window: { since: result.since, missedBefore: result.missedBefore === true },
              }),
            };
          },
          (page) => {
            const state = ensurePageCapture(page);
            const entries: NetworkSummary[] = state.network;
            const window = state.networkWindow;
            if (clear) clearNetworkCapture(state);
            return { entries, window };
          },
        );

        const text = formatNetwork(entries, filter, window);

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
    'Response body of a captured network request matching a URL glob.',
    BROWSER_RESPONSE_BODY_SHAPE,
    async ({ urlPattern, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const body = await readCapture<string | null>(
          scope,
          async () => {
            // Main matches and returns the body from its CDP capture buffer.
            const result = await sendScopedBrowserRpc<{ body: string | null }>('browser.responseBody.get', scope, {
              urlPattern,
            });
            return result.body ?? null;
          },
          (page) => {
            const state = ensurePageCapture(page);
            // Find the last matching entry with a captured body
            for (let i = state.network.length - 1; i >= 0; i--) {
              const candidate = state.network[i].response?.body;
              if (candidate !== undefined && matchesGlob(state.network[i].url, urlPattern)) {
                return candidate;
              }
            }
            return null;
          },
        );

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
              // A login endpoint that echoes the submitted form back in its
              // response (validation errors do this) would otherwise hand the
              // password straight to the model. Only `password`-family VALUES
              // are masked — the body stays debuggable, which is the point of
              // the tool.
              text: redactPasswordParams(body),
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
    'Draw a red outline around an element by ref.',
    BROWSER_HIGHLIGHT_SHAPE,
    async ({ ref, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) {
            throw new Error(`Could not resolve ref="${ref}" to an element.`);
          }

          // Main world, deliberately: element-scoped, and an ElementHandle
          // cannot be adopted into an isolated context (see isolated-eval.ts).
          // It writes two inline styles, which the page can see in the DOM
          // regardless of which world wrote them.
          await el.evaluate(
            (element: Element) => {
              (element as HTMLElement).style.outline = '3px solid red';
              (element as HTMLElement).style.outlineOffset = '2px';
            },
          );
        } else {
          // RPC fallback (packaged builds): resolve via the data-wmux-ref tag set
          // by browser_snapshot / browser_smart_snapshot and set the outline inline.
          const safeRef = sanitizeRef(ref, scope);
          const result = await sendScopedBrowserRpc<{ value: string }>('browser.evaluate', scope, {
            expression: `(() => {
              const el = document.querySelector('[data-wmux-ref="${safeRef}"]');
              if (!el) return 'not_found';
              el.style.outline = '3px solid red';
              el.style.outlineOffset = '2px';
              return 'ok';
            })()`,
          });
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
