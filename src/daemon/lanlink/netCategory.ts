// === LanLink network category (the listen gate's input) ===
//
// LanLink listens only on a network Windows classifies as Private. This reads
// that classification for the one IPv4 address LanLink would bind: the address
// is mapped to its interface index (Get-NetIPAddress) and that index to its
// connection profile (Get-NetConnectionProfile). Nothing is matched by
// interface alias, so a non-UTF-8 console codepage cannot garble the lookup,
// and the only text read back is an ASCII enum name.
//
// Windows PowerShell 5.1 by absolute System32 path (no PATH trust), with
// -NoProfile -NonInteractive -Command only. The script uses cmdlets, array
// wrapping and property reads, which Constrained Language Mode allows. The
// spawn costs about 1-2 s, so the server reads the category when it
// (re)evaluates a bind, never on its liveness tick.
//
// macOS and Linux have no per-network trust category, so there is nothing to
// read: the result is 'not-applicable' and the gate does not apply there.
//
// Imports node builtins and shared constants only.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { DAEMON_RPC_TIMEOUT_MS } from '../../shared/timeouts';

/** Windows connection-profile category. 'Unknown': the interface has no connection profile. */
export type NetCategory = 'Private' | 'Public' | 'Domain' | 'Unknown';

/** A Windows category, or 'not-applicable' on an OS with no network category (macOS, Linux). */
export type NetCategoryResult = NetCategory | 'not-applicable';

/**
 * An external process, so it is bounded: a powershell.exe that never answers is
 * a failed read, and a failed read keeps LanLink from listening. Below the
 * control-pipe RPC ceiling, because `lanlink.configure` waits for this read.
 */
export const QUERY_TIMEOUT_MS = DAEMON_RPC_TIMEOUT_MS - 2_000;

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);

/**
 * The PowerShell script for one address. The address is validated as a dotted
 * quad before it is placed in the single-quoted literal, so it cannot carry
 * script text.
 */
export function categoryScript(ip: string): string {
  if (!IPV4_RE.test(ip)) throw new Error(`not an IPv4 address: ${JSON.stringify(ip)}`);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$a = @(Get-NetIPAddress -IPAddress '${ip}' -AddressFamily IPv4)`,
    'if ($a.Count -ne 1) { exit 3 }',
    '$p = @(Get-NetConnectionProfile -InterfaceIndex $a[0].InterfaceIndex -ErrorAction SilentlyContinue)',
    "if ($p.Count -eq 0) { 'category=none'; exit 0 }",
    'if ($p.Count -ne 1) { exit 4 }',
    "'category=' + $p[0].NetworkCategory",
  ].join('; ');
}

/** Map the script's output to a category. Throws on anything but exactly one known line. */
export function parseCategoryOutput(stdout: string): NetCategory {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('category='));
  if (lines.length !== 1) throw new Error(`expected one category line, got ${lines.length}`);
  const value = lines[0].slice('category='.length);
  switch (value) {
    case 'Private':
      return 'Private';
    case 'Public':
      return 'Public';
    case 'DomainAuthenticated':
      return 'Domain';
    case 'none':
      return 'Unknown';
    default:
      throw new Error(`unrecognized network category: ${JSON.stringify(value)}`);
  }
}

export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string }>;

function defaultExec(file: string, args: string[], opts: { timeout: number; windowsHide: boolean }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, encoding: 'utf-8' }, (err, stdout) => {
      if (err) {
        // stderr is in the console codepage and may be garbled; the exit code
        // and the error message from node are enough to say what failed.
        reject(err);
        return;
      }
      resolve({ stdout });
    });
  });
}

export interface ReadNetCategoryDeps {
  platform?: NodeJS.Platform;
  exec?: ExecFileFn;
}

/**
 * The network category of the interface that holds `ip`. Rejects when it
 * cannot be read (powershell.exe blocked or timed out, the address no longer
 * present, unexpected output); the caller treats a rejection as "do not listen".
 */
export async function readNetCategory(ip: string, deps: ReadNetCategoryDeps = {}): Promise<NetCategoryResult> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return 'not-applicable';
  const script = categoryScript(ip);
  const exec = deps.exec ?? defaultExec;
  const psPath = path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await exec(psPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: QUERY_TIMEOUT_MS,
    windowsHide: true,
  });
  return parseCategoryOutput(stdout);
}
