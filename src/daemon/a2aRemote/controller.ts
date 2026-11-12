import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { DaemonConfig } from '../types';
import { A2A_REMOTE_DEFAULT_PORT } from '../../shared/a2aRemote';

/**
 * Cross-host A2A control plane: the persisted `a2aRemote` config slice and
 * the `changed` seam the dedicated listener (`A2aServer`) reconciles against.
 * Same shape as `LanLinkController`: the slice is mutated IN PLACE on the
 * daemon's boot config object and the whole file is persisted.
 */

/** Persisted slice (`config.json` → `a2aRemote`). OFF by default. */
export interface A2aRemoteConfig {
  enabled: boolean;
  /** Absent = `A2A_REMOTE_DEFAULT_PORT`. */
  port?: number;
  /**
   * The listener's bind address: an IPv4 address or `localhost` (127.0.0.1).
   * Absent = all interfaces (`0.0.0.0`). Read when the daemon starts; see
   * a2aRemoteBindHost.
   */
  bindHost?: string;
}

export interface A2aRemoteConfigurePatch {
  enabled?: boolean;
  port?: number;
}

/** Event fired with the new slice whenever a configure actually changed it. */
export const A2A_REMOTE_CONFIG_CHANGED = 'changed';

export const A2A_REMOTE_PORT_MIN = 1024;
export const A2A_REMOTE_PORT_MAX = 65535;

export function defaultA2aRemoteConfig(): A2aRemoteConfig {
  return { enabled: false };
}

function isValidPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= A2A_REMOTE_PORT_MIN && n <= A2A_REMOTE_PORT_MAX;
}

/** Lenient load-time backfill: a garbage slice degrades per field, never throws. */
export function coerceA2aRemoteConfig(raw: unknown, def: A2aRemoteConfig = defaultA2aRemoteConfig()): A2aRemoteConfig {
  if (Array.isArray(raw) || typeof raw !== 'object' || raw === null) return { ...def };
  const o = raw as Record<string, unknown>;
  const out: A2aRemoteConfig = { enabled: typeof o['enabled'] === 'boolean' ? o['enabled'] : def.enabled };
  if (isValidPort(o['port'])) out.port = o['port'];
  // Kept as written: a2aRemoteBindHost reports a value it cannot use.
  if (typeof o['bindHost'] === 'string' && o['bindHost'] !== '') out.bindHost = o['bindHost'];
  return out;
}

/**
 * The bind address the listener should use: `host` undefined for every
 * interface (unset or `0.0.0.0`), `localhost` as 127.0.0.1. A set value that
 * is not an IPv4 address or `localhost` is an `error`, logged here: the
 * listener then stays down rather than bind every interface. (An invite
 * names an IPv4 address, so an IPv6 one is refused too.)
 */
export function a2aRemoteBindHost(
  slice: A2aRemoteConfig,
  log: (level: 'error', msg: string) => void,
): { host: string | undefined } | { error: string } {
  const host = slice.bindHost;
  if (host === undefined || host === '0.0.0.0') return { host: undefined };
  if (host === 'localhost') return { host: '127.0.0.1' };
  if (net.isIPv4(host)) return { host };
  const error = `a2aRemote.bindHost ${JSON.stringify(host)} is not an IPv4 address or "localhost", so the listener is not started`;
  log('error', `[a2a-remote] ${error}`);
  return { error };
}

/** Strict RPC-boundary validation: only present keys, throws on a malformed one. */
export function coerceA2aRemotePatch(raw: unknown): A2aRemoteConfigurePatch {
  if (Array.isArray(raw) || typeof raw !== 'object' || raw === null) {
    throw new Error('a2a.remote.configure: params must be an object');
  }
  const o = raw as Record<string, unknown>;
  const patch: A2aRemoteConfigurePatch = {};
  if ('enabled' in o) {
    if (typeof o['enabled'] !== 'boolean') throw new Error('a2a.remote.configure: enabled must be boolean');
    patch.enabled = o['enabled'];
  }
  if ('port' in o) {
    if (!isValidPort(o['port'])) {
      throw new Error(`a2a.remote.configure: port must be an integer in [${A2A_REMOTE_PORT_MIN}, ${A2A_REMOTE_PORT_MAX}]`);
    }
    patch.port = o['port'];
  }
  return patch;
}

export interface A2aRemoteControllerDeps {
  /** The daemon's live boot config; `a2aRemote` is mutated in place. */
  config: DaemonConfig;
  /** Persist the whole config. Must THROW when the write did not land (saveConfigOrThrow). */
  persist: (config: DaemonConfig) => void;
}

export class A2aRemoteController extends EventEmitter {
  private readonly config: DaemonConfig;
  private readonly persist: (config: DaemonConfig) => void;

  constructor(deps: A2aRemoteControllerDeps) {
    super();
    this.config = deps.config;
    this.persist = deps.persist;
    if (!this.config.a2aRemote) this.config.a2aRemote = defaultA2aRemoteConfig();
  }

  current(): A2aRemoteConfig {
    const cur = this.config.a2aRemote ?? defaultA2aRemoteConfig();
    return { ...cur };
  }

  effectivePort(): number {
    return this.current().port ?? A2A_REMOTE_DEFAULT_PORT;
  }

  /**
   * Apply an already-validated patch. Persists FIRST and only then changes the
   * in-memory slice, so a failed write (thrown) leaves nothing applied and a
   * retry with the same value is not mistaken for a no-op. A no-op patch
   * neither rewrites disk nor fires `changed`. `changed` carries (next, prev).
   */
  configure(patch: A2aRemoteConfigurePatch): A2aRemoteConfig {
    const cur = this.current();
    const next: A2aRemoteConfig = { enabled: patch.enabled ?? cur.enabled };
    const port = patch.port ?? cur.port;
    if (port !== undefined) next.port = port;
    if (cur.bindHost !== undefined) next.bindHost = cur.bindHost;
    if (next.enabled === cur.enabled && (next.port ?? null) === (cur.port ?? null)) return cur;
    this.persist({ ...this.config, a2aRemote: next });
    this.config.a2aRemote = next;
    this.emit(A2A_REMOTE_CONFIG_CHANGED, { ...next }, cur);
    return { ...next };
  }

  /**
   * Put back a slice the listener could not apply (a port it could not bind
   * while the old one keeps serving). Does not fire `changed`: nothing is
   * listening differently.
   */
  restore(prev: A2aRemoteConfig): void {
    this.persist({ ...this.config, a2aRemote: { ...prev } });
    this.config.a2aRemote = { ...prev };
  }
}
