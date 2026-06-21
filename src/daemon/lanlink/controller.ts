import { EventEmitter } from 'node:events';
import os from 'node:os';
import type { DaemonConfig } from '../types';
import {
  defaultLanLinkConfig,
  type LanLinkConfig,
  type LanLinkConfigurePatch,
  type LanLinkStatus,
} from '../../shared/lanlink';
import { enumerateNics } from './bindGuard';

/** Event name emitted when the persisted LanLink config changes (the PR-4 seam). */
export const LANLINK_CONFIG_CHANGED = 'changed';

type IfaceSnapshot = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

interface LanLinkControllerDeps {
  /**
   * The live DaemonConfig the daemon loaded at boot (index.ts:1967). The
   * controller mutates `config.lanlink` IN PLACE so every holder of this same
   * object reference (e.g. DaemonSessionManager.config) sees the update — a fresh
   * object would orphan those references.
   */
  config: DaemonConfig;
  /** Persist the whole config to disk (saveConfig — atomic .tmp+rename). */
  persist: (config: DaemonConfig) => void;
  /** Interface snapshot source; injectable for tests. Defaults to the live read. */
  ifaces?: () => IfaceSnapshot;
}

/**
 * LanLink control-plane state holder (PR-3, network-0). Owns the runtime
 * enable/NIC state, persists changes to config.json, and emits a `changed` event
 * — the seam a future in-daemon `LanLinkServer` (PR-4) subscribes to in-process to
 * start/stop/rebind its listener. PR-3 builds NO listener; this only flips config
 * and fires the signal.
 *
 * Execute wall: imports 0 of ClaudeWorker / RpcRouter / a2a.rpc (only node:events,
 * node:os, shared types, and the pure bindGuard) — kept green by
 * daemonExecuteWall.test.ts's source scan.
 */
export class LanLinkController extends EventEmitter {
  private readonly config: DaemonConfig;
  private readonly persist: (config: DaemonConfig) => void;
  private readonly ifaces: () => IfaceSnapshot;

  constructor(deps: LanLinkControllerDeps) {
    super();
    this.config = deps.config;
    this.persist = deps.persist;
    this.ifaces = deps.ifaces ?? (() => os.networkInterfaces());
    // loadConfig backfills config.lanlink, but the type is optional — normalize
    // once so every read below can assume a present, well-formed slice.
    if (!this.config.lanlink) {
      this.config.lanlink = defaultLanLinkConfig();
    }
  }

  /** Current persisted slice (always present after the constructor normalize). */
  private current(): LanLinkConfig {
    return this.config.lanlink ?? defaultLanLinkConfig();
  }

  /** Read the live status: persisted enable/NIC/port + freshly enumerated NICs. */
  getStatus(): LanLinkStatus {
    const cur = this.current();
    return {
      enabled: cur.enabled,
      nic: cur.nic,
      port: cur.port ?? null,
      nics: enumerateNics(this.ifaces()),
    };
  }

  /**
   * Apply a validated partial update, persist it, and (if it actually changed) emit
   * `changed`. Synchronous: the in-memory mutation + atomic persist complete before
   * this returns. Idempotent — a no-op patch neither rewrites disk nor fires the
   * seam, so PR-4 won't rebind on a redundant configure. Returns the new status.
   *
   * NOTE: `patch` MUST already be validated (coerceLanLinkPatch at the RPC edge).
   */
  configure(patch: LanLinkConfigurePatch): LanLinkStatus {
    const cur = this.current();
    const next: LanLinkConfig = { enabled: cur.enabled, nic: cur.nic };
    if (cur.port !== undefined) next.port = cur.port;

    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.nic !== undefined) next.nic = patch.nic; // null = explicit clear
    if (patch.port !== undefined) next.port = patch.port;

    if (lanLinkConfigEqual(cur, next)) {
      return this.getStatus(); // no-op: skip the disk write and the rebind signal
    }

    // Single source of truth: mutate the shared config object in place, then
    // persist the whole file (atomic). saveConfig is best-effort (parity with all
    // config.json writes) — the in-memory slice is the authoritative runtime value
    // either way, and the seam consumer (PR-4) reads from the controller, not disk.
    this.config.lanlink = next;
    this.persist(this.config);
    this.emit(LANLINK_CONFIG_CHANGED, next);
    return this.getStatus();
  }
}

/** Structural equality for two LanLink config slices (drives the no-op short-circuit). */
function lanLinkConfigEqual(a: LanLinkConfig, b: LanLinkConfig): boolean {
  return (
    a.enabled === b.enabled &&
    (a.port ?? null) === (b.port ?? null) &&
    nicEqual(a.nic, b.nic)
  );
}

function nicEqual(a: LanLinkConfig['nic'], b: LanLinkConfig['nic']): boolean {
  if (a === null || b === null) return a === b;
  return a.name === b.name && a.mac === b.mac;
}
