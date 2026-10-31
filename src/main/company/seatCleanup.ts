// Company seat worktrees after their company: the git and disk reads behind
// seatCleanupRule.ts, the sweep that removes what the rule lets go, and the
// leftovers the task cleanup list shows. The sweep runs when the renderer
// asks (renderer hooks/useCompanySeatSweep.ts: once the saved session is
// loaded, and after a workspace or an archived workspace goes), never from
// the list: opening the list removes nothing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { directoryHold as defaultDirectoryHold, type DirectoryHold } from '../../shared/directoryHold';
import { normalizeWorktreePath } from '../../shared/workTask';
import { git as defaultGit, type GitResult } from '../git/git';
import {
  removeShapedWorktree, shapedWorktreeDir, shapedWorktreeName,
  type PhoneWorktreeRemoveDeps, type PhoneWorktreeRemoveResult,
} from '../worktask/PhoneWorktreeRemoval';
import { sessionHostDir, sessionsStartedIn } from '../worktask/stopSessionsInDir';
import { metaDirForWorktree, type TaskWorktreeManager } from '../worktask/TaskWorktreeManager';
import { workerGitPreflight } from '../worktask/workerGit';
import type { CompanySeatLeftover } from '../worktask/WorktaskScanService';
import { SEAT_STAMP_FILE, type SeatStamp } from './seatLaunch';
import {
  COMPANY_SEAT_BRANCH_PREFIX, COMPANY_SEAT_SHAPE, seatBranchToDelete, seatVerdict,
  type SeatFacts, type SeatGitFacts, type SeatVerdict,
} from './seatCleanupRule';

/** A sweep that waits for the daemon tries again this often, this many times. */
export const SEAT_SWEEP_RETRY_MS = 15_000;
export const SEAT_SWEEP_ATTEMPTS = 20;

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Longest stamp label or company name shown in the list. */
const STAMP_TEXT_MAX = 200;

export interface SeatSession {
  id: string;
  spawnCwd?: string;
  cwd?: string;
  wslTarget?: { distribution?: unknown };
}

export type SeatGit = (args: string[], cwd: string) => Promise<GitResult>;

export interface SeatCleanupDeps {
  /** `<wmux home>/company-worktrees`. */
  root: string;
  /** The daemon's sessions, and whether its start-up recovery is done; null
   *  when it cannot be asked. */
  sessions: () => Promise<{ sessions: SeatSession[]; recoveryDone: boolean } | null>;
  /** The folders the renderer keeps: every live, stashed and archived pane's. */
  keep: readonly string[];
  git?: SeatGit;
  /** Defaults to the shared Windows probe, `free` elsewhere. */
  directoryHold?: (dir: string) => Promise<DirectoryHold>;
  now?: () => number;
  platform?: NodeJS.Platform;
  log?: (message: string) => void;
}

/** A seat folder, the rule's verdict on it, and what its stamp names it by. */
export interface SeatReport {
  dir: string;
  verdict: SeatVerdict;
  label?: string;
  company?: string;
  baseOid?: string;
}

const canonical = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/** Every seat folder under `root`: `<root>/<12 hex>/<name>`, no link on the way. */
export function seatFolders(root: string): string[] {
  const out: string[] = [];
  let hashes: fs.Dirent[];
  try { hashes = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const hash of hashes) {
    if (!hash.isDirectory()) continue;
    let names: fs.Dirent[];
    try { names = fs.readdirSync(path.join(root, hash.name), { withFileTypes: true }); } catch { continue; }
    for (const name of names) {
      if (!name.isDirectory()) continue;
      const dir = shapedWorktreeDir(root, path.join(root, hash.name, name.name), COMPANY_SEAT_SHAPE);
      if (dir) out.push(dir);
    }
  }
  return out;
}

/** The well-formed fields of the stamp beside `dir`; none for a seat made before stamps. */
function readStamp(dir: string): Partial<Pick<SeatStamp, 'label' | 'company' | 'baseOid' | 'createdAt'>> {
  let raw: Partial<SeatStamp> | null;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(metaDirForWorktree(dir), SEAT_STAMP_FILE), 'utf8')) as Partial<SeatStamp> | null;
  } catch {
    return {};
  }
  if (!raw || raw.v !== 1) return {};
  return {
    ...(typeof raw.label === 'string' && raw.label ? { label: raw.label.slice(0, STAMP_TEXT_MAX) } : {}),
    ...(typeof raw.company === 'string' && raw.company ? { company: raw.company.slice(0, STAMP_TEXT_MAX) } : {}),
    ...(typeof raw.baseOid === 'string' && OID.test(raw.baseOid) ? { baseOid: raw.baseOid } : {}),
    ...(typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
  };
}

/** `p` is `dir` (canonical) or inside it. */
function within(p: string, dir: string, platform: NodeJS.Platform): boolean {
  const key = normalizeWorktreePath(canonical(sessionHostDir(p, {}, platform)), platform);
  const root = normalizeWorktreePath(dir, platform);
  return key === root || key.startsWith(root + '/');
}

/** A session started in `dir`, or working there now (OSC 7). */
async function sessionIn(dir: string, sessions: readonly SeatSession[], platform: NodeJS.Platform): Promise<boolean> {
  const started = await sessionsStartedIn([dir], {
    listSessions: async () => sessions.flatMap((s) => (typeof s.cwd === 'string' && s.cwd ? [s, { ...s, spawnCwd: s.cwd }] : [s])),
    platform,
  });
  return started.length > 0;
}

/** What git says about the folder. A read that fails counts as uncommitted
 *  changes: the folder stays, listed, and a person looks at it. */
async function gitFactsOf(dir: string, git: SeatGit, baseOid?: string): Promise<SeatGitFacts> {
  const top = await git(['rev-parse', '--show-toplevel'], dir);
  if (top.code !== 0 || canonical(top.stdout.trim()) !== dir) return { registered: false, locked: false, dirty: false, onlyHere: 0, branchOnlyHere: 0 };
  const lock = await git(['rev-parse', '--git-path', 'locked'], dir);
  // A status read could run a content filter the repository's config names.
  const pre = await workerGitPreflight((args) => git(args, dir), 'read');
  const status = pre.ok ? await git(['status', '--porcelain', '--untracked-files=all'], dir) : null;
  const changes = status?.code === 0 ? status.stdout.trim() : null;
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], dir);
  const ahead = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], dir);
  const onlyHere = Number.parseInt(ahead.stdout.trim(), 10);
  // The seat's own branch, when HEAD has left it: commits there stay with
  // the branch, but the folder is the only place that says so.
  const branch = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${COMPANY_SEAT_BRANCH_PREFIX}${path.basename(dir)}^{commit}`], dir);
  const branchOid = branch.code === 0 ? branch.stdout.trim() : undefined;
  const branchAhead = branchOid && branchOid !== baseOid && branchOid !== head.stdout.trim()
    ? Number.parseInt((await git(['rev-list', '--count', branchOid, '--not', '--remotes'], dir)).stdout.trim(), 10)
    : 0;
  return {
    registered: true,
    locked: lock.code === 0 && fs.existsSync(path.resolve(dir, lock.stdout.trim())),
    dirty: changes !== '' || lock.code !== 0 || ahead.code !== 0 || !Number.isFinite(onlyHere),
    ...(head.code === 0 && OID.test(head.stdout.trim()) ? { head: head.stdout.trim() } : {}),
    onlyHere: Number.isFinite(onlyHere) ? onlyHere : 0,
    // A count that cannot be read keeps the folder.
    branchOnlyHere: Number.isFinite(branchAhead) ? branchAhead : 1,
  };
}

/** The rule's verdict on one seat folder, git read only when the checks before it pass. */
async function reportOf(dir: string, sessions: readonly SeatSession[], deps: SeatCleanupDeps): Promise<SeatReport> {
  const platform = deps.platform ?? process.platform;
  const now = (deps.now ?? Date.now)();
  const stamp = readStamp(dir);
  let born = stamp.createdAt;
  if (born === undefined) {
    // A folder that cannot be read is treated as just made.
    try { born = fs.statSync(dir).mtimeMs; } catch { born = now; }
  }
  const facts: SeatFacts = {
    ageMs: now - born,
    liveSession: await sessionIn(dir, sessions, platform),
    kept: deps.keep.some((p) => within(p, dir, platform)),
    hold: await (deps.directoryHold ?? defaultDirectoryHold)(dir),
    ...(stamp.baseOid ? { baseOid: stamp.baseOid } : {}),
  };
  let verdict = seatVerdict(facts);
  if (verdict.kind === 'needs-git') verdict = seatVerdict({ ...facts, git: await gitFactsOf(dir, deps.git ?? defaultGit, stamp.baseOid) });
  return {
    dir, verdict,
    ...(stamp.label ? { label: stamp.label } : {}),
    ...(stamp.company ? { company: stamp.company } : {}),
    ...(stamp.baseOid ? { baseOid: stamp.baseOid } : {}),
  };
}

/** The repository's main worktree, which git lists first. */
async function mainWorktreeOf(dir: string, git: SeatGit): Promise<string | undefined> {
  const list = await git(['worktree', 'list', '--porcelain'], dir);
  return list.code === 0 ? /^worktree (.+)$/m.exec(list.stdout)?.[1] : undefined;
}

/** Remove one seat folder the rule let go, its meta folder, and then its
 *  branch when seatBranchToDelete allows. */
async function removeSeat(report: SeatReport, deps: SeatCleanupDeps & { worktrees: TaskWorktreeManager }, log: (m: string) => void): Promise<boolean> {
  const { dir } = report;
  const git = deps.git ?? defaultGit;
  const platform = deps.platform ?? process.platform;
  // Seat creation took the repository lock by the name the folder is filed
  // under: the hash of the folder the company was made in, which may be a
  // linked worktree rather than the repository's main one.
  const repoHash = path.basename(path.dirname(dir));
  const repoRoot = await mainWorktreeOf(dir, git);
  if (!repoRoot) {
    log(`kept ${dir}: its repository cannot be read`);
    return false;
  }
  const removed = await deps.worktrees.removeWorktree(repoRoot, repoHash, dir, async () => {
    // Under the repository lock, right before the removal: a pane started
    // in it since keeps it.
    const listed = await deps.sessions();
    if (!listed?.recoveryDone) throw new Error('the daemon cannot list its sessions');
    if (await sessionIn(dir, listed.sessions, platform)) throw new Error('a pane was started in it');
  });
  if (!removed.ok) {
    log(`kept ${dir}: ${removed.error}`);
    return false;
  }
  try { await fs.promises.rm(metaDirForWorktree(dir), { recursive: true, force: true }); } catch { /* a stamp with no worktree is never read */ }
  const folder = path.basename(dir);
  const branch = `${COMPANY_SEAT_BRANCH_PREFIX}${folder}`;
  const at = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], repoRoot);
  const oid = at.code === 0 && OID.test(at.stdout.trim()) ? at.stdout.trim() : undefined;
  const onRemote = oid !== undefined && await git(['rev-list', '--count', oid, '--not', '--remotes'], repoRoot).then((r) => r.code === 0 && r.stdout.trim() === '0');
  const target = seatBranchToDelete({ folder, branch, ...(oid ? { oid } : {}), onRemote, ...(report.baseOid ? { baseOid: report.baseOid } : {}) });
  if (target) {
    const deleted = await deps.worktrees.deleteBranchIfAt(repoRoot, repoHash, target.branch, target.oid);
    if (!deleted.ok) log(`kept the branch ${branch}: ${deleted.error}`);
  }
  log(`removed ${dir}`);
  return true;
}

/**
 * Remove every seat folder the rule lets go. Null when it must run again
 * later: the daemon cannot be asked or has not recovered its sessions yet,
 * so a pane about to come back would not be seen. Nothing to look at (no
 * seat folder) answers at once, without the daemon.
 */
export async function sweepCompanySeats(deps: SeatCleanupDeps & { worktrees: TaskWorktreeManager }): Promise<{ removed: string[] } | null> {
  const log = (m: string): void => deps.log?.(`[company] seat sweep: ${m}`);
  const folders = seatFolders(deps.root);
  if (folders.length === 0) return { removed: [] };
  const listed = await deps.sessions().catch(() => null);
  if (!listed?.recoveryDone) {
    log(`${folders.length} folder(s) wait: ${listed ? 'the daemon is still recovering its sessions' : 'the daemon cannot be asked'}`);
    return null;
  }
  const removed: string[] = [];
  for (const dir of folders) {
    const report = await reportOf(dir, listed.sessions, deps);
    if (report.verdict.kind === 'list') log(`kept ${dir}: ${report.verdict.reason}`);
    if (report.verdict.kind === 'remove' && await removeSeat(report, deps, log)) removed.push(dir);
  }
  return { removed };
}

/**
 * The seat folders the task cleanup list shows: the ones the rule keeps for
 * a person (changes, commits only here, locked, unknown to git). None while
 * the daemon cannot say which panes run where: a seat in use would read as
 * a leftover. Removes nothing.
 */
export async function listCompanySeatLeftovers(deps: SeatCleanupDeps): Promise<CompanySeatLeftover[]> {
  const folders = seatFolders(deps.root);
  if (folders.length === 0) return [];
  const listed = await deps.sessions().catch(() => null);
  if (!listed?.recoveryDone) return [];
  const out: CompanySeatLeftover[] = [];
  for (const dir of folders) {
    const { verdict, label, company } = await reportOf(dir, listed.sessions, deps);
    if (verdict.kind !== 'list') continue;
    out.push({
      worktreePath: dir, reason: verdict.reason,
      ...(verdict.commits !== undefined ? { commits: verdict.commits } : {}),
      ...(label ? { label } : {}),
      ...(company ? { company } : {}),
    });
  }
  return out;
}

/** HEAD is on no branch and holds commits on no remote ref (not the stamp's
 *  base): removing the folder would take them with it. */
async function detachedWorkOnlyHere(dir: string, git: SeatGit): Promise<boolean> {
  // A folder git does not know is the shape check's to refuse ('unregistered').
  const top = await git(['rev-parse', '--show-toplevel'], dir);
  if (top.code !== 0 || canonical(top.stdout.trim()) !== dir) return false;
  if ((await git(['symbolic-ref', '-q', 'HEAD'], dir)).code === 0) return false;
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], dir);
  if (head.code !== 0 || head.stdout.trim() === readStamp(dir).baseOid) return false;
  const ahead = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], dir);
  return ahead.code !== 0 || ahead.stdout.trim() !== '0';
}

/**
 * Remove a listed seat folder on the person's word, by its path (checked
 * against the seat shape), with PhoneWorktreeRemoval's checks: a pane inside
 * refuses, and changes, a lock or a folder git does not know need `force`.
 * So does a HEAD on no branch with commits only here (`unpushed`): no branch
 * keeps them once the folder goes. Its meta folder goes with it. A
 * `company/<folder>` branch it had checked out is reported for a separate,
 * confirmed delete.
 */
export async function removeCompanySeat(worktreePath: string, force: boolean, deps: PhoneWorktreeRemoveDeps & { seatGit?: SeatGit }): Promise<PhoneWorktreeRemoveResult> {
  const dir = shapedWorktreeDir(deps.root, worktreePath, COMPANY_SEAT_SHAPE);
  if (!force && dir && await detachedWorkOnlyHere(dir, deps.seatGit ?? defaultGit)) return { ok: false, reason: 'unpushed' };
  const res = await removeShapedWorktree(worktreePath, force, deps, COMPANY_SEAT_SHAPE);
  if (!res.ok || !dir) return res;
  try { await fs.promises.rm(metaDirForWorktree(dir), { recursive: true, force: true }); } catch { /* a stamp with no worktree is never read */ }
  if (!res.branch || !res.repo) return res;
  // The commit the branch question is about: deleteCompanySeatBranch takes
  // the branch only while it is still there.
  const at = await (deps.seatGit ?? defaultGit)(['rev-parse', '--verify', '--quiet', `refs/heads/${res.branch}^{commit}`], res.repo);
  const oid = at.stdout.trim();
  return at.code === 0 && OID.test(oid) ? { ...res, oid } : { ok: true };
}

/** Delete a removed seat's branch on the person's word: only
 *  `company/<folder>` of that seat folder, only while no worktree has it
 *  checked out, and only at `oid`, the commit removeCompanySeat reported. A
 *  branch that moved since stays. */
export async function deleteCompanySeatBranch(
  root: string, worktreePath: string, repo: string, branch: string, oid: string, git: SeatGit = defaultGit,
): Promise<{ ok: boolean; error?: string }> {
  const folder = shapedWorktreeName(root, worktreePath, COMPANY_SEAT_SHAPE);
  if (!folder || branch !== `${COMPANY_SEAT_BRANCH_PREFIX}${folder}`) return { ok: false, error: "not this seat's branch" };
  if (!OID.test(oid)) return { ok: false, error: 'invalid request' };
  if ((await git(['rev-parse', '--git-dir'], repo)).code !== 0) return { ok: false, error: 'not a repository' };
  // `update-ref -d` does not ask, as `branch -D` does, whether a worktree has it checked out.
  const list = await git(['worktree', 'list', '--porcelain'], repo);
  if (list.code !== 0) return { ok: false, error: list.stderr.trim() || 'the worktrees cannot be read' };
  if (list.stdout.split(/\r?\n/).includes(`branch refs/heads/${branch}`)) return { ok: false, error: 'a worktree has the branch checked out' };
  const deleted = await git(['update-ref', '-d', `refs/heads/${branch}`, oid], repo);
  return deleted.code === 0 ? { ok: true } : { ok: false, error: 'the branch moved since; it was kept' };
}

/** A sweep's answer: `run` numbers the sweep, so requests that waited for
 *  the same one can tell it once. */
export interface SeatSweepRun {
  run: number;
  removed: number;
}

/**
 * One sweep at a time. A request while one runs waits for it; then one more
 * runs, with the latest keep set, for every request that waited. A sweep that
 * has to wait for the daemon tries again `attempts` times, `delayMs` apart.
 */
export function serialSeatSweeps(
  sweep: (keep: readonly string[]) => Promise<{ removed: string[] } | null>,
  opts: { attempts: number; delayMs: number; sleep?: (ms: number) => Promise<void>; log?: (message: string) => void },
): { request(keep: readonly string[]): Promise<SeatSweepRun>; stop(): void } {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  let runs = 0;
  let stopped = false;
  let running: Promise<SeatSweepRun> | null = null;
  let queued: Promise<SeatSweepRun> | null = null;
  let latest: readonly string[] = [];
  // Each attempt reads the newest keep set: a sweep waiting on the daemon
  // must not judge with the folders the window kept minutes ago.
  const attempts = async (): Promise<number> => {
    for (let attempt = 1; !stopped; attempt++) {
      const done = await sweep(latest);
      if (done) return done.removed.length;
      if (attempt >= opts.attempts) break;
      await sleep(opts.delayMs);
    }
    return 0;
  };
  const start = (): Promise<SeatSweepRun> => {
    const run = ++runs;
    const p = attempts().catch((err: unknown) => {
      opts.log?.(`[company] seat sweep failed: ${String(err)}`);
      return 0;
    }).then((removed) => ({ run, removed }));
    running = p;
    void p.then(() => { if (running === p) running = null; });
    return p;
  };
  return {
    request(keep) {
      latest = keep;
      if (!running) return start();
      queued ??= running.then(() => {
        queued = null;
        return start();
      });
      return queued;
    },
    stop() { stopped = true; },
  };
}
