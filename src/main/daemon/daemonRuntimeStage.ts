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
    .filter((n) => !/\.(partial|trash)-/.test(n))
    .map((n) => path.join(stageRoot, n, ...SCRIPT))
    .filter((p) => fs.existsSync(p));
}

/** The copy of each build in progress, shared by every spawn that asks while it runs. */
const copies = new Map<string, Promise<void>>();

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
  /** Test seam: copies a folder. fs.promises.cp by default. */
  copy?: (from: string, to: string) => Promise<void>;
}): Promise<StagedDaemon | null> {
  const warn = opts.warn ?? (() => { /* silent */ });
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
        copied = copyStage(opts, staged).finally(() => copies.delete(dir));
        copies.set(dir, copied);
      }
    }
    // The old copies go while this one is made; the prune skips it and any partial copy.
    await Promise.all([copied, pruneStages(opts.stageRoot, path.basename(dir), opts.exeName)]);
    return staged;
  } catch (err) {
    warn(`[launcher] could not copy the daemon runtime out of the install (${err instanceof Error ? err.message : String(err)}); running it from the install`);
    return null;
  }
}

/**
 * Copied under a temporary name and renamed only once the copy holds the
 * files the daemon runs from, so a half copy is never run. A failed copy is
 * removed.
 */
async function copyStage(
  opts: { appDir: string; log?: (msg: string) => void; copy?: (from: string, to: string) => Promise<void> },
  staged: StagedDaemon,
): Promise<void> {
  const partial = `${staged.dir}.partial-${process.pid}`;
  const started = Date.now();
  try {
    await fs.promises.rm(partial, { recursive: true, force: true });
    await (opts.copy ?? ((from, to) => fs.promises.cp(from, to, { recursive: true })))(opts.appDir, partial);
    for (const file of [staged.script, staged.nodePath]) {
      await fs.promises.access(path.join(partial, path.relative(staged.dir, file)));
    }
    await fs.promises.rm(staged.dir, { recursive: true, force: true });
    await fs.promises.rename(partial, staged.dir);
  } catch (err) {
    await fs.promises.rm(partial, { recursive: true, force: true }).catch(() => { /* left for the next spawn */ });
    throw err;
  }
  opts.log?.(`[launcher] copied the daemon runtime to ${staged.dir} in ${Date.now() - started} ms`);
}

/**
 * Removes every copy but `keep`. Windows refuses to delete a running exe, so
 * a copy whose daemon still runs keeps its wmux.exe and is left whole rather
 * than half deleted (renaming its folder would succeed, so that is no test).
 */
async function pruneStages(stageRoot: string, keep: string, exeName: string): Promise<void> {
  let names: string[];
  try { names = await fs.promises.readdir(stageRoot); } catch { return; }
  for (const name of names) {
    if (name === keep || name.includes('.partial-')) continue;
    const full = path.join(stageRoot, name);
    try { await fs.promises.rm(path.join(full, exeName), { force: true }); } catch { continue; }
    try { await fs.promises.rm(full, { recursive: true, force: true }); } catch { /* retried on the next spawn */ }
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
