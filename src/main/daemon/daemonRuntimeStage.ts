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

/**
 * Copies `appDir` (the folder holding wmux.exe) to `stageRoot\<key>` unless
 * that copy exists, then removes the other copies no running process holds.
 * Returns null when the copy cannot be made: the caller runs the daemon from
 * the install, as before.
 */
export function stageDaemonRuntime(opts: {
  appDir: string;
  exeName: string;
  stageRoot: string;
  version: string;
  warn?: (msg: string) => void;
}): StagedDaemon | null {
  const warn = opts.warn ?? (() => { /* silent */ });
  let partial: string | null = null;
  try {
    const source = path.join(opts.appDir, ...SCRIPT);
    const dir = path.join(opts.stageRoot, stageKey(opts.version, fs.statSync(source).mtimeMs));
    const staged = (): StagedDaemon => ({ script: path.join(dir, ...SCRIPT), nodePath: path.join(dir, opts.exeName), dir });
    // A prune that removed wmux.exe but not the folder leaves a copy that cannot run.
    if (!fs.existsSync(staged().script) || !fs.existsSync(staged().nodePath)) {
      // Copied under a temporary name and renamed, so a half copy is never run.
      partial = `${dir}.partial-${process.pid}`;
      fs.rmSync(partial, { recursive: true, force: true });
      fs.cpSync(opts.appDir, partial, { recursive: true });
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(partial, dir);
      partial = null;
    }
    pruneStages(opts.stageRoot, path.basename(dir), opts.exeName);
    return staged();
  } catch (err) {
    if (partial) { try { fs.rmSync(partial, { recursive: true, force: true }); } catch { /* left for the next spawn */ } }
    warn(`[launcher] could not copy the daemon runtime out of the install (${err instanceof Error ? err.message : String(err)}); running it from the install`);
    return null;
  }
}

/**
 * Removes every copy but `keep`. Windows refuses to delete a running exe, so
 * a copy whose daemon still runs keeps its wmux.exe and is left whole rather
 * than half deleted (renaming its folder would succeed, so that is no test).
 */
function pruneStages(stageRoot: string, keep: string, exeName: string): void {
  for (const name of fs.readdirSync(stageRoot)) {
    if (name === keep || name.includes('.partial-')) continue;
    const full = path.join(stageRoot, name);
    try { fs.rmSync(path.join(full, exeName), { force: true }); } catch { continue; }
    try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* retried on the next spawn */ }
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
