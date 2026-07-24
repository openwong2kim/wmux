// Identity-derived paths for the PACKAGED app, shared by the harness scripts.
//
// electron-forge names its output directory `<name>-<platform>-<arch>` and the
// binary after `packagerConfig.executableName` — both the `fmux` slug for this
// fork, where upstream shipped `wmux`, so a harness that spells out
// `out/wmux-win32-x64/wmux.exe` finds nothing after a fork build. The same
// rename runs through the app's runtime namespace (pipe names, `~/.fmux`, the
// Electron userData dir), which an isolated bench instance has to reconstruct
// in order to find the daemon it just booted.
//
// Two names, deliberately: the ARTIFACT namespace is the slug (spaceless — the
// out dir and the .app bundle are paths that shell scripts split on), while the
// app's own NAME stays the display name and is what userData is keyed by
// (app.setName in src/main/index.ts pins it). Both come from package.json, so
// the identity lives at the packaging boundary and no script carries a product
// literal. The runtime path shapes mirror src/shared/constants.ts; keep the two
// in sync.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (scripts/helpers/ → ../..). */
export const REPO_ROOT = path.resolve(HELPERS_DIR, '..', '..');

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

/** Display name — app.getName(), and therefore the userData dir. */
export const PRODUCT_NAME = pkg.productName ?? pkg.name;

/**
 * Slug — the binary name, the `<slug>-<platform>-<arch>` out-dir prefix, and
 * the macOS bundle directory. forge.config.ts reads the same field for
 * `packagerConfig.name`/`executableName`.
 */
export const EXECUTABLE_NAME = pkg.executableName ?? pkg.name;

/**
 * Image-name substrings that identify one of OUR processes in a Win32_Process
 * snapshot. The fork's binary comes first; `wmux` stays so the same harness
 * still classifies an upstream-named build correctly (the process-tree walk is
 * rooted at our own pid, so a stray match cannot pull in a foreign process).
 */
export const APP_IMAGE_BASENAMES = [...new Set([EXECUTABLE_NAME.toLowerCase(), 'wmux'])];

/** True when a Win32_Process image name looks like our app's binary. */
export function isAppImageName(name) {
  const n = String(name ?? '').toLowerCase();
  return APP_IMAGE_BASENAMES.some((base) => n.includes(base));
}

/** `out/<slug>-<platform>-<arch>` — electron-packager's output dir. */
export function packagedAppDir({ platform = process.platform, arch = process.arch, outDir } = {}) {
  const root = outDir ?? path.join(REPO_ROOT, 'out');
  return path.join(root, `${EXECUTABLE_NAME}-${platform}-${arch}`);
}

/** The packaged binary inside packagedAppDir(). */
export function packagedAppExe(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const dir = packagedAppDir({ ...opts, platform });
  if (platform === 'darwin') {
    // The bundle DIRECTORY is the slug; the display name lives in Info.plist.
    return path.join(dir, `${EXECUTABLE_NAME}.app`, 'Contents', 'MacOS', EXECUTABLE_NAME);
  }
  if (platform === 'win32') return path.join(dir, `${EXECUTABLE_NAME}.exe`);
  return path.join(dir, EXECUTABLE_NAME);
}

/**
 * Lowercased file:// prefix of the packaged build dir — the identity guard
 * harnesses use to reject a renderer page belonging to some OTHER app instance
 * that happened to grab the CDP port they connected to.
 */
export function packagedAppUrlPrefix(opts = {}) {
  return pathToFileURL(packagedAppDir(opts)).href.toLowerCase();
}

// ─── Runtime namespace (mirrors src/shared/constants.ts) ───────────────────
// `suffix` is the instance-isolation suffix the app reads from
// WMUX_DATA_SUFFIX; pass '' for a production-shaped instance.

/** Main RPC pipe: `\\.\pipe\<exe><suffix>-<username>`. */
export function mainPipeName(suffix, username) {
  return `\\\\.\\pipe\\${EXECUTABLE_NAME}${suffix}-${username}`;
}

/** Daemon control pipe (the `daemon-pipe` hint file wins when present). */
export function daemonPipeName(suffix, username) {
  return `\\\\.\\pipe\\${EXECUTABLE_NAME}-daemon${suffix}-${username}`;
}

/** `<home>/.<exe><suffix>` — daemon.pid, daemon-pipe, config.json live here. */
export function appHomeDir(home, suffix) {
  return path.join(home, `.${EXECUTABLE_NAME}${suffix}`);
}

/** `<home>/.<exe><suffix>-auth-token` — the main pipe's token file. */
export function authTokenPath(home, suffix) {
  return path.join(home, `.${EXECUTABLE_NAME}${suffix}-auth-token`);
}

/**
 * Candidate daemon-token paths, most likely first. The daemon's token path is
 * deliberately NOT suffix-aware (`~/.<exe>/daemon-auth-token`); the suffixed
 * directory is probed as a fallback in case that ever changes.
 */
export function daemonAuthTokenPaths(home, suffix) {
  return [
    path.join(home, `.${EXECUTABLE_NAME}`, 'daemon-auth-token'),
    path.join(appHomeDir(home, suffix), 'daemon-auth-token'),
  ];
}

/**
 * Electron userData dir: `<APPDATA>/<productName><suffix>`. Keyed by
 * app.getName() — the DISPLAY name, which src/main/index.ts pins with
 * app.setName() so it never follows the packaging slug.
 */
export function userDataDir(appData, suffix) {
  return path.join(appData, `${PRODUCT_NAME}${suffix}`);
}
