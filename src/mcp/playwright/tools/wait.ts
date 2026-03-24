import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { detectDangerousPatterns } from '../security';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

/**
 * Register wait-related MCP tools on the given server.
 *
 * Tools:
 *  - browser_wait — wait for a URL, selector, text, JS predicate, or network idle
 */
export function registerWaitTools(server: McpServer): void {
  const engine = PlaywrightEngine.getInstance();

  // -----------------------------------------------------------------------
  // browser_wait
  // -----------------------------------------------------------------------
  server.tool(
    'browser_wait',
    'Wait for a condition: URL pattern, CSS selector, text content, custom JS predicate, or network idle. Priority: url > selector > text > fn > networkidle.',
    {
      url: z
        .string()
        .optional()
        .describe('URL or glob pattern to wait for (e.g. "**/dashboard**").'),
      selector: z
        .string()
        .optional()
        .describe('CSS selector to wait for.'),
      text: z
        .string()
        .optional()
        .describe('Text to wait for in document.body.innerText.'),
      fn: z
        .string()
        .optional()
        .describe('Custom JavaScript predicate function body to wait for (must return truthy).'),
      timeout: z
        .number()
        .optional()
        .describe('Maximum wait time in milliseconds. Defaults to 30000.'),
      surfaceId: optionalSurfaceId,
    },
    async ({ url, selector, text, fn, timeout, surfaceId }) => {
      const resolvedTimeout = timeout ?? 30000;

      try {
        const page = await engine.getPage(surfaceId);
        if (!page) {
          throw new Error('No browser page available. Call browser_open with a URL first to establish a CDP connection (required even if a browser panel is already visible).');
        }

        // Priority: url > selector > text > fn > networkidle
        if (url) {
          await page.waitForURL(url, { timeout: resolvedTimeout });
          return {
            content: [{ type: 'text' as const, text: `Wait completed: URL matched "${url}"` }],
          };
        }

        if (selector) {
          await page.waitForSelector(selector, { timeout: resolvedTimeout });
          return {
            content: [{ type: 'text' as const, text: `Wait completed: selector "${selector}" found` }],
          };
        }

        if (text) {
          await page.waitForFunction(
            (t: string) => document.body.innerText.includes(t),
            text,
            { timeout: resolvedTimeout },
          );
          return {
            content: [{ type: 'text' as const, text: `Wait completed: text "${text}" found` }],
          };
        }

        if (fn) {
          const warnings = detectDangerousPatterns(fn);
          if (warnings.length > 0) {
            console.warn(`[browser_wait] Dangerous patterns in fn: ${warnings.join(', ')}`);
          }
          await page.waitForFunction(fn, undefined, { timeout: resolvedTimeout });
          const warningPrefix = warnings.length > 0
            ? `\u26A0 Security warning: fn contains potentially dangerous patterns: ${warnings.join(', ')}.\n`
            : '';
          return {
            content: [{ type: 'text' as const, text: warningPrefix + 'Wait completed: custom predicate satisfied' }],
          };
        }

        // Default: wait for network idle
        await page.waitForLoadState('networkidle', { timeout: resolvedTimeout });
        return {
          content: [{ type: 'text' as const, text: `Wait completed: network idle` }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Provide clear timeout messaging
        if (message.includes('Timeout') || message.includes('timeout')) {
          const condition = url
            ? `URL "${url}"`
            : selector
              ? `selector "${selector}"`
              : text
                ? `text "${text}"`
                : fn
                  ? 'custom predicate'
                  : 'network idle';
          return {
            content: [
              {
                type: 'text' as const,
                text: `Timed out after ${resolvedTimeout}ms waiting for ${condition}`,
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
    },
  );
}
