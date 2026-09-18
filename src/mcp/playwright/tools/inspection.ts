import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import {
  DOM_LISTING_Q_NOTE,
  generateScopedSnapshot,
  generateSnapshot,
  browserScopeKey,
  markDomRefsActive,
  noteFrameRefsForScope,
  resolveRef,
} from '../snapshot';
import { buildDomSnapshotExpression, readDomSnapshotPayload } from '../dom-intelligence';
import { nextRefFor, priorRefDescriptors, recordRefGeneration } from '../refDescriptors';
import { pageEvaluator, rpcEvaluator } from '../page-eval';
import { formatSnapshotResult } from '../snapshotDiff';
import { getSnapshotBaseline, setSnapshotBaseline, snapshotSurfaceKey } from '../snapshotCache';
import {
  capCaptureText,
  continueSnapshotCapture,
  cursorIgnoredNote,
  windowSnapshotText,
} from '../snapshotCursor';
import { captureSnapshotListing } from '../snapshotListing';
import { evaluateWithGesture } from '../user-gesture';
import { evaluateIsolated } from '../isolated-eval';
import { detectDangerousPatterns } from '../security';
import { redactPasswordParams } from '../redact';
import {
  attachFailedResourceUrls,
  collapseRepeats,
  filterNetwork,
  resolveNthIndex,
  type NetworkRow,
} from '../inspectionFilters';
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
import { clampScreenshotCeilingBytes } from '../../resultCap';
import {
  formatRefBoxTable,
  recallShrinkRung,
  refBoxCandidates,
  rememberScreenshotScale,
  rememberShrinkRung,
} from '../screenshotRefs';
import {
  coordinateBasis,
  fitScreenshot,
  screenshotGeometry,
  type FittedImage,
  type ShrinkRung,
  type Viewport,
} from '../screenshotScale';

/**
 * Descriptor-history key for the DOM interactive listing (#1355).
 *
 * Per surface, because that is what a listing describes, and per selector,
 * because a scoped listing numbers refs inside one subtree — its descriptors
 * describe a different listing from the unscoped one's.
 */
function domListingKey(scope: BrowserTargetScope, selector: string | undefined): string {
  return `dom:${browserScopeKey(scope)}:${selector ?? ''}`;
}

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Omit for the surface you opened last.');

// Per-call text-result cap, honoured by the dispatch-layer guard
// (src/mcp/resultCap.ts). Tools whose output size the caller does not control
// (a console ring, a network log, an arbitrary JSON.stringify) accept this so
// a legitimate need for more than the 64 KiB default is one parameter away.
// Plain z.number(): the guard floors and clamps the value itself (every zod
// numeric modifier costs bytes in tools/list).
const maxBytesParam = z
  .number()
  .optional()
  .describe('Cap the text result in bytes (default 65536, max 524288).');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.
/**
 * Every Playwright-lane capture freezes CSS animations and transitions for
 * the duration of the shot (Playwright rewinds finite animations to their end
 * state and pauses infinite ones, then restores). Without it two captures of
 * the same page a moment apart differ by whatever a spinner, a fade-in or a
 * skeleton shimmer happened to be doing, and the agent reads that jitter as a
 * page change. A capture is a measurement; time should not be one of its
 * inputs. The webview RPC lane has no equivalent knob (capturePage is a plain
 * framebuffer read) and is left as is.
 */
const FROZEN_CAPTURE = { animations: 'disabled' as const };

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
      'Scope to the first match (e.g. "[role=dialog]") — the cheapest way to narrow a big page. Falls back to a DOM listing of that element when the tree cannot be scoped.',
    ),
  filter: z
    .enum(['interactive'])
    .optional()
    .describe('Strips non-interactive nodes — much smaller output. Ignored by "aria".'),
  q: z
    .string()
    .optional()
    .describe(
      'Text filter: keep only nodes matching this text (or /regex/), plus their ancestors. Literal text is searched in the page and costs about as little as a selector scope; a /regex/, or a page with iframes, still reads the whole tree first — prefer selector when you know where to look.',
    ),
  full: z.boolean().optional().describe('Force the complete tree instead of a diff.'),
  cursor: z
    .string()
    .optional()
    .describe(
      'Continuation token from a truncated snapshot: returns the next lines of that same capture without re-reading the page (refs stay valid). Other parameters are ignored with a cursor.',
    ),
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
  maxBytes: z
    .number()
    .optional()
    .describe('Image base64 ceiling (default 2097152, max 8388608). Over it the image is downscaled, never refused.'),
  refs: z.boolean().optional().describe('Also list snapshot refs with boxes in the capture.'),
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
  maxBytes: maxBytesParam,
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
  maxBytes: maxBytesParam,
};

const BROWSER_NETWORK_SHAPE = {
  filter: z
    .string()
    .optional()
    .describe('URL glob to keep, e.g. "*api*".'),
  exclude: z
    .string()
    .optional()
    .describe('URL glob to drop, applied after filter — e.g. "*/poll*".'),
  status: z
    .string()
    .optional()
    .describe('Status filter: "404", or a class such as "4xx"/"5xx".'),
  method: z
    .string()
    .optional()
    .describe('HTTP method, case-insensitive.'),
  collapse: z
    .boolean()
    .optional()
    .describe('Fold identical url+method+status rows into one "xN" row (default true).'),
  clear: z
    .boolean()
    .optional()
    .describe('Clear requests and retained response bodies after returning.'),
  surfaceId: optionalSurfaceId,
  maxBytes: maxBytesParam,
};

const BROWSER_RESPONSE_BODY_SHAPE = {
  urlPattern: z
    .string()
    .optional()
    .describe('URL glob, e.g. "*api/users*". Omit when passing requestId.'),
  requestId: z
    .number()
    .optional()
    .describe('The "id" browser_network printed for the request; takes priority over urlPattern.'),
  nth: z
    .number()
    .optional()
    .describe('Which match: 1 is the first, -1 the last (default).'),
  surfaceId: optionalSurfaceId,
  maxBytes: maxBytesParam,
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

type NetworkSummary = { url: string; method: string; status?: number };

/**
 * The network buffer for a scope, from whichever lane serves it.
 *
 * Shared by browser_network and by browser_console (which needs it to put the
 * URL back on a "Failed to load resource" line) and by browser_response_body
 * (which resolves an `id`/`nth` against the same ordering the listing printed).
 */
async function readNetworkEntries(
  scope: BrowserTargetScope,
  clear?: boolean,
): Promise<{ entries: NetworkSummary[]; window?: CaptureWindow }> {
  return readCapture<{ entries: NetworkSummary[]; window?: CaptureWindow }>(
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
}

/**
 * The one captured request a browser_response_body call names.
 *
 * `requestId` is the 1-based position the listing printed, so it addresses one
 * exact request; otherwise `nth` counts over the glob's matches (-1, the
 * default, being the most recent).
 */
function pickNetworkEntry(
  entries: readonly NetworkSummary[],
  args: { urlPattern?: string; requestId?: number; nth?: number },
): NetworkSummary | null {
  if (args.requestId !== undefined) return entries[args.requestId - 1] ?? null;
  if (args.urlPattern === undefined) return null;
  const pattern = args.urlPattern;
  const matches = entries.filter((e) => matchesGlob(e.url, pattern));
  const index = resolveNthIndex(matches.length, args.nth);
  return index < 0 ? null : matches[index];
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
 * Filter and render the {id, url, method, status} summary JSON.
 *
 * `id` lets browser_response_body name one exact request instead of a glob that
 * matched twelve. Identical rows are folded into one carrying `repeated: "xN"`
 * unless `collapse:false` — a page polling one endpoint used to bury every
 * other request in the listing (#1360).
 *
 * Request bodies are never captured, so the only credential that can reach this
 * listing is one a page put in the query string of a GET — which redaction
 * strips from the rendered URL. The glob still matches against the REAL url:
 * filtering is the caller's own pattern, not something the agent reads back.
 */
function formatNetwork(
  entries: Array<{ url: string; method: string; status?: number }>,
  options: {
    filter?: string;
    exclude?: string;
    status?: string;
    method?: string;
    collapse?: boolean;
  },
  window?: CaptureWindow,
): string {
  // `id` is the 1-based position in the CAPTURE buffer, not in the filtered
  // listing: browser_response_body resolves it against the same buffer, so a
  // filter must not renumber the rows out from under a follow-up call.
  const numbered = entries.map((e, i) => ({ ...e, id: i + 1 }));
  const filtered = filterNetwork(numbered, options) as Array<
    { url: string; method: string; status?: number; id: number }
  >;
  const rows: NetworkRow[] = filtered.map((e) => ({
    id: e.id,
    url: redactPasswordParams(e.url),
    method: e.method,
    status: e.status ?? '(pending)',
  }));
  const collapsed = options.collapse === false ? rows : collapseRepeats(rows);
  if (collapsed.length === 0) {
    const detail = describeWindow(window, 'requests');
    return detail ? `No network requests. ${detail}` : 'No network requests collected.';
  }
  const summary = collapsed.map(({ count, ...row }) =>
    count === undefined ? row : { ...row, repeated: `x${count}` },
  );
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
    async ({ format, selector, filter, q, full, cursor, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        // Continuation: the next window of a capture this connection already
        // took. Returns before anything touches the page, which is the whole
        // point — no re-read, no new ref generation, so the refs in this window
        // are still the ones the capture minted and still resolve for
        // browser_click. It is also never diffed: a window of a tree the caller
        // is part-way through is not a new observation to compare, so the diff
        // baseline is neither read nor written here.
        if (cursor) {
          const continued = continueSnapshotCapture(
            cursor,
            undefined,
            scope.surfaceId ? snapshotSurfaceKey(scope.workspaceId, scope.surfaceId) : undefined,
          );
          const ignored = [
            format !== undefined && 'format',
            selector !== undefined && 'selector',
            filter !== undefined && 'filter',
            q !== undefined && 'q',
            full !== undefined && 'full',
          ].filter((name): name is string => typeof name === 'string');
          // Nothing is ignored on an expired cursor — that result is the error.
          const note = continued.isError ? '' : cursorIgnoredNote(ignored);
          return {
            content: [{ type: 'text' as const, text: note + continued.text }],
            ...(continued.isError && { isError: true }),
          };
        }

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
                ...(q && { q }),
                deferTruncation: true,
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
            // Stable numbering (#1355): an element still in the subtree keeps
            // the number the previous listing gave it, so opening a dropdown no
            // longer renumbers every ref the agent is holding.
            const domKey = domListingKey(scope, selector);
            const payload = readDomSnapshotPayload(await evaluate(
              buildDomSnapshotExpression(selector, {
                ...(filter && { filter }),
                stable: { prior: priorRefDescriptors(domKey, 0), nextRef: nextRefFor(domKey, 0) },
                withEntries: true,
              }),
            ));
            // The DOM listing carries the page URL and every link href verbatim,
            // so it gets the same URL redaction the network listing does.
            text = redactPasswordParams(String(payload.text));
            if (payload.entries.length > 0) recordRefGeneration(domKey, 0, payload.entries);
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
            // The DOM listing has no tree to prune, so `q` cannot be honored
            // here. Say so rather than return a full listing that looks filtered.
            if (q) text = `${DOM_LISTING_Q_NOTE}\n${text}`;
          }
        } else if (page) {
          text = await generateSnapshot(page, {
            format: format ?? 'ai',
            ...(filter && { filter }),
            ...(q && { q }),
            // The overflow becomes a continuation capture below rather than
            // being dropped at the 50 000-character budget.
            deferTruncation: true,
          });
        } else {
          // Fallback: extract page structure via RPC evaluation. Tags interactive
          // elements with data-wmux-ref so interaction tools can resolve them.
          // Same expression the page-mode root-only fallthrough runs (snapshot.ts),
          // via the shared buildDomSnapshotExpression() helper — filter honored,
          // aria noted, same as there (#1066).
          const domKey = domListingKey(scope, undefined);
          const result = await sendScopedBrowserRpc<{ value: unknown }>('browser.evaluate', scope, {
            expression: buildDomSnapshotExpression(undefined, {
              ...(filter && { filter }),
              stable: { prior: priorRefDescriptors(domKey, 0), nextRef: nextRefFor(domKey, 0) },
              withEntries: true,
            }),
          });
          const payload = readDomSnapshotPayload(result.value);
          // Same URL redaction as the scoped DOM listing above.
          text = redactPasswordParams(payload.text);
          if (payload.entries.length > 0) recordRefGeneration(domKey, 0, payload.entries);
          if (format === 'aria') {
            text = `(note: aria format unavailable — no live page, returning the DOM interactive listing)\n${text}`;
          }
          if (q) text = `${DOM_LISTING_Q_NOTE}\n${text}`;
        }

        // What this surface's refs are, for the RPC lane's fail-closed guard.
        // Registered here rather than inside generateSnapshot because the scope
        // is a tool-layer fact, and every route that mints refs for a surface —
        // a11y, scoped, DOM listing, RPC — passes through this one handler.
        // A route that mints no frame refs clears the surface, which is what
        // keeps a later DOM snapshot's tags resolvable.
        noteFrameRefsForScope(browserScopeKey(scope), page ?? null);

        // Bound what everything downstream retains. deferTruncation hands back
        // the whole assembled tree, and the aria lane has no interactive strip to
        // shrink it, so without this cut the diff baseline and the repl listing
        // would hold a very large document's tree per surface for the baseline
        // TTL — they used to be bounded at maxLength. The cut leaves a line
        // saying what it dropped, so the last window is honest about it.
        text = capCaptureText(text);

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
        // `q` joins the diff key for the same reason the others are in it: a
        // searched snapshot and a whole one are different renderings, and
        // diffing one against the other would report the unmatched nodes as
        // removals.
        //
        // JSON, not a `|` join: `selector` and `q` are caller text that may
        // contain the separator itself, so the parts run together —
        // `{selector:"a", q:"b||c"}` and `{selector:"a||b", q:"c"}` both spell
        // `a||b||c`. Two different renderings then share one baseline, which is
        // exactly the false "(no changes since previous snapshot)" this key
        // exists to prevent.
        const attrs = JSON.stringify([format ?? 'ai', selector ?? '', filter ?? '', q ?? '', scopeRoute]);
        const baseline = full ? null : getSnapshotBaseline(key, attrs, currentUrl);
        const rendered = formatSnapshotResult(baseline?.text ?? null, text);
        setSnapshotBaseline(key, attrs, text, currentUrl);
        // `text` is the whole tree whatever `rendered` turned out to be; a
        // caller that needs every ref (browser_repl) reads it from here
        // instead of forcing full:true (snapshotListing.ts).
        captureSnapshotListing(text);

        // Truncation, last: the result the agent reads is the unit a cursor
        // walks, so the window is cut after the diff has decided what that
        // result is, at line granularity. A result that fits retires whatever
        // capture this surface had, so a cursor can never outlive the snapshot
        // it described.
        const windowed = windowSnapshotText(key, rendered.text, currentUrl);

        return {
          content: [{ type: 'text' as const, text: windowed }],
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

  /** Read the live viewport in CSS px, so the factor describes THIS image. */
  const readViewport = async (page: Page | null): Promise<Viewport | null> => {
    if (!page) return null;
    // innerWidth/innerHeight are frame properties, not main-world globals, so
    // the isolated world reads the same numbers. viewportSize() is null on
    // every connectOverCDP page, hence the page read rather than the API.
    const size = await evaluateIsolated(page, '[window.innerWidth, window.innerHeight]').catch(
      () => null,
    );
    if (!Array.isArray(size) || typeof size[0] !== 'number' || typeof size[1] !== 'number') {
      return null;
    }
    return size[0] > 0 && size[1] > 0 ? { width: size[0], height: size[1] } : null;
  };

  /** Ladder memo key: the rung is only reused for the same surface shape. */
  const viewportKey = (viewport: Viewport | null): string =>
    viewport ? `${viewport.width}x${viewport.height}` : 'unknown';

  /** Playwright lanes can simply re-capture at the rung's format and scale. */
  const shrinkViaPlaywright = (
    capture: (rung: ShrinkRung) => Promise<Buffer>,
  ): ((rung: ShrinkRung) => Promise<string | null>) =>
    async (rung) => (await capture(rung)).toString('base64');

  /** Assemble the result parts, appending the shrink note when there is one. */
  const imageResult = (fitted: FittedImage, basis: string) => ({
    content: [
      { type: 'image' as const, data: fitted.data, mimeType: fitted.mimeType },
      {
        type: 'text' as const,
        text: fitted.note ? `${basis}\n\n${fitted.note}` : basis,
      },
    ],
  });

  server.tool(
    'browser_screenshot',
    'Screenshot the page or one element as a base64-encoded PNG. Requires browser_open first, even if a browser panel is already visible. A viewport capture states ONE scale (image px per viewport CSS px, device pixel ratio and any downscale already folded in) plus a screenshotScale JSON line: click with browser_click imageX/imageY, or divide by that scale yourself. fullPage and element captures are not in click coordinates at all. CSS animations and transitions are frozen for the capture, so two shots of an unchanged page match.',
    BROWSER_SCREENSHOT_SHAPE,
    async ({ fullPage, ref, surfaceId, maxBytes, refs }) => withAutomationLease(deps, surfaceId, async (scope) => {
      const ceiling = clampScreenshotCeilingBytes(maxBytes);
      /**
       * The refs table for a page capture, measured AFTER the shot so every box
       * describes the page as it now is. Read-only: no overlay, no attribute,
       * nothing written into the page. Rows use the basis the note states —
       * viewport CSS px, or document CSS px for fullPage.
       */
      const refsTable = async (page: Page): Promise<string> => {
        const size = await evaluateIsolated(
          page,
          '[window.innerWidth, window.innerHeight, window.scrollX, window.scrollY, document.documentElement.scrollWidth, document.documentElement.scrollHeight]',
        ).catch(() => null);
        const n = Array.isArray(size) && size.every((v) => typeof v === 'number') ? (size as number[]) : null;
        if (fullPage) {
          // Without the scroll offset and document size a row could only be
          // printed in viewport coordinates under a document-coordinates
          // label, so the table is left out instead.
          if (!n) {
            return 'Ref boxes omitted: the document size and scroll offset could not be read, so document coordinates are unknown.';
          }
          return formatRefBoxTable(
            refBoxCandidates(page),
            { x: 0, y: 0, width: n[4], height: n[5] },
            { offset: { x: n[2], y: n[3] }, basis: 'document CSS px' },
          );
        }
        // viewportSize() is null on every connectOverCDP page; when the page
        // cannot report its size either, the area is unknown and the table
        // says so rather than filtering against a 0x0 box.
        const viewport = page.viewportSize() ?? (n ? { width: n[0], height: n[1] } : null);
        return formatRefBoxTable(
          refBoxCandidates(page),
          viewport ? { x: 0, y: 0, width: viewport.width, height: viewport.height } : null,
          { basis: 'viewport CSS px' },
        );
      };
      try {
        // Chrome backend (dogfood P2): browser.screenshot has no chrome lane —
        // whole-page shots go over the resolved Playwright page instead.
        if (!ref && (await engine.resolveWorkspaceBackend(scope.workspaceId)) === 'chrome') {
          const page = await engine.getPageForScope(scope);
          if (page) {
            // Read the viewport immediately before the capture: a resize
            // between the two would otherwise mislabel the image.
            const viewport = fullPage ? null : await readViewport(page);
            const buf = await page.screenshot({
              ...(fullPage && { fullPage: true }),
              type: 'png',
              ...FROZEN_CAPTURE,
            });
            const scopeKey = browserScopeKey(scope);
            const memoKey = `${scopeKey}|${fullPage ? 'full' : 'viewport'}`;
            const fitted = await fitScreenshot(
              buf.toString('base64'),
              {
                maxBytes: ceiling,
                rememberedScale: recallShrinkRung(memoKey, viewportKey(viewport), ceiling),
              },
              shrinkViaPlaywright((rung) =>
                page.screenshot({
                  ...(fullPage && { fullPage: true }),
                  type: 'jpeg',
                  quality: rung.quality,
                  ...FROZEN_CAPTURE,
                  // Playwright scales the whole capture, so the rung's factor
                  // is exactly the number stated back to the caller.
                  ...(rung.scale < 1 && { scale: 'css' as const }),
                }),
              ),
            );
            rememberShrinkRung(memoKey, viewportKey(viewport), ceiling, fitted.scale);
            // Measured on the bytes that are actually returned, so the one
            // factor already contains the device ratio and the rung above.
            const geometry = fullPage ? null : screenshotGeometry(fitted.data, viewport);
            if (geometry) rememberScreenshotScale(scopeKey, geometry);
            const basis = coordinateBasis(fullPage ? 'fullPage' : 'viewport', geometry);
            return imageResult(fitted, refs ? `${basis}\n\n${await refsTable(page)}` : basis);
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
            const buffer = (await el.screenshot({ ...FROZEN_CAPTURE })) as Buffer;
            const fitted = await fitScreenshot(
              buffer.toString('base64'),
              { maxBytes: ceiling },
              shrinkViaPlaywright((rung) =>
                el.screenshot({ type: 'jpeg', quality: rung.quality, ...FROZEN_CAPTURE }) as Promise<Buffer>,
              ),
            );
            const basis = coordinateBasis('element', null);
            return imageResult(
              fitted,
              refs ? `${basis}\n\nrefs:true lists boxes for page captures only; omit ref.` : basis,
            );
          }
        }

        // Use RPC for fast, reliable screenshots (bypasses Playwright CDP discovery)
        const result = await sendScopedBrowserRpc<{ data: string }>('browser.screenshot', scope, {
          ...(fullPage && { fullPage }),
        });

        // The daemon re-encodes in the main process (nativeImage): it is the
        // only place this lane's pixels exist. A daemon that predates the
        // parameters answers with the same PNG, which fitScreenshot reads as
        // "no knob" and reports honestly instead of refusing.
        const rpcMemoKey = `${browserScopeKey(scope)}|rpc|${fullPage ? 'full' : 'viewport'}`;
        const fitted = await fitScreenshot(
          result.data,
          {
            maxBytes: ceiling,
            // This lane cannot read a viewport, so the rung is remembered under
            // a fixed key: it still stops drifting between calls.
            rememberedScale: recallShrinkRung(rpcMemoKey, 'unknown', ceiling),
          },
          async (rung) => {
            const shrunk = await sendScopedBrowserRpc<{ data: string; mimeType?: string }>(
              'browser.screenshot',
              scope,
              { ...(fullPage && { fullPage }), format: 'jpeg', quality: rung.quality, scale: rung.scale },
            );
            return shrunk.mimeType === 'image/jpeg' ? shrunk.data : null;
          },
        );
        rememberShrinkRung(rpcMemoKey, 'unknown', ceiling, fitted.scale);
        // The RPC lane cannot click by coordinate at all, so telling the
        // caller how to convert pixels here would contradict itself.
        const basis = coordinateBasis(fullPage ? 'fullPage' : 'unsupported', null);
        if (!refs) return imageResult(fitted, basis);
        const onChrome =
          (await engine.resolveWorkspaceBackend(scope.workspaceId).catch(() => undefined)) === 'chrome';
        return imageResult(
          fitted,
          onChrome
            ? `${basis}\n\nrefs:true needs a live page to measure boxes on, and the chrome backend did not provide one for this capture.`
            : `${basis}\n\nrefs:true needs the chrome backend: this lane has no live page to measure boxes on.`,
        );
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

        // Try Playwright first for gesture-aware evaluation. A WRITE: running
        // arbitrary JS in a page is the broadest one there is, and on Live Chrome
        // this lane is the only one that can reach a Chrome tab at all (main's
        // browser.evaluate drives builtin webviews).
        const page = await engine.getPageForScope(scope, { intent: 'write' }).catch(allowScopedRpcFallback);
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
    'Read console messages. Collection starts when the page is opened/attached, not at this call; clear:true resets. A "Failed to load resource" line gets the failing URL appended from the network buffer, which Chrome leaves off the message itself.',
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

        const selected = filterConsole(entries, level);
        // Only when a line actually needs a URL: the extra buffer read is free
        // on the (overwhelmingly common) page that logged no failed resource.
        const network = selected.some((e) => /failed to load resource/i.test(e.text))
          ? await readNetworkEntries(scope).then((r) => r.entries).catch(() => [])
          : [];
        const text = formatConsole(
          attachFailedResourceUrls(selected, network) as ConsoleEntry[],
          window,
        );

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
    'Read network requests. Collection starts when the page is opened/attached, not at this call; clear:true resets. Each row carries an "id" browser_response_body accepts; identical rows fold into one with "repeated":"xN".',
    BROWSER_NETWORK_SHAPE,
    async ({ filter, exclude, status, method, collapse, clear, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const { entries, window } = await readNetworkEntries(scope, clear);

        const text = formatNetwork(
          entries,
          { filter, exclude, status, method, collapse },
          window,
        );

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
    'Response body of a captured network request, by URL glob or by the "id" browser_network printed. With several matches, nth picks one — the last by default, which is the response after the filter change you just made.',
    BROWSER_RESPONSE_BODY_SHAPE,
    async ({ urlPattern, requestId, nth, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        if (urlPattern === undefined && requestId === undefined) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Pass urlPattern (a URL glob) or requestId (the "id" a browser_network row printed).',
              },
            ],
            isError: true,
          };
        }
        const what =
          requestId !== undefined ? `id ${requestId}` : `pattern "${urlPattern}"`;
        const body = await readCapture<string | null>(
          scope,
          async () => {
            // Main's buffer cannot be indexed over RPC, so the id / nth is
            // resolved against the listing first and asked for by exact URL.
            // Same ordering the listing printed, because it is the same read.
            let pattern = urlPattern;
            if (requestId !== undefined || (nth !== undefined && nth !== -1)) {
              const { entries } = await readNetworkEntries(scope);
              const target = pickNetworkEntry(entries, { urlPattern, requestId, nth });
              if (!target) return null;
              pattern = target.url;
            }
            if (pattern === undefined) return null;
            const result = await sendScopedBrowserRpc<{ body: string | null }>('browser.responseBody.get', scope, {
              urlPattern: pattern,
            });
            return result.body ?? null;
          },
          (page) => {
            const state = ensurePageCapture(page);
            if (requestId !== undefined) {
              const entry = state.network[requestId - 1];
              return entry?.response?.body ?? null;
            }
            // Only entries whose body was actually retained can be answered
            // with, so `nth` counts over those and not over every request.
            const withBody = state.network.filter(
              (e) => e.response?.body !== undefined && matchesGlob(e.url, urlPattern!),
            );
            const index = resolveNthIndex(withBody.length, nth);
            return index < 0 ? null : withBody[index].response!.body!;
          },
        );

        if (body === null) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No response body found for ${what}. Ensure the request has been made and the response was captured.`,
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
        // A write: the highlight is two inline styles written into the page.
        const page = await engine.getPageForScope(scope, { intent: 'write' }).catch(allowScopedRpcFallback);

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
