import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import { PlaywrightEngine } from '../PlaywrightEngine';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

/**
 * Register utility MCP tools on the given server.
 *
 * Tools:
 *  - browser_pdf   — export the current page as a PDF
 *  - browser_trace — start or stop Playwright tracing
 */
export function registerUtilityTools(server: McpServer): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_pdf
  // -----------------------------------------------------------------------
  server.tool(
    'browser_pdf',
    'Export the current page as a PDF file. Falls back to CDP Page.printToPDF when Playwright pdf() is unavailable (e.g. CDP-connected browsers).',
    {
      path: z
        .string()
        .optional()
        .describe('Output file path for the PDF. Defaults to "output.pdf".'),
      surfaceId: optionalSurfaceId,
    },
    async ({ path: outputPath, surfaceId }) => {
      const resolvedPath = outputPath ?? 'output.pdf';

      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        try {
          // Try Playwright's built-in pdf() first
          await page.pdf({ path: resolvedPath, format: 'A4' });
          return {
            content: [
              {
                type: 'text' as const,
                text: `PDF saved to ${resolvedPath}`,
              },
            ],
          };
        } catch {
          // Fallback: use CDP Page.printToPDF directly
          const client = await page.context().newCDPSession(page);
          try {
            const result = await client.send('Page.printToPDF', {
              landscape: false,
              printBackground: true,
            });

            const pdfData = (result as { data: string }).data;

            // Write the base64 data to file
            fs.writeFileSync(resolvedPath, Buffer.from(pdfData, 'base64'));

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `PDF saved to ${resolvedPath} (via CDP)`,
                },
              ],
            };
          } finally {
            await client.detach().catch(() => {
              /* best-effort */
            });
          }
        }
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
  // browser_trace
  // -----------------------------------------------------------------------
  server.tool(
    'browser_trace',
    'Start or stop Playwright tracing. Use "start" to begin recording and "stop" to save the trace file.',
    {
      action: z
        .enum(['start', 'stop'])
        .describe('Whether to start or stop tracing.'),
      path: z
        .string()
        .optional()
        .describe('Output file path for the trace (used with "stop"). Defaults to "trace.zip".'),
      surfaceId: optionalSurfaceId,
    },
    async ({ action, path: outputPath, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const context = page.context();

        if (action === 'start') {
          await context.tracing.start({ screenshots: true, snapshots: true });
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Tracing started. Call browser_trace with action "stop" to save the trace.',
              },
            ],
          };
        }

        // action === 'stop'
        const resolvedPath = outputPath ?? 'trace.zip';
        await context.tracing.stop({ path: resolvedPath });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Trace saved to ${resolvedPath}`,
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
}
