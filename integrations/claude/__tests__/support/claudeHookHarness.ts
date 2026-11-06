/**
 * Runs one characterisation fixture against wmux-bridge.mjs: a fresh sandbox
 * HOME, a random WMUX_DATA_SUFFIX (so even a derived pipe name is unique), stub
 * endpoints, a scrubbed env, then every step as a real `node wmux-bridge.mjs`
 * process. The result is normalised so it holds on every OS and every run:
 * sandbox paths, the suffix, request ids, timestamps and pids become fixed
 * tokens after they have been checked.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { startStubDaemon, type StubBehaviour, type StubConnection, type StubDaemon } from './stubDaemon';

export const BRIDGE_PATH = path.resolve(process.cwd(), 'integrations/claude/bin/wmux-bridge.mjs');

type StdinPart = string | { repeat: string; count: number } | { base64: string };
type Endpoint = StubBehaviour | { mode: 'absent' } | { mode: 'refused' };
type EndpointName = 'daemon' | 'main' | 'override';

export interface Step {
  argv: string[];
  env?: Record<string, string>;
  /** Text, parts joined as bytes, or `hold` (stdin left open: proves it is never read). */
  stdin?: string | { parts: StdinPart[] } | { hold: true };
}

export interface Fixture {
  description: string;
  /** Node behaviour the native port documents as different instead of copying. */
  divergence?: string;
  platforms?: NodeJS.Platform[];
  skipReason?: string;
  /** Token files; defaults to both. `{}` writes none. */
  tokens?: { daemon?: string; main?: string };
  /** Extra files, relative to the sandbox home. */
  files?: Record<string, string>;
  endpoints?: Partial<Record<EndpointName, Endpoint>>;
  env?: Record<string, string>;
  steps: Step[];
  timing?: { step: number; minMs?: number; maxMs?: number }[];
  /** Dotted path in the result → the values it may take (a race the bridge does not settle). */
  variants?: Record<string, unknown[]>;
  expect?: { steps: unknown[] };
}

interface Sandbox {
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

function endpointPath(name: EndpointName, box: Sandbox): string {
  if (process.platform === 'win32') {
    // The main pipe name is derived, not configurable: this is the name the
    // bridge computes, unique only through the random suffix.
    if (name === 'main') return `\\\\.\\pipe\\wmux${box.suffix}-${userInfo().username || 'default'}`;
    return `\\\\.\\pipe\\wch-${name}-${randomBytes(4).toString('hex')}`;
  }
  if (name === 'main') return path.join(box.home, `.wmux${box.suffix}.sock`);
  return path.join(box.root, `${name}.sock`);
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

interface RawRun { exitCode: number | null; stdout: string; stderr: string; ms: number; pid: number }

function runBridge(step: Step, env: NodeJS.ProcessEnv, box: Sandbox): Promise<RawRun> {
  const started = Date.now();
  const child = spawn(process.execPath, [BRIDGE_PATH, ...step.argv], { cwd: box.cwd, env, stdio: 'pipe' });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => out.push(c));
  child.stderr.on('data', (c: Buffer) => err.push(c));
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

function normaliseString(value: string, box: Sandbox): string {
  let text = value;
  for (const form of [box.root, box.root.replaceAll('\\', '/')]) {
    if (text.includes(form)) text = text.replaceAll(form, '<sandbox>');
  }
  if (text.includes('<sandbox>')) text = text.replaceAll('\\', '/');
  return text
    .replaceAll(box.suffix, '<sfx>')
    .replaceAll(process.execPath, '<node>')
    .replaceAll(BRIDGE_PATH, '<bridge>');
}

// Goldens stay readable: a long string or a deep subtree is stored as its size
// and hash, which still pins every unit of it.
const LONG_STRING = 512;
const DEEP_LEVEL = 16;

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function normaliseDeep(value: unknown, box: Sandbox, depth = 0): unknown {
  if (typeof value === 'string') {
    const text = normaliseString(value, box);
    return text.length > LONG_STRING ? `<string length=${text.length} sha256=${digest(text)}>` : text;
  }
  if (value && typeof value === 'object' && depth >= DEEP_LEVEL) {
    const text = JSON.stringify(value);
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
  // The hook's parent is sent on macOS only; here the parent is this process.
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
  // The message is V8's and changes between node releases; the class is the contract.
  if (entry.outcome === 'malformed-stdin' && typeof entry.error === 'string') {
    entry.error = entry.error.split(':')[0];
  }
  return entry;
}

const DEBUG_PREFIX = 'WMUX_BRIDGE_DEBUG_ENVELOPE=';

function normaliseStderr(stderr: string, problems: string[]): string {
  return stderr.split('\n').map((line) => {
    if (!line.startsWith(DEBUG_PREFIX)) return line;
    const meta = JSON.parse(line.slice(DEBUG_PREFIX.length)) as Record<string, unknown>;
    normaliseEnvelope(meta, problems);
    return DEBUG_PREFIX + JSON.stringify(meta);
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

function applyVariants(result: { steps: unknown[] }, variants: Fixture['variants'], problems: string[]): void {
  for (const [dotted, allowed] of Object.entries(variants ?? {})) {
    const keys = dotted.split('.');
    const last = keys.pop() as string;
    let parent: unknown = result;
    for (const key of keys) parent = (parent as Record<string, unknown> | undefined)?.[key];
    const holder = parent as Record<string, unknown> | undefined;
    const actual = JSON.stringify(holder?.[last]);
    if (holder && allowed.some((v) => JSON.stringify(v) === actual)) holder[last] = '<variant>';
    else problems.push(`${dotted} = ${actual}, not one of the variants`);
  }
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
  try {
    const tokens = fixture.tokens ?? { daemon: 'daemon-token', main: 'main-token' };
    if (tokens.daemon !== undefined) writeFileSync(path.join(box.wmuxHome, 'daemon-auth-token'), tokens.daemon);
    if (tokens.main !== undefined) writeFileSync(path.join(box.home, `.wmux${box.suffix}-auth-token`), tokens.main);
    for (const [rel, content] of Object.entries(fixture.files ?? {})) {
      const file = path.join(box.home, fill(rel, box));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, fill(content, box));
    }

    const paths: Record<EndpointName, string> = {
      daemon: endpointPath('daemon', box),
      main: endpointPath('main', box),
      override: endpointPath('override', box),
    };
    // The daemon is always found through its hint file, so no derived name is used.
    writeFileSync(path.join(box.wmuxHome, 'daemon-pipe'), `${paths.daemon}\n`);
    for (const [name, endpoint] of Object.entries(fixture.endpoints ?? {}) as [EndpointName, Endpoint][]) {
      if (endpoint.mode === 'absent') continue;
      if (endpoint.mode === 'refused') await leaveRefusedSocket(paths[name]);
      else stubs[name] = await startStubDaemon(paths[name], endpoint);
    }

    const baseEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: box.home,
      USERPROFILE: box.home,
      WMUX_DATA_SUFFIX: box.suffix,
      ...(process.platform === 'win32'
        ? { SystemRoot: process.env.SystemRoot, TEMP: box.root, TMP: box.root }
        : {}),
      ...(fixture.endpoints?.override ? { WMUX_PIPE_NAME: paths.override } : {}),
    };
    for (const [key, value] of Object.entries(fixture.env ?? {})) baseEnv[key] = fill(value, box);

    const steps: unknown[] = [];
    const seen: Record<string, number> = {};
    let logSeen = 0;
    for (const [index, step] of fixture.steps.entries()) {
      const env = { ...baseEnv };
      for (const [key, value] of Object.entries(step.env ?? {})) env[key] = fill(value, box);
      const run = await runBridge(step, env, box);

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
      steps.push(normaliseDeep({
        exitCode: run.exitCode,
        stdout: run.stdout,
        stderr: normaliseStderr(run.stderr, problems),
        log,
        requests,
        spool: readSpool(path.join(box.wmuxHome, 'resume-spool'), problems),
        stamps: existsSync(stampsDir) ? readdirSync(stampsDir).sort() : undefined,
      }, box));

      for (const bound of fixture.timing ?? []) {
        if (bound.step !== index) continue;
        if (bound.minMs !== undefined && run.ms < bound.minMs) problems.push(`step ${index} took ${run.ms} ms < ${bound.minMs}`);
        if (bound.maxMs !== undefined && run.ms > bound.maxMs) problems.push(`step ${index} took ${run.ms} ms > ${bound.maxMs}`);
      }
    }
    // Round-trip: absent fields drop out exactly as they do in the stored golden.
    const result = JSON.parse(JSON.stringify({ steps })) as { steps: unknown[] };
    applyVariants(result, fixture.variants, problems);
    return { result, problems };
  } finally {
    for (const stub of Object.values(stubs)) await stub.close();
    rmSync(box.root, { recursive: true, force: true });
  }
}
