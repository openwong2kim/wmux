import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

function getExportRoot(): string {
  const root = path.join(os.homedir(), '.wmux', 'exports');
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  // Resolve symlinks so a malicious symlink at the root itself can't
  // redirect writes elsewhere. realpath only works on existing paths,
  // hence the mkdirSync above.
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

export function resolveBrowserExportPath(requestedPath: string | undefined, defaultFileName: string): string {
  const exportRoot = getExportRoot();
  const candidate = requestedPath?.trim() || defaultFileName;
  if (path.isAbsolute(candidate)) {
    throw new Error(`Absolute output paths are not allowed. Use a relative path under ${exportRoot}`);
  }

  const resolved = path.resolve(exportRoot, candidate);
  const relative = path.relative(exportRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Output path escapes the export root. Use a relative path under ${exportRoot}`);
  }

  // Walk up the resolved path looking for any existing component that
  // resolves (via realpath) outside the export root — catches symlinks
  // planted at intermediate directories. A non-existent leaf is fine; we
  // only care about already-materialised filesystem entries. Without
  // this, an attacker who can write a symlink under ~/.wmux/exports/
  // could redirect a `browser_pdf` write to anywhere on disk.
  let probe = resolved;
  while (probe !== exportRoot && probe !== path.dirname(probe)) {
    if (fs.existsSync(probe)) {
      try {
        const real = fs.realpathSync(probe);
        const realRel = path.relative(exportRoot, real);
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
          throw new Error(`Output path escapes the export root via symlink at ${probe}`);
        }
        break;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Output path escapes')) throw err;
        // realpath failure on an existing entry — fall through, the
        // string-level check above already passed.
        break;
      }
    }
    probe = path.dirname(probe);
  }

  return resolved;
}

async function ensureExportDir(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

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
        .describe('Relative output path under ~/.wmux/exports. Defaults to "output.pdf".'),
      surfaceId: optionalSurfaceId,
    },
    async ({ path: outputPath, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        const resolvedPath = resolveBrowserExportPath(outputPath, 'output.pdf');
        await ensureExportDir(resolvedPath);
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
    }),
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
        .describe('Relative output path under ~/.wmux/exports (used with "stop"). Defaults to "trace.zip".'),
      surfaceId: optionalSurfaceId,
    },
    async ({ action, path: outputPath, surfaceId }) => withAutomationLease(surfaceId, async () => {
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
        const resolvedPath = resolveBrowserExportPath(outputPath, 'trace.zip');
        await ensureExportDir(resolvedPath);
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
    }),
  );
}
