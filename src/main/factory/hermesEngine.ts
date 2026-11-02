// ─── The Hermes bot engine — wmux's own Hermes home and its checks ─────────
//
// A Hermes bot (BotEngine `{kind:'acp', preset:'hermes'}`) runs `hermes acp`
// against a Hermes home wmux owns: `<wmuxDir>/factory/hermes` (R), never the
// owner's own `~/.hermes`. Every Hermes bot shares R's default profile; the
// owner sets its model and sign-in once there (Hermes's own `hermes model`,
// in a terminal tab wmux opens), and wmux never reads its credentials.
//
// wmux writes R's settings with Hermes's own `hermes config set` and reads
// them back with `hermes config get --json` before every agent spawn; a
// setting that does not read back as written refuses the spawn. The tool
// surface is an allowlist (`platform_toolsets.acp`), the disabled list is a
// second layer, and the first turn of every session is checked again against
// the tools the session really holds (AcpBrainAdapter `toolsCheck`).
//
// Hermes runs each turn in a detached gateway process (one per home) that
// takes the environment of whatever starts it first. Every Hermes process
// wmux starts gets an allowlisted environment (no API keys, tokens or wmux
// pane identity), and a running gateway in R that wmux did not see start in
// this app run is restarted before a bot attaches. On quit, wmux stops R's
// gateway through Hermes (`gateway stop --yes`), then by its PID once
// gateway_state.json says it is R's.
//
// Readiness (FACTORY_HERMES_READINESS) answers without a model turn: hermes
// found, version in the tested range, settings applied, a model set, and one
// probe session proving Hermes can start an MCP server (the `mcp` extra; a
// standard install has it through `[all]`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { isExecutableFile } from '../claude/resolveClaudeExecutable';
import {
  HERMES_MCP_FIX_COMMAND,
  HERMES_VERSION_BELOW,
  HERMES_VERSION_MIN,
  hermesVersionStatus,
  type HermesReadiness,
} from '../../shared/hermesEngine';
import { HERMES_NOT_READY_LEAD } from './engineError';
import { hermesInstallVersion } from './hermesInstall';

/** wmux's Hermes home for this data dir. */
export function hermesRoot(wmuxDir: string): string {
  return path.join(wmuxDir, 'factory', 'hermes');
}

// ── the tool surface ────────────────────────────────────────────────────────

/** The toolsets a Hermes bot holds besides its wmux MCP tools. Every bot
 *  shares R's default profile, so each one must keep no state across
 *  sessions:
 *  - `web` (web_search, web_extract; Hermes toolsets.py:76): stateless reads.
 *  - `todo` (todo_list): an in-memory list on the session's own agent, one
 *    per session (Hermes tools/todo_tool.py:1-4, :27-28). */
export const HERMES_ALLOWED_TOOLSETS: readonly string[] = ['web', 'todo'];

/** The second layer: what Hermes would otherwise add to an ACP session.
 *  `session_search` reads other sessions of the profile (another bot's);
 *  `skills` and `memory` keep instructions across sessions; `vision` reads
 *  local image files; `connections` installs MCP servers. */
export const HERMES_DISABLED_TOOLSETS: readonly string[] = [
  'terminal', 'code_execution', 'file', 'browser', 'delegation',
  'connections', 'skills', 'memory', 'vision', 'session_search',
];

/** The tool names the allowed toolsets give (what `/tools` and the agent's
 *  tool calls may name, besides the session's MCP tools). */
export const HERMES_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_extract', 'todo_list']);

/** Whether a Hermes bot may hold `name`: an allowed tool, or one of the
 *  session's own MCP servers (Hermes names them `mcp__editor_<server>_<tag>__<tool>`;
 *  the only session server wmux gives is `wmux`). Pure. */
export function hermesToolAllowed(name: string): boolean {
  return HERMES_ALLOWED_TOOLS.has(name) || /^mcp__editor_wmux_[a-z0-9]+__[A-Za-z0-9_]+$/.test(name);
}

// ── the settings wmux writes ────────────────────────────────────────────────

type Unset = { unset: true };
const UNSET: Unset = { unset: true };

export interface HermesSetting {
  key: string;
  /** What `hermes config set <key>` writes, or UNSET for `config unset`. */
  write: string | Unset;
  /** Whether the value `config get --json` resolves (undefined: not set) is right. */
  ok: (value: unknown) => boolean;
}

const emptyish = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
const sameSet = (want: readonly string[]) => (v: unknown): boolean =>
  Array.isArray(v) && v.length === want.length && want.every((w) => v.includes(w));
const yamlList = (xs: readonly string[]): string => `[${xs.join(', ')}]`;

export const HERMES_SETTINGS: readonly HermesSetting[] = [
  { key: 'platform_toolsets.acp', write: yamlList(HERMES_ALLOWED_TOOLSETS), ok: sameSet(HERMES_ALLOWED_TOOLSETS) },
  { key: 'agent.disabled_toolsets', write: yamlList(HERMES_DISABLED_TOOLSETS), ok: sameSet(HERMES_DISABLED_TOOLSETS) },
  // The passive update check writes to ~/.hermes even with HERMES_HOME set.
  { key: 'updates.check', write: 'false', ok: (v) => v === false },
  // MCP tools straight in the tool list, without the tool_search/tool_call bridge.
  { key: 'tools.tool_search.enabled', write: 'off', ok: (v) => v === 'off' || v === false },
  { key: 'approvals.mode', write: 'manual', ok: (v) => v === 'manual' },
  { key: 'approvals.timeout', write: '300', ok: (v) => v === 300 },
  { key: 'gateway.unmanaged_idle_exit_seconds', write: '600', ok: (v) => v === 600 },
  { key: 'security.allow_private_urls', write: 'false', ok: (v) => v === false },
  { key: 'context.engine', write: 'compressor', ok: (v) => v === undefined || v === 'compressor' },
  { key: 'mcp_servers', write: UNSET, ok: emptyish },
  { key: 'plugins.enabled', write: UNSET, ok: emptyish },
  { key: 'command_allowlist', write: UNSET, ok: emptyish },
];

/** The settings whose resolved values are wrong. Pure. */
export function hermesSettingsMismatches(values: ReadonlyMap<string, unknown>): string[] {
  return HERMES_SETTINGS.filter((s) => !s.ok(values.get(s.key))).map((s) => s.key);
}

// ── the environment every Hermes process gets ──────────────────────────────

// Upper case: Windows names are matched ignoring case (its PATH is `Path`).
const ENV_ALLOW = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TZ',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE',
  // A managed network's proxy and CA bundle, which Hermes's HTTP clients read.
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']);
const PROXY_LOWER = new Set(['https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']);

/** The environment of a Hermes process wmux starts: an allowlist of `base`
 *  (no API keys, tokens or wmux pane identity reach Hermes; its credentials
 *  come from R's own files), `HERMES_HOME=root`, and PATH extended with the
 *  installer's folder (a Finder launch lacks it). Pure. */
export function hermesEnv(root: string, base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    const allowed = ENV_ALLOW.has(platform === 'win32' ? k.toUpperCase() : k) || PROXY_LOWER.has(k) || k.startsWith('LC_');
    if (typeof v === 'string' && allowed) out[k] = v;
  }
  const sep = platform === 'win32' ? ';' : ':';
  const extra = hermesInstallDirs(base, platform, home);
  const pathKey = platform === 'win32' ? Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'Path' : 'PATH';
  const parts = (out[pathKey] ?? '').split(sep).filter(Boolean);
  out[pathKey] = [...parts, ...extra.filter((d) => !parts.includes(d))].join(sep);
  out.HERMES_HOME = root;
  out.PYTHONIOENCODING = 'utf-8';
  return out;
}

/** Where the official installer publishes `hermes`: `~/.local/bin`
 *  (setup-hermes.sh:216), on Windows `%LOCALAPPDATA%\hermes\bin` (:218; it
 *  follows the installing shell's HERMES_HOME, which wmux cannot know). Pure. */
export function hermesInstallDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return [path.win32.join(base, 'hermes', 'bin')];
  }
  return [path.posix.join(home, '.local', 'bin')];
}

/** The `hermes` executable: the first on PATH, else in the installer's
 *  folder. */
export function resolveHermesExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  isExec: (p: string) => boolean = isExecutableFile,
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = [...(env.PATH ?? env.Path ?? '').split(sep).filter((d) => d && p.isAbsolute(d)), ...hermesInstallDirs(env, platform, home)];
  // Windows: the installer publishes hermes.exe (Hermes hermes_cli/_launchers.py:248-306); its
  // .cmd fallback (:339) cannot be started without a shell.
  const exts = platform === 'win32' ? ['.exe'] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const c = p.join(d, `hermes${ext}`);
      try {
        if (isExec(c)) return c;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

// ── running hermes ──────────────────────────────────────────────────────────

export interface HermesRunResult { code: number; stdout: string; stderr: string }

export type HermesRun = (exe: string, args: string[], opts: { env: Record<string, string>; timeoutMs: number }) => Promise<HermesRunResult>;

/** Run `hermes <args>` to completion (bounded). Never throws. */
export const runHermes: HermesRun = (exe, args, opts) => new Promise((resolve) => {
  execFile(exe, args, { env: opts.env, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, cwd: opts.env.HERMES_HOME },
    (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
});

/** The resolved value of `key` in R (undefined: not set). Throws when Hermes
 *  could not answer. */
export async function hermesConfigGet(run: HermesRun, exe: string, env: Record<string, string>, key: string): Promise<unknown> {
  const r = await run(exe, ['config', 'get', '--json', key], { env, timeoutMs: 20_000 });
  if (r.code !== 0) {
    if (/config key not set/i.test(r.stdout + r.stderr)) return undefined;
    throw new Error(`hermes config get ${key} failed`);
  }
  const text = r.stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`hermes config get ${key}: unreadable answer`);
  }
}

/** Read every wmux setting of R (in parallel); write the wrong ones and read
 *  them again. Resolves the keys still wrong ([] when all read back). */
export async function applyHermesSettings(run: HermesRun, exe: string, env: Record<string, string>): Promise<string[]> {
  const read = async (): Promise<Map<string, unknown>> => new Map(await Promise.all(
    HERMES_SETTINGS.map(async (s) => [s.key, await hermesConfigGet(run, exe, env, s.key)] as const)));
  const wrong = hermesSettingsMismatches(await read());
  if (wrong.length === 0) return [];
  for (const key of wrong) {
    const s = HERMES_SETTINGS.find((x) => x.key === key) as HermesSetting;
    const args = typeof s.write === 'string' ? ['config', 'set', key, s.write] : ['config', 'unset', key];
    await run(exe, args, { env, timeoutMs: 20_000 });
  }
  return hermesSettingsMismatches(await read());
}

/** Whether R has a model set (Hermes's `model` block, or a bare model id). Pure. */
export function hermesHasModel(model: unknown): boolean {
  if (typeof model === 'string') return model.trim().length > 0;
  if (model && typeof model === 'object') {
    const m = model as Record<string, unknown>;
    const id = m.default ?? m.model;
    return typeof id === 'string' && id.trim().length > 0;
  }
  return false;
}

// ── the gateway ─────────────────────────────────────────────────────────────

export interface HermesGatewayState {
  pid: number;
  argv: string[];
  hermesHome: string;
  platforms: Record<string, unknown>;
  /** Hermes's start record of the gateway process (gateway/status.py:472-504): on
   *  macOS and Windows its creation time in centiseconds since the epoch, on Linux
   *  its start in clock ticks since boot (/proc/<pid>/stat field 22). */
  startTime?: number;
  /** When the file was last written (ms). */
  writtenAt: number;
}

/** R's gateway_state.json, when it names a gateway. */
export function readHermesGatewayState(root: string): HermesGatewayState | null {
  try {
    const file = path.join(root, 'gateway_state.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const pid = raw.pid;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null;
    return {
      pid: pid as number,
      ...(Number.isSafeInteger(raw.start_time) && (raw.start_time as number) > 0 ? { startTime: raw.start_time as number } : {}),
      writtenAt: fs.statSync(file).mtimeMs,
      argv: Array.isArray(raw.argv) ? raw.argv.filter((a): a is string => typeof a === 'string') : [],
      hermesHome: typeof raw.hermes_home === 'string' ? raw.hermes_home : '',
      platforms: raw.platforms && typeof raw.platforms === 'object' && !Array.isArray(raw.platforms) ? raw.platforms as Record<string, unknown> : {},
    };
  } catch {
    return null;
  }
}

const samePath = (a: string, b: string): boolean => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

/** Whether `state` is a gateway of R that a viewer started (`gateway run
 *  --idle-exit`, Hermes's own auto-start). Pure over its inputs. */
export function isHermesGatewayOf(root: string, state: HermesGatewayState, same: (a: string, b: string) => boolean = samePath): boolean {
  return same(state.hermesHome, root) && state.argv.includes('gateway') && state.argv.includes('run');
}

/** A running process as the OS reports it: its command line, its
 *  HERMES_HOME when the OS lets wmux read its environment (not Windows), and
 *  when it was created: `createdAt` (ms since the epoch; macOS, Windows) or
 *  `startTicks` (Linux, the unit Hermes records there). */
export interface LiveProcess { command: string; hermesHome?: string; createdAt?: number; startTicks?: number }
export type ProcessInfo = (pid: number) => Promise<LiveProcess | null>;

const execText = (file: string, args: string[]): Promise<string | null> => new Promise((resolve) => {
  execFile(file, args, { timeout: 5_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
});

/** The live process `pid`, or null when it is gone or cannot be read. */
export const processInfo: ProcessInfo = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Line 1: creation time (ms since the epoch); the rest: the command line.
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds(); $p.CommandLine }`;
    const ps = await execText(powershell, ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (ps !== null) return parseWindowsProcess(ps);
    const wmic = await execText('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine,CreationDate', '/value']);
    return wmic === null ? null : parseWmicProcess(wmic);
  }
  if (process.platform === 'linux') {
    try {
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
      if (!command) return null;
      // Field 22, counted after the parenthesised name (which may hold spaces).
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      let home: string | undefined;
      try {
        home = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((e) => e.startsWith('HERMES_HOME='))?.slice('HERMES_HOME='.length);
      } catch {
        home = undefined;
      }
      return { command, ...(home !== undefined ? { hermesHome: home } : {}), ...(Number.isSafeInteger(ticks) ? { startTicks: ticks } : {}) };
    } catch {
      return null;
    }
  }
  const command = (await execText('ps', ['-ww', '-o', 'command=', '-p', String(pid)]))?.trim();
  if (!command) return null;
  // macOS appends a same-user process's environment after its command.
  const withEnv = (await execText('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)]))?.trim() ?? '';
  const env = withEnv.startsWith(command) ? withEnv.slice(command.length) : '';
  const m = /(?:^|\s)HERMES_HOME=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)/.exec(env);
  const started = Date.parse((await execText('ps', ['-o', 'lstart=', '-p', String(pid)]))?.trim() ?? '');
  return { command, ...(m ? { hermesHome: m[1] } : {}), ...(Number.isFinite(started) ? { createdAt: started } : {}) };
};

/** PowerShell's answer: the creation time (ms) on its first line, the command line after. Pure. */
export function parseWindowsProcess(out: string): LiveProcess | null {
  const [first, ...rest] = out.replace(/\r/g, '').split('\n');
  const command = rest.join(' ').trim();
  const createdAt = Number(first.trim());
  return command ? { command, ...(Number.isSafeInteger(createdAt) && createdAt > 0 ? { createdAt } : {}) } : null;
}

/** wmic's `/value` answer: CommandLine= and CreationDate=yyyymmddHHMMSS.ffffff±UUU (minutes from UTC). Pure. */
export function parseWmicProcess(out: string): LiveProcess | null {
  const command = /^\s*CommandLine=(.*)$/m.exec(out)?.[1]?.trim() ?? '';
  const d = /^\s*CreationDate=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})\d*([+-]\d+)/m.exec(out);
  const createdAt = d ? Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5], +d[6], +d[7]) - Number(d[8]) * 60_000 : NaN;
  return command ? { command, ...(Number.isFinite(createdAt) ? { createdAt } : {}) } : null;
}

/** How much later than the gateway's start record a genuine gateway process
 *  may read as created (clock and rounding slack). */
const CREATED_SLACK_MS = 2_000;

/** Whether the live process is the gateway `state` names in R: its command
 *  line runs `hermes_cli … gateway run`, and its HERMES_HOME is R. Where that
 *  cannot be read (Windows, or an unreadable environment), the process must
 *  instead be no newer than the state's start record (Hermes's start time,
 *  else the file's last write): a PID reused after the gateway died fails
 *  this. Unknown creation time: not the gateway. Pure. */
export function liveGatewayOf(
  root: string,
  live: LiveProcess | null,
  state: Pick<HermesGatewayState, 'startTime' | 'writtenAt'>,
  same: (a: string, b: string) => boolean = samePath,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!live || !/hermes_cli/.test(live.command) || !/\bgateway\s+run\b/.test(live.command)) return false;
  if (live.hermesHome !== undefined) return same(live.hermesHome, root);
  if (platform === 'linux') {
    // Hermes records Linux start ticks: the same process has the same value.
    return live.startTicks !== undefined && state.startTime !== undefined && live.startTicks === state.startTime;
  }
  if (live.createdAt === undefined) return false;
  const recorded = state.startTime !== undefined ? state.startTime * 10 : state.writtenAt;
  return live.createdAt <= recorded + CREATED_SLACK_MS;
}

// ── the probe: can Hermes start an MCP server? ──────────────────────────────

/** A minimal MCP server (stdio) run on wmux's own binary in Node mode: it
 *  marks that it started (the file named in argv[1]) and answers the
 *  handshake with no tools. Hermes starts it only when its `mcp` extra is
 *  installed. */
const PROBE_MCP_SCRIPT = [
  "const fs=require('fs');try{fs.writeFileSync(process.argv[1],'1',{flag:'wx',mode:0o600})}catch(e){}",
  "let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);let m;try{m=JSON.parse(l)}catch(e){continue}",
  "if(m==null||m.id===undefined)continue;const r=m.method==='initialize'?{protocolVersion:(m.params&&m.params.protocolVersion)||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'wmux-probe',version:'1'}}:m.method==='tools/list'?{tools:[]}:null;",
  "process.stdout.write(JSON.stringify(r?{jsonrpc:'2.0',id:m.id,result:r}:{jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'none'}})+'\\n')}});",
  "process.stdin.on('end',()=>process.exit(0));",
].join('');

export type HermesProbeResult = { ok: true } | { ok: false; reason: 'mcp-missing' | 'failed'; detail: string };

/** One ACP session in R with the probe MCP server, no prompt: proves Hermes
 *  starts an MCP server for a session. */
export async function probeHermesMcp(exe: string, env: Record<string, string>, opts: { execPath?: string; timeoutMs?: number; onSessionStarted?: () => void } = {}): Promise<HermesProbeResult> {
  const root = env.HERMES_HOME;
  const marker = path.join(root, `.wmux-probe-${process.pid}-${Date.now()}`);
  const child = spawn(exe, ['acp'], { env, cwd: root, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const decoder = new StringDecoder('utf8');
  let buf = '';
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  child.stdout.on('data', (d: Buffer) => {
    buf += decoder.write(d);
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof msg.id === 'number' && waiting.has(msg.id) && ('result' in msg || 'error' in msg)) {
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      } else if (msg.id !== undefined && typeof msg.method === 'string') {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } })}\n`);
      }
    }
  });
  let nextId = 1;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const call = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: { message: `${method} timed out` } }); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const failWaiting = (message: string): void => {
    for (const [, w] of waiting) w({ error: { message } });
    waiting.clear();
  };
  // A write to an agent that already exited is not an error of main's.
  child.stdin.on('error', () => undefined);
  child.once('error', () => failWaiting('hermes did not start'));
  child.once('exit', () => failWaiting('hermes exited'));
  try {
    const init = await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
    if (init.error) return { ok: false, reason: 'failed', detail: 'ACP initialize failed' };
    const created = await call('session/new', {
      cwd: root,
      mcpServers: [{ name: 'wmuxprobe', command: opts.execPath ?? process.execPath, args: ['-e', PROBE_MCP_SCRIPT, marker], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] }],
    });
    if (created.error) return { ok: false, reason: 'failed', detail: 'ACP session/new failed' };
    opts.onSessionStarted?.();
    // Hermes discovers a session's servers inside session/new; allow a beat
    // for a slow spawn.
    for (let i = 0; i < 20 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 250));
    return fs.existsSync(marker)
      ? { ok: true }
      : { ok: false, reason: 'mcp-missing', detail: `Hermes did not start an MCP server; add its MCP support with \`${HERMES_MCP_FIX_COMMAND}\`` };
  } finally {
    try {
      child.stdin.end();
    } catch {
      /* gone */
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    if (child.exitCode === null) child.kill();
    try {
      fs.unlinkSync(marker);
    } catch {
      /* never written */
    }
  }
}

// ── readiness ───────────────────────────────────────────────────────────────

export interface HermesReadinessDeps {
  root: string;
  resolveExe: () => string | null;
  /** The version of the install `exe` runs, read from its files (default:
   *  hermesInstall.ts hermesInstallVersion). Never `hermes --version`, whose
   *  update check fetches in that install. */
  version?: (exe: string) => string | null;
  run: HermesRun;
  env: (root: string) => Record<string, string>;
  /** The probe (default probeHermesMcp); `null` result: skipped. */
  probe: (exe: string, env: Record<string, string>) => Promise<HermesProbeResult>;
  /** The mtime of the executable, for the probe cache. */
  stamp?: (exe: string) => string;
}

const probeCache = new Map<string, HermesProbeResult>();

/** Forget the probe results (tests; a Fix that changed the install). */
export function clearHermesProbeCache(): void {
  probeCache.clear();
}

function notReady(reason: NonNullable<HermesReadiness['reason']>, message: string, version?: string): HermesReadiness {
  return { ready: false, reason, message, ...(version ? { version } : {}) };
}

/** Whether a Hermes bot can run here. Never throws. Writes R's settings when
 *  they are wrong (creating R first). */
export async function hermesReadiness(deps: HermesReadinessDeps): Promise<HermesReadiness> {
  try {
    const exe = deps.resolveExe();
    if (!exe) return notReady('not-installed', 'Hermes is not installed (no hermes executable found).');
    fs.mkdirSync(deps.root, { recursive: true, mode: 0o700 });
    const env = deps.env(deps.root);
    // Read from the install's files: `hermes --version` would run Hermes's
    // update check, which fetches in the install `hermes` resolves to.
    const version = (deps.version ?? hermesInstallVersion)(exe);
    if (!version) return notReady('unknown', 'wmux could not read the version of the Hermes install that `hermes` runs.');
    const status = hermesVersionStatus(version);
    if (status === 'outdated') return notReady('outdated', `Hermes ${version} is older than ${HERMES_VERSION_MIN}.`, version);
    if (status === 'unsupported') return notReady('unsupported', `Hermes ${version} is newer than the versions wmux was tested with (below ${HERMES_VERSION_BELOW}).`, version);
    const wrong = await applyHermesSettings(deps.run, exe, env);
    if (wrong.length > 0) return notReady('config-mismatch', `wmux could not apply these Hermes settings: ${wrong.join(', ')}.`, version);
    if (!hermesHasModel(await hermesConfigGet(deps.run, exe, env, 'model'))) {
      return notReady('not-set-up', 'wmux\'s Hermes has no model yet.', version);
    }
    const key = `${exe}\0${deps.stamp?.(exe) ?? ''}\0${version}`;
    let probe = probeCache.get(key);
    if (!probe) {
      probe = await deps.probe(exe, env);
      // Only a pass is remembered: the missing extra is added in a terminal
      // (HERMES_MCP_FIX_COMMAND) without touching the executable.
      if (probe.ok) probeCache.set(key, probe);
    }
    if (!probe.ok) return notReady(probe.reason === 'mcp-missing' ? 'mcp-missing' : 'unknown', probe.detail, version);
    return { ready: true, version };
  } catch (err) {
    return notReady('unknown', `Hermes could not be checked (${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}).`);
  }
}

/** The turn error for a not-ready engine (classified `hermes_not_ready`). Pure. */
export function hermesNotReadyMessage(r: HermesReadiness): string {
  return `${HERMES_NOT_READY_LEAD} ${r.message ?? r.reason ?? 'unknown reason'}`;
}

// ── the setup tab ───────────────────────────────────────────────────────────

/** The line a terminal tab runs for the one-time setup: Hermes's own `hermes
 *  model` against R, with the allowlisted environment on POSIX (`env -i`).
 *  Windows shells cannot clear the environment here; the gateway check before
 *  a bot attaches restarts any gateway this tab started. Null when a path
 *  cannot be typed safely in that shell. Pure. */
export function hermesSetupLine(platform: NodeJS.Platform, shell: string | undefined, exe: string, env: Record<string, string>): string | null {
  const root = env.HERMES_HOME;
  if (/[\r\n\0]/.test(exe + root)) return null;
  if (platform === 'win32') {
    const base = (shell ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
    if (base.startsWith('cmd')) {
      if (/["%]/.test(exe + root)) return null;
      return `set "HERMES_HOME=${root}" & "${exe}" model`;
    }
    const q = (s: string): string => `'${s.replace(/['‘’‚‛]/g, (c) => c + c)}'`;
    return `$env:HERMES_HOME=${q(root)}; & ${q(exe)} model`;
  }
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const vars = Object.entries(env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => `${k}=${q(v)}`).join(' ');
  return `env -i ${vars} ${q(exe)} model`;
}
