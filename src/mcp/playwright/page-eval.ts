import type { Page } from 'playwright-core';
import type { PlaywrightEngine } from './PlaywrightEngine';
import { sendRpc } from '../wmux-client';

// ---------------------------------------------------------------------------
// Transport abstraction for DOM-extraction tools (issue #105)
// ---------------------------------------------------------------------------
//
// In a packaged build, playwright-core's connectOverCDP does not surface the
// Electron <webview> guest as a Playwright Page, so PlaywrightEngine.getPage()
// returns null. Tools that need to read the DOM must then fall back to the
// main-process RPC channel (browser.evaluate -> guest webContents), the same
// route browser_evaluate / browser_snapshot already use successfully.
//
// These helpers unify "evaluate a string expression, get a JSON value back"
// across both transports so extraction tools have a single code path that works
// whether or not a Playwright Page is available.

/** Evaluate a JS expression string and resolve its JSON-serialisable value. */
export type JsonEvaluator = (expression: string) => Promise<unknown>;

/** Evaluator backed by a live Playwright Page (dev / when getPage succeeds). */
export function pageEvaluator(page: Page): JsonEvaluator {
  return (expression) => page.evaluate(expression);
}

/**
 * Evaluator backed by the main-process RPC channel. Drives the guest webview's
 * webContents via browser.evaluate (CDP Runtime.evaluate, returnByValue), so it
 * works in packaged builds where the Playwright Page route does not.
 */
export function rpcEvaluator(surfaceId?: string): JsonEvaluator {
  return async (expression) => {
    const result = (await sendRpc('browser.evaluate', {
      expression,
      ...(surfaceId && { surfaceId }),
    })) as { value: unknown };
    return result.value;
  };
}

/**
 * Resolve the best evaluator for string-script tools (browser_extract_text and
 * the browser_smart_snapshot RPC path): a Playwright Page if one is available,
 * otherwise the RPC channel.
 *
 * Note: browser_extract_text's Playwright path was ALREADY string-based
 * (page.evaluate(buildSerialiseScript())), so routing it through pageEvaluator
 * is a zero-behavior-change unification — not a switch from function to string.
 */
export async function resolveEvaluator(
  engine: PlaywrightEngine,
  surfaceId?: string,
): Promise<JsonEvaluator> {
  const page = await engine.getPage(surfaceId).catch(() => null);
  return page ? pageEvaluator(page) : rpcEvaluator(surfaceId);
}

/**
 * Run a Playwright-style page function (`fn(arg)`) and resolve its JSON value.
 *
 * Used by browser_extract_data (issue #105 decision b): when a Page exists the
 * function runs natively via page.evaluate(fn, arg) — IDENTICAL to the prior
 * behavior, so the dev path cannot regress. When no Page is available it
 * stringifies the function for the RPC channel.
 *
 * `.toString()` is safe for the extraction functions because the MCP bundle
 * (scripts/build-mcp.js) runs esbuild WITHOUT minify and the functions are
 * self-contained — they reference only browser globals (document, Map, CSS) and
 * their single argument, never a module-level binding or closure variable.
 *
 * Security: `arg` is embedded only via JSON.stringify (a data literal that
 * cannot break out into executable code), so user-supplied values inside `arg`
 * (e.g. extract_data field names) cannot inject script.
 */
export async function evalFunctionOrRpc<A, R>(
  page: Page | null,
  fn: (arg: A) => R,
  arg: A,
  surfaceId?: string,
): Promise<R> {
  if (page) {
    // Playwright types page.evaluate's function param as PageFunction<Unboxed<A>, R>,
    // which a free generic A cannot satisfy. The function is correct at runtime
    // (it ran identically before #105 via the same call), so cast at this boundary.
    return (await page.evaluate(fn as (a: unknown) => R, arg)) as R;
  }
  const expression = `(${fn.toString()})(${JSON.stringify(arg)})`;
  const result = (await sendRpc('browser.evaluate', {
    expression,
    ...(surfaceId && { surfaceId }),
  })) as { value: R };
  return result.value;
}
