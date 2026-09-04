import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ElementHandle, Page } from 'playwright-core';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import {
  browserScopeKey,
  frameRefFallbackMessage,
  isOutstandingFrameRef,
  resolveRef,
} from '../snapshot';
import {
  getLocatorByRef,
  getSmartElementByRef,
  resolveSmartRefLocator,
  smartRefAxisEntry,
} from '../dom-intelligence';
import { typeHumanlike } from '../human-typing';
import { evaluateIsolated } from '../isolated-eval';
import {
  clickPointInBox,
  defaultStartPoint,
  distance,
  getLastPointer,
  pathPoints,
  setLastPointer,
  stepsForDistance,
} from '../pointer-path';
import { hasTouchEmulation, touchDragFor, touchTapFor } from '../touch-input';
import { describeToolError } from '../toolError';
import {
  PASSWORD_FIELD_PREDICATE_JS,
  REDACTED_PASSWORD,
  isPasswordFieldNode,
  redactPasswordParams,
} from '../redact';
import {
  allowScopedRpcFallback,
  sendScopedBrowserRpc,
  type BrowserTargetScope,
  type BrowserToolDeps,
} from '../browserScope';
import { recordAction } from '../../browser-replay/actionRing';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Omit for the active surface.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.
const BROWSER_CLICK_SHAPE = {
  ref: z.string().optional(),
  x: z
    .number()
    .optional()
    .describe('Viewport CSS px, only when ref/smartRef is omitted. Needs y.'),
  y: z
    .number()
    .optional()
    .describe('Viewport CSS px, only when ref/smartRef is omitted. Needs x.'),
  smartRef: z
    .number()
    .optional()
    .describe('Ref from browser_smart_snapshot; takes priority over ref.'),
  double: z
    .boolean()
    .optional()
    .describe('Double-click instead of a single click.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_TYPE_SHAPE = {
  ref: z.string().optional().describe('Ref from browser_snapshot.'),
  smartRef: z.number().optional().describe('Ref from browser_smart_snapshot.'),
  text: z.string(),
  submit: z
    .boolean()
    .optional()
    .describe('Press Enter after typing.'),
  humanlike: z
    .boolean()
    .optional()
    .describe('Type with randomised human-like delays.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_FILL_SHAPE = {
  fields: z
    .array(
      z.object({
        ref: z.string().optional(),
        smartRef: z.number().optional(),
        value: z.string(),
      }),
    )
    .describe('{ref (or smartRef), value} pairs to fill.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_PRESS_KEY_SHAPE = {
  key: z
    .string()
    .describe(
      'Examples: Enter, Tab, Escape, ArrowDown, Control+a, Meta+c.',
    ),
  surfaceId: optionalSurfaceId,
};

const BROWSER_HOVER_SHAPE = {
  ref: z.string().describe('Ref from browser_snapshot.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_DRAG_SHAPE = {
  sourceRef: z
    .string()
    .describe('Element to drag from.'),
  targetRef: z.string().describe('Element to drop onto.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_SELECT_SHAPE = {
  ref: z.string().describe('Ref of the <select>.'),
  values: z
    .array(z.string())
    .describe('Option values to select.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_SCROLL_INTO_VIEW_SHAPE = {
  ref: z.string().describe('Ref from browser_snapshot.'),
  surfaceId: optionalSurfaceId,
};

const BROWSER_SCROLL_SHAPE = {
  direction: z.enum(['up', 'down', 'left', 'right']),
  amount: z
    .number()
    .optional()
    .describe('Pixels (default 500); use 99999 to reach the top or bottom.'),
  ref: z
    .string()
    .optional()
    .describe('Scroll inside this element instead of the page.'),
  surfaceId: optionalSurfaceId,
};

/**
 * What to say when a `ref` argument resolves to nothing.
 *
 * There are TWO ref spaces and both print bare numbers: browser_snapshot mints
 * `ref="12"` and browser_smart_snapshot lists `[61] textbox "제목"`. A smart ref
 * passed as `ref` used to come back as "Element with ref=61 not found. Run
 * browser_snapshot to get current refs" — which names neither the mistake nor
 * the fix, and sends the caller to re-snapshot a page that was fine (dogfood
 * 2026-09-04, YouTube Studio). So the message says which space the argument was
 * read in, and — when the number IS live in the other one — which parameter it
 * belongs to instead.
 */
function refNotFound(ref: string): string {
  const smart = /^\d+$/.test(ref) ? getSmartElementByRef(Number(ref)) : null;
  if (smart) {
    return (
      `ref=${ref} is not a browser_snapshot ref, but browser_smart_snapshot lists ${ref} as ` +
      `${smart.role}${smart.name ? ` "${smart.name}"` : ''} — pass it as smartRef, which ` +
      `browser_click, browser_type and browser_fill all accept.`
    );
  }
  return (
    `Element with ref=${ref} not found. This argument is read as a browser_snapshot ref; ` +
    `a number from browser_smart_snapshot goes in smartRef instead. ` +
    `Run browser_snapshot to get current refs.`
  );
}

/**
 * What a hover reports under a touchscreen preset.
 *
 * The move still goes out, deliberately. A touchscreen cannot hover, so the
 * consistent thing would be to refuse — but browser_hover exists to reveal
 * hover-gated UI, and a no-op would turn every such call into a silent failure
 * with no touch equivalent to replace it. So the caller is told what happened
 * instead, and can drop the preset if it wants that fidelity.
 */
const TOUCH_HOVER_NOTE =
  ' — as a mouse move; the emulated device has a touchscreen, which cannot hover';

/**
 * How a click that ran under a touchscreen preset is described.
 *
 * Silent when no preset with touch is active — that is the ordinary case and
 * it reads exactly as it always has. When one IS active, every outcome is
 * named, because "clicked" means two different things on the two paths and a
 * caller emulating a phone is emulating it for a reason.
 */
function dispatchNote(
  touchAvailable: boolean,
  double: boolean | undefined,
  dispatch: 'touch' | 'mouse',
): string {
  if (!touchAvailable) return '';
  if (dispatch === 'touch') return ' (touch tap)';
  if (double) {
    // Two taps in quick succession are their own gesture on a phone, not a
    // dblclick, and inventing a mapping between them would be a guess about
    // what the page meant. The mouse double click is the honest fallback.
    return ' (mouse double click — a touchscreen has no double click)';
  }
  return ' (mouse click — touch dispatch was unavailable for this element)';
}

// ---------------------------------------------------------------------------
// RPC-based interaction helpers (used when Playwright page is unavailable)
// These resolve elements via data-wmux-ref attributes set by browser_snapshot.
// ---------------------------------------------------------------------------

async function rpcEval(expression: string, scope: BrowserTargetScope): Promise<string> {
  const result = await sendScopedBrowserRpc<{ value: string }>('browser.evaluate', scope, {
    expression,
  });
  return result.value;
}

/**
 * Sanitize ref to prevent injection in CSS selectors / JS template literals.
 * Exported so other tool modules that interpolate a ref into injected JS
 * (e.g. browser_highlight in inspection.ts) reuse the same guard.
 */
export function sanitizeRef(ref: string, scope: BrowserTargetScope): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(ref)) throw new Error(`Invalid ref: "${ref}"`);
  // Every `[data-wmux-ref]` resolution in the tool layer — RPC click, fill,
  // hover, drag, select, scroll, scroll-into-view, the password probe, and
  // browser_highlight — passes through here first, which makes this the one
  // place a frame ref can be stopped before it reaches a selector that can
  // only ever match a main-document element. Fail closed: a frame ref has no
  // data-attr representation at all, so attempting it either finds nothing or,
  // worse, finds whatever a previous DOM snapshot tagged with that number.
  //
  // Asked per surface, not globally: another surface's frame refs say nothing
  // about this one's numbering, and refusing on them would block a good DOM
  // ref here for as long as some unrelated page held that number.
  if (isOutstandingFrameRef(browserScopeKey(scope), ref)) {
    throw new Error(frameRefFallbackMessage(ref));
  }
  return ref;
}

/**
 * The subset of Locator / ElementHandle that `clickWithApproach` needs. Both
 * satisfy it, so the two click paths below share one implementation.
 */
interface ApproachTarget {
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  click(options?: { position?: { x: number; y: number }; trial?: boolean }): Promise<void>;
  dblclick(options?: { position?: { x: number; y: number } }): Promise<void>;
  scrollIntoViewIfNeeded?(): Promise<void>;
}

interface ApproachPage {
  mouse: { move(x: number, y: number): Promise<void> };
  viewportSize(): { width: number; height: number } | null;
}

/**
 * Below this, in either dimension, an element is too small to miss the middle
 * of convincingly: the offset would be a pixel or two and the only thing it
 * could achieve is landing on a border.
 */
const MIN_OFFSET_SIZE_PX = 24;

/**
 * Click `el`, but move the pointer there first and land off-centre.
 *
 * A bare `locator.click()` emits one `mousemove` onto the exact centre of the
 * box and presses — a pointer that has never been anywhere else and never
 * misses the middle. This walks the pointer from wherever it last was on this
 * page (see `pointer-path`) and then hands Playwright the landing point as a
 * `position`, so actionability, `force` and `timeout` behave exactly as before
 * and the click does not jump away from where the pointer already is.
 *
 * An element with no box — detached, `display:none`, still animating in — has
 * no path to walk, so it falls straight through to the plain click and lets
 * Playwright's own waiting produce the error or the retry.
 *
 * `tap` is passed when the page is under a device preset with a touchscreen
 * (see `touch-input`). The landing point is computed exactly as it is for the
 * mouse, and then a finger is put on it instead of a cursor. Returns which of
 * the two the click actually went out as, because a fallback to the mouse is
 * something the caller has to be told rather than left to assume.
 */
export async function clickWithApproach(
  page: ApproachPage,
  el: ApproachTarget,
  double: boolean,
  tap?: (point: { x: number; y: number }) => Promise<void>,
): Promise<'touch' | 'mouse'> {
  const plainClick = async (): Promise<'mouse'> => {
    if (double) await el.dblclick();
    else await el.click();
    return 'mouse';
  };

  // Scroll first, THEN measure. A box read before scrolling describes where the
  // element was, so the approach would walk to a point outside the viewport and
  // leave the tracker pointing there.
  if (el.scrollIntoViewIfNeeded) {
    await el.scrollIntoViewIfNeeded().catch(() => {});
  }

  const box = await el.boundingBox().catch(() => null);
  if (!box || box.width <= 0 || box.height <= 0) {
    return plainClick();
  }

  // A small control has no room for a meaningful offset — aim at the centre.
  const target =
    box.width < MIN_OFFSET_SIZE_PX || box.height < MIN_OFFSET_SIZE_PX
      ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      : clickPointInBox(box);

  // Still off-screen, or in a frame whose coordinates we cannot place: a path
  // to a point outside the viewport is worse than no path at all.
  const viewport = page.viewportSize();
  if (
    target.x < 0 ||
    target.y < 0 ||
    (viewport && (target.x > viewport.width || target.y > viewport.height))
  ) {
    return plainClick();
  }

  const position = { x: target.x - box.x, y: target.y - box.y };

  // `!double` as well as `tap`: a double click has no touch equivalent worth
  // inventing, so it stays on the mouse whoever asks for it.
  if (tap && !double) {
    // A touchscreen has no pointer to walk. There is nothing resting on the
    // page between one tap and the next, so the approach path is skipped
    // outright — emitting mouse moves here would be the emulated device
    // producing input it does not have — and `setLastPointer` is skipped with
    // it, because the mouse genuinely did not move.
    //
    // The actionability the mouse path gets from `el.click()` is not given up
    // with it: a trial click runs every one of those checks (attached, visible,
    // stable, enabled, receiving events at this exact point) and dispatches
    // nothing. A trial that refuses means the element is not clickable at all,
    // which is not a touch-specific problem, so the mouse path takes it from
    // there and reports its own error.
    try {
      await el.click({ position, trial: true });
    } catch {
      return plainClick();
    }
    try {
      await tap(target);
      return 'touch';
    } catch {
      // Touch dispatch refused (a transport without it, a target that went
      // away mid-tap). A click that lands is worth more than one that matches
      // the emulated hardware, so fall through rather than fail.
      return plainClick();
    }
  }

  const from = getLastPointer(page) ?? defaultStartPoint(viewport ?? undefined);
  const steps = stepsForDistance(distance(from, target));
  for (const point of pathPoints(from, target, steps)) {
    await page.mouse.move(point.x, point.y);
  }
  setLastPointer(page, target);

  try {
    if (double) await el.dblclick({ position });
    else await el.click({ position });
  } catch {
    // The element moved, something now covers the point we aimed at, or the
    // element is rotated so a point inside its axis-aligned box is outside the
    // element itself. Playwright's own centre-targeted click resolves all
    // three, so give it exactly one go before surfacing the failure.
    await plainClick();
  }
  return 'mouse';
}

async function rpcClick(
  ref: string,
  scope: BrowserTargetScope,
  _double?: boolean,
): Promise<'touch' | 'mouse'> {
  // Use CDP click: first get element coordinates via JS, then dispatch mouse events
  const safeRef = sanitizeRef(ref, scope);
  // The handler decides between a tap and a press — it is the side that knows
  // whether a device preset with a touchscreen is on this WebContents — and
  // names which one it sent.
  const res = await sendScopedBrowserRpc<{ dispatch?: string }>('browser.click.cdp', scope, {
    selector: `[data-wmux-ref="${safeRef}"]`,
  });
  return res?.dispatch === 'touch' ? 'touch' : 'mouse';
}

async function rpcFill(ref: string, value: string, scope: BrowserTargetScope): Promise<void> {
  // Click on the element first to focus it
  await rpcClick(ref, scope);
  // Small delay for focus
  await new Promise(r => setTimeout(r, 100));
  // Select all existing text
  await sendScopedBrowserRpc('browser.evaluate', scope, {
    expression: `document.execCommand('selectAll')`,
  });
  // Type the new value via CDP Input.insertText (handles CJK, React controlled inputs)
  await sendScopedBrowserRpc('browser.type.cdp', scope, {
    text: value,
  });
}

// ---------------------------------------------------------------------------
// Addressing: one element, named three ways
// ---------------------------------------------------------------------------

/**
 * How a caller names the element a typing tool should act on.
 *
 * browser_click has accepted both ref spaces since smart refs existed; the
 * typing tools accepted only `ref`, so a smartRef read off browser_smart_snapshot
 * came back as "not found" and there was no second thing to try (dogfood
 * 2026-09-04). They now resolve exactly the way browser_click does.
 */
interface RefAddress {
  ref?: string;
  smartRef?: number;
}

/**
 * The slice of ElementHandle / Locator the typing tools use.
 *
 * A ref resolves to an ElementHandle and a smartRef to a Locator; both carry
 * these three methods with the same meaning, so one code path serves both.
 */
interface TypeTarget {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  evaluate(fn: (node: Element) => boolean): Promise<boolean>;
}

/** Reject an address that names no element, or two. */
function requireOneTarget(addr: RefAddress, tool: string): void {
  const given = [addr.ref !== undefined, addr.smartRef !== undefined].filter(Boolean).length;
  if (given === 0) {
    throw new Error(
      `${tool} needs ref (from browser_snapshot) or smartRef (from browser_smart_snapshot).`,
    );
  }
  if (given > 1) {
    throw new Error(`${tool} takes ref or smartRef, not both — they name one element two ways.`);
  }
}

/** Resolve an address on the Playwright lane. Throws with the reason it failed. */
async function resolveTypeTarget(page: Page, addr: RefAddress): Promise<TypeTarget> {
  if (addr.smartRef !== undefined) {
    // Throws StaleSmartRefError rather than typing into a substitute — the same
    // guarantee browser_click({smartRef}) gives.
    return (await resolveSmartRefLocator(page, addr.smartRef)) as unknown as TypeTarget;
  }
  const el = await resolveRef(page, addr.ref as string);
  if (!el) throw new Error(refNotFound(addr.ref as string));
  return el as unknown as TypeTarget;
}

/** The ref the RPC lane resolves an address through (its only addressing mode). */
function rpcRefFor(addr: RefAddress): string {
  return addr.ref ?? String(addr.smartRef);
}

/** How an address reads back in a tool result. */
function describeAddress(addr: RefAddress): string {
  return addr.ref !== undefined ? `ref=${addr.ref}` : `smartRef=${addr.smartRef}`;
}

/**
 * How a step addressed this way is recorded, mirroring browser_click.
 *
 * A smartRef's stored "locator" is getByRole SOURCE TEXT on the CDP lane, which
 * `page.locator()` cannot parse — so it is recorded on the ref axis instead, and
 * only the RPC lane's real CSS selector is recorded as a selector.
 */
function targetForRecord(
  addr: RefAddress,
): { ref: string } | { refEntry: NonNullable<ReturnType<typeof smartRefAxisEntry>> } | { selector: string } | Record<string, never> {
  if (addr.ref !== undefined) return { ref: addr.ref };
  if (addr.smartRef !== undefined) {
    const entry = smartRefAxisEntry(addr.smartRef);
    if (entry) return { refEntry: entry };
    const css = getLocatorByRef(addr.smartRef);
    if (css) return { selector: css };
  }
  return {};
}

/**
 * Is the element behind `ref` a password field?
 *
 * browser_type echoes the text it typed back to the agent, which puts the value
 * in the transcript (and the logs) a second time. That is fine for a search box
 * and not fine for a credential, so the echo asks the element first. Both
 * transports run the SAME predicate source (redact.ts) — Playwright serialises
 * the function, RPC interpolates its text.
 *
 * Fails open (false) on any resolution error: an unmasked echo of what the
 * agent itself just sent is the pre-existing behaviour, whereas a failed lookup
 * must not turn into a failed browser_type.
 */
async function isPasswordElement(el: TypeTarget | ElementHandle): Promise<boolean> {
  try {
    // Main world, deliberately: the predicate is scoped to an ElementHandle,
    // and a handle belongs to the world it was resolved in — there is no way
    // to hand it to an isolated context. It reads two properties off the node
    // it was given and touches no page global, so the exposure is a property
    // read a page could equally observe from its own input listener.
    return await el.evaluate(isPasswordFieldNode);
  } catch {
    return false;
  }
}

/** Same question over the RPC transport, resolved through the data-wmux-ref tag. */
async function rpcIsPasswordElement(ref: string, scope: BrowserTargetScope): Promise<boolean> {
  try {
    const safeRef = sanitizeRef(ref, scope);
    const val = await rpcEval(`(() => {
      const isPasswordField = ${PASSWORD_FIELD_PREDICATE_JS};
      return isPasswordField(document.querySelector('[data-wmux-ref="${safeRef}"]')) ? 'yes' : 'no';
    })()`, scope);
    return val === 'yes';
  } catch {
    return false;
  }
}

async function rpcPressKey(key: string, scope: BrowserTargetScope): Promise<void> {
  await sendScopedBrowserRpc('browser.press.cdp', scope, {
    key,
  });
}

/**
 * Grace period for a popup that Chrome reports a beat after the click resolves.
 * Deliberately tiny and one-shot: `waitForEvent('popup')` would tax EVERY click
 * with its full timeout, and a click that opens nothing is the common case.
 */
const POPUP_GRACE_MS = 50;
/**
 * How long a popup may stay on about:blank before we report it anyway.
 * window.open() hands back a blank document and navigates a beat later, so
 * reading the URL synchronously names nothing useful — but a popup that never
 * leaves about:blank is a real outcome too, and worth reporting as such.
 */
const POPUP_URL_SETTLE_MS = 500;
const POPUP_URL_POLL_MS = 50;
/** Popup URLs are page-controlled text; cap what goes into the result. */
const POPUP_URL_MAX_CHARS = 200;

function isBlankUrl(url: string | undefined): boolean {
  return !url || url === 'about:blank';
}

/**
 * Watch one click for a popup (window.open / target=_blank).
 *
 * mirrors browser-use tools/service.py _detect_new_tab_opened, but built on
 * Playwright's own 'popup' event rather than a before/after tab-id diff: a diff
 * over getAllPages() attributes ANY workspace's newly opened page to this
 * click, which is exactly the cross-workspace mis-attribution page scoping
 * exists to prevent.
 *
 * CHROME BACKEND ONLY. The builtin webview loads popups into the SAME webview
 * (src/main/index.ts new-window handling), so no 'popup' ever fires there, and
 * the RPC lane has no Page to listen on. Both keep their previous behaviour.
 *
 * The popup is NOT a wmux surface: only tabs opened through ChromeLauncher.openTab
 * get a `chrome-<uuid>` surfaceId, and a page-opened target is never registered
 * (verified in ChromeLauncher.noteTabPage — a tab wmux does not own is ignored).
 * So the note names the URL and stops there; it must not imply the popup can be
 * targeted by surfaceId.
 *
 * `dispose()` is separate from `note()` and MUST run in a finally: a click that
 * throws (a ref that vanished, a navigation mid-click) would otherwise leave
 * the listener — and the closure holding the popup handle — attached to the
 * page for the rest of its life.
 */
function watchForPopup(page: { on: Function; off: Function }): {
  note: () => Promise<string>;
  dispose: () => void;
} {
  let popup: { url?: () => string } | undefined;
  let fired = false;
  const onPopup = (opened: { url?: () => string }) => {
    fired = true;
    popup = opened;
  };
  page.on('popup', onPopup);

  const readUrl = (): string | undefined => {
    try {
      return popup?.url?.();
    } catch {
      return undefined; // popup torn down before we could read it
    }
  };

  return {
    dispose: () => {
      try {
        page.off('popup', onPopup);
      } catch {
        /* page already closed */
      }
    },
    note: async () => {
      if (!fired) await new Promise((r) => setTimeout(r, POPUP_GRACE_MS));
      if (!fired) return '';

      // window.open() resolves before the popup navigates, so poll briefly for
      // the real URL rather than reporting the blank placeholder.
      let url = readUrl();
      const deadline = Date.now() + POPUP_URL_SETTLE_MS;
      while (isBlankUrl(url) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POPUP_URL_POLL_MS));
        url = readUrl();
      }

      // Page-controlled text lands in the transcript, so it gets the same
      // treatment every other URL wmux echoes does: password params masked,
      // then a hard length cap.
      const shown = url
        ? redactPasswordParams(url).slice(0, POPUP_URL_MAX_CHARS)
        : 'unknown url';
      return ` — opened a popup (page: ${shown}). It is not a wmux surface; use browser_tabs to see what this workspace owns.`;
    },
  };
}

/**
 * Register interaction-related MCP tools on the given server.
 *
 * Tools:
 *  - browser_click            — click or double-click an element
 *  - browser_type             — type text into an element
 *  - browser_fill             — fill multiple form fields at once
 *  - browser_press_key        — press a keyboard key
 *  - browser_hover            — hover over an element
 *  - browser_drag             — drag from source to target element
 *  - browser_select           — select option(s) in a <select>
 *  - browser_scroll_into_view — scroll element into viewport
 */
export function registerInteractionTools(server: McpServer, deps: BrowserToolDeps): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_click
  // -----------------------------------------------------------------------
  server.tool(
    'browser_click',
    'Click an element by ref (browser_snapshot) or smartRef (browser_smart_snapshot), or — when neither is available — at x/y. Coordinates are VIEWPORT CSS PIXELS: divide a browser_screenshot pixel by the devicePixelRatio that shot reports. A fullPage or element screenshot is in a different coordinate space and cannot be used for x/y at all. Coordinates need a live page (chrome backend); the RPC lane is ref-only.',
    BROWSER_CLICK_SHAPE,
    async ({ ref, smartRef, x, y, double, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        // Coordinate clicking is an ESCAPE HATCH, not a second addressing mode:
        // a ref survives a re-render and a coordinate does not, so a call that
        // carries both is a mistake worth refusing rather than silently
        // resolving in favour of one.
        // mirrors browser-use tools/service.py coordinate clicking (set_coordinate_clicking)
        const hasCoords = x !== undefined || y !== undefined;
        if (hasCoords && (ref !== undefined || smartRef !== undefined)) {
          throw new Error(
            'Pass either ref/smartRef or x/y, not both — a ref survives a re-render and a coordinate does not.',
          );
        }
        if (hasCoords && (x === undefined || y === undefined)) {
          throw new Error('Coordinate clicks need both x and y (viewport CSS pixels).');
        }

        // Try Playwright first. The rejection is kept: on the coordinate path
        // "no page" is reported to the caller, and "the page navigated away" or
        // "the browser crashed" must not be dressed up as a backend limitation.
        let pageError: unknown;
        const page = await engine.getPageForScope(scope).catch((error) => {
          pageError = error;
          return allowScopedRpcFallback(error);
        });

        if (hasCoords) {
          if (!page) {
            const cause = pageError ? ` (${describeToolError(pageError)})` : '';
            throw new Error(
              `Coordinate clicks need a live browser page, which this workspace's backend did not provide${cause}. The RPC lane resolves elements by ref only — switch the workspace to the chrome backend, or click by ref from browser_snapshot.`,
            );
          }

          // Refuse a coordinate the viewport does not contain instead of
          // clicking nothing and reporting success. viewportSize() can be null
          // on a CDP-attached page; only the negative check applies then.
          if ((x as number) < 0 || (y as number) < 0) {
            throw new Error(`Coordinates must be inside the viewport; got (${x}, ${y}).`);
          }
          let viewport = (page as unknown as { viewportSize?: () => { width: number; height: number } | null })
            .viewportSize?.();
          if (!viewport) {
            // viewportSize() is null for a page reached over connectOverCDP —
            // which is EVERY page on the chrome backend, i.e. the only backend
            // where coordinate clicks run at all. Without this fallback the
            // bounds check was dead exactly where it matters (live dogfood:
            // x=99999 reported success). The page's own innerWidth/innerHeight
            // is the same CSS-pixel space x/y are defined in.
            const size = await evaluateIsolated(
              page,
              '[window.innerWidth, window.innerHeight]',
            ).catch(() => null);
            if (Array.isArray(size) && typeof size[0] === 'number' && typeof size[1] === 'number') {
              viewport = { width: size[0], height: size[1] };
            }
          }
          if (viewport && ((x as number) > viewport.width || (y as number) > viewport.height)) {
            throw new Error(
              `Coordinates (${x}, ${y}) are outside the ${viewport.width}x${viewport.height} viewport (CSS px). Scroll the target into view first, or take a fresh screenshot.`,
            );
          }

          // Same popup contract as a ref click — a coordinate click on a link
          // with target=_blank opens a popup just as readily.
          const coordWatch =
            (await engine.resolveWorkspaceBackend(scope.workspaceId).catch(() => undefined)) ===
            'chrome'
              ? watchForPopup(page as unknown as { on: Function; off: Function })
              : null;
          try {
            await page.mouse.click(x as number, y as number, {
              ...(double && { clickCount: 2 }),
            });
            // Keep the tracker honest: the next ref click should approach from
            // here, not from wherever the pointer was before this one.
            setLastPointer(page, { x: x as number, y: y as number });
            const note = coordWatch ? await coordWatch.note() : '';
            // Coordinate clicks are deliberately NOT recorded: a coordinate
            // does not survive a re-render, so a trace built on one replays a
            // click into whatever has moved under it. The escape hatch stays
            // an escape hatch.
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Clicked${double ? ' (double)' : ''} at viewport CSS px (${x}, ${y})${note}`,
                },
              ],
            };
          } finally {
            coordWatch?.dispose();
          }
        }

        if (page) {
          // A popup can only be observed on the chrome backend (see
          // watchForPopup); everything else clicks exactly as before.
          const watchesPopups =
            (await engine.resolveWorkspaceBackend(scope.workspaceId).catch(() => undefined)) ===
            'chrome';
          const popupWatch = watchesPopups
            ? watchForPopup(page as unknown as { on: Function; off: Function })
            : null;
          const popupNote = async () => (popupWatch ? await popupWatch.note() : '');

          // Under a device preset with a touchscreen the click goes out as a
          // real touch sequence rather than a mouse press — the page reported
          // `maxTouchPoints: 5` and `(pointer: coarse)` the moment the preset
          // was applied, and a mouse event under that identity contradicts it.
          // Resolved once here so both ref shapes take the same path.
          const tapper = touchTapFor(page);
          const tap = double ? undefined : tapper;

          try {
            if (smartRef !== undefined) {
              // Ref-keyed, not `cache[smartRef - 1]`: smart refs are keyed on
              // DOM node identity now, so the cache is no longer a dense 1..n
              // range. Throws StaleSmartRefError rather than clicking a
              // substitute when the ref no longer names one live element.
              const locator = await resolveSmartRefLocator(page, smartRef);
              const dispatch = await clickWithApproach(
                page as unknown as ApproachPage,
                locator,
                !!double,
                tap,
              );
              // A ref axis, not the css axis this used to record: the CDP
              // lane's stored "locator" is getByRole SOURCE TEXT, which
              // page.locator() cannot parse, so every replay of such a step
              // failed while the live click succeeded. The RPC lane's selector
              // is a real one and stays a css axis.
              const axisEntry = smartRefAxisEntry(smartRef);
              const selector = axisEntry ? undefined : getLocatorByRef(smartRef) ?? undefined;
              recordAction(deps, {
                scope,
                tool: 'browser_click',
                page,
                ...(axisEntry ? { refEntry: axisEntry } : { selector }),
                ...(double && { args: { double: true } }),
              });
              return {
                content: [{ type: 'text' as const, text: `Clicked${double ? ' (double)' : ''} element smartRef=${smartRef}${dispatchNote(!!tapper, double, dispatch)}${await popupNote()}` }],
              };
            }

            if (!ref) throw new Error('Either ref or smartRef must be provided.');

            const el = await resolveRef(page, ref);
            if (!el) throw new Error(refNotFound(ref));
            const dispatch = await clickWithApproach(
              page as unknown as ApproachPage,
              el,
              !!double,
              tap,
            );
            recordAction(deps, {
              scope,
              tool: 'browser_click',
              page,
              ref,
              ...(double && { args: { double: true } }),
            });
            return {
              content: [{ type: 'text' as const, text: `Clicked${double ? ' (double)' : ''} element ref=${ref}${dispatchNote(!!tapper, double, dispatch)}${await popupNote()}` }],
            };
          } finally {
            // Every exit — success, a ref that vanished, a click that threw —
            // detaches the listener.
            popupWatch?.dispose();
          }
        }

        // RPC fallback
        if (!ref && smartRef === undefined) throw new Error('Either ref or smartRef must be provided.');
        const resolvedRef = ref ?? String(smartRef);
        const rpcDispatch = await rpcClick(resolvedRef, scope, double);
        recordAction(deps, { scope, tool: 'browser_click', page: null, ref: resolvedRef });
        return {
          content: [{ type: 'text' as const, text: `Clicked${double ? ' (double)' : ''} element ref=${resolvedRef}${rpcDispatch === 'touch' ? ' (touch tap)' : ''}` }],
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
  // browser_type
  // -----------------------------------------------------------------------
  server.tool(
    'browser_type',
    'Type text into an element by ref or smartRef, replacing any existing value. Typing into a password field echoes "[redacted:password]" back — the text still went in.',
    BROWSER_TYPE_SHAPE,
    async ({ ref, smartRef, text, submit, humanlike, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const addr: RefAddress = { ...(ref !== undefined && { ref }), ...(smartRef !== undefined && { smartRef }) };
        requireOneTarget(addr, 'browser_type');
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        // Decided BEFORE typing: the field is addressable now, and a submit can
        // navigate the page out from under a later lookup.
        let isPassword: boolean;

        if (page) {
          const el = await resolveTypeTarget(page, addr);
          isPassword = await isPasswordElement(el);
          if (humanlike) {
            await el.click();
            await typeHumanlike(page, '', text);
          } else {
            await el.fill(text);
          }
          if (submit) await page.keyboard.press('Enter');
        } else {
          // RPC fallback
          const rpcRef = rpcRefFor(addr);
          isPassword = await rpcIsPasswordElement(rpcRef, scope);
          await rpcFill(rpcRef, text, scope);
          if (submit) await rpcPressKey('Enter', scope);
        }

        // The typed text is echoed so the agent can see what landed in the
        // field — except when the field is a credential, where the echo would
        // only re-enter the value into the transcript and the logs.
        const echoed = isPassword ? REDACTED_PASSWORD : text;

        // A password step is recorded as a HOLE, never as a step carrying its
        // own value: the text does not enter the ring, so it cannot reach the
        // save handler, the put RPC, or the cache file. The step is still
        // listed so the flow reads honestly and refuses to run — silently
        // dropping it would produce a trace that "logs in" without a password
        // and reports success.
        recordAction(deps, {
          scope,
          tool: 'browser_type',
          page,
          ...targetForRecord(addr),
          args: isPassword ? {} : { text, ...(submit && { submit: true }) },
          ...(isPassword && { unrecordable: 'password' as const }),
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Typed "${echoed}" into element ${describeAddress(addr)}${submit ? ' and submitted' : ''}`,
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
  // browser_fill
  // -----------------------------------------------------------------------
  server.tool(
    'browser_fill',
    'Fill multiple form fields at once, each by ref or smartRef.',
    BROWSER_FILL_SHAPE,
    async ({ fields, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        let filled = 0;
        const errors: string[] = [];
        // Which fields were credentials. Decided per field BEFORE the fill, the
        // same rule and the same predicate browser_type uses: a form filled in
        // one call may well be a login form, and recording it wholesale would
        // put the password into the trace that browser_type is careful never to
        // put there (panel review conf10 — the two tools have to give the same
        // guarantee or the guarantee is worthless).
        const isPassword: boolean[] = [];

        for (let i = 0; i < fields.length; i++) {
          const field = fields[i];
          const addr: RefAddress = {
            ...(field.ref !== undefined && { ref: field.ref }),
            ...(field.smartRef !== undefined && { smartRef: field.smartRef }),
          };
          try {
            requireOneTarget(addr, 'browser_fill');
            if (page) {
              const el = await resolveTypeTarget(page, addr);
              isPassword[i] = await isPasswordElement(el);
              await el.fill(field.value);
            } else {
              const rpcRef = rpcRefFor(addr);
              isPassword[i] = await rpcIsPasswordElement(rpcRef, scope);
              await rpcFill(rpcRef, field.value, scope);
            }
            filled++;
          } catch (err) {
            errors.push(describeToolError(err));
          }
        }

        // Recorded only when EVERY field landed: a partially filled form
        // replayed as if it were whole is a wrong run that reports success.
        if (filled === fields.length && fields.length > 0) {
          for (let i = 0; i < fields.length; i++) {
            const credential = isPassword[i] === true;
            recordAction(deps, {
              scope,
              tool: 'browser_fill',
              page,
              ...targetForRecord({
                ...(fields[i].ref !== undefined && { ref: fields[i].ref }),
                ...(fields[i].smartRef !== undefined && { smartRef: fields[i].smartRef }),
              }),
              args: credential ? {} : { value: fields[i].value },
              ...(credential && { unrecordable: 'password' as const }),
            });
          }
        }

        let resultText = `Filled ${filled}/${fields.length} field(s).`;
        if (errors.length > 0) {
          resultText += '\nErrors:\n' + errors.join('\n');
        }

        return {
          content: [{ type: 'text' as const, text: resultText }],
          ...(errors.length > 0 && filled === 0 ? { isError: true } : {}),
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
  // browser_press_key
  // -----------------------------------------------------------------------
  server.tool(
    'browser_press_key',
    'Press a keyboard key.',
    BROWSER_PRESS_KEY_SHAPE,
    async ({ key, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        if (page) {
          await page.keyboard.press(key);
        } else {
          await rpcPressKey(key, scope);
        }

        recordAction(deps, { scope, tool: 'browser_press_key', page, args: { key } });

        return {
          content: [{ type: 'text' as const, text: `Pressed key: ${key}` }],
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
  // browser_hover
  // -----------------------------------------------------------------------
  server.tool(
    'browser_hover',
    'Hover over an element by ref.',
    BROWSER_HOVER_SHAPE,
    async ({ ref, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);
        let touchNote = '';

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) throw new Error(refNotFound(ref));
          if (hasTouchEmulation(page)) touchNote = TOUCH_HOVER_NOTE;
          await el.hover();
        } else {
          // RPC fallback: real pointer movement over CDP Input. The synthetic
          // MouseEvent this replaces arrived with isTrusted === false, which any
          // handler on the page can read — a single boolean separating our
          // hover from every hover a person performs.
          const safeRef = sanitizeRef(ref, scope);
          const res = await sendScopedBrowserRpc<{ touchPreset?: boolean }>(
            'browser.hover.cdp',
            scope,
            { selector: `[data-wmux-ref="${safeRef}"]` },
          );
          if (res?.touchPreset) touchNote = TOUCH_HOVER_NOTE;
        }

        recordAction(deps, { scope, tool: 'browser_hover', page, ref });

        return {
          content: [{ type: 'text' as const, text: `Hovered over element ref=${ref}${touchNote}` }],
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
  // browser_drag
  // -----------------------------------------------------------------------
  server.tool(
    'browser_drag',
    'Drag an element from sourceRef to targetRef.',
    BROWSER_DRAG_SHAPE,
    async ({ sourceRef, targetRef, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);
        let dragNote = '';

        if (page) {
          const sourceEl = await resolveRef(page, sourceRef);
          if (!sourceEl) throw new Error(refNotFound(sourceRef));
          const targetEl = await resolveRef(page, targetRef);
          if (!targetEl) throw new Error(refNotFound(targetRef));

          const sourceBox = await sourceEl.boundingBox();
          const targetBox = await targetEl.boundingBox();
          if (!sourceBox || !targetBox) {
            throw new Error('Could not determine bounding box for source or target element.');
          }

          const sourceX = sourceBox.x + sourceBox.width / 2;
          const sourceY = sourceBox.y + sourceBox.height / 2;
          const targetX = targetBox.x + targetBox.width / 2;
          const targetY = targetBox.y + targetBox.height / 2;

          // A drag under a touchscreen preset is a finger sliding across the
          // glass: press, a bounded run of moves, lift — the same three phases
          // the mouse performs below, on the input the emulated device has.
          // Both endpoints are already measured, so nothing else is needed.
          const touchDrag = touchDragFor(page);
          let dragged = false;
          if (touchDrag) {
            try {
              await touchDrag({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
              dragged = true;
              dragNote = ' (touch drag)';
            } catch {
              // Touch dispatch refused; the mouse drag below still performs the
              // gesture, and the note says which one the page actually saw.
              dragNote = ' (mouse drag — touch dispatch was unavailable)';
            }
          }

          if (!dragged) {
            await page.mouse.move(sourceX, sourceY);
            await page.mouse.down();
            await page.mouse.move(targetX, targetY, { steps: 10 });
            await page.mouse.up();
          }
        } else {
          // RPC fallback: press, move, release over CDP Input — the same shape
          // as the Playwright path above. The synthesised DragEvents this
          // replaces were untrusted, and they also never reached anything built
          // on pointer events rather than HTML5 drag-and-drop.
          const safeSrc = sanitizeRef(sourceRef, scope);
          const safeTgt = sanitizeRef(targetRef, scope);
          const res = await sendScopedBrowserRpc<{ dispatch?: string }>('browser.drag.cdp', scope, {
            sourceSelector: `[data-wmux-ref="${safeSrc}"]`,
            targetSelector: `[data-wmux-ref="${safeTgt}"]`,
          });
          if (res?.dispatch === 'touch') dragNote = ' (touch drag)';
        }

        recordAction(deps, { scope, tool: 'browser_drag', page, ref: sourceRef, targetRef });

        return {
          content: [{ type: 'text' as const, text: `Dragged element ref=${sourceRef} to ref=${targetRef}${dragNote}` }],
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
  // browser_select
  // -----------------------------------------------------------------------
  server.tool(
    'browser_select',
    'Select option(s) in a <select> element by value.',
    BROWSER_SELECT_SHAPE,
    async ({ ref, values, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) throw new Error(refNotFound(ref));
          await el.selectOption(values);
        } else {
          // Deliberately still a DOM assignment, unlike hover and drag above.
          // A native <select> opens an OS-drawn popup that lives outside the
          // page — CDP Input events go to the document, not to that popup, so
          // there is no mouse sequence that reliably picks an option. Setting
          // `selected` and firing `change` is the only path that works here;
          // the trade-off is that the change event carries isTrusted === false.
          const safeRef = sanitizeRef(ref, scope);
          const escapedValues = JSON.stringify(values);
          const val = await rpcEval(`(() => {
            const el = document.querySelector('[data-wmux-ref="${safeRef}"]');
            if (!el || el.tagName !== 'SELECT') return 'not_found';
            const vals = ${escapedValues};
            [...el.options].forEach(o => { o.selected = vals.includes(o.value); });
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'ok';
          })()`, scope);
          if (val === 'not_found') throw new Error(refNotFound(ref));
        }

        recordAction(deps, {
          scope,
          tool: 'browser_select',
          page,
          ref,
          args: { values: values.join('\u0000') },
        });

        return {
          content: [{ type: 'text' as const, text: `Selected value(s) [${values.join(', ')}] in element ref=${ref}` }],
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
  // browser_scroll_into_view
  // -----------------------------------------------------------------------
  server.tool(
    'browser_scroll_into_view',
    'Scroll an element into the visible viewport.',
    BROWSER_SCROLL_INTO_VIEW_SHAPE,
    async ({ ref, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) throw new Error(refNotFound(ref));
          await el.scrollIntoViewIfNeeded();
        } else {
          const safeRef = sanitizeRef(ref, scope);
          const val = await rpcEval(`(() => {
            const el = document.querySelector('[data-wmux-ref="${safeRef}"]');
            if (!el) return 'not_found';
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return 'ok';
          })()`, scope);
          if (val === 'not_found') throw new Error(refNotFound(ref));
        }

        recordAction(deps, { scope, tool: 'browser_scroll_into_view', page, ref });

        return {
          content: [{ type: 'text' as const, text: `Scrolled element ref=${ref} into view` }],
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
  // browser_scroll
  // -----------------------------------------------------------------------
  server.tool(
    'browser_scroll',
    'Scroll the page, or a scrollable element when ref is given.',
    BROWSER_SCROLL_SHAPE,
    async ({ direction, amount, ref, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      const px = amount ?? 500;
      const deltaX = direction === 'right' ? px : direction === 'left' ? -px : 0;
      const deltaY = direction === 'down' ? px : direction === 'up' ? -px : 0;
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        if (page) {
          if (ref) {
            const el = await resolveRef(page, ref);
            if (!el) throw new Error(refNotFound(ref));
            // Main world, deliberately: element-scoped, and an ElementHandle
            // cannot be adopted into an isolated context (see isolated-eval.ts).
            await el.evaluate(
              (node, [dx, dy]) => { (node as Element).scrollBy(dx, dy); },
              [deltaX, deltaY] as [number, number],
            );
          } else {
            await evaluateIsolated<void, [number, number]>(
              page,
              ([dx, dy]) => { window.scrollBy(dx, dy); },
              [deltaX, deltaY],
            );
          }
        } else {
          // RPC fallback
          if (ref) {
            const safeRef = sanitizeRef(ref, scope);
            await rpcEval(`(() => {
              const el = document.querySelector('[data-wmux-ref="${safeRef}"]');
              if (!el) return 'not_found';
              el.scrollBy(${deltaX}, ${deltaY});
              return 'ok';
            })()`, scope);
          } else {
            await rpcEval(`(() => {
              window.scrollBy(${deltaX}, ${deltaY});
              return 'ok';
            })()`, scope);
          }
        }

        recordAction(deps, {
          scope,
          tool: 'browser_scroll',
          page,
          ...(ref !== undefined && { ref }),
          args: { direction, amount: px },
        });

        return {
          content: [{ type: 'text' as const, text: `Scrolled ${direction} by ${px}px${ref ? ` (element ref=${ref})` : ''}` }],
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
