import { readFileSync, readdirSync, realpathSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { childStdio } from '../consoleStdio';
import { sendDaemonStringRequest, isDefinitelyNotRunning } from '../client';
import { printResult, ensureOk } from '../utils';
import {
  daemonProcessArgs,
  ensureDaemon,
  type DaemonLauncherDeps,
} from '../../shared/daemon/daemonLauncherCore';
import type { RpcResponse } from '../../shared/rpc';
import type { DaemonStatusJson } from '../../shared/sshPcContract';
import { ENV_KEYS } from '../../shared/constants';
import { DAEMON_SUPERVISED_ENV, getWmuxDir } from '../../daemon/config';
import { APP_ATTACHED_FILE } from '../../daemon/appHostMarker';
import { headlessFlagPath, headlessReleasePath } from '../../daemon/a2aRemote/headlessMode';
import { HEADLESS_STARTS_FILE, coerceHeadlessStart, type HeadlessStartRecordV1 } from '../../daemon/a2aRemote/headlessStartStore';
import { isNestingMarker } from '../../shared/envFilter';
import { policyIo } from './remote';
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

/** `env` without `ENV_KEYS.APP_SPAWNED_DAEMON`: only the desktop app's launcher may start a daemon with it. */
export function withoutAppSpawnedMarker(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out[ENV_KEYS.APP_SPAWNED_DAEMON];
  return out;
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
  const child = spawn(process.execPath, daemonProcessArgs(script), {
    // The daemon writes where this CLI does, including a console its fds 1 and 2 do not reach.
    stdio: childStdio(),
    // Never the desktop app's launch marker, even when this CLI inherited one.
    env: {
      ...withoutAppSpawnedMarker(process.env),
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

// ─── Headless mode: on | off | status ───────────────────────────────────────

export interface HeadlessStatus {
  /** The daemon starts remote agents itself. */
  inEffect: boolean;
  optedIn: boolean;
  appAttached: boolean;
  /** Why it is not in effect, when it is not. */
  reason?: string;
  /** Agents a remote start runs here now. */
  running: number;
  /** Those agents: which start, for which PC, in which worktree, since when. */
  runningStarts: Array<{ spawnId: string; hostId: string; worktreePath?: string; since: string }>;
  /** Worktrees of starts that ended, kept with their branches (the agent's work). */
  leftovers: string[];
  /** Starts whose agent processes did not all exit yet (cleanup waits for them): `<spawnId>: <worktree> (pid …)`. */
  heldUp: string[];
  /** Per asking PC (host id): agents running, and worktrees of ended starts kept. */
  perPc: Record<string, { running: number; kept: number }>;
  /** Where the app check came from: the running daemon, or the data dir alone (no daemon answered). */
  from: 'daemon' | 'files';
  /**
   * Start files found corrupt and set aside (`headless-starts.json.corrupt-*`):
   * the starts they held are no longer listed. Present only when there is one.
   */
  setAside?: {
    files: string[];
    /** Folders under the worktrees folder named like a remote start's (`remote-sp-*`) that no start record names. */
    unrecordedWorktrees: string[];
  };
}

/** What the running daemon decides from (`daemon.headless.status`), or null when none answers. */
export interface DaemonHeadlessView {
  appAttached: boolean;
  optedIn: boolean;
  inEffect: boolean;
}

/** Test seam: the running daemon's view. */
export const headlessIo = {
  daemonView: async (): Promise<DaemonHeadlessView | null> => {
    try {
      const res = await sendDaemonStringRequest('daemon.headless.status', {});
      const r = res.ok ? (res.result as Partial<DaemonHeadlessView> | undefined) : undefined;
      return r && typeof r.appAttached === 'boolean' && typeof r.optedIn === 'boolean' && typeof r.inEffect === 'boolean'
        ? { appAttached: r.appAttached, optedIn: r.optedIn, inEffect: r.inEffect }
        : null;
    } catch {
      return null;
    }
  },
};

/**
 * What `wmux daemon headless status` reports. The app check is the running
 * daemon's when one answers (it also knows the app launcher's marker and an
 * attach it could not record); with no daemon, the data dir's record of an
 * attach. The starts are read from the data dir.
 */
export function headlessStatus(wmuxDir: string = getWmuxDir(), daemon: DaemonHeadlessView | null = null): HeadlessStatus {
  const a2aDir = join(wmuxDir, 'a2a');
  const appAttached = existsSync(join(wmuxDir, APP_ATTACHED_FILE)) || daemon?.appAttached === true;
  const optedIn = daemon ? daemon.optedIn : existsSync(headlessFlagPath(a2aDir));
  let starts: HeadlessStartRecordV1[] = [];
  try {
    const raw = JSON.parse(readFileSync(join(a2aDir, HEADLESS_STARTS_FILE), 'utf8')) as { starts?: unknown };
    starts = (Array.isArray(raw.starts) ? raw.starts : []).flatMap((r) => coerceHeadlessStart(r) ?? []);
  } catch {
    // No start recorded yet (or the file is being replaced): nothing to list.
  }
  // The running daemon's own answer when it gives one: it also knows whether
  // it could build what starts the agents this run.
  const reason = appAttached
    ? 'the desktop app has used this install; it starts remote agents here'
    : !optedIn ? 'not turned on (wmux daemon headless on)'
      : daemon && !daemon.inEffect ? 'the daemon could not set up remote starts this run (its task ledger or remote-PC service is unavailable; see its log)'
        : undefined;
  return {
    inEffect: daemon ? daemon.inEffect && reason === undefined : reason === undefined,
    optedIn,
    appAttached,
    ...(reason ? { reason } : {}),
    running: starts.filter((r) => r.phase === 'started' && !r.survivors).length,
    runningStarts: starts.flatMap((r) => (r.phase === 'started' && !r.survivors
      ? [{ spawnId: r.spawnId, hostId: r.hostId, ...(r.worktreePath ? { worktreePath: r.worktreePath } : {}), since: r.startedAt }]
      : [])),
    // Only those still on disk: the owner may have removed some already.
    leftovers: starts.flatMap((r) => (r.phase === 'ended' && !r.survivors && r.worktreePath && existsSync(r.worktreePath) ? [r.worktreePath] : [])),
    heldUp: starts.flatMap((r) => (r.survivors ? [`${r.spawnId}: ${r.worktreePath ?? r.sessionId} (pid ${r.survivors.map((p) => p.pid).join(', ')})`] : [])),
    perPc: perPc(starts),
    from: daemon ? 'daemon' : 'files',
    ...setAside(wmuxDir, starts),
  };
}

/** A set-aside start file, and the remote-start worktrees no record names then. */
function setAside(wmuxDir: string, starts: HeadlessStartRecordV1[]): Pick<HeadlessStatus, 'setAside'> {
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const files = list(join(wmuxDir, 'a2a')).filter((n) => n.startsWith(`${HEADLESS_STARTS_FILE}.corrupt-`)).sort();
  if (files.length === 0) return {};
  // Recorded paths are real paths (the worktree step resolves its root): compare against the resolved root.
  let worktrees = join(wmuxDir, 'worktrees');
  try {
    worktrees = realpathSync.native(worktrees);
  } catch { /* no such folder: nothing to list */ }
  const named = new Set(starts.flatMap((r) => [r.worktreePath, r.worktreeIntended].filter((p): p is string => !!p)));
  const unrecordedWorktrees = list(worktrees)
    .filter((n) => /^remote-sp-[0-9a-f-]{36}$/.test(n))
    .map((n) => join(worktrees, n))
    .filter((p) => !named.has(p))
    .sort();
  return { setAside: { files, unrecordedWorktrees } };
}

function perPc(starts: HeadlessStartRecordV1[]): HeadlessStatus['perPc'] {
  const out: HeadlessStatus['perPc'] = {};
  for (const r of starts) {
    const row = (out[r.hostId] ??= { running: 0, kept: 0 });
    if (r.phase === 'started' && !r.survivors) row.running += 1;
    else if (r.phase === 'ended' && r.worktreePath && existsSync(r.worktreePath)) row.kept += 1;
  }
  return out;
}

/** The app is known on this install: the daemon says so, or the data dir recorded an attach. */
async function appKnown(wmuxDir: string): Promise<boolean> {
  return existsSync(join(wmuxDir, APP_ATTACHED_FILE)) || (await headlessIo.daemonView())?.appAttached === true;
}

/** Said by `headless on` and `headless status`: an idle daemon stays up now, and what brings it back after a reboot. */
export const HEADLESS_STAYS_UP = 'While headless mode is on, the daemon stays running when idle. It does not start again by itself after a reboot or a crash: on Linux, `wmux daemon install-service` starts it at boot; otherwise run `wmux daemon start` again.';

/** After `headless on`: the stays-up rule, and how to start the daemon when none runs now. */
async function sayStaysUp(say: (line: string) => void): Promise<void> {
  say(HEADLESS_STAYS_UP);
  if (!(await headlessIo.daemonView())) say('No daemon answered: start it with `wmux daemon start` (or check `wmux daemon status` if one should be running).');
}

function headlessFail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/** `wmux daemon headless on | off | status`; `wmuxDir` is the daemon's data dir (a test seam). */
export async function runHeadless(verb: string | undefined, jsonMode: boolean, wmuxDir: string = getWmuxDir(), spawnIdArg?: string): Promise<void> {
  const flag = headlessFlagPath(join(wmuxDir, 'a2a'));
  const say = jsonMode ? console.error : console.log;
  if (verb === 'status') {
    const st = headlessStatus(wmuxDir, await headlessIo.daemonView());
    if (jsonMode) {
      console.log(JSON.stringify(st, null, 2));
      return;
    }
    console.log(st.inEffect ? 'Headless mode: on. PCs with an allow rule can start agents here with no person approving.' : `Headless mode: not in effect: ${st.reason}.`);
    // Only a daemon that answered is known to be up and holding.
    if (st.inEffect && st.from === 'daemon') console.log(HEADLESS_STAYS_UP);
    console.log(`Agents started remotely, running: ${st.running}`);
    for (const r of st.runningStarts) console.log(`  ${r.spawnId} from ${r.hostId}, since ${r.since}${r.worktreePath ? `, in ${r.worktreePath}` : ''}`);
    console.log(`Worktrees of ended starts, kept: ${st.leftovers.length}`);
    for (const p of st.leftovers) console.log(`  ${p}`);
    for (const [hostId, n] of Object.entries(st.perPc)) console.log(`  from ${hostId}: ${n.running} running, ${n.kept} kept`);
    if (st.heldUp.length > 0) {
      console.log(`Starts waiting for their agent's processes to exit (worktree kept until then): ${st.heldUp.length}`);
      for (const p of st.heldUp) console.log(`  ${p}`);
      console.log('Once you checked those processes are gone (or stopped them), drop a hold with `wmux daemon headless release <spawn id>`.');
    }
    if (st.setAside) {
      console.log(`The start file was found unreadable and set aside (${st.setAside.files.join(', ')}): starts recorded before that are not listed above, and their worktrees and branches may remain.`);
      if (st.setAside.unrecordedWorktrees.length > 0) {
        console.log('Remote-start worktrees no start record names:');
        for (const p of st.setAside.unrecordedWorktrees) console.log(`  ${p}`);
      }
      console.log('Check them with `git worktree list` in their repository, and remove one you no longer need with `git worktree remove` and `git branch -D`.');
    }
    if (st.from === 'files') console.log('(No daemon answered: read from the data dir only.)');
    return;
  }
  if (verb === 'off') {
    if (existsSync(flag)) unlinkSync(flag);
    if (jsonMode) console.log(JSON.stringify({ ok: true, optedIn: false }, null, 2));
    else console.log('Headless mode: off. No new remote start here. Agents it started that still run end within a minute; their worktrees and branches are kept. With nothing attached, the daemon exits when idle again.');
    return;
  }
  if (verb !== 'on' && verb !== 'release') headlessFail('Usage: wmux daemon headless on | off | status | release <spawn id>');
  // A person decides this, in a terminal outside wmux: an agent may not do it for itself.
  const env = process.env;
  const marker = env.WMUX_PTY_ID ? 'WMUX_PTY_ID' : Object.keys(env).find((k) => env[k] !== undefined && isNestingMarker(k));
  if (marker) headlessFail(`\`wmux daemon headless ${verb}\` is not run from an agent session or a wmux pane (${marker} is set). A person must run it, in a terminal outside wmux.`);
  if (verb === 'release') return releaseHold(spawnIdArg, wmuxDir, jsonMode);
  const APP_USED = 'the desktop app has used this install; it starts remote agents here. Headless mode is only for a host without the app.';
  if (await appKnown(wmuxDir)) headlessFail(APP_USED);
  if (!policyIo.stdinIsTty()) headlessFail('`wmux daemon headless on` asks for a typed confirmation. Run it in a terminal.');
  if (existsSync(flag)) {
    if (jsonMode) console.log(JSON.stringify({ ok: true, optedIn: true, changed: false }, null, 2));
    else console.log('Headless mode is on already.');
    await sayStaysUp(say);
    return;
  }
  say([
    'Headless mode: this daemon starts agents itself for other PCs.',
    'Every PC with an allow rule here (see `wmux remote allowed`) can then start an agent on this host with no person approving each start.',
    'Each agent runs in a new git worktree of the allowed folder, in the permission mode set with `wmux remote allow`, as the account this daemon runs as.',
    'A request no rule matches is refused at once. Turn it off with `wmux daemon headless off`.',
  ].join('\n'));
  const answer = (await policyIo.ask('Type yes to turn it on: ', jsonMode)).trim().toLowerCase();
  if (answer !== 'yes') headlessFail('not confirmed; nothing was changed.');
  // The app may have attached while the question waited.
  if (await appKnown(wmuxDir)) headlessFail(APP_USED);
  mkdirSync(join(wmuxDir, 'a2a'), { recursive: true, mode: 0o700 });
  writeFileSync(flag, `${new Date().toISOString()}\n`, { mode: 0o600 });
  if (jsonMode) console.log(JSON.stringify({ ok: true, optedIn: true, changed: true }, null, 2));
  else console.log('Headless mode: on.');
  await sayStaysUp(say);
}

/**
 * `release <spawnId>`: drop the hold on a start whose agent's processes the
 * daemon could not see exit, after the person checked them. Left as a word
 * for the daemon (a file), read at its next reconcile (within a minute).
 */
async function releaseHold(spawnId: string | undefined, wmuxDir: string, jsonMode: boolean): Promise<void> {
  if (!spawnId || !/^sp-[0-9a-f-]{36}$/.test(spawnId)) headlessFail('Usage: wmux daemon headless release <spawn id> (as `wmux daemon headless status` lists it)');
  const held = headlessStatus(wmuxDir).heldUp.find((h) => h.startsWith(`${spawnId}:`));
  if (!held) headlessFail(`no start ${spawnId} is waiting for its processes.`);
  if (!policyIo.stdinIsTty()) headlessFail('`wmux daemon headless release` asks for a typed confirmation. Run it in a terminal.');
  const say = jsonMode ? console.error : console.log;
  say(`Held: ${held}`);
  say('Releasing lets the daemon end this start: if it never finished, its worktree is removed; otherwise it is kept and listed.');
  const answer = (await policyIo.ask('Type yes once those processes are gone: ', jsonMode)).trim().toLowerCase();
  if (answer !== 'yes') headlessFail('not confirmed; nothing was changed.');
  const file = headlessReleasePath(join(wmuxDir, 'a2a'), spawnId);
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
  if (jsonMode) console.log(JSON.stringify({ ok: true, released: spawnId }, null, 2));
  else console.log('Released. The daemon ends it within a minute.');
}

export async function handleDaemon(sub: string | undefined, rest: string[], jsonMode: boolean): Promise<void> {
  switch (sub) {
    case 'headless':
      return runHeadless(rest[0], jsonMode, undefined, rest[1]);
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
        console.error(`Usage: wmux daemon start | stop | status | run | install-service | uninstall-service | headless on|off|status|release`);
      }
      process.exitCode = 1;
  }
}
