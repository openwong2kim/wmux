import { sendRequest } from '../client';
import { bindPaneClaim } from '../paneClaim';
import { refusalOf } from './action';
import type { RpcResponse } from '../../shared/rpc';

/**
 * wmux settings list
 * wmux settings get [<key>]
 * wmux settings set <key> <value>
 *
 * Reads and changes the settings in shared/appSettings.ts through the running
 * app (the `settings.*` app actions). From a wmux pane the call carries that
 * pane's claim and the app says an agent changed it; from a terminal outside
 * wmux it goes on the pipe token and the app says it came from the command
 * line. Settings that widen what an agent, another computer or a phone may do
 * are changed only in Settings, and the refusal names the section.
 */

const USAGE = 'usage: wmux settings list | get [<key>] | set <key> <value>';
const NOT_RUNNING = 'wmux is not running: settings change through the running app. Start wmux, then run this again.';

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

export type SettingsCommand =
  | { verb: 'list' }
  | { verb: 'get'; key?: string }
  | { verb: 'set'; key: string; value: string };

export function parseSettingsArgs(args: string[]): SettingsCommand {
  const [verb, ...rest] = args;
  if (rest.some((a) => a.startsWith('--'))) fail(`settings: unknown flag "${rest.find((a) => a.startsWith('--'))}"`);
  switch (verb) {
    case 'list':
      if (rest.length > 0) fail('settings list takes nothing else');
      return { verb: 'list' };
    case 'get':
      if (rest.length > 1) fail('settings get takes one key at most');
      return rest[0] ? { verb: 'get', key: rest[0] } : { verb: 'get' };
    case 'set':
      if (rest.length !== 2) fail('settings set takes a key and a value');
      return { verb: 'set', key: rest[0], value: rest[1] };
    default:
      fail(verb ? `settings: no command "${verb}" (${USAGE})` : USAGE);
  }
}

async function send(params: Record<string, unknown>): Promise<RpcResponse> {
  try {
    return await sendRequest('app.action', params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not running/i.test(message)) fail(NOT_RUNNING);
    throw err;
  }
}

/** A refusal, as JSON with --json and as an error line otherwise. */
function refuse(refusal: { code?: string; error: string }, jsonMode: boolean): never {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, ...refusal }, null, 2));
    process.exit(1);
  }
  fail(refusal.code ? `${refusal.code}: ${refusal.error}` : refusal.error);
}

const show = (v: unknown): string => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

export async function handleSettings(args: string[], jsonMode: boolean): Promise<void> {
  const cmd = parseSettingsArgs(args);
  let stop: string | null;
  try {
    stop = await bindPaneClaim();
  } catch (err) {
    if (/not running/i.test(err instanceof Error ? err.message : String(err))) fail(NOT_RUNNING);
    throw err;
  }
  if (stop) refuse({ code: 'no_identity', error: `settings: ${stop}` }, jsonMode);

  const params =
    cmd.verb === 'list' ? { id: 'settings.list', args: {} }
      : cmd.verb === 'get' ? { id: 'settings.get', args: cmd.key ? { key: cmd.key } : {} }
        : { id: 'settings.set', args: { key: cmd.key, value: cmd.value } };
  const response = await send(params);
  const refusal = refusalOf(response);
  if (refusal) {
    if (refusal.code === 'no_window') refusal.error = `the wmux window is not open: settings change through the running app (${refusal.error})`;
    refuse(refusal, jsonMode);
  }
  const result = (response as Extract<RpcResponse, { ok: true }>).result as Record<string, unknown>;
  if (jsonMode) {
    const rest = Object.fromEntries(Object.entries(result).filter(([k]) => k !== 'ok' && k !== 'id'));
    console.log(JSON.stringify(rest, null, 2));
    return;
  }
  if (cmd.verb === 'list') {
    const rows = (result['settings'] as Array<{ key: string; value: unknown; allowed: string }> | undefined) ?? [];
    const width = Math.max(0, ...rows.map((r) => r.key.length));
    console.log(rows.map((r) => `${r.key.padEnd(width)}  ${show(r.value)}  (${r.allowed})`).join('\n'));
    return;
  }
  if (cmd.verb === 'get') {
    const settings = (result['settings'] as Record<string, unknown> | undefined) ?? {};
    console.log(Object.entries(settings).map(([k, v]) => `${k} = ${show(v)}`).join('\n'));
    return;
  }
  console.log(result['changed'] === false
    ? `${cmd.key} is already ${show(result['value'])}`
    : `${cmd.key} = ${show(result['value'])}`);
}
