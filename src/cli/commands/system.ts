import { readFileSync } from 'fs';
import { join } from 'path';
import { sendRequest } from '../client';
import { printResult, ensureOk, parseFlag } from '../utils';
import { resolveSelfContext, getParentPidDefault } from '../identity';
import { ENV_KEYS } from '../../shared/constants';
import type { RpcResponse } from '../../shared/rpc';

function getFallbackVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

interface IdentifyResult {
  app: string;
  version: string;
  platform: string;
}

/**
 * `meta.*` writes are workspace-scoped SERVER-SIDE from `senderPtyId` (U8,
 * meta.rpc.ts): the daemon resolves the calling pane's workspace itself and
 * ignores any caller-supplied workspaceId, so an external caller that sends no
 * senderPtyId is refused outright. `set-status` / `set-progress` never attached
 * one, which made both commands fail unconditionally (#800).
 *
 * Same resolution ladder `wmux channel` uses, plus an explicit override:
 *   1. `--pane <ptyId>` — name the pane whose workspace to write;
 *   2. verified PID-map walk via the main pipe (resolveSelfContext, X4);
 *   3. env WMUX_PTY_ID — stamped into the pane env at spawn; survives a walk
 *      miss (descendant processes several hops up the tree).
 * Returns '' when none resolve — the caller is not in a wmux pane.
 */
async function resolveMetaSenderPtyId(args: string[]): Promise<string> {
  const explicitPane = parseFlag(args, '--pane');
  if (explicitPane) return explicitPane;
  try {
    const ctx = await resolveSelfContext({
      sendRequest,
      env: process.env,
      ppid: process.ppid,
      getParentPid: getParentPidDefault,
    });
    if (ctx.ptyId) return ctx.ptyId;
  } catch {
    // main pipe unavailable — fall through to the env hint
  }
  const envPty = process.env[ENV_KEYS.PTY_ID];
  return typeof envPty === 'string' && envPty.trim().length > 0 ? envPty.trim() : '';
}

/**
 * Fail closed BEFORE the RPC with a readable message. Without this the server's
 * own guard produces "cannot resolve the calling pane's workspace — send a
 * verified senderPtyId", which tells a human nothing about what to do.
 */
async function requireMetaSenderPtyId(cmd: string, args: string[]): Promise<string> {
  const senderPtyId = await resolveMetaSenderPtyId(args);
  if (!senderPtyId) {
    console.error(
      `Error: ${cmd} cannot tell which workspace to write — no resolvable pane identity ` +
        '(PID walk missed and WMUX_PTY_ID is unset).\n' +
        'Run it from a shell inside a wmux pane, or pass --pane <ptyId>.',
    );
    process.exit(1);
  }
  return senderPtyId;
}

/** Strip routing flags so the remaining args are the command payload. */
function stripSystemFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pane') {
      i++; // skip value
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

export async function handleSystem(
  cmd: string,
  args: string[],
  jsonMode: boolean
): Promise<void> {
  let response: RpcResponse;

  switch (cmd) {
    case 'identify': {
      response = await sendRequest('system.identify', {});
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        const info = response.result as IdentifyResult;
        console.log(`app:      ${info?.app ?? 'wmux'}`);
        console.log(`version:  ${info?.version ?? getFallbackVersion()}`);
        console.log(`platform: ${info?.platform ?? process.platform}`);
      }
      break;
    }

    case 'capabilities': {
      response = await sendRequest('system.capabilities', {});
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        // server may return { methods: string[] } or string[] directly
        const result = response.result as { methods?: string[] } | string[];
        const methods = Array.isArray(result) ? result : (result?.methods || []);
        if (methods.length > 0) {
          console.log('Supported RPC methods:');
          for (const m of methods) {
            console.log(`  ${m}`);
          }
        } else {
          console.log(JSON.stringify(response.result, null, 2));
        }
      }
      break;
    }

    case 'set-status': {
      const text = stripSystemFlags(args)[0];
      if (text === undefined) {
        console.error('Error: set-status requires <text>');
        process.exit(1);
      }
      const senderPtyId = await requireMetaSenderPtyId('set-status', args);
      response = await sendRequest('meta.setStatus', { text, senderPtyId });
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        console.log(`Status set: "${text}"`);
      }
      break;
    }

    case 'set-progress': {
      const raw = stripSystemFlags(args)[0];
      if (raw === undefined) {
        console.error('Error: set-progress requires <0-100>');
        process.exit(1);
      }
      const value = Number(raw);
      if (isNaN(value) || value < 0 || value > 100) {
        console.error('Error: progress value must be a number between 0 and 100');
        process.exit(1);
      }
      const senderPtyId = await requireMetaSenderPtyId('set-progress', args);
      response = await sendRequest('meta.setProgress', { value, senderPtyId });
      if (jsonMode) {
        printResult(response);
      } else {
        ensureOk(response);
        console.log(`Progress set: ${value}%`);
      }
      break;
    }

    default:
      console.error(`Unknown system command: ${cmd}`);
      process.exit(1);
  }
}
