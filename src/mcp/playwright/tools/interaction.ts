import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { leasedMutation } from '../automationLease';
import {
  browserScopeKey,
  frameRefFallbackMessage,
  isOutstandingFrameRef,
  resolveRef,
} from '../snapshot';
import {
  getLocatorByRef,
  getSmartElementOnPage,
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
  type Point,
} from '../pointer-path';
import { hasTouchEmulation, touchDragFor, touchTapFor } from '../touch-input';
import { describeToolError } from '../toolError';
import {
  EFFECT_TRAILER_NOTE,
  taggedFailure,
  withEffectTrailer,
  type EffectState,
} from '../resultTrailer';
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
import { getScreenshotScale } from '../screenshotRefs';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Omit for the surface you opened last.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.

// Keys held for the length of a mouse gesture. Validated by the enum only: the
// array bounds are checked in the handler, since every zod modifier costs bytes
// in tools/list.
const modifiersParam = z
  .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
  .optional()
  .describe('Keys held during the gesture.');

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
  imageX: z
    .number()
    .optional()
    .describe('Pixel read off the last browser_screenshot; divided by that capture\'s scale. Needs imageY.'),
  imageY: z
    .number()
    .optional()
    .describe('Pixel read off the last browser_screenshot; divided by that capture\'s scale. Needs imageX.'),
  smartRef: z
    .number()
    .optional()
    .describe('Ref from browser_smart_snapshot; takes priority over ref.'),
  double: z
    .boolean()
    .optional()
    .describe('Double-click instead of a single click.'),
  modifiers: modifiersParam,
  surfaceId: optionalSurfaceId,
};

const BROWSER_TYPE_SHAPE = {
  ref: z.string().optional().describe('Ref from browser_snapshot.'),
  smartRef: z.number().optional().describe('Ref from browser_smart_snapshot.'),
  selector: z
    .string()
    .optional()
    .describe('CSS only (no text=/xpath=), matching exactly one element no snapshot gave a ref.'),
  text: z.string(),
  newline: z
    .enum(['literal', 'enter', 'shift-enter'])
    .optional()
    .describe('How a \\n is sent: literal (default) or a real keypress between the lines.'),
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
    .optional()
    .describe('Element to drag from.'),
  targetRef: z.string().optional().describe('Element to drop onto.'),
  path: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .optional()
    .describe('2-50 viewport CSS px points, instead of refs.'),
  modifiers: modifiersParam,
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
  x: z.number().optional().describe('Wheel at viewport CSS px x,y instead.'),
  y: z.number().optional(),
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
 *
 * `page` scopes that second half. The smart-snapshot record is per connection,
 * not per page, so without it a stale record from another tab would name an
 * element this page does not have and point the caller at a parameter that
 * cannot work either.
 */
function refNotFound(ref: string, page: Page | null): string {
  const smart = /^\d+$/.test(ref) ? getSmartElementOnPage(Number(ref), page) : null;
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
 * A parameter refusal: the arguments are the fix, and nothing reached the page.
 * Tagged so the result's `error_code` is the branch's own verdict rather than a
 * guess read off wording that may be reworded tomorrow (see resultTrailer.ts).
 */
function badArgs(message: string): Error {
  return taggedFailure('invalid_params', message);
}

/** A `ref` that resolved to nothing, worded by refNotFound. */
function refMissing(ref: string, page: Page | null, effect?: EffectState): Error {
  return taggedFailure('ref_not_found', refNotFound(ref, page), effect);
}

/**
 * What browser_select says about an element that is not a native `<select>`.
 *
 * Custom dropdowns — a `div` with `role=combobox` over a `role=listbox` — are
 * out of this tool's reach by construction: there are no `<option>` elements to
 * set `selected` on, and the widget's own JS owns the value. The two-click
 * sequence IS the supported way, and naming it turns a dead end into the next
 * step (#1360). Before, Playwright's "Element is not a <select> element" and
 * the RPC lane's "ref not found" both sent the caller back to re-snapshot a
 * page that was perfectly fine.
 */
function notNativeSelect(ref: string): string {
  return (
    `ref=${ref} is not a native <select>; click the trigger then the option. ` +
    `browser_select only drives <select>/<option>. For a custom dropdown: ` +
    `browser_click the trigger, browser_snapshot to get the option refs, then ` +
    `browser_click the option.`
  );
}

/** Playwright's refusal for selectOption on a non-`<select>` element. */
function notASelectElement(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not a <select> element|Element is not a select/i.test(message);
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

/**
 * Why a pointer gesture addressed by coordinates (or holding keys) cannot run
 * without a live page. One wording for every such gesture, so the RPC lane
 * refuses them all the way it has always refused a coordinate click.
 */
function livePageRequired(what: string, pageError: unknown, instead: string): string {
  const cause = pageError ? ` (${describeToolError(pageError)})` : '';
  return `${what} need a live browser page, which this workspace's backend did not provide${cause}. The RPC lane resolves elements by ref only — switch the workspace to the chrome backend, or ${instead}.`;
}

const TOUCH_MODIFIERS_REFUSAL =
  'Modifier keys are held for mouse gestures only, and a device preset with a touchscreen is active on this page. Reset the preset with browser_emulate, or drop modifiers.';

/**
 * The distinct modifier keys asked for, or undefined when none were. Refused
 * outright where they cannot be honoured — no page to hold keys on, or a
 * touchscreen preset where the gesture is not a mouse gesture at all — rather
 * than performing the gesture without them.
 */
function modifierKeysFor(
  modifiers: readonly string[] | undefined,
  page: Page | null,
  pageError: unknown,
  instead: string,
): string[] | undefined {
  if (!modifiers || modifiers.length === 0) return undefined;
  if (!page) {
    throw taggedFailure('not_supported', livePageRequired('Modifier keys', pageError, instead));
  }
  if (hasTouchEmulation(page)) throw taggedFailure('not_supported', TOUCH_MODIFIERS_REFUSAL);
  return [...new Set(modifiers)];
}

/**
 * Run `gesture` with `keys` held down. Every key that went down gets its
 * release attempt, whatever happened, so a gesture that throws never leaves
 * the page with a stuck Shift that turns the next click into a range selection.
 *
 * A release that fails after a SUCCESSFUL gesture is reported: the gesture
 * happened, but the page may still be holding that key, and saying "done"
 * would hide it. When the gesture itself threw, that error is the one worth
 * reporting and a release failure on top of it is dropped.
 */
async function withModifiers<T>(
  page: Page,
  keys: readonly string[] | undefined,
  gesture: () => Promise<T>,
): Promise<T> {
  if (!keys) return gesture();
  const held: string[] = [];
  const releaseAll = async (): Promise<{ failed: boolean; error?: unknown }> => {
    let outcome: { failed: boolean; error?: unknown } = { failed: false };
    for (const key of held.reverse()) {
      try {
        await page.keyboard.up(key);
      } catch (error) {
        if (!outcome.failed) outcome = { failed: true, error };
      }
    }
    return outcome;
  };
  let result: T;
  try {
    for (const key of keys) {
      await page.keyboard.down(key);
      held.push(key);
    }
    result = await gesture();
  } catch (error) {
    await releaseAll();
    throw error;
  }
  const release = await releaseAll();
  if (release.failed) throw release.error;
  return result;
}

/** ` with Shift+Meta held`, or nothing. */
function modifiersNote(keys: readonly string[] | undefined): string {
  return keys ? ` with ${keys.join('+')} held` : '';
}

/**
 * A bounds check for viewport CSS px points on `page`, resolved once so a
 * 50-point path does not read the viewport 50 times.
 *
 * viewportSize() is null for a page reached over connectOverCDP — which is
 * EVERY page on the chrome backend, i.e. the only backend where coordinate
 * gestures run at all. Without the innerWidth/innerHeight fallback the bounds
 * check was dead exactly where it matters (live dogfood: x=99999 reported
 * success). When neither source reports a size only the negative check applies.
 */
async function viewportBoundsCheck(page: Page): Promise<(x: number, y: number) => void> {
  let viewport = (page as unknown as { viewportSize?: () => { width: number; height: number } | null })
    .viewportSize?.();
  if (!viewport) {
    const size = await evaluateIsolated(
      page,
      '[window.innerWidth, window.innerHeight]',
    ).catch(() => null);
    if (Array.isArray(size) && typeof size[0] === 'number' && typeof size[1] === 'number') {
      viewport = { width: size[0], height: size[1] };
    }
  }
  return (x, y) => {
    if (x < 0 || y < 0) {
      throw badArgs(`Coordinates must be inside the viewport; got (${x}, ${y}).`);
    }
    if (viewport && (x > viewport.width || y > viewport.height)) {
      throw badArgs(
        `Coordinates (${x}, ${y}) are outside the ${viewport.width}x${viewport.height} viewport (CSS px). Scroll the target into view first, or take a fresh screenshot.`,
      );
    }
  };
}

interface PointerPage {
  mouse: { move(x: number, y: number): Promise<void> };
  viewportSize(): { width: number; height: number } | null;
}

/**
 * Walk the pointer from `from` (or from wherever it was last left on this page)
 * to `to` along the shared pointer geometry, and leave the tracker there.
 * `rng` is pathPoints' jitter source; a constant 0.5 yields zero jitter.
 */
async function walkPointer(
  page: PointerPage,
  to: Point,
  from?: Point,
  rng?: () => number,
): Promise<void> {
  const start = from ?? getLastPointer(page) ?? defaultStartPoint(page.viewportSize() ?? undefined);
  for (const point of pathPoints(start, to, stepsForDistance(distance(start, to)), rng)) {
    await page.mouse.move(point.x, point.y);
  }
  setLastPointer(page, to);
}

/**
 * A mouse drag through `points`: approach the first, press, walk each leg with
 * the pointer geometry, release. The button comes up in a finally so a move
 * that throws mid-drag does not leave the page holding a pressed mouse.
 *
 * `straightLegs` is for an explicit path: the agent chose those waypoints (a
 * stroke on a canvas, a slider track), so the pressed legs between them are
 * straight lines. The approach before the press keeps its jitter either way.
 */
export async function mouseDragThrough(
  page: PointerPage & { mouse: { down(): Promise<void>; up(): Promise<void> } },
  points: readonly Point[],
  straightLegs = false,
): Promise<void> {
  await walkPointer(page, points[0]);
  await page.mouse.down();
  try {
    for (let i = 1; i < points.length; i++) {
      await walkPointer(page, points[i], points[i - 1], straightLegs ? () => 0.5 : undefined);
    }
  } finally {
    await page.mouse.up();
  }
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
  if (!/^[a-zA-Z0-9_-]+$/.test(ref)) throw badArgs(`Invalid ref: "${ref}"`);
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
    throw taggedFailure('ref_not_found', frameRefFallbackMessage(ref));
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

/**
 * Fill the first element matching a CSS selector, over the RPC transport.
 *
 * Takes a selector rather than a ref because the ref lane is only ONE of the
 * ways a caller can now name an element: `browser_type({selector})` hands its
 * own selector straight through (rpcSelectorFor), and a ref is rendered as the
 * `data-wmux-ref` tag the snapshot wrote.
 */
async function rpcFill(selector: string, value: string, scope: BrowserTargetScope): Promise<void> {
  // Click on the element first to focus it
  await sendScopedBrowserRpc('browser.click.cdp', scope, { selector });
  // Small delay for focus
  await new Promise(r => setTimeout(r, 100));
  // Both steps below act on whatever the DOCUMENT has focused, not on the
  // selector: `selectAll` works on the current selection and `Input.insertText`
  // on the focused node. A selector naming something unfocusable — a wrapper
  // `<div>`, a `<label>`, a disabled control — therefore left the click doing
  // nothing and overwrote whichever field the page had focused instead. Now
  // that a caller can pass its own selector, that has to be checked. `unknown`
  // (a transport that cannot answer) proceeds, exactly as it always did.
  if ((await rpcCaretState(selector, scope)) === 'lost') {
    throw taggedFailure(
      'element_not_interactable',
      `The element matching "${selector}" did not take focus, so typing would have gone into ` +
        'whatever else the page has focused. Nothing was typed — though the click that was ' +
        'meant to focus it did reach the page. Name a focusable field.',
    );
  }
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
  /**
   * A CSS selector, for an element NEITHER snapshot handed out a number for.
   *
   * YouTube Studio's title and description are `contenteditable` divs; before
   * the snapshot enumerator learned to count those, an agent that could see
   * them on screen had no way to name them at all (dogfood 2026-09-04). A
   * selector is the escape hatch that does not depend on an enumerator noticing
   * the element first.
   */
  selector?: string;
}

/** The parameters a tool accepts as an address, in the order it lists them. */
type AddressMode = 'ref' | 'smartRef' | 'selector';

const ADDRESS_MODE_HELP: Record<AddressMode, string> = {
  ref: 'ref (from browser_snapshot)',
  smartRef: 'smartRef (from browser_smart_snapshot)',
  selector: 'selector (a CSS selector)',
};

/**
 * The slice of ElementHandle / Locator the typing tools use.
 *
 * A ref resolves to an ElementHandle and a smartRef to a Locator; both carry
 * these three methods with the same meaning, so one code path serves both.
 */
interface TypeTarget {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  evaluate<R>(fn: (node: Element) => R): Promise<R>;
}

/** Reject an address that names no element, or more than one. */
function requireOneTarget(addr: RefAddress, tool: string, accepts: readonly AddressMode[]): void {
  const given = accepts.filter((mode) => addr[mode] !== undefined);
  if (given.length === 0) {
    const help = accepts.map((mode) => ADDRESS_MODE_HELP[mode]);
    throw badArgs(
      `${tool} needs ${help.slice(0, -1).join(', ')} or ${help[help.length - 1]}.`,
    );
  }
  if (given.length > 1) {
    throw badArgs(
      `${tool} takes ${given.join(' or ')}, not both — they name one element more than one way.`,
    );
  }
}

/**
 * Refuse a `selector` that is not plain CSS.
 *
 * The RPC lane resolves it with `document.querySelector`, and a recorded step
 * carries it on the `css` axis, which the replay runner also resolves as CSS.
 * Playwright's own `locator()` would happily accept `text=Save`, `//div` and
 * `a >> b` — so without this the same argument means one thing live on the
 * Chrome lane and nothing at all on the other two, which is a tool that works
 * until the day it is replayed.
 */
function requireCssSelector(selector: string): void {
  const bad = (why: string): never => {
    throw badArgs(`selector must be a CSS selector — ${why}. Got: ${selector}`);
  };
  const trimmed = selector.trim();
  if (selector.includes('>>')) bad('">>" chains Playwright engines, which CSS has no equivalent for');
  if (trimmed.startsWith('//') || trimmed.startsWith('..')) bad('this is an XPath expression');
  const engine = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*=/.exec(trimmed);
  if (engine) bad(`"${engine[1]}=" names a Playwright engine`);
}

/**
 * How many elements a selector matches, refusing anything but exactly one.
 *
 * Typing into `.first()` of several matches SUCCEEDS live and then fails on
 * every replay: the step is recorded on the css axis, and the replay runner
 * refuses a css axis whose count is not 1. The tool would be reporting a
 * result the flow cannot reproduce — so it refuses here instead, by the same
 * uniqueness rule a ref carries.
 */
function requireSingleMatch(selector: string, count: number): void {
  if (count === 0) {
    throw taggedFailure('selector_not_found', `No element matches selector: ${selector}`);
  }
  if (count > 1) {
    throw badArgs(
      `selector "${selector}" matches ${count} elements — it must match exactly one. ` +
        'Narrow it, or use a ref from browser_snapshot.',
    );
  }
}

/** Resolve an address on the Playwright lane. Throws with the reason it failed. */
async function resolveTypeTarget(
  page: Page,
  addr: RefAddress,
  notes?: string[],
): Promise<TypeTarget> {
  if (addr.smartRef !== undefined) {
    // Throws StaleSmartRefError rather than typing into a substitute — the same
    // guarantee browser_click({smartRef}) gives. A ref from an earlier snapshot
    // that still names exactly one element is recovered, with a note (#1355).
    return (await resolveSmartRefLocator(page, addr.smartRef, {
      ...(notes && { notes }),
    })) as unknown as TypeTarget;
  }
  if (addr.selector !== undefined) {
    requireCssSelector(addr.selector);
    // Counted before typing: a selector that matches nothing would otherwise
    // spend Playwright's full auto-wait and come back as a timeout, which reads
    // like a hung page rather than a selector the caller can fix — and one that
    // matches several must not be silently narrowed to the first.
    requireSingleMatch(addr.selector, await page.locator(addr.selector).count());
    return page.locator(addr.selector).first() as unknown as TypeTarget;
  }
  const el = await resolveRef(page, addr.ref as string);
  if (!el) throw refMissing(addr.ref as string, page);
  return el as unknown as TypeTarget;
}

/**
 * The CSS selector the RPC lane resolves an address through.
 *
 * Its only addressing mode is a selector, so a ref becomes the `data-wmux-ref`
 * tag the snapshot wrote and a caller's own selector is passed through.
 *
 * A smartRef gets NO rendering, deliberately. `data-wmux-ref` tags are written
 * by browser_snapshot; browser_smart_snapshot keeps its own, differently
 * numbered ref space and tags nothing. Rendering smartRef=61 as
 * `[data-wmux-ref="61"]` therefore names either nothing at all or — worse, when
 * a browser_snapshot ran earlier — whatever unrelated element that snapshot
 * happened to number 61. An error naming the limit is the only honest answer
 * this lane has.
 */
function rpcSelectorFor(addr: RefAddress, scope: BrowserTargetScope): string {
  if (addr.selector !== undefined) {
    requireCssSelector(addr.selector);
    return addr.selector;
  }
  if (addr.ref === undefined) {
    throw taggedFailure(
      'not_supported',
      `smartRef=${addr.smartRef} cannot be used on this transport: browser_smart_snapshot refs ` +
        'are not tagged into the page, and this surface has no live Chrome page to resolve them ' +
        'against. Use a ref from browser_snapshot, or a CSS selector.',
    );
  }
  return `[data-wmux-ref="${sanitizeRef(addr.ref, scope)}"]`;
}

/** How many elements a selector matches on the RPC lane. */
async function rpcMatchCount(selector: string, scope: BrowserTargetScope): Promise<number> {
  const value = await rpcEval(
    `String(document.querySelectorAll(${jsStringLiteral(selector)}).length)`,
    scope,
  );
  const count = Number(value);
  // A transport that cannot answer must not block the action — the ambiguity
  // guard is worth having, but not at the price of a fill that no longer runs.
  return Number.isFinite(count) ? count : 1;
}

/**
 * The key that ends a line, or null to leave `\n` in the inserted text.
 *
 * `Input.insertText` — what both lanes type with, because it is the only thing
 * that survives CJK IME composition and React's controlled inputs — puts the
 * newline character into the field verbatim. A single-line input drops it, and
 * a rich-text editor that listens for the keydown never sees one either, so
 * Instagram's caption came out as one paragraph and the user pressed Enter
 * eight times by hand (dogfood 2026-09-04). Splitting on `\n` and pressing a
 * real key between the pieces is what the editor is actually listening for.
 *
 * Default stays `literal`: a `\n` in a search box has meant a literal newline
 * since the tool existed, and a caller passing multi-line text to a one-line
 * field must not suddenly submit it.
 */
function newlineKeyFor(mode: 'literal' | 'enter' | 'shift-enter' | undefined): string | null {
  if (mode === 'enter') return 'Enter';
  if (mode === 'shift-enter') return 'Shift+Enter';
  return null;
}

/**
 * What a between-lines keypress left behind.
 *
 * `lost` is the one answer that stops the typing: the field the caller named is
 * gone from the document, or no longer holds the caret. Anything else — an
 * `unknown` from a transport or a test double that cannot answer the question —
 * lets the run continue, because a probe that cannot report is not evidence of
 * a problem.
 */
type CaretState = 'held' | 'lost' | 'unknown';

/**
 * Is the element still attached, and still holding the caret?
 *
 * Asked between the segments of a multi-line type. The first Enter into a
 * search box or a chat composer SUBMITS: the field empties, the page navigates,
 * and every remaining line is then inserted into whatever the new page happens
 * to focus — reported back as a successful eight-line type (review, lane D).
 * `contains` as well as identity, because a rich-text host keeps the caret in
 * one of its descendant nodes.
 */
async function caretStillOnTarget(el: TypeTarget): Promise<CaretState> {
  try {
    const held = await el.evaluate((node: Element) => {
      if (!node.isConnected) return false;
      const active = node.ownerDocument?.activeElement ?? null;
      return active !== null && (active === node || node.contains(active));
    });
    // A double that answers something other than a boolean has not answered.
    if (typeof held !== 'boolean') return 'unknown';
    return held ? 'held' : 'lost';
  } catch {
    // A detached handle throws — which IS the answer, but so is a navigation
    // that tore down the execution context mid-question. Both mean the element
    // this was typing into is not there any more.
    return 'lost';
  }
}

/** Thrown when a multi-line type stopped early, carrying how far it got. */
function partialLinesError(done: number, total: number, key: string): Error {
  return taggedFailure(
    'navigation_interrupted',
    `Typed ${done} of ${total} lines, then stopped: the field lost focus after the ${key} ` +
      '(a submit or a navigation is the usual cause). The remaining lines were NOT typed — ' +
      'they would have gone into whatever the page focused next.',
  );
}

/**
 * Type `text` into an already-resolved element on the Playwright lane.
 *
 * The FIRST segment replaces the field's value — the contract browser_type has
 * always had — and every later one is inserted after its key, at the caret the
 * key left behind.
 */
async function typeIntoTarget(
  page: Page,
  el: TypeTarget,
  text: string,
  opts: { humanlike?: boolean; newlineKey: string | null },
): Promise<string[]> {
  const segments = opts.newlineKey === null ? [text] : text.split('\n');
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) {
      await page.keyboard.press(opts.newlineKey as string);
      if ((await caretStillOnTarget(el)) === 'lost') {
        throw partialLinesError(i, segments.length, opts.newlineKey as string);
      }
    }
    const segment = segments[i];
    if (i === 0) {
      if (opts.humanlike) {
        await el.click();
        await typeHumanlike(page, '', segment);
      } else {
        await el.fill(segment);
      }
      continue;
    }
    // An empty segment is a blank line: the keypress above already made it.
    if (segment.length === 0) continue;
    if (opts.humanlike) await typeHumanlike(page, '', segment);
    else await page.keyboard.insertText(segment);
  }
  return segments;
}

/** The same, over the RPC transport, where the caret is the page's own. */
async function rpcTypeInto(
  selector: string,
  text: string,
  scope: BrowserTargetScope,
  newlineKey: string | null,
): Promise<string[]> {
  const segments = newlineKey === null ? [text] : text.split('\n');
  await rpcFill(selector, segments[0], scope);
  for (let i = 1; i < segments.length; i++) {
    await rpcPressKey(newlineKey as string, scope);
    // Same guarantee the Playwright lane gives: a key that submitted the form
    // must not be followed by lines typed into the next page's focused field.
    if ((await rpcCaretState(selector, scope)) === 'lost') {
      throw partialLinesError(i, segments.length, newlineKey as string);
    }
    if (segments[i].length === 0) continue;
    await sendScopedBrowserRpc('browser.type.cdp', scope, { text: segments[i] });
  }
  return segments;
}

/**
 * Sentinels the caret probe answers with.
 *
 * Distinct strings, not 'yes'/'no': every RPC evaluate on this lane returns a
 * bare string, and a probe that shared its vocabulary with the password probe
 * would read another question's answer as its own.
 */
const CARET_HELD = 'wmux-caret:held';
const CARET_LOST = 'wmux-caret:lost';

/**
 * Does the selector's element still hold the caret, over the RPC transport?
 *
 * Anything but the `lost` sentinel is treated as `unknown` — see CaretState.
 */
async function rpcCaretState(selector: string, scope: BrowserTargetScope): Promise<CaretState> {
  try {
    const value = await rpcEval(`(() => {
      const el = document.querySelector(${jsStringLiteral(selector)});
      if (!el) return '${CARET_LOST}';
      const active = document.activeElement;
      return active && (active === el || el.contains(active)) ? '${CARET_HELD}' : '${CARET_LOST}';
    })()`, scope);
    if (value === CARET_LOST) return 'lost';
    return value === CARET_HELD ? 'held' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** How an address reads back in a tool result. */
function describeAddress(addr: RefAddress): string {
  if (addr.ref !== undefined) return `ref=${addr.ref}`;
  if (addr.smartRef !== undefined) return `smartRef=${addr.smartRef}`;
  return `selector=${addr.selector}`;
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
  if (addr.selector !== undefined) return { selector: addr.selector };
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
async function isPasswordElement(el: TypeTarget): Promise<boolean> {
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

/**
 * A CSS selector as a single-quoted JS string literal.
 *
 * The refs this used to carry were `[a-zA-Z0-9_-]+` by sanitizeRef, so quoting
 * them was a non-question. A caller's own selector reaches the probe now
 * (browser_type's `selector`), and an apostrophe in one — `[title='x']` — would
 * otherwise close the literal it sits in.
 */
function jsStringLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `'${escaped}'`;
}

/** Same question over the RPC transport, resolved through a CSS selector. */
async function rpcIsPasswordElement(selector: string, scope: BrowserTargetScope): Promise<boolean> {
  try {
    const val = await rpcEval(`(() => {
      const isPasswordField = ${PASSWORD_FIELD_PREDICATE_JS};
      return isPasswordField(document.querySelector(${jsStringLiteral(selector)})) ? 'yes' : 'no';
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
    'Click an element by ref (browser_snapshot) or smartRef (browser_smart_snapshot), or — when neither is available — at x/y. x/y are VIEWPORT CSS PIXELS; to click something you can see in a screenshot pass imageX/imageY instead and the pixels are divided by that capture\'s reported scale for you. A fullPage or element screenshot is in a different coordinate space and cannot be used for coordinates at all. Coordinates need a live page (chrome backend); the RPC lane is ref-only.' + EFFECT_TRAILER_NOTE,
    BROWSER_CLICK_SHAPE,
    async ({ ref, smartRef, x, y, imageX, imageY, double, modifiers, surfaceId }) => leasedMutation(deps, surfaceId, async (scope, effect) => {
      try {
        // Image-space coordinates are viewport coordinates once divided by the
        // scale the last viewport screenshot of this surface reported (#1358).
        // Converted up front so everything below sees one coordinate space.
        let clickX = x;
        let clickY = y;
        let imageNote = '';
        if (imageX !== undefined || imageY !== undefined) {
          if (ref !== undefined || smartRef !== undefined || x !== undefined || y !== undefined) {
            throw badArgs('Pass imageX/imageY alone — not with ref, smartRef, x or y.');
          }
          if (imageX === undefined || imageY === undefined) {
            throw badArgs('Image-space clicks need both imageX and imageY.');
          }
          const known = getScreenshotScale(browserScopeKey(scope));
          if (!known) {
            throw badArgs(
              'No screenshot scale is known for this surface: take a viewport browser_screenshot first (fullPage and element captures set no scale), then pass imageX/imageY.',
            );
          }
          clickX = Math.round((imageX / known.scale) * 100) / 100;
          clickY = Math.round((imageY / known.scale) * 100) / 100;
          imageNote = ` (image px (${imageX}, ${imageY}) / scale ${known.scale})`;
        }
        // Coordinate clicking is an ESCAPE HATCH, not a second addressing mode:
        // a ref survives a re-render and a coordinate does not, so a call that
        // carries both is a mistake worth refusing rather than silently
        // resolving in favour of one.
        // mirrors browser-use tools/service.py coordinate clicking (set_coordinate_clicking)
        const hasCoords = clickX !== undefined || clickY !== undefined;
        if (hasCoords && (ref !== undefined || smartRef !== undefined)) {
          throw badArgs(
            'Pass either ref/smartRef or x/y, not both — a ref survives a re-render and a coordinate does not.',
          );
        }
        if (hasCoords && (clickX === undefined || clickY === undefined)) {
          throw badArgs('Coordinate clicks need both x and y (viewport CSS pixels).');
        }

        // Try Playwright first. The rejection is kept: on the coordinate path
        // "no page" is reported to the caller, and "the page navigated away" or
        // "the browser crashed" must not be dressed up as a backend limitation.
        let pageError: unknown;
        const page = await engine.getPageForScope(scope, { intent: 'write' }).catch((error) => {
          pageError = error;
          return allowScopedRpcFallback(error);
        });

        if (hasCoords) {
          if (!page) {
            throw taggedFailure(
              'not_supported',
              livePageRequired('Coordinate clicks', pageError, 'click by ref from browser_snapshot'),
            );
          }
        }
        // A click that holds keys is not recorded on any path: a trace step
        // carries no modifiers, so a replay would perform a different click
        // (a plain click where a Ctrl-click multi-selected).
        const modifierKeys = modifierKeysFor(modifiers, page, pageError, 'click without modifiers');

        if (hasCoords && page) {
          // Refuse a coordinate the viewport does not contain instead of
          // clicking nothing and reporting success.
          (await viewportBoundsCheck(page))(clickX as number, clickY as number);

          // Same popup contract as a ref click — a coordinate click on a link
          // with target=_blank opens a popup just as readily.
          const coordWatch =
            (await engine.resolveWorkspaceBackend(scope.workspaceId).catch(() => undefined)) ===
            'chrome'
              ? watchForPopup(page as unknown as { on: Function; off: Function })
              : null;
          try {
            await effect.dispatch(() =>
              withModifiers(page, modifierKeys, () =>
                page.mouse.click(clickX as number, clickY as number, {
                  ...(double && { clickCount: 2 }),
                }),
              ),
            );
            // Keep the tracker honest: the next ref click should approach from
            // here, not from wherever the pointer was before this one.
            setLastPointer(page, { x: clickX as number, y: clickY as number });
            const note = coordWatch ? await coordWatch.note() : '';
            // Coordinate clicks are deliberately NOT recorded: a coordinate
            // does not survive a re-render, so a trace built on one replays a
            // click into whatever has moved under it. The escape hatch stays
            // an escape hatch.
            return withEffectTrailer(
              {
                content: [
                  {
                    type: 'text' as const,
                    text: `Clicked${double ? ' (double)' : ''} at viewport CSS px (${clickX}, ${clickY})${imageNote}${modifiersNote(modifierKeys)}${note}`,
                  },
                ],
              },
              effect.success(),
            );
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
              // A ref from an earlier snapshot that still names exactly one
              // element resolves through its descriptor and says so (#1355).
              const refNotes: string[] = [];
              const locator = await resolveSmartRefLocator(page, smartRef, { notes: refNotes });
              const dispatch = await effect.dispatch(() =>
                withModifiers(page, modifierKeys, () =>
                  clickWithApproach(page as unknown as ApproachPage, locator, !!double, tap),
                ),
              );
              // A ref axis, not the css axis this used to record: the CDP
              // lane's stored "locator" is getByRole SOURCE TEXT, which
              // page.locator() cannot parse, so every replay of such a step
              // failed while the live click succeeded. The RPC lane's selector
              // is a real one and stays a css axis.
              const axisEntry = smartRefAxisEntry(smartRef);
              const selector = axisEntry ? undefined : getLocatorByRef(smartRef) ?? undefined;
              if (!modifierKeys) {
                recordAction(deps, {
                  scope,
                  tool: 'browser_click',
                  page,
                  ...(axisEntry ? { refEntry: axisEntry } : { selector }),
                  ...(double && { args: { double: true } }),
                });
              }
              return withEffectTrailer(
                {
                  content: [{ type: 'text' as const, text: `Clicked${double ? ' (double)' : ''} element smartRef=${smartRef}${modifiersNote(modifierKeys)}${dispatchNote(!!tapper, double, dispatch)}${refNotes.map((n) => `\n${n}`).join('')}${await popupNote()}` }],
                },
                effect.success(),
              );
            }

            if (!ref) throw badArgs('Either ref or smartRef must be provided.');

            const el = await resolveRef(page, ref);
            if (!el) throw refMissing(ref, page);
            const dispatch = await effect.dispatch(() =>
              withModifiers(page, modifierKeys, () =>
                clickWithApproach(page as unknown as ApproachPage, el, !!double, tap),
              ),
            );
            if (!modifierKeys) {
              recordAction(deps, {
                scope,
                tool: 'browser_click',
                page,
                ref,
                ...(double && { args: { double: true } }),
              });
            }
            return withEffectTrailer(
              {
                content: [{ type: 'text' as const, text: `Clicked${double ? ' (double)' : ''} element ref=${ref}${modifiersNote(modifierKeys)}${dispatchNote(!!tapper, double, dispatch)}${await popupNote()}` }],
              },
              effect.success(),
            );
          } finally {
            // Every exit — success, a ref that vanished, a click that threw —
            // detaches the listener.
            popupWatch?.dispose();
          }
        }

        // RPC fallback
        if (!ref && smartRef === undefined) throw badArgs('Either ref or smartRef must be provided.');
        const resolvedRef = ref ?? String(smartRef);
        const rpcDispatch = await effect.dispatch(() => rpcClick(resolvedRef, scope, double));
        recordAction(deps, { scope, tool: 'browser_click', page: null, ref: resolvedRef });
        return withEffectTrailer(
          {
            content: [{ type: 'text' as const, text: `Clicked${double ? ' (double)' : ''} element ref=${resolvedRef}${rpcDispatch === 'touch' ? ' (touch tap)' : ''}` }],
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

  // -----------------------------------------------------------------------
  // browser_type
  // -----------------------------------------------------------------------
  server.tool(
    'browser_type',
    'Type text into an element by ref, smartRef or CSS selector, replacing any existing value. Typing into a password field echoes "[redacted:password]" back — the text still went in.' + EFFECT_TRAILER_NOTE,
    BROWSER_TYPE_SHAPE,
    async ({ ref, smartRef, selector, text, newline, submit, humanlike, surfaceId }) => leasedMutation(deps, surfaceId, async (scope, effect) => {
      try {
        const addr: RefAddress = {
          ...(ref !== undefined && { ref }),
          ...(smartRef !== undefined && { smartRef }),
          ...(selector !== undefined && { selector }),
        };
        requireOneTarget(addr, 'browser_type', ['ref', 'smartRef', 'selector']);
        const newlineKey = newlineKeyFor(newline);
        const page = await engine.getPageForScope(scope, { intent: 'write' }).catch(allowScopedRpcFallback);

        // Decided BEFORE typing: the field is addressable now, and a submit can
        // navigate the page out from under a later lookup.
        let isPassword: boolean;
        let segments: string[];
        const refNotes: string[] = [];

        if (page) {
          const el = await resolveTypeTarget(page, addr, refNotes);
          isPassword = await isPasswordElement(el);
          segments = await effect.dispatch(() =>
            typeIntoTarget(page, el, text, { humanlike, newlineKey }),
          );
          if (submit) await page.keyboard.press('Enter');
        } else {
          // RPC fallback
          const rpcSelector = rpcSelectorFor(addr, scope);
          // A caller's own selector is counted here for the same reason it is
          // on the Playwright lane: `.first()` semantics that replay refuses.
          // A data-wmux-ref tag is unique by construction, so it is not asked.
          if (addr.selector !== undefined) {
            requireSingleMatch(rpcSelector, await rpcMatchCount(rpcSelector, scope));
          }
          isPassword = await rpcIsPasswordElement(rpcSelector, scope);
          segments = await effect.dispatch(() =>
            rpcTypeInto(rpcSelector, text, scope, newlineKey),
          );
          if (submit) await rpcPressKey('Enter', scope);
        }

        // The typed text is echoed so the agent can see what landed in the
        // field — except when the field is a credential, where the echo would
        // only re-enter the value into the transcript and the logs.
        const echoed = isPassword ? REDACTED_PASSWORD : text;
        // How many keypresses the newline mode spent, so a caller can tell a
        // field that swallowed them from one that never got them.
        const lineNote =
          newlineKey && segments.length > 1
            ? ` as ${segments.length} lines (${newlineKey} between them)`
            : '';

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
          args: isPassword
            ? {}
            : { text, ...(newline && { newline }), ...(submit && { submit: true }) },
          ...(isPassword && { unrecordable: 'password' as const }),
        });

        return withEffectTrailer(
          {
            content: [
              {
                type: 'text' as const,
                text: `Typed "${echoed}" into element ${describeAddress(addr)}${lineNote}${submit ? ' and submitted' : ''}${refNotes.map((n) => `\n${n}`).join('')}`,
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

  // -----------------------------------------------------------------------
  // browser_fill
  // -----------------------------------------------------------------------
  server.tool(
    'browser_fill',
    'Fill multiple form fields at once, each by ref or smartRef.' + EFFECT_TRAILER_NOTE,
    BROWSER_FILL_SHAPE,
    async ({ fields, surfaceId }) => leasedMutation(deps, surfaceId, async (scope, effect) => {
      try {
        const page = await engine.getPageForScope(scope, { intent: 'write' }).catch(allowScopedRpcFallback);

        let filled = 0;
        const errors: string[] = [];
        // Kept as the error it was, not only as its text: the trailer's code is
        // read off the failure object (resultTrailer.ts), and the first field to
        // fail is the one the caller has to fix.
        let firstError: unknown;
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
            requireOneTarget(addr, 'browser_fill', ['ref', 'smartRef']);
            if (page) {
              const el = await resolveTypeTarget(page, addr);
              isPassword[i] = await isPasswordElement(el);
              await effect.dispatch(() => el.fill(field.value));
            } else {
              const rpcSelector = rpcSelectorFor(addr, scope);
              isPassword[i] = await rpcIsPasswordElement(rpcSelector, scope);
              await effect.dispatch(() => rpcFill(rpcSelector, field.value, scope));
            }
            filled++;
          } catch (err) {
            if (firstError === undefined) firstError = err;
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

        // A form that took SOME of its fields dispatched; only one that took
        // none of them can promise the page is untouched. So a partial fill
        // reads `committed`, and the "Filled 2/3" count plus the Errors block
        // stay the per-field truth — the trailer has three states and none of
        // them is "partly".
        const filledNothing = errors.length > 0 && filled === 0;
        return withEffectTrailer(
          {
            content: [{ type: 'text' as const, text: resultText }],
            ...(filledNothing ? { isError: true } : {}),
          },
          filledNothing ? effect.failure(firstError) : effect.success(),
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

  // -----------------------------------------------------------------------
  // browser_press_key
  // -----------------------------------------------------------------------
  server.tool(
    'browser_press_key',
    'Press a keyboard key.' + EFFECT_TRAILER_NOTE,
    BROWSER_PRESS_KEY_SHAPE,
    async ({ key, surfaceId }) => leasedMutation(deps, surfaceId, async (scope, effect) => {
      try {
        const page = await engine.getPageForScope(scope, { intent: 'write' }).catch(allowScopedRpcFallback);

        if (page) {
          await effect.dispatch(() => page.keyboard.press(key));
        } else {
          await effect.dispatch(() => rpcPressKey(key, scope));
        }

        recordAction(deps, { scope, tool: 'browser_press_key', page, args: { key } });

        return withEffectTrailer(
          { content: [{ type: 'text' as const, text: `Pressed key: ${key}` }] },
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

  // -----------------------------------------------------------------------
  // browser_hover
  // -----------------------------------------------------------------------
  server.tool(
    'browser_hover',
    'Hover over an element by ref.' + EFFECT_TRAILER_NOTE,
    BROWSER_HOVER_SHAPE,
    async ({ ref, surfaceId }) => leasedMutation(deps, surfaceId, async (scope, effect) => {
      try {
        const page = await engine.getPageForScope(scope, { intent: 'write' }).catch(allowScopedRpcFallback);
        let touchNote = '';

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) throw refMissing(ref, page);
          if (hasTouchEmulation(page)) touchNote = TOUCH_HOVER_NOTE;
          await effect.dispatch(() => el.hover());
        } else {
          // RPC fallback: real pointer movement over CDP Input. The synthetic
          // MouseEvent this replaces arrived with isTrusted === false, which any
          // handler on the page can read — a single boolean separating our
          // hover from every hover a person performs.
          const safeRef = sanitizeRef(ref, scope);
          const res = await effect.dispatch(() =>
            sendScopedBrowserRpc<{ touchPreset?: boolean }>('browser.hover.cdp', scope, {
              selector: `[data-wmux-ref="${safeRef}"]`,
            }),
          );
          if (res?.touchPreset) touchNote = TOUCH_HOVER_NOTE;
        }

        recordAction(deps, { scope, tool: 'browser_hover', page, ref });

        return withEffectTrailer(
          { content: [{ type: 'text' as const, text: `Hovered over element ref=${ref}${touchNote}` }] },
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

  // -----------------------------------------------------------------------
  // browser_drag
  // -----------------------------------------------------------------------
  server.tool(
    'browser_drag',
    'Drag an element from sourceRef to targetRef, or through path points (chrome backend).' + EFFECT_TRAILER_NOTE,
    BROWSER_DRAG_SHAPE,
    async ({ sourceRef, targetRef, path, modifiers, surfaceId }) => leasedMutation(deps, surfaceId, async (scope, effect) => {
      try {
        // Same rule as browser_click's ref-vs-x/y: a path is the escape hatch
        // for surfaces with nothing to snapshot (a canvas, a slider track, a
        // crop box), not a second way to address an element that has a ref.
        if (path !== undefined && (sourceRef !== undefined || targetRef !== undefined)) {
          throw badArgs(
            'Pass either sourceRef/targetRef or path, not both — a ref survives a re-render and a coordinate does not.',
          );
        }
        if (path === undefined && (sourceRef === undefined || targetRef === undefined)) {
          throw badArgs(
            'A ref drag needs both sourceRef and targetRef; to drag through viewport CSS px points pass path instead.',
          );
        }
        if (path !== undefined && (path.length < 2 || path.length > 50)) {
          throw badArgs(`path takes 2 to 50 {x, y} points (viewport CSS px); got ${path.length}.`);
        }

        let pageError: unknown;
        const page = await engine.getPageForScope(scope, { intent: 'write' }).catch((error) => {
          pageError = error;
          return allowScopedRpcFallback(error);
        });

        if (path !== undefined) {
          if (!page) {
            throw taggedFailure(
              'not_supported',
              livePageRequired('Path drags', pageError, 'drag by sourceRef/targetRef from browser_snapshot'),
            );
          }
          // The emulated touchscreen's drag is a single press-slide-lift
          // between two points; a multi-point path has no touch equivalent in
          // this version, and a mouse drag under that identity contradicts it.
          if (hasTouchEmulation(page)) {
            throw taggedFailure(
              'not_supported',
              'Path drags are mouse-only, and a device preset with a touchscreen is active on this page (its touch drag takes one start and one end point). Drag by sourceRef/targetRef, or reset the preset with browser_emulate.',
            );
          }
          const modifierKeys = modifierKeysFor(modifiers, page, pageError, 'drag without modifiers');
          const inBounds = await viewportBoundsCheck(page);
          for (const point of path) inBounds(point.x, point.y);

          await effect.dispatch(() =>
            withModifiers(page, modifierKeys, () => mouseDragThrough(page, path, true)),
          );
          // Path drags are deliberately NOT recorded, for the same reason
          // coordinate clicks are not: a coordinate does not survive a
          // re-render, so a replay would drag whatever has moved under it.
          const first = path[0];
          const last = path[path.length - 1];
          return withEffectTrailer(
            {
              content: [{
                type: 'text' as const,
                text: `Dragged through ${path.length} points from viewport CSS px (${first.x}, ${first.y}) to (${last.x}, ${last.y})${modifiersNote(modifierKeys)}`,
              }],
            },
            effect.success(),
          );
        }

        const source = sourceRef as string;
        const target = targetRef as string;
        const modifierKeys = modifierKeysFor(modifiers, page, pageError, 'drag without modifiers');
        let dragNote = '';

        if (page) {
          const sourceEl = await resolveRef(page, source);
          if (!sourceEl) throw refMissing(source, page);
          const targetEl = await resolveRef(page, target);
          if (!targetEl) throw refMissing(target, page);

          const sourceBox = await sourceEl.boundingBox();
          const targetBox = await targetEl.boundingBox();
          if (!sourceBox || !targetBox) {
            throw taggedFailure(
              'element_not_visible',
              'Could not determine bounding box for source or target element.',
            );
          }

          const sourceX = sourceBox.x + sourceBox.width / 2;
          const sourceY = sourceBox.y + sourceBox.height / 2;
          const targetX = targetBox.x + targetBox.width / 2;
          const targetY = targetBox.y + targetBox.height / 2;

          // A drag under a touchscreen preset is a finger sliding across the
          // glass: press, a bounded run of moves, lift — the same three phases
          // the mouse performs below, on the input the emulated device has.
          // Both endpoints are already measured, so nothing else is needed.
          // (Modifiers were refused above under a touchscreen preset.)
          const touchDrag = touchDragFor(page);
          let dragged = false;
          if (touchDrag) {
            try {
              await effect.dispatch(() =>
                touchDrag({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }),
              );
              dragged = true;
              dragNote = ' (touch drag)';
            } catch {
              // Touch dispatch refused; the mouse drag below still performs the
              // gesture, and the note says which one the page actually saw.
              dragNote = ' (mouse drag — touch dispatch was unavailable)';
            }
          }

          if (!dragged) {
            // The shared pointer geometry rather than a straight 10-step line:
            // the approach starts where the pointer was last left.
            await effect.dispatch(() =>
              withModifiers(page, modifierKeys, () =>
                mouseDragThrough(page, [{ x: sourceX, y: sourceY }, { x: targetX, y: targetY }]),
              ),
            );
          }
        } else {
          // RPC fallback: press, move, release over CDP Input — the same shape
          // as the Playwright path above. The synthesised DragEvents this
          // replaces were untrusted, and they also never reached anything built
          // on pointer events rather than HTML5 drag-and-drop.
          const safeSrc = sanitizeRef(source, scope);
          const safeTgt = sanitizeRef(target, scope);
          const res = await effect.dispatch(() =>
            sendScopedBrowserRpc<{ dispatch?: string }>('browser.drag.cdp', scope, {
              sourceSelector: `[data-wmux-ref="${safeSrc}"]`,
              targetSelector: `[data-wmux-ref="${safeTgt}"]`,
            }),
          );
          if (res?.dispatch === 'touch') dragNote = ' (touch drag)';
        }

        // A drag that held keys is not recorded: a trace step carries no
        // modifiers, so a replay would perform a different drag.
        if (!modifierKeys) {
          recordAction(deps, { scope, tool: 'browser_drag', page, ref: source, targetRef: target });
        }

        return withEffectTrailer(
          {
            content: [{ type: 'text' as const, text: `Dragged element ref=${source} to ref=${target}${modifiersNote(modifierKeys)}${dragNote}` }],
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

  // -----------------------------------------------------------------------
  // browser_select
  // -----------------------------------------------------------------------
  server.tool(
    'browser_select',
    'Select option(s) in a native <select> element by value. A custom dropdown (div/listbox) is not supported here — click its trigger, then click the option.' + EFFECT_TRAILER_NOTE,
    BROWSER_SELECT_SHAPE,
    async ({ ref, values, surfaceId }) => leasedMutation(deps, surfaceId, async (scope, effect) => {
      try {
        const page = await engine.getPageForScope(scope, { intent: 'write' }).catch(allowScopedRpcFallback);

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) throw refMissing(ref, page);
          try {
            await effect.dispatch(() => el.selectOption(values));
          } catch (error) {
            // Playwright's own message is "Element is not a <select> element",
            // which tells the caller what the element is NOT and leaves them
            // retrying the same tool (#1360). The workaround is two clicks, so
            // say that instead.
            if (notASelectElement(error)) {
              throw taggedFailure('element_not_interactable', notNativeSelect(ref));
            }
            throw error;
          }
        } else {
          // Deliberately still a DOM assignment, unlike hover and drag above.
          // A native <select> opens an OS-drawn popup that lives outside the
          // page — CDP Input events go to the document, not to that popup, so
          // there is no mouse sequence that reliably picks an option. Setting
          // `selected` and firing `change` is the only path that works here;
          // the trade-off is that the change event carries isTrusted === false.
          const safeRef = sanitizeRef(ref, scope);
          const escapedValues = JSON.stringify(values);
          const val = await effect.dispatch(() => rpcEval(`(() => {
            const el = document.querySelector('[data-wmux-ref="${safeRef}"]');
            if (!el) return 'not_found';
            // Distinguished from a miss (#1360): "the ref is gone" and "the ref
            // is a custom dropdown" need different things from the caller.
            if (el.tagName !== 'SELECT') return 'not_select';
            const vals = ${escapedValues};
            [...el.options].forEach(o => { o.selected = vals.includes(o.value); });
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'ok';
          })()`, scope));
          // The evaluation reached the page, read the element and changed
          // nothing — a state the dispatch probe cannot know, so it is declared.
          if (val === 'not_select') {
            throw taggedFailure('element_not_interactable', notNativeSelect(ref), 'none');
          }
          if (val === 'not_found') throw refMissing(ref, page, 'none');
        }

        recordAction(deps, {
          scope,
          tool: 'browser_select',
          page,
          ref,
          args: { values: values.join('\u0000') },
        });

        return withEffectTrailer(
          {
            content: [{ type: 'text' as const, text: `Selected value(s) [${values.join(', ')}] in element ref=${ref}` }],
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

  // -----------------------------------------------------------------------
  // browser_scroll_into_view
  // -----------------------------------------------------------------------
  server.tool(
    'browser_scroll_into_view',
    'Scroll an element into the visible viewport.' + EFFECT_TRAILER_NOTE,
    BROWSER_SCROLL_INTO_VIEW_SHAPE,
    async ({ ref, surfaceId }) => leasedMutation(deps, surfaceId, async (scope, effect) => {
      try {
        const page = await engine.getPageForScope(scope, { intent: 'write' }).catch(allowScopedRpcFallback);

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) throw refMissing(ref, page);
          await effect.dispatch(() => el.scrollIntoViewIfNeeded());
        } else {
          const safeRef = sanitizeRef(ref, scope);
          const val = await effect.dispatch(() => rpcEval(`(() => {
            const el = document.querySelector('[data-wmux-ref="${safeRef}"]');
            if (!el) return 'not_found';
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return 'ok';
          })()`, scope));
          // Read and rejected by the page itself: nothing was scrolled.
          if (val === 'not_found') throw refMissing(ref, page, 'none');
        }

        recordAction(deps, { scope, tool: 'browser_scroll_into_view', page, ref });

        return withEffectTrailer(
          { content: [{ type: 'text' as const, text: `Scrolled element ref=${ref} into view` }] },
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

  // -----------------------------------------------------------------------
  // browser_scroll
  // -----------------------------------------------------------------------
  server.tool(
    'browser_scroll',
    'Scroll the page, or a scrollable element when ref is given.' + EFFECT_TRAILER_NOTE,
    BROWSER_SCROLL_SHAPE,
    async ({ direction, amount, ref, x, y, surfaceId }) => leasedMutation(deps, surfaceId, async (scope, effect) => {
      const px = amount ?? 500;
      const deltaX = direction === 'right' ? px : direction === 'left' ? -px : 0;
      const deltaY = direction === 'down' ? px : direction === 'up' ? -px : 0;
      try {
        const hasPoint = x !== undefined || y !== undefined;
        if (hasPoint && ref !== undefined) {
          throw badArgs('Pass either ref or x/y, not both — a ref survives a re-render and a coordinate does not.');
        }
        if (hasPoint && (x === undefined || y === undefined)) {
          throw badArgs('A wheel at a point needs both x and y (viewport CSS pixels).');
        }

        let pageError: unknown;
        const page = await engine.getPageForScope(scope, { intent: 'write' }).catch((error) => {
          pageError = error;
          return allowScopedRpcFallback(error);
        });

        if (hasPoint) {
          // Real wheel events at a point: maps, canvases and virtualized lists
          // listen for `wheel` under the pointer and ignore scrollBy entirely.
          if (!page) {
            throw taggedFailure(
              'not_supported',
              livePageRequired('Wheel scrolls at a point', pageError, 'scroll the page or a ref without x/y'),
            );
          }
          // Same identity reason as path drags and modifiers: a mouse move and
          // a wheel are input the emulated touchscreen device does not have.
          if (hasTouchEmulation(page)) {
            throw taggedFailure(
              'not_supported',
              'Wheel scrolls at a point are mouse-only, and a device preset with a touchscreen is active on this page. Scroll without x/y, or reset the preset with browser_emulate.',
            );
          }
          (await viewportBoundsCheck(page))(x as number, y as number);
          // The approach is already input on the page, so the dispatch starts
          // here rather than at the wheel.
          effect.begin();
          await walkPointer(page, { x: x as number, y: y as number });
          await page.mouse.wheel(deltaX, deltaY);
          // Not recorded, like a coordinate click: the point is layout.
          return withEffectTrailer(
            {
              content: [{ type: 'text' as const, text: `Scrolled ${direction} by ${px}px with the wheel at viewport CSS px (${x}, ${y})` }],
            },
            effect.success(),
          );
        }

        if (page) {
          if (ref) {
            const el = await resolveRef(page, ref);
            if (!el) throw refMissing(ref, page);
            // Main world, deliberately: element-scoped, and an ElementHandle
            // cannot be adopted into an isolated context (see isolated-eval.ts).
            await effect.dispatch(() =>
              el.evaluate(
                (node, [dx, dy]) => { (node as Element).scrollBy(dx, dy); },
                [deltaX, deltaY] as [number, number],
              ),
            );
          } else {
            await effect.dispatch(() =>
              evaluateIsolated<void, [number, number]>(
                page,
                ([dx, dy]) => { window.scrollBy(dx, dy); },
                [deltaX, deltaY],
              ),
            );
          }
        } else {
          // RPC fallback
          if (ref) {
            const safeRef = sanitizeRef(ref, scope);
            const val = await effect.dispatch(() => rpcEval(`(() => {
              const el = document.querySelector('[data-wmux-ref="${safeRef}"]');
              if (!el) return 'not_found';
              el.scrollBy(${deltaX}, ${deltaY});
              return 'ok';
            })()`, scope));
            // The answer was already there and was being dropped: without this
            // the tool reported "Scrolled down by 500px (element ref=7)" for a
            // ref the page no longer has — and now would call it committed.
            if (val === 'not_found') throw refMissing(ref, page, 'none');
          } else {
            await effect.dispatch(() => rpcEval(`(() => {
              window.scrollBy(${deltaX}, ${deltaY});
              return 'ok';
            })()`, scope));
          }
        }

        recordAction(deps, {
          scope,
          tool: 'browser_scroll',
          page,
          ...(ref !== undefined && { ref }),
          args: { direction, amount: px },
        });

        return withEffectTrailer(
          {
            content: [{ type: 'text' as const, text: `Scrolled ${direction} by ${px}px${ref ? ` (element ref=${ref})` : ''}` }],
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
