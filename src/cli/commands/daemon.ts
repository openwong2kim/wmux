import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { sendDaemonStringRequest, isDefinitelyNotRunning } from '../client';
import { printResult, ensureOk } from '../utils';
import {
  ensureDaemon,
  type DaemonLauncherDeps,
} from '../../shared/daemon/daemonLauncherCore';
import type { RpcResponse } from '../../shared/rpc';
import type { DaemonStatusJson } from '../../shared/sshPcContract';
import { ENV_KEYS } from '../../shared/constants';
import { DAEMON_SUPERVISED_ENV } from '../../daemon/config';
import {
  defaultDaemonServiceDeps,
  installDaemonService,
  uninstallDaemonService,
  type DaemonServiceResult,
} from '../daemonService';

/**
 * `wmux daemon start | stop | status` — headless daemon lifecycle (#1001).
 *
 * v1 scope, per the maintainer's scope note in discussion #1001: exactly
 * these three verbs. No first-run wizard (that's `wmux web`'s job — it
 * already owns enable/pairing/TLS and talks to a running daemon directly),
 * no service-manager integration (a systemd unit is a docs snippet, not a
 * flag).
 *
 * The spawn/readiness chain itself is NOT reimplemented here — it is
 * `ensureDaemon()` from `../../shared/daemon/daemonLauncherCore`, the exact
 * same function `src/main/daemon/launcher.ts` binds for the Electron main
 * process. Two independent copies of that logic would drift apart, and the
 * spawn path is where wmux's worst lifecycle bugs have lived (#537, #980) —
 * so this file supplies only what differs for a headless caller: where the
 * daemon script lives relative to this CLI bundle, what version to stamp,
 * and how to answer the "can't verify this PID" question (always refuse —
 * see `askUserToRecoverFromStalePid` below).
 */

/**
 * Candidate paths for the daemon entry script, resolved relative to THIS
 * bundle's own location instead of `app.getAppPath()` / `process.resourcesPath`
 * (which don't exist outside Electron).
 *
 * `dist/cli-bundle/index.js` and `dist/daemon-bundle/index.js` are built as
 * siblings (see package.json's `build:cli` / `build:daemon`, and
 * forge.config.ts's `extraResource` list) in BOTH layouts this needs to
 * cover:
 *  - dev checkout: <repo>/dist/cli-bundle/index.js, <repo>/dist/daemon-bundle/index.js
 *  - installed app: <resources>/cli-bundle/index.js, <resources>/daemon-bundle/index.js
 * so `__dirname/../daemon-bundle/index.js` resolves correctly in both without
 * needing to tell them apart. The tsc-output fallback candidates mirror the
 * same two layouts for the (rare) case someone runs the CLI straight out of
 * `dist/cli` rather than the bundled artifact.
 */
function resolveDaemonScriptCandidates(): string[] {
  return [
    join(__dirname, '..', 'daemon-bundle', 'index.js'),
    join(__dirname, '..', 'daemon', 'daemon', 'index.js'),
    join(__dirname, '..', 'daemon', 'index.js'),
  ];
}

/**
 * Reads the nearest `package.json` relative to this bundle to stamp a real
 * version. `doctor.ts` / `system.ts` use the same relative-lookup idiom for
 * the CLI's own version display, but fall back to `'0.0.0'` there because
 * that value is display-only.
 *
 * Here it is NOT display-only — it is stamped into `SPAWNED_BY_VERSION` and
 * read by the B′ staleness gate (`isDaemonOlder` in `daemonReplacement.ts`).
 * That gate special-cases the literal string `'unknown'` as "spawn path
 * unclear, keep the daemon" — but `'0.0.0'` is a real, parseable version, so
 * the gate reads it as positively OLDER than any real release and the first
 * GUI to connect replaces (kills) the daemon the CLI just started, PTYs
 * included. In the installed layout `__dirname/../../package.json` does not
 * exist (the CLI bundle sits at `<resources>/cli-bundle`), so this path is
 * not a rare edge case — it is what every real installed headless daemon
 * hits. Falling back to `'unknown'` instead lets the gate's existing
 * exception carry it, matching what an Electron-spawned daemon gets when
 * `app.getVersion()` is unavailable for some other reason.
 */
export function resolveSpawnedByVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * A headless caller never has a window to put a recovery dialog in, and
 * there is no human at a keyboard to ask mid-command. Refusing (returning
 * `false`) takes the existing "unverified live process" branch in
 * `ensureDaemon` — it throws with a manual-recovery message instead of
 * guessing "probably dead" and spawning a second daemon over PTYs the first
 * one still owns. This is the same outcome `WMUX_NO_DIALOG=1` produces for
 * the Electron path in tests, but reached structurally here rather than by
 * env var, since a headless verb has no other path to be on.
 */
async function askUserToRecoverFromStalePid(): Promise<boolean> {
  return false;
}

const cliDaemonDeps: DaemonLauncherDeps = {
  resolveDaemonScriptCandidates,
  resolveSpawnedByVersion,
  askUserToRecoverFromStalePid,
  // The headless CLI is never Electron — plain `node`/`node.exe` already
  // understands the daemon bundle without ELECTRON_RUN_AS_NODE.
  isElectronHost: () => false,
  // Same reason as the app (src/main/daemon/launcher.ts): a daemon started
  // from a terminal must not be ended when that terminal app quits.
  launchViaLaunchdOnDarwin: true,
  // Both routed to stderr, in both --json and text mode: `runStart --json`
  // prints exactly one JSON object on stdout as its contract, and text mode
  // already has its own human-readable status lines — neither has room for
  // launcher-internal diagnostics mixed in. console.error is stderr in Node
  // regardless of platform, so this needs no further branching on jsonMode.
  log: (...args: unknown[]) => console.error(...args),
  warn: (...args: unknown[]) => console.error(...args),
};

function printText(lines: string[]): void {
  for (const line of lines) console.log(line);
}

async function runStart(jsonMode: boolean): Promise<void> {
  try {
    const info = await ensureDaemon(cliDaemonDeps);
    if (jsonMode) {
      // authToken deliberately omitted: `status`/`stop` resolve their own
      // token via resolveDaemonAuthToken() and never need it echoed back,
      // and printing a live credential to stdout risks it landing in shell
      // history or a captured log.
      console.log(JSON.stringify({ ok: true, pid: info.pid ?? null, pipeName: info.pipeName, spawned: info.spawned }, null, 2));
      return;
    }
    printText([
      info.spawned
        ? `wmux daemon started (PID ${info.pid ?? 'unknown'})`
        : `wmux daemon already running (PID ${info.pid ?? 'unknown'})`,
      `pipe: ${info.pipeName}`,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`wmux daemon start: ${message}`);
    }
    process.exitCode = 1;
  }
}

/**
 * The `web` field of `daemon status --json` (DaemonStatusJson): whether the
 * web server runs, and on which port with which grant. PICKED field by field
 * from `daemon.web.status`, never spread — that answer carries the operator
 * token, and this output is read over SSH. Absent when the daemon cannot say.
 */
async function readWebSummary(): Promise<DaemonStatusJson['web'] | undefined> {
  try {
    const res = await sendDaemonStringRequest('daemon.web.status', {});
    if (!res.ok || !res.result || typeof res.result !== 'object') return undefined;
    const info = res.result as { running?: unknown; port?: unknown; allowInput?: unknown };
    if (info.running !== true) return { running: false };
    return {
      running: true,
      ...(typeof info.port === 'number' ? { port: info.port } : {}),
      allowInput: info.allowInput === true,
    };
  } catch {
    return undefined;
  }
}

async function runStatus(jsonMode: boolean): Promise<void> {
  let response: RpcResponse;
  try {
    response = await sendDaemonStringRequest('daemon.ping', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, running: false, error: message }, null, 2));
    } else {
      console.log('wmux daemon is not running.');
    }
    // A transport failure IS the answer "not running" for a human, but a
    // script needs the exit code to tell it apart from a clean, healthy
    // status check — otherwise `wmux daemon status || restart` never fires.
    process.exitCode = 1;
    return;
  }
  if (jsonMode) {
    // The failure branch above emits `{ok, running: false, error}`. Mirror
    // that shape on success — `daemon.ping`'s own result carries no
    // `running` field (a successful ping IS "running", it never needed to
    // say so) — so a script keying on `.running` doesn't read `undefined`
    // for a daemon that is, in fact, up.
    if (!response.ok) {
      return printResult(response);
    }
    const web = await readWebSummary();
    console.log(JSON.stringify({
      ok: true,
      running: true,
      ...(response.result as Record<string, unknown> | undefined),
      ...(web ? { web } : {}),
    }, null, 2));
    return;
  }
  ensureOk(response);
  console.log('wmux daemon is running.');
  const result = response.result;
  if (result && typeof result === 'object') {
    for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
      console.log(`  ${key}: ${JSON.stringify(value)}`);
    }
  }
}

async function runStop(jsonMode: boolean): Promise<void> {
  let response: RpcResponse;
  try {
    response = await sendDaemonStringRequest('daemon.shutdown', {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only a DEFINITIVE absence (no pipe file, or a pipe file nothing accepts
    // on) means "already stopped" — that is genuinely idempotent success. A
    // timeout, an EPERM, or a connection dropped mid-request all mean the
    // daemon may well still be alive (EPERM in particular can mean a daemon
    // owned by another user/session IS listening); reporting those as a
    // clean stop would let `wmux daemon stop && something` proceed against a
    // daemon that never shut down. `isDefinitelyNotRunning` is deliberately
    // narrower than `isConnectFailure` — see its doc comment in `client.ts`.
    const alreadyStopped = isDefinitelyNotRunning(err);
    if (jsonMode) {
      console.log(JSON.stringify({ ok: alreadyStopped, error: message }, null, 2));
    } else if (alreadyStopped) {
      console.log('wmux daemon is not running.');
    } else {
      console.error(`wmux daemon stop: ${message}`);
    }
    if (!alreadyStopped) process.exitCode = 1;
    return;
  }
  if (jsonMode) {
    return printResult(response);
  }
  ensureOk(response);
  console.log('wmux daemon stopped.');
}

/**
 * `wmux daemon run` — the daemon in the FOREGROUND, for a service manager.
 *
 * `start` detaches (ensureDaemon); a supervisor needs a process that lives as
 * long as the daemon does. This runs the same daemon script with the same
 * version stamp, plus DAEMON_SUPERVISED_ENV so it never exits on idle, and
 * relays the supervisor's stop signal to it. Exits with the daemon's code, so
 * DAEMON_EXIT_ALREADY_RUNNING reaches the supervisor unchanged.
 */
function runForeground(): void {
  const script = resolveDaemonScriptCandidates().find((c) => existsSync(c));
  if (!script) {
    console.error('wmux daemon run: the daemon script was not found next to this CLI');
    process.exitCode = 1;
    return;
  }
  const child = spawn(process.execPath, [script], {
    stdio: 'inherit',
    env: {
      ...process.env,
      [ENV_KEYS.SPAWNED_BY_VERSION]: resolveSpawnedByVersion(),
      [DAEMON_SUPERVISED_ENV]: '1',
    },
  });
  // Relay, then wait for the daemon's own exit. The CLI's global SIGINT
  // handler would exit at once and leave the daemon running unsupervised.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.removeAllListeners(signal);
    process.on(signal, () => { child.kill(signal); });
  }
  child.on('error', (err) => {
    console.error(`wmux daemon run: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function printService(result: DaemonServiceResult, jsonMode: boolean, verb: string): void {
  if (!result.ok) process.exitCode = 1;
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const out = result.ok ? console.log : console.error;
  out(`wmux daemon ${verb}: ${result.ok ? 'ok' : `failed${result.error ? ` — ${result.error}` : ''}`} (${result.manager})`);
  if (result.unitPath) out(`  unit: ${result.unitPath}`);
  if (result.enabled !== undefined) out(`  enabled: ${result.enabled}  active: ${result.active}  linger: ${result.linger}`);
  if (result.hint) out(`  ${result.hint}`);
}

async function daemonAnswers(): Promise<boolean> {
  try {
    return (await sendDaemonStringRequest('daemon.ping', {})).ok;
  } catch {
    return false;
  }
}

export async function handleDaemon(sub: string | undefined, _rest: string[], jsonMode: boolean): Promise<void> {
  switch (sub) {
    case 'start':
      return runStart(jsonMode);
    case 'status':
      return runStatus(jsonMode);
    case 'stop':
      return runStop(jsonMode);
    case 'run':
      return runForeground();
    case 'install-service':
      return printService(await installDaemonService(defaultDaemonServiceDeps(daemonAnswers)), jsonMode, sub);
    case 'uninstall-service':
      return printService(await uninstallDaemonService(defaultDaemonServiceDeps(daemonAnswers)), jsonMode, sub);
    default:
      if (jsonMode) {
        console.log(JSON.stringify({ ok: false, error: `unknown subcommand: ${sub ?? '(none)'}` }, null, 2));
      } else {
        console.error(`Usage: wmux daemon start | stop | status | run | install-service | uninstall-service`);
      }
      process.exitCode = 1;
  }
}
