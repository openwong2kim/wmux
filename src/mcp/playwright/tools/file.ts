import * as fs from 'node:fs';
import * as os from 'node:os';
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
export const BROWSER_FILE_UPLOAD_SHAPE = {
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
    .int()
    .min(1)
    .optional()
    .describe('Milliseconds, ref path only; default 120000.'),
  surfaceId: optionalSurfaceId,
};

export const BROWSER_DOWNLOAD_SHAPE = {
  ref: z
    .string()
    .describe('Element that triggers the download.'),
  filename: z
    .string()
    .optional()
    .describe('Save the download as this name.'),
  timeout: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Milliseconds to wait for the download to START; default 30000.'),
  surfaceId: optionalSurfaceId,
};

export const BROWSER_WAIT_FOR_DOWNLOAD_SHAPE = {
  filename: z
    .string()
    .optional()
    .describe('Expected filename.'),
  timeout: z
    .number()
    .int()
    .min(1)
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
 * How the uploads root is spelled in tool output.
 *
 * Two requirements that look opposed. Naming a fixed `~/.wmux/uploads/` is
 * wrong on any instance carrying a data suffix — the directory the caller is
 * told to use is not the one the check enforces. Printing the resolved absolute
 * path is right but parks the login name and home layout in every upload
 * result, which is local identifying detail an injected page would like an
 * agent to repeat back to it.
 *
 * `~`-relative with the suffix kept satisfies both: `~/.wmux-dogm/uploads` is
 * the real root, and nothing outside the home directory is disclosed. Falls
 * back to the absolute path only when the root is not under the home directory
 * at all, where accuracy has to win.
 */
function displayRoot(root: string): string {
  let home = os.homedir();
  try {
    home = fs.realpathSync(home);
  } catch {
    // Unresolvable home — compare against what we were given.
  }
  const rel = path.relative(home, root);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return root;
  return `~/${rel.split(path.sep).join('/')}`;
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
 * Note what is NOT on that list: a path that EXISTS and whose realpath still
 * cannot be computed. Every guarantee above rests on resolving links first, so
 * on that input the gate would quietly become a lexical string compare — a
 * weaker check of a different kind — and that lexical string is exactly what
 * Chrome would then be asked to open. It is refused instead. existsSync does
 * not throw, so the only inputs that get there are already anomalous.
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
    throw new Error(
      `browser_file_upload blocked: "${input}" exists but its real path cannot be resolved, ` +
      `so it cannot be checked against the upload root.`,
    );
  }
  const rel = path.relative(root, resolved);
  // `rel === '..'` and `'..' + sep` are the escapes; a bare startsWith('..')
  // also swallows legitimate names — `..dots` in the root relativises to
  // `..dots` and was refused forever.
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(
      `browser_file_upload blocked: "${input}" is outside the allowed upload root (${displayRoot(root)}). ` +
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

// ---------------------------------------------------------------------------
// Download: keeping the page the agent was on
// ---------------------------------------------------------------------------

/** Default wait for the download to START. See BROWSER_DOWNLOAD_SHAPE. */
const DOWNLOAD_START_TIMEOUT_MS = 30_000;

/** Budget for each half of the restore. Bounded so a failed download does not
 *  also become a hang; the error is already on its way out. */
const RESTORE_TIMEOUT_MS = 10_000;

/**
 * Put the tab back where it was after a click navigated instead of downloading.
 *
 * Chrome ignores the `download` attribute on a CROSS-ORIGIN link (spec
 * behaviour) and renders the target instead, so a click on a link to a video on
 * someone else's host fires no download event and NAVIGATES. Measured: the tool
 * timed out and the agent's tab was left on the media URL — a snapshot taken
 * afterwards described a completely different page, with nothing saying the
 * page the agent was working on had gone.
 *
 * `goBack` first, and the reason is history rather than speed: it POPS the
 * stray entry, while `goto` pushes a new one on top of it. Measured on Chrome
 * 141 with the same three-entry history — page A, page B, then the media URL
 * the click navigated to — a later browser_navigate_back lands on A after a
 * goBack restore, and lands back on THE MEDIA URL after a goto restore, i.e.
 * straight into the failure this function exists to undo.
 *
 * Neither route brings the document back. Also measured: a marker set on
 * `window` before the click is gone after goBack, so Chrome did not keep the
 * page in its back/forward cache and the restore is a reload either way. The
 * caller is told which route ran, because only one of them leaves the history
 * usable.
 */
async function restoreAfterStrayNavigation(
  page: Page,
  originalUrl: string,
): Promise<'restored' | 'reloaded' | 'failed'> {
  // Success is judged by where the tab ENDED UP, not by whether goBack's
  // promise resolved. Measured against a wmux-opened tab: the back navigation
  // lands immediately (the lifecycle ring records it at once) while the promise
  // sits unresolved until its own timeout — so awaiting it would spend the
  // whole budget and then fall through to the goto that leaves the stray entry
  // in history. Polling the URL turns that into the good outcome. The same loop
  // exits at once when goBack fails outright, which is the no-history case.
  let settled = false;
  const back = page
    .goBack({ timeout: RESTORE_TIMEOUT_MS, waitUntil: 'commit' })
    .catch(() => undefined)
    .finally(() => { settled = true; });
  const deadline = Date.now() + RESTORE_TIMEOUT_MS;
  for (;;) {
    if (page.url() === originalUrl) return 'restored';
    if (settled || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await back;
  if (page.url() === originalUrl) return 'restored';

  try {
    await page.goto(originalUrl, { timeout: RESTORE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    return page.url() === originalUrl ? 'reloaded' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * What to tell an agent whose download turned into a navigation.
 *
 * The bare Playwright timeout ("Timeout 30000ms exceeded while waiting for
 * event \"download\"") is true and useless: it names neither the cause nor the
 * fact that the page moved. Both belong here, and so does the one thing the
 * agent can actually do next — the URL is in hand, and on this machine a
 * terminal can fetch it whenever the asset does not need the page's session.
 */
function describeStrayNavigation(
  strandedUrl: string,
  originalUrl: string,
  outcome: 'restored' | 'reloaded' | 'failed',
): string {
  const state =
    outcome === 'restored'
      ? `The tab was sent back to ${originalUrl}; the page was reloaded, so anything it held in memory is gone.`
      : outcome === 'reloaded'
        ? `The tab was reopened at ${originalUrl} — the page was reloaded, and the stray entry is still in history, so browser_navigate_back would land back here.`
        : `The tab could NOT be recovered and is still on ${strandedUrl} — navigate before using it again.`;
  return (
    `The click navigated instead of downloading: the browser is now at ${strandedUrl}. ` +
    `Chrome ignores a link's "download" attribute across origins and renders the target instead, ` +
    `so no download ever started. ${state} ` +
    `That URL is the file — fetch it from a terminal if it needs no session, ` +
    `otherwise use a control that builds the download in the page itself.`
  );
}

/**
 * Marks the one error that means "this may actually have worked".
 *
 * Raised only from the Playwright transfer call, never inferred from message
 * text: the rejection messages echo the caller's own path, so a file living
 * under `.wmux-timeout/` would have matched a text scan and been told its
 * upload might have landed — advice that manufactures exactly the duplicate
 * retry the warning exists to prevent.
 */
class UploadTransferTimeout extends Error {
  constructor(readonly cause: unknown) {
    super(describeToolError(cause));
    this.name = 'UploadTransferTimeout';
  }
}

/** Playwright's own timeout, as raised by setInputFiles. */
function isPlaywrightTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || /\bTimeout \d+ms exceeded/.test(error.message))
  );
}

/**
 * Run the content-copying transfer, tagging a timeout as the ambiguous case.
 *
 * That case was measured, not imagined: a 45MB file reported "Timeout 30000ms
 * exceeded" while the page's change event had already fired with the full
 * 47,185,920 bytes. An agent reading only "Timeout" retries — and on a real
 * uploader a retry is a SECOND upload, i.e. a duplicate post. The tool cannot
 * tell the two apart, so it says so rather than implying a clean failure.
 */
async function setInputFilesTagged(
  target: { setInputFiles: (paths: string[], options: { timeout: number }) => Promise<void> },
  safePaths: string[],
  timeout: number,
): Promise<void> {
  try {
    await target.setInputFiles(safePaths, { timeout });
  } catch (error) {
    if (isPlaywrightTimeout(error)) throw new UploadTransferTimeout(error);
    throw error;
  }
}

/** The duplicate-upload warning, appended only to a tagged transfer timeout. */
function describeUploadTimeout(message: string): string {
  return (
    `${message} The file may have reached the page anyway — the renderer can ` +
    `finish the transfer after this call gives up. Check the page before ` +
    `retrying; a blind retry can upload the same file twice.`
  );
}

/**
 * The slice of Playwright's ElementHandle this module needs. Narrow on purpose
 * so the proximity search is unit-testable against a plain object.
 */
interface ElementHandleLike {
  evaluate: (fn: (node: unknown) => boolean) => Promise<boolean>;
  evaluateHandle: (
    fn: (node: unknown) => unknown,
  ) => Promise<{ asElement?: () => unknown; dispose?: () => Promise<void> } | null>;
  setInputFiles: (paths: string[], options: { timeout: number }) => Promise<void>;
}

/** The shape of the DOM nodes the proximity search walks. */
interface ProximityNode {
  nodeType?: number;
  tagName?: string;
  id?: string;
  getAttribute?: (name: string) => string | null;
  children?: ArrayLike<ProximityNode>;
  parentElement?: ProximityNode | null;
  closest?: (selector: string) => ProximityNode | null;
}

/**
 * Find the file input at or near an anchor element.
 *
 * mirrors browser-use browser/session.py find_file_input_near_element: from the
 * anchor, walk up to MAX_HEIGHT parents; at each level test the node itself,
 * its descendants up to MAX_DESCENDANT_DEPTH, and its siblings, for an
 * `input[type=file]`.
 *
 * Why it is needed: real uploaders style a <button>/<label> and keep the actual
 * input visually hidden, so the ref an agent gets from a snapshot is the button,
 * and setInputFiles on a button fails with an unhelpful error.
 *
 * Deliberately self-contained (no imports, no closure): it is handed to
 * `ElementHandle.evaluateHandle` AS A FUNCTION, which Playwright serialises and
 * calls with the element as its argument. It used to be passed as a source
 * STRING, which Playwright evaluated as an expression instead — the search
 * never ran on the anchor at all and every styled uploader reported "no file
 * input found" (live dogfood).
 */
export function findFileInputNearElement(anchor: unknown): unknown {
  const MAX_HEIGHT = 3;
  const MAX_DESCENDANT_DEPTH = 3;
  const start = anchor as ProximityNode | null;
  const isFileInput = (n: ProximityNode | null | undefined): boolean =>
    !!n &&
    n.nodeType === 1 &&
    n.tagName === 'INPUT' &&
    String((n.getAttribute && n.getAttribute('type')) || '').toLowerCase() === 'file';

  // Walking three levels up reaches sibling subtrees that can belong to a
  // DIFFERENT widget — a second upload form on the same page. When either the
  // anchor or the candidate sits in a <form>, they must sit in the SAME one;
  // otherwise the files would be attached to someone else's form.
  const anchorForm = start && start.closest ? start.closest('form') : null;
  const sameOwner = (n: ProximityNode): boolean => {
    const form = n.closest ? n.closest('form') : null;
    if (anchorForm || form) return form === anchorForm;
    return true;
  };
  const accept = (n: ProximityNode | null | undefined): boolean => !!n && isFileInput(n) && sameOwner(n);

  const inDescendants = (n: ProximityNode | null | undefined, depth: number): ProximityNode | null => {
    if (!n || depth < 0) return null;
    if (accept(n)) return n;
    const kids = n.children ? Array.prototype.slice.call(n.children) : [];
    for (const child of kids as ProximityNode[]) {
      const found = inDescendants(child, depth - 1);
      if (found) return found;
    }
    return null;
  };

  let current: ProximityNode | null | undefined = start;
  for (let level = 0; current && level <= MAX_HEIGHT; level++) {
    if (accept(current)) return current;
    const inside = inDescendants(current, MAX_DESCENDANT_DEPTH);
    if (inside) return inside;
    const parent: ProximityNode | null | undefined = current.parentElement;
    if (parent) {
      const siblings = parent.children ? Array.prototype.slice.call(parent.children) : [];
      for (const sibling of siblings as ProximityNode[]) {
        if (sibling === current) continue;
        if (accept(sibling)) return sibling;
        const found = inDescendants(sibling, MAX_DESCENDANT_DEPTH);
        if (found) return found;
      }
    }
    current = parent;
  }
  return null;
}

/** Hint appended when no file input can be reached from what the caller named. */
const FILE_INPUT_PROXIMITY_HINT =
  ' If the page uses a styled upload button, pass the visible upload button\'s ref instead of a selector — the nearby hidden input is found from there.';

/**
 * Resolve the element a `ref` names to the file input that should actually
 * receive the files: the element itself when it already is one, otherwise the
 * nearest `input[type=file]` around it. Null when neither exists.
 */
async function resolveFileInputFromRef(
  el: ElementHandleLike,
): Promise<ElementHandleLike | null> {
  // Fail-open at every step: when the probe cannot run at all, the element the
  // caller named is used exactly as it was before this search existed.
  let isFileInput: boolean | null = null;
  try {
    // Main world, deliberately: element-scoped, and an ElementHandle cannot be
    // adopted into an isolated context (see isolated-eval.ts).
    isFileInput = await el.evaluate((node: unknown) => {
      const n = node as { tagName?: string; getAttribute?: (a: string) => unknown } | null;
      return (
        !!n &&
        n.tagName === 'INPUT' &&
        String((n.getAttribute && n.getAttribute('type')) || '').toLowerCase() === 'file'
      );
    });
  } catch {
    isFileInput = null;
  }
  if (isFileInput !== false) return el;

  let handle: { asElement?: () => unknown; dispose?: () => Promise<void> } | null | undefined;
  try {
    // Main world, deliberately: the RESULT is a handle Playwright then passes
    // to setInputFiles, so it has to live in the world Playwright resolved the
    // element in.
    handle = await el.evaluateHandle(findFileInputNearElement);
  } catch {
    return el; // probe unavailable — keep the pre-existing behaviour
  }
  const found = handle?.asElement ? handle.asElement() : null;
  // Playwright returns the handle ITSELF from asElement() for an element, so
  // only a handle we are not about to use gets disposed — a null result (the
  // page returned null) and any wrapper that is not the element included.
  // Without this the miss path leaks a JSHandle into the page's context on
  // every failed upload attempt.
  if (handle && handle !== found && typeof handle.dispose === 'function') {
    await handle.dispose().catch(() => undefined);
  }
  return (found as ElementHandleLike | null) ?? null;
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
          // The ref usually names the visible upload BUTTON, not the input.
          const input = await resolveFileInputFromRef(el as unknown as ElementHandleLike);
          if (!input) {
            throw new Error(
              `No file input found at or near ref="${ref}".` + FILE_INPUT_PROXIMITY_HINT,
            );
          }
          await setInputFilesTagged(input, safePaths, resolvedTimeout);
        } else if (!(await uploadViaCdp(page, resolvedSelector, safePaths))) {
          // No CDP (or the selector matched nothing): fall back to the DOM
          // handle, which also produces the user-facing "no file input" error.
          const fileInput = await page.$(resolvedSelector);
          if (!fileInput) {
            throw new Error(
              (selector
                ? `No file input element matches selector: ${resolvedSelector}`
                : 'No file input element found on the page.') + FILE_INPUT_PROXIMITY_HINT,
            );
          }
          await setInputFilesTagged(fileInput, safePaths, resolvedTimeout);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Uploaded ${safePaths.length} file(s) from ${displayRoot(getUploadRoot())}`,
            },
          ],
        };
      } catch (error) {
        // Only a tagged transfer timeout earns the duplicate-upload warning.
        const message =
          error instanceof UploadTransferTimeout
            ? describeUploadTimeout(error.message)
            : describeToolError(error);
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
    'Click an element by ref and capture the resulting download. Returns the saved path plus the name and URL the browser had for it. timeout bounds the wait for the download to START, not to finish — a download that begins in time then runs for minutes still completes (measured: a 60s transfer succeeds under the 30s default). If the click navigates instead of downloading, which is what Chrome does with a cross-origin "download" link, the tab is put back where it was and the error says so.',
    BROWSER_DOWNLOAD_SHAPE,
    async ({ ref, filename, timeout, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      // Captured before the click so a stray navigation has somewhere to go
      // back to. Read outside the try: the catch needs it too.
      let originalUrl = '';
      let page: Awaited<ReturnType<typeof engine.getPageForScope>> = null;
      try {
        page = await engine.getPageForScope(scope);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }
        originalUrl = page.url();

        const el = await resolveRef(page, ref);
        if (!el) {
          throw new Error(`Could not resolve ref="${ref}" to an element.`);
        }

        // Start waiting for download before clicking. The timeout covers the
        // START of the download only — Playwright resolves this event when the
        // transfer begins, and download.path() below then waits out the rest
        // unbounded. That split is deliberate and worth keeping: a large file
        // is slow to finish, not slow to begin.
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: timeout ?? DOWNLOAD_START_TIMEOUT_MS }),
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

        // The saved path is a temp name — `render.mp4` when the caller picked
        // one, an extension-less GUID when it did not — so on its own it says
        // nothing about WHAT was downloaded. The browser's own name and the URL
        // it came from were previously reachable only through
        // browser_wait_for_download, which meant learning the filename cost a
        // second, differently-shaped call.
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Downloaded: ${filePath}\n` +
                `suggestedFilename: ${download.suggestedFilename()}\n` +
                `url: ${download.url()}`,
            },
          ],
        };
      } catch (error) {
        let message = describeToolError(error);
        // A click that navigated is not just a failed download: the page the
        // agent was working on is gone, and every later tool call would run
        // against whatever replaced it. Only on the failure path — a download
        // that succeeded AND navigated did so because the site meant to, and
        // undoing that would be the wrong kind of help.
        if (page) {
          const strandedUrl = page.url();
          if (originalUrl && strandedUrl !== originalUrl) {
            const outcome = await restoreAfterStrayNavigation(page, originalUrl);
            message = `${message}\n\n${describeStrayNavigation(strandedUrl, originalUrl, outcome)}`;
          }
        }
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
