import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ElementHandle } from 'playwright-core';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import {
  browserScopeKey,
  frameRefFallbackMessage,
  isOutstandingFrameRef,
  resolveRef,
} from '../snapshot';
import { getLocatorByRef } from '../dom-intelligence';
import { typeHumanlike } from '../human-typing';
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
  ref: z.string().describe('Ref from browser_snapshot.'),
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
        ref: z.string(),
        value: z.string(),
      }),
    )
    .describe('{ref, value} pairs to fill.'),
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

const REF_NOT_FOUND_HINT =
  'Element with ref={ref} not found. Run browser_snapshot to get current refs.';

function refNotFound(ref: string): string {
  return REF_NOT_FOUND_HINT.replace('{ref}', ref);
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

async function rpcClick(ref: string, scope: BrowserTargetScope, _double?: boolean): Promise<void> {
  // Use CDP click: first get element coordinates via JS, then dispatch mouse events
  const safeRef = sanitizeRef(ref, scope);
  await sendScopedBrowserRpc('browser.click.cdp', scope, {
    selector: `[data-wmux-ref="${safeRef}"]`,
  });
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
async function isPasswordElement(el: ElementHandle): Promise<boolean> {
  try {
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
            const size = await page
              .evaluate('[window.innerWidth, window.innerHeight]')
              .catch(() => null);
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

          try {
            if (smartRef !== undefined) {
              const selector = getLocatorByRef(smartRef);
              if (!selector) {
                throw new Error(
                  `Element with smartRef=${smartRef} not found. Run browser_smart_snapshot to get current refs.`,
                );
              }
              const locator = page.locator(selector);
              if (double) await locator.dblclick();
              else await locator.click();
              recordAction(deps, {
                tool: 'browser_click',
                page,
                selector,
                ...(double && { args: { double: true } }),
              });
              return {
                content: [{ type: 'text' as const, text: `Clicked${double ? ' (double)' : ''} element smartRef=${smartRef}${await popupNote()}` }],
              };
            }

            if (!ref) throw new Error('Either ref or smartRef must be provided.');

            const el = await resolveRef(page, ref);
            if (!el) throw new Error(refNotFound(ref));
            if (double) await el.dblclick();
            else await el.click();
            recordAction(deps, {
              tool: 'browser_click',
              page,
              ref,
              ...(double && { args: { double: true } }),
            });
            return {
              content: [{ type: 'text' as const, text: `Clicked${double ? ' (double)' : ''} element ref=${ref}${await popupNote()}` }],
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
        await rpcClick(resolvedRef, scope, double);
        recordAction(deps, { tool: 'browser_click', page: null, ref: resolvedRef });
        return {
          content: [{ type: 'text' as const, text: `Clicked${double ? ' (double)' : ''} element ref=${resolvedRef}` }],
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
    'Type text into an element by ref, replacing any existing value. Typing into a password field echoes "[redacted:password]" back — the text still went in.',
    BROWSER_TYPE_SHAPE,
    async ({ ref, text, submit, humanlike, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        // Decided BEFORE typing: the field is addressable now, and a submit can
        // navigate the page out from under a later lookup.
        let isPassword: boolean;

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) throw new Error(refNotFound(ref));
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
          isPassword = await rpcIsPasswordElement(ref, scope);
          await rpcFill(ref, text, scope);
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
          tool: 'browser_type',
          page,
          ref,
          args: isPassword ? {} : { text, ...(submit && { submit: true }) },
          ...(isPassword && { unrecordable: 'password' as const }),
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: `Typed "${echoed}" into element ref=${ref}${submit ? ' and submitted' : ''}`,
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
    'Fill multiple form fields at once, each by ref.',
    BROWSER_FILL_SHAPE,
    async ({ fields, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        let filled = 0;
        const errors: string[] = [];

        for (const field of fields) {
          try {
            if (page) {
              const el = await resolveRef(page, field.ref);
              if (!el) { errors.push(refNotFound(field.ref)); continue; }
              await el.fill(field.value);
            } else {
              await rpcFill(field.ref, field.value, scope);
            }
            filled++;
          } catch (err) {
            errors.push(describeToolError(err));
          }
        }

        // Recorded only when EVERY field landed: a partially filled form
        // replayed as if it were whole is a wrong run that reports success.
        if (filled === fields.length && fields.length > 0) {
          for (const field of fields) {
            recordAction(deps, {
              tool: 'browser_fill',
              page,
              ref: field.ref,
              args: { value: field.value },
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

        recordAction(deps, { tool: 'browser_press_key', page, args: { key } });

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

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) throw new Error(refNotFound(ref));
          await el.hover();
        } else {
          // RPC fallback: dispatch mouseover event
          const safeRef = sanitizeRef(ref, scope);
          const val = await rpcEval(`(() => {
            const el = document.querySelector('[data-wmux-ref="${safeRef}"]');
            if (!el) return 'not_found';
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            return 'ok';
          })()`, scope);
          if (val === 'not_found') throw new Error(refNotFound(ref));
        }

        recordAction(deps, { tool: 'browser_hover', page, ref });

        return {
          content: [{ type: 'text' as const, text: `Hovered over element ref=${ref}` }],
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

          await page.mouse.move(sourceX, sourceY);
          await page.mouse.down();
          await page.mouse.move(targetX, targetY, { steps: 10 });
          await page.mouse.up();
        } else {
          // RPC fallback: simplified drag via JS events
          const safeSrc = sanitizeRef(sourceRef, scope);
          const safeTgt = sanitizeRef(targetRef, scope);
          const val = await rpcEval(`(() => {
            const src = document.querySelector('[data-wmux-ref="${safeSrc}"]');
            const tgt = document.querySelector('[data-wmux-ref="${safeTgt}"]');
            if (!src) return 'source_not_found';
            if (!tgt) return 'target_not_found';
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
            tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return 'ok';
          })()`, scope);
          if (val === 'source_not_found') throw new Error(refNotFound(sourceRef));
          if (val === 'target_not_found') throw new Error(refNotFound(targetRef));
        }

        recordAction(deps, { tool: 'browser_drag', page, ref: sourceRef, targetRef });

        return {
          content: [{ type: 'text' as const, text: `Dragged element ref=${sourceRef} to ref=${targetRef}` }],
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

        recordAction(deps, { tool: 'browser_scroll_into_view', page, ref });

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
            await el.evaluate(
              (node, [dx, dy]) => { (node as Element).scrollBy(dx, dy); },
              [deltaX, deltaY] as [number, number],
            );
          } else {
            await page.evaluate(
              ([dx, dy]) => { window.scrollBy(dx, dy); },
              [deltaX, deltaY] as [number, number],
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
