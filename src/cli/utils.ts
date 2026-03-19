import type { RpcResponse } from '../shared/rpc';

/**
 * Print the result field of a successful RPC response as JSON.
 * If the response contains an error, the error is printed to stderr and
 * the process exits with code 1.
 */
export function printResult(response: RpcResponse): void {
  if (!response.ok) {
    printError(response);
    return;
  }
  console.log(JSON.stringify(response.result, null, 2));
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
