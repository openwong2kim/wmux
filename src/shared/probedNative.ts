// A wmux-native copy installed beside what it serves (the MCP launcher in
// ~/.wmux/mcp, the hook bridge in ~/.wmux/hooks), offered only once a probe
// has proved these exact bytes answer what this build expects.
//
// Stage, probe, then swap: the new bytes are written to a sibling file and
// fsynced, that file is probed where it will run (a noexec mount fails here,
// not later), and only a pass moves it into place. The destination therefore
// only ever holds bytes that passed, or what it held before: there is no
// restore and no delete path. A failing refresh leaves the working copy in
// place, and it is still offered when its own bytes have a recorded pass.
//
// The verdict of each probe is recorded by sha256 and the line the probe
// expects, so a boot runs the probe only for bytes (or a protocol) it has not
// judged yet. A timeout or a copy that could not be started proves nothing
// and is never recorded.
//
// Serialized twice: in this process by a queue, and across processes (the app
// and the CLI) by an O_EXCL lock file in the record directory.

import { execFile } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sweepAsides } from './lifecycleIntegrations';

/** What a probe proved: it runs, it does not, or nothing. Nothing is proved
 *  when it timed out (an antivirus scan, load) or could not be started at all
 *  (access denied, the file held or gone): neither says anything about the
 *  bytes, so neither is recorded. */
export type ProbeVerdict = 'pass' | 'fail' | 'timeout' | 'unstartable';

/** What a passing probe prints: exactly one line, or output containing a
 *  text (a `--version` that every build answers carries a marker line). */
export type ProbeExpectation = { line: string } | { contains: string };

/** An expectation as part of a verdict's key: a line is itself, so the keys
 *  recorded before `contains` existed stay valid; a contained text is tagged. */
export function expectationKey(expect: ProbeExpectation): string {
  return 'line' in expect ? expect.line : `contains:${expect.contains}`;
}

/** A probe's verdict with what the binary printed (trimmed) and, unless it
 *  exited 0, why not: the spawn error, its exit status or the signal. */
export interface ProbeRun {
  verdict: ProbeVerdict;
  printed: string;
  failure: string | null;
}

/** Run `binary args…` and hold its stdout to `expect`. Never throws. */
export function runProbeDetailed(binary: string, args: readonly string[], expect: ProbeExpectation, timeoutMs: number): Promise<ProbeRun> {
  return new Promise((resolve) => {
    try {
      execFile(binary, [...args], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        const out = String(stdout ?? '');
        const printed = out.trim();
        const failed = error as { killed?: boolean; code?: unknown; signal?: unknown } | null;
        if (failed?.killed) return resolve({ verdict: 'timeout', printed, failure: `no answer in ${timeoutMs} ms` });
        // A string code is a spawn error (EACCES, EPERM, EBUSY, ENOENT); an
        // exit status is a number, and a signal leaves it null.
        if (typeof failed?.code === 'string') return resolve({ verdict: 'unstartable', printed, failure: `${failed.code}: ${(error as Error).message}` });
        const met = 'line' in expect ? printed === expect.line : out.includes(expect.contains);
        const failure = !failed ? null : typeof failed.signal === 'string' ? `killed by ${failed.signal}` : `exit ${String(failed.code)}`;
        resolve({ verdict: !failed && met ? 'pass' : 'fail', printed, failure });
      });
    } catch (error) {
      resolve({ verdict: 'unstartable', printed: '', failure: String(error) });
    }
  });
}

/** runProbeDetailed's verdict alone. */
export async function runProbe(binary: string, args: readonly string[], expect: ProbeExpectation, timeoutMs: number): Promise<ProbeVerdict> {
  return (await runProbeDetailed(binary, args, expect, timeoutMs)).verdict;
}

// ----- the record ----------------------------------------------------------------

/** The verdicts recorded in a directory. Version 2 keys them by sha256 and the
 *  expected line; a version 1 file reads as empty, so each copy is probed once
 *  more. */
export const PROBE_RECORD = '.wmux-native-health.json';
const MAX_RECORDED = 8;

type ProbeRecord = { version: 2; verdicts: Record<string, 'pass' | 'fail'> };

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function fileSha256(file: string): string | null {
  try {
    return sha256Of(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/** One verdict's key: these bytes, asked this question. */
export function probeKey(sha256: string, line: string): string {
  return `${sha256} ${line}`;
}

function readRecord(dir: string): ProbeRecord {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, PROBE_RECORD), 'utf8')) as Partial<ProbeRecord>;
    if (parsed && parsed.version === 2 && parsed.verdicts && typeof parsed.verdicts === 'object') return parsed as ProbeRecord;
  } catch { /* missing or unreadable: nothing recorded */ }
  return { version: 2, verdicts: {} };
}

export function recordedProbe(dir: string, key: string): 'pass' | 'fail' | undefined {
  const verdict = readRecord(dir).verdicts[key];
  return verdict === 'pass' || verdict === 'fail' ? verdict : undefined;
}

/** The verdict recorded on the bytes now at `file`, asked `line`; undefined
 *  when nothing is recorded or the file cannot be read. Runs nothing. */
export function recordedVerdictOf(file: string, recordDir: string, line: string): 'pass' | 'fail' | undefined {
  const hash = fileSha256(file);
  return hash ? recordedProbe(recordDir, probeKey(hash, line)) : undefined;
}

/** Every verdict recorded on the bytes now at `file`, by expectation key;
 *  empty when the file cannot be read. Runs nothing. */
export function recordedVerdictsOf(file: string, recordDir: string): Map<string, 'pass' | 'fail'> {
  const out = new Map<string, 'pass' | 'fail'>();
  const hash = fileSha256(file);
  if (!hash) return out;
  for (const [key, verdict] of Object.entries(readRecord(recordDir).verdicts)) {
    if (key.startsWith(`${hash} `) && (verdict === 'pass' || verdict === 'fail')) out.set(key.slice(hash.length + 1), verdict);
  }
  return out;
}

/** The sha256 of every file in `dir` (each copy in place, the record's
 *  neighbours). Best effort: an unreadable file is left out. */
function hashesInPlace(dir: string): Set<string> {
  const hashes = new Set<string>();
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return hashes; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).isFile()) hashes.add(sha256Of(fs.readFileSync(file)));
    } catch { /* gone, or unreadable */ }
  }
  return hashes;
}

/** Record a verdict; the newest few are kept, and never evicted are `keep`
 *  (the key of the bytes in place) and the verdicts of any file still in
 *  `dir`: one record serves every copy installed there. */
export function recordProbe(dir: string, key: string, verdict: 'pass' | 'fail', keep?: string): void {
  const record = readRecord(dir);
  delete record.verdicts[key];
  record.verdicts[key] = verdict;
  let evictable = Object.keys(record.verdicts).filter((k) => k !== keep && k !== key);
  const excess = Object.keys(record.verdicts).length - MAX_RECORDED;
  if (excess > 0) {
    const inPlace = hashesInPlace(dir);
    evictable = evictable.filter((k) => !inPlace.has(k.split(' ')[0]));
  }
  for (const old of evictable.slice(0, Math.max(0, excess))) delete record.verdicts[old];
  writeRecord(dir, record);
}

/** Drop a recorded verdict, so the next run probes those bytes again. */
export function forgetProbe(dir: string, key: string): void {
  const record = readRecord(dir);
  if (!(key in record.verdicts)) return;
  delete record.verdicts[key];
  writeRecord(dir, record);
}

function writeRecord(dir: string, record: ProbeRecord): void {
  const file = path.join(dir, PROBE_RECORD);
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    try { fs.unlinkSync(temp); } catch { /* never written */ }
  }
}

// ----- the cross-process lock ----------------------------------------------------

export const PROBE_LOCK = '.wmux-native.lock';

export interface LockOptions {
  /** How long to wait for another holder. */
  waitMs?: number;
  /** A lock older than this is taken over even when its pid still lives. */
  staleMs?: number;
  pollMs?: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, as another user's process.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take `<dir>/.wmux-native.lock` with O_EXCL, or null when another holder
 * keeps it past `waitMs`. A lock whose pid is gone, or older than `staleMs`,
 * is taken over. The release removes only a lock still carrying this owner.
 * Any error other than an existing lock (a missing or read-only directory,
 * access denied) is thrown.
 */
export async function lockDir(dir: string, opts: LockOptions = {}): Promise<{ release(): void } | null> {
  const { waitMs = 10_000, staleMs = 30_000, pollMs = 100 } = opts;
  const file = path.join(dir, PROBE_LOCK);
  const owner = `${process.pid} ${Date.now()} ${randomBytes(4).toString('hex')}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeSync(fd, owner); } finally { fs.closeSync(fd); }
      return {
        release: () => {
          try {
            if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file);
          } catch { /* already gone */ }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    takeOverIfStale(file, staleMs);
    // Every way round waits and keeps the deadline: a lock that cannot be
    // read or removed must not spin the main process.
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Remove a held lock whose pid is gone or that is older than `staleMs`; the
 *  next attempt then creates its own. Best effort: any failure leaves it. */
function takeOverIfStale(file: string, staleMs: number): void {
  let held = '';
  let mtime = 0;
  try {
    held = fs.readFileSync(file, 'utf8');
    mtime = fs.statSync(file).mtimeMs;
  } catch { return; }
  const [pid, since] = held.split(' ').map(Number);
  if (!(Number.isInteger(pid) && pid > 0 && Number.isFinite(since))) {
    // Empty or unreadable: a holder between its open and its write. Held
    // until the file itself is stale.
    if (Date.now() - mtime < staleMs) return;
  } else if (alive(pid) && Date.now() - since < staleMs) {
    return;
  }
  // Atomic: move it to a name of our own, then check it is the lock judged.
  // Another waiter may have taken the dead lock over first; then this is that
  // waiter's fresh lock, and it goes back under its name with link(), which
  // never replaces a newer lock there.
  const grabbed = `${file}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try { fs.renameSync(file, grabbed); } catch { return; /* gone, or held fast */ }
  let moved: string | null = null;
  try { moved = fs.readFileSync(grabbed, 'utf8'); } catch { /* unreadable: put back */ }
  if (moved !== held) {
    try { fs.linkSync(grabbed, file); } catch { /* a newer lock has the name */ }
  }
  try { fs.unlinkSync(grabbed); } catch { /* left behind: a stray file, never read as the lock */ }
}

// ----- stage, probe, swap --------------------------------------------------------

export interface ProbedNativeOptions {
  /** The binary this build ships, or null when it ships none. */
  sourcePath: string | null;
  destinationPath: string;
  /** Where the verdicts and the lock live. */
  recordDir: string;
  /** What the probe expects, as expectationKey gives it: part of every
   *  verdict's key. */
  line: string;
  /** Runs the probe on a path; the real one is runProbe. */
  probe: (binary: string) => Promise<ProbeVerdict>;
  /** Any one of them in a destination makes it wmux's to replace. */
  ownershipMarkers: readonly string[];
  /** Probe again even bytes with a recorded verdict, and record the new one
   *  (`wmux setup-hooks --reprobe`, after the cause of a recorded failure is
   *  gone). Never set at boot. */
  reprobe?: boolean;
  /** The staged copy's mode. Default 0o700. */
  mode?: number;
  lock?: LockOptions;
  platform?: NodeJS.Platform;
}

export interface ProbedNativeResult {
  /** The copy to offer, or null. */
  binary: string | null;
  /** Why nothing new is offered; for the log. */
  reason?: string;
}

let queue: Promise<unknown> = Promise.resolve();

export function prepareProbedNative(opts: ProbedNativeOptions): Promise<ProbedNativeResult> {
  const run = queue.then(() => prepareLocked(opts));
  queue = run.catch(() => undefined);
  return run;
}

async function prepareLocked(opts: ProbedNativeOptions): Promise<ProbedNativeResult> {
  if (!opts.sourcePath || !fs.existsSync(opts.sourcePath)) return { binary: null, reason: 'not shipped with this build' };
  let lock: { release(): void } | null;
  try {
    // A first install creates the directories, private to the user.
    for (const dir of [path.dirname(opts.destinationPath), opts.recordDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    lock = await lockDir(opts.recordDir, opts.lock);
  } catch (error) {
    return keepInPlace(opts, `could not take the install lock: ${String(error)}`);
  }
  if (!lock) return keepInPlace(opts, 'another install holds the lock');
  try {
    return await prepareOnce(opts, opts.sourcePath);
  } finally {
    lock.release();
  }
}

/**
 * Without the lock nothing may be written, but the copy in place is still
 * offered when its bytes have a recorded pass: otherwise every agent config
 * would move to node for this start.
 */
function keepInPlace(opts: ProbedNativeOptions, reason: string): ProbedNativeResult {
  return recordedVerdictOf(opts.destinationPath, opts.recordDir, opts.line) === 'pass'
    ? { binary: opts.destinationPath, reason: `${reason}; the installed copy stays` }
    : { binary: null, reason };
}

function reasonOf(verdict: ProbeVerdict, known: 'pass' | 'fail' | undefined): string {
  if (verdict === 'timeout') return 'self-test timed out';
  if (verdict === 'unstartable') return 'self-test could not start';
  return known === 'fail' ? 'recorded as failing' : 'self-test failed';
}

/** Files an interrupted run left: asides and staged copies. Under the lock, so
 *  none is another run's own. While the copy's name is empty (a Windows swap
 *  whose undo failed), an aside is the only good copy: it is left alone. */
function sweep(destinationPath: string, platform: NodeJS.Platform): void {
  if (fs.existsSync(destinationPath)) sweepAsides(destinationPath);
  sweepAsides(destinationPath, stagedName(destinationPath, platform).prefix);
}

/** The staged copy's name: `<base>.staged-<id>`, and on Windows the real
 *  extension last (`wmux-native.staged-<id>.exe`), so application control and
 *  antivirus treat it as they treat the copy it becomes. */
function stagedName(dest: string, platform: NodeJS.Platform): { prefix: string; path: string } {
  const ext = platform === 'win32' ? path.extname(dest) : '';
  const prefix = `${path.basename(dest, ext)}.staged-`;
  const id = `${process.pid}-${randomBytes(4).toString('hex')}`;
  return { prefix, path: path.join(path.dirname(dest), `${prefix}${id}${ext}`) };
}

async function prepareOnce(opts: ProbedNativeOptions, sourcePath: string): Promise<ProbedNativeResult> {
  const dest = opts.destinationPath;
  const platform = opts.platform ?? process.platform;
  sweep(dest, platform);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(sourcePath);
  } catch (error) {
    return { binary: null, reason: `source unreadable: ${String(error)}` };
  }
  let current: Buffer | null = null;
  try {
    current = fs.readFileSync(dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { binary: null, reason: `copy unreadable: ${String(error)}` };
  }
  const key = probeKey(sha256Of(bytes), opts.line);
  const recorded = recordedProbe(opts.recordDir, key);
  const known = opts.reprobe ? undefined : recorded;
  // What a reprobe settles, when these bytes had a verdict: a timeout proves
  // nothing (a slow antivirus scan), so the recorded verdict stands, as if it
  // had not run. A copy that could not be started (a home turned noexec) is
  // not offered, and the recorded verdict is forgotten, so the next run
  // probes again rather than trusting it; nothing new is recorded.
  const settle = (probed: ProbeVerdict): { verdict: ProbeVerdict; known: 'pass' | 'fail' | undefined } => {
    if (probed === 'timeout' && recorded) return { verdict: recorded, known: recorded };
    if (probed === 'unstartable' && recorded) forgetProbe(opts.recordDir, key);
    return { verdict: probed, known };
  };

  if (current?.equals(bytes)) {
    // These bytes are in place already: only their verdict is missing.
    const probed = known ?? (await opts.probe(dest));
    if (!known && (probed === 'pass' || probed === 'fail')) recordProbe(opts.recordDir, key, probed, key);
    const { verdict, known: decided } = settle(probed);
    return verdict === 'pass' ? { binary: dest } : { binary: null, reason: reasonOf(verdict, decided) };
  }
  if (current && !opts.ownershipMarkers.some((marker) => current.includes(Buffer.from(marker)))) {
    return { binary: null, reason: 'copy is foreign' };
  }
  const currentKey = current ? probeKey(sha256Of(current), opts.line) : undefined;
  // What a refresh that does not happen still offers: the copy in place.
  const keep = (reason: string): ProbedNativeResult => keepInPlace(opts, reason);
  if (known === 'fail') return keep(reasonOf('fail', known));

  const staged = stagedName(dest, platform).path;
  try {
    writeSynced(staged, bytes, opts.mode ?? 0o700);
  } catch (error) {
    try { fs.unlinkSync(staged); } catch { /* never written */ }
    return keep(`could not stage the copy: ${String(error)}`);
  }
  const probed = known ?? (await opts.probe(staged));
  if (!known && (probed === 'pass' || probed === 'fail')) recordProbe(opts.recordDir, key, probed, currentKey);
  const { verdict, known: decided } = settle(probed);
  if (verdict !== 'pass') {
    try { fs.unlinkSync(staged); } catch { /* swept next time */ }
    return keep(reasonOf(verdict, decided));
  }
  // The probe took time: what is at the name now must still be what was
  // judged wmux's own (or still nothing), or it is not replaced.
  if (!sameAsBefore(dest, current)) {
    try { fs.unlinkSync(staged); } catch { /* swept next time */ }
    return { binary: null, reason: 'copy is foreign' };
  }
  try {
    swapIn(staged, dest, current !== null, platform);
  } catch (error) {
    try { fs.unlinkSync(staged); } catch { /* swept next time */ }
    return keep(`could not replace the copy: ${String(error)}`);
  }
  return { binary: dest };
}

/** True when `file` still holds `before`'s bytes, or is still missing. */
function sameAsBefore(file: string, before: Buffer | null): boolean {
  try {
    const now = fs.readFileSync(file);
    return before !== null && now.equals(before);
  } catch (error) {
    return before === null && (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function writeSynced(file: string, bytes: Buffer, mode: number): void {
  const fd = fs.openSync(file, 'wx', mode);
  try {
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // The mode above went through the umask.
  fs.chmodSync(file, mode);
}

/**
 * Move a staged copy that passed into place.
 *   unix: one rename, which replaces atomically; a running copy keeps its
 *         inode.
 *   Windows: a running exe cannot be replaced, only renamed: it goes aside,
 *         the staged copy takes its name, and only if that second rename
 *         fails is the aside renamed back (a filesystem undo; nothing failed
 *         a probe). An aside still running is swept on a later run.
 */
function swapIn(staged: string, dest: string, hasCurrent: boolean, platform: NodeJS.Platform): void {
  if (platform !== 'win32' || !hasCurrent) {
    fs.renameSync(staged, dest);
    return;
  }
  const aside = `${dest}.previous-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.renameSync(dest, aside);
  try {
    fs.renameSync(staged, dest);
  } catch (error) {
    // Undo; if that fails too the name stays empty and the aside is kept
    // (see sweep). Either way the first failure is the one reported.
    try { fs.renameSync(aside, dest); } catch { /* the aside is kept */ }
    throw error;
  }
  try { fs.unlinkSync(aside); } catch { /* still running: swept next time */ }
}
