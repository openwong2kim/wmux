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

/** Run `binary args…` and compare its trimmed stdout with `line`. Never throws. */
export function runProbe(binary: string, args: readonly string[], line: string, timeoutMs: number): Promise<ProbeVerdict> {
  return new Promise((resolve) => {
    try {
      execFile(binary, [...args], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
        if (error && (error as { killed?: boolean }).killed) return resolve('timeout');
        // A string code is a spawn error (EACCES, EPERM, EBUSY, ENOENT); an
        // exit status is a number.
        if (error && typeof (error as { code?: unknown }).code === 'string') return resolve('unstartable');
        resolve(!error && String(stdout).trim() === line ? 'pass' : 'fail');
      });
    } catch {
      resolve('unstartable');
    }
  });
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

/** Record a verdict; the newest few are kept, and never evicted is `keep`
 *  (the key of the bytes in place). */
export function recordProbe(dir: string, key: string, verdict: 'pass' | 'fail', keep?: string): void {
  const record = readRecord(dir);
  delete record.verdicts[key];
  record.verdicts[key] = verdict;
  const evictable = Object.keys(record.verdicts).filter((k) => k !== keep && k !== key);
  const excess = Object.keys(record.verdicts).length - MAX_RECORDED;
  for (const old of evictable.slice(0, Math.max(0, excess))) delete record.verdicts[old];
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
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
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
  try { held = fs.readFileSync(file, 'utf8'); } catch { return; }
  const [pid, since] = held.split(' ').map(Number);
  if (Number.isInteger(pid) && alive(pid) && Date.now() - since < staleMs) return;
  // Only if it is still the lock just read.
  try { if (fs.readFileSync(file, 'utf8') === held) fs.unlinkSync(file); } catch { /* gone, or held fast */ }
}

// ----- stage, probe, swap --------------------------------------------------------

export interface ProbedNativeOptions {
  /** The binary this build ships, or null when it ships none. */
  sourcePath: string | null;
  destinationPath: string;
  /** Where the verdicts and the lock live. */
  recordDir: string;
  /** The line a passing probe prints: part of every verdict's key. */
  line: string;
  /** Runs the probe on a path; the real one is runProbe. */
  probe: (binary: string) => Promise<ProbeVerdict>;
  /** Any one of them in a destination makes it wmux's to replace. */
  ownershipMarkers: readonly string[];
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
  const lock = await lockDir(opts.recordDir, opts.lock);
  if (!lock) return { binary: null, reason: 'another install holds the lock' };
  try {
    return await prepareOnce(opts, opts.sourcePath);
  } finally {
    lock.release();
  }
}

function reasonOf(verdict: ProbeVerdict, known: 'pass' | 'fail' | undefined): string {
  if (verdict === 'timeout') return 'self-test timed out';
  if (verdict === 'unstartable') return 'self-test could not start';
  return known === 'fail' ? 'recorded as failing' : 'self-test failed';
}

/** Files an interrupted run left: asides and staged copies. Under the lock, so
 *  none is another run's own. */
function sweep(destinationPath: string): void {
  sweepAsides(destinationPath);
  const dir = path.dirname(destinationPath);
  const prefix = `${path.basename(destinationPath)}.staged-`;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name.startsWith(prefix)) try { fs.unlinkSync(path.join(dir, name)); } catch { /* next time */ }
  }
}

async function prepareOnce(opts: ProbedNativeOptions, sourcePath: string): Promise<ProbedNativeResult> {
  const dest = opts.destinationPath;
  sweep(dest);
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
  const known = recordedProbe(opts.recordDir, key);

  if (current?.equals(bytes)) {
    // These bytes are in place already: only their verdict is missing.
    const verdict = known ?? (await opts.probe(dest));
    if (!known && (verdict === 'pass' || verdict === 'fail')) recordProbe(opts.recordDir, key, verdict, key);
    return verdict === 'pass' ? { binary: dest } : { binary: null, reason: reasonOf(verdict, known) };
  }
  if (current && !opts.ownershipMarkers.some((marker) => current.toString('utf8').includes(marker))) {
    return { binary: null, reason: 'copy is foreign' };
  }
  const currentKey = current ? probeKey(sha256Of(current), opts.line) : undefined;
  // What a refresh that does not happen still offers: the copy in place.
  const keep = (reason: string): ProbedNativeResult =>
    currentKey && recordedProbe(opts.recordDir, currentKey) === 'pass'
      ? { binary: dest, reason: `${reason}; the installed copy stays` }
      : { binary: null, reason };
  if (known === 'fail') return keep(reasonOf('fail', known));

  const staged = `${dest}.staged-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeSynced(staged, bytes, opts.mode ?? 0o700);
  } catch (error) {
    try { fs.unlinkSync(staged); } catch { /* never written */ }
    return keep(`could not stage the copy: ${String(error)}`);
  }
  const verdict = known ?? (await opts.probe(staged));
  if (!known && (verdict === 'pass' || verdict === 'fail')) recordProbe(opts.recordDir, key, verdict, currentKey);
  if (verdict !== 'pass') {
    try { fs.unlinkSync(staged); } catch { /* swept next time */ }
    return keep(reasonOf(verdict, known));
  }
  try {
    swapIn(staged, dest, current !== null, opts.platform ?? process.platform);
  } catch (error) {
    try { fs.unlinkSync(staged); } catch { /* swept next time */ }
    return keep(`could not replace the copy: ${String(error)}`);
  }
  return { binary: dest };
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
 *   unix: the copy in place is linked aside first, so its name never goes
 *         missing; the rename is atomic and a running copy keeps its inode;
 *         the aside is then dropped.
 *   Windows: a running exe cannot be replaced, only renamed: it goes aside,
 *         the staged copy takes its name, and only if that second rename
 *         fails is the aside renamed back (a filesystem undo; nothing failed
 *         a probe). An aside still running is swept on a later run.
 */
function swapIn(staged: string, dest: string, hasCurrent: boolean, platform: NodeJS.Platform): void {
  const aside = `${dest}.previous-${process.pid}-${randomBytes(4).toString('hex')}`;
  if (platform !== 'win32') {
    let linked = false;
    if (hasCurrent) {
      try { fs.linkSync(dest, aside); linked = true; } catch { /* no hard links here: the rename alone is still atomic */ }
    }
    fs.renameSync(staged, dest);
    if (linked) try { fs.unlinkSync(aside); } catch { /* swept next time */ }
    return;
  }
  if (!hasCurrent) {
    fs.renameSync(staged, dest);
    return;
  }
  fs.renameSync(dest, aside);
  try {
    fs.renameSync(staged, dest);
  } catch (error) {
    fs.renameSync(aside, dest);
    throw error;
  }
  try { fs.unlinkSync(aside); } catch { /* still running: swept next time */ }
}
