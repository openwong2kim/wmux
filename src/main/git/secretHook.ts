// The pre-commit hook wmux installs in repositories it opens (the Git page)
// and in the repositories Moa's task worktrees belong to, so a commit made
// from ANY terminal or tool — not only wmux's own buttons — is checked with
// the same rules (`wmux secrets check-staged`, src/cli/commands/secretsCheck.ts).
//
// It never overwrites a hook the user has: an existing pre-commit is moved
// to `pre-commit.wmux-user` and the wmux hook runs it after its own check,
// with the same arguments, so it still decides. When `core.hooksPath` is set
// (husky, lefthook, a shared hooks folder) the hooks live in the user's own
// files; wmux leaves them alone and says so. Worktrees share the repository's
// hooks folder, so one install covers every task worktree.
import fs from 'node:fs';
import path from 'node:path';

export const SECRET_HOOK_MARKER = '# wmux-secret-guard v1';
export const USER_HOOK_NAME = 'pre-commit.wmux-user';

/** How the hook reaches wmux's CLI: the app binary run as node, the bundled
 *  CLI script, and (dev) a plain `node` fallback. */
export interface SecretHookRuntime {
  /** Executable run with ELECTRON_RUN_AS_NODE=1 (the wmux app), or node. */
  runtime: string;
  /** Path of the CLI bundle (cli-bundle/index.js). */
  cli: string;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const posix = (s: string) => s.replace(/\\/g, '/');

/**
 * #2231 — a commit made in a WSL shell runs this hook under Linux, where the
 * Windows paths it names (`D:/…/wmux.exe`) do not exist and the distro has no
 * `wmux`: every commit was refused. Under WSL (WSL_DISTRO_NAME, or
 * "microsoft" in /proc/version) each `X:/…` path is looked up through its
 * `/mnt/x/…` mount and the Windows app runs through interop, with
 * ELECTRON_RUN_AS_NODE (and the commit's GIT_INDEX_FILE) handed over by
 * WSLENV; the CLI path it is given stays the Windows one, which is what a
 * Windows program reads. A mount that is not there leaves the path as it was,
 * so Git for Windows' own sh is never sent elsewhere, and a check that still
 * cannot run refuses the commit as before.
 */
export const WSL_HOOK_LINES: readonly string[] = [
  'if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then',
  '  wmux_mnt() {',
  '    case "$1" in',
  '      [A-Za-z]:/*) printf \'/mnt/%s/%s\' "$(printf \'%s\' "$1" | cut -c1 | tr \'A-Z\' \'a-z\')" "${1#?:/}" ;;',
  '      *) printf \'%s\' "$1" ;;',
  '    esac',
  '  }',
  '  WMUX_RUNTIME_MNT="$(wmux_mnt "$WMUX_RUNTIME")"',
  '  WMUX_CLI_MNT="$(wmux_mnt "$WMUX_CLI")"',
  '  if [ -f "$WMUX_RUNTIME_MNT" ] && [ -f "$WMUX_CLI_MNT" ]; then',
  '    WMUX_RUNTIME="$WMUX_RUNTIME_MNT"',
  '    WMUX_CLI="$WMUX_CLI_MNT"',
  '    WSLENV="${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE/w${GIT_INDEX_FILE:+:GIT_INDEX_FILE/p}"',
  '    export WSLENV',
  '  fi',
  'fi',
];

/** The hook script (POSIX sh; Git for Windows runs it with its own sh). */
export function buildPreCommitHook(rt: SecretHookRuntime): string {
  return [
    '#!/bin/sh',
    SECRET_HOOK_MARKER,
    '# Installed by wmux: stops a commit that would save a password or key into git.',
    `# Your previous pre-commit hook (if you had one) is kept as ${USER_HOOK_NAME} and still runs.`,
    `WMUX_RUNTIME=${shq(posix(rt.runtime))}`,
    `WMUX_CLI=${shq(posix(rt.cli))}`,
    'WMUX_CLI_ARG="$WMUX_CLI"',
    ...WSL_HOOK_LINES,
    'if [ -f "$WMUX_RUNTIME" ] && [ -f "$WMUX_CLI" ]; then',
    '  ELECTRON_RUN_AS_NODE=1 "$WMUX_RUNTIME" "$WMUX_CLI_ARG" secrets check-staged || exit 1',
    'elif command -v wmux >/dev/null 2>&1; then',
    '  wmux secrets check-staged || exit 1',
    'else',
    '  echo "" >&2',
    '  echo "wmux could not check this commit for passwords and keys (wmux was moved or uninstalled), so it stopped the commit." >&2',
    '  echo "Open the repository in wmux once to repair the check, or remove .git/hooks/pre-commit to turn it off." >&2',
    '  exit 1',
    'fi',
    `USER_HOOK="$(dirname "$0")/${USER_HOOK_NAME}"`,
    'if [ -x "$USER_HOOK" ]; then exec "$USER_HOOK" "$@"; fi',
    'exit 0',
    '',
  ].join('\n');
}

export type SecretHookInstall =
  | { ok: true; hook: string; chained: boolean; updated: boolean }
  | { ok: false; reason: 'not-a-repo' | 'hooks-path' | 'conflict' | 'error'; message: string };

export interface SecretHookPorts {
  /** git in `cwd`; stdout, or null on failure. */
  git: (args: string[], cwd: string) => Promise<string | null>;
  fs?: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync' | 'chmodSync' | 'unlinkSync'>;
}

/** Installs (or refreshes) the wmux pre-commit hook for the repository at `cwd`. */
export async function installSecretHook(cwd: string, rt: SecretHookRuntime, ports: SecretHookPorts): Promise<SecretHookInstall> {
  const f = ports.fs ?? fs;
  const hooksPath = (await ports.git(['config', '--get', 'core.hooksPath'], cwd))?.trim();
  if (hooksPath) {
    return { ok: false, reason: 'hooks-path', message: `this repository uses its own hooks folder (${hooksPath}); wmux leaves it alone` };
  }
  const common = (await ports.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd))?.trim();
  if (!common) return { ok: false, reason: 'not-a-repo', message: 'not a git repository' };
  const dir = path.join(path.resolve(cwd, common), 'hooks');
  const hook = path.join(dir, 'pre-commit');
  const user = path.join(dir, USER_HOOK_NAME);
  try {
    f.mkdirSync(dir, { recursive: true });
    let chained = f.existsSync(user);
    let updated = false;
    if (f.existsSync(hook)) {
      const current = f.readFileSync(hook, 'utf8');
      if (current.includes(SECRET_HOOK_MARKER)) {
        if (current === buildPreCommitHook(rt)) return { ok: true, hook, chained, updated: false };
        updated = true;
      } else {
        // The user's own hook: kept and chained, never overwritten.
        if (chained) {
          return { ok: false, reason: 'conflict', message: `both pre-commit and ${USER_HOOK_NAME} exist; wmux did not touch either` };
        }
        f.renameSync(hook, user);
        chained = true;
      }
    }
    f.writeFileSync(hook, buildPreCommitHook(rt), { mode: 0o755 });
    f.chmodSync(hook, 0o755);
    return { ok: true, hook, chained, updated };
  } catch (err) {
    return { ok: false, reason: 'error', message: (err as Error).message };
  }
}

export type SecretHookUninstall =
  | { ok: true; removed: boolean; restored: boolean }
  | { ok: false; message: string };

/** Removes the wmux hook from the repository at `cwd` and puts the user's
 *  original pre-commit (kept as pre-commit.wmux-user) back in its place. A
 *  pre-commit that is not wmux's is never touched. */
export async function uninstallSecretHook(cwd: string, ports: SecretHookPorts): Promise<SecretHookUninstall> {
  const f = ports.fs ?? fs;
  const common = (await ports.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd))?.trim();
  if (!common) return { ok: false, message: 'not a git repository' };
  const dir = path.join(path.resolve(cwd, common), 'hooks');
  const hook = path.join(dir, 'pre-commit');
  const user = path.join(dir, USER_HOOK_NAME);
  try {
    const ours = f.existsSync(hook) && f.readFileSync(hook, 'utf8').includes(SECRET_HOOK_MARKER);
    if (f.existsSync(hook) && !ours) return { ok: true, removed: false, restored: false };
    if (ours) f.unlinkSync(hook);
    const restored = f.existsSync(user);
    if (restored) f.renameSync(user, hook);
    return { ok: true, removed: ours, restored };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** The saved choice and the repositories wmux installed into (so turning the
 *  setting off can take the hook back out everywhere). */
export interface SecretHookPrefs {
  autoInstall: boolean;
  repos: string[];
}

export interface SecretHookPrefsStore {
  load(): SecretHookPrefs;
  save(p: SecretHookPrefs): void;
}

/** Installs once per repository per run, only while the setting is on
 *  (default on); turning it off uninstalls from every repo it installed. */
export class SecretHookInstaller {
  private done = new Map<string, Promise<SecretHookInstall>>();

  constructor(
    private runtime: () => SecretHookRuntime | null,
    private ports: SecretHookPorts,
    private prefs: SecretHookPrefsStore = memoryPrefs(),
  ) {}

  get autoInstall(): boolean {
    return this.prefs.load().autoInstall;
  }

  ensure(cwd: string): Promise<SecretHookInstall> | null {
    if (!this.prefs.load().autoInstall) return null;
    const rt = this.runtime();
    if (!rt) return null;
    const key = path.resolve(cwd);
    let hit = this.done.get(key);
    if (!hit) {
      hit = installSecretHook(cwd, rt, this.ports).then((r) => {
        if (r.ok) {
          const p = this.prefs.load();
          const repo = path.dirname(path.dirname(r.hook));
          if (!p.repos.includes(repo)) this.prefs.save({ ...p, repos: [...p.repos, repo] });
        } else if (r.reason !== 'hooks-path') console.warn(`[secret-hook] ${cwd}: ${r.message}`);
        return r;
      });
      this.done.set(key, hit);
    }
    return hit;
  }

  /** Saves the choice; turning it off removes the hook from every repository
   *  wmux installed it in and restores each user's original hook. */
  async setAutoInstall(on: boolean): Promise<{ autoInstall: boolean; failed: string[] }> {
    const p = this.prefs.load();
    if (on) {
      this.prefs.save({ ...p, autoInstall: true });
      return { autoInstall: true, failed: [] };
    }
    await Promise.allSettled([...this.done.values()]);
    this.done.clear();
    const failed: string[] = [];
    const repos = this.prefs.load().repos;
    for (const repo of repos) {
      const r = await uninstallSecretHook(repo, this.ports);
      if (!r.ok && r.message !== 'not a git repository') failed.push(repo);
    }
    this.prefs.save({ autoInstall: false, repos: failed });
    return { autoInstall: false, failed };
  }
}

function memoryPrefs(): SecretHookPrefsStore {
  let v: SecretHookPrefs = { autoInstall: true, repos: [] };
  return { load: () => v, save: (p) => { v = p; } };
}

/** File-backed prefs; a missing or broken file means the default (on). */
export function filePrefs(file: string, f: Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'mkdirSync'> = fs): SecretHookPrefsStore {
  return {
    load() {
      try {
        const j = JSON.parse(f.readFileSync(file, 'utf8')) as Partial<SecretHookPrefs>;
        return { autoInstall: j.autoInstall !== false, repos: Array.isArray(j.repos) ? j.repos.filter((r) => typeof r === 'string') : [] };
      } catch {
        return { autoInstall: true, repos: [] };
      }
    },
    save(p) {
      f.mkdirSync(path.dirname(file), { recursive: true });
      f.writeFileSync(file, JSON.stringify(p, null, 2));
    },
  };
}
