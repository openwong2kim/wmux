import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from 'playwright-core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import type { BrowserToolDeps } from '../browserScope';
import { resolveRef } from '../snapshot';
import { describeToolError } from '../toolError';
import { getWmuxDir } from '../../../daemon/config';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Omit for the active surface.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.
const BROWSER_FILE_UPLOAD_SHAPE = {
  paths: z
    .array(z.string())
    .describe('Each path must resolve under the uploads root (~/.wmux/uploads/).'),
  selector: z
    .string()
    .optional()
    .describe('CSS selector of the file input; default the page\'s first one.'),
  ref: z
    .string()
    .optional()
    .describe('Ref of a file input. Prefer selector — a ref takes the 50MB-capped path.'),
  timeout: z
    .number()
    .optional()
    .describe('Milliseconds, ref path only; default 120000.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_DOWNLOAD_SHAPE = {
  ref: z
    .string()
    .describe('Element that triggers the download.'),
  filename: z
    .string()
    .optional()
    .describe('Save the download as this name.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_WAIT_FOR_DOWNLOAD_SHAPE = {
  filename: z
    .string()
    .optional()
    .describe('Expected filename.'),
  timeout: z
    .number()
    .optional()
    .describe('Milliseconds; default 30000.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_DIALOG_SHAPE = {
  accept: z
    .boolean()
    .describe('true accepts, false dismisses.'),
  text: z
    .string()
    .optional()
    .describe('Text for a prompt dialog.'),
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

/**
 * The one gate on what a page may be handed, and the reason it is unchanged by
 * the CDP route below.
 *
 * The route changed from "Node reads the bytes and streams them" to "Chrome
 * opens the path itself", which sounds like it widens the blast radius and does
 * not: Chrome runs as the same user and could always read anything this process
 * could. What matters is that the string handed to the browser is the one this
 * function RETURNED — the realpath'd, root-checked value — and never the
 * caller's raw input. Both call sites below use `safePaths` only.
 *
 * Four ways out of the root, and what stops each:
 *  - `..` segments — path.resolve() normalises them before any check.
 *  - a symlink/junction inside the root pointing out of it — realpathSync()
 *    resolves it, so the relative check runs against the true target.
 *  - another drive or a UNC share (`E:\x`, `\\host\share\x`) — path.relative()
 *    then returns an absolute path, which path.isAbsolute() rejects.
 *  - a path that does not exist, where realpath cannot run: it stays lexical,
 *    but a path Chrome cannot open is a path Chrome cannot leak. fs.existsSync
 *    resolves links exactly as the browser would, so "exists" and "openable"
 *    are the same question here.
 *
 * The residue is TOCTOU — swapping the file for a symlink between this check
 * and the upload — which needs write access to the uploads root and is no wider
 * than it was when Playwright did the reading.
 */
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
      `Move the file under that root before uploading.`,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Upload transport: hand Chrome the path, not the bytes
// ---------------------------------------------------------------------------

/** The default file input — the page's first one, as before `selector` existed. */
const DEFAULT_FILE_INPUT_SELECTOR = 'input[type="file"]';

/**
 * Fallback wall-clock for the ref path. Nothing legitimate can reach it: that
 * path is capped at 50MB by Playwright (see uploadViaCdp) and measured transfer
 * runs ~0.77 s/MB, so a maximal 50MB upload lands near 39 s. It exists to stop
 * a wedged renderer hanging the tool, not to bound normal work — which is the
 * opposite of the 30 s default it replaces, a limit real uploads DID reach.
 */
const REF_UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Set a file input's files over CDP, by path.
 *
 * Why this exists: Playwright's `setInputFiles` decides that a browser reached
 * through `connectOverCDP` is "not co-located" with the client and therefore
 * ships the file's CONTENTS over the protocol — which it refuses to do past
 * 50MB ("Cannot transfer files larger than 50Mb to a browser not co-located
 * with the Playwright client"). Measured: 49MB uploads, 50MB is refused. Every
 * video worth uploading is bigger than that, so the whole tool was unusable for
 * the one job it exists for.
 *
 * The premise behind that refusal does not hold here. wmux only ever attaches
 * to a browser on THIS machine — `http://localhost:<port>` for a dedicated or
 * Electron instance, `ws://127.0.0.1:<port>` for a live-Chrome attach (see
 * PlaywrightEngine.connect and LiveChromeClient) — so the browser can simply
 * open the file itself. `DOM.setFileInputFiles` passes the path and nothing
 * else, which makes the transfer free and the size limit disappear.
 *
 * If wmux ever attaches to a browser on another host, this route becomes wrong
 * (the path would resolve over there) and must be gated on the endpoint being
 * loopback. Nothing in the engine can produce such an endpoint today.
 *
 * Returns false when the CDP route is unavailable or the selector matches
 * nothing, so the caller can fall back rather than fail the upload outright.
 * A `DOM.setFileInputFiles` rejection is NOT swallowed: the element was found
 * and the browser refused it, which the caller must report, not retry.
 */
async function uploadViaCdp(
  page: Page,
  selector: string,
  files: string[],
): Promise<boolean> {
  const client = await page.context().newCDPSession(page).catch(() => null);
  if (!client) return false;
  try {
    let nodeId: number | undefined;
    try {
      const doc = (await client.send('DOM.getDocument', { depth: 0 })) as {
        root?: { nodeId?: number };
      };
      if (!doc?.root?.nodeId) return false;
      const found = (await client.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector,
      })) as { nodeId?: number };
      // CDP reports "no match" as nodeId 0, and throws on an invalid selector.
      // Both mean "this route cannot serve the call" — the DOM fallback owns
      // the user-facing "no file input" / bad-selector error.
      nodeId = found?.nodeId || undefined;
    } catch {
      return false;
    }
    if (nodeId === undefined) return false;

    await client.send('DOM.setFileInputFiles', { files, nodeId });
    return true;
  } finally {
    await client.detach().catch(() => { /* best-effort */ });
  }
}

/**
 * Say out loud that a timed-out upload may have landed anyway.
 *
 * This is the failure mode the timeout above exists to prevent, and it was
 * measured, not imagined: a 45MB file reported "Timeout 30000ms exceeded" while
 * the page's change event had already fired with the full 47,185,920 bytes. An
 * agent reading only "Timeout" retries — and on a real uploader a retry is a
 * SECOND upload, i.e. a duplicate post. The tool cannot tell the two apart from
 * here, so it says so instead of implying a clean failure.
 */
function decorateUploadTimeout(message: string): string {
  if (!/timeout/i.test(message)) return message;
  return (
    `${message} The file may have reached the page anyway — the renderer can ` +
    `finish the transfer after this call gives up. Check the page before ` +
    `retrying; a blind retry can upload the same file twice.`
  );
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
export function registerFileTools(server: McpServer, deps: BrowserToolDeps): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_file_upload
  // -----------------------------------------------------------------------
  server.tool(
    'browser_file_upload',
    'Upload files to a file input, by default the page\'s first one — pass selector to pick another. Paths MUST live under the uploads root (~/.wmux/uploads/, instance suffix applied); anything else is rejected so a malicious page cannot exfiltrate credentials or SSH keys. Size is not a limit on the selector path: the browser opens the path itself. A ref instead of a selector takes a slower path that cannot carry more than 50MB. Only a real <input type=file> is supported; a drop-zone-only uploader fails with "No file input element found".',
    BROWSER_FILE_UPLOAD_SHAPE,
    async ({ paths, selector, ref, timeout, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const safePaths = paths.map(validateUploadPath);
        const resolvedSelector = selector ?? DEFAULT_FILE_INPUT_SELECTOR;
        const resolvedTimeout = timeout ?? REF_UPLOAD_TIMEOUT_MS;

        if (ref) {
          // A ref names an element we hold as a handle, not as a selector, so
          // the by-path CDP route cannot address it and this stays on
          // Playwright's content-copying path — 50MB cap included. Kept for
          // compatibility; `selector` is the route that scales.
          const el = await resolveRef(page, ref);
          if (!el) {
            throw new Error(`Could not resolve ref="${ref}" to an element.`);
          }
          await el.setInputFiles(safePaths, { timeout: resolvedTimeout });
        } else if (!(await uploadViaCdp(page, resolvedSelector, safePaths))) {
          // No CDP (or the selector matched nothing): fall back to the DOM
          // handle, which also produces the user-facing "no file input" error.
          const fileInput = await page.$(resolvedSelector);
          if (!fileInput) {
            throw new Error(
              selector
                ? `No file input element matches selector: ${resolvedSelector}`
                : 'No file input element found on the page.',
            );
          }
          await fileInput.setInputFiles(safePaths, { timeout: resolvedTimeout });
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Uploaded ${safePaths.length} file(s) from ${getUploadRoot()}`,
            },
          ],
        };
      } catch (error) {
        const message = describeToolError(error);
        return {
          content: [{ type: 'text' as const, text: decorateUploadTimeout(message) }],
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
    'Click an element by ref and capture the resulting download. Returns the file path.',
    BROWSER_DOWNLOAD_SHAPE,
    async ({ ref, filename, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope);
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
        const message = describeToolError(error);
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
    'Wait for a download event, optionally matching a filename.',
    BROWSER_WAIT_FOR_DOWNLOAD_SHAPE,
    async ({ filename, timeout, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      const resolvedTimeout = timeout ?? 30000;

      try {
        const page = await engine.getPageForScope(scope);
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
        const message = describeToolError(error);
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
    'Pre-register a handler for the NEXT dialog (alert, confirm, prompt, beforeunload); it is accepted or dismissed automatically when it appears.',
    BROWSER_DIALOG_SHAPE,
    async ({ accept, text, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope);
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
        const message = describeToolError(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    }),
  );
}
