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
});
