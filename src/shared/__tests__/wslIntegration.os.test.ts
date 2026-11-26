import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { accountHomeWslFlags, buildWslInjection, WSL_ACCOUNT_SH, WSL_CLAUDE_SHIM, WSL_HOOK, WSL_STATUSLINE, wslClaudeHooks } from '../wslIntegration';
import { ACCOUNT_SHARE_MARKER, wslAccountHomeKey } from '../wslAccountHome';
import { HOOK_SPECS } from '../../cli/commands/setupHooks';
import { parseWslAgentReport, pickReportedAgent } from '../../daemon/wslAgentProcess';
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

  it.skipIf(process.platform === 'win32')('a task pane gets its worktree\'s Linux git location after the user\'s rc files (#2231)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-test-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, '.bashrc'), 'export GIT_DIR=/user/rc GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=me\n');
    const injected = buildWslInjection({
      target: { distribution: 'test', user: 'test' }, cwd: dir,
      env: { HOME: dir, PATH: '/usr/bin:/bin', WMUX_WSL_GIT_DIR: '/mnt/d/r/.git/worktrees/t-1', WMUX_WSL_GIT_WORK_TREE: '/mnt/c/w/t-1',
        WMUX_WSL_GIT_AUTOCRLF: 'true', WSLENV: 'WMUX_WSL_GIT_DIR/u:WMUX_WSL_GIT_WORK_TREE/u:WMUX_WSL_GIT_AUTOCRLF/u' },
      integrationDir: dir, bashInit: BASH_INIT, runtimePath: process.execPath, bridgePath: '/unused-bridge',
    });
    // The pane's own WSLENV entries survive the injection's.
    expect(injected.env.WSLENV.split(':')).toEqual(expect.arrayContaining(['WMUX_WSL_GIT_DIR/u', 'WMUX_WSL_GIT_WORK_TREE/u', 'WMUX_WSL_GIT_AUTOCRLF/u', 'WMUX_WSL_CWD/u']));
    const output = execFileSync('/bin/bash', ['-c', '. "$WMUX_WSL_BASHRC"; printf "%s\\0" "$GIT_DIR" "$GIT_WORK_TREE" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_1" "$GIT_CONFIG_VALUE_1" "$GIT_CONFIG_KEY_0"'], {
      encoding: 'utf8', env: injected.env,
    }).split('\0');
    expect(output.slice(0, 6)).toEqual(['/mnt/d/r/.git/worktrees/t-1', '/mnt/c/w/t-1', '2', 'core.autocrlf', 'true', 'user.name']);
  });

  it('a task pane\'s workspace-trust skip reaches Linux claude; an ordinary pane keeps the dialog (#2231)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-test-')); dirs.push(dir);
    const build = (env: Record<string, string>) => buildWslInjection({
      target: { distribution: 'test', user: 'test' }, cwd: dir, env: { HOME: dir, PATH: '/usr/bin:/bin', ...env },
      integrationDir: dir, bashInit: BASH_INIT, runtimePath: process.execPath, bridgePath: '/unused-bridge',
    }).env.WSLENV.split(':');
    expect(build({ CLAUDE_CODE_SANDBOXED: '1' })).toContain('CLAUDE_CODE_SANDBOXED/u');
    expect(build({}).some((e) => e.startsWith('CLAUDE_CODE_SANDBOXED'))).toBe(false);
  });

  it('a worker pane\'s DISABLE_AUTOUPDATER reaches Linux claude; an ordinary pane\'s env is not sent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-test-')); dirs.push(dir);
    const build = (env: Record<string, string>) => buildWslInjection({
      target: { distribution: 'test', user: 'test' }, cwd: dir, env: { HOME: dir, PATH: '/usr/bin:/bin', ...env },
      integrationDir: dir, bashInit: BASH_INIT, runtimePath: process.execPath, bridgePath: '/unused-bridge',
    }).env.WSLENV.split(':');
    expect(build({ CLAUDE_CODE_SANDBOXED: '1', DISABLE_AUTOUPDATER: '1' })).toContain('DISABLE_AUTOUPDATER/u');
    expect(build({ CLAUDE_CODE_SANDBOXED: '1', DISABLE_AUTOUPDATER: '0' })).toContain('DISABLE_AUTOUPDATER/u');
    expect(build({ DISABLE_AUTOUPDATER: '1' }).some((e) => e.startsWith('DISABLE_AUTOUPDATER'))).toBe(false);
    expect(build({ CLAUDE_CODE_SANDBOXED: '1' }).some((e) => e.startsWith('DISABLE_AUTOUPDATER'))).toBe(false);
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
    // #1730 — the same events and matchers a Windows pane registers (setupHooks.ts).
    expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'PermissionRequest', 'PostToolUse', 'PreToolUse',
      'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'SubagentStop', 'UserPromptSubmit']);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('/bin/sh "$WMUX_WSL_HOOK" SessionStart');
    expect(settings.hooks.PreToolUse.map((g: { matcher: string; hooks: Array<{ command: string; timeout: number }> }) =>
      [g.matcher, g.hooks[0].command, g.hooks[0].timeout])).toEqual([
      ['AskUserQuestion', '/bin/sh "$WMUX_WSL_HOOK" PreToolUse', 10],
      ['', '/bin/sh "$WMUX_WSL_HOOK" PreToolUse --permission-gate', 150],
    ]);
    expect(settings.hooks.PostToolUse[0].matcher).toBe('AskUserQuestion');
    expect(injected.env.WMUX_WSL_GATE_FLAG).toBe(path.join(dir, 'gate-armed'));
    expect(injected.env.WSLENV).toContain('WMUX_WSL_GATE_FLAG/p');
    expect(fs.readdirSync(dir)).toEqual(['wsl']);
    expect(fs.readFileSync(path.join(dir, 'wsl', 'bashrc.integration'), 'utf8')).toContain('# original shell integration');
    const shim = fs.readFileSync(path.join(dir, 'wsl', 'bin', 'claude'), 'utf8');
    expect(shim).toContain('"$real" --settings "$wmux_settings" ${mcp_config:+--mcp-config="$mcp_config"} "$@"');
    // A launch that names its own servers (a bot's worker) keeps them alone.
    expect(shim).toContain('mcp_config=${WMUX_WSL_MCP_CONFIG:-}');
    expect(shim).toContain('case $arg in --) break ;; --strict-mcp-config) mcp_config= ;; esac');
  });

  it.skipIf(process.platform === 'win32')('the claude shim leaves its own MCP config out only for a launch whose options say --strict-mcp-config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-shim-')); dirs.push(dir);
    const bin = path.join(dir, 'bin');
    const real = path.join(dir, 'real');
    fs.mkdirSync(bin); fs.mkdirSync(real);
    fs.writeFileSync(path.join(bin, 'claude'), WSL_CLAUDE_SHIM, { mode: 0o755 });
    fs.writeFileSync(path.join(real, 'claude'), '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\n', { mode: 0o755 });
    const run = (...args: string[]) => execFileSync('/bin/sh', [path.join(bin, 'claude'), ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${real}:/usr/bin:/bin`, WMUX_WSL_BIN: bin, WMUX_WSL_SETTINGS: '/s.json', WMUX_WSL_MCP_CONFIG: '/m.json' },
    });
    expect(run('--resume', 'x')).toBe('[--settings][/s.json][--mcp-config=/m.json][--resume][x]');
    expect(run('--mcp-config=/w.json', '--strict-mcp-config', '--', 'go')).toBe('[--settings][/s.json][--mcp-config=/w.json][--strict-mcp-config][--][go]');
    // The words after -- are the prompt, not options.
    expect(run('--', '--strict-mcp-config')).toBe('[--settings][/s.json][--mcp-config=/m.json][--][--strict-mcp-config]');
  });

  describe('the usage statusline in a WSL pane', () => {
    const inject = (statuslinePath?: string | null) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-sl-')); dirs.push(dir);
      return { dir, injected: buildWslInjection({
        target: { distribution: 'Ubuntu', user: 'me' }, cwd: '/home/me', env: { WMUX_PTY_ID: 'pane-one' },
        integrationDir: dir, bashInit: '', runtimePath: 'C:\\wmux\\wmux.exe', bridgePath: 'C:\\wmux\\wmux-bridge.mjs',
        ...(statuslinePath !== undefined ? { statuslinePath } : {}),
      }) };
    };

    it('adds a settings file with wmux\'s statusLine, the script Windows node opens, and its WSLENV entries', () => {
      const { injected } = inject('C:\\wmux\\wmux-statusline.mjs');
      const withLine = JSON.parse(fs.readFileSync(injected.env.WMUX_WSL_SETTINGS_STATUSLINE, 'utf8'));
      expect(withLine.statusLine).toEqual({ type: 'command', command: '/bin/sh "$WMUX_WSL_STATUSLINE_SH"', padding: 0 });
      expect(withLine.hooks).toEqual(wslClaudeHooks());
      // The plain one keeps hooks only.
      expect(JSON.parse(fs.readFileSync(injected.env.WMUX_WSL_SETTINGS, 'utf8')).statusLine).toBeUndefined();
      expect(fs.readFileSync(injected.env.WMUX_WSL_STATUSLINE_SH, 'utf8')).toBe(WSL_STATUSLINE);
      expect(injected.env.WMUX_WSL_STATUSLINE).toBe('C:\\wmux\\wmux-statusline.mjs');
      expect(injected.env.WSLENV.split(':')).toEqual(expect.arrayContaining([
        'WMUX_WSL_STATUSLINE/u', 'WMUX_WSL_STATUSLINE_SH/p', 'WMUX_WSL_SETTINGS_STATUSLINE/p', 'WMUX_PTY_ID', 'WMUX_DATA_SUFFIX',
      ]));
      // The account's Windows folder never crosses for the statusline.
      expect(injected.env.WSLENV.split(':').some((e) => e.startsWith('CLAUDE_CONFIG_DIR'))).toBe(false);
    });

    it('adds nothing when the script does not ship', () => {
      const { injected } = inject(null);
      expect(injected.env.WMUX_WSL_SETTINGS_STATUSLINE).toBeUndefined();
      expect(injected.env.WSLENV).not.toContain('STATUSLINE');
    });

    it.skipIf(process.platform === 'win32')('runs Windows node with the Linux config dir as is (/w, never translated), or none when unset', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-sl-run-')); dirs.push(dir);
      const node = path.join(dir, 'node');
      fs.writeFileSync(node, '#!/bin/sh\nprintf "%s|%s|%s|%s" "$1" "$ELECTRON_RUN_AS_NODE" "$WMUX_STATUSLINE_CONFIG_DIR" "$WSLENV"\n', { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'statusline.sh'), WSL_STATUSLINE);
      const run = (extra: Record<string, string>) => execFileSync('/bin/sh', [path.join(dir, 'statusline.sh')], {
        encoding: 'utf8', env: { PATH: '/usr/bin:/bin', WMUX_WSL_NODE: node, WMUX_WSL_STATUSLINE: 'C:\\wmux\\wmux-statusline.mjs', WSLENV: 'WMUX_PTY_ID', ...extra },
      });
      expect(run({ CLAUDE_CONFIG_DIR: '/home/me/.wmux/accounts/claude-0123456789abcdef' }))
        .toBe('C:\\wmux\\wmux-statusline.mjs|1|d:/home/me/.wmux/accounts/claude-0123456789abcdef|WMUX_PTY_ID:ELECTRON_RUN_AS_NODE/w:WMUX_STATUSLINE_CONFIG_DIR/w');
      expect(run({}).split('|')[2]).toBe('none');
      // A relative one is made absolute against the working folder.
      expect(execFileSync('/bin/sh', [path.join(dir, 'statusline.sh')], {
        encoding: 'utf8', cwd: dir, env: { PATH: '/usr/bin:/bin', WMUX_WSL_NODE: node, WMUX_WSL_STATUSLINE: 's', CLAUDE_CONFIG_DIR: './cfg', PWD: dir },
      }).split('|')[2]).toBe(`d:${dir}/./cfg`);
      // Without the Windows side's paths it is silent.
      expect(execFileSync('/bin/sh', [path.join(dir, 'statusline.sh')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })).toBe('');
    });

    it.skipIf(process.platform === 'win32')('the claude shim takes the statusLine settings only when the user\'s and the project\'s settings set none', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-sl-shim-')); dirs.push(dir);
      const bin = path.join(dir, 'bin'); const real = path.join(dir, 'real'); const home = path.join(dir, 'home'); const project = path.join(dir, 'project');
      for (const d of [bin, real, path.join(home, '.claude'), path.join(project, '.claude')]) fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(bin, 'claude'), WSL_CLAUDE_SHIM, { mode: 0o755 });
      fs.writeFileSync(path.join(real, 'claude'), '#!/bin/sh\nprintf "%s" "$2"\n', { mode: 0o755 });
      const run = (extra: Record<string, string> = {}) => execFileSync('/bin/sh', [path.join(bin, 'claude')], {
        encoding: 'utf8', cwd: project,
        env: { PATH: `${bin}:${real}:/usr/bin:/bin`, HOME: home, WMUX_WSL_BIN: bin, WMUX_WSL_SETTINGS: '/plain.json', WMUX_WSL_SETTINGS_STATUSLINE: '/line.json', ...extra },
      });
      expect(run()).toBe('/line.json');
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"statusLine":{"type":"command","command":"mine"}}');
      expect(run()).toBe('/plain.json');
      // An account home's own settings decide for a pane on that account.
      const account = path.join(dir, 'account'); fs.mkdirSync(account);
      expect(run({ CLAUDE_CONFIG_DIR: account })).toBe('/line.json');
      fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), '{"statusLine":{"type":"command","command":"proj"}}');
      expect(run({ CLAUDE_CONFIG_DIR: account })).toBe('/plain.json');
      // No statusLine settings (the script missing): the plain one.
      expect(run({ WMUX_WSL_SETTINGS_STATUSLINE: '' })).toBe('/plain.json');
    });
  });

  describe('account homes across the Windows/WSL boundary', () => {
    function inject(env: Record<string, string>, wslAccountLoginEnvKey?: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME') {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-account-')); dirs.push(dir);
      return buildWslInjection({
        target: { distribution: 'Ubuntu', user: 'developer' }, cwd: '/home/developer',
        env, integrationDir: dir, bashInit: '', mcpEntryPath: null, wslAccountLoginEnvKey,
      });
    }

    it.each(['CODEX_HOME', 'CLAUDE_CONFIG_DIR'])('transports a selected Windows %s and translates its path', (key) => {
      const home = "C:\\account profiles\\it's selected";
      const env = { [key]: home, WSLENV: `MY_VAR/p:${key}/w` };
      const injected = inject(env, key === 'CODEX_HOME' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR');
      expect(injected.env[key]).toBe(home);
      expect(injected.env.WSLENV.split(':')).toContain(`${key}/pu`);
      expect(injected.env.WSLENV.split(':')).not.toContain(`${key}/w`);
      expect(injected.env.WSLENV.split(':')).toContain('MY_VAR/p');
      expect(env.WSLENV).toBe(`MY_VAR/p:${key}/w`);
    });

    it.each(['CODEX_HOME', 'CLAUDE_CONFIG_DIR'])('preserves an explicit Linux %s without path translation', (key) => {
      const home = "/home/developer/account profiles/it's selected";
      const injected = inject({ [key]: home, WSLENV: `${key}/p:OTHER/u` }, key === 'CODEX_HOME' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR');
      expect(injected.env[key]).toBe(home);
      expect(injected.env.WSLENV.split(':')).toContain(`${key}/u`);
      expect(injected.env.WSLENV.split(':')).not.toContain(`${key}/p`);
      expect(injected.env.WSLENV.split(':')).toContain('OTHER/u');
    });

    it.each([
      'D:/account profiles/selected',
      '\\\\wsl.localhost\\Ubuntu\\home\\developer\\selected',
      '\\\\wsl$\\ubuntu\\home\\developer\\selected',
      '//wsl.localhost/Ubuntu/home/developer/selected',
    ])('translates the Windows path %s', (home) => {
      const injected = inject({ CODEX_HOME: home }, 'CODEX_HOME');
      expect(injected.env.WSLENV.split(':')).toContain('CODEX_HOME/pu');
      expect(injected.env.WMUX_WSL_ACCOUNT_HOME_UNREACHABLE).toBeUndefined();
    });

    // #2202: WSL cannot translate these, prints "Failed to translate" into the
    // tab and drops the variable, so the login would land in the default home.
    it.each([
      '\\\\server\\share\\selected',
      '//server/share/selected',
      '\\\\wsl.localhost\\Debian\\home\\developer\\selected',
      '\\\\wsl$\\Ubuntu-24.04\\home\\developer\\selected',
    ])('does not forward the untranslatable path %s and tells the tab why', (home) => {
      const injected = inject({ CODEX_HOME: home, WSLENV: 'MY_VAR/p:CODEX_HOME/p' }, 'CODEX_HOME');
      const wslenv = injected.env.WSLENV.split(':');
      expect(wslenv.some((entry) => entry.split('/')[0] === 'CODEX_HOME')).toBe(false);
      expect(wslenv).toContain('MY_VAR/p');
      expect(wslenv).toContain('WMUX_WSL_ACCOUNT_HOME_UNREACHABLE');
      expect(injected.env.WMUX_WSL_ACCOUNT_HOME_UNREACHABLE).toBe(`CODEX_HOME (${home})`);
      expect(injected.env.CODEX_HOME).toBe(home);
    });

    it('maps account home shapes to WSLENV flags', () => {
      expect(accountHomeWslFlags('C:\\accounts\\one', 'Ubuntu')).toBe('pu');
      expect(accountHomeWslFlags('/home/developer/one', 'Ubuntu')).toBe('u');
      expect(accountHomeWslFlags('\\\\WSL.LOCALHOST\\UBUNTU\\home', 'Ubuntu')).toBe('pu');
      expect(accountHomeWslFlags('\\\\wsl.localhost\\Ubuntu', 'Ubuntu')).toBe('pu');
      expect(accountHomeWslFlags('\\\\wsl.localhost\\UbuntuX\\home', 'Ubuntu')).toBeNull();
      expect(accountHomeWslFlags('\\\\server\\share', 'Ubuntu')).toBeNull();
    });

    it.each(['claude', 'codex'] as const)('keeps two %s logins on their selected accounts without transferring the other vendor', (vendor) => {
      const first = inject({ CODEX_HOME: 'C:\\accounts\\one', CLAUDE_CONFIG_DIR: '/home/developer/claude-one' }, vendor === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR');
      const second = inject({ CODEX_HOME: 'C:\\accounts\\two', CLAUDE_CONFIG_DIR: '/home/developer/claude-two' }, vendor === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR');
      expect(first.env.CODEX_HOME).toBe('C:\\accounts\\one');
      expect(second.env.CODEX_HOME).toBe('C:\\accounts\\two');
      expect(first.env.CLAUDE_CONFIG_DIR).toBe('/home/developer/claude-one');
      expect(second.env.CLAUDE_CONFIG_DIR).toBe('/home/developer/claude-two');
      for (const launched of [first, second]) {
        expect(launched.env.WSLENV.split(':')).toContain(vendor === 'codex' ? 'CODEX_HOME/pu' : 'CLAUDE_CONFIG_DIR/u');
        expect(launched.env.WSLENV.split(':')).not.toContain(vendor === 'codex' ? 'CLAUDE_CONFIG_DIR/u' : 'CODEX_HOME/pu');
      }
    });

    it.each<Record<string, string>>([{}, { CODEX_HOME: '', CLAUDE_CONFIG_DIR: '' }])('does not introduce absent or empty account homes', (env) => {
      for (const vendor of ['claude', 'codex'] as const) {
        const injected = inject(env, vendor === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR');
        expect(injected.env.WSLENV.split(':').some((entry) => ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(entry.split('/')[0]))).toBe(false);
      }
    });

    it.each(['C:\\accounts\\windows', '/home/developer/linux-profile'])(
      'does not opt an ordinary pane into either account home (%s)', (home) => {
        const env = { CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, WSLENV: 'MY_VAR/p' };
        const injected = inject(env);
        expect(injected.env.WSLENV.split(':').some((entry) => /^(CODEX_HOME|CLAUDE_CONFIG_DIR)(\/|$)/.test(entry))).toBe(false);
        expect(injected.env.CODEX_HOME).toBe(home);
        expect(injected.env.CLAUDE_CONFIG_DIR).toBe(home);
        expect(injected.env.WSLENV.split(':')).toContain('MY_VAR/p');
        expect(env.WSLENV).toBe('MY_VAR/p');
      },
    );

    it('retains a user-supplied account WSLENV entry without opting in another vendor', () => {
      const injected = inject({ CODEX_HOME: 'C:\\accounts\\manual', CLAUDE_CONFIG_DIR: 'C:\\accounts\\inherited', WSLENV: 'CODEX_HOME/p:MY_VAR/u' });
      expect(injected.env.WSLENV.split(':')).toContain('CODEX_HOME/p');
      expect(injected.env.WSLENV.split(':').some((entry) => entry.startsWith('CLAUDE_CONFIG_DIR/'))).toBe(false);
    });

    it('ignores an unsupported account key from an untyped IPC caller', () => {
      const injected = inject({ CODEX_HOME: 'C:\\accounts\\bound', OTHER_CONFIG_DIR: 'C:\\accounts\\other' }, 'OTHER_CONFIG_DIR' as 'CODEX_HOME');
      expect(injected.env.WSLENV.split(':').some((entry) => /^(CODEX_HOME|OTHER_CONFIG_DIR)(\/|$)/.test(entry))).toBe(false);
    });
  });

  // A bound workspace's account runs on its own home in the distro: only its
  // key crosses over, never the Windows folder (shared/wslAccountHome.ts).
  describe('bound account homes in WSL', () => {
    function inject(env: Record<string, string>, opts: { login?: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'; exec?: string } = {}) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-bound-')); dirs.push(dir);
      const injected = buildWslInjection({
        target: { distribution: 'Ubuntu', user: 'developer' }, cwd: '/home/developer',
        env, integrationDir: dir, bashInit: '', mcpEntryPath: null, wslAccountLoginEnvKey: opts.login, execCommand: opts.exec,
      });
      return { ...injected, dir, wslenv: injected.env.WSLENV.split(':') };
    }

    it('sends each marked account as its key, and the account folder never', () => {
      const env = { CLAUDE_CONFIG_DIR: 'C:\\accounts\\work', CODEX_HOME: 'C:\\accounts\\codex', WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR,CODEX_HOME' };
      const { env: out, wslenv, dir } = inject(env);
      expect(out.WMUX_WSL_ACCOUNT_CLAUDE).toBe(wslAccountHomeKey('C:\\accounts\\work'));
      expect(out.WMUX_WSL_ACCOUNT_CODEX).toBe(wslAccountHomeKey('C:\\accounts\\codex'));
      expect(wslenv).toEqual(expect.arrayContaining(['WMUX_WSL_ACCOUNT_CLAUDE', 'WMUX_WSL_ACCOUNT_CODEX', 'WMUX_WSL_ACCOUNT_SH/p']));
      expect(wslenv.some((entry) => /^(CODEX_HOME|CLAUDE_CONFIG_DIR)(\/|$)/.test(entry))).toBe(false);
      expect(out.WMUX_WSL_ACCOUNT_SH).toBe(path.join(dir, 'wsl', 'account.sh'));
      expect(fs.readFileSync(out.WMUX_WSL_ACCOUNT_SH, 'utf8')).toBe(WSL_ACCOUNT_SH);
      expect(out.WMUX_WSL_ACCOUNT_CLAUDE_SHARE).toBeUndefined();
      // The distro names the pane's sign-in key; it stays on the Windows side.
      expect(out.WMUX_WSL_ACCOUNT_DISTRO).toBe('Ubuntu');
      expect(wslenv.some((entry) => entry.startsWith('WMUX_WSL_ACCOUNT_DISTRO'))).toBe(false);
    });

    it('leaves an unmarked account variable (a profile\'s or an inherited one) alone', () => {
      const { env: out, wslenv } = inject({ CLAUDE_CONFIG_DIR: 'C:\\profile\\claude', CODEX_HOME: 'C:\\accounts\\codex', WMUX_WSL_ACCOUNT_KEYS: 'CODEX_HOME' });
      expect(out.WMUX_WSL_ACCOUNT_CLAUDE).toBeUndefined();
      expect(out.WMUX_WSL_ACCOUNT_CODEX).toBe(wslAccountHomeKey('C:\\accounts\\codex'));
      expect(wslenv).not.toContain('WMUX_WSL_ACCOUNT_CLAUDE');
    });

    it('lets a Settings login tab keep the Windows folder for its own variable', () => {
      const env = { CLAUDE_CONFIG_DIR: 'C:\\accounts\\work', CODEX_HOME: 'C:\\accounts\\codex', WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR,CODEX_HOME' };
      const { env: out, wslenv } = inject(env, { login: 'CLAUDE_CONFIG_DIR' });
      expect(wslenv).toContain('CLAUDE_CONFIG_DIR/pu');
      expect(out.WMUX_WSL_ACCOUNT_CLAUDE).toBeUndefined();
      expect(out.WMUX_WSL_ACCOUNT_CODEX).toBe(wslAccountHomeKey('C:\\accounts\\codex'));
    });

    it('redoes a recovered pane\'s replayed account variables from its mark', () => {
      const replayed = {
        CLAUDE_CONFIG_DIR: 'C:\\accounts\\work', WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR',
        WMUX_WSL_ACCOUNT_CLAUDE: '0000000000000000', WMUX_WSL_ACCOUNT_CLAUDE_SHARE: '1', WMUX_WSL_ACCOUNT_CODEX: '1111111111111111',
        WSLENV: 'WMUX_WSL_ACCOUNT_CLAUDE:WMUX_WSL_ACCOUNT_CLAUDE_SHARE:WMUX_WSL_ACCOUNT_CODEX',
      };
      const { env: out, wslenv } = inject(replayed);
      expect(out.WMUX_WSL_ACCOUNT_CLAUDE).toBe(wslAccountHomeKey('C:\\accounts\\work'));
      expect(out.WMUX_WSL_ACCOUNT_CLAUDE_SHARE).toBeUndefined();
      expect(out.WMUX_WSL_ACCOUNT_CODEX).toBeUndefined();
      // Only this spawn's names stay in WSLENV.
      expect(wslenv).toContain('WMUX_WSL_ACCOUNT_CLAUDE');
      expect(wslenv).not.toContain('WMUX_WSL_ACCOUNT_CLAUDE_SHARE');
      expect(wslenv).not.toContain('WMUX_WSL_ACCOUNT_CODEX');
    });

    it('marks a shared account folder (a linked skills folder) for mirroring', () => {
      const account = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-share-')); dirs.push(account);
      const source = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-share-src-')); dirs.push(source);
      fs.symlinkSync(source, path.join(account, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
      const { env: out, wslenv } = inject({ CLAUDE_CONFIG_DIR: account, WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR' });
      expect(out.WMUX_WSL_ACCOUNT_CLAUDE_SHARE).toBe('1');
      expect(wslenv).toContain('WMUX_WSL_ACCOUNT_CLAUDE_SHARE');
    });

    it('marks an account folder created with sharing on, even with nothing linked', () => {
      const account = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-sharemark-')); dirs.push(account);
      fs.writeFileSync(path.join(account, ACCOUNT_SHARE_MARKER), '');
      expect(inject({ CODEX_HOME: account, WMUX_WSL_ACCOUNT_KEYS: 'CODEX_HOME' }).env.WMUX_WSL_ACCOUNT_CODEX_SHARE).toBe('1');
    });

    it('adds nothing for an unbound pane', () => {
      const { env: out, wslenv } = inject({ CLAUDE_CONFIG_DIR: 'C:\\inherited' });
      expect(out.WMUX_WSL_ACCOUNT_SH).toBeUndefined();
      expect(wslenv.some((entry) => entry.startsWith('WMUX_WSL_ACCOUNT'))).toBe(false);
    });

    it('sets up the account before an exec unit\'s command and fails the run when it cannot', () => {
      const { args } = inject({ CLAUDE_CONFIG_DIR: 'C:\\accounts\\work', WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR' }, { exec: 'claude' });
      const bootstrap = args[args.indexOf('-c') + 1];
      expect(bootstrap).toContain('. "$WMUX_WSL_ACCOUNT_SH" exec || exit 1\nfi\neval "$1"');
    });

    // The bootstrap and rc file around the script, in a real bash (review of #3418).
    describe.skipIf(process.platform === 'win32')('around the user\'s startup files', () => {
      // Node's stdio pipes are sockets, and `bash -c` on a socket stdin takes
      // itself for a remote shell and sources ~/.bashrc before the command,
      // which would run the user's file ahead of the rc under test. A real
      // pane's stdin is a terminal.
      const NO_STDIN: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];
      function pane(bashrc: string, opts: { exec?: string; integration?: '0' | '1' } = {}) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-rc-')); dirs.push(dir);
        fs.writeFileSync(path.join(dir, '.bashrc'), bashrc);
        const injected = buildWslInjection({
          target: { distribution: 'test', user: 'test' }, cwd: dir, execCommand: opts.exec,
          env: { HOME: dir, PATH: '/usr/bin:/bin', WMUX_SHELL_INTEGRATION: opts.integration ?? '1', CLAUDE_CONFIG_DIR: 'C:\\accounts\\work', WMUX_WSL_ACCOUNT_KEYS: 'CLAUDE_CONFIG_DIR' },
          integrationDir: dir, bashInit: BASH_INIT, runtimePath: process.execPath, bridgePath: '/unused-bridge', mcpEntryPath: null,
        });
        const home = path.join(dir, '.wmux', 'accounts', `claude-${wslAccountHomeKey('C:\\accounts\\work')}`);
        return { dir, home, env: injected.env, bashArgs: injected.args.slice(injected.args.indexOf('/bin/bash') + 1) };
      }

      it.each(['0', '1'] as const)('hands the account to a shell the user\'s .bashrc execs (integration=%s)', (integration) => {
        const { home, env } = pane('exec /bin/sh -c \'printf "%s" "$CLAUDE_CONFIG_DIR"\'\n', { integration });
        const ran = spawnSync('/bin/bash', ['-c', '. "$WMUX_WSL_BASHRC"; printf never'], { encoding: 'utf8', env, stdio: NO_STDIN });
        expect(ran.stdout).toBe(home);
        expect(ran.stderr).toBe('');
      });

      it('wins over an export in the user\'s .bashrc and says the first-use line once', () => {
        const { home, env } = pane('export CLAUDE_CONFIG_DIR=/elsewhere\n');
        const ran = spawnSync('/bin/bash', ['-c', '. "$WMUX_WSL_BASHRC"; printf "%s|%s" "$CLAUDE_CONFIG_DIR" "${__wmux_accounts-unset}"'], { encoding: 'utf8', env, stdio: NO_STDIN });
        expect(ran.stdout).toBe(`${home}|unset`);
        expect(ran.stderr.match(/has no sign-in in this WSL distro yet/g)).toHaveLength(1);
      });

      it('says so, and never runs an exec unit, when the account script did not cross over', () => {
        const interactive = pane('');
        const { WMUX_WSL_ACCOUNT_SH: _dropped, ...dropped } = interactive.env;
        const ran = spawnSync('/bin/bash', ['-c', '. "$WMUX_WSL_BASHRC"; printf "%s" "${CLAUDE_CONFIG_DIR-}"'], { encoding: 'utf8', env: dropped, stdio: NO_STDIN });
        expect(ran.stderr).toContain('cannot reach its account script');
        const exec = pane('', { exec: 'printf ran' });
        const { WMUX_WSL_ACCOUNT_SH: _gone, ...noScript } = exec.env;
        const refused = spawnSync('/bin/bash', exec.bashArgs, { encoding: 'utf8', env: noScript, stdio: NO_STDIN });
        expect(refused.status).toBe(1);
        expect(refused.stdout).toBe('');
        expect(refused.stderr).toContain('does not run on the default account');
        const allowed = spawnSync('/bin/bash', exec.bashArgs, { encoding: 'utf8', env: exec.env, stdio: NO_STDIN });
        expect(allowed.status).toBe(0);
        expect(allowed.stdout).toBe('ran');
      });
    });

    // The script itself, in a real bash (Linux and macOS CI; Windows runs it in
    // WSL through wslAccountEnv.runtime.test.ts).
    describe.skipIf(process.platform === 'win32')('account.sh', () => {
      function source(home: string, mode: 'interactive' | 'exec', env: Record<string, string>) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-acsh-')); dirs.push(dir);
        fs.writeFileSync(path.join(dir, 'account.sh'), WSL_ACCOUNT_SH);
        return spawnSync('bash', ['--noprofile', '--norc', '-c',
          `. "$1" ${mode}; rc=$?; printf '%s|%s|%s' "$rc" "\${CLAUDE_CONFIG_DIR:-}" "\${CODEX_HOME:-}"`, 'x', path.join(dir, 'account.sh')], {
          env: { PATH: process.env.PATH ?? '', HOME: home, ...env }, encoding: 'utf8',
        });
      }
      const home = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-home-')); dirs.push(h); return h; };

      it('makes a private home per account and says once that it has no sign-in yet', () => {
        const h = home();
        const ran = source(h, 'interactive', { WMUX_DATA_SUFFIX: '-t1', WMUX_WSL_ACCOUNT_CLAUDE: 'aaaaaaaaaaaaaaaa', WMUX_WSL_ACCOUNT_CODEX: 'bbbbbbbbbbbbbbbb' });
        const claude = path.join(h, '.wmux-t1', 'accounts', 'claude-aaaaaaaaaaaaaaaa');
        expect(ran.stdout).toBe(`0|${claude}|${path.join(h, '.wmux-t1', 'accounts', 'codex-bbbbbbbbbbbbbbbb')}`);
        expect(fs.statSync(claude).mode & 0o777).toBe(0o700);
        expect(ran.stderr).toContain('this pane\'s claude account has no sign-in in this WSL distro yet');
        fs.writeFileSync(path.join(claude, '.credentials.json'), '{}');
        expect(source(h, 'interactive', { WMUX_DATA_SUFFIX: '-t1', WMUX_WSL_ACCOUNT_CLAUDE: 'aaaaaaaaaaaaaaaa' }).stderr).toBe('');
      });

      it('logs the no-sign-in note in an exec run instead of printing it', () => {
        const h = home();
        const ran = source(h, 'exec', { WMUX_WSL_ACCOUNT_CLAUDE: 'cccccccccccccccc' });
        expect(ran.stderr).toBe('');
        expect(fs.readFileSync(path.join(h, '.wmux', 'accounts', 'notices.log'), 'utf8')).toContain('has no sign-in in this WSL distro yet');
      });

      it('mirrors the distro\'s own default folder into a new shared home, once', () => {
        const h = home();
        fs.mkdirSync(path.join(h, '.claude', 'skills'), { recursive: true });
        fs.writeFileSync(path.join(h, '.claude', 'settings.json'), '{"linux":true}');
        source(h, 'exec', { WMUX_WSL_ACCOUNT_CLAUDE: 'dddddddddddddddd', WMUX_WSL_ACCOUNT_CLAUDE_SHARE: '1' });
        const account = path.join(h, '.wmux', 'accounts', 'claude-dddddddddddddddd');
        expect(fs.readlinkSync(path.join(account, 'skills'))).toBe(path.join(h, '.claude', 'skills'));
        expect(fs.readFileSync(path.join(account, 'settings.json'), 'utf8')).toBe('{"linux":true}');
        fs.writeFileSync(path.join(h, '.claude', 'settings.json'), '{"later":true}');
        source(h, 'exec', { WMUX_WSL_ACCOUNT_CLAUDE: 'dddddddddddddddd', WMUX_WSL_ACCOUNT_CLAUDE_SHARE: '1' });
        expect(fs.readFileSync(path.join(account, 'settings.json'), 'utf8')).toBe('{"linux":true}');
      });

      it('makes a shared home appear only complete when two panes start on it at once', () => {
        const h = home();
        fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(h, '.claude', 'settings.json'), '{"linux":true}');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-race-')); dirs.push(dir);
        const script = path.join(dir, 'account.sh');
        fs.writeFileSync(script, WSL_ACCOUNT_SH);
        // A slow copy holds the first pane mid-mirror while the second one starts.
        const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
        fs.writeFileSync(path.join(bin, 'cp'), '#!/bin/sh\nsleep 0.4\nexec /bin/cp "$@"\n', { mode: 0o755 });
        const pane = '( . "$1" exec; if [ -f "$CLAUDE_CONFIG_DIR/settings.json" ]; then echo complete; else echo incomplete; fi )';
        const key = 'f'.repeat(16);
        const ran = spawnSync('bash', ['--noprofile', '--norc', '-c', `${pane} & sleep 0.1; ${pane} & wait`, 'x', script], {
          env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: h, WMUX_WSL_ACCOUNT_CLAUDE: key, WMUX_WSL_ACCOUNT_CLAUDE_SHARE: '1' },
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        expect(ran.stdout.trim().split('\n')).toEqual(['complete', 'complete']);
        const root = path.join(h, '.wmux', 'accounts');
        // One home, and no seed left beside it or inside it.
        expect(fs.readdirSync(root).filter((name) => name !== 'notices.log')).toEqual([`claude-${key}`]);
        expect(fs.readdirSync(path.join(root, `claude-${key}`)).filter((name) => name.startsWith('.seed'))).toEqual([]);
        expect(fs.statSync(path.join(root, `claude-${key}`)).mode & 0o777).toBe(0o700);
      });

      it('fails, without exporting, when the home cannot be made or the suffix cannot name a folder', () => {
        const h = home();
        fs.mkdirSync(path.join(h, '.wmux'));
        fs.writeFileSync(path.join(h, '.wmux', 'accounts'), 'not a folder');
        const blocked = source(h, 'interactive', { WMUX_WSL_ACCOUNT_CLAUDE: 'eeeeeeeeeeeeeeee' });
        expect(blocked.stdout).toBe('1||');
        expect(blocked.stderr).toContain('cannot create');
        const bad = source(home(), 'exec', { WMUX_DATA_SUFFIX: '/../x', WMUX_WSL_ACCOUNT_CLAUDE: 'eeeeeeeeeeeeeeee' });
        expect(bad.stdout).toBe('1||');
        expect(bad.stderr).toContain('cannot name a folder');
      });

      it('ignores a key that is not 16-character hex', () => {
        expect(source(home(), 'exec', { WMUX_WSL_ACCOUNT_CLAUDE: '../../etc' }).stdout).toBe('0||');
      });
    });
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
      const out = execFileSync('script', ['-qec', `/bin/sh '${shimOf(dir)}' --help`, '/dev/null'], {
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

// #1727 — the hook runs inside Linux as the agent's descendant and reports
// which process the agent is. Linux only: it reads /proc.
describe.runIf(process.platform === 'linux' && fs.existsSync('/proc/sys/kernel/random/boot_id'))('WSL hook agent-process report (#1727)', () => {
  it('reports the boot id and the agent among its ancestors, and keeps its own arguments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-hook-')); dirs.push(dir);
    const hook = path.join(dir, 'hook.sh');
    fs.writeFileSync(hook, WSL_HOOK);
    // The fake Windows runtime records what the bridge would receive.
    const node = path.join(dir, 'node');
    fs.writeFileSync(node, `#!/bin/sh\nprintf '%s' "$WMUX_WSL_AGENT_PROC" > '${dir}/report'\nprintf '%s\n' "$WSLENV" "$@" > '${dir}/args'\n`, { mode: 0o755 });
    // A process whose image stem is `claude` stands in for the agent; the
    // trailing `true` keeps it from exec-replacing itself with the hook.
    const claude = path.join(dir, 'claude');
    fs.symlinkSync('/bin/sh', claude);
    execFileSync(claude, ['-c', `echo $$ > '${dir}/pid'; /bin/sh '${hook}' SessionStart; true`], {
      env: { PATH: '/usr/bin:/bin', WMUX_WSL_NODE: node, WMUX_WSL_BRIDGE: '/bridge.mjs' },
    });

    const report = parseWslAgentReport(fs.readFileSync(path.join(dir, 'report'), 'utf8'));
    expect(report?.bootId).toBe(fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
    const picked = pickReportedAgent(report, 'claude');
    expect(picked?.pid).toBe(Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8')));
    expect(picked?.start).toMatch(/^\d+$/);
    expect(fs.readFileSync(path.join(dir, 'args'), 'utf8').split('\n').slice(0, 3))
      .toEqual(['ELECTRON_RUN_AS_NODE/w:WMUX_WSL_AGENT_PROC/w:CLAUDE_CODE_ENTRYPOINT/w:WMUX_GATE/w', '/bridge.mjs', 'SessionStart']);
  });

  it('still runs the bridge when /proc cannot be read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-hook-')); dirs.push(dir);
    const hook = path.join(dir, 'hook.sh');
    // Point the boot-id read at a missing file: the report is skipped.
    fs.writeFileSync(hook, WSL_HOOK.replace('/proc/sys/kernel/random/boot_id', `${dir}/missing`));
    const node = path.join(dir, 'node');
    fs.writeFileSync(node, `#!/bin/sh\nprintf '[%s]' "$WMUX_WSL_AGENT_PROC" > '${dir}/report'\n`, { mode: 0o755 });
    execFileSync('/bin/sh', [hook, 'Stop'], { env: { PATH: '/usr/bin:/bin', WMUX_WSL_NODE: node, WMUX_WSL_BRIDGE: '/b' } });
    expect(fs.readFileSync(path.join(dir, 'report'), 'utf8')).toBe('[]');
  });
});

// #1730 — the permission gate fires on every tool call; without the daemon's
// flag the hook must answer "no opinion" without starting the Windows bridge.
describe.skipIf(process.platform === 'win32')('WSL hook permission gate (#1730)', () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-gate-')); dirs.push(dir);
    const hook = path.join(dir, 'hook.sh');
    fs.writeFileSync(hook, WSL_HOOK);
    const node = path.join(dir, 'node');
    fs.writeFileSync(node, `#!/bin/sh\nprintf '%s\n' "$WSLENV" "[$WMUX_WSL_AGENT_PROC]" "$@" > '${dir}/ran'\n`, { mode: 0o755 });
    const flag = path.join(dir, 'gate-armed');
    const run = (args: string[]) => execFileSync('/bin/sh', [hook, ...args], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', WMUX_WSL_NODE: node, WMUX_WSL_BRIDGE: '/bridge.mjs', WMUX_WSL_GATE_FLAG: flag },
    });
    return { dir, flag, run, ran: () => fs.existsSync(path.join(dir, 'ran')) ? fs.readFileSync(path.join(dir, 'ran'), 'utf8').split('\n') : null };
  }

  it('says nothing and starts nothing while the gate is not armed', () => {
    const { run, ran } = setup();
    expect(run(['PreToolUse', '--permission-gate'])).toBe('');
    expect(ran()).toBeNull();
  });

  it('runs the bridge once armed, forwarding the entrypoint and opt-out, without the /proc walk', () => {
    const { flag, run, ran } = setup();
    fs.writeFileSync(flag, '');
    run(['PreToolUse', '--permission-gate']);
    const out = ran()!;
    expect(out[0]).toContain('CLAUDE_CODE_ENTRYPOINT/w');
    expect(out[0]).toContain('WMUX_GATE/w');
    expect(out[1]).toBe('[]');
    expect(out.slice(2, 5)).toEqual(['/bridge.mjs', 'PreToolUse', '--permission-gate']);
  });

  it('stays silent with no flag path, or under the WMUX_GATE=0 opt-out', () => {
    const { flag, dir, ran } = setup();
    fs.writeFileSync(flag, '');
    const hook = path.join(dir, 'hook.sh');
    const base = { PATH: '/usr/bin:/bin', WMUX_WSL_NODE: path.join(dir, 'node'), WMUX_WSL_BRIDGE: '/b' };
    execFileSync('/bin/sh', [hook, 'PreToolUse', '--permission-gate'], { env: base });
    execFileSync('/bin/sh', [hook, 'PreToolUse', '--permission-gate'], { env: { ...base, WMUX_WSL_GATE_FLAG: '' } });
    execFileSync('/bin/sh', [hook, 'PreToolUse', '--permission-gate'], { env: { ...base, WMUX_WSL_GATE_FLAG: flag, WMUX_GATE: '0' } });
    expect(ran()).toBeNull();
  });

  it('never gates the other hooks on the flag', () => {
    const { run, ran } = setup();
    run(['UserPromptSubmit']);
    expect(ran()?.slice(2, 4)).toEqual(['/bridge.mjs', 'UserPromptSubmit']);
  });
});

// #1730 — a WSL pane must register exactly the hooks a Windows pane does.
describe('WSL hook parity with Windows (#1730)', () => {
  it('registers every Windows hook spec, with the same matcher and arguments', () => {
    const wsl = Object.entries(wslClaudeHooks()).flatMap(([event, groups]) => groups.map((g) => {
      const extra = g.hooks[0].command.split(` ${event}`)[1]?.trim() ?? '';
      return `${event}|${g.matcher}|${extra}`;
    })).sort();
    const windows = HOOK_SPECS.map((s) => `${s.event}|${s.matcher}|${s.extraArgs ?? ''}`).sort();
    expect(wsl).toEqual(windows);
  });
});
