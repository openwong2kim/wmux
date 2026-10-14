import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RUNTIME_CURRENT_LINK, RUNTIME_DIR } from '../shared/sshPcContract';
import { DAEMON_EXIT_ALREADY_RUNNING, dataSuffix } from '../shared/constants';

/**
 * `wmux daemon install-service` / `uninstall-service` — an opt-in way for a
 * headless host's daemon to come back after a reboot and outlive the SSH
 * login that started it.
 *
 * Linux only for now: a systemd --user unit whose ExecStart is
 * `wmux daemon run`, the foreground entry. macOS keeps its one-shot launchd
 * job (no login autostart, deliberately) and gets a hint instead. Without a
 * user manager the answer is the exact command to run under one's own
 * supervisor.
 *
 * Never runs sudo and never stops a running daemon: stopping ends every pane.
 */

export const SERVICE_UNIT_NAME = 'wmux-daemon.service';

export type ServiceManager = 'systemd' | 'launchd' | 'none';

export interface DaemonServiceResult {
  ok: boolean;
  manager: ServiceManager;
  unitPath?: string;
  enabled?: boolean;
  active?: boolean;
  /** `loginctl` Linger for this user; null when it could not be read. */
  linger?: boolean | null;
  /** logind KillUserProcesses; null when it could not be read. */
  killUserProcesses?: boolean | null;
  hint?: string;
  error?: string;
}

export interface CommandResult { code: number | null; stdout: string; stderr: string; missing?: boolean }

export interface DaemonServiceDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  user: string;
  /** Absolute node binary and CLI script that `daemon run` is started with. */
  nodePath: string;
  cliScript: string;
  /** WMUX_DATA_SUFFIX of the installing CLI: the service daemon must use the same data dir. */
  dataSuffix: string;
  run(cmd: string, args: string[]): CommandResult;
  writeFile(file: string, content: string): void;
  removeFile(file: string): void;
  fileExists(file: string): boolean;
  realpath(file: string): string | null;
  /** Whether a daemon answers a ping right now. */
  daemonRunning(): Promise<boolean>;
}

export function defaultDaemonServiceDeps(daemonRunning: () => Promise<boolean>): DaemonServiceDeps {
  return {
    platform: process.platform,
    homeDir: os.homedir(),
    user: os.userInfo().username,
    nodePath: process.execPath,
    cliScript: require.main?.filename ?? process.argv[1] ?? '',
    dataSuffix: dataSuffix(),
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 20_000 });
      const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
      return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? r.error.message : ''), missing };
    },
    writeFile: (file, content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode: 0o644 });
    },
    removeFile: (file) => { fs.rmSync(file, { force: true }); },
    fileExists: (file) => fs.existsSync(file),
    realpath: (file) => { try { return fs.realpathSync(file); } catch { return null; } },
    daemonRunning,
  };
}

/**
 * Rewrite a path inside `~/.wmux/runtime/<ver>/` to go through the `current`
 * link when that link points at the same version, so the unit follows an
 * upgrade instead of pinning the version it was installed from. Any other
 * layout (a dev checkout, an installed app) is left as is.
 */
export function preferCurrentRuntime(file: string, deps: Pick<DaemonServiceDeps, 'homeDir' | 'realpath'>): string {
  const runtime = deps.realpath(path.join(deps.homeDir, RUNTIME_DIR));
  if (!runtime) return file;
  const rel = path.relative(runtime, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  const [version, ...rest] = rel.split(path.sep);
  if (!version || version === RUNTIME_CURRENT_LINK || rest.length === 0) return file;
  const current = deps.realpath(path.join(runtime, RUNTIME_CURRENT_LINK));
  if (!current || current !== deps.realpath(path.join(runtime, version))) return file;
  return path.join(deps.homeDir, RUNTIME_DIR, RUNTIME_CURRENT_LINK, ...rest);
}

/**
 * One unit-file word, quoted for systemd: `%` is a specifier and `$` an env
 * expansion, so both are doubled. A control character cannot be written into
 * a unit line at all, so it is refused rather than mangled.
 */
function systemdWord(word: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(word)) throw new Error(`cannot write a control character into the unit: ${JSON.stringify(word)}`);
  return `"${word.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** The command a service manager runs: the daemon in the foreground. */
export function foregroundCommand(deps: Pick<DaemonServiceDeps, 'nodePath' | 'cliScript' | 'homeDir' | 'realpath'>): string[] {
  return [preferCurrentRuntime(deps.nodePath, deps), preferCurrentRuntime(deps.cliScript, deps), 'daemon', 'run'];
}

export function buildSystemdUnit(command: string[], suffix = ''): string {
  return [
    '[Unit]',
    'Description=wmux daemon (terminal sessions for remote wmux clients)',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${command.map(systemdWord).join(' ')}`,
    // An isolated instance (WMUX_DATA_SUFFIX) keeps its own ~/.wmux<suffix>.
    ...(suffix ? [`Environment=${systemdWord(`WMUX_DATA_SUFFIX=${suffix}`)}`] : []),
    // A crash comes back; `wmux daemon stop` (exit 0) stays stopped.
    'Restart=on-failure',
    'RestartSec=2',
    // Another daemon already holds the lock: not a crash, do not loop on it.
    `RestartPreventExitStatus=${DAEMON_EXIT_ALREADY_RUNNING}`,
    // SIGTERM to the daemon alone, so it saves every session before the rest
    // of the group is killed.
    'KillMode=mixed',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function systemdUnitPath(homeDir: string): string {
  return path.join(homeDir, '.config', 'systemd', 'user', SERVICE_UNIT_NAME);
}

/** `yes`/`no` (loginctl) or `b true`/`b false` (busctl); null when it could not be read. */
function yesNo(r: CommandResult): boolean | null {
  if (r.code !== 0) return null;
  const v = r.stdout.trim();
  return v === 'yes' || v === 'b true' ? true : v === 'no' || v === 'b false' ? false : null;
}

/** A logind MANAGER property; busctl when this loginctl cannot show it. */
function logindManagerFlag(deps: DaemonServiceDeps, property: string): boolean | null {
  return yesNo(deps.run('loginctl', ['show-session', '-p', property, '--value']))
    ?? yesNo(deps.run('busctl', ['get-property', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', property]));
}

function systemdState(deps: DaemonServiceDeps): Pick<DaemonServiceResult, 'enabled' | 'active' | 'linger' | 'killUserProcesses'> {
  return {
    enabled: deps.run('systemctl', ['--user', 'is-enabled', SERVICE_UNIT_NAME]).stdout.trim() === 'enabled',
    active: deps.run('systemctl', ['--user', 'is-active', SERVICE_UNIT_NAME]).stdout.trim() === 'active',
    linger: yesNo(deps.run('loginctl', ['show-user', deps.user, '-p', 'Linger', '--value'])),
    killUserProcesses: logindManagerFlag(deps, 'KillUserProcesses'),
  };
}

const lingerHint = (user: string): string =>
  'Linger is off, so the daemon stops when your last login session ends and does not start at boot. ' +
  `Run once: sudo loginctl enable-linger ${user}`;

function unsupported(deps: DaemonServiceDeps, manager: ServiceManager, why: string): DaemonServiceResult {
  const cmd = foregroundCommand(deps).map((w) => (/\s/.test(w) ? JSON.stringify(w) : w)).join(' ');
  return { ok: false, manager, hint: `${why} Run it under your own supervisor: ${cmd}` };
}

/** Whether a systemd user manager answers; a missing systemctl is `none`. */
function probeSystemd(deps: DaemonServiceDeps): 'ok' | 'missing' | string {
  const probe = deps.run('systemctl', ['--user', 'show-environment']);
  if (probe.missing) return 'missing';
  if (probe.code !== 0) return (probe.stderr || probe.stdout).trim() || 'systemctl --user failed';
  return 'ok';
}

export async function installDaemonService(deps: DaemonServiceDeps): Promise<DaemonServiceResult> {
  if (deps.platform === 'darwin') {
    return unsupported(deps, 'launchd', 'A login service is not supported on macOS yet.');
  }
  if (deps.platform !== 'linux') return unsupported(deps, 'none', 'No supported service manager on this system.');
  const probe = probeSystemd(deps);
  if (probe === 'missing') return unsupported(deps, 'none', 'systemd was not found.');
  const unitPath = systemdUnitPath(deps.homeDir);
  if (probe !== 'ok') {
    return {
      ok: false, manager: 'systemd', unitPath,
      error: `the systemd user manager is not reachable: ${probe}`,
      hint: `Enable lingering once (sudo loginctl enable-linger ${deps.user}), log in again, and retry.`,
    };
  }

  if (!path.isAbsolute(deps.nodePath) || !path.isAbsolute(deps.cliScript)) {
    return { ok: false, manager: 'systemd', unitPath, error: `cannot resolve this CLI's absolute path (${deps.cliScript || 'unknown'})` };
  }
  const wasActive = deps.run('systemctl', ['--user', 'is-active', SERVICE_UNIT_NAME]).stdout.trim() === 'active';
  try {
    deps.writeFile(unitPath, buildSystemdUnit(foregroundCommand(deps), deps.dataSuffix));
  } catch (error) {
    return { ok: false, manager: 'systemd', unitPath, error: `could not write the unit: ${error instanceof Error ? error.message : String(error)}` };
  }
  const reload = deps.run('systemctl', ['--user', 'daemon-reload']);
  if (reload.code !== 0) {
    return { ok: false, manager: 'systemd', unitPath, error: `systemctl --user daemon-reload failed: ${reload.stderr.trim()}` };
  }
  // Never stop or replace a live daemon: that ends every pane it hosts. A
  // daemon already running (outside the service, or the service's own on a
  // re-install) keeps running; the unit takes over at its next start.
  const deferStart = wasActive || await deps.daemonRunning();
  const enable = deps.run('systemctl', ['--user', 'enable', ...(deferStart ? [] : ['--now']), SERVICE_UNIT_NAME]);
  if (enable.code !== 0) {
    return { ok: false, manager: 'systemd', unitPath, error: `systemctl --user enable failed: ${enable.stderr.trim()}` };
  }
  const state = systemdState(deps);
  const hints: string[] = [];
  if (deferStart && !wasActive) {
    hints.push(
      'A daemon is already running outside the service and was left alone (stopping it ends its panes). ' +
      `The service starts at the next boot, or now with: wmux daemon stop && systemctl --user start ${SERVICE_UNIT_NAME}`,
    );
  } else if (wasActive) {
    hints.push('The service was already running; the updated unit applies from its next start.');
  }
  if (state.linger !== true) hints.push(lingerHint(deps.user));
  return {
    ok: state.enabled === true,
    manager: 'systemd',
    unitPath,
    ...state,
    ...(hints.length ? { hint: hints.join(' ') } : {}),
  };
}

export async function uninstallDaemonService(deps: DaemonServiceDeps): Promise<DaemonServiceResult> {
  if (deps.platform === 'darwin') return { ok: true, manager: 'launchd', hint: 'No service is installed on macOS.' };
  if (deps.platform !== 'linux') return { ok: true, manager: 'none' };
  const probe = probeSystemd(deps);
  if (probe === 'missing') return { ok: true, manager: 'none' };
  const unitPath = systemdUnitPath(deps.homeDir);
  if (probe !== 'ok') {
    return { ok: false, manager: 'systemd', unitPath, error: `the systemd user manager is not reachable: ${probe}` };
  }
  // `disable` without `--now`: the running daemon keeps its panes.
  if (deps.fileExists(unitPath)) {
    const disable = deps.run('systemctl', ['--user', 'disable', SERVICE_UNIT_NAME]);
    if (disable.code !== 0) {
      return { ok: false, manager: 'systemd', unitPath, error: `systemctl --user disable failed: ${disable.stderr.trim()}` };
    }
    try {
      deps.removeFile(unitPath);
    } catch (error) {
      return { ok: false, manager: 'systemd', unitPath, error: `could not remove the unit: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  deps.run('systemctl', ['--user', 'daemon-reload']);
  const state = systemdState(deps);
  return {
    ok: true,
    manager: 'systemd',
    unitPath,
    ...state,
    ...(state.active ? { hint: 'The daemon keeps running until `wmux daemon stop`; it will not start again at boot.' } : {}),
  };
}
