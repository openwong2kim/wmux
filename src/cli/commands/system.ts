import { readFileSync } from 'fs';
import { join } from 'path';
import { sendRequest } from '../client';
import { printResult, ensureOk } from '../utils';
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
 *
 * Only rung 2 is verified. `--pane` and the env hint are same-user forgeable:
 * the daemon derives the workspace from the ptyId it is handed, but nothing
 * proves the calling process owns that pane. That is the accepted #113 ceiling
 * and exactly what `wmux send --pane` already allows, so this adds no new
 * authority — but it is why the verified walk is tried before the env hint
 * rather than the other way round, even though the hint is cheaper.
 */
async function resolveMetaSenderPtyId(explicitPane: string): Promise<string> {
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
async function requireMetaSenderPtyId(cmd: string, explicitPane: string): Promise<string> {
  const senderPtyId = await resolveMetaSenderPtyId(explicitPane);
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

interface SystemArgs {
  /** Explicit `--pane` target; '' when the caller did not name one. */
  paneId: string;
  /** Everything that was not a routing flag, in order. */
  payload: string[];
}

/**
 * Parse the routing flag and the payload in ONE pass.
 *
 * Two independent passes (parseFlag for the value, a stripper for the payload)
 * disagree at the edges: parseFlag ignores a value starting with `-` while the
 * stripper consumed the next token unconditionally, and neither recognised
 * `--pane=<v>` — so `set-status --pane=pty-x hello` published the literal string
 * "--pane=pty-x" to the caller's own workspace and exited 0. Parsing once
 * removes that whole class rather than patching each case.
 *
 * An unrecognised `--flag` is an error, not payload: silently posting a mistyped
 * flag as a status message is the same failure in a different costume. `--`
 * ends flag parsing for a payload that legitimately starts with dashes.
 */
function parseSystemArgs(cmd: string, args: string[]): SystemArgs {
  let paneId = '';
  const payload: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      payload.push(...args.slice(i + 1));
      break;
    }
    if (a === '--pane' || a.startsWith('--pane=')) {
      const value = a.startsWith('--pane=') ? a.slice('--pane='.length) : args[i + 1];
      if (!value || value.startsWith('-')) {
        console.error(`Error: ${cmd}: --pane requires a <ptyId>`);
        process.exit(1);
      }
      if (!a.includes('=')) i++; // consume the separate value token
      paneId = value;
      continue;
    }
    // Only double-dash is a flag — `set-progress -5` must reach the range check
    // as a value, not die here as an unknown flag.
    if (a.startsWith('--')) {
      console.error(
        `Error: ${cmd}: unknown flag "${a}". ` +
          'Put -- before a payload that starts with dashes.',
      );
      process.exit(1);
    }
    payload.push(a);
  }
  return { paneId, payload };
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
      const { paneId, payload } = parseSystemArgs('set-status', args);
      // Join, don't take [0]: `set-status Build failed` used to publish "Build"
      // and drop the rest without a word. `wmux send` has always joined.
      const text = payload.join(' ');
      if (!text) {
        console.error('Error: set-status requires <text>');
        process.exit(1);
      }
      const senderPtyId = await requireMetaSenderPtyId('set-status', paneId);
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
      const { paneId, payload } = parseSystemArgs('set-progress', args);
      // Exactly one non-blank token. `Number('')` is 0, so an empty argument
      // used to report "Progress set: 0%" — the same false success this PR
      // exists to remove — and a stray second token was dropped in silence.
      const raw = payload[0];
      if (raw === undefined || raw.trim() === '') {
        console.error('Error: set-progress requires <0-100>');
        process.exit(1);
      }
      if (payload.length > 1) {
        console.error(`Error: set-progress takes one value, got ${payload.length}`);
        process.exit(1);
      }
      const value = Number(raw);
      if (isNaN(value) || value < 0 || value > 100) {
        console.error('Error: progress value must be a number between 0 and 100');
        process.exit(1);
      }
      const senderPtyId = await requireMetaSenderPtyId('set-progress', paneId);
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
