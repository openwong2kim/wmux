import { readFileSync } from 'fs';
import { join } from 'path';
import { sendDaemonStringRequest, isConnectFailure } from '../client';
import { printResult, ensureOk } from '../utils';
import {
  ensureDaemon,
  type DaemonLauncherDeps,
} from '../../shared/daemon/daemonLauncherCore';
import type { RpcResponse } from '../../shared/rpc';

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
    console.log(JSON.stringify({ ok: true, running: true, ...(response.result as Record<string, unknown> | undefined) }, null, 2));
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
    // Only a connect-level failure (no daemon listening at all) means
    // "already stopped" — that is genuinely idempotent success. A timeout,
    // a permission error, or a connection dropped mid-request all mean the
    // daemon may well still be alive; reporting those as a clean stop would
    // let `wmux daemon stop && something` proceed against a daemon that
    // never shut down. Mirrors the connect/timeout split `sendRequest`
    // itself already draws for retry purposes.
    const alreadyStopped = isConnectFailure(err);
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

export async function handleDaemon(sub: string | undefined, _rest: string[], jsonMode: boolean): Promise<void> {
  switch (sub) {
    case 'start':
      return runStart(jsonMode);
    case 'status':
      return runStatus(jsonMode);
    case 'stop':
      return runStop(jsonMode);
    default:
      if (jsonMode) {
        console.log(JSON.stringify({ ok: false, error: `unknown subcommand: ${sub ?? '(none)'}` }, null, 2));
      } else {
        console.error(`Usage: wmux daemon start | stop | status`);
      }
      process.exitCode = 1;
  }
}
