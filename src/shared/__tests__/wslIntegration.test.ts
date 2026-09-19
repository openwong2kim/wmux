import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWslInjection } from '../wslIntegration';
import { execFileSync } from 'node:child_process';
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
    expect(fs.readFileSync(path.join(dir, 'wsl', 'bin', 'claude'), 'utf8')).toContain('"$real" --settings "$WMUX_WSL_SETTINGS" "$@"');
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
