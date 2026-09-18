import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import { getSmartSnapshot, getSmartSnapshotViaEval, smartPageToken } from '../dom-intelligence';
import { extractMarkdown, extractStructuredDataWithNotes } from '../markdown-extractor';
import { resolveEvaluator, rpcEvaluator } from '../page-eval';
import { formatSnapshotResult } from '../snapshotDiff';
import { getSnapshotBaseline, setSnapshotBaseline, snapshotSurfaceKey } from '../snapshotCache';
import {
  capCaptureText,
  continueSnapshotCapture,
  cursorIgnoredNote,
  windowBudgetForMaxBytes,
  windowSnapshotText,
} from '../snapshotCursor';
import { captureSnapshotListing } from '../snapshotListing';
import { allowScopedRpcFallback, type BrowserToolDeps } from '../browserScope';
import { describeToolError } from '../toolError';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Omit for the surface you opened last.');

// Per-call text-result cap, honoured by the dispatch-layer guard
// (src/mcp/resultCap.ts) on tools whose output size the caller does not
// directly control. Plain z.number(): the guard floors and clamps the value
// itself (every zod numeric modifier costs bytes in tools/list).
const maxBytesParam = z
  .number()
  .optional()
  .describe('Cap the text result in bytes (default 65536, max 524288).');

// Upper bounds for the caller-set extraction sizes. Clamped in the handlers,
// not the schema, so an over-limit request is served at the ceiling rather
// than rejected. maxContentLength matches the diff-baseline cost of one
// listing; maxLength matches the 512 KiB result cap the guard can enforce.
const MAX_SMART_CONTENT_CHARS = 100_000;
const MAX_EXTRACT_TEXT_CHARS = 524_288;

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.
const BROWSER_SMART_SNAPSHOT_SHAPE = {
  maxContentLength: z
    .number()
    .optional()
    .describe('Content summary cap in characters (default 3000, max 100000).'),
  full: z.boolean().optional().describe('Force the complete tree instead of a diff.'),
  cursor: z
    .string()
    .optional()
    .describe(
      'Continuation token from a truncated snapshot: returns the next lines of that same capture without re-reading the page (refs stay valid). Other parameters are ignored with a cursor.',
    ),
  surfaceId: optionalSurfaceId,
  maxBytes: maxBytesParam,
};

const BROWSER_EXTRACT_TEXT_SHAPE = {
  selector: z
    .string()
    .optional()
    .describe('Scope extraction to this element.'),
  maxLength: z
    .number()
    .optional()
    .describe('Character cap on the markdown (max 524288).'),
  includeLinks: z
    .boolean()
    .optional()
    .describe('Preserve hyperlinks (default false).'),
  surfaceId: optionalSurfaceId,
  maxBytes: maxBytesParam,
};

const BROWSER_EXTRACT_DATA_SHAPE = {
  goal: z
    .string()
    .describe('What to extract, e.g. "product list".'),
  fields: z
    .record(z.string(), z.string())
    .describe('Field name to expected type, e.g. { name: "string", price: "number" }.'),
  surfaceId: optionalSurfaceId,
  maxBytes: maxBytesParam,
};

/**
 * Register extraction-related MCP tools on the given server.
 *
 * Tools:
 *  - browser_smart_snapshot   -- smart snapshot with indexed interactive elements
 *  - browser_extract_text     -- extract page content as clean markdown
 *  - browser_extract_data     -- extract structured data as JSON
 */
export function registerExtractionTools(server: McpServer, deps: BrowserToolDeps): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_smart_snapshot
  // -----------------------------------------------------------------------
  server.tool(
    'browser_smart_snapshot',
    'Indexed interactive elements plus clean page text. Pass a returned ref to browser_click as smartRef. On the chrome backend a repeat call returns a diff (full:true forces the whole listing); the packaged RPC lane numbers refs by position, so it returns the full listing every time and says so.',
    BROWSER_SMART_SNAPSHOT_SHAPE,
    async ({ maxContentLength, full, cursor, maxBytes, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        // This tool declares maxBytes, so its windows are sized to the ceiling
        // the CALLER asked for rather than the default — raising maxBytes buys
        // bigger windows instead of being silently overridden by a fixed one.
        const budget = windowBudgetForMaxBytes(maxBytes);
        // Continuation: the next window of a capture already stored for this
        // surface, served before anything touches the page. No re-read means no
        // new smart-ref numbering, so the refs in this window are the ones the
        // capture listed and browser_click({smartRef}) still resolves them. Not
        // diffed either — the baseline is neither read nor written here.
        if (cursor) {
          const continued = continueSnapshotCapture(cursor, budget);
          const ignored = [
            maxContentLength !== undefined && 'maxContentLength',
            full !== undefined && 'full',
          ].filter((name): name is string => typeof name === 'string');
          const note = continued.isError ? '' : cursorIgnoredNote(ignored);
          return {
            content: [{ type: 'text' as const, text: note + continued.text }],
            ...(continued.isError && { isError: true }),
          };
        }

        // Playwright path uses the CDP accessibility tree; when no Page is
        // available (packaged builds, issue #105) fall back to a DOM-based
        // snapshot over the RPC channel.
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);
        // Clamp, not reject: an over-limit cap is served at the ceiling.
        const capLength = Math.min(maxContentLength ?? 3000, MAX_SMART_CONTENT_CHARS);
        const snapshot = page
          ? await getSmartSnapshot(page, { maxContentLength: capLength, surfaceId: scope.surfaceId })
          : await getSmartSnapshotViaEval(rpcEvaluator(scope), {
              maxContentLength: capLength,
              surfaceId: scope.surfaceId,
            });

        // Format the snapshot output: indexed elements + content summary
        const lines: string[] = [];

        lines.push(`Page: ${snapshot.title ?? snapshot.url}`);
        lines.push('');

        if (snapshot.elements && snapshot.elements.length > 0) {
          lines.push('Interactive Elements:');
          for (const el of snapshot.elements) {
            lines.push(`  [${el.ref}] ${el.role} "${el.name}"${el.description ? ` - ${el.description}` : ''}`);
          }
          lines.push('');
        }

        if (snapshot.content) {
          lines.push('Page Content:');
          lines.push(snapshot.content);
        }

        // Bound what the diff baseline and the repl listing retain, the same cut
        // browser_snapshot makes, leaving a line naming what it dropped.
        const text = capCaptureText(lines.join('\n'));

        // Auto-diff, same machinery and same 50%/800-line fallback as
        // browser_snapshot (snapshotDiff.ts): a repeat call with the same
        // attributes on the same URL returns only what moved, and the first
        // line always declares which of the two it is.
        //
        // Only the CDP lane may diff. The RPC lane still numbers refs by walk
        // position (see getSmartSnapshotViaEval), so a single insertion
        // renumbers the whole listing and a "diff" there is noise dressed up
        // as a saving. It still writes its baseline: the contract is a diff
        // against the last listing this tool returned, whichever lane produced
        // it.
        //
        // The attrs key carries the lane and, on the CDP lane, the page token
        // (review 5 and 7 and 4). The lane, because the two number their refs
        // differently and a positional listing is not a baseline an identity
        // listing may be diffed against. The token, because one surface key
        // covers every tab on that surface and survives a reload — and neither
        // a second tab on the same URL nor a fresh document is something the
        // URL guard alone can see, so both would have been answered with
        // "(no changes since previous snapshot)" about a page never compared.
        const key = snapshotSurfaceKey(scope.workspaceId, scope.surfaceId, 'smart');
        const attrs = page
          ? `smart|cdp|${smartPageToken(page)}|${capLength}`
          : `smart|rpc|${capLength}`;
        const baseline =
          full || !page ? null : getSnapshotBaseline(key, attrs, snapshot.url || undefined);
        const rendered = formatSnapshotResult(baseline?.text ?? null, text);
        setSnapshotBaseline(key, attrs, text, snapshot.url || undefined);
        // The complete listing, for a caller that needs every ref even when
        // it is handed a diff (snapshotListing.ts).
        captureSnapshotListing(text);

        const notes: string[] = [];
        // The content summary is cut at maxContentLength, so a diff — "(no
        // changes)" most of all — speaks only for what fits (review 10).
        const truncated = snapshot.content.endsWith('... (truncated)');
        if (rendered.usedDiff && truncated) {
          notes.push(`(page text is capped at ${capLength} characters; anything past the cut is not compared)`);
        }
        // #1360: "a repeat call returns a diff" is true only where refs are
        // keyed on DOM identity. On this lane they are positional, so the tool
        // silently returned the full tree every time and looked broken. Say
        // which it is instead of leaving the caller to infer it.
        if (!page && !full) {
          notes.push('(no diff on this backend: refs here are numbered by walk position, so a single insertion renumbers the listing and a diff would be noise. The chrome backend diffs.)');
        }

        // The caveats go directly UNDER the header line rather than at the end.
        // The header's contract is to be the first line, but a windowed result's
        // tail only reaches the LAST window — and "(page text is capped…)" is
        // exactly what the agent needs while reading the first one.
        const [header, ...body] = rendered.text.split('\n');
        const annotated = [header, ...notes, ...body].join('\n');

        // Truncation, last: the listing plus its notes is what the agent reads,
        // so that is the text a cursor walks. Keyed on the BARE surface key, not
        // the tool-namespaced diff key — a capture is one frozen view of a
        // surface, and the next snapshot of it from either tool retires this one.
        const captureKey = snapshotSurfaceKey(scope.workspaceId, scope.surfaceId);
        const windowed = windowSnapshotText(
          captureKey,
          annotated,
          snapshot.url || undefined,
          budget,
        );

        return {
          content: [{ type: 'text' as const, text: windowed }],
        };
      } catch (error) {
        const message = describeToolError(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    }),
  );

  // -----------------------------------------------------------------------
  // browser_extract_text
  // -----------------------------------------------------------------------
  server.tool(
    'browser_extract_text',
    'Extract page content as clean markdown, stripping navigation and noise. Link URLs are dropped and only the anchor text is kept — pass includeLinks:true when you need the hrefs.',
    BROWSER_EXTRACT_TEXT_SHAPE,
    async ({ selector, maxLength, includeLinks, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        // resolveEvaluator picks the Playwright page when available, else the
        // RPC channel (packaged builds, issue #105). extract_text's in-page work
        // is a string script, so both transports produce identical output.
        const evaluate = await resolveEvaluator(engine, scope);

        // Clamp, not reject: an over-limit cap is served at the ceiling.
        const maxLengthClamped = maxLength === undefined ? undefined : Math.min(maxLength, MAX_EXTRACT_TEXT_CHARS);
        const markdown = await extractMarkdown(evaluate, {
          selector,
          maxLength: maxLengthClamped,
          includeLinks,
        });

        return {
          content: [{ type: 'text' as const, text: markdown }],
        };
      } catch (error) {
        const message = describeToolError(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    }),
  );

  // -----------------------------------------------------------------------
  // browser_extract_data
  // -----------------------------------------------------------------------
  server.tool(
    'browser_extract_data',
    'Extract structured data from the page (tables, lists, repeated items) as JSON.',
    BROWSER_EXTRACT_DATA_SHAPE,
    async ({ goal, fields, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        // Native page.evaluate(fn, arg) when a Page exists (unchanged dev path);
        // RPC fallback when not (packaged builds, issue #105).
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        const { records, notes } = await extractStructuredDataWithNotes(page, scope, goal, fields);

        // Caveats ride along after the JSON, the same way browser_snapshot
        // appends its truncation note (issue #1353): a positional column guess
        // or a one-field-only mapping is still a result, but the agent has to
        // know it is a guess.
        const note = notes.length > 0 ? `\n\n(${notes.join('; ')})` : '';

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(records, null, 2) + note,
            },
          ],
        };
      } catch (error) {
        const message = describeToolError(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    }),
  );
}
