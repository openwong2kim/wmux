// Pure guard for the WMUX_DATA_SUFFIX userData-isolation invariant. Extracted so
// it is unit-testable without booting Electron (main/index.ts runs at module
// top-level and pulls in `app`).

import * as fs from 'fs';
import * as path from 'path';

export type IsolationCheck = { ok: true } | { ok: false; error: string };

/**
 * After applying WMUX_DATA_SUFFIX to userData, verify the isolation actually
 * took. A NON-EMPTY suffix MUST be reflected in the resolved userData path; if
 * setPath threw / silently no-op'd, userData stays at the PRODUCTION location and
 * an isolated instance would read prod's session.json — restoring the wrong
 * workspaces (the observed "a fresh suffix restored an old workspace" bug). Fail
 * ONLY on that precise mismatch.
 *
 * An EMPTY suffix is legitimate production (no isolation requested) and ALWAYS
 * passes — never fail just because userData equals the prod default. This is the
 * load-bearing distinction: the guard must not turn every normal production boot
 * into a crash.
 */
export function checkUserDataIsolation(
  suffix: string,
  resolvedUserData: string,
  originalUserData: string,
): IsolationCheck {
  if (!suffix) return { ok: true };
  // Exact-path comparison, NOT a tail substring (`endsWith`). A suffix that
  // coincidentally tails the production path — e.g. 'x' when userData already
  // ends in 'wmux' — would let endsWith() report success even after setPath
  // failed/no-op'd and the app is still pointed at production state, the exact
  // corruption this guard exists to catch.
  if (resolvedUserData === originalUserData + suffix) return { ok: true };
  return {
    ok: false,
    error:
      `data isolation broken: WMUX_DATA_SUFFIX="${suffix}" but userData resolved to ` +
      `"${resolvedUserData}" (expected "${originalUserData}${suffix}"). Refusing to boot ` +
      `onto the production data dir — an isolated instance would corrupt or restore ` +
      `production state.`,
  };
}

export const PORTABLE_DATA_SUFFIX = '-portable';

/**
 * darwin: should a PACKAGED app use isolated data because it is not installed?
 * A copy run from a DMG mount, AppTranslocation, an electron-forge `out/` dir,
 * or ~/Downloads would otherwise share production data, sockets, token and the
 * launchd label — and, if newer, replace the production daemon and repoint the
 * CLI shim at itself.
 *
 * `realExecPath` is the realpath of process.execPath (the caller does that one
 * syscall; this stays pure). Installed = the .app bundle sits anywhere under
 * /Applications or ~/Applications. Any depth on purpose: misreading a real
 * install (e.g. /Applications/Utilities, a Setapp folder, Homebrew's default
 * cask dir) as portable would open an empty app, the worse failure. Case-
 * insensitive because APFS is by default. A path with no recognisable .app
 * bundle is treated as installed for the same reason.
 *
 * Never overrides an explicit WMUX_DATA_SUFFIX; WMUX_ALLOW_PRODUCTION_DATA=1
 * keeps the old behaviour (a custom Homebrew --appdir, for one).
 */
export function shouldUsePortableData(realExecPath: string, home: string, env: NodeJS.ProcessEnv): boolean {
  if (env.WMUX_DATA_SUFFIX || env.WMUX_ALLOW_PRODUCTION_DATA === '1') return false;
  const bundle = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/i.exec(realExecPath)?.[1];
  if (!bundle) return false;
  const lower = bundle.toLowerCase();
  const roots = ['/Applications/', ...(home ? [`${home.replace(/\/+$/, '')}/Applications/`] : [])];
  return !roots.some((root) => lower.startsWith(root.toLowerCase()));
}

/**
 * Whether to tell the user, once per portable data dir, that this copy uses
 * separate data. Only when the portable suffix was FORCED. The marker is
 * created exclusively, so a later launch or renderer reload never shows it
 * again; a marker that cannot be written skips the notice rather than nag.
 * The renderer asks after mounting, so a claimed marker means a shown toast.
 */
export function claimPortableDataNotice(forced: boolean, markerPath: string): boolean {
  if (!forced) return false;
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, new Date().toISOString(), { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') console.warn('[Main] portable data notice marker not written:', err);
    return false;
  }
}
