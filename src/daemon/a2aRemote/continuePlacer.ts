import fs from 'node:fs';
import path from 'node:path';
import type { HostId } from '../../shared/a2aRemote';
import { CONTINUE_FILES_MAX, type A2aContinuePlaceResult, type A2aContinueStepResult } from '../../shared/a2aContinue';
import { claudeProjectFolder } from '../../shared/claudeProjectFolder';
import { isBytePrefix } from '../continueOnAccount';
import { claudeTranscriptRoot } from '../hooks/transcriptPathGuard';
import { continueStagedFile, continueStagedTranscript, continueStagingDir } from './continueStaging';
import { continueManifestBytes, type ContinueRequestStore } from './continueRequestStore';
import { errMsg } from './storeFile';

/**
 * Places a conversation another PC handed over where Claude Code reads it,
 * once main has made the request's worktree (this PC is B; see
 * `shared/a2aContinue.ts`): from staging to
 * `<config dir>/projects/<claudeProjectFolder(cwd)>/<sessionId>.jsonl` and
 * `<sessionId>/<rel>`, where `cwd` is the folder of the worktree the pane
 * runs in, realpath'd: Claude names the folder after the exact cwd it runs
 * in, and a file under any other folder is not the one it resumes.
 *
 * The config dir is the pane's: `CLAUDE_CONFIG_DIR` when it is absolute, else
 * `~/.claude`. No component below it may be a link. A file already there is
 * taken over only when it is an earlier state of the staged one (its bytes
 * start the staged file's), and only when this PC holds no file of that
 * conversation the manifest lacks; anything else is `diverged`, as is a copy
 * of that conversation in any other project folder (Claude could bind that
 * stale copy, and a resume from that folder would open it). What was
 * there is moved aside into staging (`.prior/`) and put back on any failure,
 * so a failed place leaves the folder as it was. A rename that crosses
 * volumes (EXDEV) is a copy, synced, renamed into place from a temp name
 * beside the target.
 *
 * What each place did is kept in memory per request, so `unplace` takes back
 * exactly that: the placed files go, what was there comes back, and the
 * folders it made go when they are empty again. After a restart nothing is
 * kept: what is placed then stays, and holds every byte of what it replaced.
 */

/** Windows MAX_PATH. */
const WINDOWS_PATH_MAX = 260;
/** The folder in staging that holds what a place moved aside. */
const PRIOR_DIR = '.prior';

export interface ContinuePlacerDeps {
  /** The a2a dir: staging is below it (continueStagingDir). */
  a2aDir: string;
  /** `<wmux home>/worktrees`: a request's worktree is `continue-<continueId>` there. */
  worktreesRoot: string;
  requests: Pick<ContinueRequestStore, 'get'>;
  /** The environment the pane's Claude finds its config dir in (default: this process's). */
  env?: () => Record<string, string | undefined>;
  /** Free bytes on the volume that holds `dir`. */
  freeBytes?: (dir: string) => Promise<number>;
  platform?: NodeJS.Platform;
  /** Test seam: fs.promises.rename. */
  rename?: (from: string, to: string) => Promise<void>;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** What one place did, in order. */
interface Placement {
  /** Folders it made, outermost first. */
  made: string[];
  /** Files that were there: where each was, and where it waits in staging. */
  aside: Array<{ at: string; kept: string }>;
  /** Files it placed. */
  placed: string[];
}

type PlaceFailure = Extract<A2aContinuePlaceResult, { ok: false }>;
type EntryKind = 'none' | 'dir' | 'file' | 'other';

export class ContinuePlacer {
  private readonly deps: ContinuePlacerDeps;
  private readonly platform: NodeJS.Platform;
  private readonly rename: (from: string, to: string) => Promise<void>;
  private readonly placements = new Map<string, Placement>();
  /** Places still running, per request: an unplace meanwhile waits for its own. */
  private readonly placing = new Map<string, Promise<A2aContinuePlaceResult>>();
  private temps = 0;

  constructor(deps: ContinuePlacerDeps) {
    this.deps = deps;
    this.platform = deps.platform ?? process.platform;
    this.rename = deps.rename ?? ((from, to) => fs.promises.rename(from, to));
  }

  /** Place a starting request's conversation for a pane in `cwd`; the placed transcript's path, or why not. */
  async place(hostId: HostId, continueId: string, cwd: string): Promise<A2aContinuePlaceResult> {
    const key = `${hostId}:${continueId}`;
    if (this.placements.has(key) || this.placing.has(key)) return fail('failed', 'this request was placed already');
    const placement: Placement = { made: [], aside: [], placed: [] };
    // Held from the start, so a second call meanwhile is refused.
    this.placements.set(key, placement);
    const running = this.placeOnce(hostId, continueId, cwd, key, placement);
    this.placing.set(key, running);
    try {
      return await running;
    } finally {
      this.placing.delete(key);
    }
  }

  /**
   * Take back what `place` did for this request. A place still running (main
   * stopped waiting for its answer) is let finish first, then taken back
   * whole; one that failed has taken itself back already.
   */
  async unplace(hostId: HostId, continueId: string): Promise<A2aContinueStepResult> {
    const key = `${hostId}:${continueId}`;
    const placement = this.placements.get(key);
    if (!placement) return { ok: false, error: 'nothing was placed for this request in this run' };
    // Taken at once: a forget meanwhile (main reports the start failed when
    // this answer is late) cannot drop what is still to be taken back.
    this.placements.delete(key);
    const running = this.placing.get(key);
    if (running && !(await running).ok) return { ok: true };
    return (await this.undo(placement)) ? { ok: true } : { ok: false, error: 'not everything placed could be taken back' };
  }

  /** The request is decided: what its place did is no longer taken back. */
  forget(hostId: HostId, continueId: string): void {
    this.placements.delete(`${hostId}:${continueId}`);
  }

  /** One place, taken back by itself when it fails. Never rejects. */
  private async placeOnce(hostId: HostId, continueId: string, cwd: string, key: string, placement: Placement): Promise<A2aContinuePlaceResult> {
    let res: A2aContinuePlaceResult;
    try {
      res = await this.placeNow(hostId, continueId, cwd, placement);
    } catch (err) {
      res = fail(errnoCode(err), `the conversation was not placed: ${errMsg(err)}`);
    }
    if (!res.ok) {
      if (!(await this.undo(placement))) this.deps.log('error', `[a2a-remote] continue ${continueId}: a failed place was not fully taken back`);
      if (this.placements.get(key) === placement) this.placements.delete(key);
      this.deps.log('warn', `[a2a-remote] continue ${continueId} from ${hostId}: not placed (${res.code}): ${res.error}`);
    }
    return res;
  }

  private async placeNow(hostId: HostId, continueId: string, cwd: string, placement: Placement): Promise<A2aContinuePlaceResult> {
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'starting' || !rec.manifest) return fail('failed', 'this request is not starting');
    const { sessionId } = rec.request;
    const manifest = rec.manifest;

    // The pane's folder: inside this request's own worktree, as the OS resolves both.
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return fail('failed', 'the folder is not an absolute path');
    const cwdReal = await realpathOrNull(cwd);
    const treeReal = await realpathOrNull(path.join(this.deps.worktreesRoot, `continue-${continueId}`));
    if (cwdReal === null || treeReal === null || !isBelow(path.relative(treeReal, cwdReal)) || (await kindOf(cwdReal)) !== 'dir') {
      return fail('failed', 'the folder is not inside this request\'s worktree');
    }

    const configured = (this.deps.env ?? (() => process.env))()['CLAUDE_CONFIG_DIR'];
    const projectsDir = claudeTranscriptRoot(configured && path.isAbsolute(configured) ? { CLAUDE_CONFIG_DIR: configured } : {});
    const configDir = path.dirname(projectsDir);
    try {
      if (!(await fs.promises.stat(configDir)).isDirectory()) return fail('failed', 'Claude\'s config folder is not a folder');
    } catch {
      return fail('failed', 'Claude\'s config folder does not exist');
    }
    const projectDir = path.join(projectsDir, claudeProjectFolder(cwdReal));
    const transcript = path.join(projectDir, `${sessionId}.jsonl`);
    const folder = path.join(projectDir, sessionId);
    const staging = continueStagingDir(this.deps.a2aDir, hostId, continueId);
    const files = manifest.files.map((f) => ({
      rel: f.rel,
      at: path.join(folder, ...f.rel.split('/')),
      staged: continueStagedFile(staging, sessionId, f.rel),
    }));
    if (this.platform === 'win32' && [transcript, ...files.map((f) => f.at)].some((p) => p.length > WINDOWS_PATH_MAX)) {
      return fail('path-too-long', `a placed file's path exceeds ${WINDOWS_PATH_MAX} characters`);
    }

    // Below the config dir: no link, and only what each name should be.
    const kinds = { projects: await kindOf(projectsDir), project: await kindOf(projectDir), transcript: await kindOf(transcript), folder: await kindOf(folder) };
    if (kinds.projects !== 'none' && kinds.projects !== 'dir') return fail('failed', `${projectsDir} is a link or not a folder`);
    if (kinds.project !== 'none' && kinds.project !== 'dir') return fail('failed', `${projectDir} is a link or not a folder`);
    if (kinds.transcript !== 'none' && kinds.transcript !== 'file') return fail('failed', `${transcript} is a link or not a file`);
    if (kinds.folder !== 'none' && kinds.folder !== 'dir') return fail('failed', `${folder} is a link or not a folder`);
    // A copy in any other project folder could be the one Claude binds or a
    // resume elsewhere opens: one conversation is held in one folder only.
    const elsewhere = kinds.projects === 'dir' ? await heldElsewhere(projectsDir, path.basename(projectDir), sessionId) : null;
    if (elsewhere?.link) return fail('failed', `${elsewhere.link} is a link, so whether it holds this conversation is not known`);
    if (elsewhere?.copy) return fail('diverged', `another project folder holds this conversation: ${elsewhere.copy}`);
    const held = kinds.folder === 'dir' ? await heldFiles(folder) : { files: [], dirs: new Set<string>() };
    if ('link' in held) return fail('failed', `${held.link} is a link or not a file`);
    if ('tooMany' in held) return fail('diverged', 'this PC holds more files of the conversation than any manifest');

    // What is here must be an earlier state of what came, file by file.
    const stagedTranscript = continueStagedTranscript(staging, sessionId);
    if (kinds.transcript === 'file' && !(await isBytePrefix(transcript, stagedTranscript))) {
      return fail('diverged', 'the transcript here holds turns the other PC\'s lacks');
    }
    const byRel = new Map(files.map((f) => [f.rel, f]));
    for (const rel of held.files) {
      const f = byRel.get(rel);
      if (!f) return fail('diverged', 'this PC holds a file of the conversation the other PC\'s lacks');
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      if (!(await isBytePrefix(f.at, f.staged))) return fail('diverged', 'a file of the conversation here differs from the other PC\'s');
    }
    if (files.some((f) => held.dirs.has(f.rel))) return fail('diverged', 'a folder here sits where the other PC has a file');

    const bytes = continueManifestBytes(manifest);
    const free = await (this.deps.freeBytes ?? statfsFree)(configDir);
    if (free < bytes) return fail('no-space', `${bytes} bytes do not fit on the config folder's volume (${free} free)`);

    // Each step is recorded as it lands, so a failure takes back exactly what happened.
    await this.makeDir(projectsDir, placement);
    await this.makeDir(projectDir, placement);
    const prior = path.join(staging, PRIOR_DIR);
    if (kinds.transcript === 'file') await this.moveAside(transcript, path.join(prior, `${sessionId}.jsonl`), placement);
    for (const rel of held.files) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      await this.moveAside(path.join(folder, ...rel.split('/')), path.join(prior, sessionId, ...rel.split('/')), placement);
    }
    await this.move(stagedTranscript, transcript);
    placement.placed.push(transcript);
    for (const f of files) {
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      await this.makeDirs(folder, path.dirname(f.at), placement);
      // eslint-disable-next-line no-await-in-loop -- one file at a time
      await this.move(f.staged, f.at);
      placement.placed.push(f.at);
    }
    this.deps.log('info', `[a2a-remote] continue ${continueId} from ${hostId}: placed ${files.length + 1} file(s)`);
    return { ok: true, transcriptPath: transcript };
  }

  /** Make `dir` when nothing is there, and record it. */
  private async makeDir(dir: string, placement: Placement): Promise<void> {
    if ((await kindOf(dir)) !== 'none') return;
    await fs.promises.mkdir(dir);
    placement.made.push(dir);
  }

  /** Make every missing folder from `base` (which exists) down to `dir`, and record each. */
  private async makeDirs(base: string, dir: string, placement: Placement): Promise<void> {
    await this.makeDir(base, placement);
    const rel = path.relative(base, dir);
    if (!rel) return;
    let at = base;
    for (const part of rel.split(path.sep)) {
      at = path.join(at, part);
      // eslint-disable-next-line no-await-in-loop -- outermost first
      await this.makeDir(at, placement);
    }
  }

  private async moveAside(at: string, kept: string, placement: Placement): Promise<void> {
    await fs.promises.mkdir(path.dirname(kept), { recursive: true });
    await this.move(at, kept);
    placement.aside.push({ at, kept });
  }

  /**
   * A rename; across volumes, a copy synced to disk and renamed into place
   * from a temp name beside `to`, then the source removed.
   */
  private async move(from: string, to: string): Promise<void> {
    try {
      await this.rename(from, to);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    }
    const temp = path.join(path.dirname(to), `.${path.basename(to)}.wmux-${process.pid}-${++this.temps}.tmp`);
    try {
      await fs.promises.copyFile(from, temp, fs.constants.COPYFILE_EXCL);
      const handle = await fs.promises.open(temp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.rename(temp, to);
    } catch (err) {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
    await fs.promises.unlink(from);
  }

  /** Take back a placement, last step first. False when some step could not be. */
  private async undo(placement: Placement): Promise<boolean> {
    let whole = true;
    const step = async (what: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        whole = false;
        this.deps.log('warn', `[a2a-remote] continue: ${what} not taken back: ${errMsg(err)}`);
      }
    };
    for (const at of [...placement.placed].reverse()) {
      // eslint-disable-next-line no-await-in-loop -- last first
      await step(at, () => fs.promises.rm(at, { force: true }));
    }
    for (const { at, kept } of [...placement.aside].reverse()) {
      // eslint-disable-next-line no-await-in-loop -- last first
      await step(at, () => this.move(kept, at));
    }
    for (const dir of [...placement.made].reverse()) {
      // A folder that holds something now (an earlier step not taken back) stays.
      // eslint-disable-next-line no-await-in-loop -- innermost first
      await fs.promises.rmdir(dir).catch(() => undefined);
    }
    placement.made = [];
    placement.aside = [];
    placement.placed = [];
    return whole;
  }
}

function fail(code: PlaceFailure['code'], error: string): PlaceFailure {
  return { ok: false, code, error };
}

/** The code for a write that failed: a full disk or a name too long for it, else `failed`. */
function errnoCode(err: unknown): PlaceFailure['code'] {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOSPC' ? 'no-space' : code === 'ENAMETOOLONG' ? 'path-too-long' : 'failed';
}

/** What is at `p`, its link never followed: a link or anything but a file or folder is `other`. */
async function kindOf(p: string): Promise<EntryKind> {
  try {
    const st = await fs.promises.lstat(p);
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw err;
  }
}

/**
 * The files and folders this PC holds below a conversation's folder, by
 * their path below it ('/'-separated), no link followed. More files than any
 * manifest may hold is `tooMany`; a link or a special file is `link`.
 */
async function heldFiles(folder: string): Promise<{ files: string[]; dirs: Set<string> } | { link: string } | { tooMany: true }> {
  const files: string[] = [];
  const dirs = new Set<string>();
  const walk = async (dir: string, rel: string): Promise<string | null> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirs.add(r);
        // eslint-disable-next-line no-await-in-loop -- depth first
        const bad = await walk(at, r);
        if (bad) return bad;
      } else if (entry.isFile()) {
        files.push(r);
        if (files.length > CONTINUE_FILES_MAX) return '';
      } else {
        return at;
      }
    }
    return null;
  };
  const bad = await walk(folder, '');
  if (bad === '') return { tooMany: true };
  if (bad !== null) return { link: bad };
  return { files, dirs };
}

/**
 * Whether a project folder other than `own` holds conversation `sessionId`:
 * its `<sessionId>.jsonl` or `<sessionId>/`, in any form. Every folder is
 * looked in and no link is followed: a project folder that is a link cannot
 * be looked in without following it, so it is answered as `link`.
 */
async function heldElsewhere(projectsDir: string, own: string, sessionId: string): Promise<{ copy?: string; link?: string }> {
  for (const entry of await fs.promises.readdir(projectsDir, { withFileTypes: true })) {
    if (entry.name === own) continue;
    const at = path.join(projectsDir, entry.name);
    if (entry.isSymbolicLink()) return { link: at };
    if (!entry.isDirectory()) continue;
    for (const name of [`${sessionId}.jsonl`, sessionId]) {
      // eslint-disable-next-line no-await-in-loop -- every folder, one at a time
      if ((await kindOf(path.join(at, name))) !== 'none') return { copy: path.join(at, name) };
    }
  }
  return {};
}

/** `path.relative` that stays at or below its base. */
function isBelow(rel: string): boolean {
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function realpathOrNull(p: string): Promise<string | null> {
  return new Promise((resolve) => fs.realpath.native(p, (err, real) => resolve(err ? null : real)));
}

async function statfsFree(dir: string): Promise<number> {
  const s = await fs.promises.statfs(dir);
  return s.bavail * s.bsize;
}
