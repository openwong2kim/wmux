import { execFile } from 'node:child_process';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { getExecEnv } from '../../shared/execEnv';
import { coerceSpawnPolicy, defaultSpawnPolicy, type A2aSpawnPolicySetResult, type A2aSpawnPolicyV1 } from '../../shared/a2aSpawn';
import type { HostId } from '../../shared/a2aRemote';
import { CheckBusy, CheckTimeout, realpathNative, spawnChecks, type SpawnChecks } from './spawnChecks';
import { loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * Remote spawn policy (`spawn-policy.json`): who may ask this PC to start a
 * new agent, where, and which agents. A missing file is the default: off,
 * nobody allowed.
 *
 * The app's own human changes it (`wmux.internal` RPCs), and on a host the
 * app does not use, a person through `wmux remote allow|revoke` on the daemon
 * pipe (DaemonPipeServer HEADLESS_REMOTE_METHODS), which may not name a PC
 * that is not paired (spawnReceiver `unpairedHostNamed`). That is not a
 * boundary against code running as the same user on this PC; the boundary is
 * this PC's per-PC opt-in and its approval of each request.
 *
 * Roots: every save resolves each root to its realpath and requires it to be
 * a git repository's top level (an agent only ever works in a fresh worktree
 * of one). The resolved path is what is stored, and what a request's folder
 * is checked against.
 */

export const SPAWN_POLICY_FILE = 'spawn-policy.json';
/**
 * How long one save may take, from the call: queued behind another save and
 * checking every folder. Under the app's 30 s RPC timeout, so a save the app
 * gave up on has saved nothing.
 */
export const SPAWN_POLICY_SET_BUDGET_MS = 25_000;

/** The repository top level of `dir` (realpath), or null when it is not inside one. */
export type RepoToplevel = (dir: string) => Promise<string | null>;

export interface SpawnPolicyStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seams. */
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
  repoToplevel?: RepoToplevel;
  realpath?: (p: string) => Promise<string>;
  checks?: SpawnChecks;
  setBudgetMs?: number;
}

export class SpawnPolicyStore {
  readonly filePath: string;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly repoToplevel: RepoToplevel;
  private readonly realpath: (p: string) => Promise<string>;
  private readonly checks: SpawnChecks;
  private readonly now: () => number;
  private readonly setBudgetMs: number;
  private policy: A2aSpawnPolicyV1;
  private writable: boolean;

  constructor(opts: SpawnPolicyStoreOptions) {
    this.filePath = path.join(opts.dir, SPAWN_POLICY_FILE);
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    this.repoToplevel = opts.repoToplevel ?? gitToplevel;
    this.realpath = opts.realpath ?? realpathNative;
    this.checks = opts.checks ?? spawnChecks;
    this.now = opts.now ?? Date.now;
    this.setBudgetMs = opts.setBudgetMs ?? SPAWN_POLICY_SET_BUDGET_MS;
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: SPAWN_POLICY_FILE,
      coerce: coerceSpawnPolicy,
      now: opts.now ?? Date.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'remote spawn starts off, with nobody allowed',
    });
    this.policy = loaded.value ?? defaultSpawnPolicy();
    this.writable = loaded.writable;
  }

  get(): A2aSpawnPolicyV1 {
    return structuredClone(this.policy);
  }

  /**
   * Replace the policy with `raw`, after checking it whole: each root must
   * resolve to a git repository's top level, and is stored as that realpath.
   *
   * `raw.version` is the version the caller read. Saves run one at a time,
   * and one whose version is no longer current (another save, or a removed
   * PC, landed meanwhile) is refused as a `conflict` and changes nothing.
   * The version check and the write happen together, after every wait.
   */
  set(raw: unknown): Promise<A2aSpawnPolicySetResult> {
    const deadline = this.now() + this.setBudgetMs;
    const run = this.queue.then(() => this.setNow(raw, deadline));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** A paired PC was removed: it is no longer allowed and its rules go (a re-pair starts from nothing). */
  forgetHost(hostId: HostId): boolean {
    return this.retainHosts((h) => h !== hostId, `forgetting ${hostId}`);
  }

  /**
   * Keep only the PCs `paired` still knows, e.g. on start: a removal whose
   * write failed before a restart is applied again here.
   *
   * Memory first: the live policy stops allowing a removed PC even when the
   * file cannot be written. That is logged, and the next write (a save, or
   * this on the next start) writes the whole policy again.
   */
  retainHosts(paired: (hostId: HostId) => boolean, why = 'dropping PCs no longer paired'): boolean {
    const gone = new Set([...Object.keys(this.policy.hosts), ...this.policy.rules.map((r) => r.hostId)].filter((h) => !paired(h)));
    if (gone.size === 0) return false;
    const hosts = { ...this.policy.hosts };
    for (const h of gone) delete hosts[h];
    this.policy = {
      ...this.policy,
      hosts,
      rules: this.policy.rules.filter((r) => !gone.has(r.hostId)),
      version: this.policy.version + 1,
    };
    this.persist(why);
    return true;
  }

  private queue: Promise<void> = Promise.resolve();

  private async setNow(raw: unknown, deadline: number): Promise<A2aSpawnPolicySetResult> {
    if (!this.writable) return { ok: false, error: storeUnavailable(SPAWN_POLICY_FILE).message };
    const next = coerceSpawnPolicy(raw);
    if (!next) return { ok: false, error: 'the policy is not valid' };
    if (next.version !== this.policy.version) return CONFLICT;
    // Past the budget nothing is written: the caller has stopped waiting.
    const checked = await withinBudget(this.checkRoots(next.roots, deadline), deadline - this.now());
    if (checked === OVER_BUDGET) return { ok: false, error: 'the folders did not answer in time; nothing was saved' };
    if (!Array.isArray(checked)) return checked;
    // Something else changed the policy while the folders were checked.
    if (next.version !== this.policy.version) return CONFLICT;
    const saved: A2aSpawnPolicyV1 = { ...next, roots: checked, version: this.policy.version + 1 };
    this.write(this.filePath, saved);
    this.scheduleHarden(this.filePath);
    this.policy = saved;
    return { ok: true, policy: structuredClone(saved) };
  }

  /** Each root resolved and checked, in order; the first refusal otherwise. */
  private async checkRoots(input: A2aSpawnPolicyV1['roots'], deadline: number): Promise<A2aSpawnPolicyV1['roots'] | { ok: false; error: string }> {
    const roots: A2aSpawnPolicyV1['roots'] = [];
    for (const root of input) {
      // A save already given up on checks no further folders.
      if (this.now() > deadline) return { ok: false, error: 'the folders did not answer in time; nothing was saved' };
      if (!path.isAbsolute(root.path)) return { ok: false, error: `${root.label}: the folder must be an absolute path` };
      // Bounded like a request's checks: a folder on a mount that does not
      // answer fails this save instead of holding up every later one.
      let real: string;
      let top: string | null;
      try {
        real = await this.checks.run(() => this.realpath(root.path));
        top = await this.checks.run(() => this.repoToplevel(real));
      } catch (err) {
        if (err instanceof CheckTimeout) return { ok: false, error: `${root.label}: the folder did not answer in time` };
        // Slots are held by checks that have not returned; a drive that never
        // answers keeps them until wmux restarts.
        if (err instanceof CheckBusy) return { ok: false, error: 'earlier folder checks have not finished; if this keeps happening, a drive is not answering: restart wmux' };
        return { ok: false, error: `${root.label}: the folder does not exist` };
      }
      if (top === null || !samePath(top, real)) return { ok: false, error: `${root.label}: the folder must be the top level of a git repository` };
      roots.push({ ...root, path: real });
    }
    return roots;
  }

  private persist(why: string): void {
    if (!this.writable) {
      this.log('error', `[a2a-remote] ${SPAWN_POLICY_FILE}: not saved after ${why}: ${storeUnavailable(SPAWN_POLICY_FILE).message}`);
      return;
    }
    try {
      this.write(this.filePath, this.policy);
      this.scheduleHarden(this.filePath);
    } catch (err) {
      this.log('error', `[a2a-remote] ${SPAWN_POLICY_FILE}: not saved after ${why}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const OVER_BUDGET = Symbol('over budget');

/** `p`, or `OVER_BUDGET` once `ms` have passed (at once when `ms` is not positive). */
function withinBudget<T>(p: Promise<T>, ms: number): Promise<T | typeof OVER_BUDGET> {
  if (ms <= 0) {
    p.catch(() => undefined);
    return Promise.resolve(OVER_BUDGET);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const over = new Promise<typeof OVER_BUDGET>((resolve) => {
    timer = setTimeout(() => resolve(OVER_BUDGET), ms);
    timer.unref?.();
  });
  return Promise.race([p, over]).finally(() => clearTimeout(timer));
}

const CONFLICT: A2aSpawnPolicySetResult = { ok: false, conflict: true, error: 'the settings changed in the meantime' };

/**
 * Two realpaths name the same folder. Exact on every platform but Windows,
 * whose file systems are case-insensitive: realpath already returns the
 * on-disk spelling, and a case-sensitive volume (Linux, a case-sensitive
 * APFS) must not let a sibling that differs only by case pass as the same.
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string => path.resolve(p);
  return platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/**
 * `git rev-parse --show-toplevel` in `dir`, realpath'd. Read-only: no hooks
 * run for rev-parse, and fsmonitor is off for this call.
 */
const gitToplevel: RepoToplevel = (dir) => new Promise((resolve) => {
  execFile('git', ['-c', 'core.fsmonitor=false', '-C', dir, 'rev-parse', '--show-toplevel'], {
    env: getExecEnv(), timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024,
  }, (err, stdout) => {
    if (err) return resolve(null);
    const top = String(stdout).trim();
    if (!top) return resolve(null);
    realpathNative(top).then(resolve, () => resolve(null));
  });
});
