import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../PlaywrightEngine';
import { detectDangerousPatterns } from '../security';
import { rpcEvaluator } from '../page-eval';

// Optional surfaceId schema reused across tools
const optionalSurfaceId = z
  .string()
  .optional()
  .describe('Target a specific surface by ID. Omit to use the active surface.');

// ---------------------------------------------------------------------------
// Packaged RPC fallback helpers (#114)
// ---------------------------------------------------------------------------
//
// On packaged builds playwright-core cannot surface the guest <webview> as a
// Playwright Page, so engine.getPage() returns null and page.waitFor* is
// unavailable. browser_wait then polls the condition over the main-process CDP
// channel (browser.evaluate), the same route the state/extraction tools use
// (#105/#106/#111). Each predicate mirrors the Playwright path's semantics as
// closely as the transport allows.

/**
 * Convert a Playwright-style URL glob to an anchored RegExp, matching
 * `waitForURL` glob semantics: `**` spans path separators (`.*`), while a single
 * `*` is confined to one path segment (`[^/]*`). Every other regex metacharacter
 * is escaped first.
 */
function urlGlobToRegExp(glob: string): RegExp {
  const DOUBLE = String.fromCharCode(0); // placeholder so ** survives the single-* pass
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, DOUBLE)
    .replace(/\*/g, '[^/]*')
    .replace(new RegExp(DOUBLE, 'g'), '.*');
  return new RegExp(`^${escaped}$`);
}

/** Setup errors (no target / dead WebContents) are not transient navigation
 *  races — re-raise them immediately instead of polling until the deadline. */
function isSetupError(message: string): boolean {
  return /no webview target registered|WebContents unavailable/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
        const page = await engine.getPage(surfaceId).catch(() => null);

        // Packaged RPC fallback (#114): no Playwright Page, so poll the condition
        // over the CDP channel until it holds or the timeout elapses.
        if (!page) {
          const evaluate = rpcEvaluator(surfaceId);
          let predicate: () => Promise<boolean>;
          let label: string;
          let warningPrefix = '';

          // Priority: url > selector > text > fn > networkidle (mirrors the
          // Playwright path below).
          if (url) {
            const re = urlGlobToRegExp(url);
            // waitForURL waits for the load state (default 'load') after the URL
            // matches, so require document.readyState === 'complete' too — without
            // it the fallback could complete against a partially loaded page.
            predicate = async () => {
              const href = await evaluate('location.href');
              if (!(typeof href === 'string' && (href === url || re.test(href)))) return false;
              return (await evaluate('document.readyState')) === 'complete';
            };
            label = `URL matched "${url}"`;
          } else if (selector) {
            // waitForSelector defaults to state 'visible', so match attachment AND
            // visibility (non-empty box, not display:none/visibility:hidden) rather
            // than mere DOM presence.
            const expr =
              `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
              ` if (!el) return false;` +
              ` const s = window.getComputedStyle(el);` +
              ` if (s.visibility === 'hidden' || s.display === 'none') return false;` +
              ` const r = el.getBoundingClientRect();` +
              ` return r.width > 0 && r.height > 0; })()`;
            predicate = async () => Boolean(await evaluate(expr));
            label = `selector "${selector}" found`;
          } else if (text) {
            const expr = `!!(document.body && document.body.innerText.includes(${JSON.stringify(text)}))`;
            predicate = async () => Boolean(await evaluate(expr));
            label = `text "${text}" found`;
          } else if (fn) {
            const warnings = detectDangerousPatterns(fn);
            if (warnings.length > 0) {
              console.warn(`[browser_wait] Dangerous patterns in fn: ${warnings.join(', ')}`);
              warningPrefix = `⚠ Security warning: fn contains potentially dangerous patterns: ${warnings.join(', ')}.\n`;
            }
            // fn is a JS predicate expression evaluated in page context (Playwright
            // waitForFunction(string) semantics). Coerce to a boolean IN the page:
            // browser.evaluate returns only the CDP result.value, so a truthy but
            // non-serializable result (e.g. a DOM node from querySelector) would
            // otherwise come back as null and never satisfy the wait.
            predicate = async () => Boolean(await evaluate(`!!(${fn})`));
            label = 'custom predicate satisfied';
          } else {
            // networkidle has no page-target debugger equivalent over this
            // transport; approximate with document.readyState === 'complete'.
            predicate = async () => (await evaluate('document.readyState')) === 'complete';
            label = 'network idle (approximated by document.readyState === "complete" over the CDP fallback)';
          }

          const deadline = Date.now() + resolvedTimeout;
          for (;;) {
            let ok = false;
            try {
              ok = await predicate();
            } catch (error) {
              // A missing target / dead WebContents is a setup error, not a
              // transient navigation race — surface it immediately so the caller
              // gets an actionable message instead of a timeout.
              const message = error instanceof Error ? error.message : String(error);
              if (isSetupError(message)) throw error;
              // Otherwise transient (e.g. body not ready mid-navigation): keep polling.
            }
            if (ok) {
              return {
                content: [{ type: 'text' as const, text: warningPrefix + `Wait completed: ${label}` }],
              };
            }
            if (Date.now() >= deadline) {
              throw new Error(`Timeout ${resolvedTimeout}ms exceeded`);
            }
            await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
          }
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
            ? `⚠ Security warning: fn contains potentially dangerous patterns: ${warnings.join(', ')}.\n`
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
