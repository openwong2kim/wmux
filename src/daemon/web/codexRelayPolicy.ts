import { ENV_KEYS } from '../../shared/constants';
import { WMUX_SERVER_KEY } from '../../shared/mcpTargets';

/**
 * What a pane's Codex relay lets through, and how it attaches the pane's
 * identity. Deny by default.
 *
 * Codex runs every thread of an account inside one shared server, so a
 * thread's shell commands and MCP servers cannot take their identity from the
 * server's environment. The relay serves exactly one pane and adds that
 * pane's identity, taken from the daemon's own session record, to every
 * request that creates or re-opens a thread or runs a command:
 *
 *   identity    thread/start, thread/resume, thread/fork: per-thread config
 *               overrides `shell_environment_policy.set.WMUX_*` (shell
 *               commands) and `mcp_servers.wmux.env.WMUX_*` (the wmux MCP),
 *               after removing every client-supplied value for those keys.
 *   exec        command/exec: WMUX_* removed from `env`, identity set.
 *   ownThread   requests that run work inside an existing thread: allowed
 *               only on a thread this pane started, resumed or forked.
 *   proven      allowed only while the shared server is proven clean.
 *   pass        everything else the protocol defines.
 *
 * A method the table does not know, a batch frame, or any request whose
 * identity cannot be guaranteed is refused and never forwarded.
 */

export type MethodClass = 'identity' | 'exec' | 'ownThread' | 'proven' | 'pass';

/** Every client request of the Codex app-server protocol this relay knows. */
export const CLIENT_REQUEST_CLASSES: Readonly<Record<string, MethodClass>> = {
  'thread/start': 'identity',
  'thread/resume': 'identity',
  'thread/fork': 'identity',
  'command/exec': 'exec',
  'turn/start': 'ownThread',
  'turn/steer': 'ownThread',
  'thread/shellCommand': 'ownThread',
  'review/start': 'ownThread',
  'thread/compact/start': 'ownThread',
  'thread/inject_items': 'ownThread',
  'thread/approveGuardianDeniedAction': 'ownThread',
  'mcpServer/tool/call': 'ownThread',
  // Restarts MCP servers outside any thread request, so without per-thread
  // overrides: only safe when the server itself carries no stale identity.
  'config/mcpServer/reload': 'proven',
  ...Object.fromEntries([
    'account/gatewayOAuth/cancel', 'account/gatewayOAuth/login', 'account/gatewayOAuth/read', 'account/login/cancel',
    'account/login/start', 'account/logout', 'account/rateLimitResetCredit/consume', 'account/rateLimits/read',
    'account/read', 'account/sendAddCreditsNudgeEmail', 'account/usage/read', 'account/workspaceMessages/read',
    'app/installed', 'app/list', 'app/read',
    'command/exec/resize', 'command/exec/terminate', 'command/exec/write',
    'config/batchWrite', 'config/read', 'config/value/write', 'configRequirements/read',
    'experimentalFeature/enablement/set', 'experimentalFeature/list',
    'externalAgentConfig/detect', 'externalAgentConfig/import', 'externalAgentConfig/import/readHistories',
    'externalAgentConfig/import/recordHistory', 'feedback/upload',
    'fs/copy', 'fs/createDirectory', 'fs/getMetadata', 'fs/readDirectory', 'fs/readFile', 'fs/remove', 'fs/unwatch',
    'fs/watch', 'fs/writeFile', 'fuzzyFileSearch', 'getAuthStatus', 'getConversationSummary', 'gitDiffToRemote',
    'hooks/list', 'initialize', 'marketplace/add', 'marketplace/remove', 'marketplace/upgrade',
    'mcpServer/oauth/login', 'mcpServer/resource/read', 'mcpServerStatus/list', 'model/list',
    'modelProvider/capabilities/read', 'permissionProfile/list',
    'plugin/install', 'plugin/installed', 'plugin/list', 'plugin/read', 'plugin/reconcile', 'plugin/share/checkout',
    'plugin/share/delete', 'plugin/share/list', 'plugin/share/save', 'plugin/share/updateTargets', 'plugin/skill/read',
    'plugin/uninstall', 'skills/config/write', 'skills/extraRoots/set', 'skills/list',
    'thread/archive', 'thread/attachment/add', 'thread/attachment/list', 'thread/attachment/remove', 'thread/delete',
    'thread/goal/clear', 'thread/goal/get', 'thread/goal/set', 'thread/items/list', 'thread/list', 'thread/loaded/list',
    'thread/metadata/update', 'thread/name/set', 'thread/read', 'thread/revert', 'thread/section/move',
    'thread/turns/list', 'thread/unarchive', 'thread/unsubscribe',
    'threadSection/create', 'threadSection/delete', 'threadSection/list', 'threadSection/update',
    'turn/interrupt', 'windowsSandbox/readiness', 'windowsSandbox/setupStart',
  ].map((m) => [m, 'pass' as const])),
};

export const CLIENT_NOTIFICATIONS: ReadonlySet<string> = new Set(['initialized']);

/**
 * Every WMUX_* key a thread could inherit from the shared server. All of them
 * are set on every thread (to the pane's value, or blank) so a stale value
 * inherited from a server started with some pane's environment never shows.
 */
export const PROTECTED_KEYS: readonly string[] = [
  ...new Set([...Object.values(ENV_KEYS), 'WMUX_COMMANDER_TOKEN', 'WMUX_SHELL_INTEGRATION', 'WMUX_USER_ZDOTDIR']),
];

/** Pane identity; values from the daemon's session record for that pane. */
export function threadIdentityEnv(
  session: { id: string; env?: Record<string, string> },
  daemonEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const paneEnv = session.env ?? {};
  const out: Record<string, string> = {};
  for (const key of PROTECTED_KEYS) out[key] = '';
  for (const key of [ENV_KEYS.WORKSPACE_ID, ENV_KEYS.WORKSPACE_NAME, ENV_KEYS.SURFACE_ID, ENV_KEYS.MEMBER_ID,
    ENV_KEYS.SOCKET_PATH, ENV_KEYS.AUTH_TOKEN]) out[key] = paneEnv[key] ?? '';
  out[ENV_KEYS.PTY_ID] = session.id;
  // Panes are stamped with their member id at spawn; one without has exactly
  // one sensible member identity, its own pty id.
  if (!out[ENV_KEYS.MEMBER_ID]) out[ENV_KEYS.MEMBER_ID] = session.id;
  // The instance this daemon serves; the pane's own value when it has one.
  out[ENV_KEYS.DATA_SUFFIX] = paneEnv[ENV_KEYS.DATA_SUFFIX] ?? daemonEnv[ENV_KEYS.DATA_SUFFIX] ?? '';
  return out;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const BARE = /^[A-Za-z0-9_-]+$/;

/** Split a TOML dotted key (`a."b.c".d`) into segments; undefined when malformed. */
export function splitDottedKey(key: string): string[] | undefined {
  const out: string[] = [];
  let i = 0;
  while (i <= key.length) {
    if (key[i] === '"' || key[i] === "'") {
      const q = key[i];
      const end = key.indexOf(q, i + 1);
      if (end < 0) return undefined;
      out.push(key.slice(i + 1, end));
      i = end + 1;
    } else {
      let end = key.indexOf('.', i);
      if (end < 0) end = key.length;
      const seg = key.slice(i, end).trim();
      if (!BARE.test(seg)) return undefined;
      out.push(seg);
      i = end;
    }
    if (i === key.length) return out;
    if (key[i] !== '.') return undefined;
    i++;
  }
  return out;
}

type Tree = Record<string, unknown>;

function mergeInto(tree: Tree, segs: string[], value: unknown): void {
  let node = tree;
  for (const seg of segs.slice(0, -1)) {
    const next = record(node[seg]);
    node[seg] = next ? { ...next } : {};
    node = node[seg] as Tree;
  }
  const last = segs[segs.length - 1];
  const existing = record(node[last]);
  const incoming = record(value);
  if (existing && incoming) {
    const merged: Tree = { ...existing };
    for (const [k, v] of Object.entries(incoming)) mergeInto(merged, [k], v);
    node[last] = merged;
  } else {
    node[last] = incoming ? JSON.parse(JSON.stringify(incoming)) : value;
  }
}

function flatten(tree: Tree, prefix: string[], out: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(tree)) {
    if (!BARE.test(k)) return false; // cannot be written back as a dotted override
    const obj = record(v);
    if (obj && Object.keys(obj).length > 0) { if (!flatten(obj, [...prefix, k], out)) return false; }
    else out[[...prefix, k].join('.')] = v;
  }
  return true;
}

const NORMALIZED_ROOTS = new Set(['shell_environment_policy', 'mcp_servers']);

/**
 * The client's `config` overrides with the pane's identity written last. Keys
 * under `shell_environment_policy` and `mcp_servers` are parsed into one tree
 * (dotted keys and nested objects alike), every client value for a protected
 * key is removed, and the tree is written back as dotted overrides. An
 * `include_only` list in force keeps the identity keys. Undefined when the
 * config cannot be normalized safely.
 */
export function withIdentityConfig(
  config: unknown,
  identity: Record<string, string>,
  opts: { mcp: boolean; effectiveIncludeOnly?: unknown },
): Record<string, unknown> | undefined {
  if (config !== undefined && config !== null && !record(config)) return undefined;
  const out: Record<string, unknown> = {};
  const tree: Tree = {};
  for (const [key, value] of Object.entries(record(config) ?? {})) {
    const segs = splitDottedKey(key);
    if (!segs) {
      if (NORMALIZED_ROOTS.has(key.split('.')[0].replace(/^["']/, ''))) return undefined;
      out[key] = value;
      continue;
    }
    if (NORMALIZED_ROOTS.has(segs[0])) mergeInto(tree, segs, value);
    else out[key] = value;
  }
  const policy = record(tree.shell_environment_policy) ?? {};
  const set = { ...(record(policy.set) ?? {}) };
  for (const key of Object.keys(set)) if (key.startsWith('WMUX_')) delete set[key];
  Object.assign(set, identity);
  const nextPolicy: Tree = { ...policy, set };
  const includeOnly = policy.include_only ?? opts.effectiveIncludeOnly;
  if (includeOnly !== undefined && includeOnly !== null) {
    if (!Array.isArray(includeOnly) || includeOnly.some((p) => typeof p !== 'string')) return undefined;
    if (includeOnly.length > 0) nextPolicy.include_only = [...new Set([...includeOnly as string[], ...Object.keys(identity)])];
  }
  tree.shell_environment_policy = nextPolicy;
  const servers = record(tree.mcp_servers);
  const wmux = servers ? record(servers[WMUX_SERVER_KEY]) : undefined;
  if (wmux) delete wmux.env;
  if (opts.mcp) {
    tree.mcp_servers = { ...(servers ?? {}), [WMUX_SERVER_KEY]: { ...(wmux ?? {}), env: { ...identity } } };
  }
  if (!flatten(tree, [], out)) return undefined;
  return out;
}

/** command/exec `env`: WMUX_* removed, identity set; blanks unset the variable. */
export function withIdentityEnv(env: unknown, identity: Record<string, string>): Record<string, string | null> | undefined {
  if (env !== undefined && env !== null && !record(env)) return undefined;
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(record(env) ?? {})) {
    if (k.startsWith('WMUX_')) continue;
    if (v !== null && typeof v !== 'string') return undefined;
    out[k] = v as string | null;
  }
  for (const [k, v] of Object.entries(identity)) out[k] = v === '' ? null : v;
  return out;
}

/** Does the effective config define a command-based wmux MCP server? undefined = unknown. */
export function effectiveWmuxMcp(configRead: unknown): boolean | undefined {
  const config = record(record(configRead)?.config);
  if (!config) return undefined;
  const servers = record(config.mcp_servers);
  if (!servers) return false;
  const wmux = record(servers[WMUX_SERVER_KEY]);
  return !!wmux && typeof wmux.command === 'string' && wmux.command.length > 0;
}

export function effectiveIncludeOnly(configRead: unknown): unknown {
  return record(record(record(configRead)?.config)?.shell_environment_policy)?.include_only;
}

export type Verdict =
  | { kind: 'forward'; message?: Record<string, unknown> }
  | { kind: 'refuse'; reason: string };

export interface PolicyContext {
  paneId: string;
  /** Pane identity once the pane is committed to the relay. */
  identity: Record<string, string> | undefined;
  /** Is the shared server proven to have been started clean? */
  serverProven: boolean;
  /** Owning pane of a thread, and whether that pane is still live. */
  owner(threadId: string): { paneId: string; live: boolean } | undefined;
  /** A read-only query on a separate upstream connection; rejects on failure. */
  query(method: 'config/read' | 'thread/loaded/list', params: Record<string, unknown>): Promise<unknown>;
}

const refuse = (reason: string): Verdict => ({ kind: 'refuse', reason });

/** Class of a client frame, or a refusal reason for frames never forwarded. */
export function classify(message: unknown): MethodClass | 'response' | 'notification' | { refuse: string } {
  if (Array.isArray(message)) return { refuse: 'batched requests are not supported' };
  const m = record(message);
  if (!m) return { refuse: 'malformed request' };
  if (typeof m.method !== 'string') return 'id' in m ? 'response' : { refuse: 'malformed request' };
  if (!('id' in m)) return CLIENT_NOTIFICATIONS.has(m.method) ? 'notification' : { refuse: `unsupported notification ${m.method}` };
  return CLIENT_REQUEST_CLASSES[m.method] ?? { refuse: `unsupported request ${m.method}` };
}

async function loadedElsewhere(ctx: PolicyContext, threadId: string): Promise<boolean | undefined> {
  try {
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res = record(await ctx.query('thread/loaded/list', cursor ? { cursor } : {}));
      const data = res?.data;
      if (!Array.isArray(data)) return undefined;
      for (const id of data) if (typeof id === 'string') seen.add(id);
      cursor = typeof res?.nextCursor === 'string' ? res.nextCursor : null;
      if (!cursor) return seen.has(threadId);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Decide one client frame. Never forwards a thread or command without identity. */
export async function reviewClientFrame(message: unknown, ctx: PolicyContext): Promise<Verdict> {
  const cls = classify(message);
  if (typeof cls === 'object') return refuse(cls.refuse);
  if (cls === 'response' || cls === 'notification' || cls === 'pass') return { kind: 'forward' };
  const m = message as Record<string, unknown>;
  const params = m.params === undefined || m.params === null ? {} : record(m.params);
  if (!params) return refuse('malformed request parameters');

  if (cls === 'proven') return ctx.serverProven ? { kind: 'forward' } : refuse('the Codex background server has not been confirmed clean');

  if (cls === 'ownThread') {
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    const owner = threadId ? ctx.owner(threadId) : undefined;
    return owner?.paneId === ctx.paneId ? { kind: 'forward' } : refuse('this thread was not opened from this pane');
  }

  const identity = ctx.identity;
  if (!identity) return refuse('pane identity is not available');

  if (cls === 'exec') {
    const env = withIdentityEnv(params.env, identity);
    if (!env) return refuse('command environment is malformed');
    return { kind: 'forward', message: { ...m, params: { ...params, env } } };
  }

  // identity: thread/start, thread/resume, thread/fork
  if (m.method !== 'thread/start') {
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    const owner = threadId ? ctx.owner(threadId) : undefined;
    if (owner && owner.paneId !== ctx.paneId && owner.live) return refuse('this thread belongs to another pane');
    // A resume re-opens the thread as-is when the server already has it
    // loaded, and then these overrides do not reach its running processes.
    if (m.method === 'thread/resume' && owner?.paneId !== ctx.paneId) {
      const loaded = threadId ? await loadedElsewhere(ctx, threadId) : undefined;
      if (loaded === true) return refuse('this thread is already open elsewhere');
      if (loaded === undefined && !ctx.serverProven) return refuse('cannot confirm where this thread is open');
    }
  }

  const clientConfig = record(params.config);
  const clientProfile = clientConfig && ('profile' in clientConfig);
  let effective: unknown;
  try {
    effective = await ctx.query('config/read', typeof params.cwd === 'string' ? { cwd: params.cwd } : {});
  } catch { effective = undefined; }
  let mcp = clientProfile ? undefined : effectiveWmuxMcp(effective);
  const clientTree: Tree = {};
  for (const [k, v] of Object.entries(clientConfig ?? {})) {
    const segs = splitDottedKey(k);
    if (segs && segs[0] === 'mcp_servers') mergeInto(clientTree, segs, v);
  }
  const clientWmux = record(record(clientTree.mcp_servers)?.[WMUX_SERVER_KEY]);
  if (clientWmux && typeof clientWmux.command === 'string') mcp = true;
  if (mcp === undefined) {
    // Unknown: on a proven-clean server an MCP without injected identity has
    // none at all and refuses on its own; otherwise it could inherit a stale one.
    if (!ctx.serverProven) return refuse('cannot determine the MCP configuration for this thread');
    mcp = false;
  }
  const config = withIdentityConfig(params.config, identity, {
    mcp, effectiveIncludeOnly: clientProfile ? undefined : effectiveIncludeOnly(effective),
  });
  if (!config) return refuse('thread configuration cannot carry the pane identity');
  return { kind: 'forward', message: { ...m, params: { ...params, config } } };
}

/** Thread ids a server response hands to the requesting pane. */
export function threadIdsFromResponse(method: string, result: unknown): string[] {
  const r = record(result);
  if (!r) return [];
  if (method === 'review/start') return typeof r.reviewThreadId === 'string' ? [r.reviewThreadId] : [];
  const id = record(r.thread)?.id;
  return typeof id === 'string' ? [id] : [];
}
