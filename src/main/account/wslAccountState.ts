// ─── A WSL account home's sign-in and usage, per distro and Linux user ───────
//
// A registered account runs in a WSL pane on its own home in the distro
// (shared/wslAccountHome.ts). That home is signed in inside the distro, maybe
// to another login than the account's Windows folder, so nothing measured on
// the Windows side says anything about it, and nothing measured there is
// mixed into the Windows entry (AccountUsageService).
//
// This store is the one source of truth for such a home: keyed (account,
// distro, user), since the home is /home/<user>/.wmux<suffix>/accounts/…
// It is written only by:
//   - a usage sample from a live WSL pane whose own env and user give that
//     home (usage.rpc.ts): the READING, stamped when it arrived;
//   - a hook from a WSL claude whose transcript lies under that home's
//     projects/ (a turn that failed on its sign-in, or one that worked): the
//     SIGN-IN evidence;
//   - after a restart, a reattached pane whose live claude process (the
//     daemon's process watch) runs on that home by its own env and user:
//     live evidence, as a sample would be (learnFromLiveSessions).
// It never asks the distro anything, never reads its files, and so never
// boots a stopped one. Readings are mirrored into the usage trail under the
// same key, which seeds them after a restart.
//
// Accepted: a local process holding main's pipe token could forge a sample
// (as for any pane); the boundary against another OS user is a separate design.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { validWslTarget } from '../../shared/wslTarget';
import { canonicalAccountFolder, wslAccountLinuxHome } from '../../shared/wslAccountHome';
import { agentRow } from '../../shared/agentIdentity';
import type { UsageSnapshot } from '../claude/UsageApi';
import { mergeLive, type UsageUpdate } from '../claude/usageMerge';
import type { AccountQuotaReading } from '../../shared/accountQuota';
import type { UsageTrailSample } from '../usage/usageTrail';

/** Where a WSL launch or pane runs: its distro and Linux user. */
export interface WslPlace {
  distribution: string;
  user: string;
}

/** The usage trail's and the reserve's key cap (usageReserveHolds.ts, usage.rpc.ts). */
export const MAX_WSL_STATE_KEY_LEN = 128;

/** A candidate's reading must be this fresh to be switched to (AccountRotationService's age). */
export const WSL_CANDIDATE_MAX_AGE_MS = 10 * 60 * 1000;

const KEY_MARK = '@wsl:';

interface PlainPane {
  requested: string;
  pid: number;
  /** The process's start identity, when the daemon had it at the create. */
  start?: string;
  /** When it was noted (newest wins for a distro). */
  at: number;
}

/** The start identity the daemon records for a session's process (Windows'
 *  FILETIME, else POSIX `lstart` or the kernel start tick), or null. */
function processStart(s: { pidCreatedAtFt?: unknown; pidStartTime?: unknown; pidStartKernel?: unknown } | null | undefined): string | null {
  for (const v of [s?.pidCreatedAtFt, s?.pidStartTime, s?.pidStartKernel]) {
    if ((typeof v === 'string' && v) || typeof v === 'number') return String(v);
  }
  return null;
}

/** The plain WSL panes kept for a restart (notePlainPane), next to the places file. */
export const WSL_PLAIN_PANES_FILENAME = 'wsl-plain-panes.json';
const MAX_PLAIN_PANES = 256;

function firstSnapshot(update: UsageUpdate, nowMs: number): UsageSnapshot | null {
  if (!update.session && !update.weekly) return null;
  return {
    ...(update.session ? { sessionPct: update.session.pct, sessionResetEpochSec: update.session.resetEpochSec } : {}),
    ...(update.weekly ? { weeklyPct: update.weekly.pct, weeklyResetEpochSec: update.weekly.resetEpochSec } : {}),
    fetchedAtMs: nowMs,
  };
}

/** Distro names compare as the daemon's target.distribution does: any case. */
function placeHash(place: WslPlace): string {
  return createHash('sha256').update(`${place.distribution.toLowerCase()}\0${place.user}`).digest('hex').slice(0, 16);
}

/** `<accountId>@wsl:<16 hex of distro and user>`, or null when it would pass the key cap. */
export function wslStateKey(accountId: string, place: WslPlace): string | null {
  const key = `${accountId}${KEY_MARK}${placeHash(place)}`;
  return key.length <= MAX_WSL_STATE_KEY_LEN ? key : null;
}

/** Whether a usage-trail key is one of this store's. */
export function isWslStateKey(key: string): boolean {
  return /@wsl:[0-9a-f]{16}$/.test(key);
}

export interface WslAccountEntry {
  snapshot: UsageSnapshot | null;
  /** When the last sample ARRIVED (not the window it describes). */
  sampleAtMs: number | null;
  /** Last sign-in evidence: true after a turn worked, false after one failed on its sign-in. */
  signedIn: boolean | null;
  /** A sample from a live pane arrived in this run (a reading seeded from the
   *  trail is not one: the sign-in evidence of before the restart is gone). */
  live?: true;
}

export class WslAccountState {
  private readonly entries = new Map<string, WslAccountEntry>();
  /** Where a plain WSL pane last started, by the distro it asked for
   *  (lowercased; '' for wsl.exe's default distro). */
  private readonly defaultPlaces = new Map<string, WslPlace>();
  private readonly listeners = new Set<() => void>();
  /** Plain WSL panes this store saw start, by session id: the distro they
   *  asked for and their process id (wsl-plain-panes.json). After a restart a
   *  live one of them, reattached with the same process, says where its
   *  distro starts (learnFromLiveSessions). */
  private readonly plainPanes = new Map<string, PlainPane>();
  private plainFile?: string;
  /** The daemon's sessions were read for live claude homes in this run. */
  private liveHomesRead = false;

  /**
   * `placesFile`: where the default places are kept across restarts, so the
   * first plain launch after one has a place (a recovered pane comes back by
   * reattach, never through a plain create). Only the requested distro and
   * the (distro, user) it started as: no reading, no sign-in. Only a NAMED
   * distro's: which distro wsl.exe's default is can change while wmux is
   * closed (`wsl --set-default`), so that one is learned again each run.
   */
  constructor(private readonly now: () => number = Date.now, private readonly placesFile?: string) {
    if (!placesFile) return;
    this.plainFile = path.join(path.dirname(placesFile), WSL_PLAIN_PANES_FILENAME);
    try {
      const raw = atomicReadJSONSync<Record<string, unknown>>(this.plainFile);
      for (const [id, v] of Object.entries(raw ?? {})) {
        const r = v as { requested?: unknown; pid?: unknown; start?: unknown; at?: unknown } | null;
        if (id && typeof r?.requested === 'string' && typeof r.pid === 'number' && Number.isInteger(r.pid) && r.pid > 0) {
          this.plainPanes.set(id, {
            requested: r.requested.toLowerCase(), pid: r.pid,
            ...(typeof r.start === 'string' && r.start ? { start: r.start } : {}),
            at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
          });
        }
      }
    } catch { /* none kept yet: learned from the next plain pane */ }
    try {
      const raw = atomicReadJSONSync<Record<string, unknown>>(placesFile);
      for (const [requested, place] of Object.entries(raw ?? {})) {
        if (requested && validWslTarget(place)) this.defaultPlaces.set(requested.toLowerCase(), { distribution: place.distribution, user: place.user });
      }
    } catch { /* none kept yet, or unreadable: learned again from the next plain pane */ }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    for (const l of this.listeners) {
      try { l(); } catch { /* a listener never breaks a write */ }
    }
  }

  private entry(key: string): WslAccountEntry {
    let e = this.entries.get(key);
    if (!e) {
      e = { snapshot: null, sampleAtMs: null, signedIn: null };
      this.entries.set(key, e);
    }
    return e;
  }

  /** A usage sample from a live pane on this home. Returns the merged snapshot to mirror, or null. */
  noteSample(accountId: string, place: WslPlace, update: UsageUpdate): UsageSnapshot | null {
    const key = wslStateKey(accountId, place);
    if (!key) return null;
    const e = this.entry(key);
    // A first sample stands on its own even with one window (a plan that has
    // no 5h one): no probe here seeds the other half.
    const merged = mergeLive(e.snapshot, update, this.now()) ?? (e.snapshot ? null : firstSnapshot(update, this.now()));
    // Arrival is what makes a reading fresh, even when the numbers did not move.
    e.sampleAtMs = this.now();
    e.live = true;
    if (merged) e.snapshot = merged;
    this.changed();
    return merged ?? e.snapshot;
  }

  /** Sign-in evidence from a hook whose transcript lies under this home. */
  noteAuth(accountId: string, place: WslPlace, signedIn: boolean): void {
    const key = wslStateKey(accountId, place);
    if (!key) return;
    this.entry(key).signedIn = signedIn;
    this.changed();
  }

  /** After a restart: the last mirrored reading of a key, when nothing newer is held. */
  seed(key: string, snapshot: UsageSnapshot, atMs: number): void {
    if (!isWslStateKey(key) || key.length > MAX_WSL_STATE_KEY_LEN) return;
    const e = this.entry(key);
    if (e.sampleAtMs !== null && e.sampleAtMs >= atMs) return;
    e.snapshot = snapshot;
    e.sampleAtMs = atMs;
    this.changed();
  }

  get(accountId: string, place: WslPlace): WslAccountEntry | undefined {
    const key = wslStateKey(accountId, place);
    return key ? this.entries.get(key) : undefined;
  }

  /** Every held entry by key, for the usage reserve and the trail. */
  all(): Array<[string, WslAccountEntry]> {
    return [...this.entries];
  }

  /** A plain WSL pane (no target of its own) that asked for `requested` started at `place`. */
  noteDefaultPlace(requested: string | null, place: WslPlace): void {
    const key = (requested ?? '').toLowerCase();
    const prev = this.defaultPlaces.get(key);
    this.defaultPlaces.set(key, { distribution: place.distribution, user: place.user });
    if (!this.placesFile || (prev && prev.distribution === place.distribution && prev.user === place.user)) return;
    try {
      if (!key) return;
      atomicWriteJSONSync(this.placesFile, Object.fromEntries([...this.defaultPlaces].filter(([requested]) => requested)));
    } catch { /* kept for this run only */ }
  }

  /** A plain WSL pane (no target of its own: not a recovery, a continued
   *  conversation or a pool pin) started as session `sessionId`, process
   *  `pid`, asking for `requested`: kept so a restart can learn its place
   *  again from it while that same process lives. */
  notePlainPane(sessionId: string, session: { pid?: unknown; pidCreatedAtFt?: unknown; pidStartTime?: unknown; pidStartKernel?: unknown } | null | undefined, requested: string | null): void {
    const pid = session?.pid;
    if (!this.plainFile || !sessionId || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
    const start = processStart(session);
    this.plainPanes.delete(sessionId);
    this.plainPanes.set(sessionId, { requested: (requested ?? '').toLowerCase(), pid, ...(start ? { start } : {}), at: this.now() });
    while (this.plainPanes.size > MAX_PLAIN_PANES) this.plainPanes.delete(this.plainPanes.keys().next().value as string);
    this.savePlainPanes();
  }

  /**
   * After a restart: the daemon's live sessions. A plain pane kept from
   * before, still the same process (a reattach, not a respawn), is live
   * evidence of where its distro starts now, so a distro whose start place
   * is not known in this run (the unnamed default's is never kept) learns
   * it. In memory only, as from a plain create. Panes that are gone are
   * dropped from the file.
   */
  learnFromLiveSessions(
    sessions: ReadonlyArray<{ id?: unknown; pid?: unknown; state?: unknown; wslTarget?: unknown; pidCreatedAtFt?: unknown; pidStartTime?: unknown; pidStartKernel?: unknown; env?: unknown; liveAgent?: unknown }>,
    claudeAccounts?: ReadonlyArray<{ id: string; configDir: string }>,
  ): void {
    if (claudeAccounts) this.learnLiveHomes(sessions, claudeAccounts);
    if (this.plainPanes.size === 0) return;
    const live = new Set<string>();
    // Per distro asked for, the most recently started live pane (one started
    // before a `wsl --set-default` says less than one started after it).
    const newest = new Map<string, { at: number; place: WslPlace }>();
    for (const s of sessions) {
      if (typeof s?.id !== 'string') continue;
      const kept = this.plainPanes.get(s.id);
      // Only a running process: a daemon restart's placeholders ('suspended')
      // carry the old pid and target, and a respawn has another process.
      if (!kept || (s.state !== 'attached' && s.state !== 'detached') || s.pid !== kept.pid) continue;
      // The process that started then, not a later one that got its pid.
      const start = processStart(s);
      if (kept.start && start !== kept.start) continue;
      live.add(s.id);
      if (!validWslTarget(s.wslTarget)) continue;
      const prev = newest.get(kept.requested);
      if (!prev || kept.at > prev.at) newest.set(kept.requested, { at: kept.at, place: { distribution: s.wslTarget.distribution, user: s.wslTarget.user } });
    }
    for (const [requested, { place }] of newest) {
      if (!this.defaultPlaces.has(requested)) this.defaultPlaces.set(requested, place);
    }
    let dropped = false;
    for (const id of [...this.plainPanes.keys()]) if (!live.has(id)) { this.plainPanes.delete(id); dropped = true; }
    if (dropped) this.savePlainPanes();
  }

  /**
   * After a restart, a pane that survived by reattach with claude still
   * running in it (the daemon's process watch, `liveAgent`) on an account's
   * home is live evidence for that home, as a sample from it would be: an
   * idle claude does not redraw, so no sample comes on its own. The home is
   * the one the session's own env and user give (as usage.rpc.ts reads a
   * sample's), never a saved binding. A home whose last turn failed on its
   * sign-in stays out (`signedIn` is not touched). Read once per run.
   */
  private learnLiveHomes(
    sessions: ReadonlyArray<{ state?: unknown; wslTarget?: unknown; env?: unknown; liveAgent?: unknown }>,
    claudeAccounts: ReadonlyArray<{ id: string; configDir: string }>,
  ): void {
    this.liveHomesRead = true;
    let marked = false;
    for (const s of sessions) {
      if ((s?.state !== 'attached' && s?.state !== 'detached') || agentRow(typeof s.liveAgent === 'string' ? s.liveAgent : undefined)?.usageReserve !== true || !validWslTarget(s.wslTarget)) continue;
      if (!s.env || typeof s.env !== 'object') continue;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.env)) if (typeof v === 'string') env[k] = v;
      if (!wslAccountLinuxHome(env, 'claude', s.wslTarget.user)) continue;
      const folder = canonicalAccountFolder(env.CLAUDE_CONFIG_DIR ?? '');
      const place = { distribution: s.wslTarget.distribution, user: s.wslTarget.user };
      for (const a of claudeAccounts) {
        const key = canonicalAccountFolder(a.configDir) === folder ? wslStateKey(a.id, place) : null;
        if (!key) continue;
        this.entry(key).live = true;
        marked = true;
      }
    }
    if (marked) this.changed();
  }

  /** Whether the daemon's sessions are worth reading (learnFromLiveSessions):
   *  live claude homes not read yet in this run, or a kept plain pane's
   *  distro with no start place yet. */
  liveSessionsPending(): boolean {
    return !this.liveHomesRead || this.hasUnlearnedPlainPanes();
  }

  /** Whether a kept plain pane's distro has no start place in this run yet:
   *  then the daemon's sessions are worth reading (learnFromLiveSessions). */
  hasUnlearnedPlainPanes(): boolean {
    for (const p of this.plainPanes.values()) if (!this.defaultPlaces.has(p.requested)) return true;
    return false;
  }

  private savePlainPanes(): void {
    if (!this.plainFile) return;
    try {
      atomicWriteJSONSync(this.plainFile, Object.fromEntries(this.plainPanes));
    } catch { /* kept for this run only */ }
  }

  /** Where a plain pane asking for `requested` starts, when one was seen since main started. */
  defaultPlace(requested: string | null): WslPlace | undefined {
    return this.defaultPlaces.get((requested ?? '').toLowerCase());
  }

  /**
   * The quota reading of this home for a launch decision. The BOUND account's
   * is used at any age: once its reset passes, evaluateQuota counts the
   * window as refilled, and samples stop when claude is closed. A switch
   * CANDIDATE needs one that arrived within WSL_CANDIDATE_MAX_AGE_MS.
   */
  reading(accountId: string, place: WslPlace, role: 'bound' | 'candidate'): AccountQuotaReading | null {
    const e = this.get(accountId, place);
    const s = e?.snapshot;
    // A home whose last turn failed on its sign-in cannot run a launch.
    if (!e || !s || e.sampleAtMs === null || e.signedIn === false) return null;
    if (role === 'candidate' && this.now() - e.sampleAtMs > WSL_CANDIDATE_MAX_AGE_MS) return null;
    const win = (pct: number | undefined, resetSec = 0) => (pct === undefined ? [] : [{
      remaining: 1 - Math.max(0, Math.min(100, pct)) / 100,
      resetAtMs: resetSec > 0 ? resetSec * 1000 : null,
    }]);
    return { windows: [...win(s.sessionPct, s.sessionResetEpochSec), ...win(s.weeklyPct, s.weeklyResetEpochSec)], capturedAtMs: e.sampleAtMs };
  }
}

/** Seed a store from the usage trail's last `@wsl:` sample per key (after a restart). */
export function seedWslAccountState(
  state: Pick<WslAccountState, 'seed'>,
  trail: { keys(): string[]; read(key: string): UsageTrailSample[] },
): void {
  for (const key of trail.keys()) {
    if (!isWslStateKey(key)) continue;
    const last = trail.read(key).at(-1);
    if (!last) continue;
    // A window kept as 0% with no reset is one the plan does not have (usageTrail.ts).
    const absent = (pct: number, reset: number) => pct === 0 && reset === 0;
    state.seed(key, {
      ...(absent(last.s5, last.r5) ? {} : { sessionPct: last.s5, sessionResetEpochSec: last.r5 }),
      ...(absent(last.s7, last.r7) ? {} : { weeklyPct: last.s7, weeklyResetEpochSec: last.r7 }),
      fetchedAtMs: last.t,
    }, last.t);
  }
}

let instance: WslAccountState | null = null;

export function getWslAccountState(): WslAccountState {
  if (!instance) instance = new WslAccountState(Date.now, path.join(getWmuxDir(), 'wsl-default-places.json'));
  return instance;
}
