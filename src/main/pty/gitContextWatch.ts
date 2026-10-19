import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { watchTarget } from '../../shared/watchTarget';
import { wslPathToHost } from '../../mcp/wslPaths';

/**
 * X1 workspace-context sidebar — git branch tracking via fs.watch.
 *
 * Frozen contract (docs/internal/fable-window-schema-freeze.md §2):
 *   - `gitBranch`/`gitIsWorktree` come from an fs.watch on `<cwd>/.git/HEAD`
 *     (with linked-worktree `gitdir:` indirection). **No polling.**
 *   - Daemon broadcasts `{ type: 'context.git', sessionId,
 *     data: { branch: string | null, isWorktree: boolean, absent?: true } }`.
 *
 * Shared between the daemon (DaemonSessionManager wiring in daemon/index.ts)
 * and local-mode main (localContextWatch) exactly like cwdDetect — both PTY
 * ownership modes must emit the identical shape.
 */

export interface GitContext {
  branch: string | null;
  isWorktree: boolean;
  /**
   * Set only when `branch` is null because the cwd is outside any repository
   * (the walk up reached the root) and a live watch on the cwd will report a
   * `.git` appearing: a known "no branch", which main answers without
   * spawning git. A null branch without it (HEAD unreadable or unparseable,
   * an inconclusive walk, no live watch) is unknown, and main may ask git. Additive: a sender that predates it reads as
   * unknown, which is the old behaviour.
   * Known for the cwd itself only: a `.git` appearing in an ANCESTOR of the
   * cwd (`git init ..`) is not observed (watching every ancestor up to `/`
   * is not affordable), so the branch shows at the next cd or resync()
   * (an app subscribing to the daemon).
   */
  absent?: true;
}

interface ResolvedRepo {
  /** Directory whose HEAD file describes the checked-out branch. */
  gitDir: string;
  isWorktree: boolean;
}

/**
 * Maps a `gitdir:` value that is an absolute POSIX path (`/home/me/repo/.git/
 * worktrees/x`, what git inside WSL writes) to a path this process can open.
 * Only the daemon passes one, for a WSL session whose distro it knows
 * (#2407); without one, gitdirAsHostPath maps the drive mount only.
 */
export type GitDirMapper = (gitdir: string) => string;

/** Walk-up ceiling — a cwd nested deeper than this inside a repo is absurd. */
const MAX_WALK_UP = 24;
/** Re-read debounce after an fs.watch event (HEAD is rewritten via rename). */
const REREAD_DEBOUNCE_MS = 50;
/**
 * #2407 — a WSL distro's share (`\\wsl$\…`, `\\wsl.localhost\…`). Its 9P
 * filesystem raises no change notifications (fs.watch throws EISDIR on every
 * spelling) and every open waits on the distro, so the watcher never touches
 * it synchronously: it resolves asynchronously and polls.
 */
const WSL_SHARE = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]/i;
/** How often a WSL-share watch re-reads HEAD, or looks for a `.git` appearing. */
export const REMOTE_POLL_MS = 2_500;
/** An inconclusive WSL-share walk is retried after 1, 2, 4… rounds, up to this (a minute). */
const REMOTE_REWALK_MAX_ROUNDS = 24;
/**
 * How long one poll round may wait on the share. Past it the pane reads as
 * unknown, the poll backs off, and no further round is queued until the
 * stuck one settles (its late answer is dropped).
 */
export const REMOTE_POLL_DEADLINE_MS = 5_000;
/** The longest a backed-off WSL-share poll waits between rounds. */
export const REMOTE_POLL_MAX_MS = 60_000;
/**
 * How long a WSL-share resolve may take before the session reads as unknown.
 * Sized for a cold start, where every recovered pane resolves at once, one
 * probe at a time: measured on a running distro, a non-repo cwd five levels
 * deep is 13 probes in ~12 ms, so 25 panes take ~0.3 s, and ~1.5 s at the
 * MAX_WALK_UP ceiling. A late answer still applies.
 */
export const REMOTE_RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Resolve the git dir owning `startDir`, following the linked-worktree
 * `.git`-file indirection. Returns null when `startDir` is not inside a
 * repository (or anything on the way is unreadable — best-effort by design;
 * a permission error must never break PTY bookkeeping).
 */
export function resolveRepo(startDir: string): ResolvedRepo | null {
  return resolveRepoState(startDir).repo;
}

/**
 * resolveRepo, also telling whether a null answer is conclusive: the walk
 * reached the filesystem root and every `.git` probe on the way said "no
 * such file", along the cwd as given and along its physical path. A walk
 * that hit MAX_WALK_UP, an unreadable `.git`, a `.git` file without a
 * `gitdir:` line, a directory holding a `HEAD` (a bare repository), or a cwd
 * whose real path cannot be read is inconclusive — git may still find a repo.
 */
export function resolveRepoState(startDir: string, mapGitDir?: GitDirMapper): RepoState {
  const walk = resolveSteps(startDir, mapGitDir);
  let step = walk.next();
  while (!step.done) step = walk.next(answerSync(step.value));
  return step.value;
}

/** resolveRepoState off the event loop, every probe answered by `io` (#2407). */
export async function resolveRepoStateAsync(
  startDir: string,
  io: ProbeIo,
  mapGitDir?: GitDirMapper,
): Promise<RepoState> {
  const walk = resolveSteps(startDir, mapGitDir);
  let step = walk.next();
  while (!step.done) step = walk.next(await io(step.value));
  return step.value;
}

type RepoState = { repo: ResolvedRepo | null; conclusive: boolean };

/**
 * One filesystem question the walk asks. The walk is written once and the
 * caller answers it, synchronously for a local path or through a ProbeIo for
 * a WSL share (#2407):
 *   stat     → 'dir' | 'file' | 'other', 'missing' (ENOENT, ENOTDIR), 'error'
 *   read     → the file's text, or null when it cannot be read
 *   realpath → the physical path, or null when it cannot be resolved
 */
export interface Probe { op: 'stat' | 'read' | 'realpath'; path: string }
export type ProbeAnswer = 'dir' | 'file' | 'other' | 'missing' | 'error' | string | null;
/** `live`, when given, says whether the probe is still wanted (serialProbeIo). */
export type ProbeIo = (probe: Probe, live?: () => boolean) => Promise<ProbeAnswer>;
type Walk = Generator<Probe, RepoState, ProbeAnswer>;

function* resolveSteps(startDir: string, mapGitDir?: GitDirMapper): Walk {
  const lexical = yield* walkUp(startDir, mapGitDir);
  if (lexical.repo || !lexical.conclusive) return lexical;
  // The shell reports its logical $PWD; git walks the physical one. Through
  // a symlink (`~/link` → `/repo/src`) only the latter passes `/repo/.git`.
  const real = yield { op: 'realpath', path: startDir };
  if (real === null) return { repo: null, conclusive: false };
  return real === startDir ? lexical : yield* walkUp(real, mapGitDir);
}

/**
 * A `gitdir:` value as this process can open it (#2407). A worktree added by
 * Linux git on a Windows drive (`/mnt/d/repo` from WSL) records its gitdir
 * as `/mnt/d/repo/.git/worktrees/x`; on win32 `path.resolve` would read that
 * as rooted on the current drive (`D:\mnt\d\…`), a directory that does not
 * exist, so HEAD could not be read. The drive mount is the host folder it
 * names (`D:\repo\.git\worktrees\x`); any other value is kept as given.
 */
function gitdirAsHostPath(value: string): string {
  if (process.platform !== 'win32' || !value.startsWith('/') || value.startsWith('//')) return value;
  const host = wslPathToHost(value, undefined);
  return 'path' in host ? host.path : value;
}

function* walkUp(startDir: string, mapGitDir?: GitDirMapper): Walk {
  let dir = startDir;
  let conclusive = true;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const dotGit = path.join(dir, '.git');
    const st = yield { op: 'stat', path: dotGit };
    if (st === 'dir') {
      return { repo: { gitDir: dotGit, isWorktree: false }, conclusive: true };
    }
    if (st === 'file') {
      // Linked worktree: `.git` is a file `gitdir: <abs-or-rel path>`
      const content = yield { op: 'read', path: dotGit };
      const m = content?.match(/^gitdir:\s*(.+)\s*$/m);
      if (m) {
        const gitdir = m[1].trim();
        const target = path.resolve(dir, mapGitDir && gitdir.startsWith('/') ? mapGitDir(gitdir) : gitdirAsHostPath(gitdir));
        // A submodule also uses the gitdir file (…/.git/modules/…); only
        // `…/worktrees/<name>` is a linked worktree. Either way the HEAD
        // at the target describes this checkout.
        const isWorktree = /[\\/]worktrees[\\/]/.test(target);
        return { repo: { gitDir: target, isWorktree }, conclusive: true };
      }
      if (content !== null) return { repo: null, conclusive: false };
      // Unreadable: might be hiding a repo.
      conclusive = false;
    }
    // ENOENT and friends — keep walking up. Only "no such file" is an
    // answer; anything else (EACCES, EPERM) might be hiding a repo.
    if (st === 'error') conclusive = false;
    // A bare repository has no `.git`, only `HEAD` and friends at its top:
    // git finds it, this walk does not, so a `HEAD` here makes it no answer.
    if (conclusive && (yield { op: 'stat', path: path.join(dir, 'HEAD') }) !== 'missing') conclusive = false;
    const parent = path.dirname(dir);
    if (parent === dir) return { repo: null, conclusive };
    dir = parent;
  }
  return { repo: null, conclusive: false };
}

function answerSync(probe: Probe): ProbeAnswer {
  try {
    if (probe.op === 'read') return fs.readFileSync(probe.path, 'utf8');
    if (probe.op === 'realpath') return fs.realpathSync.native(probe.path);
    return statKind(fs.statSync(probe.path));
  } catch (err) {
    return probe.op === 'stat' ? statFailure(err) : null;
  }
}

async function answerAsync(probe: Probe): Promise<ProbeAnswer> {
  try {
    if (probe.op === 'read') return await fs.promises.readFile(probe.path, 'utf8');
    if (probe.op === 'realpath') return await fs.promises.realpath(probe.path);
    return statKind(await fs.promises.stat(probe.path));
  } catch (err) {
    return probe.op === 'stat' ? statFailure(err) : null;
  }
}

function statKind(st: fs.Stats): ProbeAnswer {
  return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
}

function statFailure(err: unknown): ProbeAnswer {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error';
}

/**
 * One probe at a time through `answer` (fs.promises by default). A probe on a
 * WSL share waits on the distro's 9P server, which can be booting or wedged;
 * serialised, a stuck probe parks one libuv threadpool thread (of four)
 * instead of every one the daemon's own fs work needs. `live` is asked when
 * the probe's turn comes, not when it was queued: a probe for a pane that
 * moved on or closed meanwhile is dropped without any IO.
 */
export function serialProbeIo(answer: ProbeIo = answerAsync): ProbeIo {
  let tail: Promise<unknown> = Promise.resolve();
  return (probe, live) => {
    const run = tail.then(() => (live && !live() ? Promise.reject(new Error('probe no longer wanted')) : answer(probe)));
    tail = run.catch(() => undefined);
    return run;
  };
}

/** The distro whose share `p` is on, lower-cased; '' for any other path. */
function shareOf(p: string): string {
  return /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)/i.exec(p)?.[1].toLowerCase() ?? '';
}

/** Settles with `work`'s value, or `undefined` once `ms` pass first or `work` fails. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work.catch(() => undefined), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `dir` holds a `.git` or a `HEAD` entry; true when it cannot tell. */
function hasGitEntry(dir: string): boolean {
  try {
    return !!fs.statSync(path.join(dir, '.git'), { throwIfNoEntry: false })
      || !!fs.statSync(path.join(dir, 'HEAD'), { throwIfNoEntry: false });
  } catch {
    return true;
  }
}

/** Parse a HEAD file's content into a branch label (short SHA when detached). */
export function parseHead(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const ref = trimmed.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (ref) return ref[1];
  // Detached HEAD — show the short commit id.
  if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed.slice(0, 8);
  // Other refs (refs/tags/… via symbolic-ref) — last path segment.
  const otherRef = trimmed.match(/^ref:\s*refs\/(.+)$/);
  if (otherRef) return otherRef[1].split('/').pop() ?? null;
  return null;
}

/** Read the current branch out of a resolved repo. Best-effort. */
export function readGitContext(repo: ResolvedRepo): GitContext {
  try {
    const content = fs.readFileSync(path.join(repo.gitDir, 'HEAD'), 'utf8');
    return { branch: parseHead(content), isWorktree: repo.isWorktree };
  } catch {
    return { branch: null, isWorktree: repo.isWorktree };
  }
}

async function readGitContextAsync(repo: ResolvedRepo, io: ProbeIo): Promise<GitContext> {
  const content = await io({ op: 'read', path: path.join(repo.gitDir, 'HEAD') });
  return { branch: content === null ? null : parseHead(content), isWorktree: repo.isWorktree };
}

/** Listener shape `fs.watch` invokes: `(eventType, filename)`. */
export type GitWatchListener = (eventType: string, filename: string | Buffer | null) => void;

/** The subset of `fs.FSWatcher` this module uses. `fs.FSWatcher` satisfies it. */
export interface GitWatchHandle {
  close(): void;
  on(event: 'error', listener: () => void): unknown;
}

/**
 * Factory that arms a watch on `target`. Defaults to `fs.watch`; tests inject a
 * fake so watcher logic (filename filtering, debounce, re-resolve) is asserted
 * without depending on platform FSEvents/inotify delivery latency.
 */
export type GitWatchFactory = (target: string, listener: GitWatchListener) => GitWatchHandle;

const defaultWatchFactory: GitWatchFactory = (target, listener) => fs.watch(target, listener);

interface SessionWatch {
  cwd: string;
  mapGitDir?: GitDirMapper;
  repo: ResolvedRepo | null;
  /** With `repo` null: the search reached the root (see resolveRepoState). */
  conclusive: boolean;
  /** On a WSL share: resolved asynchronously, `watcher` is a poll (#2407). */
  remote: boolean;
  /** A remote repo's HEAD as last read; the poll keeps it current. */
  head?: GitContext;
  /** A remote poll round missed its deadline: the answer is unknown. */
  stalled?: boolean;
  watcher: GitWatchHandle | null;
  debounce: NodeJS.Timeout | null;
  /** Last emitted value, JSON-encoded, to suppress no-op re-emits. */
  lastEmitted: string | null;
}

/** The latest WSL-share cwd a session asked for, until its walk applies. */
interface RemoteTarget {
  cwd: string;
  mapGitDir?: GitDirMapper;
  /** Reads the session as unknown if the walk outlasts REMOTE_RESOLVE_TIMEOUT_MS. */
  timer: NodeJS.Timeout;
}

/**
 * Tracks the git branch per PTY session with fs.watch (no polling).
 *
 * Events:
 *  - 'git' → { sessionId: string, branch: string | null, isWorktree: boolean, absent?: true }
 *
 * `update(sessionId, cwd)` is called on session create and on every cwd
 * change (OSC 7 / prompt scrape). When the cwd is outside any repository the
 * watcher arms on the cwd itself so a later `git init` is picked up without
 * polling. A cwd on a WSL share is the exception (see WSL_SHARE): it is
 * resolved asynchronously and polled every REMOTE_POLL_MS, through one probe
 * queue per distro so a wedged distro holds up only its own panes.
 */
export class GitContextWatcher extends EventEmitter {
  private sessions = new Map<string, SessionWatch>();
  private readonly watchFactory: GitWatchFactory;
  private readonly isRemote: (cwd: string) => boolean;
  private readonly answer: ProbeIo;
  private readonly queues = new Map<string, ProbeIo>();
  /** The WSL-share cwd each session waits on; a superseded one is dropped. */
  private pending = new Map<string, RemoteTarget>();
  /** Sessions with a walk running: at most one each, which takes the latest target. */
  private resolving = new Set<string>();
  private outstanding = 0;

  /**
   * @param watchFactory Test seam only. Omitted in production, where the
   *   watcher arms `fs.watch` exactly as before.
   * @param remote Test seam only: which cwds take the WSL-share path, and
   *   what answers each probe (queued per distro by the watcher).
   */
  constructor(
    watchFactory: GitWatchFactory = defaultWatchFactory,
    remote: { isRemote?: (cwd: string) => boolean; io?: ProbeIo } = {},
  ) {
    super();
    this.watchFactory = watchFactory;
    this.isRemote = remote.isRemote ?? ((cwd) => WSL_SHARE.test(cwd));
    this.answer = remote.io ?? answerAsync;
  }

  /** @param mapGitDir See GitDirMapper; kept for every later re-resolve. */
  update(sessionId: string, cwd: string, mapGitDir?: GitDirMapper): void {
    if (this.isRemote(cwd)) {
      this.updateRemote(sessionId, cwd, mapGitDir);
      return;
    }
    // A local answer supersedes a WSL-share resolve still in flight.
    this.dropPending(sessionId);
    const state = resolveRepoState(cwd, mapGitDir);
    if (state.repo && this.isRemote(state.repo.gitDir)) {
      // A worktree on a host drive whose repository lives in a distro: the
      // walk was local, but its HEAD is on the share. Read it the share's
      // way, timeout and stale guard included.
      this.updateRemote(sessionId, cwd, mapGitDir);
      return;
    }
    this.apply(sessionId, cwd, mapGitDir, state, 'local');
  }

  /**
   * Resolve a WSL-share cwd off the event loop. Requests coalesce: the
   * session's target is replaced, and its one walk (resolveRemote) takes the
   * latest when it next looks, so a burst of cds queues no more than one
   * probe. A walk slower than REMOTE_RESOLVE_TIMEOUT_MS reads as unknown
   * until it lands.
   */
  private updateRemote(sessionId: string, cwd: string, mapGitDir?: GitDirMapper): void {
    this.dropPending(sessionId);
    const target: RemoteTarget = {
      cwd,
      mapGitDir,
      timer: setTimeout(() => {
        if (this.pending.get(sessionId) !== target) return;
        // A live poll on this same cwd (a resync or `git init` re-resolve) is
        // still the best answer there is; keep it.
        const live = this.sessions.get(sessionId);
        if (live && live.cwd === cwd && live.watcher) return;
        this.apply(sessionId, cwd, mapGitDir, { repo: null, conclusive: false }, 'timeout');
      }, REMOTE_RESOLVE_TIMEOUT_MS),
    };
    target.timer.unref?.();
    this.pending.set(sessionId, target);
    // Another directory: stop the old poll now, so it cannot re-resolve the
    // old cwd over this one.
    const existing = this.sessions.get(sessionId);
    if (existing && existing.cwd !== cwd) this.teardown(existing);
    if (!this.resolving.has(sessionId)) void this.resolveRemote(sessionId);
  }

  /** The session's one walk: resolves its pending target until none is left. */
  private async resolveRemote(sessionId: string): Promise<void> {
    this.resolving.add(sessionId);
    try {
      for (let target = this.pending.get(sessionId); target; target = this.pending.get(sessionId)) {
        const wanted = target;
        const live = () => this.pending.get(sessionId) === wanted;
        const io: ProbeIo = (probe) => this.probe(probe, live);
        let state: RepoState = { repo: null, conclusive: false };
        let head: GitContext | undefined;
        try {
          state = await resolveRepoStateAsync(wanted.cwd, io, wanted.mapGitDir);
          if (state.repo) head = await readGitContextAsync(state.repo, io);
        } catch { /* superseded, or an answer that throws: unknown */ }
        // Superseded or removed meanwhile: go on with the latest, if any.
        if (!live()) continue;
        this.dropPending(sessionId);
        this.apply(sessionId, wanted.cwd, wanted.mapGitDir, state, 'remote', head);
        return;
      }
    } finally {
      this.resolving.delete(sessionId);
    }
  }

  /** Through the share's own queue, so one wedged distro holds up only its panes. */
  private probe(probe: Probe, live: () => boolean): Promise<ProbeAnswer> {
    const share = shareOf(probe.path);
    let queue = this.queues.get(share);
    if (!queue) this.queues.set(share, queue = serialProbeIo(this.answer));
    this.outstanding++;
    const run = queue(probe, live);
    const done = () => { this.outstanding--; };
    run.then(done, done);
    return run;
  }

  private dropPending(sessionId: string): void {
    const target = this.pending.get(sessionId);
    if (target) clearTimeout(target.timer);
    this.pending.delete(sessionId);
  }

  /**
   * Make `state` the session's watch and emit its answer. `mode`: 'local'
   * arms fs.watch, 'remote' a poll, 'timeout' nothing (the late answer
   * replaces it). `head` is HEAD already read for a remote repo.
   */
  private apply(
    sessionId: string,
    cwd: string,
    mapGitDir: GitDirMapper | undefined,
    { repo, conclusive }: RepoState,
    mode: 'local' | 'remote' | 'timeout',
    head?: GitContext,
  ): void {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.cwd === cwd && existing.repo?.gitDir === repo?.gitDir
      && existing.conclusive === conclusive && existing.watcher) {
      if (head) this.readAndEmit(sessionId, existing, head);
      return; // same checkout — keep the live watcher.
    }
    if (existing) this.teardown(existing);

    const watch: SessionWatch = {
      cwd,
      mapGitDir,
      repo,
      conclusive,
      remote: mode !== 'local',
      watcher: null,
      debounce: null,
      lastEmitted: existing?.lastEmitted ?? null,
    };
    this.sessions.set(sessionId, watch);
    if (mode === 'local') {
      this.arm(sessionId, watch);
      // A `.git` (or bare `HEAD`) created between the walk and the watch going
      // live raised no event: look once more before calling the cwd absent.
      if (!repo && watch.watcher && watch.conclusive && hasGitEntry(cwd)) watch.conclusive = false;
    } else if (mode === 'remote') {
      watch.watcher = this.poll(sessionId, watch);
    }
    this.readAndEmit(sessionId, watch, head);
  }

  /**
   * Re-emit every session's current answer, unchanged or not. The daemon
   * outlives the app, so a subscribing app starts with no git state, and one
   * that lost its subscription missed whatever changed meanwhile; without
   * this its poll would keep a stale "no branch". A session outside a repo
   * is resolved again (an ancestor's `.git` is not watched); one inside a
   * repo only has its HEAD re-read (a remote one re-sends what its poll read).
   */
  resync(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      const watch = this.sessions.get(sessionId);
      if (!watch) continue;
      watch.lastEmitted = null;
      // Moving to another cwd on a WSL share: that resolve emits when it
      // lands; re-resolving the old cwd here would supersede it.
      const moving = this.pending.get(sessionId);
      if (moving && moving.cwd !== watch.cwd) continue;
      if (!watch.repo) this.update(sessionId, watch.cwd, watch.mapGitDir);
      // update() emitted already if it found a repo; otherwise emit here.
      const current = this.sessions.get(sessionId);
      if (current && current.lastEmitted === null) this.readAndEmit(sessionId, current);
    }
  }

  remove(sessionId: string): void {
    this.dropPending(sessionId);
    const watch = this.sessions.get(sessionId);
    if (!watch) return;
    this.teardown(watch);
    this.sessions.delete(sessionId);
  }

  dispose(): void {
    for (const sessionId of [...this.pending.keys()]) this.dropPending(sessionId);
    for (const watch of this.sessions.values()) this.teardown(watch);
    this.sessions.clear();
    this.removeAllListeners();
  }

  /** Current session count — observability/testing only. */
  get size(): number {
    return this.sessions.size;
  }

  /** Share probes queued or running — observability/testing only. */
  get probesOutstanding(): number {
    return this.outstanding;
  }

  private teardown(watch: SessionWatch): void {
    if (watch.debounce) { clearTimeout(watch.debounce); watch.debounce = null; }
    try { watch.watcher?.close(); } catch { /* already closed */ }
    watch.watcher = null;
  }

  /**
   * Arm the fs.watch. Inside a repo, watch the directory that holds HEAD —
   * git rewrites HEAD atomically via rename, and watching the file directly
   * loses tracking after the rename on some platforms. Outside a repo, watch
   * the cwd itself so a `.git` appearing (git init/clone into cwd) triggers a
   * re-resolve.
   */
  private arm(sessionId: string, watch: SessionWatch): void {
    // Long spelling: libuv 1.52 mishandles an 8.3 short dir (watchTarget, #984).
    const target = watchTarget(watch.repo ? watch.repo.gitDir : watch.cwd);
    try {
      watch.watcher = this.watchFactory(target, (_event, filename) => {
        if (watch.repo) {
          // Only HEAD transitions matter (HEAD.lock → HEAD rename included).
          if (filename && !/^HEAD(\.lock)?$/i.test(String(filename))) return;
        } else if (filename && !/^(\.git|HEAD)$/.test(String(filename))) {
          // `.git` for init/clone; `HEAD` for a bare clone into the cwd,
          // which turns a known "not a repo" into unknown.
          return;
        }
        if (watch.debounce) clearTimeout(watch.debounce);
        watch.debounce = setTimeout(() => {
          watch.debounce = null;
          if (!watch.repo) {
            // `.git` may have just appeared — re-resolve and re-arm.
            this.update(sessionId, watch.cwd, watch.mapGitDir);
            return;
          }
          this.readAndEmit(sessionId, watch);
        }, REREAD_DEBOUNCE_MS);
        watch.debounce.unref?.();
      });
      watch.watcher.on('error', () => {
        // Directory vanished (worktree pruned, repo deleted) — drop the
        // watcher; the next cwd update re-arms.
        this.teardown(watch);
        // Outside a repo, "no branch" was known only while the watch could
        // see a `.git` appear; without it the answer is unknown again.
        if (!watch.repo && this.sessions.get(sessionId) === watch) this.readAndEmit(sessionId, watch);
      });
    } catch {
      // Watch target unreadable — degrade to "value at update time" only.
      watch.watcher = null;
    }
  }

  /**
   * The watch for a WSL share: one async probe round every REMOTE_POLL_MS.
   * Inside a repo, re-read HEAD; outside, look at the cwd's `.git` (and the
   * text of a `.git` file) and `HEAD`, and re-resolve when any of it changes
   * (a `git init`, a clone, a gitdir line written in place); an inconclusive
   * walk is also retried, backing off to once a minute. A round that misses
   * REMOTE_POLL_DEADLINE_MS reads as unknown and doubles the interval (up to
   * REMOTE_POLL_MAX_MS); no new round is queued while it is still out, and
   * its late answer is dropped. No git process is spawned.
   */
  private poll(sessionId: string, watch: SessionWatch): GitWatchHandle {
    let timer: NodeJS.Timeout | null = null;
    let closed = false;
    let interval = REMOTE_POLL_MS;
    /** The last round's probes are still queued or running. */
    let out = false;
    // A conclusive walk saw neither entry in the cwd; otherwise the first
    // round only records what is there.
    let entries: string | null = watch.conclusive ? 'missing missing ' : null;
    let walkEvery = 1;
    let roundsSinceWalk = 0;
    const io: ProbeIo = (probe) => this.probe(probe, () => !closed);
    const look = async (): Promise<{ head: GitContext } | { seen: string }> => {
      if (watch.repo) return { head: await readGitContextAsync(watch.repo, io) };
      const gitEntry = await io({ op: 'stat', path: path.join(watch.cwd, '.git') });
      const headEntry = await io({ op: 'stat', path: path.join(watch.cwd, 'HEAD') });
      // A `.git` file without a `gitdir:` line can be fixed in place.
      const gitText = gitEntry === 'file' ? await io({ op: 'read', path: path.join(watch.cwd, '.git') }) : '';
      return { seen: `${gitEntry} ${headEntry} ${gitText}` };
    };
    const tick = async () => {
      timer = null;
      if (out) {
        // Still waiting on the distro: queue nothing more behind it.
        interval = Math.min(interval * 2, REMOTE_POLL_MAX_MS);
        schedule();
        return;
      }
      out = true;
      const round = look().finally(() => { out = false; });
      const result = await within(round, REMOTE_POLL_DEADLINE_MS);
      if (closed) return;
      if (!result) {
        interval = Math.min(interval * 2, REMOTE_POLL_MAX_MS);
        watch.stalled = true;
        this.readAndEmit(sessionId, watch);
      } else {
        interval = REMOTE_POLL_MS;
        watch.stalled = false;
        if ('head' in result) {
          this.readAndEmit(sessionId, watch, result.head);
        } else {
          let again = entries !== null && result.seen !== entries;
          entries = result.seen;
          // An inconclusive walk may have met a passing error (a distro still
          // booting) anywhere up the tree: walk again, backing off.
          if (!watch.conclusive && ++roundsSinceWalk >= walkEvery) {
            roundsSinceWalk = 0;
            walkEvery = Math.min(walkEvery * 2, REMOTE_REWALK_MAX_ROUNDS);
            again = true;
          }
          this.readAndEmit(sessionId, watch);
          if (again) this.update(sessionId, watch.cwd, watch.mapGitDir);
        }
      }
      if (!closed) schedule();
    };
    const schedule = () => {
      timer = setTimeout(() => { void tick().catch(() => { if (!closed) schedule(); }); }, interval);
      timer.unref?.();
    };
    schedule();
    return {
      close() { closed = true; if (timer) clearTimeout(timer); timer = null; },
      on() { return this; },
    };
  }

  /** `head`: HEAD just read for a remote repo, kept as its current answer. */
  private readAndEmit(sessionId: string, watch: SessionWatch, head?: GitContext): void {
    if (head) watch.head = head;
    const ctx: GitContext = watch.stalled
      ? { branch: null, isWorktree: watch.repo?.isWorktree ?? false }
      : watch.repo
        ? watch.remote ? watch.head ?? { branch: null, isWorktree: watch.repo.isWorktree } : readGitContext(watch.repo)
        : watch.watcher && watch.conclusive
          ? { branch: null, isWorktree: false, absent: true }
          : { branch: null, isWorktree: false };
    const encoded = JSON.stringify(ctx);
    if (encoded === watch.lastEmitted) return;
    watch.lastEmitted = encoded;
    this.emit('git', { sessionId, ...ctx });
  }
}

