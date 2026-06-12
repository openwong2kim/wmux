import type { RpcResponse } from '../shared/rpc';

/**
 * Extract the application-level error from an RPC response.
 *
 * Renderer-bridge handlers often report failure as `{ error: '...' }` INSIDE
 * the result payload while the RPC envelope stays `ok: true` (the dispatch
 * itself succeeded). Checking only `response.ok` masks those failures — e.g.
 * `surface.close` on a surface outside the active workspace returned
 * `{ error: 'surface not found' }` and the CLI printed "Closed surface: …".
 * Returns undefined when the call genuinely succeeded.
 */
export function getResultError(response: RpcResponse): string | undefined {
  if (!response.ok) return response.error;
  const r = response.result;
  if (
    r !== null &&
    typeof r === 'object' &&
    typeof (r as Record<string, unknown>)['error'] === 'string'
  ) {
    return (r as Record<string, string>)['error'];
  }
  return undefined;
}

/**
 * Guard for human-readable command paths: prints the (envelope- or
 * payload-level) error to stderr and exits 1; returns silently on success.
 * Declared as an assertion so callers keep the `response.result` narrowing
 * the old `if (!response.ok) return` guard provided.
 */
export function ensureOk(
  response: RpcResponse,
): asserts response is Extract<RpcResponse, { ok: true }> {
  const err = getResultError(response);
  if (err !== undefined) {
    console.error(`Error: ${err}`);
    process.exit(1);
  }
}

/**
 * Print the result field of a successful RPC response as JSON.
 * If the response contains an error, the error is printed to stderr and
 * the process exits with code 1. A payload-level `result.error` keeps the
 * machine-readable JSON on stdout but still exits 1 so scripts can rely on
 * the exit code.
 */
export function printResult(response: RpcResponse): void {
  if (!response.ok) {
    printError(response);
    return;
  }
  console.log(JSON.stringify(response.result, null, 2));
  if (getResultError(response) !== undefined) {
    process.exit(1);
  }
}

/**
 * Print the error field of a failed RPC response to stderr and exit with 1.
 */
export function printError(response: RpcResponse): void {
  const msg = !response.ok ? response.error : 'Unknown error from wmux';
  console.error(`Error: ${msg}`);
  process.exit(1);
}

/**
 * Parse a named flag value from an argv array.
 * e.g. parseFlag(['--name', 'dev'], '--name') => 'dev'
 * Returns undefined when the flag is not present.
 */
export function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('-')) return undefined;
  return value;
}

/**
 * Check whether a bare flag is present in argv.
 * e.g. hasFlag(['--json', 'identify'], '--json') => true
 */
export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}
