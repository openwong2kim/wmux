import { readFileSync } from 'fs';
import { join } from 'path';
import { sendDaemonStringRequest } from '../client';
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
 * Same fallback idiom `doctor.ts` and `system.ts` already use for the CLI's
 * own version (`getFallbackVersion` in system.ts): read the nearest
 * `package.json` relative to this bundle, default to `0.0.0` if that fails.
 *
 * This must never resolve to nothing — an empty `SPAWNED_BY_VERSION` makes
 * the daemon fall back to the `'unknown'` sentinel, which the B′ staleness
 * gate reads as "positively old", and the first GUI that connects to a
 * VPS-started daemon would replace it on sight.
 */
function resolveSpawnedByVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
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
      console.log(JSON.stringify({ ok: true, pid: info.pid, pipeName: info.pipeName, spawned: info.spawned }, null, 2));
      return;
    }
    printText([
      info.spawned
        ? `wmux daemon started (PID ${info.pid})`
        : `wmux daemon already running (PID ${info.pid})`,
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
    return;
  }
  if (jsonMode) {
    return printResult(response);
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
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.log('wmux daemon is not running.');
    }
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
