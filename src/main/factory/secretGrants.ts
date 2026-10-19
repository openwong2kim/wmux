// ─── Secret grants — a bot's named secrets for one worker spawn ────────────
//
// A bot names the secrets a worker should get (fanout `secretNames`); main
// checks them against the store when the fan-out is accepted, then
// FanOutService mints one grant per task spawn, bound to the bot, the task,
// the owner workspace and the task's folder. The grant id travels through the
// renderer's spawn (it carries no name and no value); pty:create resolves it
// just before the daemon create. A grant resolves at most once: the first
// look consumes it, whatever the outcome. It resolves only for the fan-out
// launch of a bot's worker in the folder and owner it was minted for, and
// only within BOT_SECRET_LIMITS.GRANT_TTL_MS. The values go to the daemon as
// `secretEnv`, apart from the session env (DaemonCreateSessionParams).

import crypto from 'node:crypto';
import path from 'node:path';
import { BOT_SECRET_LIMITS, SECRET_GRANT_ID_RE, isBotSecretName, type SecretGrantId } from '../../shared/botSecret';
import { isConnectionKey } from './connectorStore';

export interface SecretGrantSource {
  /** The values of `names`, or the names that are not stored. */
  values(names: readonly string[]): { ok: true; env: Record<string, string> } | { ok: false; missing: string[] };
  markUsed(names: readonly string[], botId: string): void;
}

interface Grant {
  botId: string;
  taskId: string;
  ownerWorkspaceId: string;
  cwd: string;
  /** Plain secrets the bot named (never a connection's key). */
  names: string[];
  /** The keys of the task's connections (each a connection's key, and one
   *  of the connections the spawn carries). */
  connectionNames: string[];
  expiresAt: number;
}

export type GrantResolution =
  | { ok: true; env: Record<string, string>; botId: string; names: string[] }
  | { ok: false; reason: string };

const grants = new Map<SecretGrantId, Grant>();
let source: (() => SecretGrantSource | null) | null = null;
let clock: () => number = Date.now;

/** The secrets module points grants at the running store. */
export function setSecretGrantSource(next: (() => SecretGrantSource | null) | null): void {
  source = next;
}

function sweep(now: number): void {
  for (const [id, g] of grants) if (g.expiresAt <= now) grants.delete(id);
}

/** Names a fan-out may carry: valid, distinct, at most NAMES_PER_FANOUT.
 *  Null when any is not. Pure. */
export function parseSecretNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > BOT_SECRET_LIMITS.NAMES_PER_FANOUT) return null;
  if (!raw.every(isBotSecretName)) return null;
  const names = [...new Set(raw as string[])];
  return names.length === raw.length ? names : null;
}

/** The stored-ness of `names` right now: null when all are stored, else the
 *  refusal text (the fan-out is refused before anything starts). */
export function secretNamesRefusal(names: readonly string[]): string | null {
  const s = source?.() ?? null;
  if (!s) return 'the key store is not running';
  const r = s.values(names);
  return r.ok ? null : `not stored: ${r.missing.join(', ')} (ask the owner with secret_request first)`;
}

/** Mint one single-use grant for one worker spawn. Null when a name is not
 *  stored any more (the task is then not launched). */
export function mintSecretGrant(input: { botId: string; taskId: string; ownerWorkspaceId: string; cwd: string; names: readonly string[]; connectionNames?: readonly string[] }): SecretGrantId | null {
  const now = clock();
  sweep(now);
  const connectionNames = [...(input.connectionNames ?? [])];
  const all = [...input.names, ...connectionNames];
  if (!input.botId || !input.taskId || !input.ownerWorkspaceId || !input.cwd || parseSecretNames(all) === null) return null;
  // A connection's key never goes out as a plain secret, whenever it became
  // one; a connection's key list holds only connection keys.
  if (input.names.some((n) => isConnectionKey(n)) || connectionNames.some((n) => !isConnectionKey(n))) return null;
  if (secretNamesRefusal(all) !== null) return null;
  const id = `sg-${crypto.randomBytes(24).toString('base64url')}`;
  grants.set(id, {
    botId: input.botId,
    taskId: input.taskId,
    ownerWorkspaceId: input.ownerWorkspaceId,
    cwd: path.resolve(input.cwd),
    names: [...input.names],
    connectionNames,
    expiresAt: now + BOT_SECRET_LIMITS.GRANT_TTL_MS,
  });
  return id;
}

/** Drop a grant that will not be used (the spawn failed before pty:create). */
export function revokeSecretGrant(id: SecretGrantId | null | undefined): void {
  if (id) grants.delete(id);
}

/**
 * pty:create's look-up. Consumes the grant on the first look. `spawn` is what
 * the create is: a bot worker's fan-out launch (`strictBotWorker`), its owner
 * workspace (`fanoutTaskOf`) and folder (`cwd`), and who main's in-flight
 * spawn mark says it is for (`spawns`: bot and task). Every one must match.
 */
export function resolveSecretGrant(
  id: unknown,
  spawn: { strictBotWorker: boolean; fanoutTaskOf: unknown; cwd: unknown; spawns?: ReadonlyArray<{ botId: string; taskId: string; connectors?: ReadonlyArray<{ secrets: ReadonlyArray<{ secret: string }> }> }> },
): GrantResolution {
  if (typeof id !== 'string' || !SECRET_GRANT_ID_RE.test(id)) return { ok: false, reason: 'not a secret grant' };
  const grant = grants.get(id);
  grants.delete(id);
  const now = clock();
  sweep(now);
  if (!grant) return { ok: false, reason: 'the secret grant is unknown or already used' };
  if (grant.expiresAt <= now) return { ok: false, reason: 'the secret grant expired' };
  if (!spawn.strictBotWorker) return { ok: false, reason: 'secrets go only to a bot worker\'s fan-out launch' };
  if (spawn.fanoutTaskOf !== grant.ownerWorkspaceId) return { ok: false, reason: 'the secret grant is for another workspace' };
  if (typeof spawn.cwd !== 'string' || !spawn.cwd || path.resolve(spawn.cwd) !== grant.cwd) {
    return { ok: false, reason: 'the secret grant is for another folder' };
  }
  const mark = spawn.spawns?.find((s) => s.botId === grant.botId && s.taskId === grant.taskId);
  if (!mark) return { ok: false, reason: 'the secret grant is for another bot or task' };
  if (grant.names.some((n) => isConnectionKey(n))) return { ok: false, reason: 'a key it names belongs to a connection now' };
  // A connection's key goes only to a spawn that carries that connection.
  const carried = new Set((mark.connectors ?? []).flatMap((c) => c.secrets.map((x) => x.secret)));
  if (grant.connectionNames.some((n) => !carried.has(n) || !isConnectionKey(n))) {
    return { ok: false, reason: 'a connection key it names is not one of this launch\'s connections' };
  }
  const s = source?.() ?? null;
  if (!s) return { ok: false, reason: 'the key store is not running' };
  const names = [...grant.names, ...grant.connectionNames];
  const r = s.values(names);
  if (!r.ok) return { ok: false, reason: `not stored: ${r.missing.join(', ')}` };
  try {
    s.markUsed(names, grant.botId);
  } catch { /* use is best effort; the spawn goes on */ }
  return { ok: true, env: r.env, botId: grant.botId, names };
}

/** Test-only. */
export function __resetSecretGrantsForTesting(now?: () => number): void {
  grants.clear();
  clock = now ?? Date.now;
}

/**
 * pty:create's stage: the secret env for this create, or undefined when it
 * carries no grant. A grant that does not resolve throws (the create fails
 * and the renderer rolls the workspace back; the task reports not launched).
 */
export function secretEnvForCreate(
  options: { secretGrant?: unknown; fanoutTaskOf?: unknown; cwd?: unknown } | undefined,
  botWorker: { strict: boolean; spawns?: ReadonlyArray<{ botId: string; taskId: string; connectors?: ReadonlyArray<{ secrets: ReadonlyArray<{ secret: string }> }> }> } | null,
): Record<string, string> | undefined {
  if (options?.secretGrant === undefined) return undefined;
  const r = resolveSecretGrant(options.secretGrant, {
    strictBotWorker: botWorker?.strict === true,
    fanoutTaskOf: options.fanoutTaskOf,
    cwd: options.cwd,
    ...(botWorker?.spawns ? { spawns: botWorker.spawns } : {}),
  });
  if (!r.ok) throw new Error(`PTY_CREATE: ${r.reason}`);
  return r.env;
}
