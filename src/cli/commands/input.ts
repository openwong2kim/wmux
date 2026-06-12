import { sendRequest } from '../client';
import { printResult, ensureOk, parseFlag, hasFlag } from '../utils';
import { resolveSelfContext, getParentPidDefault, type SelfContext } from '../identity';
import type { RpcResponse } from '../../shared/rpc';

/**
 * Resolve the routing params for a terminal-IO command.
 *
 *   --pane <ptyId>  → explicit target (no identity lookup)
 *   --active        → legacy behavior: whatever pane is focused in the UI
 *   (default)       → self-targeting: the pane whose shell spawned this CLI,
 *                     resolved via the verified PID-map walk. Falls back to
 *                     active-pane when not inside a wmux pane.
 *
 * Returned params carry workspaceId alongside ptyId so the main process
 * asserts ownership (assertWorkspaceOwnsPty) — self-targeting can never
 * write into a foreign workspace even if the map were wrong.
 *
 * `mode` handles the workspace-only identity case (older main that returns
 * `mappings` without pane-level `entries`):
 *   - 'require-pty' (send/send-key): a workspaceId WITHOUT a ptyId would make
 *     the server resolve the globally focused pane and then hard-fail the
 *     ownership assert whenever the user is viewing another workspace — worse
 *     than the pre-X4 CLI. Drop the identity entirely → pure active-pane.
 *   - 'workspace-scope-ok' (read-screen): the server forwards workspaceId to
 *     the renderer, which resolves the CALLER's own active pane scoped to
 *     that workspace — workspace-only identity is an improvement there.
 */
export async function resolveTargetParams(
  args: string[],
  mode: 'require-pty' | 'workspace-scope-ok',
): Promise<Record<string, unknown>> {
  const explicitPane = parseFlag(args, '--pane');
  if (explicitPane) return { ptyId: explicitPane };
  if (hasFlag(args, '--active')) return {};

  const ctx: SelfContext = await resolveSelfContext({
    sendRequest,
    env: process.env,
    ppid: process.ppid,
    getParentPid: getParentPidDefault,
  });
  if (mode === 'require-pty' && !ctx.ptyId) return {};
  const params: Record<string, unknown> = {};
  if (ctx.ptyId) params.ptyId = ctx.ptyId;
  if (ctx.workspaceId) params.workspaceId = ctx.workspaceId;
  return params;
}

/** Strip routing/option flags so the remaining args are the text payload. */
export function stripInputFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pane') {
      i++; // skip value
      continue;
    }
    if (a === '--active' || a === '--submit' || a === '--raw') continue;
    out.push(a);
  }
  return out;
}

export async function handleInput(
  cmd: string,
  args: string[],
  jsonMode: boolean
): Promise<void> {
  let response: RpcResponse;

  switch (cmd) {
    case 'send': {
      const text = stripInputFlags(args).join(' ');
      if (!text) {
        console.error('Error: send requires <text>');
        process.exit(1);
      }
      const target = await resolveTargetParams(args, 'require-pty');
      const params: Record<string, unknown> = { text, ...target };
      if (hasFlag(args, '--submit')) params.submit = true;
      if (hasFlag(args, '--raw')) params.raw = true;
      response = await sendRequest('input.send', params);
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        console.log(params.submit ? 'Text sent and submitted.' : 'Text sent.');
      }
      break;
    }

    case 'send-key': {
      const key = stripInputFlags(args)[0];
      if (!key) {
        console.error('Error: send-key requires <keystroke>');
        process.exit(1);
      }
      const target = await resolveTargetParams(args, 'require-pty');
      response = await sendRequest('input.sendKey', { key, ...target });
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        console.log(`Key sent: ${key}`);
      }
      break;
    }

    case 'read-screen': {
      const target = await resolveTargetParams(args, 'workspace-scope-ok');
      const params: Record<string, unknown> = { ...target };
      const tail = parseFlag(args, '--tail');
      if (tail && Number.isFinite(parseInt(tail, 10))) {
        params.tail_lines = parseInt(tail, 10);
      }
      response = await sendRequest('input.readScreen', params);
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        // server returns { text: string } object or plain string
        const result = response.result as { text?: string } | string;
        let screen: string;
        if (typeof result === 'object' && result !== null && 'text' in result) {
          screen = result.text ?? '';
        } else if (typeof result === 'string') {
          screen = result;
        } else {
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        process.stdout.write(screen);
        if (!screen.endsWith('\n')) process.stdout.write('\n');
      }
      break;
    }

    default:
      console.error(`Unknown input command: ${cmd}`);
      process.exit(1);
  }
}
