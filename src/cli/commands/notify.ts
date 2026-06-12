import { sendRequest } from '../client';
import { printResult, ensureOk, parseFlag } from '../utils';
import { resolveSelfContext, getParentPidDefault } from '../identity';
import type { RpcResponse } from '../../shared/rpc';

const VALID_TYPES = new Set(['info', 'warning', 'error', 'agent']);

/**
 * wmux notify <title> [body]            — positional shorthand
 * wmux notify --title <t> --body <b>    — explicit flags (legacy)
 * Options: --type info|warning|error|agent, --workspace <id>
 *
 * When run inside a wmux pane the notification is routed to the caller's own
 * workspace (verified PID-map identity) so scripts in background workspaces
 * notify the right place instead of whichever workspace the user is viewing.
 */
export async function handleNotify(
  args: string[],
  jsonMode: boolean
): Promise<void> {
  const flagTitle = parseFlag(args, '--title');
  const flagBody = parseFlag(args, '--body');
  const type = parseFlag(args, '--type');
  const explicitWorkspace = parseFlag(args, '--workspace');

  // Positional form: args minus all flag pairs.
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--title' || a === '--body' || a === '--type' || a === '--workspace') {
      i++; // skip flag value
      continue;
    }
    if (a.startsWith('--')) continue;
    positionals.push(a);
  }

  const title = flagTitle ?? positionals[0];
  // When --title is given, ALL positionals are the body (joined) — slicing
  // only the first would silently drop the rest.
  const body = flagBody ?? (flagTitle ? positionals.join(' ') : positionals.slice(1).join(' '));

  if (!title) {
    console.error('Error: notify requires a title — `wmux notify "Done" "Build finished"` or --title/--body');
    process.exit(1);
  }
  if (type && !VALID_TYPES.has(type)) {
    console.error(`Error: --type must be one of: ${[...VALID_TYPES].join(', ')}`);
    process.exit(1);
  }

  let workspaceId = explicitWorkspace;
  if (!workspaceId) {
    const ctx = await resolveSelfContext({
      sendRequest,
      env: process.env,
      ppid: process.ppid,
      getParentPid: getParentPidDefault,
    });
    workspaceId = ctx.workspaceId;
  }

  const params: Record<string, unknown> = { title, body };
  if (type) params.type = type;
  if (workspaceId) params.workspaceId = workspaceId;

  const response: RpcResponse = await sendRequest('notify', params);

  if (jsonMode) {
    printResult(response);
  } else {
    ensureOk(response);
    console.log(`Notification sent: "${title}"`);
  }
}
