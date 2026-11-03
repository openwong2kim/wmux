import { promises as fsp } from 'node:fs';
import type os from 'node:os';
import { isTailnetIpv4 } from '../../shared/a2aRemote';
import {
  fixtureTailscaleDirExec,
  tailscaleStatus,
  tailscaleWhois,
  type TailnetStatusRead,
  type TailnetWhois,
  type TailscaleExec,
} from '../../cli/tailscale';

/**
 * The daemon's read-only view of Tailscale for A2A discovery: this PC and the
 * other nodes (`status --json`) and who holds a tailnet address
 * (`whois --json <ip>`). One seam, so the listener and the tests share the
 * same calls and no test ever runs the real CLI.
 */
export interface TailnetCli {
  status(signal?: AbortSignal): Promise<TailnetStatusRead>;
  /** Null on any failure (see `tailscaleWhois`). */
  whois(ip: string, signal?: AbortSignal): Promise<TailnetWhois | null>;
}

/**
 * The real CLI, or `exec` in its place. A whois asks the CLI binary that last
 * answered `status`: with a Homebrew `tailscale` beside the app, only one of
 * them reaches the running daemon.
 */
export function createTailnetCli(exec?: TailscaleExec, candidates?: string[]): TailnetCli {
  const opts = { ...(exec ? { exec } : {}), ...(candidates ? { candidates } : {}) };
  let bin: string | undefined;
  return {
    status: async (signal) => {
      const read = await tailscaleStatus({ ...opts, ...(signal ? { signal } : {}) });
      if (read.ok) bin = read.bin;
      return read;
    },
    whois: (ip, signal) => tailscaleWhois(ip, { ...opts, ...(signal ? { signal } : {}), ...(bin ? { bin } : {}) }),
  };
}

/**
 * `WMUX_DEV_TAILSCALE_DIR`, honoured only when NODE_ENV is `development` or
 * `test`. Positive dev detection: a packaged build leaves NODE_ENV unset, so
 * a `!== 'production'` check would honour it there.
 */
export function devTailscaleDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') return null;
  const dir = env.WMUX_DEV_TAILSCALE_DIR?.trim();
  return dir ? dir : null;
}

/**
 * The CLI the daemon uses: the real one, or, in a development build with
 * `WMUX_DEV_TAILSCALE_DIR` set, answers from that directory's fixtures
 * (`fixtureTailscaleDirExec`), which refuse every other command.
 */
export function tailnetCliFromEnv(env: NodeJS.ProcessEnv = process.env): TailnetCli {
  const dir = devTailscaleDir(env);
  return createTailnetCli(dir ? fixtureTailscaleDirExec(dir, (f) => fsp.readFile(f, 'utf8')) : undefined);
}

/**
 * True when some network interface holds an IPv4 in 100.64.0.0/10 that is not
 * one of this PC's tailnet addresses, or one of those addresses sits on more
 * than one interface: the range is also carrier-grade NAT, so a LAN may use
 * it, and then a source address in it says nothing about the tailnet.
 * Loopback interfaces are skipped: nothing outside this PC reaches them.
 */
export function tailnetRangeOnLan(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, selfIps: readonly string[]): boolean {
  const self = new Set(selfIps);
  const holders = new Map<string, Set<string>>();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal || !isTailnetIpv4(nic.address)) continue;
      if (!self.has(nic.address)) return true;
      const names = holders.get(nic.address) ?? new Set<string>();
      names.add(name);
      if (names.size > 1) return true;
      holders.set(nic.address, names);
    }
  }
  return false;
}
