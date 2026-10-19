import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  buildSystemdUnit,
  installDaemonService,
  preferCurrentRuntime,
  uninstallDaemonService,
  type CommandResult,
  type DaemonServiceDeps,
} from '../daemonService';

// systemd and the ~/.wmux/runtime layout are POSIX; the fixtures are POSIX paths.
const POSIX_ONLY = process.platform === 'win32';
const HOME = '/home/ada';
const RUNTIME = `${HOME}/.wmux/runtime`;

/** Scripted systemctl/loginctl plus an in-memory unit file. */
function fakeDeps(over: Partial<DaemonServiceDeps> & {
  answers?: Record<string, Partial<CommandResult>>;
  running?: boolean;
} = {}) {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const answers: Record<string, Partial<CommandResult>> = {
    'systemctl --user show-environment': { code: 0 },
    'systemctl --user is-active wmux-daemon.service': { code: 3, stdout: 'inactive\n' },
    'systemctl --user is-enabled wmux-daemon.service': { code: 0, stdout: 'enabled\n' },
    'loginctl show-user ada -p Linger --value': { code: 0, stdout: 'no\n' },
    'loginctl show-session -p KillUserProcesses --value': { code: 0, stdout: 'yes\n' },
    ...over.answers,
  };
  const deps: DaemonServiceDeps = {
    platform: 'linux',
    homeDir: HOME,
    user: 'ada',
    nodePath: `${RUNTIME}/3.70.0/node/bin/node`,
    cliScript: `${RUNTIME}/3.70.0/resources/cli-bundle/index.js`,
    dataSuffix: '',
    run: (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      return { code: 0, stdout: '', stderr: '', ...answers[key] };
    },
    writeFile: (file, content) => { files.set(file, content); },
    removeFile: (file) => { files.delete(file); },
    fileExists: (file) => files.has(file),
    // `current` points at 3.70.0; everything else is already real.
    realpath: (file) => (file === `${RUNTIME}/current` ? `${RUNTIME}/3.70.0` : file),
    daemonRunning: async () => over.running ?? false,
    ...over,
  };
  return { deps, calls, files };
}

describe.skipIf(POSIX_ONLY)('wmux daemon install-service (systemd --user)', () => {
  it('writes a foreground unit through the current link, starts it, and names the linger fix', async () => {
    const { deps, calls, files } = fakeDeps();
    const result = await installDaemonService(deps);

    const unitPath = `${HOME}/.config/systemd/user/wmux-daemon.service`;
    expect(result).toEqual({
      ok: true, manager: 'systemd', unitPath, enabled: true, active: false, linger: false, killUserProcesses: true,
      hint: expect.stringContaining('sudo loginctl enable-linger ada'),
    });
    expect(files.get(unitPath)).toContain(
      `ExecStart="${RUNTIME}/current/node/bin/node" "${RUNTIME}/current/resources/cli-bundle/index.js" "daemon" "run"`,
    );
    expect(calls).toContain('systemctl --user daemon-reload');
    expect(calls).toContain('systemctl --user enable --now wmux-daemon.service');
    expect(calls.some((c) => c.startsWith('sudo'))).toBe(false);
  });

  it('never stops or replaces a daemon that is already running', async () => {
    const { deps, calls } = fakeDeps({ running: true });
    const result = await installDaemonService(deps);
    expect(calls).toContain('systemctl --user enable wmux-daemon.service');
    expect(calls.some((c) => c.includes('--now') || c.includes(' stop') || c.includes('restart'))).toBe(false);
    expect(result.hint).toContain('left alone');
    expect(result.hint).toContain('systemctl --user start wmux-daemon.service');
  });

  it('reads KillUserProcesses through busctl when loginctl cannot show it, and keeps a data suffix', async () => {
    const { deps, files } = fakeDeps({
      dataSuffix: '-dev',
      answers: {
        'loginctl show-session -p KillUserProcesses --value': { code: 1, stderr: 'no session' },
        'busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses': { code: 0, stdout: 'b false\n' },
      },
    });
    const result = await installDaemonService(deps);
    expect(result.killUserProcesses).toBe(false);
    expect([...files.values()][0]).toContain('Environment="WMUX_DATA_SUFFIX=-dev"');
  });

  it('answers ok:false instead of throwing when the unit cannot be written', async () => {
    const { deps } = fakeDeps({ writeFile: () => { throw new Error('EACCES'); } });
    expect(await installDaemonService(deps)).toMatchObject({ ok: false, manager: 'systemd', error: expect.stringContaining('EACCES') });
  });

  it('answers manager none with the exact foreground command when systemd is absent', async () => {
    const { deps, files } = fakeDeps({ answers: { 'systemctl --user show-environment': { code: null, missing: true } } });
    const result = await installDaemonService(deps);
    expect(result).toEqual({
      ok: false, manager: 'none',
      hint: expect.stringContaining(`${RUNTIME}/current/node/bin/node ${RUNTIME}/current/resources/cli-bundle/index.js daemon run`),
    });
    expect(files.size).toBe(0);
  });

  it('uninstall disables and removes the unit without stopping the daemon', async () => {
    const { deps, calls, files } = fakeDeps();
    await installDaemonService(deps);
    const result = await uninstallDaemonService(deps);
    expect(result.ok).toBe(true);
    expect(files.size).toBe(0);
    expect(calls).toContain('systemctl --user disable wmux-daemon.service');
    expect(calls.some((c) => c.includes('disable --now') || c.includes(' stop'))).toBe(false);
  });
});

describe.skipIf(POSIX_ONLY)('unit file and runtime path', () => {
  it('keeps a dev or app layout as is, and only follows current when it points at that version', () => {
    const deps = fakeDeps().deps;
    expect(preferCurrentRuntime('/repo/dist/cli-bundle/index.js', deps)).toBe('/repo/dist/cli-bundle/index.js');
    expect(preferCurrentRuntime(`${RUNTIME}/3.69.0/node/bin/node`, deps)).toBe(`${RUNTIME}/3.69.0/node/bin/node`);
    expect(preferCurrentRuntime(`${RUNTIME}/3.70.0/node/bin/node`, deps)).toBe(path.join(RUNTIME, 'current/node/bin/node'));
  });

  it('restarts on failure only, not on the already-running exit, and stops the daemon first', () => {
    const unit = buildSystemdUnit(['/n 100%/node', 'x"y', '/a/$HOME']);
    expect(unit).toContain('ExecStart="/n 100%%/node" "x\\"y" "/a/$$HOME"');
    expect(() => buildSystemdUnit(['/a\nb'])).toThrow(/control character/);
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartPreventExitStatus=75');
    expect(unit).toContain('KillMode=mixed');
    expect(unit).toContain('WantedBy=default.target');
  });
});
