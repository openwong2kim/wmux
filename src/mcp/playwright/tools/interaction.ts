import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { resolveRef } from '../snapshot';
import { getLocatorByRef } from '../dom-intelligence';
import { typeHumanlike } from '../human-typing';
import { sendRpc } from '../../wmux-client';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

const REF_NOT_FOUND_HINT =
  'Element with ref={ref} not found. Run browser_snapshot to get current refs.';

function refNotFound(ref: string): string {
  return REF_NOT_FOUND_HINT.replace('{ref}', ref);
}

// ---------------------------------------------------------------------------
// RPC-based interaction helpers (used when Playwright page is unavailable)
// These resolve elements via data-wmux-ref attributes set by browser_snapshot.
// ---------------------------------------------------------------------------

async function rpcEval(expression: string, surfaceId?: string): Promise<string> {
  const result = await sendRpc('browser.evaluate', {
    expression,
    ...(surfaceId && { surfaceId }),
  }) as { value: string };
  return result.value;
}

async function rpcClick(ref: string, surfaceId?: string, _double?: boolean): Promise<void> {
  // Use CDP click: first get element coordinates via JS, then dispatch mouse events
  await sendRpc('browser.click.cdp', {
    selector: `[data-wmux-ref="${ref}"]`,
    ...(surfaceId && { surfaceId }),
  });
}

async function rpcFill(ref: string, value: string, surfaceId?: string): Promise<void> {
  // Click on the element first to focus it
  await rpcClick(ref, surfaceId);
  // Small delay for focus
  await new Promise(r => setTimeout(r, 100));
  // Select all existing text
  await sendRpc('browser.evaluate', {
    expression: `document.execCommand('selectAll')`,
    ...(surfaceId && { surfaceId }),
  });
  // Type the new value via CDP Input.insertText (handles CJK, React controlled inputs)
  await sendRpc('browser.type.cdp', {
    text: value,
    ...(surfaceId && { surfaceId }),
  });
}

async function rpcPressKey(key: string, surfaceId?: string): Promise<void> {
  await sendRpc('browser.press.cdp', {
    key,
    ...(surfaceId && { surfaceId }),
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
export function registerInteractionTools(server: McpServer): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_click
  // -----------------------------------------------------------------------
  server.tool(
    'browser_click',
    'Click an element identified by its ref number from the accessibility snapshot, or by a smartRef from browser_smart_snapshot.',
    {
      ref: z.string().optional().describe('Element ref number from browser_snapshot'),
      smartRef: z
        .number()
        .optional()
        .describe('Element ref number from browser_smart_snapshot (dom-intelligence). If provided, takes priority over ref.'),
      double: z
        .boolean()
        .optional()
        .describe('If true, perform a double-click instead of a single click.'),
      surfaceId: optionalSurfaceId,
    },
    async ({ ref, smartRef, double, surfaceId }) => {
      try {
        // Try Playwright first
        const page = await engine.getPage(surfaceId).catch(() => null);

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
        await rpcClick(resolvedRef, surfaceId, double);
        return {
          content: [{ type: 'text' as const, text: `Clicked${double ? ' (double)' : ''} element ref=${resolvedRef}` }],
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
  // browser_type
  // -----------------------------------------------------------------------
  server.tool(
    'browser_type',
    'Type text into an element identified by its ref number.',
    {
      ref: z.string().describe('Element ref number from browser_snapshot'),
      text: z.string().describe('Text to type into the element'),
      submit: z
        .boolean()
        .optional()
        .describe('If true, press Enter after typing.'),
      humanlike: z
        .boolean()
        .optional()
        .describe('If true, type with randomised human-like delays.'),
      surfaceId: optionalSurfaceId,
    },
    async ({ ref, text, submit, humanlike, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);

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
          await rpcFill(ref, text, surfaceId);
          if (submit) await rpcPressKey('Enter', surfaceId);
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
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  );

  // -----------------------------------------------------------------------
  // browser_fill
  // -----------------------------------------------------------------------
  server.tool(
    'browser_fill',
    'Fill multiple form fields at once. Each field is identified by a ref number.',
    {
      fields: z
        .array(
          z.object({
            ref: z.string().describe('Element ref number'),
            value: z.string().describe('Value to fill'),
          }),
        )
        .describe('Array of {ref, value} pairs to fill'),
      surfaceId: optionalSurfaceId,
    },
    async ({ fields, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);

        let filled = 0;
        const errors: string[] = [];

        for (const field of fields) {
          try {
            if (page) {
              const el = await resolveRef(page, field.ref);
              if (!el) { errors.push(refNotFound(field.ref)); continue; }
              await el.fill(field.value);
            } else {
              await rpcFill(field.ref, field.value, surfaceId);
            }
            filled++;
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
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
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  );

  // -----------------------------------------------------------------------
  // browser_press_key
  // -----------------------------------------------------------------------
  server.tool(
    'browser_press_key',
    'Press a keyboard key (e.g. Enter, Tab, Escape, ArrowDown, Control+a).',
    {
      key: z
        .string()
        .describe(
          'Key to press. Examples: Enter, Tab, Escape, ArrowDown, Control+a, Meta+c',
        ),
      surfaceId: optionalSurfaceId,
    },
    async ({ key, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);

        if (page) {
          await page.keyboard.press(key);
        } else {
          await rpcPressKey(key, surfaceId);
        }

        return {
          content: [{ type: 'text' as const, text: `Pressed key: ${key}` }],
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
  // browser_hover
  // -----------------------------------------------------------------------
  server.tool(
    'browser_hover',
    'Hover over an element identified by its ref number.',
    {
      ref: z.string().describe('Element ref number from browser_snapshot'),
      surfaceId: optionalSurfaceId,
    },
    async ({ ref, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) throw new Error(refNotFound(ref));
          await el.hover();
        } else {
          // RPC fallback: dispatch mouseover event
          const val = await rpcEval(`(() => {
            const el = document.querySelector('[data-wmux-ref="${ref}"]');
            if (!el) return 'not_found';
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            return 'ok';
          })()`, surfaceId);
          if (val === 'not_found') throw new Error(refNotFound(ref));
        }

        return {
          content: [{ type: 'text' as const, text: `Hovered over element ref=${ref}` }],
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
  // browser_drag
  // -----------------------------------------------------------------------
  server.tool(
    'browser_drag',
    'Drag an element from sourceRef to targetRef.',
    {
      sourceRef: z
        .string()
        .describe('Ref number of the element to drag from'),
      targetRef: z.string().describe('Ref number of the element to drop onto'),
      surfaceId: optionalSurfaceId,
    },
    async ({ sourceRef, targetRef, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);

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
          const val = await rpcEval(`(() => {
            const src = document.querySelector('[data-wmux-ref="${sourceRef}"]');
            const tgt = document.querySelector('[data-wmux-ref="${targetRef}"]');
            if (!src) return 'source_not_found';
            if (!tgt) return 'target_not_found';
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
            tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return 'ok';
          })()`, surfaceId);
          if (val === 'source_not_found') throw new Error(refNotFound(sourceRef));
          if (val === 'target_not_found') throw new Error(refNotFound(targetRef));
        }

        return {
          content: [{ type: 'text' as const, text: `Dragged element ref=${sourceRef} to ref=${targetRef}` }],
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
  // browser_select
  // -----------------------------------------------------------------------
  server.tool(
    'browser_select',
    'Select option(s) in a <select> element by value.',
    {
      ref: z.string().describe('Element ref number of the <select>'),
      values: z
        .array(z.string())
        .describe('Array of option values to select'),
      surfaceId: optionalSurfaceId,
    },
    async ({ ref, values, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) throw new Error(refNotFound(ref));
          await el.selectOption(values);
        } else {
          const escapedValues = JSON.stringify(values);
          const val = await rpcEval(`(() => {
            const el = document.querySelector('[data-wmux-ref="${ref}"]');
            if (!el || el.tagName !== 'SELECT') return 'not_found';
            const vals = ${escapedValues};
            [...el.options].forEach(o => { o.selected = vals.includes(o.value); });
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'ok';
          })()`, surfaceId);
          if (val === 'not_found') throw new Error(refNotFound(ref));
        }

        return {
          content: [{ type: 'text' as const, text: `Selected value(s) [${values.join(', ')}] in element ref=${ref}` }],
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
  // browser_scroll_into_view
  // -----------------------------------------------------------------------
  server.tool(
    'browser_scroll_into_view',
    'Scroll an element into the visible viewport.',
    {
      ref: z.string().describe('Element ref number from browser_snapshot'),
      surfaceId: optionalSurfaceId,
    },
    async ({ ref, surfaceId }) => {
      try {
        const page = await engine.getPage(surfaceId).catch(() => null);

        if (page) {
          const el = await resolveRef(page, ref);
          if (!el) throw new Error(refNotFound(ref));
          await el.scrollIntoViewIfNeeded();
        } else {
          const val = await rpcEval(`(() => {
            const el = document.querySelector('[data-wmux-ref="${ref}"]');
            if (!el) return 'not_found';
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return 'ok';
          })()`, surfaceId);
          if (val === 'not_found') throw new Error(refNotFound(ref));
        }

        return {
          content: [{ type: 'text' as const, text: `Scrolled element ref=${ref} into view` }],
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
