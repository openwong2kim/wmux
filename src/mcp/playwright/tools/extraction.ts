import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import { getSmartSnapshot, getSmartSnapshotViaEval } from '../dom-intelligence';
import { extractMarkdown, extractStructuredData } from '../markdown-extractor';
import { resolveEvaluator, rpcEvaluator } from '../page-eval';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

/**
 * Register extraction-related MCP tools on the given server.
 *
 * Tools:
 *  - browser_smart_snapshot   -- smart snapshot with indexed interactive elements
 *  - browser_extract_text     -- extract page content as clean markdown
 *  - browser_extract_data     -- extract structured data as JSON
 */
export function registerExtractionTools(server: McpServer): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_smart_snapshot
  // -----------------------------------------------------------------------
  server.tool(
    'browser_smart_snapshot',
    'Get a smart snapshot of the page with indexed interactive elements and clean text content. Use element ref numbers with browser_click to interact.',
    {
      maxContentLength: z
        .number()
        .optional()
        .describe('Maximum length of the content summary in characters (default 3000).'),
      surfaceId: optionalSurfaceId,
    },
    async ({ maxContentLength, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        // Playwright path uses the CDP accessibility tree; when no Page is
        // available (packaged builds, issue #105) fall back to a DOM-based
        // snapshot over the RPC channel.
        const page = await engine.getPage(surfaceId).catch(() => null);
        const snapshot = page
          ? await getSmartSnapshot(page, { maxContentLength: maxContentLength ?? 3000 })
          : await getSmartSnapshotViaEval(rpcEvaluator(surfaceId), { maxContentLength: maxContentLength ?? 3000 });

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
        const message = error instanceof Error ? error.message : String(error);
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
    'Extract page content as clean markdown text, stripping navigation and noise.',
    {
      selector: z
        .string()
        .optional()
        .describe('CSS selector to scope extraction to a specific element.'),
      maxLength: z
        .number()
        .optional()
        .describe('Maximum length of the returned markdown in characters.'),
      includeLinks: z
        .boolean()
        .optional()
        .describe('If true, preserve hyperlinks in the markdown output (default false).'),
      surfaceId: optionalSurfaceId,
    },
    async ({ selector, maxLength, includeLinks, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        // resolveEvaluator picks the Playwright page when available, else the
        // RPC channel (packaged builds, issue #105). extract_text's in-page work
        // is a string script, so both transports produce identical output.
        const evaluate = await resolveEvaluator(engine, surfaceId);

        const markdown = await extractMarkdown(evaluate, {
          selector,
          maxLength,
          includeLinks,
        });

        return {
          content: [{ type: 'text' as const, text: markdown }],
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
  // browser_extract_data
  // -----------------------------------------------------------------------
  server.tool(
    'browser_extract_data',
    'Extract structured data from the page (tables, lists, repeated items) as JSON.',
    {
      goal: z
        .string()
        .describe('Description of what data to extract (e.g. "product list", "search results").'),
      fields: z
        .record(z.string(), z.string())
        .describe('Map of field names to their expected types (e.g. { name: "string", price: "number", url: "string" }).'),
      surfaceId: optionalSurfaceId,
    },
    async ({ goal, fields, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        // Native page.evaluate(fn, arg) when a Page exists (unchanged dev path);
        // RPC fallback when not (packaged builds, issue #105).
        const page = await engine.getPage(surfaceId).catch(() => null);

        const records = await extractStructuredData(page, surfaceId, goal, fields);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(records, null, 2),
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
}
