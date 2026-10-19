// ─── Bot connections — MCP servers the owner gives bots' workers ───────────
//
// Contract for main/factory/connectorStore.ts, the connection IPC
// (main/pipe/handlers/connector.rpc.ts), Settings › Bots › Connections and
// the bot profile's Connections row.
//
// The owner defines a connection once, in one library
// (`<wmuxDir>/factory/connectors.json`, main-window IPC only; bots cannot
// write it). Each connection has a scope: every bot (the default) or the bots
// picked. A bot gets the enabled connections scoped to it, minus the
// every-bot ones it was switched off for (`connectorsForBot`). A bot's
// workers may use them; a bot itself never does.
//
// A connection's keys live in the bot key store (factory/secrets.json) under
// their own names. Those names belong to the connection: a bot cannot hand
// them to a worker as plain `secretNames`, and its key list leaves them out.
// No value is held in a connection record: `secrets` names keys, and every
// literal (argument, variable, header) that holds a stored value is refused.

import { isCredentialEnvKey } from './envFilter';
import { isBotSecretName } from './botSecret';

export type ConnectorTransport = 'stdio' | 'http' | 'sse';

/** Which of a server's tools a worker may call. `all` minus `blocked`, or
 *  only the tools listed in `allowed`. */
export type ConnectorTools =
  | { mode: 'all'; blocked: string[] }
  | { mode: 'listed'; allowed: string[] };

export type ConnectorSecret =
  /** stdio: the server gets the value as the env var of the key's name. */
  | { secret: string; as: 'env' }
  /** http/sse: the value is sent in `header` (`Bearer <value>` or the value). */
  | { secret: string; as: 'header'; header: string; scheme: 'bearer' | 'raw' };

export type ConnectorScope = { kind: 'all' } | { kind: 'bots'; botIds: string[] };

export type ConnectorPresetId = 'github' | 'filesystem';

export interface Connector {
  /** 'con-' + 8 hex, minted by main. */
  id: string;
  /** The MCP server key and tool prefix (`mcp__<name>__<tool>`), unique in
   *  the library (CONNECTOR_NAME_RE). */
  name: string;
  /** The owner's one line, shown to bots. */
  purpose?: string;
  /** The preset the owner started from (display only). */
  preset?: ConnectorPresetId;
  transport: ConnectorTransport;
  /** stdio: `command` is an absolute path, resolved when it was saved. */
  stdio?: { command: string; args: string[]; env: Record<string, string> };
  /** http/sse. */
  remote?: { url: string; headers: Record<string, string> };
  /** Key names (never values). */
  secrets: ConnectorSecret[];
  tools: ConnectorTools;
  scope: ConnectorScope;
  /** Bots an every-bot connection is switched off for. */
  offFor: string[];
  /** Library-wide on/off. */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** What the owner's dialog sends to save: a connection without what main
 *  owns (id on create, timestamps, offFor). `stdio.command` may be a bare
 *  name; main resolves it to an absolute path. */
export type ConnectorDraft = Omit<Connector, 'id' | 'createdAt' | 'updatedAt' | 'offFor'> & { id?: string };

export const CONNECTOR_LIMITS = {
  LIBRARY: 32,
  PER_FANOUT: 8,
  ARGS: 32,
  ARG: 512,
  ENV: 32,
  ENV_VALUE: 1024,
  HEADERS: 16,
  HEADER_VALUE: 1024,
  URL: 2048,
  PURPOSE: 120,
  SECRETS: 8,
  TOOLS: 64,
  COMMAND: 1024,
  BOTS: 64,
} as const;

/** Main-window IPC (the owner only). */
export const CONNECTOR_IPC = {
  list: 'factory:connector:list',
  save: 'factory:connector:save',
  remove: 'factory:connector:remove',
  setOffForBot: 'factory:connector:offForBot',
  setEnabled: 'factory:connector:setEnabled',
} as const;

/** The worker CLIs a task's connections are wired for. */
export const CONNECTOR_WORKER_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex']);

export const CONNECTOR_ID_RE = /^con-[0-9a-f]{8}$/;
/** Lower-case words joined by single hyphens: no `_`, so a tool name
 *  `mcp__<name>__<tool>` splits one way only. */
export const CONNECTOR_NAME_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
export const CONNECTOR_TOOL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
/** An HTTP header field name (RFC 9110 token). */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const BOT_ID_RE = /^bot-[0-9a-f]{8}$/;

/** Names that would shadow a server wmux or an agent brings itself. */
export function isReservedConnectorName(name: string): boolean {
  return name === 'wmux' || name.startsWith('wmux-') || name.startsWith('claude') || name.startsWith('codex') || name === 'ide';
}

/** Env keys a connection may not set: what changes how a program or its
 *  package manager loads code, wmux's and the agents' own variables. */
export function isRefusedConnectorEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  return k === 'NODE_OPTIONS' || k === 'NODE_PATH' || k === 'PATH' || k === 'HOME' || k === 'CODEX_HOME'
    || k.startsWith('LD_') || k.startsWith('DYLD_') || k.startsWith('WMUX_') || k.startsWith('ELECTRON_')
    || k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE') || k.startsWith('NPM_CONFIG_');
}

/** A header whose literal value would be a credential: it must be a key. */
function isCredentialHeader(name: string): boolean {
  return /^(authorization|proxy-authorization|cookie)$/i.test(name) || /(token|secret|key|password|auth)/i.test(name);
}

/** Control characters (C0, DEL, C1) and line separators. */
function hasControl(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s);
}

/** A literal that is never expanded: no control characters and no `${`
 *  (Claude expands `${VAR}` in an MCP config, which would pull any variable
 *  of the worker, a key included, into the server's arguments). */
function isPlainLiteral(s: unknown, max: number): s is string {
  return typeof s === 'string' && s.length <= max && !hasControl(s) && !s.includes('${');
}

/** A URL a remote connection may use: https, or http to this computer; no
 *  user name or password, no fragment. Pure. */
export function isConnectorUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > CONNECTOR_LIMITS.URL || hasControl(raw) || /\s/.test(raw) || raw.includes('${')) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash || raw.includes('#')) return false;
  if (u.protocol === 'https:') return !!u.hostname;
  if (u.protocol === 'http:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  return false;
}

/** A stdio command as typed: a bare program name (looked up on PATH when it
 *  is saved) or an absolute path. Never a relative path (it would resolve
 *  inside the worker's checkout), never quoting or shell syntax, never a
 *  privilege change. Pure. */
export function commandRefusal(command: unknown, platform: NodeJS.Platform = process.platform): string | null {
  if (typeof command !== 'string' || command.trim() === '') return 'The command is empty.';
  if (command.length > CONNECTOR_LIMITS.COMMAND || hasControl(command)) return 'The command is too long or holds control characters.';
  if (/["'`$;&|<>()*?!%\n]/.test(command)) return 'The command may not hold quotes, $, backticks or shell operators.';
  const absolute = platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(command) : command.startsWith('/');
  if (!absolute && /[\\/]/.test(command)) return 'Use a program name or an absolute path, not a relative path.';
  const base = command.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  if (base === 'sudo' || base === 'su' || base === 'doas' || base === 'runas' || base === 'pkexec') return 'A connection may not change user.';
  return null;
}

export type ConnectorRefusal = { ok: false; field: string; message: string };

export interface ConnectorValidationContext {
  /** The library as it is (the connection being edited included). */
  library: readonly Connector[];
  /** The bots that exist now. */
  botIds: ReadonlySet<string>;
  platform?: NodeJS.Platform;
}

function refuse(field: string, message: string): ConnectorRefusal {
  return { ok: false, field, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function stringList(raw: unknown, max: number, each: (s: string) => boolean): string[] | null {
  if (!Array.isArray(raw) || raw.length > max) return null;
  if (!raw.every((s) => typeof s === 'string' && each(s))) return null;
  return [...raw] as string[];
}

function toolsOf(raw: unknown): ConnectorTools | null {
  if (!isRecord(raw)) return null;
  const valid = (s: string) => CONNECTOR_TOOL_RE.test(s);
  if (raw.mode === 'all') {
    const blocked = stringList(raw.blocked ?? [], CONNECTOR_LIMITS.TOOLS, valid);
    return blocked ? { mode: 'all', blocked: [...new Set(blocked)] } : null;
  }
  if (raw.mode === 'listed') {
    const allowed = stringList(raw.allowed ?? [], CONNECTOR_LIMITS.TOOLS, valid);
    return allowed ? { mode: 'listed', allowed: [...new Set(allowed)] } : null;
  }
  return null;
}

function scopeOf(raw: unknown): ConnectorScope | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'all') return { kind: 'all' };
  if (raw.kind === 'bots') {
    const ids = stringList(raw.botIds, CONNECTOR_LIMITS.BOTS, (s) => BOT_ID_RE.test(s));
    return ids ? { kind: 'bots', botIds: [...new Set(ids)] } : null;
  }
  return null;
}

function secretsOf(raw: unknown, transport: ConnectorTransport): ConnectorSecret[] | string {
  if (!Array.isArray(raw)) return 'Keys are malformed.';
  if (raw.length > CONNECTOR_LIMITS.SECRETS) return `At most ${CONNECTOR_LIMITS.SECRETS} keys.`;
  const out: ConnectorSecret[] = [];
  const names = new Set<string>();
  const headers = new Set<string>();
  for (const s of raw) {
    if (!isRecord(s) || !isBotSecretName(s.secret)) {
      return 'A key name must be an upper-case env name that reads as a credential (for example GITHUB_MCP_TOKEN).';
    }
    if (names.has(s.secret)) return `The key ${s.secret} is listed twice.`;
    names.add(s.secret);
    if (s.as === 'env') {
      if (transport !== 'stdio') return 'A remote connection sends its keys in headers.';
      if (isRefusedConnectorEnvKey(s.secret)) return `${s.secret} may not be set by a connection.`;
      out.push({ secret: s.secret, as: 'env' });
    } else if (s.as === 'header') {
      if (transport === 'stdio') return 'A local command gets its keys as variables.';
      if (typeof s.header !== 'string' || !HEADER_NAME_RE.test(s.header)) return 'A key\'s header name is not a valid header name.';
      if (headers.has(s.header.toLowerCase())) return `The header ${s.header} is set twice.`;
      headers.add(s.header.toLowerCase());
      if (s.scheme !== 'bearer' && s.scheme !== 'raw') return 'A key\'s header form is Bearer or the value itself.';
      out.push({ secret: s.secret, as: 'header', header: s.header, scheme: s.scheme });
    } else {
      return 'A key goes in a variable or a header.';
    }
  }
  return out;
}

/** The shape of a connection, checked field by field: what main runs on a
 *  save (with the library rules after it) and on every record it reads.
 *  Returns the clean record or the first refusal. Pure. */
export function parseConnectorShape(
  raw: unknown,
  platform: NodeJS.Platform = process.platform,
): { ok: true; connector: Omit<Connector, 'id' | 'createdAt' | 'updatedAt'> & { id?: string } } | ConnectorRefusal {
  if (!isRecord(raw)) return refuse('connection', 'The connection is malformed.');
  if (raw.id !== undefined && (typeof raw.id !== 'string' || !CONNECTOR_ID_RE.test(raw.id))) return refuse('connection', 'The connection id is malformed.');
  const name = raw.name;
  if (typeof name !== 'string' || !CONNECTOR_NAME_RE.test(name)) {
    return refuse('name', 'The name is 2-32 lower-case letters, digits and single hyphens, starting with a letter (for example github).');
  }
  if (name.includes('--')) return refuse('name', 'The name may not hold two hyphens in a row.');
  if (isReservedConnectorName(name)) return refuse('name', `${name} is reserved for wmux and the agents.`);
  let purpose: string | undefined;
  if (raw.purpose !== undefined && raw.purpose !== '') {
    if (typeof raw.purpose !== 'string' || hasControl(raw.purpose) || raw.purpose.trim().length > CONNECTOR_LIMITS.PURPOSE) {
      return refuse('purpose', `The purpose is one line of at most ${CONNECTOR_LIMITS.PURPOSE} characters.`);
    }
    purpose = raw.purpose.trim() || undefined;
  }
  const preset = raw.preset === 'github' || raw.preset === 'filesystem' ? raw.preset : undefined;
  const transport = raw.transport;
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') return refuse('transport', 'The connection is a local command or a remote URL.');
  const secrets = secretsOf(raw.secrets ?? [], transport);
  if (typeof secrets === 'string') return refuse('secrets', secrets);
  const secretNames = new Set(secrets.map((s) => s.secret));
  let stdio: Connector['stdio'];
  let remote: Connector['remote'];
  if (transport === 'stdio') {
    if (raw.remote !== undefined) return refuse('transport', 'A local command has no URL.');
    if (!isRecord(raw.stdio)) return refuse('command', 'The command is missing.');
    const why = commandRefusal(raw.stdio.command, platform);
    if (why) return refuse('command', why);
    const args = stringList(raw.stdio.args ?? [], CONNECTOR_LIMITS.ARGS, (s) => isPlainLiteral(s, CONNECTOR_LIMITS.ARG));
    if (!args) return refuse('args', `At most ${CONNECTOR_LIMITS.ARGS} arguments of ${CONNECTOR_LIMITS.ARG} characters, with no control characters and no \${.`);
    if (!isRecord(raw.stdio.env ?? {})) return refuse('env', 'The variables are malformed.');
    const envIn = Object.entries((raw.stdio.env ?? {}) as Record<string, unknown>);
    if (envIn.length > CONNECTOR_LIMITS.ENV) return refuse('env', `At most ${CONNECTOR_LIMITS.ENV} variables.`);
    const env: Record<string, string> = {};
    for (const [k, v] of envIn) {
      if (!ENV_KEY_RE.test(k) || k.length > 64) return refuse('env', `${k} is not an upper-case variable name.`);
      if (isRefusedConnectorEnvKey(k)) return refuse('env', `${k} may not be set by a connection.`);
      if (isCredentialEnvKey(k) || secretNames.has(k)) return refuse('env', `${k} reads as a credential: add it under Keys instead, so its value is stored encrypted.`);
      if (!isPlainLiteral(v, CONNECTOR_LIMITS.ENV_VALUE)) return refuse('env', `${k}'s value is too long, holds control characters or \${.`);
      env[k] = v;
    }
    stdio = { command: (raw.stdio.command as string).trim(), args, env };
  } else {
    if (raw.stdio !== undefined) return refuse('transport', 'A remote URL has no command.');
    if (!isRecord(raw.remote)) return refuse('url', 'The URL is missing.');
    if (!isConnectorUrl(raw.remote.url)) return refuse('url', 'The URL must be https (or http to this computer), with no user name, password or #fragment.');
    if (!isRecord(raw.remote.headers ?? {})) return refuse('headers', 'The headers are malformed.');
    const hIn = Object.entries((raw.remote.headers ?? {}) as Record<string, unknown>);
    if (hIn.length > CONNECTOR_LIMITS.HEADERS) return refuse('headers', `At most ${CONNECTOR_LIMITS.HEADERS} headers.`);
    const keyed = new Set(secrets.flatMap((s) => (s.as === 'header' ? [s.header.toLowerCase()] : [])));
    const headers: Record<string, string> = {};
    for (const [k, v] of hIn) {
      if (!HEADER_NAME_RE.test(k)) return refuse('headers', `${k} is not a header name.`);
      if (isCredentialHeader(k)) return refuse('headers', `${k} carries a credential: add it under Keys instead, so its value is stored encrypted.`);
      if (keyed.has(k.toLowerCase())) return refuse('headers', `${k} is also sent from a key.`);
      if (!isPlainLiteral(v, CONNECTOR_LIMITS.HEADER_VALUE)) return refuse('headers', `${k}'s value is too long, holds control characters or \${.`);
      headers[k] = v;
    }
    remote = { url: raw.remote.url as string, headers };
  }
  const tools = toolsOf(raw.tools);
  if (!tools) return refuse('tools', `Tool names are letters, digits, _ and - (at most ${CONNECTOR_LIMITS.TOOLS}).`);
  const scope = scopeOf(raw.scope ?? { kind: 'all' });
  if (!scope) return refuse('scope', 'The bots picked are malformed.');
  const offFor = raw.offFor === undefined ? [] : stringList(raw.offFor, CONNECTOR_LIMITS.BOTS, (s) => BOT_ID_RE.test(s));
  if (!offFor) return refuse('scope', 'The bots it is off for are malformed.');
  if (typeof raw.enabled !== 'boolean') return refuse('enabled', 'On or off is missing.');
  return {
    ok: true,
    connector: {
      ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
      name,
      ...(purpose ? { purpose } : {}),
      ...(preset ? { preset } : {}),
      transport,
      ...(stdio ? { stdio } : {}),
      ...(remote ? { remote } : {}),
      secrets,
      tools,
      scope,
      // Off-for applies to an every-bot connection only.
      offFor: scope.kind === 'all' ? [...new Set(offFor)] : [],
      enabled: raw.enabled,
    },
  };
}

/** Every string the owner wrote into a connection (field names included):
 *  what is checked for a stored key value on save and on read. Pure. */
export function connectorTexts(c: Pick<Connector, 'name' | 'purpose' | 'stdio' | 'remote' | 'secrets' | 'tools'>): string[] {
  return [
    c.name,
    ...(c.purpose ? [c.purpose] : []),
    ...(c.stdio ? [c.stdio.command, ...c.stdio.args, ...Object.entries(c.stdio.env).flat()] : []),
    ...(c.remote ? [c.remote.url, ...Object.entries(c.remote.headers).flat()] : []),
    ...c.secrets.flatMap((s) => (s.as === 'header' ? [s.secret, s.header] : [s.secret])),
    ...(c.tools.mode === 'all' ? c.tools.blocked : c.tools.allowed),
  ];
}

/** The library rules of a save: a unique name, bots that exist. Pure. */
export function libraryRefusal(
  c: { id?: string; name: string; scope: ConnectorScope },
  ctx: Pick<ConnectorValidationContext, 'library' | 'botIds'>,
): ConnectorRefusal | null {
  if (ctx.library.some((o) => o.name === c.name && o.id !== c.id)) return refuse('name', `A connection named ${c.name} exists already.`);
  if (!c.id && ctx.library.length >= CONNECTOR_LIMITS.LIBRARY) return refuse('connection', `At most ${CONNECTOR_LIMITS.LIBRARY} connections.`);
  if (c.scope.kind === 'bots') {
    const unknown = c.scope.botIds.filter((id) => !ctx.botIds.has(id));
    if (unknown.length > 0) return refuse('scope', 'A bot picked no longer exists.');
  }
  return null;
}

/** What one bot gets, in library order: the enabled connections scoped to
 *  every bot that it was not switched off for, and those scoped to it. Pure. */
export function connectorsForBot(lib: readonly Connector[], botId: string): Connector[] {
  return lib.filter((c) => c.enabled && (c.scope.kind === 'all' ? !c.offFor.includes(botId) : c.scope.botIds.includes(botId)));
}

/** Every key name a connection in `lib` uses. Pure. */
export function connectorSecretNames(lib: readonly Connector[]): Set<string> {
  return new Set(lib.flatMap((c) => c.secrets.map((s) => s.secret)));
}

/** The other connections that use `secret`. Pure. */
export function otherConnectorsUsing(lib: readonly Connector[], secret: string, exceptId: string): Connector[] {
  return lib.filter((c) => c.id !== exceptId && c.secrets.some((s) => s.secret === secret));
}

// ── The owner's IPC shapes ───────────────────────────────────────────────

/** One connection as the owner's views show it. */
export interface ConnectorView extends Connector {
  /** Key names that are not stored (or not readable here). */
  missingKeys: string[];
}

export type ConnectorListResult =
  | { ok: true; connectors: ConnectorView[]; cannotStore?: { code: string; message: string } }
  | { ok: false; code: string; message: string };

export interface ConnectorSaveRequest {
  connector: ConnectorDraft;
  /** Values for the connection's keys, typed in the dialog (each stored
   *  once, after the connection; never sent back). */
  keyValues?: Record<string, string>;
}

export type ConnectorSaveResult =
  | { ok: true; connector: ConnectorView }
  | { ok: false; code: string; field?: string; message: string };

export interface ConnectorRemoveRequest {
  id: string;
  /** Also delete its keys that no other connection uses. */
  deleteKeys: boolean;
}

export type ConnectorRemoveResult =
  | { ok: true; deletedKeys: string[]; keptKeys: string[] }
  | { ok: false; code: string; message: string };

export type ConnectorSimpleResult = { ok: true; connector: ConnectorView } | { ok: false; code: string; message: string };
