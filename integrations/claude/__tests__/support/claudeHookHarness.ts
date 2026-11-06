/**
 * Runs one characterisation fixture against a Claude hook implementation: a
 * fresh sandbox home, a random WMUX_DATA_SUFFIX (so even a derived pipe name
 * is unique), stub endpoints, a scrubbed env, then every step as a real
 * process. The result is normalised so it holds on every OS and every run:
 * sandbox paths, the suffix, request ids, timestamps and pids become fixed
 * tokens after they have been checked.
 *
 * The implementation is `node integrations/claude/bin/wmux-bridge.mjs` (the
 * reference) unless WMUX_CLAUDE_HOOK_IMPL names another command, as
 * `<exe> [prefix args…]` split on whitespace, or as a JSON array when a path
 * has spaces. The fixture's argv follows the prefix. Every check below holds
 * for any implementation: the log pid is the spawned process, and on macOS
 * agentPid is this test process, so a wrapper has to exec, not fork.
 *
 * Two tiers of comparison, as the port is held to them:
 *   - raw bytes: stdout, stderr and the WMUX_BRIDGE_DEBUG_ENVELOPE line, with
 *     volatile values masked by substitution in the text itself;
 *   - JSON round-trip: bridge.log lines and RPC requests (key order kept).
 *
 * `variants` lists the outcomes the reference may produce where node itself
 * is racy. A port is held to `strictForPort` at the same path instead: the
 * single outcome a full-duplex transport must reach; or, where only the
 * kernel's errno differs between runs or platforms, to `portVariants`.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { startStubDaemon, type StubBehaviour, type StubConnection, type StubDaemon } from './stubDaemon';

export const BRIDGE_PATH = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');

function implCommand(): string[] {
  const raw = process.env.WMUX_CLAUDE_HOOK_IMPL?.trim();
  if (!raw) return [process.execPath, BRIDGE_PATH];
  return raw.startsWith('[') ? (JSON.parse(raw) as string[]) : raw.split(/\s+/);
}

export const IMPL = implCommand();
/** True when the reference (node + the .mjs) runs, so `variants` apply. */
export const IS_REFERENCE = !process.env.WMUX_CLAUDE_HOOK_IMPL?.trim();
/**
 * The Node bridge beside a native implementation's binary (what its kill
 * switch and a stale pin hand runs to). Its path is masked like the
 * reference's.
 */
const SIBLING_BRIDGE = IS_REFERENCE ? BRIDGE_PATH : path.join(path.dirname(IMPL[0]), 'wmux-bridge.mjs');

type StdinPart = string | { repeat: string; count: number } | { base64: string };
type Endpoint = StubBehaviour | { mode: 'absent' } | { mode: 'refused' };
type EndpointName = 'daemon' | 'main' | 'override';
/** `data` is the sandbox home the tokens are in; `alt` is a second home holding decoy tokens. */
export type HomeChoice = 'data' | 'alt';

export interface Step {
  argv: string[];
  env?: Record<string, string>;
  /** Text, parts joined as bytes, or `hold` (stdin left open: proves it is never read). */
  stdin?: string | { parts: StdinPart[] } | { hold: true };
  /** Activity stamp name → its age in ms, set on the file just before the step. */
  stampAges?: Record<string, number>;
  /** Streams whose reader is gone before the implementation writes: closed right after spawn. */
  closed?: ('stdout' | 'stderr')[];
}

export interface Fixture {
  description: string;
  /** Node behaviour the native port documents as different instead of copying. */
  divergence?: string;
  platforms?: NodeJS.Platform[];
  skipReason?: string;
  /** Token files; defaults to both. `{}` writes none. */
  tokens?: { daemon?: string; main?: string };
  /** Extra files, relative to the data home. */
  files?: Record<string, string>;
  /**
   * HOME and USERPROFILE; both `data` by default. USERPROFILE may also be ''
   * or unset. On Windows an unset USERPROFILE is filled in from this test
   * process (libuv's uv_spawn copies its required_vars, USERPROFILE among
   * them, into a child env that lacks them), so `parentUSERPROFILE` points
   * this process's own USERPROFILE into the sandbox for the run.
   */
  homes?: { HOME?: HomeChoice; USERPROFILE?: HomeChoice | '' | 'unset'; parentUSERPROFILE?: HomeChoice };
  /** How the daemon-pipe hint file is written; `absent` leaves the derived name. */
  daemonHint?: 'lf' | 'crlf' | 'blanks' | 'absent';
  endpoints?: Partial<Record<EndpointName, Endpoint>>;
  env?: Record<string, string>;
  steps: Step[];
  timing?: { step: number; minMs?: number; maxMs?: number }[];
  /** Dotted path in the result → the values the reference may produce there. */
  variants?: Record<string, unknown[]>;
  /** More values allowed at a path on one platform only. */
  platformVariants?: Partial<Record<NodeJS.Platform, Record<string, unknown[]>>>;
  /** Dotted path → the one value a port must produce there. */
  strictForPort?: Record<string, unknown>;
  /** Dotted path → the values a port may produce there, in place of `variants`. */
  portVariants?: Record<string, unknown[]>;
  expect?: { steps: unknown[] };
}

export interface Sandbox {
  root: string;
  home: string;
  cwd: string;
  wmuxHome: string;
  suffix: string;
}

const SAFETY_KILL_MS = 20_000;

function makeSandbox(): Sandbox {
  // Short POSIX root: sockets live under it and sun_path is 104 bytes on macOS.
  const base = process.platform === 'win32' ? tmpdir() : '/tmp';
  const root = realpathSync(mkdtempSync(path.join(base, 'wch-')));
  const suffix = `-c${randomBytes(3).toString('hex')}`;
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  const wmuxHome = path.join(home, `.wmux${suffix}`);
  for (const dir of [home, cwd, wmuxHome]) mkdirSync(dir, { recursive: true });
  return { root, home, cwd, wmuxHome, suffix };
}

function fill(text: string, box: Sandbox): string {
  return text
    .replaceAll('<sandbox>', box.root.replaceAll('\\', '/'))
    .replaceAll('<home>', box.home.replaceAll('\\', '/'))
    .replaceAll('<wmux>', `.wmux${box.suffix}`);
}

function user(): string {
  return userInfo().username || 'default';
}

/** Where each endpoint listens. `posixHome` is HOME: the main socket follows os.homedir(). */
function endpointPath(name: EndpointName, box: Sandbox, posixHome: string, hint: Fixture['daemonHint']): string {
  if (process.platform === 'win32') {
    // Derived names are not configurable; they are unique only through the
    // random suffix, which is what makes them safe to bind here.
    if (name === 'main') return `\\\\.\\pipe\\wmux${box.suffix}-${user()}`;
    if (name === 'daemon' && hint === 'absent') return `\\\\.\\pipe\\wmux-daemon${box.suffix}-${user()}`;
    return `\\\\.\\pipe\\wch-${name}-${randomBytes(4).toString('hex')}`;
  }
  if (name === 'main') return path.join(posixHome, `.wmux${box.suffix}.sock`);
  if (name === 'daemon' && hint === 'absent') return path.join(box.wmuxHome, 'daemon.sock');
  return path.join(box.root, `${name}.sock`);
}

function writeHint(file: string, pipe: string, hint: Fixture['daemonHint']): void {
  if (hint === 'absent') return;
  const text = hint === 'crlf' ? `${pipe}\r\n` : hint === 'blanks' ? ` \t${pipe} \r\n\n` : `${pipe}\n`;
  writeFileSync(file, text);
}

/** A unix socket file nobody listens on: a listener killed before it could unlink it. */
function leaveRefusedSocket(at: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(at)}, () => console.log('up'))`]);
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => {
      child.kill('SIGKILL');
      child.once('exit', () => resolve());
    });
    child.once('error', reject);
  });
}

function stdinBytes(stdin: Step['stdin'], box: Sandbox): Buffer | 'hold' {
  if (stdin === undefined) return Buffer.alloc(0);
  if (typeof stdin === 'string') return Buffer.from(fill(stdin, box), 'utf8');
  if ('hold' in stdin) return 'hold';
  return Buffer.concat(stdin.parts.map((part) => {
    if (typeof part === 'string') return Buffer.from(fill(part, box), 'utf8');
    if ('base64' in part) return Buffer.from(part.base64, 'base64');
    return Buffer.from(part.repeat.repeat(part.count), 'utf8');
  }));
}

/** Pins the throttle without wall-clock: each stamp's mtime is set, not waited for. */
function ageStamps(ages: Step['stampAges'], box: Sandbox): void {
  const dir = path.join(box.wmuxHome, 'activity-stamps');
  for (const [name, ageMs] of Object.entries(ages ?? {})) {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    if (!existsSync(file)) writeFileSync(file, '');
    const when = new Date(Date.now() - ageMs);
    utimesSync(file, when, when);
  }
}

interface RawRun { exitCode: number | null; stdout: string; stderr: string; ms: number; pid: number }

function runImpl(step: Step, env: NodeJS.ProcessEnv, box: Sandbox): Promise<RawRun> {
  const started = Date.now();
  const [exe, ...prefix] = IMPL;
  const child = spawn(exe, [...prefix, ...step.argv], { cwd: box.cwd, env, stdio: 'pipe' });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => out.push(c));
  child.stderr.on('data', (c: Buffer) => err.push(c));
  for (const name of step.closed ?? []) child[name].destroy();
  // The bridge stops reading at its cap and destroys stdin; the rest of a large
  // write then fails here, which is expected.
  child.stdin.on('error', () => { /* expected after the cap */ });
  const input = stdinBytes(step.stdin, box);
  if (input !== 'hold') child.stdin.end(input);
  const safety = setTimeout(() => child.kill(), SAFETY_KILL_MS);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(safety);
      child.stdin.destroy();
      resolve({
        exitCode: code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ms: Date.now() - started,
        pid: child.pid ?? -1,
      });
    });
  });
}

// ----- normalisation -------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The rest of a path after the sandbox root: it ends at whitespace, a quote,
// a colon or a delimiter, so text around the path is left byte for byte.
const PATH_TAIL = String.raw`[^\s"'<>|*?,;:]*`;

/**
 * Masks the sandbox root (as written raw, with forward slashes, or escaped
 * inside JSON text) and turns the separators of that one path into `/`; then
 * the suffix and the implementation's own paths.
 */
export function normaliseString(value: string, box: Sandbox): string {
  const forms = [
    { text: box.root.replaceAll('\\', '\\\\'), sep: '\\\\' },
    { text: box.root, sep: '\\' },
    { text: box.root.replaceAll('\\', '/'), sep: '/' },
  ];
  let text = value;
  const seen = new Set<string>();
  for (const form of forms) {
    if (seen.has(form.text)) continue;
    seen.add(form.text);
    text = text.replace(new RegExp(escapeRegExp(form.text) + `(${PATH_TAIL})`, 'g'), (_m, tail: string) => `<sandbox>${tail.split(form.sep).join('/')}`);
  }
  text = text.replaceAll(box.suffix, '<sfx>');
  for (const [real, token] of [[BRIDGE_PATH, '<bridge>'], [SIBLING_BRIDGE, '<bridge>'], [process.execPath, '<node>'], [IMPL[0], '<impl>']]) {
    text = text.replaceAll(real, token);
  }
  return text;
}

// Goldens stay readable: a long string or a deep subtree is stored as its size
// and hash, which still pins every unit of it.
const LONG_STRING = 512;
const DEEP_LEVEL = 16;

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * JSON.stringify of a parsed JSON value, without recursion: a request the port
 * forwards can nest deeper than this process's stack lets JSON.stringify go.
 */
function stringifyDeep(value: unknown): string {
  const out: string[] = [];
  const todo: ({ text: string } | { value: unknown })[] = [{ value }];
  while (todo.length > 0) {
    const task = todo.pop() as { text: string } | { value: unknown };
    if ('text' in task) {
      out.push(task.text);
      continue;
    }
    const v = task.value;
    if (!v || typeof v !== 'object') {
      out.push(JSON.stringify(v));
      continue;
    }
    const entries = Array.isArray(v) ? v.map((item) => ['', item] as const) : Object.entries(v);
    const later: ({ text: string } | { value: unknown })[] = [{ text: Array.isArray(v) ? '[' : '{' }];
    entries.forEach(([key, item], i) => {
      if (i > 0) later.push({ text: ',' });
      if (!Array.isArray(v)) later.push({ text: `${JSON.stringify(key)}:` });
      later.push({ value: item });
    });
    later.push({ text: Array.isArray(v) ? ']' : '}' });
    for (let i = later.length - 1; i >= 0; i--) todo.push(later[i]);
  }
  return out.join('');
}

function normaliseDeep(value: unknown, box: Sandbox, depth = 0): unknown {
  if (typeof value === 'string') {
    const text = normaliseString(value, box);
    return text.length > LONG_STRING ? `<string length=${text.length} sha256=${digest(text)}>` : text;
  }
  if (value && typeof value === 'object' && depth >= DEEP_LEVEL) {
    const text = stringifyDeep(value);
    return `<json length=${text.length} sha256=${digest(text)}>`;
  }
  if (Array.isArray(value)) return value.map((v) => normaliseDeep(v, box, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normaliseDeep(v, box, depth + 1)]));
  }
  return value;
}

/** Envelope fields that differ every run or by OS, checked before they are fixed. */
function normaliseEnvelope(envelope: Record<string, unknown>, problems: string[]): void {
  if (typeof envelope.ts === 'number') envelope.ts = '<ts>';
  else if ('ts' in envelope) problems.push(`envelope.ts is ${typeof envelope.ts}`);
  // The hook's parent is sent on macOS only; it is this process, which spawned
  // the implementation directly.
  if (process.platform === 'darwin') {
    if (envelope.agentPid !== process.pid) problems.push(`agentPid ${String(envelope.agentPid)} is not the parent ${process.pid}`);
  } else if ('agentPid' in envelope) {
    problems.push('agentPid sent off macOS');
  }
  delete envelope.agentPid;
}

function normaliseConnection(conn: StubConnection, ids: Set<string>, problems: string[]): unknown {
  if (conn.answeredEarly) {
    ids.add(conn.answeredEarly.id);
    return { answeredEarly: true, sawNewline: conn.answeredEarly.sawNewline };
  }
  if (conn.destroyedOverLong) return { destroyedOverLong: true };
  if (conn.reset) return { reset: true };
  const request = conn.request as Record<string, unknown> | undefined;
  if (!request) return { request: 'none' };
  if (typeof request.id === 'string' && /^bridge-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.id)) {
    ids.add(request.id);
    request.id = '<request-id>';
  } else {
    problems.push(`request id ${String(request.id)}`);
  }
  if (request.params && typeof request.params === 'object') {
    normaliseEnvelope(request.params as Record<string, unknown>, problems);
  }
  return request;
}

function normaliseLog(line: string, pid: number, problems: string[]): unknown {
  const entry = JSON.parse(line) as Record<string, unknown>;
  if (typeof entry.ts !== 'string' || Number.isNaN(Date.parse(entry.ts))) problems.push(`log ts ${String(entry.ts)}`);
  if (entry.pid !== pid) problems.push(`log pid ${String(entry.pid)} is not ${pid}`);
  delete entry.ts;
  delete entry.pid;
  // A native implementation marks every line it writes, and no fixture hands
  // a native run to Node, so an unmarked line from a port is a run that went
  // to Node anyway. The reference never marks.
  if (IS_REFERENCE ? 'impl' in entry : entry.impl !== 'native') {
    problems.push(`log impl ${JSON.stringify(entry.impl)}`);
  }
  delete entry.impl;
  // The message is V8's and changes between node releases; the class is the contract.
  if (entry.outcome === 'malformed-stdin' && typeof entry.error === 'string') {
    entry.error = entry.error.split(':')[0];
  }
  return entry;
}

const DEBUG_PREFIX = 'WMUX_BRIDGE_DEBUG_ENVELOPE=';

/**
 * The debug line is compared as raw bytes: volatile values are masked in the
 * text. An uncaught exception's trace keeps the bridge's own frames; node's
 * internal frames (a run of them is one line) and its version change with the
 * node release, so they are masked.
 */
export function normaliseStderr(stderr: string, problems: string[]): string {
  const lines: string[] = [];
  for (const line of stderr.split('\n')) {
    // `at fn (node:…)`, `at fn [as x] (node:…)`, `at node:…`, `at async node:…`
    const internal = /^\s+at (?:.*\(node:[^)]*\)|(?:async )?node:\S+)$/.test(line);
    if (internal && lines.at(-1) === '    at <node internals>') continue;
    lines.push(internal ? '    at <node internals>' : line.replace(/^Node\.js v\d+\.\d+\.\d+$/, 'Node.js <version>'));
  }
  return lines.map((line) => {
    if (!line.startsWith(DEBUG_PREFIX)) return line;
    let text = line;
    const ts = /"ts":(\d+)(?=[,}])/.exec(text);
    if (ts) text = text.replace(ts[0], '"ts":"<ts>"');
    else problems.push('debug line has no numeric ts');
    const pid = /"agentPid":(\d+),/.exec(text);
    if (process.platform === 'darwin') {
      if (!pid || Number(pid[1]) !== process.pid) problems.push(`debug agentPid ${pid?.[1]} is not the parent ${process.pid}`);
    } else if (text.includes('"agentPid"')) {
      problems.push('debug agentPid sent off macOS');
    }
    if (pid) text = text.replace(pid[0], '');
    return text;
  }).join('\n');
}

function readLines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function readSpool(dir: string, problems: string[]): Record<string, unknown> | undefined {
  if (!existsSync(dir)) return undefined;
  const out: Record<string, unknown> = {};
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) {
      out[name] = 'not-json';
      continue;
    }
    const record = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>;
    if (typeof record.ts !== 'number') problems.push(`spool ts ${String(record.ts)}`);
    record.ts = '<ts>';
    out[name] = record;
  }
  return out;
}

/** Every regular file under `dir`, relative and with `/` separators. Sockets
 *  are left out: Windows has named pipes instead, and the stub that served a
 *  request already shows where it listened. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, rel: string): void => {
    for (const name of readdirSync(at).sort()) {
      const full = path.join(at, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full, `${rel}${name}/`);
      else if (stat.isFile()) out.push(`${rel}${name}`);
    }
  };
  walk(dir, '');
  return out;
}

function holderAt(result: unknown, dotted: string): [Record<string, unknown> | undefined, string] {
  const keys = dotted.split('.');
  const last = keys.pop() as string;
  let parent: unknown = result;
  for (const key of keys) parent = (parent as Record<string, unknown> | undefined)?.[key];
  return [parent as Record<string, unknown> | undefined, last];
}

function applyVariants(result: { steps: unknown[] }, fixture: Fixture, problems: string[]): void {
  const paths = new Set([
    ...Object.keys(fixture.variants ?? {}),
    ...Object.keys(fixture.strictForPort ?? {}),
    ...Object.keys(fixture.portVariants ?? {}),
  ]);
  for (const dotted of paths) {
    const [holder, last] = holderAt(result, dotted);
    const actual = JSON.stringify(holder?.[last]);
    const strict = fixture.strictForPort?.[dotted];
    const forPort = fixture.portVariants?.[dotted];
    const allowed = !IS_REFERENCE && strict !== undefined
      ? [strict]
      : !IS_REFERENCE && forPort !== undefined
        ? forPort
        : [...fixture.variants?.[dotted] ?? [], ...fixture.platformVariants?.[process.platform]?.[dotted] ?? []];
    if (holder && allowed.some((v) => JSON.stringify(v) === actual)) holder[last] = '<variant>';
    else problems.push(`${dotted} = ${actual}, not one of ${JSON.stringify(allowed)}`);
  }
}

/**
 * The child's whole env, built from nothing so no variable of this process
 * leaks in under another case: on Windows env keys are case-insensitive, and
 * a stray `Userprofile` would act as USERPROFILE.
 */
export function childEnv(
  fixture: Pick<Fixture, 'homes' | 'env'>,
  box: Sandbox,
  homeDir: (choice: HomeChoice) => string,
  pipeOverride?: string,
): NodeJS.ProcessEnv {
  const homes = { HOME: 'data', USERPROFILE: 'data', ...fixture.homes };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: homeDir(homes.HOME as HomeChoice),
    WMUX_DATA_SUFFIX: box.suffix,
    ...(process.platform === 'win32'
      ? { SystemRoot: process.env.SystemRoot, TEMP: box.root, TMP: box.root }
      : {}),
    ...(pipeOverride ? { WMUX_PIPE_NAME: pipeOverride } : {}),
  };
  if (homes.USERPROFILE === '') env.USERPROFILE = '';
  else if (homes.USERPROFILE !== 'unset') env.USERPROFILE = homeDir(homes.USERPROFILE as HomeChoice);
  for (const [key, value] of Object.entries(fixture.env ?? {})) env[key] = fill(value, box);
  return env;
}

export interface FixtureRun {
  result: { steps: unknown[] };
  /** Checks the fixed tokens stood for valid values, and timing bounds. */
  problems: string[];
}

export async function runFixture(fixture: Fixture): Promise<FixtureRun> {
  const box = makeSandbox();
  const problems: string[] = [];
  const stubs: Partial<Record<EndpointName, StubDaemon>> = {};
  let parentProfile: { value: string | undefined } | undefined;
  try {
    const tokens = fixture.tokens ?? { daemon: 'daemon-token', main: 'main-token' };
    if (tokens.daemon !== undefined) writeFileSync(path.join(box.wmuxHome, 'daemon-auth-token'), tokens.daemon);
    if (tokens.main !== undefined) writeFileSync(path.join(box.home, `.wmux${box.suffix}-auth-token`), tokens.main);
    for (const [rel, content] of Object.entries(fixture.files ?? {})) {
      const file = path.join(box.home, fill(rel, box));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, fill(content, box));
    }

    // A second home with decoy tokens: an implementation that resolves the
    // wrong variable authenticates with these, or writes its files here.
    const alt = path.join(box.root, 'alt');
    const homes = { HOME: 'data', USERPROFILE: 'data', ...fixture.homes };
    const usesAlt = homes.HOME === 'alt' || homes.USERPROFILE === 'alt' || homes.parentUSERPROFILE === 'alt';
    if (usesAlt) {
      mkdirSync(path.join(alt, `.wmux${box.suffix}`), { recursive: true });
      writeFileSync(path.join(alt, `.wmux${box.suffix}`, 'daemon-auth-token'), 'decoy-daemon-token');
      writeFileSync(path.join(alt, `.wmux${box.suffix}-auth-token`), 'decoy-main-token');
    }
    const homeDir = (choice: HomeChoice): string => (choice === 'alt' ? alt : box.home);
    const posixHome = homeDir(homes.HOME as HomeChoice);

    const paths: Record<EndpointName, string> = {
      daemon: endpointPath('daemon', box, posixHome, fixture.daemonHint),
      main: endpointPath('main', box, posixHome, fixture.daemonHint),
      override: endpointPath('override', box, posixHome, fixture.daemonHint),
    };
    writeHint(path.join(box.wmuxHome, 'daemon-pipe'), paths.daemon, fixture.daemonHint);
    for (const [name, endpoint] of Object.entries(fixture.endpoints ?? {}) as [EndpointName, Endpoint][]) {
      if (endpoint.mode === 'absent') continue;
      if (endpoint.mode === 'refused') await leaveRefusedSocket(paths[name]);
      else stubs[name] = await startStubDaemon(paths[name], endpoint);
    }

    const baseEnv = childEnv(fixture, box, homeDir, fixture.endpoints?.override ? paths.override : undefined);
    if (homes.parentUSERPROFILE) {
      parentProfile = { value: process.env.USERPROFILE };
      process.env.USERPROFILE = homeDir(homes.parentUSERPROFILE);
    }

    const steps: unknown[] = [];
    const seen: Record<string, number> = {};
    let logSeen = 0;
    let altLogSeen = 0;
    for (const [index, step] of fixture.steps.entries()) {
      const env = { ...baseEnv };
      for (const [key, value] of Object.entries(step.env ?? {})) env[key] = fill(value, box);
      ageStamps(step.stampAges, box);
      const run = await runImpl(step, env, box);

      const ids = new Set<string>();
      const requests: Record<string, unknown[]> = {};
      for (const [name, stub] of Object.entries(stubs)) {
        const fresh = stub.connections.slice(seen[name] ?? 0);
        seen[name] = stub.connections.length;
        if (fresh.length > 0) requests[name] = fresh.map((c) => normaliseConnection(c, ids, problems));
      }
      // One id across the whole walk.
      if (ids.size > 1) problems.push(`step ${index}: ${ids.size} request ids`);

      const lines = readLines(path.join(box.wmuxHome, 'bridge.log'));
      const log = lines.slice(logSeen).map((line) => normaliseLog(line, run.pid, problems));
      logSeen = lines.length;

      const stampsDir = path.join(box.wmuxHome, 'activity-stamps');
      // A log written under the other home: the bridge resolved that one.
      const altLogLines = readLines(path.join(alt, `.wmux${box.suffix}`, 'bridge.log')).slice(altLogSeen);
      altLogSeen += altLogLines.length;
      const rest = normaliseDeep({
        log,
        requests,
        spool: readSpool(path.join(box.wmuxHome, 'resume-spool'), problems),
        stamps: existsSync(stampsDir) ? readdirSync(stampsDir).sort() : undefined,
        alt: usesAlt ? listFiles(alt) : undefined,
        altLog: usesAlt && altLogLines.length > 0 ? altLogLines.map((line) => normaliseLog(line, run.pid, problems)) : undefined,
      }, box) as Record<string, unknown>;
      steps.push({
        exitCode: run.exitCode,
        // Raw bytes: masked in place, never parsed.
        stdout: normaliseString(run.stdout, box),
        stderr: normaliseString(normaliseStderr(run.stderr, problems), box),
        ...rest,
      });

      for (const bound of fixture.timing ?? []) {
        if (bound.step !== index) continue;
        if (bound.minMs !== undefined && run.ms < bound.minMs) problems.push(`step ${index} took ${run.ms} ms < ${bound.minMs}`);
        if (bound.maxMs !== undefined && run.ms > bound.maxMs) problems.push(`step ${index} took ${run.ms} ms > ${bound.maxMs}`);
      }
    }
    // Round-trip: absent fields drop out exactly as they do in the stored golden.
    const result = JSON.parse(JSON.stringify({ steps })) as { steps: unknown[] };
    applyVariants(result, fixture, problems);
    return { result, problems };
  } finally {
    if (parentProfile) {
      if (parentProfile.value === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = parentProfile.value;
    }
    for (const stub of Object.values(stubs)) await stub.close();
    rmSync(box.root, { recursive: true, force: true });
  }
}
