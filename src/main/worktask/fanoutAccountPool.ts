// ─── Fan-out account pool (desktop) ─────────────────────────────────────────
//
// With "Spread fan-out workers over accounts" on, each Claude fan-out worker
// launches on one account of a pool instead of all of them on the default
// login (a task workspace is bound to no account). The pick is the shared
// pickPoolAccount (src/shared/fanoutAccountPool.ts); this module feeds it:
//
//   - which accounts may run a worker (preparePool, async, before the
//     launches): Claude accounts of the caller's group whose folder exists,
//     is local (not UNC), has wmux hooks that are not out of date, and holds
//     a sign-in of its own. A sign-in is checked by its presence only — a
//     stat of `.credentials.json`, or on macOS a keychain lookup that prints
//     no secret — never by reading it. A task pane gets no vault value, so an
//     account that signs in only through its vault is left out. The default
//     login joins when the settings include it (poolIncludesDefaultLogin).
//   - the pick itself (pickFromPool, sync, so it and the booking in the
//     launch record are one step): the cached quota readings (no network),
//     the usage reserve's holds, and the open workers on each account.
//   - the create of the worker's pane (poolAccountForCreate): main reads the
//     account from the launch record; the renderer never names it.
//   - a WSL task pane (a task folder on a WSL share): its accounts run on
//     their homes in that distro, which are other logins than the Windows
//     folders. Such a pick is keyed by (account, distro, user) and reads only
//     WslAccountState (wslAccountState.ts): a member needs sign-in evidence
//     from that home, its quota and its usage-reserve hold are the home's,
//     and its open workers are counted there. Nothing is asked of the distro.
//
// Off by default, and off reads nothing: no settings beyond the file's
// `enabled`, no account folders, no keychain, and no launch record gets an
// account. Daemon mode only (a pane's account folder and its spawn env are
// the daemon's).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { agentRow } from '../../shared/agentIdentity';
import { accountGroupOf } from '../../shared/accountGroup';
import { evaluateQuota } from '../../shared/accountQuota';
import { namesClaude } from '../../shared/botWorkerGuard';
import { namesCodex } from '../../shared/codexWorkerGuard';
import { splitModelEnvMarker } from '../../shared/workerLaunch';
import {
  DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS,
  FANOUT_ACCOUNT_POOL_FILENAME,
  POOL_DEFAULT_ACCOUNT,
  normalizeFanoutAccountPoolSettings,
  pickPoolAccount,
  poolGroupFor,
  poolIncludesDefaultLogin,
  type FanoutAccountPoolSettings,
  type PoolCandidate,
  type PoolPick,
} from '../../shared/fanoutAccountPool';
import { getAccountStore, isAccessibleDir, type Account } from '../account/accountStore';
import { appAccountVault, holdsClaudeSignIn } from '../account/accountVault';
import { claudeReading } from '../account/AccountRotationService';
import type { AccountUsageEntry } from '../account/AccountUsageService';
import type { UsageSnapshot } from '../claude/UsageApi';
import { macKeychainServiceName } from '../claude/claudeCredential';
import { usageReserveHoldForAccount } from '../usage/usageReserve';
import { getWorkerSlots, paneTaskPooled, parseLaunchToken, type WorkerSlots } from '../factory/workerSlots';
import { getWslAccountState, wslStateKey, type WslAccountState, type WslPlace } from '../account/wslAccountState';
import { isWslShellPath } from '../../shared/wslDistro';
import { getDefaultShellMirror } from '../pty/defaultShellMirror';
import { getDefaultWslDistro } from '../pty/defaultWslDistro';
import { liveHolders } from '../factory/workerHolders';
import { wslShareToLinux } from '../../shared/wslPaths';
import type { AccountPick } from './FanOutService';

/** What the running app hands the pool (index.ts): none of it is read while the pool is off. */
export interface FanoutAccountPoolHost {
  daemonConnected: () => boolean;
  /** The per-account usage readings main holds (AccountUsageService). */
  claudeUsage: () => readonly AccountUsageEntry[];
  /** The default login's reading (the usage poller). */
  defaultSnapshot: () => UsageSnapshot | null;
  /** The accounts whose settings.json does not hold the current wmux hooks:
   *  none installed, out of date, or unreadable
   *  (hooksBridge.handler accountsWithoutCurrentHooks). */
  hookDriftIds: (accounts: readonly Account[]) => Promise<ReadonlySet<string>>;
  /** Ask for a usage reading of an account, under the usage service's own
   *  rate limit and switches (AccountUsageService.maybeProbe). Optional. */
  probeUsage?: (accountId: string) => void;
  /** A UNC folder (hooksBridge.handler isUncPath). */
  isUnc: (dir: string) => boolean;
  /** Tell the owner once that a worker ran on the caller's account because no
   *  pool account could run it (poolCallerFallback). Optional. */
  notifyCallerFallback?: () => void;
  /** The daemon's sessions (daemon.listSessions), for learning where a WSL
   *  distro starts after a restart (learnPoolStartPlaces). Optional. */
  daemonSessions?: () => Promise<unknown>;
}

let host: FanoutAccountPoolHost | null = null;
/** Each caller workspace's pool as last read (preparePool), for checks that
 *  run between fan-outs: the held bot fan-outs' reserve check. */
const lastPools = new Map<string, { pool: PreparedPool; at: number }>();
const LAST_POOLS_MAX = 200;
/** A cached pool older than this is read again (in the background) for the
 *  next held-fan-out pass. */
const LAST_POOL_TTL_MS = 60_000;
const refreshingPools = new Set<string>();
/** Per launching task: how its fan-out holds a request the reserve stops at
 *  the pane's create (a WSL pane, checked on its caller's account). */
const createReserveHolds = new Map<string, (hold: { account: string; untilMs: number }) => string>();
const CREATE_RESERVE_HOLDS_MAX = 500;
/** The owner was told this run that the pool fell back to the caller's account. */
let toldCallerFallback = false;

export function setFanoutAccountPoolHost(next: FanoutAccountPoolHost | null): void {
  host = next;
}

// ── Settings ────────────────────────────────────────────────────────────────

let cached: { file: string; settings: FanoutAccountPoolSettings } | null = null;
let writes: Promise<unknown> = Promise.resolve();

function settingsFile(wmuxDir = getWmuxDir()): string {
  return path.join(wmuxDir, FANOUT_ACCOUNT_POOL_FILENAME);
}

/** The pool's settings (defaults when the file is missing or unreadable). */
export function loadFanoutAccountPoolSettings(wmuxDir?: string): FanoutAccountPoolSettings {
  const file = settingsFile(wmuxDir);
  if (cached?.file === file) return { ...cached.settings };
  let raw: unknown = null;
  try {
    raw = atomicReadJSONSync<unknown>(file);
  } catch {
    raw = null;
  }
  const settings = normalizeFanoutAccountPoolSettings(raw);
  cached = { file, settings };
  return { ...settings };
}

/** Write the fields of `patch` over the stored settings; resolves the stored result. */
export function setFanoutAccountPoolSettings(patch: unknown, wmuxDir?: string): Promise<FanoutAccountPoolSettings> {
  const run = writes.then(async () => {
    const file = settingsFile(wmuxDir);
    const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch as Record<string, unknown> : {};
    const current = loadFanoutAccountPoolSettings(wmuxDir);
    const merged: Record<string, unknown> = { ...current };
    for (const k of ['enabled', 'includeDefaultLogin', 'group', 'quotaBandPct', 'maxWorkersPerAccount'] as const) {
      if (Object.hasOwn(p, k)) merged[k] = p[k];
    }
    const next = normalizeFanoutAccountPoolSettings(merged);
    await atomicWriteJSON(file, next);
    cached = { file, settings: next };
    return { ...next };
  });
  writes = run.catch(() => undefined);
  return run;
}

/** Tests only. */
export function resetFanoutAccountPoolForTests(): void {
  cached = null;
  writes = Promise.resolve();
  host = null;
  lastPools.clear();
  refreshingPools.clear();
  createReserveHolds.clear();
  toldCallerFallback = false;
}

// ── Eligibility (async, before the launches) ────────────────────────────────

export interface PoolMember {
  /** An account id, or POOL_DEFAULT_ACCOUNT. */
  id: string;
  /** The account's folder; null for the default login. */
  configDir: string | null;
}

export interface PreparedPool {
  settings: FanoutAccountPoolSettings;
  group: string;
  members: PoolMember[];
  /** The accounts a WSL task pane may pick from: the group's local folders,
   *  whatever their Windows sign-in and hooks (a WSL home signs in and runs
   *  its hooks inside the distro). Each is checked against that home's own
   *  evidence at the pick (poolCandidates `place`). Never the default login:
   *  nothing is known of a distro's own login. */
  wslMembers?: PoolMember[];
}

export type PoolExclusion = 'missing-folder' | 'unc' | 'hook-drift' | 'vault-only' | 'signed-out';

export interface PreparePoolDeps {
  settings?: () => FanoutAccountPoolSettings;
  host?: FanoutAccountPoolHost | null;
  accounts?: () => Account[];
  binding?: (workspaceId: string) => string | undefined;
  dirOk?: (dir: string) => boolean;
  /** Whether the folder holds a Claude sign-in of its own (presence only). */
  signedIn?: (configDir: string) => Promise<boolean>;
  /** Whether the account's vault holds a Claude sign-in (metadata only). */
  vaultSignIn?: (accountId: string) => boolean;
  log?: (line: string) => void;
}

const SIGN_IN_PROBE_TIMEOUT_MS = 5000;

/**
 * Whether a Claude account folder holds a sign-in of its own, by presence
 * only: a non-empty `.credentials.json` (Linux, Windows, and macOS without a
 * keychain item), else on macOS the keychain item Claude Code keeps for that
 * folder, looked up without `-w`/`-g` so no secret is printed or read.
 * False on any failure or timeout (fail closed: the account is left out).
 */
export async function claudeFolderSignedIn(configDir: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    const st = fs.statSync(path.join(configDir, '.credentials.json'));
    if (st.isFile() && st.size > 0) return true;
  } catch {
    // no file: the keychain below, on macOS
  }
  if (platform !== 'darwin') return false;
  return new Promise<boolean>((resolve) => {
    execFile('security', ['find-generic-password', '-s', macKeychainServiceName(configDir), '-a', os.userInfo().username],
      { timeout: SIGN_IN_PROBE_TIMEOUT_MS, windowsHide: true },
      (err) => resolve(!err));
  });
}

/**
 * The pool a fan-out of `callerWorkspaceId` picks from, or null when the
 * pool is off (or there is no daemon): then nothing is read and no launch is
 * given an account. The group is the caller's bound account's, else the
 * setting's; accounts of other groups are never members.
 */
export async function preparePool(callerWorkspaceId: string, deps: PreparePoolDeps = {}): Promise<PreparedPool | null> {
  // No host (tests, or before the app wired it): nothing is read at all.
  const h = deps.host === undefined ? host : deps.host;
  if (!h) return null;
  const settings = (deps.settings ?? loadFanoutAccountPoolSettings)();
  if (!settings.enabled || !h.daemonConnected()) {
    lastPools.delete(callerWorkspaceId);
    return null;
  }
  const log = deps.log ?? ((line: string) => console.log(line));
  const all = (deps.accounts ?? (() => getAccountStore().listAccounts()))().filter((a) => agentRow(a.vendor)?.usageReserve === true);
  const boundId = (deps.binding ?? ((ws: string) => getAccountStore().getBinding(ws, 'claude')))(callerWorkspaceId);
  const bound = boundId ? all.find((a) => a.id === boundId) : undefined;
  const group = poolGroupFor(bound ? accountGroupOf(bound) : null, settings);
  const inGroup = all.filter((a) => accountGroupOf(a) === group);
  const dirOk = deps.dirOk ?? isAccessibleDir;
  const signedIn = deps.signedIn ?? ((dir: string) => claudeFolderSignedIn(dir));
  const vaultSignIn = deps.vaultSignIn ?? ((id: string) => holdsClaudeSignIn(appAccountVault().list(id)));
  const excluded: Array<[string, PoolExclusion]> = [];
  const local = inGroup.filter((a) => {
    if (h.isUnc(a.configDir)) { excluded.push([a.id, 'unc']); return false; }
    if (!dirOk(a.configDir)) { excluded.push([a.id, 'missing-folder']); return false; }
    return true;
  });
  let drift: ReadonlySet<string> = new Set();
  try {
    drift = await h.hookDriftIds(local);
  } catch {
    // Unknown: every account counts as drifted rather than launch without its hooks.
    drift = new Set(local.map((a) => a.id));
  }
  const members: PoolMember[] = [];
  for (const a of local) {
    if (drift.has(a.id)) { excluded.push([a.id, 'hook-drift']); continue; }
    if (!(await signedIn(a.configDir).catch(() => false))) {
      let vault = false;
      try { vault = vaultSignIn(a.id); } catch { vault = false; }
      excluded.push([a.id, vault ? 'vault-only' : 'signed-out']);
      continue;
    }
    members.push({ id: a.id, configDir: a.configDir });
  }
  if (poolIncludesDefaultLogin(group, settings)) members.push({ id: POOL_DEFAULT_ACCOUNT, configDir: null });
  // A member with no reading ranks below every measured one: ask for one, so
  // an account that never got a worker is measured for the next picks.
  if (h.probeUsage) {
    const usage = h.claudeUsage();
    for (const m of members) {
      if (m.id !== POOL_DEFAULT_ACCOUNT && !claudeReading(usage.find((e) => e.accountId === m.id))) {
        try { h.probeUsage(m.id); } catch { /* the next read asks again */ }
      }
    }
  }
  if (excluded.length > 0) log(`[fanout-pool] left out of the pool: ${excluded.map(([id, why]) => `${id} (${why})`).join(', ')}`);
  const pool = { settings, group, members, wslMembers: local.map((a) => ({ id: a.id, configDir: a.configDir })) };
  lastPools.delete(callerWorkspaceId);
  lastPools.set(callerWorkspaceId, { pool, at: Date.now() });
  while (lastPools.size > LAST_POOLS_MAX) lastPools.delete(lastPools.keys().next().value as string);
  return pool;
}

// ── The pick (sync) ─────────────────────────────────────────────────────────

export interface PickDeps {
  host?: FanoutAccountPoolHost | null;
  /** A WSL task pane's place: the pick is among the pool's WSL members, on
   *  their homes there (absent: a native pane). */
  place?: WslPlace;
  wslState?: Pick<WslAccountState, 'get' | 'reading'>;
  slots?: WorkerSlots;
  holdFor?: (account: string) => { untilMs: number } | null;
  /** Whether a launched task's worker may still run (liveHolders: a free holder does not). */
  workerMayRun?: (taskId: string) => boolean;
  dirOk?: (dir: string) => boolean;
  now?: () => number;
}

/** The live-worker caps' holder set as a sync liveness source: a launched
 *  task runs a worker while the set lists it as held or unknown. One it lists
 *  as free, or no longer lists (an ended task whose workspace closed), runs
 *  none. While the set cannot be read (no source installed yet, or a read
 *  that throws) every launched worker still counts: an unknown never frees
 *  an account. */
function holderMayRun(): (taskId: string) => boolean {
  let running: Set<string> | null = null;
  try {
    const look = liveHolders();
    if (look) running = new Set(look.holders.filter((x) => x.state !== 'free').map((x) => x.taskId));
  } catch {
    running = null;
  }
  return (taskId) => running === null || running.has(taskId);
}

/** The usage key a pool launch runs on: the account id for a native pane,
 *  its WSL home's key (`<id>@wsl:<hash>`) for a WSL one, null when that key
 *  would pass the key cap. The reserve's holds and the open-worker counts use it. */
export function poolUsageKey(accountId: string, wslPlace?: WslPlace): string | null {
  return wslPlace ? wslStateKey(accountId, wslPlace) : accountId;
}

/** Open workers per pool account: launching ones under way, and launched ones
 *  whose worker may still run. Released and ended ones do not count. A
 *  worker on one of the account's WSL homes counts on the account too, so
 *  the per-account limit holds across Windows and every distro. */
export function openWorkersByAccount(slots: WorkerSlots, workerMayRun: (taskId: string) => boolean): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of slots.poolLaunches()) {
    if (l.state === 'launched' && !workerMayRun(l.taskId)) continue;
    out.set(l.accountId, (out.get(l.accountId) ?? 0) + 1);
  }
  return out;
}

/** For the reserve's refusal of a WSL task: null when some usable home in
 *  `place` is not held (or none is usable), else the hold that ends first,
 *  named by its home's key. A home out of quota is no reserve stop. */
export function poolHeldInPlace(pool: PreparedPool, place: WslPlace, deps: PickDeps = {}): { account: string; untilMs: number } | null {
  const candidates = poolCandidates(pool, { ...deps, place }).filter((c) => c.verdict.usable);
  if (candidates.length === 0 || candidates.some((c) => c.heldUntilMs === null)) return null;
  let first: { account: string; untilMs: number } | null = null;
  for (const c of candidates) {
    const key = poolUsageKey(c.id, place);
    if (key && c.heldUntilMs !== null && (!first || c.heldUntilMs < first.untilMs)) first = { account: key, untilMs: c.heldUntilMs };
  }
  return first;
}

/** The key a WSL pick's hold is named by when no single home is held: the
 *  candidate home there whose hold ends first, else the first candidate. */
export function heldHomeKey(pool: PreparedPool, place: WslPlace, deps: PickDeps = {}): string | null {
  const candidates = poolCandidates(pool, { ...deps, place });
  const held = candidates.filter((c) => c.heldUntilMs !== null).sort((a, b) => (a.heldUntilMs ?? 0) - (b.heldUntilMs ?? 0));
  const c = held[0] ?? candidates[0];
  return c ? poolUsageKey(c.id, place) : null;
}

/** Sign-in evidence from a WSL home in this run: a turn that worked, or a
 *  sample from a live pane with no failed turn since. A reading seeded from
 *  the trail after a restart is none (a failed sign-in of before it is not
 *  kept): it can rule a home out by its quota, never make it a candidate. */
function wslHomeSignedIn(e: { signedIn: boolean | null; live?: true } | undefined): boolean {
  return !!e && (e.signedIn === true || (e.signedIn === null && e.live === true));
}

/**
 * A WSL member's verdict on its home: null when the home is not a candidate
 * (no sign-in evidence from it, or its last turn failed on its sign-in).
 * The reading at any age rules a spent home out until its reset; only one
 * that arrived within the candidate age ranks it, an older one counts as not
 * measured (so a home last seen exhausted is never picked as if it were fresh).
 */
function wslVerdict(state: Pick<WslAccountState, 'get' | 'reading'>, accountId: string, place: WslPlace, now: number): ReturnType<typeof evaluateQuota> | null {
  if (!wslHomeSignedIn(state.get(accountId, place))) return null;
  const any = evaluateQuota(state.reading(accountId, place, 'bound'), now);
  if (!any.usable) return any;
  return evaluateQuota(state.reading(accountId, place, 'candidate'), now);
}

/** The candidates of a prepared pool now: quota from the readings on hand,
 *  the reserve's holds, the open workers. A member whose folder went since
 *  is left out. */
export function poolCandidates(pool: PreparedPool, deps: PickDeps = {}): PoolCandidate[] {
  const h = deps.host === undefined ? host : deps.host;
  const now = (deps.now ?? Date.now)();
  const holdFor = deps.holdFor ?? usageReserveHoldForAccount;
  const open = openWorkersByAccount(deps.slots ?? getWorkerSlots(), deps.workerMayRun ?? holderMayRun());
  const dirOk = deps.dirOk ?? isAccessibleDir;
  const out: PoolCandidate[] = [];
  if (deps.place) {
    // A WSL pane: only the homes in its place, read from WslAccountState
    // (never the Windows entries, the default login's included).
    const state = deps.wslState ?? getWslAccountState();
    for (const m of pool.wslMembers ?? []) {
      if (m.configDir === null || !dirOk(m.configDir)) continue;
      const key = poolUsageKey(m.id, deps.place);
      const verdict = key ? wslVerdict(state, m.id, deps.place, now) : null;
      if (!key || !verdict) continue;
      out.push({ id: m.id, verdict, heldUntilMs: holdFor(key)?.untilMs ?? null, open: open.get(m.id) ?? 0 });
    }
    return out;
  }
  const usage = h?.claudeUsage() ?? [];
  for (const m of pool.members) {
    if (m.configDir !== null && !dirOk(m.configDir)) continue;
    const reading = m.id === POOL_DEFAULT_ACCOUNT
      ? defaultReading(h?.defaultSnapshot() ?? null)
      : claudeReading(usage.find((e) => e.accountId === m.id));
    out.push({ id: m.id, verdict: evaluateQuota(reading, now), heldUntilMs: holdFor(m.id)?.untilMs ?? null, open: open.get(m.id) ?? 0 });
  }
  return out;
}

function defaultReading(snapshot: UsageSnapshot | null): ReturnType<typeof claudeReading> {
  return snapshot ? claudeReading({ accountId: POOL_DEFAULT_ACCOUNT, status: 'ok', snapshot, fetchedAtMs: snapshot.fetchedAtMs ?? null, lastError: null }) : null;
}

/** The account the next worker launches on. Sync: the caller books it in
 *  the launch record in the same step. */
export function pickFromPool(pool: PreparedPool, deps: PickDeps = {}): PoolPick {
  return pickPoolAccount(poolCandidates(pool, deps), pool.settings);
}

/**
 * Whether a pick that found no account sends the worker to the caller's
 * account, as with the pool off: the pool has no account that can run
 * workers at all (none eligible, such as accounts signed in only inside
 * WSL). Every account out of quota still refuses with its reset (the
 * caller's may be one of them), and a limit the owner set (the usage
 * reserve's holds, the per-account worker limit) still stops it. A WSL
 * task pane's pick over its homes is the exception: with no usable home
 * there it runs on the caller's account, as WSL panes did before the pool
 * took them in (fanout.rpc.ts accountPick).
 */
export function poolFallsBackToCaller(pick: PoolPick): boolean {
  return pick.kind === 'none' && pick.reason === 'empty';
}

/** Open workers on one usage key (an account id or 'default'), as the
 *  per-account worker limit counts them: pool launches and fallbacks onto
 *  the caller's account alike. */
export function openWorkersOn(key: string, deps: Pick<PickDeps, 'slots' | 'workerMayRun'> = {}): number {
  return openWorkersByAccount(deps.slots ?? getWorkerSlots(), deps.workerMayRun ?? holderMayRun()).get(key) ?? 0;
}

/** A worker ran on the caller's account (poolFallsBackToCaller): said once per app run. */
export function notePoolCallerFallback(deps: { host?: FanoutAccountPoolHost | null; log?: (line: string) => void } = {}): void {
  if (toldCallerFallback) return;
  (deps.log ?? ((line: string) => console.log(line)))('[fanout-pool] no pool account can run a worker: it runs on the caller\'s account, as with the pool off');
  const h = deps.host === undefined ? host : deps.host;
  if (!h?.notifyCallerFallback) return;
  try {
    h.notifyCallerFallback();
    toldCallerFallback = true;
  } catch { /* a notice never stops a launch; the next fallback tries again */ }
}

/** For the usage reserve's check at the fan-out: null when some member is
 *  not held (or the pool has none: the caller checks its own account then,
 *  poolFallsBackToCaller), else the member's hold that ends first. */
export function poolAllHeld(pool: PreparedPool, holdFor: (account: string) => { account: string; untilMs: number } | null = usageReserveHoldForAccount): { account: string; untilMs: number } | null {
  if (pool.members.length === 0) return null;
  let first: { account: string; untilMs: number } | null = null;
  for (const m of pool.members) {
    const hold = holdFor(m.id);
    if (!hold) return null;
    if (!first || hold.untilMs < first.untilMs) first = { account: hold.account, untilMs: hold.untilMs };
  }
  return first;
}

/**
 * A respawn or resume of a task whose last launch ran on pool account
 * `accountId` launches there again (its conversation lives in that folder,
 * so it can resume nowhere else), or is held: null when it may launch now,
 * else why not. The account must still be registered with its folder; while
 * the pool is on it must also have quota and not be held by the usage
 * reserve. Reads only what is on hand (no network).
 */
export function poolRelaunchRefusal(accountId: string, deps: PickDeps & { account?: (id: string) => Account | undefined; poolOn?: () => boolean; settings?: () => FanoutAccountPoolSettings; taskId?: string } = {}): string | null {
  const configDir = accountId === POOL_DEFAULT_ACCOUNT
    ? null
    : (deps.account ?? ((id: string) => getAccountStore().getAccount(id)))(accountId)?.configDir;
  if (configDir === undefined) return 'fan-out account pool: the account this task ran on is no longer registered';
  // A WSL launch runs again on the same home: its quota and hold are that home's.
  const own = deps.taskId ? (deps.slots ?? getWorkerSlots()).launchOf(deps.taskId) : null;
  // The pane's place, kept with the pool mark across a codex or agy generation.
  const wslPlace = own && (own.accountId === accountId || (!own.accountId && own.pooled === true)) ? own.wslPlace : undefined;
  const c = wslPlace && configDir !== null
    ? wslRelaunchCandidate(accountId, configDir, wslPlace, deps)
    : poolCandidates({ settings: DEFAULT_FANOUT_ACCOUNT_POOL_SETTINGS, group: '', members: [{ id: accountId, configDir }] }, deps)[0];
  if (!c) return 'fan-out account pool: the folder of the account this task ran on is missing';
  // Its WSL home's last turn failed on its sign-in: a worker there would stop at the login.
  if (wslPlace && (deps.wslState ?? getWslAccountState()).get(accountId, wslPlace)?.signedIn === false) {
    return `fan-out account pool: the account this task ran on is signed out in WSL ${wslPlace.distribution}; sign it in there first`;
  }
  const h = deps.host === undefined ? host : deps.host;
  const poolOn = deps.poolOn ?? (() => !!h && loadFanoutAccountPoolSettings().enabled);
  if (!poolOn()) return null;
  const when = (ms: number | null) => (ms !== null ? `; it frees up at ${new Date(ms).toISOString()}` : '');
  if (!c.verdict.usable) return `fan-out account pool: the account this task ran on is out of quota${when(c.verdict.availableAtMs)}`;
  if (c.heldUntilMs !== null) return `fan-out account pool: the usage reserve holds the account this task ran on${when(c.heldUntilMs)}`;
  // The per-account limit, not counting this task's own last launch (the
  // relaunch replaces it).
  const max = (deps.settings ?? loadFanoutAccountPoolSettings)().maxWorkersPerAccount;
  if (max > 0) {
    const ownCounted = own?.accountId === accountId && own.state !== 'released' ? 1 : 0;
    if (c.open - ownCounted >= max) return `fan-out account pool: the account this task ran on already runs its most workers (${max}); it starts again once one ends`;
  }
  return null;
}

/**
 * Whether a held bot fan-out of `workspaceId` stays held with the pool on:
 * decided by the same pick that held it (every usable account held by the
 * reserve, or every one out of quota with a known reset). Undefined when the
 * pool is off, the daemon is away, or no pool account can run workers at all
 * (poolFallsBackToCaller): the caller then checks the workspace's own
 * account, as the fan-out itself would. A pool not read yet (after a
 * restart) or read too long ago is read again in the background, and stays
 * held until that read is in.
 */
export function poolReserveHeldForWorkspace(
  workspaceId: string,
  deps: PickDeps & { poolOn?: () => boolean; refresh?: (workspaceId: string) => void; paneShell?: () => { wsl: boolean; distro: string | null }; defaultPlace?: (distro: string | null) => WslPlace | undefined } = {},
): boolean | undefined {
  const h = deps.host === undefined ? host : deps.host;
  const poolOn = deps.poolOn ?? (() => !!h && h.daemonConnected() && loadFanoutAccountPoolSettings().enabled);
  if (!poolOn()) return undefined;
  const now = (deps.now ?? Date.now)();
  const entry = lastPools.get(workspaceId);
  if (!entry || now - entry.at > LAST_POOL_TTL_MS) {
    (deps.refresh ?? refreshPoolInBackground)(workspaceId);
    if (!entry) return true;
  }
  // Its tasks run in Windows folders (worktrees, research folders); their
  // panes start WSL with a WSL default shell. The same pick as at their
  // launch: over the homes at that place, else (no usable home, or no place
  // known) the workspace's own account decides.
  const shell = (deps.paneShell ?? defaultTaskPaneShell)();
  if (shell.wsl) {
    const place = (deps.defaultPlace ?? ((d: string | null) => getWslAccountState().defaultPlace(d)))(shell.distro);
    if (!place || !poolCandidates(entry.pool, { ...deps, place }).some((c) => c.verdict.usable)) return undefined;
    return poolHeldInPlace(entry.pool, place, deps) !== null;
  }
  const pick = pickPoolAccount(poolCandidates(entry.pool, deps), entry.pool.settings);
  // No pool account can run it: its workers run on the workspace's own
  // account, which the caller checks (as with the pool off).
  if (poolFallsBackToCaller(pick)) return undefined;
  return pick.kind === 'none' && (pick.reason === 'held' || (pick.reason === 'quota' && pick.availableAtMs !== null));
}

/** A WSL relaunch's own home as a candidate: its quota at any age and its
 *  hold (no sign-in evidence is asked: its conversation lives there). */
function wslRelaunchCandidate(accountId: string, configDir: string, place: WslPlace, deps: PickDeps): PoolCandidate | undefined {
  if (!(deps.dirOk ?? isAccessibleDir)(configDir)) return undefined;
  const key = poolUsageKey(accountId, place);
  if (!key) return undefined;
  const now = (deps.now ?? Date.now)();
  const open = openWorkersByAccount(deps.slots ?? getWorkerSlots(), deps.workerMayRun ?? holderMayRun());
  return {
    id: accountId,
    verdict: evaluateQuota((deps.wslState ?? getWslAccountState()).reading(accountId, place, 'bound'), now),
    heldUntilMs: (deps.holdFor ?? usageReserveHoldForAccount)(key)?.untilMs ?? null,
    open: open.get(accountId) ?? 0,
  };
}

/** Whether a task pane with no shell of its own starts WSL (the Settings
 *  default shell, mirrored to main), and the distro it asks for. A
 *  prediction: the pane's create checks the shell it really got. */
export function defaultTaskPaneShell(platform: NodeJS.Platform = process.platform): { wsl: boolean; distro: string | null } {
  return { wsl: platform === 'win32' && isWslShellPath(getDefaultShellMirror() ?? undefined), distro: getDefaultWslDistro() };
}

/** The pool's answer for one fan-out task, with where its pane runs. */
export type PoolTaskPick =
  | { kind: 'pick'; accountId: string; wslPlace?: WslPlace }
  /** A WSL pane the pool has no usable home for: it runs on the caller's
   *  account, as WSL panes did before the pool took them in. `place` absent:
   *  no start place is known for `distro` in this run. */
  | { kind: 'wsl-caller'; distro: string | null; place?: WslPlace }
  /** No account now: the caller decides (fall back, refuse or hold). */
  | { kind: 'none'; pick: Extract<PoolPick, { kind: 'none' }>; wslPlace?: WslPlace };

export interface PoolTaskDeps {
  /** Whether a task pane with no shell of its own starts WSL (default: defaultTaskPaneShell). */
  paneShell?: () => { wsl: boolean; distro: string | null };
  /** Where a plain WSL pane asking for a distro starts (default: WslAccountState defaultPlace). */
  defaultPlace?: (distro: string | null) => WslPlace | undefined;
  wslState?: Pick<WslAccountState, 'get' | 'reading'>;
  pick?: (pool: PreparedPool, deps: PickDeps) => PoolPick;
}

/**
 * One task's pick, shared by every fan-out entry point (the wire and the GUI).
 * A task folder on a WSL share starts a WSL pane in that distro; a task pane
 * on any other folder starts WSL when the default shell is WSL, in the chosen
 * distro. Such a pane runs as whoever a plain pane there starts as, and its
 * accounts on their homes there: with no such place known, or no usable home
 * there (none signed in, or every one spent), it runs on the caller's account.
 */
export function pickPoolTask(pool: PreparedPool, task: { cwd?: string }, deps: PoolTaskDeps = {}): PoolTaskPick {
  const share = task.cwd ? wslShareToLinux(task.cwd) : null;
  const shell = (deps.paneShell ?? defaultTaskPaneShell)();
  const wslPane = !!share || shell.wsl;
  const distro = share ? share.distro : shell.distro;
  const place = wslPane ? (deps.defaultPlace ?? ((d: string | null) => getWslAccountState().defaultPlace(d)))(distro) : undefined;
  if (wslPane && !place) return { kind: 'wsl-caller', distro };
  const picked = (deps.pick ?? pickFromPool)(pool, place ? { place, ...(deps.wslState ? { wslState: deps.wslState } : {}) } : {});
  if (picked.kind === 'pick') return { kind: 'pick', accountId: picked.accountId, ...(place ? { wslPlace: place } : {}) };
  if (place && (picked.reason === 'empty' || picked.reason === 'quota')) return { kind: 'wsl-caller', distro, place };
  return { kind: 'none', pick: picked, ...(place ? { wslPlace: place } : {}) };
}

/** The log line for a WSL task the pool sent to the caller's account, saying why. */
export function poolTaskCallerLine(index: number, p: Extract<PoolTaskPick, { kind: 'wsl-caller' }>): string {
  const why = p.place
    ? `no pool account has a usable sign-in on its home in WSL ${p.place.distribution} as ${p.place.user} (a working turn or a live pane there in this run)`
    : `no start place is known in this run for WSL ${p.distro ?? '(default distro)'} (a plain WSL pane there tells it)`;
  return `[fanout-pool] task ${index + 1} runs on the caller's account: ${why}`;
}

/** The pool's accounts (an agent with usageReserve: Claude), by folder: what a live pane's env is read against (learnFromLiveSessions). */
export function poolClaudeAccounts(accounts: () => readonly Account[] = () => getAccountStore().listAccounts()): Array<{ id: string; configDir: string }> {
  return accounts().filter((a) => agentRow(a.vendor)?.usageReserve === true).map((a) => ({ id: a.id, configDir: a.configDir }));
}

/** After a restart, learn from the daemon's live sessions where a distro
 *  starts and which homes run a live claude (wslAccountState.ts
 *  learnFromLiveSessions), while that is still to be read. */
export async function learnPoolStartPlaces(deps: { host?: FanoutAccountPoolHost | null; state?: Pick<WslAccountState, 'liveSessionsPending' | 'learnFromLiveSessions'>; accounts?: () => readonly Account[] } = {}): Promise<void> {
  const h = deps.host === undefined ? host : deps.host;
  const state = deps.state ?? getWslAccountState();
  if (!h?.daemonSessions || !state.liveSessionsPending()) return;
  try {
    const sessions = await h.daemonSessions();
    if (Array.isArray(sessions)) state.learnFromLiveSessions(sessions as Array<Record<string, unknown>>, poolClaudeAccounts(deps.accounts));
  } catch { /* not known: such a task runs on the caller's account */ }
}

const GUI_POOL_FRESH_MS = 10_000;

/**
 * The pool's account pick for a fan-out a person started (the dialog, the Git
 * page's hand-off, hand out): the same pick as the wire's (pickPoolTask), so
 * its workers spread over the pool too. A click is never refused by the pool:
 * with no account free (held by the reserve, at the worker limit, or spent)
 * a worker runs on the caller's account, as it did with the pool off.
 */
export function guiFanOutAccountPick(
  callerWorkspaceId: string,
  taskRunsClaude: (index: number) => boolean,
  deps: PoolTaskDeps & { prepare?: (workspaceId: string) => Promise<PreparedPool | null>; learn?: () => Promise<void>; log?: (line: string) => void; notifyFallback?: () => void; callerAccountKey?: (workspaceId: string) => string } = {},
): AccountPick {
  const log = deps.log ?? ((line: string) => console.log(line));
  // A worker that falls to the caller's account with no pool account free is
  // booked there, as on the wire, so it counts toward the per-account worker
  // limit of later picks. Never refused: a person started it.
  const onCaller = (): { callerAccount: string } => ({
    callerAccount: (deps.callerAccountKey ?? ((ws: string) => getAccountStore().getBinding(ws, 'claude') ?? POOL_DEFAULT_ACCOUNT))(callerWorkspaceId),
  });
  const fellBack = deps.notifyFallback ?? (() => notePoolCallerFallback());
  let pool: PreparedPool | null = null;
  let readAt = 0;
  let reading: Promise<void> | null = null;
  return {
    prepare: async ({ index }) => {
      if (!taskRunsClaude(index)) return;
      if (!reading || Date.now() - readAt >= GUI_POOL_FRESH_MS) {
        readAt = Date.now();
        reading = (deps.prepare ?? preparePool)(callerWorkspaceId).then(
          async (p) => { pool = p; if (p) await (deps.learn ?? learnPoolStartPlaces)(); },
          () => { readAt = 0; },
        );
      }
      await reading;
    },
    pick: (task) => {
      const current = pool;
      if (!current || !taskRunsClaude(task.index)) return null;
      const d = pickPoolTask(current, task, deps);
      if (d.kind === 'pick') return { accountId: d.accountId, ...(d.wslPlace ? { wslPlace: d.wslPlace } : {}) };
      if (d.kind === 'wsl-caller') {
        log(poolTaskCallerLine(task.index, d));
        fellBack();
        return null;
      }
      if (poolFallsBackToCaller(d.pick)) fellBack();
      else log(`[fanout-pool] task ${task.index + 1} runs on the caller's account: no pool account is free (${d.pick.reason})`);
      return onCaller();
    },
  };
}

function refreshPoolInBackground(workspaceId: string): void {
  if (refreshingPools.has(workspaceId)) return;
  refreshingPools.add(workspaceId);
  void preparePool(workspaceId).catch(() => null).finally(() => refreshingPools.delete(workspaceId));
}

/** A launching pool task's fan-out says how a reserve stop at its pane's
 *  create is held (its reserveRefusal), so a bot's request is kept for the
 *  reset as it would be at the launch check. */
export function registerPoolCreateReserveHold(taskId: string, hold: (h: { account: string; untilMs: number }) => string): void {
  createReserveHolds.delete(taskId);
  createReserveHolds.set(taskId, hold);
  while (createReserveHolds.size > CREATE_RESERVE_HOLDS_MAX) createReserveHolds.delete(createReserveHolds.keys().next().value as string);
}

/** The refusal of a create the reserve stops, held through the task's
 *  fan-out when it registered one (used once); null when it did not. */
export function poolCreateReserveRefusal(taskId: string, hold: { account: string; untilMs: number }): string | null {
  const fn = createReserveHolds.get(taskId);
  if (!fn) return null;
  createReserveHolds.delete(taskId);
  try {
    return fn(hold);
  } catch {
    return null;
  }
}

/** The pool account a pane's live env runs on: the registered account whose
 *  folder its CLAUDE_CONFIG_DIR names, the default login when it names none,
 *  undefined for a folder no account has. */
export function poolAccountOfPaneEnv(env: Record<string, string>, accounts: () => readonly Account[] = () => getAccountStore().listAccounts()): string | undefined {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return POOL_DEFAULT_ACCOUNT;
  return accounts().find((a) => a.configDir === dir && agentRow(a.vendor)?.usageReserve === true)?.id;
}

/** The pool account of a live pane, read from the daemon's session env, for
 *  a relaunch typed into it; undefined when the pane's task never ran on the
 *  pool (nothing is read then) or it cannot be read. */
export async function poolAccountOfLivePane(sessionId: string, rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>, slots: WorkerSlots = getWorkerSlots()): Promise<string | undefined> {
  if (!paneTaskPooled(sessionId, slots)) return undefined;
  try {
    const sessions = await rpc('daemon.listSessions', {}) as Array<{ id?: unknown; env?: unknown }>;
    const s = Array.isArray(sessions) ? sessions.find((x) => x?.id === sessionId) : undefined;
    if (!s?.env || typeof s.env !== 'object') return undefined;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.env)) if (typeof v === 'string') env[k] = v;
    return poolAccountOfPaneEnv(env);
  } catch {
    return undefined;
  }
}

// ── The worker pane's create ────────────────────────────────────────────────

export type PoolCreateDecision =
  /** No pool account for this create: it runs as before. */
  | { kind: 'none' }
  /** The record named an account but the line launches no Claude, or the
   *  pane does not run where the account was picked for (`wsl`: it runs on
   *  the caller's account, as without the pool): drop it. */
  | { kind: 'release'; taskId: string; gen: number; wsl?: true }
  /** The default login: no account folder, and no quota rotation away from it. */
  | { kind: 'default' }
  /** `wslPlace`: a WSL pane picked for its home there, spawned as that user. */
  | { kind: 'account'; accountId: string; wslPlace?: WslPlace };

/**
 * What a fan-out task pane's create does with its launch record's pool
 * account. Read only after the launch was claimed (stampFanoutTaskPane). The
 * renderer's `accountId` is never taken: one that differs from the record's
 * refuses the create (THROWS). Only a Claude line (and not a Codex one) runs
 * on the account; any other line releases it. The account runs only where
 * it was picked for: a WSL pane keeps it when the record's place is the
 * pane's own (same distro, any case, and same user), a native pane when the
 * record names no place. Any other pane releases it (`wsl`): its sign-in and
 * quota there were never read, so it runs as it did before the pool. Pure
 * over its inputs.
 */
export function poolAccountForCreate(
  options: { fanoutTaskOf?: unknown; fanoutLaunch?: unknown; accountId?: unknown; initialCommand?: unknown } | undefined,
  launchOf: (taskId: string) => { gen: number; state: string; accountId?: string; wslPlace?: WslPlace } | null,
  place: { wsl?: boolean; wslPlace?: WslPlace | null } = {},
): PoolCreateDecision {
  if (typeof options?.fanoutTaskOf !== 'string' || !options.fanoutTaskOf) return { kind: 'none' };
  const token = parseLaunchToken(options.fanoutLaunch);
  if (!token) return { kind: 'none' };
  const launch = launchOf(token.taskId);
  if (!launch || launch.gen !== token.gen || launch.state === 'released' || !launch.accountId) return { kind: 'none' };
  const named = options.accountId;
  const recorded = launch.accountId === POOL_DEFAULT_ACCOUNT ? undefined : launch.accountId;
  if (named !== undefined && named !== recorded) {
    throw new Error('PTY_CREATE: this task pane runs on the account its launch recorded, not one the create names');
  }
  const raw = typeof options.initialCommand === 'string' ? options.initialCommand : '';
  const line = splitModelEnvMarker(raw).command;
  if (!line || !namesClaude(line) || namesCodex(line)) return { kind: 'release', taskId: token.taskId, gen: token.gen };
  const at = launch.wslPlace;
  const here = place.wsl === true ? place.wslPlace ?? null : undefined;
  const same = at && here
    ? at.distribution.toLowerCase() === here.distribution.toLowerCase() && at.user === here.user
    : !at && here === undefined;
  if (!same) return { kind: 'release', taskId: token.taskId, gen: token.gen, wsl: true };
  if (!recorded) return { kind: 'default' };
  return at ? { kind: 'account', accountId: recorded, wslPlace: at } : { kind: 'account', accountId: recorded };
}

/** The pool account (never the default login) a task workspace's current
 *  launch runs on, for the turn-end usage probe. */
export function poolAccountOfWorkspace(workspaceId: string, slots: WorkerSlots = getWorkerSlots()): string | null {
  try {
    const ref = slots.workspaceOf(workspaceId);
    if (!ref) return null;
    const launch = slots.launchOf(ref.taskId);
    if (!launch || launch.gen !== ref.gen || !launch.accountId || launch.accountId === POOL_DEFAULT_ACCOUNT) return null;
    // A WSL home is measured by its own pane's samples, never by a Windows probe.
    if (launch.wslPlace) return null;
    return launch.accountId;
  } catch {
    return null;
  }
}

/** A task pane moved to `accountId` in place (continueOnAccount, after the
 *  daemon confirmed): its launch record follows, when it has a pool account. */
export function notePoolPaneMoved(sessionId: string, accountId: string, slots: WorkerSlots = getWorkerSlots()): void {
  try {
    const pane = slots.paneOf(sessionId);
    if (pane) slots.setLaunchAccount(pane.taskId, pane.gen, accountId);
  } catch {
    // the record keeps the old account; the next pick may count it there
  }
}
