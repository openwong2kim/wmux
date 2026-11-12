import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Electron's own CDP port: claiming it, and proving it came up (#1331).
//
// The port used to be a bare `18800 + randomInt(100)`, handed straight to
// `--remote-debugging-port` and announced as "CDP enabled on port N". Two wmux
// instances side by side (a dogfood build next to the real one, separate
// WMUX_DATA_SUFFIX) draw the same number roughly once in a hundred launches.
// Chromium cannot bind it, comes up with NO listening CDP port at all, and says
// nothing — while that log line still claims the port is enabled. Everything
// that needs CDP is then dead with no hint anywhere as to why.
//
// Two halves, because neither is enough alone:
//
//   claimCdpPort  refuses a port another LIVE wmux is already holding. This is
//                 the reported collision, and it is the one we can prevent
//                 rather than merely report.
//   probeCdpEndpoint  asks the port itself, after Chromium has had its chance
//                 to bind, whether this instance owns the endpoint. This catches
//                 everything the claim cannot see — a non-wmux process on the
//                 port, a Chromium that refused it for its own reasons — and it
//                 is what the "enabled" log line is allowed to depend on.
//
// Why a claim FILE and not a bind probe: the port has to be chosen before
// `app.commandLine.appendSwitch`, which runs inside the synchronous `appInit()`
// — there is no await to hang an async `net.listen` probe on, and making boot
// async to get one would reorder far more than this is worth. `openSync(…,
// 'wx')` is atomic and synchronous, which is exactly the shape available here.
// It is a weaker check (it only knows about wmux) and that is fine: the probe
// is the one that actually decides what gets logged.
// ---------------------------------------------------------------------------

/** First port of the CDP range, matching PortAllocator's DEFAULT_PORT_MIN. */
export const CDP_PORT_MIN = 18800;
/** How many ports the range holds (18800–18899). */
export const CDP_PORT_COUNT = 100;

/** Where claims live, without creating it (a quit must not make the directory). */
function claimDirPath(home = os.homedir()): string {
  return path.join(home, '.cache', 'wmux-cdp');
}

/** Shared across Dock/shell launches and data suffixes, independent of TMPDIR. */
export function claimDir(home = os.homedir()): string {
  const dir = claimDirPath(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function claimPath(dir: string, port: number): string {
  return path.join(dir, `wmux-cdp-${port}.lock`);
}

/** Is a process with this pid still running? */
function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering
    // anything. EPERM means it exists and belongs to someone else, which for
    // our purposes is still "alive".
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Chromium honours these switches whoever passed them: they open a debugging
 * endpoint or loosen one. They go before the CDP setting is even read, so a
 * failure reading it can't leave them in place, and only wmux's own port is
 * added back.
 */
export const DEBUGGING_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'remote-allow-origins',
] as const;

export function dropDebuggingSwitches(commandLine: { removeSwitch(name: string): void }): void {
  for (const name of DEBUGGING_SWITCHES) commandLine.removeSwitch(name);
}

export interface ClaimCdpPortDeps {
  /** Directory for claim files. Defaults to the user-stable cache directory. */
  dir?: string;
  /** This process's id, written into the claim. */
  pid?: number;
  /** Liveness test for the pid found in an existing claim. */
  isAlive?: (pid: number) => boolean;
  /** Offset into the range to start from. Defaults to a CSPRNG draw. */
  firstOffset?: number;
  /** The OS uptime in whole seconds, written into the claim and compared. */
  uptime?: () => number;
}

function defaultUptime(): number {
  return Math.floor(os.uptime());
}

/**
 * A claim's content: `<pid> uptime=<seconds>`. The pid comes first and the
 * field after a space, so an older wmux (and scripts/lib/control-wmux-lib.mjs),
 * which read the file with parseInt, still get the pid; a claim from an older
 * wmux, a bare pid, parses with no uptime.
 */
function formatClaim(pid: number, uptime: number): string {
  return `${pid} uptime=${uptime}`;
}

function parseClaim(text: string): { pid: number; uptime: number | null } {
  const uptime = /(?:^|\s)uptime=(\d+)(?:\s|$)/.exec(text)?.[1];
  return { pid: Number.parseInt(text.trim(), 10), uptime: uptime === undefined ? null : Number(uptime) };
}

export interface CdpPortClaim {
  port: number;
  /**
   * Whether the port was claimed exclusively, or merely drawn.
   *
   * False means every port in the range is claimed by a live process, or the
   * claim directory could not be written at all. The port is still used — a
   * boot must not fail over a debugging socket — but the caller should say so,
   * because the probe is then the only thing standing between the operator and
   * a silently dead CDP.
   */
  claimed: boolean;
}

/**
 * Pick a CDP port no other live wmux instance is holding.
 *
 * Starts at a random offset and walks the whole range, so the choice stays
 * unpredictable (the reason it was randomized to begin with — see the CDP block
 * in src/main/index.ts) while still being exhaustive rather than one blind draw.
 *
 * A claim left behind by a crashed instance is reclaimed: the file records the
 * pid, and a pid that is gone releases the port. Nothing has to run at exit for
 * this to be correct, which matters because a crash is precisely when no exit
 * handler runs. A clean quit still gives the claim back (releaseCdpPortOnExit),
 * so stale files are left only by crashes and hard kills.
 */
export function claimCdpPort(deps: ClaimCdpPortDeps = {}): CdpPortClaim {
  let dir: string;
  try { dir = deps.dir ?? claimDir(); } catch {
    return { port: CDP_PORT_MIN + ((deps.firstOffset ?? crypto.randomInt(CDP_PORT_COUNT)) % CDP_PORT_COUNT), claimed: false };
  }
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const start = deps.firstOffset ?? crypto.randomInt(CDP_PORT_COUNT);
  const readUptime = deps.uptime ?? defaultUptime;
  // Written into our claim. A comparison takes its own, later sample.
  const uptime = readUptime();

  for (let i = 0; i < CDP_PORT_COUNT; i++) {
    const port = CDP_PORT_MIN + ((start + i) % CDP_PORT_COUNT);
    if (tryClaim(dir, port, pid, isAlive, uptime, readUptime)) return { port, claimed: true };
  }

  // Everything is spoken for, or the directory is unwritable. Draw and carry
  // on; the probe will report the truth either way.
  return { port: CDP_PORT_MIN + (start % CDP_PORT_COUNT), claimed: false };
}

function tryClaim(
  dir: string, port: number, pid: number, isAlive: (pid: number) => boolean,
  uptime: number, readUptime: () => number,
): boolean {
  const file = claimPath(dir, port);
  if (writeClaim(file, pid, uptime)) return true;

  // Occupied. Whose is it, and are they still here?
  let claim: { pid: number; uptime: number | null };
  try {
    claim = parseClaim(fs.readFileSync(file, 'utf8'));
  } catch {
    // Unreadable claim: treat it as held rather than stealing a port on a
    // guess. The range has ninety-nine other numbers in it.
    return false;
  }
  // A claim written at a higher uptime than ours is from an earlier boot, since
  // within one boot the uptime only grows. Every process that could have written
  // it is gone, though its pid may be alive again, handed by the OS to an
  // unrelated process (a conhost, a browser) that the liveness test below cannot
  // tell from the wmux that wrote it. No wall clock is involved, so a clock step
  // cannot make a live claim look old (#2497).
  // Not covered (#3286): Windows Fast Startup keeps the uptime across a
  // shutdown; an earlier boot that ended before reaching our current uptime; a
  // pid reused within one boot after a crash; and claims from an older wmux,
  // which carry no uptime and keep the pid rule alone.
  // The comparison sample is taken after the read, not at the start of the walk:
  // another instance may have written this claim since then, a whole second
  // later, and a claim already written cannot carry a higher uptime than a
  // sample taken after it within one boot.
  if (claim.uptime !== null && claim.uptime > readUptime()) return replaceStaleClaim(file, pid, uptime);
  const holder = claim.pid;
  // Same answer for a claim we cannot make sense of — including the EMPTY one
  // another instance leaves for the instant between creating the file and
  // writing its pid into it. That instance is very much alive, and reading its
  // half-written claim as abandoned is how two processes end up on one port,
  // which is the entire bug.
  if (!Number.isInteger(holder) || holder <= 0) return false;
  if (isAlive(holder)) return false;

  // A stale claim — its owner is gone.
  return replaceStaleClaim(file, pid, uptime);
}

/**
 * Remove a stale claim and take the port. If the unlink or the re-create loses
 * a race with another instance doing the same thing, that instance wins and we
 * move on to the next port.
 */
function replaceStaleClaim(file: string, pid: number, uptime: number): boolean {
  try {
    fs.unlinkSync(file);
  } catch {
    return false;
  }
  return writeClaim(file, pid, uptime);
}

/**
 * Give our claim back at quit. A claim nobody releases is only reclaimed when a
 * later launch happens to try that port, so without this every port wmux has
 * ever used keeps a file, and a file whose pid Windows has since handed to
 * another process holds its port for as long as that process runs.
 *
 * Only a file that still names `pid` is removed: if it names anyone else, the
 * port is theirs now. Synchronous and silent, because it runs from a process
 * `exit` handler, where nothing can be awaited and nothing may throw.
 */
export function releaseCdpPort(claim: CdpPortClaim, deps: { dir?: string; pid?: number } = {}): void {
  if (!claim.claimed) return;
  const file = claimPath(deps.dir ?? claimDirPath(), claim.port);
  const pid = deps.pid ?? process.pid;
  try {
    if (parseClaim(fs.readFileSync(file, 'utf8')).pid !== pid) return;
    fs.unlinkSync(file);
  } catch {
    /* already gone, or unreadable: nothing of ours to remove */
  }
}

/**
 * Release `claim` when the process exits. Electron emits process `exit` for
 * `app.quit()` (before or after ready) and for `app.exit()`, which skips
 * `will-quit`. Not `will-quit` itself: Chromium still listens on the port
 * then, and a launch that took the port in that gap would fail to bind it.
 * Returns the release, for an exit that runs no handlers (a Windows session
 * end).
 */
export function releaseCdpPortOnExit(
  claim: CdpPortClaim,
  proc: { on(event: 'exit', listener: () => void): unknown },
  deps: { dir?: string; pid?: number } = {},
): () => void {
  const release = (): void => releaseCdpPort(claim, deps);
  proc.on('exit', release);
  return release;
}

/** Create the claim file exclusively. False = somebody else holds it, or we cannot write. */
function writeClaim(file: string, pid: number, uptime: number): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, formatClaim(pid, uptime), 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** What the CDP endpoint said when asked whether it exists. */
export type CdpProbeResult =
  | { ok: true; browser: string }
  | { ok: false; reason: string };

/** Verify the endpoint contains a target identified through Electron's local debugger. */
export async function probeCdpEndpoint(
  port: number,
  expectedTargetId: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CdpProbeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 3000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { Browser?: unknown };
    const browser = typeof body?.Browser === 'string' ? body.Browser : 'unknown';
    if (!expectedTargetId) return { ok: false, reason: 'local target identity unavailable' };
    const targetsRes = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
    if (!targetsRes.ok) return { ok: false, reason: `target list HTTP ${targetsRes.status}` };
    const targets: unknown = await targetsRes.json();
    if (!Array.isArray(targets) || !targets.some((target) => target?.id === expectedTargetId)) {
      return { ok: false, reason: 'local target is not yet present in the endpoint' };
    }
    return { ok: true, browser };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Retry target-list lag. Absence is not proof of foreign ownership. */
export async function probeCdpEndpointWithRetry(
  port: number, expectedTargetId: string,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CdpProbeResult> {
  let result: CdpProbeResult = { ok: false, reason: 'verification pending' };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(100 * 3 ** (attempt - 1));
    result = await probeCdpEndpoint(port, expectedTargetId, deps);
    if (result.ok) return result;
  }
  return result;
}
