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

/** The folder Electron keeps each wmux profile's userData in, relative to home. */
function userDataRoots(): string[] {
  if (process.platform === 'darwin') return ['library/application support'];
  if (process.platform === 'win32') return ['appdata/roaming'];
  const xdg = process.env.XDG_CONFIG_HOME;
  const roots = ['.config'];
  if (xdg) {
    for (const home of homeRoots()) {
      const rel = relBelow(xdg.replace(/\\/g, '/').toLowerCase(), home);
      if (rel) roots.push(rel);
    }
  }
  return roots;
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
  { what: '~/.config/gh (GitHub CLI tokens)', test: underHome('.config/gh') },
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

/** Whether a plugin's `fs.*` call must refuse `p`: the file tree's list or this one. */
export function isPluginRefusedPath(p: string): boolean {
  return isSensitivePath(p) || pluginFsRefusal(p) !== null;
}

/**
 * `resolveAccessiblePath` plus this list, checked on the path as given and
 * once symlinks resolve. Null when refused, missing or not local.
 */
export async function resolvePluginPath(input: string): Promise<string | null> {
  if (pluginFsRefusal(input)) return null;
  const canonical = await resolveAccessiblePath(input);
  if (!canonical || pluginFsRefusal(canonical)) return null;
  return canonical;
}
