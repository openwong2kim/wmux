/**
 * Runs the Windows daemon from a copy of the installed app outside the
 * install root.
 *
 * Squirrel's Setup.exe, run over an existing install, kills every process
 * whose image path starts with %LOCALAPPDATA%\wmux and deletes the folder
 * ("already exists, burning it to the ground"). A daemon running from
 * app-X.Y.Z\wmux.exe died with it, and so did every pane. A daemon running
 * from ~\.wmux\daemon-runtime\<build>\ is outside that prefix, so a reinstall
 * leaves it and its panes running. (The match is a bare prefix: a copy in
 * %LOCALAPPDATA%\wmux-daemon-runtime was killed too.)
 *
 * The copy keeps the install's layout (wmux.exe, resources\daemon-bundle\
 * index.js), so the launcher's image and script checks hold unchanged.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface StagedDaemon {
  /** The copied daemon entry script. */
  script: string;
  /** The copied wmux.exe, run with ELECTRON_RUN_AS_NODE. */
  nodePath: string;
  /** The copy's root, the daemon's working directory. */
  dir: string;
}

const SCRIPT = ['resources', 'daemon-bundle', 'index.js'];

/** A copy in progress is named `<build>.partial-<pid of the copying process>`. */
const PARTIAL_INFIX = '.partial-';

/** The async fs calls that walk or change the app's tree: the copy, its checks, the rename and the deletes. */
export type TreeFs = Pick<typeof fs, 'promises'>;

/**
 * The fs that walks the copied tree. Electron's own `fs` reads a `.asar` file
 * as an archive, and the tree holds resources\app.asar. In the packaged app,
 * `fs.promises.cp` of the tree throws "Invalid package …\app.asar" and
 * `fs.promises.rm` fails with EBUSY on it. original-fs is Electron's
 * unpatched fs. Plain node (tests) has no such module and no such patch.
 * (`fs.rmSync` of such a tree works even when patched, so the uninstall
 * delete keeps it; the existsSync checks never reach into the archive.)
 */
export function treeFsFor(electronVersion: string | undefined, loadOriginalFs: () => unknown): TreeFs {
  return electronVersion ? (loadOriginalFs() as TreeFs) : fs;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron's built-in module; external in vite.main.config.ts
const defaultTreeFs = treeFsFor(process.versions.electron, () => require('original-fs'));

export function isSquirrelInstall(appDir: string): boolean {
  return fs.existsSync(path.join(appDir, '..', 'Update.exe'));
}

/** One folder per build: a same-version rebuild still gets a fresh copy. */
export function stageKey(version: string, scriptMtimeMs: number): string {
  return `${version}-${Math.floor(scriptMtimeMs)}`;
}

/** The entry scripts of every staged copy (the kill gate must recognise an older build's daemon). */
export function stagedDaemonScripts(stageRoot: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(stageRoot); } catch { return []; }
  return names
    .filter((n) => !n.includes(PARTIAL_INFIX) && !n.includes('.trash-'))
    .map((n) => path.join(stageRoot, n, ...SCRIPT))
    .filter((p) => fs.existsSync(p));
}

/** The copy of each build in progress, shared by every spawn that asks while it runs. */
const copies = new Map<string, Promise<void>>();

/**
 * Longest a spawn waits for the copy. Past it the daemon runs from the
 * install, so a copy that hangs (a stuck drive, a scanner) cannot keep the app
 * without a daemon; the copy goes on, for the next spawn.
 */
const COPY_WAIT_MS = 180_000;

/**
 * Copies `appDir` (the folder holding wmux.exe) to `stageRoot\<key>` unless
 * that copy exists, and removes the other copies no running process holds.
 * Everything that touches the ~450 MB tree is async, so the main thread is
 * free while it runs. Resolves null when the copy cannot be made: the caller
 * runs the daemon from the install, as before.
 */
export async function stageDaemonRuntime(opts: {
  appDir: string;
  exeName: string;
  stageRoot: string;
  version: string;
  warn?: (msg: string) => void;
  log?: (msg: string) => void;
  /** Test seam: copies a folder. The tree fs's promises.cp by default. */
  copy?: (from: string, to: string) => Promise<void>;
  /** Test seam: COPY_WAIT_MS by default. */
  maxWaitMs?: number;
  /** Test seam: the fs for the tree (treeFsFor). original-fs under Electron. */
  treeFs?: TreeFs;
}): Promise<StagedDaemon | null> {
  const treeFs = opts.treeFs ?? defaultTreeFs;
  const warn = opts.warn ?? (() => { /* silent */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const source = path.join(opts.appDir, ...SCRIPT);
    const dir = path.join(opts.stageRoot, stageKey(opts.version, fs.statSync(source).mtimeMs));
    const staged: StagedDaemon = { script: path.join(dir, ...SCRIPT), nodePath: path.join(dir, opts.exeName), dir };
    let copied: Promise<void> = Promise.resolve();
    // A prune that removed wmux.exe but not the folder leaves a copy that cannot run.
    if (!fs.existsSync(staged.script) || !fs.existsSync(staged.nodePath)) {
      const running = copies.get(dir);
      if (running) {
        copied = running;
      } else {
        copied = copyStage(opts, treeFs, staged).finally(() => copies.delete(dir));
        copies.set(dir, copied);
      }
    }
    const waitMs = opts.maxWaitMs ?? COPY_WAIT_MS;
    const tooLong = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still copying after ${waitMs} ms`)), waitMs);
    });
    // The old copies go while this one is made; the prune skips it and this
    // process's own partial copy.
    await Promise.race([Promise.all([copied, pruneStages(treeFs, opts.stageRoot, path.basename(dir), opts.exeName)]), tooLong]);
    return staged;
  } catch (err) {
    warn(`[launcher] could not copy the daemon runtime out of the install (${err instanceof Error ? err.message : String(err)}); running it from the install`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Copied under a temporary name and renamed only once the copy holds the
 * files the daemon runs from, so a half copy is never run. A failed copy is
 * removed.
 */
async function copyStage(
  opts: { appDir: string; log?: (msg: string) => void; copy?: (from: string, to: string) => Promise<void> },
  treeFs: TreeFs,
  staged: StagedDaemon,
): Promise<void> {
  const partial = `${staged.dir}${PARTIAL_INFIX}${process.pid}`;
  const started = Date.now();
  try {
    await treeFs.promises.rm(partial, { recursive: true, force: true });
    await (opts.copy ?? ((from, to) => treeFs.promises.cp(from, to, { recursive: true })))(opts.appDir, partial);
    for (const file of [staged.script, staged.nodePath]) {
      await treeFs.promises.access(path.join(partial, path.relative(staged.dir, file)));
    }
    await treeFs.promises.rm(staged.dir, { recursive: true, force: true });
    await treeFs.promises.rename(partial, staged.dir);
  } catch (err) {
    await treeFs.promises.rm(partial, { recursive: true, force: true }).catch(() => { /* left for the next spawn */ });
    throw err;
  }
  opts.log?.(`[launcher] copied the daemon runtime to ${staged.dir} in ${Date.now() - started} ms`);
}

/**
 * Removes every copy but `keep`. Windows refuses to delete a running exe, so
 * a copy whose daemon still runs keeps its wmux.exe and is left whole rather
 * than half deleted (renaming its folder would succeed, so that is no test).
 *
 * Partial copies: only this process copies into this stage root. The stage
 * root sits in the suffixed wmux dir, and the app holds the single-instance
 * lock for the matching suffixed userData until it exits. So a partial named
 * after any other pid was left by a process that has exited part way (a crash,
 * a kill), and nothing will finish it. It goes here; this process's own
 * partial is left to copyStage.
 */
async function pruneStages(treeFs: TreeFs, stageRoot: string, keep: string, exeName: string): Promise<void> {
  let names: string[];
  try { names = await treeFs.promises.readdir(stageRoot); } catch { return; }
  const ownPartial = `${PARTIAL_INFIX}${process.pid}`;
  for (const name of names) {
    if (name === keep) continue;
    const full = path.join(stageRoot, name);
    if (name.includes(PARTIAL_INFIX)) {
      if (name.endsWith(ownPartial)) continue;
      try { await treeFs.promises.rm(full, { recursive: true, force: true }); } catch { /* retried on the next spawn */ }
      continue;
    }
    try { await treeFs.promises.rm(path.join(full, exeName), { force: true }); } catch { continue; }
    try { await treeFs.promises.rm(full, { recursive: true, force: true }); } catch { /* retried on the next spawn */ }
  }
}

/** Where the staged copies live: beside the user's other wmux data. */
export function daemonStageRootIn(wmuxDir: string): string {
  return path.join(wmuxDir, 'daemon-runtime');
}

/**
 * Uninstall: removes every staged copy, after the caller has stopped the
 * daemons running from them. A copy whose wmux.exe is still held stays, as
 * the prune leaves it; returns whether the whole folder is gone.
 */
export function removeDaemonRuntimeStages(stageRoot: string): boolean {
  try {
    fs.rmSync(stageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* a held copy; nothing else to do at uninstall */ }
  return !fs.existsSync(stageRoot);
}
