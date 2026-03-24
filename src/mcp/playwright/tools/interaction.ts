import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { resolveRef } from '../snapshot';
import { getLocatorByRef } from '../dom-intelligence';
import { typeHumanlike } from '../human-typing';

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
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        if (smartRef !== undefined) {
          // Use dom-intelligence ref resolution
          const selector = getLocatorByRef(smartRef);
          if (!selector) {
            throw new Error(
              `Element with smartRef=${smartRef} not found. Run browser_smart_snapshot to get current refs.`,
            );
          }

          const locator = page.locator(selector);
          if (double) {
            await locator.dblclick();
          } else {
            await locator.click();
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: `Clicked${double ? ' (double)' : ''} element smartRef=${smartRef}`,
              },
            ],
          };
        }

        if (!ref) {
          throw new Error('Either ref or smartRef must be provided.');
        }

        const el = await resolveRef(page, ref);
        if (!el) {
          throw new Error(refNotFound(ref));
        }

        if (double) {
          await el.dblclick();
        } else {
          await el.click();
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Clicked${double ? ' (double)' : ''} element ref=${ref}`,
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
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const el = await resolveRef(page, ref);
        if (!el) {
          throw new Error(refNotFound(ref));
        }

        if (humanlike) {
          // Focus the element first, then use human-like typing via keyboard
          await el.click();
          await typeHumanlike(page, '', text);
        } else {
          await el.fill(text);
        }

        if (submit) {
          await page.keyboard.press('Enter');
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
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        let filled = 0;
        const errors: string[] = [];

        for (const field of fields) {
          const el = await resolveRef(page, field.ref);
          if (!el) {
            errors.push(refNotFound(field.ref));
            continue;
          }
          await el.fill(field.value);
          filled++;
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
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        await page.keyboard.press(key);

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
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const el = await resolveRef(page, ref);
        if (!el) {
          throw new Error(refNotFound(ref));
        }

        await el.hover();

        return {
          content: [
            { type: 'text' as const, text: `Hovered over element ref=${ref}` },
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
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const sourceEl = await resolveRef(page, sourceRef);
        if (!sourceEl) {
          throw new Error(refNotFound(sourceRef));
        }

        const targetEl = await resolveRef(page, targetRef);
        if (!targetEl) {
          throw new Error(refNotFound(targetRef));
        }

        // Get bounding boxes for source and target
        const sourceBox = await sourceEl.boundingBox();
        const targetBox = await targetEl.boundingBox();

        if (!sourceBox || !targetBox) {
          throw new Error(
            'Could not determine bounding box for source or target element.',
          );
        }

        // Perform drag from center of source to center of target
        const sourceX = sourceBox.x + sourceBox.width / 2;
        const sourceY = sourceBox.y + sourceBox.height / 2;
        const targetX = targetBox.x + targetBox.width / 2;
        const targetY = targetBox.y + targetBox.height / 2;

        await page.mouse.move(sourceX, sourceY);
        await page.mouse.down();
        await page.mouse.move(targetX, targetY, { steps: 10 });
        await page.mouse.up();

        return {
          content: [
            {
              type: 'text' as const,
              text: `Dragged element ref=${sourceRef} to ref=${targetRef}`,
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
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const el = await resolveRef(page, ref);
        if (!el) {
          throw new Error(refNotFound(ref));
        }

        await el.selectOption(values);

        return {
          content: [
            {
              type: 'text' as const,
              text: `Selected value(s) [${values.join(', ')}] in element ref=${ref}`,
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
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        const el = await resolveRef(page, ref);
        if (!el) {
          throw new Error(refNotFound(ref));
        }

        await el.scrollIntoViewIfNeeded();

        return {
          content: [
            {
              type: 'text' as const,
              text: `Scrolled element ref=${ref} into view`,
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
