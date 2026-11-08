import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Download, Page } from 'playwright-core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { armDialogAnswer, modalScopeKey, resolveDialogOwner } from '../modalState';
import { leasedMutation, withAutomationLease } from '../automationLease';
import { isProtectedScope, protectedRefusal } from '../protectedPane';
import { claimNextDownload, guardUnclaimedDownloads } from '../downloadGuard';
import {
  awaitConsentedDownload,
  consentHostOf,
  pageTargetId,
  releaseConsent,
  requestBrowserConsent,
} from '../consent';
import {
  BROWSER_CONSENT_DOWNLOAD_FINISH_MS,
  BROWSER_CONSENT_DOWNLOAD_START_MAX_MS,
  browserPolicyRefusalCode,
} from '../../../shared/browserPolicy';
import {
  allowScopedRpcFallback,
  sendScopedBrowserRpc,
  type BrowserTargetScope,
  type BrowserToolDeps,
} from '../browserScope';
import { resolveRef } from '../snapshot';
import { describeToolError } from '../toolError';
import { recordAction } from '../../browser-replay/actionRing';
import { uploadFilesPlaceholder } from '../../../shared/browserReplay/actionTrace';
import {
  EFFECT_TRAILER_NOTE,
  taggedFailure,
  withEffectTrailer,
  type EffectProbe,
} from '../resultTrailer';
import { getWmuxDir } from '../../../daemon/config';
import { fromAgentPath, toAgentPath, wslMountRoot } from '../../wslPaths';
import { randomBytes } from 'node:crypto';
import { sanitizeRef } from './interaction';
import {
  DEFAULT_FILE_INPUT_SELECTOR,
  UPLOAD_MAX_TIMEOUT_MS,
  checkUploadPath,
  findFileInputNearElement,
  uploadRootIn,
} from '../../../shared/browserUpload';

export { DEFAULT_FILE_INPUT_SELECTOR, findFileInputNearElement };

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Omit for the surface you opened last.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.
export const BROWSER_FILE_UPLOAD_SHAPE = {
  paths: z
    .array(z.string())
    .describe('Each path must resolve under the uploads root (~/.wmux/uploads/).'),
  selector: z
    .string()
    .optional()
    .describe('CSS selector of the file input; default the page\'s first one. CSS only on the built-in browser.'),
  ref: z
    .string()
    .optional()
    .describe('Ref of a file input or of the upload button beside it. On the Chrome backend a ref takes the 50MB-capped path.'),
  timeout: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Milliseconds for the page to take the files; default 120000 (at most 120000 on the built-in browser). On the Chrome backend, ref path only.'),
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

/**
 * In-app tabs are Electron guests, and Electron has no prompt(): the call throws
 * in the page ("prompt() is not supported.") and no dialog opens, so an armed
 * answer never meets one. A Chrome-backend tab shows a real prompt, which an
 * armed answer and its text do answer.
 */
const PROMPT_ON_IN_APP_TABS = "prompt isn't available on in-app tabs; the page sees an error instead of a dialog.";

const BROWSER_DIALOG_SHAPE = {
  accept: z
    .boolean()
    .describe('true accepts, false dismisses.'),
  text: z
    .string()
    .optional()
    .describe('Text for a prompt dialog (Chrome-backend tabs only).'),
  surfaceId: optionalSurfaceId,
};

// ---------------------------------------------------------------------------
// Upload sandbox: restrict browser_file_upload to ~/.wmux/uploads
// ---------------------------------------------------------------------------

function getUploadRoot(): string {
  return uploadRootIn(getWmuxDir()).real;
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
 *
 * Accuracy also wins for a WSL caller: its `~` is the Linux home, not the
 * Windows one this root lives under, so it is told the drive-mount path
 * (`/mnt/c/Users/me/.wmux/uploads`) it can actually write to.
 */
function displayRoot(root: string): string {
  if (wslMountRoot() !== null) return toAgentPath(root);
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
 * The upload gate as the tool reports it: checkUploadPath (shared with main,
 * which runs it again on its side) plus the WSL conversion, which only this
 * process can do — the WMUX_WSL_* env that names the caller's mount is ours.
 *
 * The route changed from "Node reads the bytes and streams them" to "the
 * browser opens the path itself", which sounds like it widens the blast radius
 * and does not: the browser runs as the same user and could always read
 * anything this process could. What matters is that the string handed to the
 * browser is the one the check RETURNED, never the caller's raw input. Every
 * call site below uses `safePaths` only.
 */
export function validateUploadPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('browser_file_upload blocked: empty path');
  }
  const uploadRoot = uploadRootIn(getWmuxDir());
  const root = uploadRoot.real;
  // A WSL caller speaks /mnt/<drive>/ paths; every check runs on the host path
  // they name. A distro path (`/home/me/x`) has no host spelling, so it cannot
  // be under the root at all.
  const hostInput = fromAgentPath(input);
  if (hostInput === null) {
    throw new Error(
      `browser_file_upload blocked: "${input}" is not an absolute /mnt/<drive>/ path, so the Windows browser cannot open it. ` +
      `Copy the file under the upload root (${displayRoot(root)}) and pass that path.`,
    );
  }
  const checked = checkUploadPath(hostInput, uploadRoot);
  if (checked.ok) return checked.path;
  switch (checked.reason) {
    case 'aliased':
      throw new Error(
        `browser_file_upload blocked: "${input}" has a name (${JSON.stringify(checked.name)}) that Windows opens as a different file ` +
        `(a trailing dot or space, a device name, or a colon naming a stream), so it cannot be checked against the upload root.`,
      );
    case 'unresolvable':
      throw new Error(
        `browser_file_upload blocked: "${input}" exists but its real path cannot be resolved, ` +
        `so it cannot be checked against the upload root.`,
      );
    case 'missing':
      throw new Error(
        `browser_file_upload blocked: "${input}" does not exist. ` +
        `Put the file under the upload root (${displayRoot(root)}) first.`,
      );
    case 'not-a-file':
      throw new Error(
        `browser_file_upload blocked: "${input}" is not a regular file. Pass files, not directories.`,
      );
    default:
      throw new Error(
        `browser_file_upload blocked: "${input}" is outside the allowed upload root (${displayRoot(root)}). ` +
        `Move the file under that root before uploading.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Upload transport: hand Chrome the path, not the bytes
// ---------------------------------------------------------------------------

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
  // Taken rather than wrapped at the call site: a `false` from here means the
  // route could not serve the call and sent NOTHING, which the caller must not
  // report as an ambiguous dispatch. Only the one send below is one.
  effect: EffectProbe,
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

    await effect.dispatch(() => client.send('DOM.setFileInputFiles', { files, nodeId }));
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

/**
 * Protected pane: main lets exactly the approved download through, into a
 * directory it owns, and reports the file. Playwright's own download object is
 * not used — its path would point into a directory the browser was not told to
 * write to. Returns the file the browser wrote and what it called it.
 */
async function consentedDownload(
  scope: Parameters<typeof requestBrowserConsent>[0],
  tool: string,
  page: Page,
  approvedUrl: string,
  startTimeoutMs: number,
  trigger: () => Promise<void>,
): Promise<{ path: string; url: string; suggestedFilename: string }> {
  const targetId = await pageTargetId(page);
  const startMs = Math.min(BROWSER_CONSENT_DOWNLOAD_START_MAX_MS, Math.max(1_000, startTimeoutMs));
  const { operationId } = await requestBrowserConsent(scope, tool, {
    action: 'download',
    url: approvedUrl,
    targetId,
    startTimeoutMs: startMs,
  });
  try {
    // Right before dispatch: still the site the operator approved.
    if (consentHostOf(page.url()) !== consentHostOf(approvedUrl)) {
      throw protectedRefusal(tool, 'the page moved to another site while the operator was being asked');
    }
    await trigger();
    return await awaitConsentedDownload(scope, tool, operationId, startMs + BROWSER_CONSENT_DOWNLOAD_FINISH_MS + 15_000);
  } catch (err) {
    // Whatever failed, the pass is withdrawn and the deny restored.
    releaseConsent(scope, operationId);
    throw err;
  }
}

/**
 * Unprotected pane: the download has begun (the browser writes it to its own
 * temporary file) and the operator is asked about it, by host and file name,
 * before the tool hands it over. A refusal, a timeout or nobody to ask cancels
 * and deletes it. There is no standing grant on an unprotected pane, so every
 * download is asked about.
 */
async function consentToUnprotectedDownload(
  scope: Parameters<typeof requestBrowserConsent>[0],
  tool: string,
  page: Page,
  download: Download,
): Promise<void> {
  try {
    await requestBrowserConsent(scope, tool, {
      action: 'download',
      url: downloadSourceUrl(download.url(), page.url()),
      detail: download.suggestedFilename(),
      unprotected: true,
    });
  } catch (err) {
    await download.cancel().catch(() => undefined);
    await download.delete().catch(() => undefined);
    throw err;
  }
}

/** The http(s) URL a download is named by: its own, a blob's origin, else the page's. */
function downloadSourceUrl(url: string, pageUrl: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
    if (parsed.protocol === 'blob:' && parsed.origin !== 'null') return parsed.origin;
  } catch {
    // Not a URL: the page it came from names it.
  }
  return pageUrl;
}

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
 * Raised only from the transfer call itself (Playwright's, or main's whole-
 * message timeout), never inferred from a scan of message text: the rejection
 * messages echo the caller's own path, so a file living
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
    `finish the transfer after this call gives up, and a blind retry then uploads ` +
    `the same file twice.`
  );
}

/**
 * The slice of Playwright's ElementHandle this module needs. Narrow on purpose
 * so the proximity search is unit-testable against a plain object.
 */
interface ElementHandleLike {
  evaluate: <R, A>(fn: (node: unknown, arg: A) => R, arg?: A) => Promise<R>;
  evaluateHandle: (
    fn: (node: unknown) => unknown,
  ) => Promise<{ asElement?: () => unknown; dispose?: () => Promise<void> } | null>;
  setInputFiles: (paths: string[], options: { timeout: number }) => Promise<void>;
}

/** Hint appended when no file input can be reached from what the caller named. */
const FILE_INPUT_PROXIMITY_HINT =
  ' If the page uses a styled upload button, pass the visible upload button\'s ref instead of a selector — the nearby hidden input is found from there.';

/**
 * Resolve the element a `ref` names to the file input that should actually
 * receive the files: the element itself when it already is one, otherwise the
 * nearest `input[type=file]` around it. Null when neither exists.
 */
export async function resolveFileInputFromRef(
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

/** What main answers browser.upload.cdp with. */
interface MainUploadReply {
  uploaded?: boolean;
  /** Nothing was sent to the page; see UploadOutcome in browser.rpc.ts. */
  missing?: 'match' | 'ambiguous' | 'near' | 'invalid' | 'unanswered';
  detail?: string;
  /** With `unanswered`: the wait main ran, which caps what was asked. */
  waitedMs?: number;
}

/** Room for main to report its own timeout before the client gives up. */
const MAIN_UPLOAD_RPC_MARGIN_MS = 5_000;

/** Marks a ref's element for main. Self-contained: Playwright serialises it. */
function markUploadTarget(node: unknown, nonce: string): void {
  (node as { setAttribute: (name: string, value: string) => void }).setAttribute('data-wmux-upload', nonce);
}

/** Takes the mark off again, unless the page has since put another there. */
function clearUploadTarget(node: unknown, nonce: string): void {
  const el = node as { getAttribute: (name: string) => string | null; removeAttribute: (name: string) => void };
  if (el.getAttribute('data-wmux-upload') === nonce) el.removeAttribute('data-wmux-upload');
}

/**
 * A wait main or the client gave up on after the files may have been sent.
 * Matched whole, never as a substring: main's refusals echo the caller's path.
 */
function isMainUploadTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /^browser\.upload\.cdp: the page did not take the files within \d+ ms$/.test(message) ||
    /^RPC timeout: browser\.upload\.cdp \(\d+ms\)$/.test(message)
  );
}

/**
 * Builtin backend: main sets the files on the input, so the upload works
 * whether or not a Playwright page is attached. Main checks every path again
 * and passes the page only what its check returned. Selectors are CSS, looked
 * up in an isolated world in the top document.
 *
 * A ref names an anchor (usually the visible upload button) and main finds
 * the file input around it, in that same isolated world. Without a page the
 * ref can only be a DOM-snapshot ref, and main finds its data-wmux-ref tag
 * directly. With one, the page resolves the ref as it always has — an a11y ref
 * exists only in that page's ref map and the handle exposes no node id — so
 * the anchor gets a one-shot attribute and main is pointed at it. Main refuses
 * a mark or tag found on more than one element. A ref minted inside an iframe
 * is refused (sanitizeRef): main reaches the top document only.
 *
 * Returns the page used to resolve a ref, if one was.
 */
async function uploadThroughMain(
  engine: PlaywrightEngine,
  scope: BrowserTargetScope,
  effect: EffectProbe,
  safePaths: string[],
  selector: string | undefined,
  ref: string | undefined,
  timeoutMs: number,
): Promise<Page | null> {
  let target: { selector: string; near: boolean };
  let page: Page | null = null;
  let marked: ElementHandleLike | null = null;
  let nonce = '';
  if (ref) {
    const safeRef = sanitizeRef(ref, scope);
    page = await engine.getPageForScope(scope, { intent: 'write' }).catch(() => null);
    if (page) {
      const el = await resolveRef(page, safeRef);
      if (!el) {
        throw taggedFailure('ref_not_found', `Could not resolve ref="${ref}" to an element.`);
      }
      nonce = randomBytes(8).toString('hex');
      marked = el as unknown as ElementHandleLike;
      await marked.evaluate(markUploadTarget, nonce);
      target = { selector: `[data-wmux-upload="${nonce}"]`, near: true };
    } else {
      target = { selector: `[data-wmux-ref="${safeRef}"]`, near: true };
    }
  } else {
    target = { selector: selector ?? DEFAULT_FILE_INPUT_SELECTOR, near: false };
  }

  let reply: MainUploadReply | undefined;
  try {
    reply = await effect.dispatch(() =>
      sendScopedBrowserRpc<MainUploadReply>(
        'browser.upload.cdp',
        scope,
        { files: safePaths, ...target, timeoutMs },
        timeoutMs + MAIN_UPLOAD_RPC_MARGIN_MS,
      ),
    );
  } catch (error) {
    if (isMainUploadTimeout(error)) throw new UploadTransferTimeout(error);
    throw error;
  } finally {
    if (marked) await marked.evaluate(clearUploadTarget, nonce).catch(() => undefined);
  }
  if (reply?.uploaded === true) return page;

  // Main sent nothing to the page, so nothing happened.
  switch (reply?.missing) {
    case 'unanswered':
      throw taggedFailure(
        'timeout',
        `The page did not answer within ${reply.waitedMs ?? timeoutMs} ms; no file was set.`,
        'none',
      );
    case 'invalid':
      throw taggedFailure(
        'invalid_params',
        `Invalid selector "${selector ?? ''}": the built-in browser takes CSS selectors only` +
          (reply.detail ? ` (${reply.detail})` : '') + '.',
        'none',
      );
    case 'ambiguous':
      throw taggedFailure(
        'ref_not_found',
        `ref="${ref}" now names more than one element. Run browser_snapshot for current refs.`,
        'none',
      );
    case 'near':
      throw taggedFailure(
        'element_not_interactable',
        `No file input found at or near ref="${ref}".` + FILE_INPUT_PROXIMITY_HINT,
        'none',
      );
    default:
      if (ref) throw taggedFailure('ref_not_found', `Could not resolve ref="${ref}" to an element.`, 'none');
      throw taggedFailure(
        'selector_not_found',
        (selector
          ? `No file input element matches selector: ${selector}`
          : 'No file input element found on the page.') + FILE_INPUT_PROXIMITY_HINT,
        'none',
      );
  }
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
    'Upload files to a file input, by default the page\'s first one — pass selector to pick another. Paths MUST live under the uploads root (~/.wmux/uploads/, instance suffix applied); anything else is rejected so a malicious page cannot exfiltrate credentials or SSH keys. Size is not a limit: the browser opens the path itself, except on the Chrome backend, where a ref instead of a selector takes a slower path that cannot carry more than 50MB. Only a real <input type=file> is supported; a drop-zone-only uploader fails with "No file input element found". On the built-in browser, selectors are CSS and refs and selectors reach the top document only; a ref from inside an iframe is refused.' + EFFECT_TRAILER_NOTE,
    BROWSER_FILE_UPLOAD_SHAPE,
    async ({ paths, selector, ref, timeout, surfaceId }) => leasedMutation(deps, surfaceId, async (scope, effect) => {
      try {
        const resolvedSelector = selector ?? DEFAULT_FILE_INPUT_SELECTOR;
        let page: Page | null = null;
        let safePaths: string[];
        if ((await engine.resolveWorkspaceBackend(scope.workspaceId)) !== 'chrome') {
          safePaths = paths.map(validateUploadPath);
          // Clamped to main's own cap before it is sent: the same bound on
          // both sides, and never a client timer past what Node can hold.
          const mainTimeout = Math.min(timeout ?? REF_UPLOAD_TIMEOUT_MS, UPLOAD_MAX_TIMEOUT_MS);
          page = await uploadThroughMain(engine, scope, effect, safePaths, selector, ref, mainTimeout);
        } else {
          page = await engine.getPageForScope(scope, { intent: 'write' });
          if (!page) {
            throw taggedFailure('not_supported', 'No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
          }

          safePaths = paths.map(validateUploadPath);
          const resolvedTimeout = timeout ?? REF_UPLOAD_TIMEOUT_MS;

          if (ref) {
            // A ref names an element we hold as a handle, not as a selector, so
            // the by-path CDP route cannot address it and this stays on
            // Playwright's content-copying path — 50MB cap included. Kept for
            // compatibility; `selector` is the route that scales.
            const el = await resolveRef(page, ref);
            if (!el) {
              throw taggedFailure('ref_not_found', `Could not resolve ref="${ref}" to an element.`);
            }
            // The ref usually names the visible upload BUTTON, not the input.
            const input = await resolveFileInputFromRef(el as unknown as ElementHandleLike);
            if (!input) {
              throw taggedFailure(
                'element_not_interactable',
                `No file input found at or near ref="${ref}".` + FILE_INPUT_PROXIMITY_HINT,
              );
            }
            await effect.dispatch(() => setInputFilesTagged(input, safePaths, resolvedTimeout));
          } else if (!(await uploadViaCdp(page, resolvedSelector, safePaths, effect))) {
            // No CDP (or the selector matched nothing): fall back to the DOM
            // handle, which also produces the user-facing "no file input" error.
            const fileInput = await page.$(resolvedSelector);
            if (!fileInput) {
              throw taggedFailure(
                'selector_not_found',
                (selector
                  ? `No file input element matches selector: ${resolvedSelector}`
                  : 'No file input element found on the page.') + FILE_INPUT_PROXIMITY_HINT,
              );
            }
            await effect.dispatch(() => setInputFilesTagged(fileInput, safePaths, resolvedTimeout));
          }
        }

        // Recorded with a placeholder per file, never the paths themselves.
        recordAction(deps, {
          scope,
          tool: 'browser_file_upload',
          page,
          ...(ref ? { ref } : { selector: resolvedSelector }),
          args: { files: uploadFilesPlaceholder(safePaths.length) },
        });
        return withEffectTrailer(
          {
            content: [
              {
                type: 'text' as const,
                text: `Uploaded ${safePaths.length} file(s) from ${displayRoot(getUploadRoot())}`,
              },
            ],
          },
          effect.success(),
        );
      } catch (error) {
        // Only a tagged transfer timeout earns the duplicate-upload warning.
        const message =
          error instanceof UploadTransferTimeout
            ? describeUploadTimeout(error.message)
            : describeToolError(error);
        return withEffectTrailer(
          {
            content: [{ type: 'text' as const, text: message }],
            isError: true,
          },
          effect.failure(error),
        );
      }
    }),
  );

  // -----------------------------------------------------------------------
  // browser_download
  // -----------------------------------------------------------------------
  server.tool(
    'browser_download',
    'Click an element by ref and capture the resulting download. Returns the saved path plus the name and URL the browser had for it. timeout bounds the wait for the download to START, not to finish — a download that begins in time then runs for minutes still completes (measured: a 60s transfer succeeds under the 30s default). If the click navigates instead of downloading, which is what Chrome does with a cross-origin "download" link, the tab is put back where it was and the error says so. The user may be asked to allow the download.' + EFFECT_TRAILER_NOTE,
    BROWSER_DOWNLOAD_SHAPE,
    async ({ ref, filename, timeout, surfaceId }) => leasedMutation(deps, surfaceId, async (scope, effect) => {
      // Captured before the click so a stray navigation has somewhere to go
      // back to. Read outside the try: the catch needs it too.
      let originalUrl = '';
      let page: Awaited<ReturnType<typeof engine.getPageForScope>> = null;
      try {
        // A download starts with a CLICK, so this is a write.
        page = await engine.getPageForScope(scope, { intent: 'write' });
        if (!page) {
          throw taggedFailure('not_supported', 'No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }
        originalUrl = page.url();

        const el = await resolveRef(page, ref);
        if (!el) {
          throw taggedFailure('ref_not_found', `Could not resolve ref="${ref}" to an element.`);
        }

        // Protected pane: the operator answers for this download first; main
        // then lets exactly it through (see consentedDownload).
        if (isProtectedScope(scope)) {
          const got = await consentedDownload(scope, 'browser_download', page, originalUrl, timeout ?? DOWNLOAD_START_TIMEOUT_MS, async () => {
            effect.begin();
            await el.click();
          });
          let saved = got.path;
          if (filename) {
            const safeName = path.basename(filename);
            if (!safeName || safeName === '.' || safeName === '..') {
              throw taggedFailure('invalid_params', 'filename must be a non-empty plain file name');
            }
            saved = path.join(os.tmpdir(), safeName);
            await fs.promises.copyFile(got.path, saved);
          }
          return withEffectTrailer(
            {
              content: [
                {
                  type: 'text' as const,
                  text:
                    `Downloaded: ${toAgentPath(saved)}\n` +
                    `suggestedFilename: ${got.suggestedFilename}\n` +
                    `url: ${got.url}`,
                },
              ],
            },
            effect.success(),
          );
        }

        // Start waiting for download before clicking. The timeout covers the
        // START of the download only — Playwright resolves this event when the
        // transfer begins, and download.path() below then waits out the rest
        // unbounded. That split is deliberate and worth keeping: a large file
        // is slow to finish, not slow to begin.
        // The click is the dispatch, so a timeout waiting for the download that
        // follows it is the ambiguous case rather than a clean failure.
        guardUnclaimedDownloads(page);
        const releaseClaim = claimNextDownload(page);
        effect.begin();
        let download: Download;
        try {
          [download] = await Promise.all([
            page.waitForEvent('download', { timeout: timeout ?? DOWNLOAD_START_TIMEOUT_MS }),
            el.click(),
          ]);
        } finally {
          releaseClaim();
        }
        await consentToUnprotectedDownload(scope, 'browser_download', page, download);

        let filePath: string;
        if (filename) {
          const pathMod = await import('path');
          const os = await import('os');
          // path.basename strips any directory components — a malicious
          // page could otherwise pass `../../etc/passwd` and overwrite
          // arbitrary files via download.saveAs which doesn't sanitize.
          const safeName = pathMod.basename(filename);
          if (!safeName || safeName === '.' || safeName === '..') {
            throw taggedFailure('invalid_params', 'filename must be a non-empty plain file name');
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
        return withEffectTrailer(
          {
            content: [
              {
                type: 'text' as const,
                text:
                  `Downloaded: ${toAgentPath(filePath)}\n` +
                  `suggestedFilename: ${download.suggestedFilename()}\n` +
                  `url: ${download.url()}`,
              },
            ],
          },
          effect.success(),
        );
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
        return withEffectTrailer(
          {
            content: [{ type: 'text' as const, text: message }],
            isError: true,
          },
          effect.failure(error),
        );
      }
    }),
  );

  // -----------------------------------------------------------------------
  // browser_wait_for_download
  // -----------------------------------------------------------------------
  server.tool(
    'browser_wait_for_download',
    'Wait for a download event, optionally matching a filename. The user may be asked to allow it.',
    BROWSER_WAIT_FOR_DOWNLOAD_SHAPE,
    async ({ filename, timeout, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      const resolvedTimeout = timeout ?? 30000;

      try {
        const page = await engine.getPageForScope(scope);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        // Protected pane: the operator answers first; main then lets the next
        // download of this tab through and reports it.
        if (isProtectedScope(scope)) {
          const got = await consentedDownload(scope, 'browser_wait_for_download', page, page.url(), resolvedTimeout, async () => undefined);
          if (filename && got.suggestedFilename !== filename) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Download received but filename mismatch: expected "${filename}", got "${got.suggestedFilename}"`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { suggestedFilename: got.suggestedFilename, url: got.url, path: toAgentPath(got.path) },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        guardUnclaimedDownloads(page);
        const releaseClaim = claimNextDownload(page);
        let download: Download;
        try {
          download = await page.waitForEvent('download', {
            timeout: resolvedTimeout,
          });
        } finally {
          releaseClaim();
        }

        const suggestedName = download.suggestedFilename();

        if (filename && suggestedName !== filename) {
          // Not handed over, so not kept either.
          await download.cancel().catch(() => undefined);
          await download.delete().catch(() => undefined);
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

        await consentToUnprotectedDownload(scope, 'browser_wait_for_download', page, download);
        const downloadPath = await download.path();

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  suggestedFilename: suggestedName,
                  url: download.url(),
                  path: toAgentPath(downloadPath ?? '(pending)'),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message = describeToolError(error);
        // A consent refusal is reported as itself, never as a download timeout.
        if (browserPolicyRefusalCode(error) === null && (message.includes('Timeout') || message.includes('timeout'))) {
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
    `Pre-register the answer for the NEXT dialog (alert, confirm, or, on a Chrome-backend tab, prompt) that one of your actions opens on a tab you opened, within 30s. ${PROMPT_ON_IN_APP_TABS} Without it a dialog is dismissed and reported as a [modal] note; leaving a page (beforeunload) is always accepted. Refused on tabs the user owns or lent.` + EFFECT_TRAILER_NOTE,
    BROWSER_DIALOG_SHAPE,
    async ({ accept, text, surfaceId }) => leasedMutation(deps, surfaceId, async (scope, effect) => {
      try {
        // Answering a dialog (accept/dismiss, and prompt text) acts on the page.
        const page = await engine.getPageForScope(scope, { intent: 'write' }).catch(allowScopedRpcFallback);
        // Asked once: it picks the no-page path and says whether prompt exists here.
        // Unknown (an older main, CDP off) adds no prompt note either way.
        const inAppTab = (await engine.resolveWorkspaceBackend(scope.workspaceId)) === 'builtin';
        if (page) {
          armDialogAnswer(
            page,
            modalScopeKey(scope.workspaceId, scope.surfaceId),
            await resolveDialogOwner(page, scope.workspaceId),
            accept,
            text,
          );
        } else if (inAppTab) {
          // No Playwright page on this tab: main answers its dialogs.
          await sendScopedBrowserRpc('browser.dialog.arm', scope, { accept, ...(text !== undefined && { text }) });
        } else {
          throw taggedFailure('not_supported', 'No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }
        // Nothing is sent to the page here — what this tool mutates is the
        // handler armed on it, and that registration is what `committed`
        // reports. The dialog it answers has not happened yet.
        effect.begin();

        const action = accept ? 'accepted' : 'dismissed';
        const promptNote = !inAppTab
          ? ''
          : text !== undefined
            ? ` The text won't be used here: ${PROMPT_ON_IN_APP_TABS}`
            : ` This doesn't apply to prompt: ${PROMPT_ON_IN_APP_TABS}`;
        return withEffectTrailer(
          {
            content: [
              {
                type: 'text' as const,
                text: `Dialog handler set. Next dialog will be ${action}.${promptNote}`,
              },
            ],
          },
          effect.success(),
        );
      } catch (error) {
        const message = describeToolError(error);
        return withEffectTrailer(
          {
            content: [{ type: 'text' as const, text: message }],
            isError: true,
          },
          effect.failure(error),
        );
      }
    }),
  );
}
