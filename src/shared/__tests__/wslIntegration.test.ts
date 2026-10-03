import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWslInjection } from '../wslIntegration';
import { execFileSync, spawnSync } from 'node:child_process';
import { BASH_INIT } from '../../daemon/shell-integration';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('WSL per-launch Claude integration', () => {
  it.skipIf(process.platform === 'win32').each(['0', '1'])('restores cwd after user bashrc with integration=%s', (enabled) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-test-')); dirs.push(dir);
    const project = path.join(dir, "project ' with spaces"); fs.mkdirSync(project);
    fs.writeFileSync(path.join(dir, '.bashrc'), 'export USER_RC_LOADED=yes\ncd ~\n');
    const injected = buildWslInjection({
      target: { distribution: 'test', user: 'test' }, cwd: project,
      env: { HOME: dir, PATH: '/usr/bin:/bin', WMUX_SHELL_INTEGRATION: enabled },
      integrationDir: dir, bashInit: BASH_INIT, runtimePath: process.execPath, bridgePath: '/unused-bridge',
    });
    const output = execFileSync('/bin/bash', ['-c', '. "$WMUX_WSL_BASHRC"; printf "%s\\0%s\\0%s" "$PWD" "$USER_RC_LOADED" "$PATH"'], {
      encoding: 'utf8', env: injected.env,
    }).split('\0');
    expect(output[0]).toBe(project);
    expect(output[1]).toBe('yes');
    expect(output[2].startsWith(injected.env.WMUX_WSL_BIN + ':')).toBe(enabled === '1');
  });

  it('uses scoped settings and the existing Windows bridge without writing user settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-test-')); dirs.push(dir);
    const injected = buildWslInjection({
      target: { distribution: 'Ubuntu', user: 'developer' }, cwd: "/home/developer/a ' b",
      env: { WMUX_PTY_ID: 'pane-one', WMUX_DATA_SUFFIX: '-isolated', WSLENV: 'MY_VAR/p' },
      integrationDir: dir, bashInit: '# original shell integration\n',
      runtimePath: 'C:\\wmux\\wmux.exe', bridgePath: 'C:\\wmux\\wmux-bridge.mjs',
    });
    expect(injected.args.slice(0, 8)).toEqual(['--distribution', 'Ubuntu', '--user', 'developer', '--cd', "/home/developer/a ' b", '--exec', '/bin/bash']);
    expect(injected.env.WMUX_PTY_ID).toBe('pane-one');
    expect(injected.env.WMUX_DATA_SUFFIX).toBe('-isolated');
    expect(injected.env.WSLENV).toContain('MY_VAR/p:WMUX_PTY_ID:');
    expect(injected.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    const settings = JSON.parse(fs.readFileSync(injected.env.WMUX_WSL_SETTINGS, 'utf8'));
    expect(Object.keys(settings.hooks)).toEqual(['SessionStart', 'Stop', 'StopFailure']);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('/bin/sh "$WMUX_WSL_HOOK" SessionStart');
    expect(fs.readdirSync(dir)).toEqual(['wsl']);
    expect(fs.readFileSync(path.join(dir, 'wsl', 'bashrc.integration'), 'utf8')).toContain('# original shell integration');
    expect(fs.readFileSync(path.join(dir, 'wsl', 'bin', 'claude'), 'utf8')).toContain('"$real" --settings "$WMUX_WSL_SETTINGS" ${WMUX_WSL_MCP_CONFIG:+--mcp-config="$WMUX_WSL_MCP_CONFIG"} "$@"');
  });

  it('mounts the Windows wmux MCP server per launch, and skips it without a bundle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-mcp-')); dirs.push(dir);
    const base = { target: { distribution: 'Ubuntu', user: 'developer' }, cwd: '/home/developer',
      env: { WMUX_PTY_ID: 'pane-one' }, integrationDir: dir, bashInit: '',
      runtimePath: 'C:\\wmux\\wmux.exe', bridgePath: 'C:\\wmux\\wmux-bridge.mjs' };
    const injected = buildWslInjection({ ...base, mcpEntryPath: 'C:\\wmux\\mcp-bundle\\index.js' });
    expect(injected.env.WMUX_WSL_MCP).toBe('C:\\wmux\\mcp-bundle\\index.js');
    // The entry is a Windows path for the Windows runtime; the config is read by Linux claude.
    expect(injected.env.WSLENV).toContain('WMUX_WSL_MCP/u:WMUX_WSL_MCP_CONFIG/p');
    const config = JSON.parse(fs.readFileSync(injected.env.WMUX_WSL_MCP_CONFIG, 'utf8'));
    expect(Object.keys(config.mcpServers)).toEqual(['wmux']);
    expect(config.mcpServers.wmux.command).toBe('/bin/sh');
    expect(config.mcpServers.wmux.args[1]).toContain('exec "$WMUX_WSL_NODE" "$WMUX_WSL_MCP"');

    const skipped = buildWslInjection({ ...base, integrationDir: path.join(dir, 'none'), mcpEntryPath: null });
    expect(skipped.env).not.toHaveProperty('WMUX_WSL_MCP_CONFIG');
    expect(skipped.env.WSLENV).not.toContain('WMUX_WSL_MCP');
    expect(fs.existsSync(path.join(dir, 'none', 'wsl', 'claude-mcp.json'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('launches the MCP entry in Electron node mode without leaking it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-mcp-run-')); dirs.push(dir);
    const injected = buildWslInjection({ target: { distribution: 'test', user: 'test' }, cwd: dir,
      env: {}, integrationDir: dir, bashInit: '', runtimePath: '/unused', bridgePath: '/unused', mcpEntryPath: '/entry.js' });
    const fakeNode = path.join(dir, 'fake-node');
    fs.writeFileSync(fakeNode, '#!/bin/sh\nprintf "%s|%s|%s|%s|%s" "$ELECTRON_RUN_AS_NODE" "$WSLENV" "$WMUX_WSL_DISTRO" "$WMUX_WSL_MOUNT" "$*"\n', { mode: 0o755 });
    const fakeBin = path.join(dir, 'fake-bin'); fs.mkdirSync(fakeBin);
    // wslpath only exists inside WSL; stand in with what it answers for C:\.
    fs.writeFileSync(path.join(fakeBin, 'wslpath'), '#!/bin/sh\nprintf "%s|" "$@" > "$0.args"; printf "/mnt/c/"\n', { mode: 0o755 });
    const { args } = JSON.parse(fs.readFileSync(injected.env.WMUX_WSL_MCP_CONFIG, 'utf8')).mcpServers.wmux;
    const out = execFileSync('/bin/sh', args, { encoding: 'utf8',
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, WMUX_WSL_NODE: fakeNode, WMUX_WSL_MCP: '/entry.js', WSLENV: 'WMUX_PTY_ID', WSL_DISTRO_NAME: 'Ubuntu' } });
    expect(out).toBe('1|WMUX_PTY_ID:ELECTRON_RUN_AS_NODE/w:WMUX_WSL_DISTRO/w:WMUX_WSL_MOUNT/w|Ubuntu|/mnt/c/|/entry.js');
    expect(fs.readFileSync(path.join(fakeBin, 'wslpath.args'), 'utf8')).toBe('-u|C:\\|');
  });
  it.skipIf(process.platform === 'win32')('exec units skip noisy interactive startup files and diagnose missing cwd transport', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-exec-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, '.bashrc'), 'echo UNEXPECTED_BASHRC_OUTPUT\n');
    const injected = buildWslInjection({ target: { distribution: 'test', user: 'test' }, cwd: dir,
      env: { HOME: dir, PATH: '/usr/bin:/bin' }, integrationDir: dir, bashInit: BASH_INIT,
      runtimePath: process.execPath, bridgePath: '/unused', execCommand: 'printf "clean-output"' });
    const bashArgs = injected.args.slice(injected.args.indexOf('/bin/bash') + 1);
    expect(execFileSync('/bin/bash', bashArgs, { encoding: 'utf8', env: injected.env })).toBe('clean-output');
    try {
      execFileSync('/bin/bash', bashArgs, { env: { ...injected.env, WMUX_WSL_CWD: '' }, stdio: 'pipe' });
      throw new Error('expected failure');
    } catch (error) {
      expect(String((error as { stderr?: Buffer }).stderr)).toContain('check the directory and WSLENV transport');
    }
  });

  // #1305 — the other half of "exec units skip noisy interactive startup
  // files": skipping them also skips the PATH they set, and an nvm-installed
  // claude lives nowhere else. The shim answered 127 for a claude that works
  // in every interactive pane.
  describe.skipIf(process.platform === 'win32')('the claude shim resolves an interactive-only PATH (#1305)', () => {
    /** A HOME whose claude exists only under a directory its `.bashrc` adds. */
    function homeWithInteractiveClaude(): { dir: string; env: Record<string, string> } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-shim-')); dirs.push(dir);
      const injected = buildWslInjection({
        target: { distribution: 'test', user: 'test' }, cwd: dir,
        env: { HOME: dir, PATH: '/usr/bin:/bin' }, integrationDir: dir, bashInit: BASH_INIT,
        runtimePath: process.execPath, bridgePath: '/unused', execCommand: 'claude --help',
      });
      return {
        dir,
        env: {
          HOME: dir,
          // Exactly what an exec pane has: the shim in front, and nothing the
          // user's startup files would have added.
          PATH: `${injected.env.WMUX_WSL_BIN}:/usr/bin:/bin`,
          WMUX_WSL_BIN: injected.env.WMUX_WSL_BIN,
          WMUX_WSL_SETTINGS: injected.env.WMUX_WSL_SETTINGS,
        },
      };
    }

    const shimOf = (dir: string) => path.join(dir, 'wsl', 'bin', 'claude');

    it('finds it, and no startup banner reaches the pane or the lookup', () => {
      const { dir, env } = homeWithInteractiveClaude();
      const nvmBin = path.join(dir, 'nvm-bin'); fs.mkdirSync(nvmBin);
      fs.writeFileSync(path.join(nvmBin, 'claude'), '#!/bin/sh\nprintf "claude ran: %s" "$*"\n', { mode: 0o755 });
      // No trailing newline on the banner: the marker line has to start itself.
      fs.writeFileSync(path.join(dir, '.bashrc'), `printf 'MOTD banner'\nexport PATH="${nvmBin}:$PATH"\n`);

      const out = execFileSync('/bin/sh', [shimOf(dir), '--help'], { encoding: 'utf8', env });

      expect(out).toBe(`claude ran: --settings ${env.WMUX_WSL_SETTINGS} --help`);
      expect(out).not.toContain('MOTD banner');
    });

    // #1721 — a real pane has a controlling terminal; CI does not, so the test
    // above passed while every real pane waited out the 10 s bound and then got
    // 127. `script` gives the shim a pty of its own. util-linux `script` only:
    // BSD `script` (macOS) takes different arguments.
    const hasUtilLinuxScript = process.platform === 'linux'
      && spawnSync('script', ['--version'], { encoding: 'utf8' }).stdout?.includes('util-linux');
    it.runIf(hasUtilLinuxScript)('finds it promptly under a controlling terminal', () => {
      const { dir, env } = homeWithInteractiveClaude();
      const nvmBin = path.join(dir, 'nvm-bin'); fs.mkdirSync(nvmBin);
      fs.writeFileSync(path.join(nvmBin, 'claude'), '#!/bin/sh\nprintf "claude ran: %s" "$*"\n', { mode: 0o755 });
      fs.writeFileSync(path.join(dir, '.bashrc'), `export PATH="${nvmBin}:$PATH"\n`);

      const started = Date.now();
      const out = execFileSync('script', ['-qec', `/bin/sh ${shimOf(dir)} --help`, '/dev/null'], {
        encoding: 'utf8', env, timeout: 20_000, killSignal: 'SIGKILL',
      });

      expect(out).toContain(`claude ran: --settings ${env.WMUX_WSL_SETTINGS} --help`);
      // Stopped on the terminal, the lookup only ends at the 10 s KILL.
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    // --mcp-config is variadic in claude's parser: passed as two words it would
    // also take the user's prompt as a config path.
    it('passes the MCP config as one = argument, leaving the prompt alone', () => {
      const { dir, env } = homeWithInteractiveClaude();
      const bin = path.join(dir, 'claude-bin'); fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 });
      const config = path.join(dir, 'mcp dir', 'claude-mcp.json');
      const out = execFileSync('/bin/sh', [shimOf(dir), 'fix the bug'], { encoding: 'utf8',
        env: { ...env, PATH: `${env.PATH}:${bin}`, WMUX_WSL_MCP_CONFIG: config } });
      expect(out).toBe(`--settings|${env.WMUX_WSL_SETTINGS}|--mcp-config=${config}|fix the bug|`);
    });

    // The lookup is BOUNDED, and the bound is the KILL, not the TERM: an
    // interactive bash ignores SIGTERM. Measured here — with a plain `timeout`
    // a startup file that goes back to waiting keeps the pane hanging past the
    // budget; the follow-up KILL ends it and the honest 127 is reached
    // (review: CodeRabbit). The fake `timeout` proves the shim actually routes
    // through it, with a test-sized budget so nothing waits out the real one.
    it('gives up on a startup file that hangs, instead of hanging the pane', () => {
      const { dir, env } = homeWithInteractiveClaude();
      const nvmBin = path.join(dir, 'nvm-bin'); fs.mkdirSync(nvmBin);
      fs.writeFileSync(path.join(nvmBin, 'claude'), '#!/bin/sh\nprintf "claude ran"\n', { mode: 0o755 });
      // Installed and reachable in principle — and never reached, because
      // getting there means outliving a startup file that does not stop for a
      // TERM.
      fs.writeFileSync(path.join(dir, '.bashrc'), `while :; do sleep 1; done\nexport PATH="${nvmBin}:$PATH"\n`);
      const fakeBin = path.join(dir, 'fake-bin'); fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        path.join(fakeBin, 'timeout'),
        // Keeps the shim's FLAGS and shrinks only its budget, so a shim that
        // stopped passing -k would run unbounded here and hang this test —
        // which is the regression worth catching.
        '#!/bin/sh\nkflag=\n'
          + 'while [ $# -gt 0 ] && [ "$1" != "/bin/bash" ]; do\n'
          + '  if [ "$1" = "-k" ]; then kflag="-k 1"; shift; fi\n'
          + '  shift\n'
          + 'done\n'
          + 'exec /usr/bin/timeout $kflag 1 "$@"\n',
        { mode: 0o755 },
      );

      const started = Date.now();
      try {
        execFileSync('/bin/sh', [shimOf(dir), '--help'], {
          env: { ...env, PATH: `${fakeBin}:${env.PATH}` },
          stdio: 'pipe',
          // A shim that lost its bound would hang this call, and execFileSync
          // is synchronous — vitest cannot interrupt it, so the whole file
          // would stall instead of failing. Kill it here and let the
          // assertions below report what went wrong.
          timeout: 20_000,
          killSignal: 'SIGKILL',
        });
        throw new Error('expected failure');
      } catch (error) {
        expect((error as { status?: number }).status).toBe(127);
        expect(String((error as { stderr?: Buffer }).stderr))
          .toContain('claude is not installed in this WSL distribution');
      }
      // The startup file never ends on its own; anything slow here means the
      // pane was waiting on it rather than on the bound.
      expect(Date.now() - started).toBeLessThan(15_000);
    });

    it('still says so when claude is installed nowhere', () => {
      const { dir, env } = homeWithInteractiveClaude();
      fs.writeFileSync(path.join(dir, '.bashrc'), 'export PATH="/usr/bin:/bin"\n');

      try {
        execFileSync('/bin/sh', [shimOf(dir), '--help'], { env, stdio: 'pipe' });
        throw new Error('expected failure');
      } catch (error) {
        expect((error as { status?: number }).status).toBe(127);
        expect(String((error as { stderr?: Buffer }).stderr))
          .toContain('claude is not installed in this WSL distribution');
      }
    });
  });

});
