import { sendRequest, setWorkspaceToken } from '../client';
import { resolveSelfContext, getParentPidDefault } from '../identity';
import type { RpcResponse } from '../../shared/rpc';

/**
 * wmux action <id> [--target <workspaceId|surfaceId|#tag>] [--arg k=v ...]
 * wmux action --list
 *
 * Runs one app action (shared/appActions.ts) on the workspace of the wmux pane
 * this runs in. Main resolves that workspace from the pane claim it mints from
 * its own walk of this process's parents; a terminal outside wmux gets no
 * claim and is refused. A guard against mistakes, not a security boundary
 * against same-user code.
 */

interface ActionArgs {
  list: boolean;
  id: string;
  target?: string;
  args: Record<string, string>;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/** `--flag value` or `--flag=value`; returns the value and how many tokens it took. */
function flagValue(args: string[], i: number, flag: string): { value: string; used: number } | null {
  const a = args[i];
  if (a === flag) {
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`action: ${flag} needs a value`);
    return { value, used: 2 };
  }
  if (a.startsWith(`${flag}=`)) return { value: a.slice(flag.length + 1), used: 1 };
  return null;
}

export function parseActionArgs(args: string[]): ActionArgs {
  const out: ActionArgs = { list: false, id: '', args: {} };
  for (let i = 0; i < args.length;) {
    const a = args[i];
    if (a === '--list') { out.list = true; i++; continue; }
    const target = flagValue(args, i, '--target');
    if (target) {
      if (out.target !== undefined) fail('action: --target given twice');
      out.target = target.value;
      i += target.used;
      continue;
    }
    const arg = flagValue(args, i, '--arg');
    if (arg) {
      const eq = arg.value.indexOf('=');
      if (eq <= 0) fail(`action: --arg takes key=value, got "${arg.value}"`);
      const key = arg.value.slice(0, eq).trim();
      if (Object.prototype.hasOwnProperty.call(out.args, key)) fail(`action: --arg ${key} given twice`);
      out.args[key] = arg.value.slice(eq + 1);
      i += arg.used;
      continue;
    }
    if (a.startsWith('--')) fail(`action: unknown flag "${a}"`);
    if (out.id) fail(`action: one action at a time (got "${out.id}" and "${a}")`);
    out.id = a;
    i++;
  }
  return out;
}

/** The refusal in a response, with its code: the action's own, or the router's fence. */
function refusalOf(response: RpcResponse): { code?: string; error: string } | null {
  if (!response.ok) {
    return { ...(/worker fence/.test(response.error) ? { code: 'fenced' } : {}), error: response.error };
  }
  const r = response.result as Record<string, unknown> | null;
  if (r && typeof r === 'object' && r['ok'] === false) {
    return { ...(typeof r['code'] === 'string' ? { code: r['code'] } : {}), error: String(r['error'] ?? 'refused') };
  }
  return null;
}

function report(response: RpcResponse, jsonMode: boolean, summary: (result: Record<string, unknown>) => string): void {
  const refusal = refusalOf(response);
  if (refusal) {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, ...refusal }, null, 2));
      process.exit(1);
    }
    fail(refusal.code ? `${refusal.code}: ${refusal.error}` : refusal.error);
  }
  const result = (response as Extract<RpcResponse, { ok: true }>).result as Record<string, unknown>;
  console.log(jsonMode ? JSON.stringify(result, null, 2) : summary(result));
}

interface ListedAction {
  id: string;
  target: string;
  args: Record<string, { type: string; required?: boolean; values?: string[] }>;
  description: string;
}

function listLine(a: ListedAction): string {
  const args = Object.entries(a.args ?? {}).map(([k, spec]) => {
    const shape = spec.values ? spec.values.join('|') : spec.type;
    return spec.required ? `${k}=<${shape}>` : `[${k}=<${shape}>]`;
  });
  const target = a.target === 'none' ? '' : ` [--target <${a.target}>]`;
  return `  ${a.id}${target}${args.length ? ` ${args.join(' ')}` : ''}\n      ${a.description}`;
}

export async function handleAction(args: string[], jsonMode: boolean): Promise<void> {
  const parsed = parseActionArgs(args);

  if (parsed.list) {
    if (parsed.id || parsed.target !== undefined || Object.keys(parsed.args).length > 0) {
      fail('action: --list takes nothing else');
    }
    const response = await sendRequest('app.action.list', {});
    report(response, jsonMode, (result) => {
      const actions = (result['actions'] as ListedAction[] | undefined) ?? [];
      return ['App actions (wmux action <id> [--target <id|#tag>] [--arg key=value ...]):', ...actions.map(listLine)].join('\n');
    });
    return;
  }

  if (!parsed.id) fail('action requires an action id — `wmux action --list` lists them');

  // Main's own walk of this process's parents finds the pane and hands back
  // its claim; every request after this carries it. Without one, main refuses
  // with no_identity (outside a wmux pane, or a wmux app too old to mint one).
  const self = await resolveSelfContext({
    sendRequest,
    env: process.env,
    ppid: process.ppid,
    getParentPid: getParentPidDefault,
    callerPid: process.pid,
  });
  if (self.workspaceToken) setWorkspaceToken(self.workspaceToken);

  const params: Record<string, unknown> = { id: parsed.id, args: parsed.args };
  if (parsed.target !== undefined) params.target = parsed.target;
  const response = await sendRequest('app.action', params);
  report(response, jsonMode, (result) => {
    const { ok: _ok, id: _id, changed, ...rest } = result;
    const detail = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
    return `${parsed.id}: ${changed === false ? 'already so' : 'done'}${detail}`;
  });
}
