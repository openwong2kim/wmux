import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import { resolveRef } from '../snapshot';
import { getWmuxDir } from '../../../daemon/config';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.
const BROWSER_FILE_UPLOAD_SHAPE = {
  paths: z
    .array(z.string())
    .describe('Array of file paths to upload. Each path must resolve under ~/.wmux/uploads/.'),
  ref: z
    .string()
    .optional()
    .describe('Ref number of the file input element (from browser_snapshot).'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_DOWNLOAD_SHAPE = {
  ref: z
    .string()
    .describe('Ref number of the element to click to trigger the download.'),
  filename: z
    .string()
    .optional()
    .describe('Optional filename to save the download as.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_WAIT_FOR_DOWNLOAD_SHAPE = {
  filename: z
    .string()
    .optional()
    .describe('Expected filename to match against the download.'),
  timeout: z
    .number()
    .optional()
    .describe('Maximum wait time in milliseconds. Defaults to 30000.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_DIALOG_SHAPE = {
  accept: z
    .boolean()
    .describe('Whether to accept (true) or dismiss (false) the dialog.'),
  text: z
    .string()
    .optional()
    .describe('Text to enter in a prompt dialog before accepting.'),
  surfaceId: optionalSurfaceId,
};

// ---------------------------------------------------------------------------
// Upload sandbox: restrict browser_file_upload to ~/.wmux/uploads
// ---------------------------------------------------------------------------

function getUploadRoot(): string {
  const root = path.join(getWmuxDir(), 'uploads');
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

function validateUploadPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('browser_file_upload blocked: empty path');
  }
  const root = getUploadRoot();
  const abs = path.resolve(input);
  let resolved = abs;
  try {
    if (fs.existsSync(abs)) resolved = fs.realpathSync(abs);
  } catch {
    // fall through with abs; the relative check below will still catch traversal
  }
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `browser_file_upload blocked: "${input}" is outside the allowed upload root (${root}). ` +
      `Move the file under ~/.wmux/uploads/ before uploading.`,
    );
  }
  return resolved;
}

/**
 * Register file-related MCP tools on the given server.
 *
 * Tools:
 *  - browser_file_upload        — upload files to a file input (sandboxed to ~/.wmux/uploads)
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
    'Upload files to a file input element. Paths MUST live under ~/.wmux/uploads/ — arbitrary filesystem paths are rejected to prevent exfiltration of credentials or SSH keys via malicious pages.',
    BROWSER_FILE_UPLOAD_SHAPE,
    async ({ paths, ref, surfaceId }) => withAutomationLease(surfaceId, async () => {
      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const safePaths = paths.map(validateUploadPath);

        if (ref) {
          const el = await resolveRef(page, ref);
          if (!el) {
            throw new Error(`Could not resolve ref="${ref}" to an element.`);
          }
          await el.setInputFiles(safePaths);
        } else {
          // Find the first file input on the page
          const fileInput = await page.$('input[type="file"]');
          if (!fileInput) {
            throw new Error('No file input element found on the page.');
          }
          await fileInput.setInputFiles(safePaths);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Uploaded ${safePaths.length} file(s) from ~/.wmux/uploads/`,
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
  // browser_download
  // -----------------------------------------------------------------------
  server.tool(
    'browser_download',
    'Click an element (identified by ref) and capture the resulting download. Returns the downloaded file path.',
    BROWSER_DOWNLOAD_SHAPE,
    async ({ ref, filename, surfaceId }) => withAutomationLease(surfaceId, async () => {
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
          const pathMod = await import('path');
          const os = await import('os');
          // path.basename strips any directory components — a malicious
          // page could otherwise pass `../../etc/passwd` and overwrite
          // arbitrary files via download.saveAs which doesn't sanitize.
          const safeName = pathMod.basename(filename);
          if (!safeName || safeName === '.' || safeName === '..') {
            throw new Error('filename must be a non-empty plain file name');
          }
          const savePath = pathMod.join(os.tmpdir(), safeName);
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
    }),
  );

  // -----------------------------------------------------------------------
  // browser_wait_for_download
  // -----------------------------------------------------------------------
  server.tool(
    'browser_wait_for_download',
    'Wait for a download event on the page. Optionally filter by filename.',
    BROWSER_WAIT_FOR_DOWNLOAD_SHAPE,
    async ({ filename, timeout, surfaceId }) => withAutomationLease(surfaceId, async () => {
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
    }),
  );

  // -----------------------------------------------------------------------
  // browser_dialog
  // -----------------------------------------------------------------------
  server.tool(
    'browser_dialog',
    'Pre-register a handler for the next browser dialog (alert, confirm, prompt, beforeunload). The handler will automatically accept or dismiss the dialog when it appears.',
    BROWSER_DIALOG_SHAPE,
    async ({ accept, text, surfaceId }) => withAutomationLease(surfaceId, async () => {
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
    }),
  );
}
