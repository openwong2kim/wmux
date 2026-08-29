import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import { getSmartSnapshot, getSmartSnapshotViaEval } from '../dom-intelligence';
import { extractMarkdown, extractStructuredData } from '../markdown-extractor';
import { resolveEvaluator, rpcEvaluator } from '../page-eval';
import { allowScopedRpcFallback, type BrowserToolDeps } from '../browserScope';
import { describeToolError } from '../toolError';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Omit for the active surface.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.
const BROWSER_SMART_SNAPSHOT_SHAPE = {
  maxContentLength: z
    .number()
    .optional()
    .describe('Content summary cap in characters (default 3000).'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_EXTRACT_TEXT_SHAPE = {
  selector: z
    .string()
    .optional()
    .describe('Scope extraction to this element.'),
  maxLength: z
    .number()
    .optional()
    .describe('Character cap on the markdown.'),
  includeLinks: z
    .boolean()
    .optional()
    .describe('Preserve hyperlinks (default false).'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_EXTRACT_DATA_SHAPE = {
  goal: z
    .string()
    .describe('What to extract, e.g. "product list".'),
  fields: z
    .record(z.string(), z.string())
    .describe('Field name to expected type, e.g. { name: "string", price: "number" }.'),
  surfaceId: optionalSurfaceId,
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
    'Indexed interactive elements plus clean page text. Pass a returned ref to browser_click as smartRef.',
    BROWSER_SMART_SNAPSHOT_SHAPE,
    async ({ maxContentLength, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        // Playwright path uses the CDP accessibility tree; when no Page is
        // available (packaged builds, issue #105) fall back to a DOM-based
        // snapshot over the RPC channel.
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);
        const snapshot = page
          ? await getSmartSnapshot(page, { maxContentLength: maxContentLength ?? 3000 })
          : await getSmartSnapshotViaEval(rpcEvaluator(scope), { maxContentLength: maxContentLength ?? 3000 });

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

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
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
    'Extract page content as clean markdown, stripping navigation and noise.',
    BROWSER_EXTRACT_TEXT_SHAPE,
    async ({ selector, maxLength, includeLinks, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        // resolveEvaluator picks the Playwright page when available, else the
        // RPC channel (packaged builds, issue #105). extract_text's in-page work
        // is a string script, so both transports produce identical output.
        const evaluate = await resolveEvaluator(engine, scope);

        const markdown = await extractMarkdown(evaluate, {
          selector,
          maxLength,
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

        const records = await extractStructuredData(page, scope, goal, fields);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(records, null, 2),
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
