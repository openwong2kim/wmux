// The paths a plugin's `fs.*` calls never reach, on top of what the app's own
// file tree refuses (`isSensitivePath` in fs.handler.ts). The file tree keeps
// its behaviour; this list applies to plugins only.
//
// `fs.read` reaches the whole local disk, so this list is what keeps
// credentials out of a plugin's hands. Every rule matches case-insensitively
// and on any segment of the path, so a file inside a refused folder is refused
// too, and a refused name is refused at any depth. A path is checked as given
// and once symlinks resolve.
//
// Keep the list here, and keep one test per rule in fsRefusals.test.ts.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeRoots, isSensitivePath, resolveAccessiblePath } from '../../ipc/handlers/fs.handler';

interface Rule {
  /** What the rule refuses, as the approval copy and docs describe it. */
  what: string;
  /** `rel` is the path below home ('' when it is not below home), lowercase, `/`-separated. */
  test: (segments: string[], rel: string) => boolean;
}

const anySegment = (match: (name: string) => boolean) => (segments: string[]) => segments.some(match);
/** `rel` is `entry` or lies inside it. */
const underHome = (...entries: string[]) => (_s: string[], rel: string) =>
  rel !== '' && entries.some((e) => rel === e || rel.startsWith(`${e}/`));

const SHELL_HISTORY = new Set([
  '.bash_history', '.zsh_history', '.sh_history', '.history', 'fish_history', 'consolehost_history.txt',
]);

/** The user config folder for XDG tools (gh), relative to home: ~/.config and $XDG_CONFIG_HOME. */
function configRoots(): string[] {
  const roots = ['.config'];
  const xdg = xdgConfigHome();
  if (xdg) {
    for (const home of homeRoots()) {
      const rel = relBelow(xdg, home);
      if (rel) roots.push(rel);
    }
  }
  return roots;
}

/** $XDG_CONFIG_HOME, absolute, lowercase and `/`-separated; null when unset. */
function xdgConfigHome(): string | null {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.resolve(xdg).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') : null;
}

/** gh tokens and wmux's userData under an $XDG_CONFIG_HOME outside home. */
function underXdgConfig(normalized: string): boolean {
  const xdg = xdgConfigHome();
  if (!xdg || !normalized.startsWith(`${xdg}/`)) return false;
  const first = normalized.slice(xdg.length + 1).split('/')[0];
  return first === 'gh' || first.startsWith('wmux');
}

/** The folder Electron keeps each wmux profile's userData in, relative to home. */
function userDataRoots(): string[] {
  if (process.platform === 'darwin') return ['library/application support'];
  if (process.platform === 'win32') return ['appdata/roaming'];
  return configRoots();
}

export const PLUGIN_FS_REFUSALS: readonly Rule[] = [
  {
    what: "wmux's own data: ~/.wmux* folders, sockets and token files, any profile suffix",
    test: (_s, rel) => rel !== '' && rel.split('/')[0].startsWith('.wmux'),
  },
  {
    what: "wmux's app data (Electron userData), any profile suffix",
    test: (_s, rel) => userDataRoots().some((root) =>
      rel.startsWith(`${root}/`) && rel.slice(root.length + 1).split('/')[0].startsWith('wmux')),
  },
  { what: '.env and .env.* files, at any depth', test: anySegment((n) => n === '.env' || n.startsWith('.env.')) },
  { what: 'private keys: *.pem and *.key files, at any depth', test: anySegment((n) => n.endsWith('.pem') || n.endsWith('.key')) },
  // id_rsa, id_ed25519, id_ecdsa_sk.pub: key files have no other extension,
  // so source files such as id_map.ts stay readable.
  { what: 'SSH key files (id_*), at any depth', test: anySegment((n) => /^id_[^.]+(\.pub)?$/.test(n)) },
  { what: '~/.git-credentials', test: underHome('.git-credentials') },
  {
    what: 'GitHub CLI tokens: ~/.config/gh, $XDG_CONFIG_HOME/gh and %APPDATA%\\GitHub CLI',
    test: (s, rel) => configRoots().some((root) => underHome(`${root}/gh`)(s, rel)) || underHome('appdata/roaming/github cli')(s, rel),
  },
  { what: 'gcloud credentials on Windows: %APPDATA%\\gcloud', test: underHome('appdata/roaming/gcloud') },
  { what: '~/.claude/.credentials.json and ~/.claude.json', test: underHome('.claude/.credentials.json', '.claude.json') },
  { what: '~/.codex/auth.json', test: underHome('.codex/auth.json') },
  { what: '~/.pgpass', test: underHome('.pgpass') },
  { what: '~/.netrc', test: underHome('.netrc') },
  {
    what: 'shell history: .bash_history, .zsh_history, .sh_history, .history, fish_history, ConsoleHost_history.txt, ~/.zsh_sessions',
    test: (segments, rel) => segments.some((n) => SHELL_HISTORY.has(n)) || underHome('.zsh_sessions')(segments, rel),
  },
];

function relBelow(normalized: string, home: string): string {
  return normalized.startsWith(`${home}/`) ? normalized.slice(home.length + 1) : '';
}

/** The first rule that refuses `p` (absolute), or null. */
export function pluginFsRefusal(p: string): Rule | null {
  const normalized = path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  const homes = homeRoots();
  for (const rule of PLUGIN_FS_REFUSALS) {
    const rels = homes.map((h) => relBelow(normalized, h));
    if (rels.some((rel) => rule.test(segments, rel))) return rule;
  }
  return null;
}

/** A WSL distro's files (\\wsl.localhost\<distro>, \\wsl$\<distro>): their home is not one
 *  the rules know, so a plugin never reaches them. */
const WSL_SHARE = /^(?:[\\/]{2}\?[\\/]unc[\\/]|[\\/]{2})(?:wsl\.localhost|wsl\$)(?:[\\/]|$)/i;

/** macOS also reaches the data volume as /System/Volumes/Data/<path>, a
 *  firmlink realpath keeps as written: check the plain spelling. */
function plainSpelling(p: string): string {
  if (process.platform !== 'darwin') return p;
  let plain = path.resolve(p);
  // The kernel's /.nofollow prefix also reaches the same files; strip both, in any order.
  for (let m; (m = /^\/(?:\.nofollow|system\/volumes\/data)(?=\/|$)/i.exec(plain));) plain = plain.slice(m[0].length) || '/';
  return plain === path.resolve(p) ? p : plain;
}

/** Whether a plugin's `fs.*` call must refuse `p`: the file tree's list or this one. */
export function isPluginRefusedPath(p: string): boolean {
  if (WSL_SHARE.test(p)) return true;
  const plain = plainSpelling(p);
  const normalized = path.resolve(plain).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  return isSensitivePath(plain) || pluginFsRefusal(plain) !== null || underXdgConfig(normalized);
}

/**
 * `resolveAccessiblePath` plus this list, checked on the path as given and
 * once symlinks resolve. Null when refused, missing or not local.
 */
export async function resolvePluginPath(input: string): Promise<string | null> {
  if (isPluginRefusedPath(input) || await onWslDrive(input)) return null;
  const canonical = await resolveAccessiblePath(input);
  if (!canonical || isPluginRefusedPath(canonical) || await insideRefusedByIdentity(canonical)) return null;
  return canonical;
}

/** The refused folders and files that sit at known places, as absolute paths.
 *  The rules above match by spelling; these are also matched by identity
 *  (insideRefusedByIdentity), so another spelling of the same folder (a
 *  /.nofollow prefix, a symlinked dotfiles folder, a moved AppData) is refused
 *  too. */
async function refusedRoots(): Promise<string[]> {
  const home = os.homedir();
  const roots = [
    '.ssh', '.aws', '.gnupg', '.gpg', '.config/gcloud', '.azure', '.kube', '.docker/config.json',
    '.npmrc', '.netrc', '.pgpass', '.git-credentials', '.claude.json', '.claude/.credentials.json',
    '.codex/auth.json', '.zsh_sessions', 'AppData/Roaming/GitHub CLI', 'AppData/Roaming/gcloud',
    ...configRoots().map((root) => `${root}/gh`),
  ].map((rel) => path.join(home, rel));
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) roots.push(path.join(xdg, 'gh'));
  const appData = process.env.APPDATA;
  if (appData) roots.push(path.join(appData, 'GitHub CLI'), path.join(appData, 'gcloud'));
  for (const env of ['GH_CONFIG_DIR', 'CLOUDSDK_CONFIG']) {
    const dir = process.env[env];
    if (dir && path.isAbsolute(dir)) roots.push(dir);
  }
  // wmux's own data (~/.wmux*) and each profile's userData (wmux*).
  const parents: Array<[string, string]> = [[home, '.wmux']];
  for (const root of userDataRoots()) parents.push([path.join(home, root), 'wmux']);
  if (appData) parents.push([appData, 'wmux']);
  if (xdg) parents.push([xdg, 'wmux']);
  for (const [dir, prefix] of parents) {
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    for (const name of names) if (name.toLowerCase().startsWith(prefix)) roots.push(path.join(dir, name));
  }
  return roots;
}

/** How long a read of the refused roots' identities is reused: a scan checks every entry. */
const IDENTITY_TTL_MS = 2_000;
let identities: { at: number; key: string; ids: Promise<Set<string>>; reals: Promise<string[]> } | null = null;

/** A path's identity as an entry of its folder: the folder's device and inode
 *  plus the lowercase name. It holds for a file that is replaced (a new inode)
 *  and for one that does not exist yet. */
async function entryKey(p: string): Promise<string | null> {
  const parent = await fs.promises.stat(path.dirname(p), { bigint: true }).catch(() => null);
  return parent ? `${parent.dev}:${parent.ino}/${path.basename(p).toLowerCase()}` : null;
}

function refusedIdentities(): Promise<Set<string>> {
  return identityCache().ids;
}

/** The refused roots as given and once symlinks resolve, normalized for a prefix compare. */
function refusedRootPaths(): Promise<string[]> {
  return identityCache().reals;
}

function identityCache(): { ids: Promise<Set<string>>; reals: Promise<string[]> } {
  const now = Date.now();
  const env = process.env;
  const key = JSON.stringify([os.homedir(), env.XDG_CONFIG_HOME, env.APPDATA, env.GH_CONFIG_DIR, env.CLOUDSDK_CONFIG]);
  if (identities && identities.key === key && now - identities.at < IDENTITY_TTL_MS) return identities;
  const roots = refusedRoots();
  const ids = roots.then(async (list) => {
    const set = new Set<string>();
    await Promise.all(list.map(async (root) => {
      const st = await fs.promises.stat(root, { bigint: true }).catch(() => null);
      if (st) set.add(`${st.dev}:${st.ino}`);
      const entry = await entryKey(root);
      if (entry) set.add(entry);
    }));
    return set;
  });
  const reals = roots.then(async (list) => {
    const out = new Set<string>();
    await Promise.all(list.map(async (root) => {
      out.add(normalizedPath(root));
      const real = await fs.promises.realpath(root).catch(() => null);
      if (real) out.add(normalizedPath(real));
    }));
    return [...out];
  });
  identities = { at: now, key, ids, reals };
  return identities;
}

const normalizedPath = (p: string) => path.resolve(plainSpelling(p)).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

/** Whether moving, renaming or trashing `p` would carry a refused folder or file
 *  with it: one lies at or below `p`, as spelled or once links resolve. A link
 *  or junction above a refused folder is never traversed by the preflight, so
 *  this is what keeps it from being renamed out of the way. */
export async function holdsRefusedRoot(p: string): Promise<boolean> {
  const spellings = [normalizedPath(p)];
  const real = await fs.promises.realpath(p).catch(() => null);
  if (real) spellings.push(normalizedPath(real));
  const roots = await refusedRootPaths();
  return spellings.some((s) => roots.some((r) => r === s || r.startsWith(`${s}/`)));
}

/** Whether `canonical` (a resolved path, or one about to be created) is a
 *  refused folder or file or lies inside one, by identity rather than by
 *  spelling. */
export async function insideRefusedByIdentity(canonical: string): Promise<boolean> {
  const ids = await refusedIdentities();
  if (ids.size === 0) return false;
  for (let p = canonical; ; p = path.dirname(p)) {
    const st = await fs.promises.stat(p, { bigint: true }).catch(() => null);
    if (st && ids.has(`${st.dev}:${st.ino}`)) return true;
    const entry = await entryKey(p);
    if (entry && ids.has(entry)) return true;
    if (path.dirname(p) === p) return false;
  }
}

/** A drive letter mapped to a WSL distro share (net use, subst) is that share. */
async function onWslDrive(input: string): Promise<boolean> {
  if (process.platform !== 'win32' || !/^[a-z]:/i.test(input)) return false;
  const root = await fs.promises.realpath(`${input.slice(0, 2)}\\`).catch(() => null);
  return root !== null && WSL_SHARE.test(root);
}
