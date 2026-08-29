import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { withAutomationLease } from '../automationLease';
import { resolveRef } from '../snapshot';
import { getLocatorByRef } from '../dom-intelligence';
import { typeHumanlike } from '../human-typing';
import { describeToolError } from '../toolError';
import {
  allowScopedRpcFallback,
  sendScopedBrowserRpc,
  type BrowserTargetScope,
  type BrowserToolDeps,
} from '../browserScope';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Omit for the active surface.');

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects.
const BROWSER_CLICK_SHAPE = {
  ref: z.string().optional(),
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
export function sanitizeRef(ref: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(ref)) throw new Error(`Invalid ref: "${ref}"`);
  return ref;
}

async function rpcClick(ref: string, scope: BrowserTargetScope, _double?: boolean): Promise<void> {
  // Use CDP click: first get element coordinates via JS, then dispatch mouse events
  const safeRef = sanitizeRef(ref);
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

async function rpcPressKey(key: string, scope: BrowserTargetScope): Promise<void> {
  await sendScopedBrowserRpc('browser.press.cdp', scope, {
    key,
  });
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
    'Click an element by ref (browser_snapshot) or smartRef (browser_smart_snapshot).',
    BROWSER_CLICK_SHAPE,
    async ({ ref, smartRef, double, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        // Try Playwright first
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        if (page) {
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
            return {
              content: [{ type: 'text' as const, text: `Clicked${double ? ' (double)' : ''} element smartRef=${smartRef}` }],
            };
          }

          if (!ref) throw new Error('Either ref or smartRef must be provided.');

          const el = await resolveRef(page, ref);
          if (!el) throw new Error(refNotFound(ref));
          if (double) await el.dblclick();
          else await el.click();
          return {
            content: [{ type: 'text' as const, text: `Clicked${double ? ' (double)' : ''} element ref=${ref}` }],
          };
        }

        // RPC fallback
        if (!ref && smartRef === undefined) throw new Error('Either ref or smartRef must be provided.');
        const resolvedRef = ref ?? String(smartRef);
        await rpcClick(resolvedRef, scope, double);
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
    'Type text into an element by ref.',
    BROWSER_TYPE_SHAPE,
    async ({ ref, text, submit, humanlike, surfaceId }) => withAutomationLease(deps, surfaceId, async (scope) => {
      try {
        const page = await engine.getPageForScope(scope).catch(allowScopedRpcFallback);

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) throw new Error(refNotFound(ref));
          if (humanlike) {
            await el.click();
            await typeHumanlike(page, '', text);
          } else {
            await el.fill(text);
          }
          if (submit) await page.keyboard.press('Enter');
        } else {
          // RPC fallback
          await rpcFill(ref, text, scope);
          if (submit) await rpcPressKey('Enter', scope);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Typed "${text}" into element ref=${ref}${submit ? ' and submitted' : ''}`,
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
          const safeRef = sanitizeRef(ref);
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
          const safeSrc = sanitizeRef(sourceRef);
          const safeTgt = sanitizeRef(targetRef);
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
          const safeRef = sanitizeRef(ref);
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
          const safeRef = sanitizeRef(ref);
          const val = await rpcEval(`(() => {
            const el = document.querySelector('[data-wmux-ref="${safeRef}"]');
            if (!el) return 'not_found';
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return 'ok';
          })()`, scope);
          if (val === 'not_found') throw new Error(refNotFound(ref));
        }

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
            const safeRef = sanitizeRef(ref);
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
