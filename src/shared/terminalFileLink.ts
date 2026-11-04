/**
 * Resolve a file path or `file://` link printed in a terminal pane into the
 * path the HOST (the machine running wmux) can open.
 *
 * Pure, no I/O: whether the target exists or is a directory is the caller's
 * business. Handles the cases a click can meet:
 *  - POSIX absolute path on a POSIX host: passed through;
 *  - drive / UNC path on a Windows host: passed through, normalised;
 *  - POSIX absolute path in a WSL pane on a Windows host: translated with
 *    `wslPathToHost` (`/mnt/c/x` -> `C:\x`, else `\\wsl$\<distro>\...`);
 *  - `file://` URLs (including `file:///C:/x`; a non-local host is refused);
 *  - `:line` / `:line:col` suffixes (and a `#L12` URL fragment);
 *  - relative paths, joined onto the pane's cwd.
 * Anything else (a POSIX path in a native Windows pane, `~`, a relative path
 * with no usable cwd, a path that Windows would read as another file) is null.
 */

import { wslPathToHost } from './wslPaths';

export type TerminalFileLinkShell = 'wsl' | 'native';

export interface TerminalFileLinkInput {
  /** The text as printed, or an OSC 8 / `file://` URI. */
  raw: string;
  hostPlatform: NodeJS.Platform;
  /** `wsl` when the pane runs a shell inside WSL on a Windows host. */
  shellKind: TerminalFileLinkShell;
  /** The pane's WSL distro, when known (daemon sessions only). */
  distro?: string;
  /** The pane's current directory, as the shell reports it. */
  cwd?: string;
}

export interface TerminalFileLink {
  hostPath: string;
  line?: number;
  col?: number;
}

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const LOCATION_SUFFIX = /^(.+?):(\d+)(?::(\d+))?$/s;

/**
 * Canonical spelling of a Windows host path, so one file never gets two
 * identities: `\\wsl.localhost\` and `\\wsl$\` name the same share, either
 * slash direction works, and a drive letter's case is irrelevant. Anything
 * that is not a drive or UNC path (a POSIX path) comes back unchanged.
 */
export function normalizeHostPath(p: string): string {
  const isDrive = DRIVE_PATH.test(p);
  const isUnc = /^(?:\\\\|\/\/)[^\\/]/.test(p);
  if (!isDrive && !isUnc) return p;
  let out = p.replace(/\//g, '\\');
  // Collapse repeated separators after the UNC prefix / drive root.
  const prefix = isUnc ? '\\\\' : '';
  out = prefix + out.slice(prefix.length).replace(/\\{2,}/g, '\\');
  if (isDrive) out = out[0].toUpperCase() + out.slice(1);
  if (isUnc) out = out.replace(/^\\\\wsl\.localhost\\/i, '\\\\wsl$\\').replace(/^\\\\wsl\$\\/i, '\\\\wsl$\\');
  // A trailing separator is not part of a file's identity (keep a bare root).
  if (out.length > 3 && out.endsWith('\\')) out = out.slice(0, -1);
  return out;
}

/** Split `a/b/../c` style paths on `/` or `\`, resolving `.` and `..`. Null if `..` climbs above the root. */
function joinSegments(base: string[], rel: string): string[] | null {
  const out = base.slice();
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out;
}

function fromFileUrl(raw: string): { path: string; line?: number } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const frag = /^#L(\d+)/i.exec(url.hash);
  const line = frag ? Number(frag[1]) : undefined;
  const host = url.hostname;
  // A remote host would turn into a UNC path (\\host\share), and opening one
  // makes Windows authenticate to that host (NTLM leak). Only local file URLs
  // are accepted; WSL shares are reached through plain POSIX paths instead.
  if (host !== '' && host.toLowerCase() !== 'localhost') return null;
  // file:///C:/x -> C:/x
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) return { path: pathname.slice(1), line };
  return { path: pathname, line };
}

export function resolveTerminalFileLink(input: TerminalFileLinkInput): TerminalFileLink | null {
  const { hostPlatform, shellKind, distro, cwd } = input;
  let text = input.raw.trim();
  // eslint-disable-next-line no-control-regex
  if (text === '' || /[\x00-\x1f]/.test(text)) return null;

  let line: number | undefined;
  let col: number | undefined;

  if (/^file:/i.test(text)) {
    const parsed = fromFileUrl(text);
    if (!parsed) return null;
    text = parsed.path;
    line = parsed.line;
  }
  const loc = LOCATION_SUFFIX.exec(text);
  if (loc) {
    text = loc[1];
    line = Number(loc[2]);
    col = loc[3] !== undefined ? Number(loc[3]) : undefined;
  }
  if (text === '') return null;

  const done = (hostPath: string): TerminalFileLink => ({
    hostPath: normalizeHostPath(hostPath),
    ...(line !== undefined && { line }),
    ...(col !== undefined && { col }),
  });

  const win = hostPlatform === 'win32';

  if (DRIVE_PATH.test(text) || /^\\\\[^\\]/.test(text)) {
    return win ? done(text) : null;
  }

  if (text.startsWith('/')) {
    if (win) {
      if (shellKind !== 'wsl') return null;
      const r = wslPathToHost(text, distro);
      return 'path' in r ? done(r.path) : null;
    }
    return done(text);
  }

  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) return null;

  // Relative: join onto the pane's cwd.
  if (!cwd) return null;
  if (shellKind === 'wsl' && win) {
    // A WSL pane's cwd must be a Linux path; a Windows host cwd says nothing about it.
    if (!cwd.startsWith('/') || cwd.startsWith('//')) return null;
    const segs = joinSegments(cwd.split('/').filter(Boolean), text);
    if (!segs) return null;
    const r = wslPathToHost(`/${segs.join('/')}`, distro);
    return 'path' in r ? done(r.path) : null;
  }
  if (DRIVE_PATH.test(cwd)) {
    if (!win) return null;
    const segs = joinSegments(cwd.slice(3).split(/[\\/]/).filter(Boolean), text);
    return segs ? done(`${cwd.slice(0, 3)}${segs.join('\\')}`) : null;
  }
  if (/^\\\\[^\\]+\\[^\\]+/.test(cwd)) {
    if (!win) return null;
    const m = /^(\\\\[^\\]+\\[^\\]+)(.*)$/s.exec(cwd)!;
    const segs = joinSegments(m[2].split(/[\\/]/).filter(Boolean), text);
    return segs ? done(`${m[1]}\\${segs.join('\\')}`) : null;
  }
  if (cwd.startsWith('/') && !win) {
    const segs = joinSegments(cwd.split('/').filter(Boolean), text);
    return segs ? done(`/${segs.join('/')}`) : null;
  }
  return null;
}
