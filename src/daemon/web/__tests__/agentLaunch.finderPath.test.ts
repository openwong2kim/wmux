import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExecArgs } from '../../execWrapper';

// A daemon started by an app launched from Finder inherits launchd's PATH
// (/usr/bin:/bin:/usr/sbin:/sbin). The phone's "start Codex/Claude" probe ran
// `claude --help` / `codex --help` with that PATH, got exit 127, and reported
// agent-not-installed. These run the real probe under that PATH.
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const CLAUDE_HELP = "Claude Code\n --model <model> alias 'sonnet'";
const CODEX_HELP = 'Codex CLI\n --model <MODEL>\n --config <key=value>';

function fakeBin(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe.skipIf(process.platform === 'win32')('agent probe under a Finder-launched PATH', () => {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, SHELL: process.env.SHELL, GH_TOKEN: process.env.GH_TOKEN };
  let home: string;

  beforeEach(() => {
    vi.resetModules(); // the probe and login-shell caches are module-level
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-agent-path-'));
    process.env.PATH = LAUNCHD_PATH;
    process.env.HOME = home;
    process.env.SHELL = path.join(home, 'missing', 'zsh'); // login-shell probe fails → static fallbacks only
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const probe = async () => {
    const { installedAgentLaunchOptions } = await import('../agentLaunch');
    const options = await installedAgentLaunchOptions({ CODEX_HOME: path.join(home, '.codex') });
    return options.map((option) => option.agent);
  };
  /** Stands in for zsh: prints rc noise, prepends `dir` like an rc would, runs the `-ilc` command. */
  const loginShellAdding = (dir: string, extra = '') => {
    process.env.SHELL = fakeBin(path.join(home, 'shell'), 'zsh', `echo 'rc noise'\n${extra}\nPATH="${dir}:$PATH"; export PATH\neval "$2"`);
  };

  it('finds agents installed in ~/.local/bin', async () => {
    fakeBin(path.join(home, '.local', 'bin'), 'claude', `printf '%s' "${CLAUDE_HELP}"`);
    fakeBin(path.join(home, '.local', 'bin'), 'codex', `printf '%s' "${CODEX_HELP}"`);
    expect(await probe()).toEqual(['claude', 'codex']);
  });

  it('launches exactly the binary and PATH it probed, even after a login profile rewrites PATH', async () => {
    const npmBin = path.join(home, '.local', 'node', 'bin');
    // Prints its own PATH on launch; --help satisfies the probe.
    const codex = fakeBin(npmBin, 'codex', `[ "$1" = --help ] && { printf '%s' "${CODEX_HELP}"; exit 0; }\nprintf '%s\\n' "$PATH" "$@"`);
    loginShellAdding(npmBin);
    expect(await probe()).toContain('codex');

    const { pinnedAgentLaunch } = await import('../agentLaunch');
    const pinned = await pinnedAgentLaunch('codex --model m');
    expect(pinned).toContain(`'${codex}' --model m`);
    // `/bin/sh -lc` reads /etc/profile (path_helper on macOS) before the command runs.
    const [agentPath, ...argv] = execFileSync('/bin/sh', buildExecArgs('/bin/sh', pinned) ?? [], { encoding: 'utf8', env: { HOME: home, PATH: LAUNCHD_PATH } }).trim().split('\n');
    expect(agentPath.split(':')[0]).toBe(npmBin); // the login shell's PATH comes first
    expect(argv).toEqual(['--model', 'm']);
  });

  it('retries a failed login-shell probe after the backoff instead of caching the failure', async () => {
    const { resolveLoginShellPath, LOGIN_PATH_RETRY_MS } = await import('../../../shared/execEnv');
    const t0 = 1_000_000;
    expect(await resolveLoginShellPath(t0)).toBeNull(); // shell missing
    const dir = path.join(home, 'later');
    fakeBin(path.join(home, 'missing'), 'zsh', `PATH="${dir}:$PATH"; export PATH\neval "$2"`);
    expect(await resolveLoginShellPath(t0 + 1000)).toBeNull(); // still inside the backoff: no respawn
    expect(await resolveLoginShellPath(t0 + LOGIN_PATH_RETRY_MS + 1)).toContain(dir);
  });

  it('runs the rc files without the daemon environment', async () => {
    process.env.GH_TOKEN = 'secret';
    loginShellAdding(path.join(home, 'x'), `printf '%s|%s' "\${GH_TOKEN:-unset}" "$TERM" > "${home}/seen"`);
    const { resolveLoginShellPath } = await import('../../../shared/execEnv');
    expect(await resolveLoginShellPath()).toContain(path.join(home, 'x'));
    expect(fs.readFileSync(path.join(home, 'seen'), 'utf8')).toBe('unset|dumb');
  });

  it('kills what the rc started when the login shell times out', async () => {
    const pidFile = path.join(home, 'bg.pid');
    process.env.SHELL = fakeBin(path.join(home, 'shell'), 'zsh', `sleep 30 &\necho $! > "${pidFile}"\nsleep 30`);
    const { resolveLoginShellPath } = await import('../../../shared/execEnv');
    expect(await resolveLoginShellPath()).toBeNull();
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);
});
