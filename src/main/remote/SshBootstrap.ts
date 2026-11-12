// "Add PC over SSH", host side: probe, install the wmux-server runtime, make
// sure `wmux web` runs, and mint a pairing code (E1/E2/E3/E5).
//
// Every remote step is one `ssh … -- <alias> sh -s -- <args>` with the script
// on stdin, so nothing typed by a user or sent by the host is ever spliced
// into a shell line: the arguments are validated against strict patterns
// first (version, arch, sha256, the pinned release URL), and the scripts call
// the runtime by absolute path because non-interactive ssh does not source
// the user's rc files.
//
// What this never does:
//   - restart or reconfigure a running `wmux web` (a transport change revokes
//     every device paired with that host — another laptop included);
//   - restart a daemon that still has live sessions (that kills the user's
//     processes); the upgrade then waits for the user;
//   - install next to a wmux desktop app on the host (they would share
//     ~/.wmux and the desktop's daemon gate would kill the runtime's daemon);
//   - parse `wmux web --status --json`, which prints the operator token
//     with --show-token.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type {
  DaemonStatusJson,
  ServerArch,
  ServerArtifactManifest,
  WebPairCliResult,
} from '../../shared/sshPcContract';
import type { SshServiceResult } from '../../shared/remoteHosts';
import {
  RUNTIME_CLI_REL,
  RUNTIME_CURRENT_LINK,
  RUNTIME_DIR,
  RUNTIME_NODE_REL,
  serverArtifactName,
  serverArtifactUrl,
} from '../../shared/sshPcContract';
import {
  SshFailure,
  assertSshOk,
  bootstrapArgs,
  parseServerHostKey,
  parseSshG,
  resolveArgs,
  runSsh,
  type RunSshOptions,
  type SshRunResult,
} from './sshCommand';

/** Why bootstrap stopped, for the dialog. Distinct from ssh's own failures. */
export type BootstrapRefusal =
  /** The host runs the wmux desktop app: pair it with `wmux web` instead. */
  | 'desktop-installed'
  | 'unsupported-os'
  | 'unsupported-arch'
  | 'musl'
  | 'glibc-too-old'
  | 'missing-tools'
  /** This app build carries no server manifest, so it cannot install. */
  | 'no-manifest'
  | 'download-failed'
  | 'checksum-mismatch'
  | 'install-failed'
  /** Another computer is installing on this host right now. */
  | 'install-busy'
  /** Another pairing holds the host's single pairing slot (a phone can, for minutes). */
  | 'pair-busy'
  /** The runtime's CLI predates `wmux web pair`. */
  | 'pair-unsupported'
  | 'web-failed'
  /** wmux web was turned off on the host; it stays off until someone there starts it. */
  | 'web-stopped'
  | 'web-not-loopback';

export class BootstrapError extends Error {
  readonly refusal: BootstrapRefusal;
  constructor(refusal: BootstrapRefusal, message: string) {
    super(message);
    this.name = 'BootstrapError';
    this.refusal = refusal;
  }
}

export type BootstrapPhase = 'connect' | 'probe' | 'install' | 'start' | 'pair';

export interface HostProbe {
  os: string;
  arch: ServerArch | null;
  rawArch: string;
  glibc: string | null;
  musl: boolean;
  /** Paths that show a wmux desktop app on the host. */
  desktop: string[];
  hasDownloader: boolean;
  hasSha256: boolean;
  hasTar: boolean;
  installed: string[];
  current: string | null;
  status: DaemonStatusJson | null;
  hostKey: string | null;
}

/** Runs one ssh invocation; injected so tests never touch a real ssh. */
export type SshRun = (args: string[], opts?: RunSshOptions) => Promise<SshRunResult>;

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)?)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function isValidVersion(v: unknown): v is string {
  return typeof v === 'string' && VERSION_RE.test(v);
}

/** Absolute runtime paths on the host, relative to its $HOME (shell-expanded there). */
const RT = `"$HOME/${RUNTIME_DIR}"`;
const CLI_CURRENT = `"$HOME/${RUNTIME_DIR}/${RUNTIME_CURRENT_LINK}/${RUNTIME_NODE_REL}" "$HOME/${RUNTIME_DIR}/${RUNTIME_CURRENT_LINK}/${RUNTIME_CLI_REL}"`;

/** Linux install locations of the wmux desktop app (deb/rpm) and its user data (any build). */
const DESKTOP_MARKERS = ['/usr/lib/wmux', '/opt/wmux', '/usr/share/applications/wmux.desktop', '"$HOME/.config/wmux"'];

export const PROBE_SCRIPT = `
echo "os=$(uname -s 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then echo "glibc=$(getconf GNU_LIBC_VERSION | awk '{print $2}')"; fi
for f in /lib/ld-musl-* /usr/lib/ld-musl-*; do [ -e "$f" ] && echo "musl=1"; done
for p in ${DESKTOP_MARKERS.join(' ')}; do [ -e "$p" ] && echo "desktop=$p"; done
command -v curl >/dev/null 2>&1 && echo "downloader=curl"
command -v wget >/dev/null 2>&1 && echo "downloader=wget"
command -v sha256sum >/dev/null 2>&1 && echo "sha256=1"
command -v tar >/dev/null 2>&1 && echo "tar=1"
if [ -d ${RT} ]; then
  for d in ${RT}/*; do [ -d "$d" ] && [ ! -L "$d" ] && echo "installed=$(basename "$d")"; done
  [ -L ${RT}/${RUNTIME_CURRENT_LINK} ] && echo "current=$(readlink ${RT}/${RUNTIME_CURRENT_LINK})"
fi
if [ -x "$HOME/${RUNTIME_DIR}/${RUNTIME_CURRENT_LINK}/${RUNTIME_NODE_REL}" ]; then
  echo "status=$(${CLI_CURRENT} daemon status --json 2>/dev/null | tr -d '\\n')"
fi
exit 0
`;

/**
 * Installs <ver> atomically: <ver>.partial → verify → <ver> → `current`.
 * $1 version, $2 sha256, $3 mode (download|upload), $4 url (download only).
 */
export const INSTALL_SCRIPT = `
set -u
VER="$1"; SHA="$2"; MODE="$3"; URL="\${4:-}"
umask 077
mkdir -p ${RT} || { echo "error=install-failed"; exit 1; }
cd ${RT} || exit 1
# One install at a time (two laptops adding this host at once): a lock older
# than 30 minutes is a dead installer's and is taken over.
if ! mkdir .install.lock 2>/dev/null; then
  if [ -n "$(find .install.lock -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rmdir .install.lock && mkdir .install.lock || { echo "error=install-busy"; exit 2; }
  else echo "error=install-busy"; exit 2; fi
fi
trap 'rmdir .install.lock 2>/dev/null' EXIT
for d in ./*.partial; do [ -e "$d" ] && rm -rf -- "$d"; done
if [ "$MODE" = download ]; then
  TGZ="$VER.download"
  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --tlsv1.2 -o "$TGZ" "$URL" || { rm -f -- "$TGZ"; echo "error=download-failed"; exit 3; }
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$TGZ" "$URL" || { rm -f -- "$TGZ"; echo "error=download-failed"; exit 3; }
  else echo "error=download-failed"; exit 3; fi
else
  TGZ="$VER.upload"
  [ -f "$TGZ" ] || { echo "error=install-failed"; exit 4; }
fi
GOT=$(sha256sum "$TGZ" | awk '{print $1}')
if [ "$GOT" != "$SHA" ]; then rm -f -- "$TGZ"; echo "error=checksum-mismatch"; exit 5; fi
mkdir "$VER.partial" && tar -xzf "$TGZ" -C "$VER.partial" || { rm -f -- "$TGZ"; echo "error=install-failed"; exit 6; }
rm -f -- "$TGZ"
if [ ! -e "$VER.partial/${RUNTIME_NODE_REL}" ]; then
  set -- "$VER.partial"/*
  if [ "$#" -eq 1 ] && [ -e "$1/${RUNTIME_NODE_REL}" ]; then mv -- "$1" "$VER.inner" && rmdir -- "$VER.partial" && mv -- "$VER.inner" "$VER.partial"; fi
fi
if [ ! -x "$VER.partial/${RUNTIME_NODE_REL}" ] || [ ! -f "$VER.partial/${RUNTIME_CLI_REL}" ] || ! grep -q "\\"version\\": *\\"$VER\\"" "$VER.partial/package.json"; then
  echo "error=install-failed"; exit 7
fi
if [ -e "$VER" ]; then echo "error=install-failed"; exit 8; fi
mv -- "$VER.partial" "$VER" || { echo "error=install-failed"; exit 9; }
ln -sfn "$VER" current.tmp && mv -Tf current.tmp ${RUNTIME_CURRENT_LINK} || { echo "error=install-failed"; exit 10; }
echo "installed=$VER"
`;

/**
 * Runs the runtime CLI (\`current\`, or an explicit version) with the given
 * arguments. $1 = version or "current"; the rest go to the CLI verbatim.
 */
export const CLI_SCRIPT = `
V="$1"; shift
R="$HOME/${RUNTIME_DIR}/$V"
exec "$R/${RUNTIME_NODE_REL}" "$R/${RUNTIME_CLI_REL}" "$@"
`;

/**
 * CLI_SCRIPT with stdout thrown away ON THE HOST. `wmux web` starts print the
 * server's status (the operator token with --show-token); it must never reach
 * this laptop.
 */
export const CLI_QUIET_SCRIPT = `
V="$1"; shift
R="$HOME/${RUNTIME_DIR}/$V"
exec "$R/${RUNTIME_NODE_REL}" "$R/${RUNTIME_CLI_REL}" "$@" > /dev/null
`;

function kv(stdout: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) out.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return out;
}

/** The last line of a stdout that parses as a JSON object (CLIs may print notes first). */
export function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const text = stdout.slice(-64 * 1024);
  // A pretty-printed object spans lines: try the whole text, then each `{` start.
  const starts: number[] = [];
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) starts.push(i);
  for (const start of starts) {
    try {
      const v: unknown = JSON.parse(text.slice(start));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* keep looking */ }
  }
  return null;
}

function toArch(raw: string): ServerArch | null {
  if (raw === 'x86_64' || raw === 'amd64') return 'x64';
  if (raw === 'aarch64' || raw === 'arm64') return 'arm64';
  return null;
}

function parseStatus(raw: string): DaemonStatusJson | null {
  if (!raw) return null;
  const obj = lastJsonObject(raw);
  if (!obj || typeof obj.running !== 'boolean') return null;
  const web = obj.web as Record<string, unknown> | undefined;
  const port = web?.port;
  return {
    running: obj.running,
    ...(typeof obj.version === 'string' ? { version: obj.version } : {}),
    ...(typeof obj.spawnedByVersion === 'string' ? { spawnedByVersion: obj.spawnedByVersion } : {}),
    ...(Number.isInteger(obj.liveSessions) ? { liveSessions: obj.liveSessions as number } : {}),
    ...(web && typeof web.running === 'boolean'
      ? {
        web: {
          running: web.running,
          ...(Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536 ? { port: port as number } : {}),
          ...(typeof web.allowInput === 'boolean' ? { allowInput: web.allowInput } : {}),
        },
      }
      : {}),
  };
}

export function parseProbe(stdout: string, stderr: string): HostProbe {
  const probe: HostProbe = {
    os: '',
    arch: null,
    rawArch: '',
    glibc: null,
    musl: false,
    desktop: [],
    hasDownloader: false,
    hasSha256: false,
    hasTar: false,
    installed: [],
    current: null,
    status: null,
    hostKey: parseServerHostKey(stderr),
  };
  for (const [k, v] of kv(stdout)) {
    switch (k) {
      case 'os': probe.os = v; break;
      case 'arch': probe.rawArch = v; probe.arch = toArch(v); break;
      case 'glibc': if (/^\d+\.\d+/.test(v)) probe.glibc = v; break;
      case 'musl': probe.musl = true; break;
      case 'desktop': probe.desktop.push(v); break;
      case 'downloader': probe.hasDownloader = true; break;
      case 'sha256': probe.hasSha256 = true; break;
      case 'tar': probe.hasTar = true; break;
      case 'installed': if (isValidVersion(v)) probe.installed.push(v); break;
      case 'current': if (isValidVersion(v)) probe.current = v; break;
      case 'status': probe.status = parseStatus(v); break;
    }
  }
  return probe;
}

function versionTuple(v: string): number[] {
  return v.split(/[.-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0);
}

/**
 * Release order: numeric core first, then a release outranks its prereleases
 * (4.0.0 > 4.0.0-beta.2 > 4.0.0-beta.1). Negative when a < b.
 */
export function compareRelease(a: string, b: string): number {
  const [coreA, preA] = a.split('-', 2) as [string, string | undefined];
  const [coreB, preB] = b.split('-', 2) as [string, string | undefined];
  const x = versionTuple(coreA);
  const y = versionTuple(coreB);
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  const pa = preA.split('.');
  const pb = preB.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    // semver: numeric identifiers compare numerically and rank below alphanumeric ones.
    const numA = /^\d+$/.test(pa[i]);
    const numB = /^\d+$/.test(pb[i]);
    if (numA && numB) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d !== 0) return d;
    } else if (numA !== numB) {
      return numA ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** a >= b on dotted numeric versions (glibc "2.28"). */
export function versionAtLeast(a: string, b: string): boolean {
  const x = versionTuple(a);
  const y = versionTuple(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

export type InstallPlan =
  | { kind: 'ready'; version: string }
  | { kind: 'install'; version: string; arch: ServerArch; sha256: string; url: string; size: number };

/** What to do on this host, or why not. Pure: the decision table lives here. */
export function planInstall(probe: HostProbe, manifest: ServerArtifactManifest | null): InstallPlan {
  if (probe.desktop.length > 0) {
    throw new BootstrapError('desktop-installed', `the wmux desktop app is installed on this computer (${probe.desktop[0]})`);
  }
  if (probe.os !== 'Linux') throw new BootstrapError('unsupported-os', `${probe.os || 'this system'} is not supported yet; Linux only`);
  if (probe.musl && !probe.glibc) throw new BootstrapError('musl', 'musl-based Linux (e.g. Alpine) is not supported');
  if (!probe.arch) throw new BootstrapError('unsupported-arch', `${probe.rawArch || 'this CPU'} is not supported`);
  if (!manifest) {
    // Without a manifest there is nothing verified to install; an existing
    // runtime can still be used as it is.
    if (probe.current) return { kind: 'ready', version: probe.current };
    throw new BootstrapError('no-manifest', 'this build of wmux cannot install the server');
  }
  // A host already on this version or a NEWER one (another laptop runs a
  // later app) is used as it is: `current` never moves backward. What the
  // older app can do there is decided by the host's capabilities.
  if (probe.current && probe.installed.includes(probe.current) && compareRelease(probe.current, manifest.version) >= 0) {
    return { kind: 'ready', version: probe.current };
  }
  if (!probe.glibc) throw new BootstrapError('musl', 'could not find glibc on this computer');
  if (!versionAtLeast(probe.glibc, manifest.glibcMin)) {
    throw new BootstrapError('glibc-too-old', `glibc ${probe.glibc} is older than the required ${manifest.glibcMin}`);
  }
  if (!probe.hasSha256 || !probe.hasTar) throw new BootstrapError('missing-tools', 'this computer needs sha256sum and tar');
  const artifact = manifest.artifacts[probe.arch];
  if (!artifact || !SHA256_RE.test(artifact.sha256) || !isValidVersion(manifest.version)) {
    throw new BootstrapError('no-manifest', `no server build for ${probe.arch}`);
  }
  if (probe.installed.includes(manifest.version)) {
    // Installed but not current (an earlier swap was interrupted): only the link moves.
    return { kind: 'install', version: manifest.version, arch: probe.arch, sha256: artifact.sha256, url: '', size: 0 };
  }
  return {
    kind: 'install',
    version: manifest.version,
    arch: probe.arch,
    sha256: artifact.sha256,
    url: serverArtifactUrl(manifest.version, probe.arch),
    size: artifact.size,
  };
}

/** Same pinned URL the manifest names, never `latest`, never anything else. */
function assertPinnedUrl(url: string, version: string, arch: ServerArch): void {
  if (url !== serverArtifactUrl(version, arch)) throw new BootstrapError('install-failed', 'refusing an unpinned artifact URL');
}

export interface BootstrapDeps {
  run?: SshRun;
  manifest: ServerArtifactManifest | null;
  /** The name this laptop is paired under on the host. */
  deviceName: string;
  /**
   * Gets the artifact onto the LAPTOP when the host cannot download it
   * (no curl/wget, no internet). Returns a readable stream of the verified
   * tarball; the host re-verifies the sha256 after the upload.
   */
  openArtifact?: (version: string, arch: ServerArch, sha256: string, signal?: AbortSignal) => Promise<NodeJS.ReadableStream>;
  onPhase?: (phase: BootstrapPhase) => void;
  signal?: AbortSignal;
}

export interface BootstrapResult {
  resolvedHost: string;
  hostKeyFingerprint: string;
  version: string;
  pair: WebPairCliResult;
  /** An installed upgrade is waiting for a daemon restart the user must allow. */
  upgradePending: boolean;
}

/** Every word after `sh -s --`: ssh hands the line to a remote shell, so nothing it could parse. */
const STEP_ARG_RE = /^[A-Za-z0-9._:/=-]+$/;

export function sshStep(run: SshRun, alias: string, script: string, args: string[], opts: RunSshOptions = {}): Promise<SshRunResult> {
  for (const arg of args) {
    if (!STEP_ARG_RE.test(arg)) throw new BootstrapError('install-failed', 'refusing an unsafe argument for the remote shell');
  }
  return run(bootstrapArgs(alias, ['sh', '-s', '--', ...args]), { timeoutMs: 120_000, ...opts, stdin: script });
}

export async function resolveAlias(run: SshRun, alias: string, signal?: AbortSignal): Promise<{ hostname: string; user: string; port: string }> {
  const res = await run(resolveArgs(alias), { timeoutMs: 10_000, signal });
  if (res.code !== 0) throw new SshFailure('failed', 'ssh could not read the configuration for this host');
  const g = parseSshG(res.stdout);
  return { hostname: g.get('hostname') ?? '', user: g.get('user') ?? '', port: g.get('port') ?? '22' };
}

async function runCli(run: SshRun, alias: string, version: string, args: string[], signal?: AbortSignal, quiet = false): Promise<SshRunResult> {
  return sshStep(run, alias, quiet ? CLI_QUIET_SCRIPT : CLI_SCRIPT, [version, ...args], { signal, timeoutMs: 60_000 });
}

/** Device names travel as one ssh argv word: letters, digits, `.`, `_`, `-` only. */
export function safeDeviceName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return cleaned || 'wmux-desktop';
}

export function parsePairResult(stdout: string): WebPairCliResult | null {
  const obj = lastJsonObject(stdout);
  if (!obj) return null;
  const { code, expiresAt, port, allowInput } = obj;
  if (typeof code !== 'string' || !/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return null;
  if (!Number.isInteger(port) || (port as number) <= 0 || (port as number) >= 65536) return null;
  return {
    code,
    expiresAt: typeof expiresAt === 'number' ? expiresAt : 0,
    port: port as number,
    allowInput: allowInput === true,
  };
}

/** Mint a fresh pairing code on the host (re-run after a burned code). */
export async function issuePairCode(run: SshRun, alias: string, deviceName: string, signal?: AbortSignal): Promise<WebPairCliResult> {
  const res = await runCli(run, alias, RUNTIME_CURRENT_LINK, ['web', 'pair', '--name', safeDeviceName(deviceName), '--kind', 'desktop', '--json'], signal);
  if (res.code === 255) assertSshOk(res);
  const pair = parsePairResult(res.stdout);
  if (pair) return pair;
  // `{ok:false, error}`: the verb exists and said no. Only no answer at all means "too old".
  const refused = lastJsonObject(res.stdout);
  if (refused && refused.ok === false) {
    const error = typeof refused.error === 'string' ? refused.error.slice(0, 200) : '';
    if (/another pairing is in progress/i.test(error)) {
      throw new BootstrapError('pair-busy', 'another pairing is in progress on that computer');
    }
    throw new BootstrapError('web-failed', error || 'the wmux server on this computer refused to issue a pairing code');
  }
  throw new BootstrapError('pair-unsupported', 'the wmux server on this computer could not issue a pairing code');
}

/**
 * Bring a paired host's server back before its tunnel opens. A headless
 * daemon with nothing to serve exits after a few idle minutes and takes
 * `wmux web` with it; that is a normal reconnect, not an error. The daemon is
 * started again and restores web itself, on its own port and flags (E2).
 */
export async function reviveHost(run: SshRun, alias: string, remotePort: number, signal?: AbortSignal): Promise<void> {
  let status = await readStatus(run, alias, RUNTIME_CURRENT_LINK, signal);
  if (!status?.running) {
    const res = await runCli(run, alias, RUNTIME_CURRENT_LINK, ['daemon', 'start', '--json'], signal);
    if (res.code === 255) assertSshOk(res);
    if (res.code !== 0) throw new BootstrapError('web-failed', 'could not start the wmux daemon on that computer');
    status = await readStatus(run, alias, RUNTIME_CURRENT_LINK, signal);
  }
  if (!status?.running || status.web === undefined) return;
  // The daemon restores its own web server on boot. One that is still off was
  // stopped on purpose there; turning it back on is that computer's call.
  if (!status.web.running) throw new BootstrapError('web-stopped', 'wmux web was stopped on that computer');
  if (status.web.port !== undefined && status.web.port !== remotePort) {
    throw new BootstrapError('web-failed', `wmux web on that computer now listens on port ${status.web.port}, not ${remotePort}`);
  }
}

/**
 * `wmux daemon install-service --json` / `uninstall-service --json` output,
 * read as what the person needs to hear. The service never stops or restarts
 * the running daemon, so web keeps its port and flags (E2).
 */
export function parseServiceResult(stdout: string, on: boolean): SshServiceResult {
  const tooOld = 'the wmux server there has no install-service; remove this PC and add it again to update it';
  const obj = lastJsonObject(stdout);
  if (!obj || typeof obj.ok !== 'boolean') return { ok: false, kind: 'failed', message: tooOld };
  const fullHint = typeof obj.hint === 'string' ? obj.hint : '';
  const hint = fullHint.slice(0, 500);
  const error = typeof obj.error === 'string' ? obj.error.slice(0, 300) : '';
  // A CLI from before install-service answers `{ok:false, error:'unknown subcommand: …'}`, with no manager.
  if (obj.manager !== 'systemd' && obj.manager !== 'launchd' && obj.manager !== 'none') {
    return { ok: false, kind: 'failed', message: /unknown subcommand/i.test(error) ? tooOld : error || hint };
  }
  if (obj.manager !== 'systemd') {
    if (!on && obj.ok) return { ok: true, on: false };
    return { ok: false, kind: 'service-unsupported', message: hint };
  }
  if (!obj.ok) return { ok: false, kind: 'failed', message: [error, hint].filter(Boolean).join(' ') };
  if (!on) return { ok: true, on: false };
  if (obj.linger === true) return { ok: true, on: true };
  // Read from the whole hint: a cut one could end in half a user name.
  const lingerCommand = /sudo loginctl enable-linger [A-Za-z0-9._-]+/.exec(fullHint)?.[0] ?? 'sudo loginctl enable-linger $USER';
  return { ok: true, on: true, lingerCommand };
}

/** Turn "Start after reboot" on or off on the host. Never throws. */
export async function setHostService(run: SshRun, alias: string, on: boolean, signal?: AbortSignal): Promise<SshServiceResult> {
  try {
    if (signal?.aborted) throw new SshFailure('cancelled', 'cancelled');
    const res = await runCli(run, alias, RUNTIME_CURRENT_LINK, ['daemon', on ? 'install-service' : 'uninstall-service', '--json'], signal);
    if (res.code === 255) assertSshOk(res);
    return parseServiceResult(res.stdout, on);
  } catch (err) {
    if (err instanceof SshFailure) return { ok: false, kind: err.kind, message: err.message };
    return { ok: false, kind: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

async function readStatus(run: SshRun, alias: string, version: string, signal?: AbortSignal): Promise<DaemonStatusJson | null> {
  const res = await runCli(run, alias, version, ['daemon', 'status', '--json'], signal);
  if (res.code === 255) assertSshOk(res);
  return parseStatus(res.stdout.replace(/\n/g, ''));
}

/**
 * Bring the host to "runtime current + web running", then mint a code.
 * Throws SshFailure (connection/auth) or BootstrapError (a refusal).
 */
export async function bootstrapHost(alias: string, deps: BootstrapDeps): Promise<BootstrapResult> {
  const run = deps.run ?? runSsh;
  const signal = deps.signal;
  deps.onPhase?.('connect');
  const resolved = await resolveAlias(run, alias, signal);

  deps.onPhase?.('probe');
  const probeRes = assertSshOk(await sshStep(run, alias, PROBE_SCRIPT, [], { signal, timeoutMs: 60_000 }));
  const probe = parseProbe(probeRes.stdout, probeRes.stderr);
  if (!probe.hostKey) throw new SshFailure('failed', 'could not read the host key ssh was shown');
  const plan = planInstall(probe, deps.manifest);

  if (plan.kind === 'install') {
    deps.onPhase?.('install');
    if (plan.url) {
      assertPinnedUrl(plan.url, plan.version, plan.arch);
      let res = probe.hasDownloader
        ? await sshStep(run, alias, INSTALL_SCRIPT, [plan.version, plan.sha256, 'download', plan.url], { signal, timeoutMs: 600_000 })
        : null;
      const failed = (r: SshRunResult | null): string | null => {
        if (!r) return 'download-failed';
        if (r.code === 0) return null;
        if (r.code === 255) assertSshOk(r);
        return kv(r.stdout).find(([k]) => k === 'error')?.[1] ?? 'install-failed';
      };
      let err = failed(res);
      if (err === 'download-failed' && deps.openArtifact) {
        // The host could not fetch it: carry the verified tarball over ssh.
        const stream = await deps.openArtifact(plan.version, plan.arch, plan.sha256, signal);
        const upload = await run(
          bootstrapArgs(alias, ['sh', '-c', `'umask 077; mkdir -p ${RT} && cat > ${RT}/${plan.version}.upload'`]),
          { stdin: stream, signal, timeoutMs: 600_000 },
        );
        assertSshOk(upload);
        res = await sshStep(run, alias, INSTALL_SCRIPT, [plan.version, plan.sha256, 'upload'], { signal, timeoutMs: 300_000 });
        err = failed(res);
      }
      if (err) {
        const refusal: BootstrapRefusal = err === 'checksum-mismatch' || err === 'download-failed' || err === 'install-busy' ? err : 'install-failed';
        throw new BootstrapError(refusal, `installing the wmux server failed (${refusal})`);
      }
    } else {
      // Already extracted: point `current` at it.
      const res = await sshStep(run, alias, `cd ${RT} && ln -sfn "$1" current.tmp && mv -Tf current.tmp ${RUNTIME_CURRENT_LINK}`, [plan.version], { signal });
      if (res.code !== 0) throw new BootstrapError('install-failed', 'could not switch to the installed version');
    }
  }

  deps.onPhase?.('start');
  let upgradePending = false;
  let restarted = false;
  let startedHere = false;
  let status = await readStatus(run, alias, RUNTIME_CURRENT_LINK, signal);
  const oldVersion = status?.running ? status.version : undefined;
  // Only an OLDER running daemon is ever replaced; a newer one is left alone.
  if (status?.running && oldVersion && isValidVersion(oldVersion) && compareRelease(oldVersion, plan.version) < 0) {
    // Asked again right before stopping: a session opened since the first
    // look must keep its processes (E3).
    const stopWith = probe.installed.includes(oldVersion) ? oldVersion : RUNTIME_CURRENT_LINK;
    const fresh = status.liveSessions === 0 ? await readStatus(run, alias, stopWith, signal) : status;
    if (fresh?.running && fresh.liveSessions === 0) {
      await runCli(run, alias, stopWith, ['daemon', 'stop', '--json'], signal);
      restarted = true;
      status = null;
    } else {
      // Restarting would end the user's running processes: keep the old daemon.
      upgradePending = true;
    }
  }
  if (!status?.running) {
    // The CLI never launches a daemon on its own; a headless host has no app to do it.
    const res = await runCli(run, alias, RUNTIME_CURRENT_LINK, ['daemon', 'start', '--json'], signal);
    if (res.code === 255) assertSshOk(res);
    if (res.code !== 0) throw new BootstrapError('web-failed', 'could not start the wmux daemon on this computer');
    startedHere = !restarted;
    status = await readStatus(run, alias, RUNTIME_CURRENT_LINK, signal);
  }
  // A daemon that does not report `web` predates `wmux web pair`: an older CLI
  // reads `web pair` as "start web", which would restart the server (E2).
  if (status?.running === true && status.web === undefined) {
    throw new BootstrapError('pair-unsupported', 'the wmux server on this computer is too old to pair this way');
  }
  if (!status?.web?.running) {
    // Only a daemon this bootstrap brought up fresh gets input switched on;
    // anyone else's keeps the shape its owner chose (no flags = keep).
    const startArgs = startedHere ? ['web', '--allow-input', '--json'] : ['web', '--json'];
    const res = await runCli(run, alias, RUNTIME_CURRENT_LINK, startArgs, signal, true);
    if (res.code === 255) assertSshOk(res);
    if (res.code !== 0) throw new BootstrapError('web-failed', 'could not start wmux web on this computer');
  }

  deps.onPhase?.('pair');
  const pair = await issuePairCode(run, alias, deps.deviceName, signal);
  return {
    resolvedHost: resolved.hostname,
    hostKeyFingerprint: probe.hostKey,
    version: plan.version,
    pair,
    upgradePending,
  };
}

/**
 * The manifest baked into this app build, or null (dev builds, older builds).
 * WMUX_SERVER_MANIFEST is a development override only: a packaged app reads
 * nothing but its own resources, so an environment variable cannot choose
 * which sha256 a host is told to trust.
 */
export function loadServerManifest(resourcesDir: string, allowDevOverride = false): ServerArtifactManifest | null {
  const override = allowDevOverride ? process.env.WMUX_SERVER_MANIFEST : undefined;
  const file = override || path.join(resourcesDir, 'server-manifest.json');
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const m = parsed as ServerArtifactManifest;
    if (!isValidVersion(m.version) || typeof m.glibcMin !== 'string' || typeof m.artifacts !== 'object' || !m.artifacts) return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * The upload fallback's source: the pinned release URL, downloaded into an
 * app-private directory (or, in development only, WMUX_SERVER_ARTIFACT_DIR).
 * The file is opened ONCE; the sha256 is computed and the upload streamed from
 * that same descriptor, so nothing can swap the bytes between check and send.
 */
export async function openVerifiedArtifact(
  version: string,
  arch: ServerArch,
  sha256: string,
  privateDir: string,
  opts: { fetchImpl?: typeof fetch; allowDevOverride?: boolean; signal?: AbortSignal } = {},
): Promise<NodeJS.ReadableStream> {
  const name = serverArtifactName(version, arch);
  const localDir = opts.allowDevOverride ? process.env.WMUX_SERVER_ARTIFACT_DIR : undefined;
  let file: string;
  let downloaded = false;
  if (localDir) {
    file = path.join(localDir, name);
  } else {
    const res = await (opts.fetchImpl ?? fetch)(serverArtifactUrl(version, arch), { redirect: 'follow', signal: opts.signal });
    if (!res.ok || !res.body) throw new BootstrapError('download-failed', `download failed: HTTP ${res.status}`);
    ensurePrivateDir(privateDir);
    file = path.join(privateDir, `${name}.${crypto.randomUUID()}`);
    downloaded = true;
    // Streamed to disk: the tarball never sits whole in main's heap.
    try {
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(file, { mode: 0o600, flags: 'wx' }), { signal: opts.signal });
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw new BootstrapError('download-failed', err instanceof Error ? err.message : String(err));
    }
  }
  const fd = fs.openSync(file, 'r');
  // The name is no longer needed once the descriptor is held (Windows cannot
  // unlink an open file; there it goes when the upload closes it).
  let removeOnClose = false;
  if (downloaded) {
    try { fs.rmSync(file, { force: true }); } catch { removeOnClose = true; }
  }
  const cleanup = (): void => { if (removeOnClose) fs.rm(file, { force: true }, () => undefined); };
  const hash = crypto.createHash('sha256');
  try {
    for await (const chunk of fs.createReadStream('', { fd, start: 0, autoClose: false })) hash.update(chunk as Buffer);
  } catch (err) {
    fs.closeSync(fd);
    cleanup();
    throw new BootstrapError('download-failed', err instanceof Error ? err.message : String(err));
  }
  if (hash.digest('hex') !== sha256) {
    fs.closeSync(fd);
    cleanup();
    throw new BootstrapError('checksum-mismatch', 'the downloaded server does not match this app build');
  }
  const upload = fs.createReadStream('', { fd, start: 0, autoClose: true });
  upload.once('close', cleanup);
  return upload;
}

/** An owner-only directory that is not a symlink. */
function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new BootstrapError('download-failed', 'download directory is not a directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new BootstrapError('download-failed', 'download directory is owned by another user');
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}
