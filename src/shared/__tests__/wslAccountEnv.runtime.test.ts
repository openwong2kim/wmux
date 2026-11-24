/** Opt in with WMUX_TEST_WSL=1 and optionally WMUX_TEST_WSL_DISTRO.
 * A fake login writes only to temporary account directories; no vendor CLI,
 * user configuration, credentials or daily daemon is used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildWslInjection } from '../wslIntegration';
import { wslAccountHomeKey } from '../wslAccountHome';

const enabled = process.platform === 'win32' && process.env.WMUX_TEST_WSL === '1';

describe.runIf(enabled)('WSL account-home transport', () => {
  it.each(['CODEX_HOME', 'CLAUDE_CONFIG_DIR'])('leaves an ordinary pane on its Linux %s', (key) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-ordinary-'));
    const wsl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
    const distroArgs = process.env.WMUX_TEST_WSL_DISTRO ? ['-d', process.env.WMUX_TEST_WSL_DISTRO] : [];
    const env = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: process.env.PATH ?? '', WMUX_SHELL_INTEGRATION: '0' };
    const execute = (args: string[]) => execFileSync(wsl, [...distroArgs, '--exec', ...args], {
      env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    try {
      const [distribution, user] = execute(['/bin/sh', '-c', 'printf "%s\\0%s" "$WSL_DISTRO_NAME" "$(id -un)"']).split('\0');
      const initialCommand = `printf '%s' "\${${key}-}"`;
      const baseline = execute(['/bin/sh', '-c', initialCommand]);
      const cwd = execute(['wslpath', '-u', dir]).trim();
      const injected = buildWslInjection({
        target: { distribution, user }, cwd, integrationDir: dir,
        env: { ...env, [key]: dir }, bashInit: '', execCommand: initialCommand, mcpEntryPath: null,
      });
      expect(execFileSync(wsl, injected.args, { env: injected.env, encoding: 'utf8', timeout: 30_000, windowsHide: true })).toBe(baseline);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it.each([
    ['CODEX_HOME', 'auth.json', 'windows'],
    ['CLAUDE_CONFIG_DIR', '.credentials.json', 'windows'],
    ['CODEX_HOME', 'auth.json', 'linux'],
    ['CLAUDE_CONFIG_DIR', '.credentials.json', 'linux'],
  ])('keeps the %s login writer and Windows reader on the same %s fixture (%s path)', (key, file, style) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wmux account it's-"));
    const wsl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
    const distroArgs = process.env.WMUX_TEST_WSL_DISTRO ? ['-d', process.env.WMUX_TEST_WSL_DISTRO] : [];
    const execute = (args: string[]) => execFileSync(wsl, [...distroArgs, '--exec', ...args], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    try {
      const [distribution, user] = execute(['/bin/sh', '-c', 'printf "%s\\0%s" "$WSL_DISTRO_NAME" "$(id -un)"']).split('\0');
      const selected = path.join(dir, 'selected');
      const other = path.join(dir, 'other');
      fs.mkdirSync(selected);
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, file), 'other account');
      const linuxDir = execute(['wslpath', '-u', dir]).trim();
      const linuxSelected = `${linuxDir}/selected`;
      // Only fixed variable/file names enter shell source. Paths are env data.
      const initialCommand = `set -eu; printf '%s' "$${key}"; printf '{"fixture":true}' > "$${key}/${file}"`;
      const injected = buildWslInjection({
        target: { distribution, user }, cwd: linuxDir, integrationDir: dir,
        wslAccountLoginEnvKey: key === 'CODEX_HOME' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR',
        env: {
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          PATH: process.env.PATH ?? '',
          [key]: style === 'windows' ? selected : linuxSelected,
          WMUX_SHELL_INTEGRATION: '0',
        },
        bashInit: '', execCommand: initialCommand, mcpEntryPath: null,
      });
      const receivedHome = execFileSync(wsl, injected.args, {
        env: injected.env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      });
      expect(receivedHome).toBe(linuxSelected);
      expect(JSON.parse(fs.readFileSync(path.join(selected, file), 'utf8'))).toEqual({ fixture: true });
      expect(fs.readFileSync(path.join(other, file), 'utf8')).toBe('other account');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // #2202: a UNC home into this same distro translates; another distro's does not.
  it('carries a \\\\wsl.localhost home inside this distro and drops another distro\'s with a note', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-unc-'));
    const wsl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
    const distroArgs = process.env.WMUX_TEST_WSL_DISTRO ? ['-d', process.env.WMUX_TEST_WSL_DISTRO] : [];
    const execute = (args: string[]) => execFileSync(wsl, [...distroArgs, '--exec', ...args], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const linuxHome = `/tmp/wmux-unc-${process.pid}`;
    try {
      const [distribution, user] = execute(['/bin/sh', '-c', 'printf "%s\\0%s" "$WSL_DISTRO_NAME" "$(id -un)"']).split('\0');
      execute(['mkdir', '-p', linuxHome]);
      const cwd = execute(['wslpath', '-u', dir]).trim();
      const base = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: process.env.PATH ?? '', WMUX_SHELL_INTEGRATION: '0' };
      const run = (home: string, execCommand?: string) => {
        const injected = buildWslInjection({
          target: { distribution, user }, cwd, integrationDir: dir, wslAccountLoginEnvKey: 'CODEX_HOME',
          env: { ...base, CODEX_HOME: home }, bashInit: '', mcpEntryPath: null,
          ...(execCommand === undefined ? {} : { execCommand }),
        });
        return spawnSync(wsl, injected.args, {
          env: injected.env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
          // No history: the interactive shell would append this to the user's ~/.bash_history.
          ...(execCommand === undefined ? { input: 'unset HISTFILE; exit\n' } : {}),
        });
      };
      const write = `set -eu; printf '%s|%s' "\${CODEX_HOME-}" "\${WMUX_WSL_ACCOUNT_HOME_UNREACHABLE-}"; printf '{}' > "\${CODEX_HOME:-/nonexistent}/auth.json"`;

      const same = run(`\\\\wsl.localhost\\${distribution}${linuxHome.replace(/\//g, '\\')}`, write);
      expect(same.stdout).toBe(`${linuxHome}|`);
      expect(same.stderr).not.toMatch(/Failed to translate/);
      expect(execute(['cat', `${linuxHome}/auth.json`])).toBe('{}');

      const otherHome = '\\\\wsl.localhost\\wmux-no-such-distro\\home\\someone';
      const peek = `printf '%s|%s' "\${CODEX_HOME-}" "\${WMUX_WSL_ACCOUNT_HOME_UNREACHABLE-}"`;
      const other = run(otherHome, peek);
      expect(other.stdout).toBe(`|CODEX_HOME (${otherHome})`);
      expect(other.stderr).not.toMatch(/Failed to translate/);
      // The interactive login tab says why the login cannot reach the account.
      const tab = run(otherHome);
      expect(tab.stderr).toContain(`wmux: CODEX_HOME (${otherHome}) cannot be opened from this WSL distro`);
      expect(tab.stderr).not.toMatch(/Failed to translate/);
    } finally {
      try { execute(['rm', '-rf', linuxHome]); } catch { /* best effort */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  // A bound workspace's account runs on its own home in the distro
  // (shared/wslAccountHome.ts). A unique data suffix keeps the test out of the
  // user's real ~/.wmux, and its folder is removed at the end.
  it('gives each bound account its own private home in the distro, and an unbound pane its Linux profile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-bound-'));
    const wsl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
    const distroArgs = process.env.WMUX_TEST_WSL_DISTRO ? ['-d', process.env.WMUX_TEST_WSL_DISTRO] : [];
    const execute = (args: string[]) => execFileSync(wsl, [...distroArgs, '--exec', ...args], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const suffix = `-wmuxtest-${process.pid}`;
    let linuxRoot = '';
    try {
      const [distribution, user, linuxHome] = execute(['/bin/sh', '-c', 'printf "%s\\0%s\\0%s" "$WSL_DISTRO_NAME" "$(id -un)" "$HOME"']).split('\0');
      linuxRoot = `${linuxHome}/.wmux${suffix}`;
      const cwd = execute(['wslpath', '-u', dir]).trim();
      const base = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: process.env.PATH ?? '', WMUX_SHELL_INTEGRATION: '0', WMUX_DATA_SUFFIX: suffix };
      const peek = `printf '%s|%s|%s' "\${CLAUDE_CONFIG_DIR-}" "\${CODEX_HOME-}" "$(stat -c %a "\${CLAUDE_CONFIG_DIR:-/nonexistent}" 2>/dev/null)"`;
      const run = (env: Record<string, string>, execCommand?: string) => {
        const injected = buildWslInjection({
          target: { distribution, user }, cwd, integrationDir: dir, env: { ...base, ...env }, bashInit: '', mcpEntryPath: null,
          ...(execCommand === undefined ? {} : { execCommand }),
        });
        return spawnSync(wsl, injected.args, {
          env: injected.env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
          // No history: the interactive shell would append this to the user's ~/.bash_history.
          ...(execCommand === undefined ? { input: `unset HISTFILE; ${peek}; exit\n` } : {}),
        });
      };
      const work = { CLAUDE_CONFIG_DIR: path.join(dir, 'work'), CODEX_HOME: path.join(dir, 'codex'), WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR,CODEX_HOME' };
      const workHome = `${linuxRoot}/accounts/claude-${wslAccountHomeKey(work.CLAUDE_CONFIG_DIR)}`;
      const codexHome = `${linuxRoot}/accounts/codex-${wslAccountHomeKey(work.CODEX_HOME)}`;

      const first = run(work, peek);
      expect(first.stdout).toBe(`${workHome}|${codexHome}|700`);
      expect(first.stderr).toBe('');
      expect(execute(['cat', `${linuxRoot}/accounts/notices.log`])).toContain('has no sign-in in this WSL distro yet');

      const personal = run({ CLAUDE_CONFIG_DIR: path.join(dir, 'personal'), WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR' }, peek);
      expect(personal.stdout.split('|')[0]).toBe(`${linuxRoot}/accounts/claude-${wslAccountHomeKey(path.join(dir, 'personal'))}`);

      // The interactive pane says once that the account has no sign-in here, and nothing once it has one.
      const tab = run(work);
      expect(tab.stdout).toContain(`${workHome}|${codexHome}|700`);
      expect(tab.stderr).toContain('this pane\'s claude account has no sign-in in this WSL distro yet');
      execute(['/bin/sh', '-c', `printf '{}' > "${workHome}/.credentials.json" && printf '{}' > "${codexHome}/auth.json"`]);
      expect(run(work).stderr).not.toContain('has no sign-in');

      // An unbound pane, and an unmarked (profile or inherited) variable, keep the Linux profile.
      const baseline = execute(['/bin/sh', '-c', peek]);
      expect(run({ CLAUDE_CONFIG_DIR: path.join(dir, 'inherited') }, peek).stdout).toBe(baseline);

      // An exec unit whose account home cannot be made does not run on the default account.
      execute(['/bin/sh', '-c', `rm -rf "${linuxRoot}" && mkdir -p "${linuxRoot}" && printf x > "${linuxRoot}/accounts"`]);
      const blocked = run(work, 'printf ran');
      expect(blocked.status).toBe(1);
      expect(blocked.stdout).toBe('');
      expect(blocked.stderr).toContain('cannot create');
    } finally {
      if (linuxRoot.includes('.wmux-wmuxtest-')) { try { execute(['rm', '-rf', linuxRoot]); } catch { /* best effort */ } }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
