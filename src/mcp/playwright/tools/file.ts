import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { resolveRef } from '../snapshot';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

/**
 * Register file-related MCP tools on the given server.
 *
 * Tools:
 *  - browser_file_upload        — upload files to a file input
 *  - browser_download           — click an element and capture the download
 *  - browser_wait_for_download  — wait for a download event
 *  - browser_dialog             — pre-register a dialog accept/dismiss handler
 */
export function registerFileTools(server: McpServer): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_file_upload
  // -----------------------------------------------------------------------
  server.tool(
    'browser_file_upload',
    'Upload files to a file input element. Specify a ref to target a specific input, or omit to use the first file input on the page.',
    {
      paths: z
        .array(z.string())
        .describe('Array of absolute file paths to upload.'),
      ref: z
        .string()
        .optional()
        .describe('Ref number of the file input element (from browser_snapshot).'),
      surfaceId: optionalSurfaceId,
    },
    async ({ paths, ref, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        if (ref) {
          const el = await resolveRef(page, ref);
          if (!el) {
            throw new Error(`Could not resolve ref="${ref}" to an element.`);
          }
          await el.setInputFiles(paths);
        } else {
          // Find the first file input on the page
          const fileInput = await page.$('input[type="file"]');
          if (!fileInput) {
            throw new Error('No file input element found on the page.');
          }
          await fileInput.setInputFiles(paths);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Uploaded ${paths.length} file(s)`,
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
  // browser_download
  // -----------------------------------------------------------------------
  server.tool(
    'browser_download',
    'Click an element (identified by ref) and capture the resulting download. Returns the downloaded file path.',
    {
      ref: z
        .string()
        .describe('Ref number of the element to click to trigger the download.'),
      filename: z
        .string()
        .optional()
        .describe('Optional filename to save the download as.'),
      surfaceId: optionalSurfaceId,
    },
    async ({ ref, filename, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const el = await resolveRef(page, ref);
        if (!el) {
          throw new Error(`Could not resolve ref="${ref}" to an element.`);
        }

        // Start waiting for download before clicking
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          el.click(),
        ]);

        let filePath: string;
        if (filename) {
          const path = await import('path');
          const os = await import('os');
          const savePath = path.join(os.tmpdir(), filename);
          await download.saveAs(savePath);
          filePath = savePath;
        } else {
          const downloadPath = await download.path();
          filePath = downloadPath ?? download.suggestedFilename();
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Downloaded: ${filePath}`,
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
  // browser_wait_for_download
  // -----------------------------------------------------------------------
  server.tool(
    'browser_wait_for_download',
    'Wait for a download event on the page. Optionally filter by filename.',
    {
      filename: z
        .string()
        .optional()
        .describe('Expected filename to match against the download.'),
      timeout: z
        .number()
        .optional()
        .describe('Maximum wait time in milliseconds. Defaults to 30000.'),
      surfaceId: optionalSurfaceId,
    },
    async ({ filename, timeout, surfaceId }) => {
      const resolvedTimeout = timeout ?? 30000;

      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const download = await page.waitForEvent('download', {
          timeout: resolvedTimeout,
        });

        const suggestedName = download.suggestedFilename();

        if (filename && suggestedName !== filename) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Download received but filename mismatch: expected "${filename}", got "${suggestedName}"`,
              },
            ],
            isError: true,
          };
        }

        const downloadPath = await download.path();

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  suggestedFilename: suggestedName,
                  url: download.url(),
                  path: downloadPath ?? '(pending)',
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Timeout') || message.includes('timeout')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Timed out after ${resolvedTimeout}ms waiting for download`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  );

  // -----------------------------------------------------------------------
  // browser_dialog
  // -----------------------------------------------------------------------
  server.tool(
    'browser_dialog',
    'Pre-register a handler for the next browser dialog (alert, confirm, prompt, beforeunload). The handler will automatically accept or dismiss the dialog when it appears.',
    {
      accept: z
        .boolean()
        .describe('Whether to accept (true) or dismiss (false) the dialog.'),
      text: z
        .string()
        .optional()
        .describe('Text to enter in a prompt dialog before accepting.'),
      surfaceId: optionalSurfaceId,
    },
    async ({ accept, text, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        page.once('dialog', async (dialog) => {
          if (accept) {
            await dialog.accept(text);
          } else {
            await dialog.dismiss();
          }
        });

        const action = accept ? 'accepted' : 'dismissed';
        return {
          content: [
            {
              type: 'text' as const,
              text: `Dialog handler set. Next dialog will be ${action}.`,
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
