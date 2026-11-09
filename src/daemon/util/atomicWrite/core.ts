/**
 * Atomic JSON read/write primitives.
 *
 * Extracted from the duplicate logic in `StateWriter.ts` and
 * `SessionManager.ts`. This is the T1a scaffold — the interface is
 * frozen here so later phases can layer extra behaviour without
 * changing call sites:
 *
 *   - T1b: StateWriter / SessionManager migrate to these helpers.
 *   - T5:  rotation (tmp → primary → .bak → .bak.1 chain). The
 *          `rotationEnabled` flag is wired in already; it is a
 *          no-op for now.
 *   - T6:  corrupt-file quarantine. The `validate` hook exists and
 *          read-time failures fall back to returning `null`; the
 *          quarantine path will replace the warn-and-continue
 *          behaviour.
 *   - T7:  lazy migrations. The `migrator` hook exists and is
 *          accepted but unused today.
 *
 * Scope guard: this module must not depend on Electron or on any
 * module that reaches into daemon-specific state. It only uses
 * `node:fs`, `node:path`, and `node:process` so both the daemon
 * and the main process can consume it once the migration lands in
 * T1b.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  BACKUP_SUFFIXES,
  isManagedBackup,
  rotateBackups,
  rotateBackupsSync,
} from './rotation';
import { quarantineFile, quarantineFileSync } from './quarantine';

// ── Public types ─────────────────────────────────────────────────────

export interface AtomicWriteOptions {
  /**
   * When true, T5's rotation chain takes over (primary → .bak →
   * .bak.1 …). **No-op in T1a.**
   */
  rotationEnabled?: boolean;

  /**
   * Optional pre-write validator. Called with the data the caller
   * supplied _before_ serialization. Throwing or returning `false`
   * causes the write to abort with an error — the on-disk file is
   * left untouched.
   */
  validate?: (data: unknown) => boolean;

  /**
   * Injectable clock for tests. Defaults to `Date.now`.
   * T6 uses this for quarantine timestamps.
   */
  clock?: () => number;

  /**
   * durable 쓰기 (envelope-design §2.3 D13). true면 crash-safe 시퀀스를 강제한다:
   *   tmp write → tmp fd fsync → rename → 부모 디렉토리 fsync.
   * 기본 경로(false/미지정)는 fsync 없는 write+rename로 **1비트도 불변**이다 —
   * 스냅샷엔 충분하지만 정본(manifest 등)엔 전원손실 내구를 위해 durable이 필요하다.
   * win32는 디렉토리 fsync 미지원이라 4단계를 스킵한다(§2.3 win32 잔여, 파일 자체
   * FlushFileBuffers까지만 보장).
   */
  durable?: boolean;

  /**
   * Test seam for the win32 commit-rename retry (see
   * `RENAME_RETRY_DELAYS_MS`). Production code never passes this;
   * tests use it to drive the retry loop without sleeping for real.
   */
  renameRetry?: RenameRetryPolicy;
}

export interface AtomicReadOptions<T> {
  /**
   * Post-parse validator/type guard. When it returns false we
   * discard the parsed value and try the `.bak` fallback; if that
   * also fails we return `null`. T6 will replace this warn-and-null
   * path with isolation-to-quarantine.
   */
  validate?: (data: unknown) => data is T;

  /**
   * T7 lazy-migration hook. Receives the parsed (and prototype-
   * sanitised) value plus the detected schema version, and must
   * return the migrated payload with a new version. **No-op in
   * T1a** — current behaviour is as if the hook was not supplied.
   */
  migrator?: (
    data: unknown,
    fromVersion: number,
  ) => { data: T; version: number };

  /** Injectable clock for tests. Defaults to `Date.now`. */
  clock?: () => number;

  /**
   * This read does not feed a later write of the file (a targeted read of one
   * field, a check). It still throws `CouldNotReadError`, but neither holds
   * writes back nor releases a hold, so one blip here cannot stop a store whose
   * state in memory is good from saving.
   */
  readOnly?: boolean;

  /** Test seam for the win32 read retry. Mirrors `AtomicWriteOptions.renameRetry`. */
  readRetry?: RenameRetryPolicy;

  /**
   * validate 거부 시 격리(quarantine) 이동 여부(기본 true — 기존 동작 불변).
   * false면 손상 파일을 **절대 이동·수정하지 않고** null만 반환한다 — genesis·reseed처럼
   * "어떤 경로도 수정·삭제하지 않는다"(envelope-design §6.2 불변 계약) 아티팩트의
   * read 경로용. `.bak` 폴백 체인은 동일하게 동작한다.
   */
  quarantineOnCorruption?: boolean;
}

/**
 * Retry policy for the final tmp → target rename. `delaysMs.length`
 * is the number of retries after the first attempt, so total attempts
 * are `delaysMs.length + 1`.
 */
export interface RenameRetryPolicy {
  delaysMs?: readonly number[];
  /** Sync sleep used by `atomicWriteJSONSync`. */
  sleepSync?: (ms: number) => void;
  /** Async sleep used by `atomicWriteJSON`. */
  sleep?: (ms: number) => Promise<void>;
}

// ── Internal helpers ─────────────────────────────────────────────────

const JSON_INDENT = 2;

/**
 * Recursively strip prototype-pollution keys from a parsed JSON
 * payload. Matches the reviver used by the original StateWriter /
 * SessionManager implementations. We apply this as a reviver so the
 * keys are dropped _during_ parsing and never attached to any
 * object.
 */
function jsonReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    return undefined;
  }
  return value;
}

/**
 * Unique-ish tmp path. Using PID (plus a monotonic counter) keeps
 * concurrent writers in different processes from clobbering each
 * other's in-flight tmp file. Within a single process the counter
 * avoids collisions when two writes interleave.
 */
let tmpCounter = 0;
function makeTmpPath(targetPath: string): string {
  tmpCounter = (tmpCounter + 1) >>> 0;
  return `${targetPath}.tmp.${process.pid}.${tmpCounter}`;
}

function bakPathFor(targetPath: string): string {
  return `${targetPath}.bak`;
}

/**
 * Windows real-time antivirus scanners briefly open a handle on a
 * file right after it is written, and a rename whose destination is
 * held that way fails with EPERM/EACCES/EBUSY. The window is short
 * (tens of ms), so a bounded backoff turns an intermittent hard
 * failure into a slightly slower success.
 *
 * This matters more than a normal transient because of the ordering:
 * by the time we rename tmp → target, the previous primary has
 * ALREADY been moved to `.bak`. A failure here therefore leaves the
 * caller with no primary file at all, which is how a half-written
 * pairing survives a restart (#658).
 *
 * The commit rename and the primary → `.bak` rotation before it are
 * retried, and only on win32 — POSIX rename does not fail this way, so
 * behaviour off Windows is byte-identical to before. Each rename can add
 * up to 310ms, so one sync write can block its thread for up to ~620ms.
 * The sync callers are the daemon's JSON stores and, through `text.ts`,
 * Electron main (scrollback save, bot room log, handoff queue); the
 * per-process budget below caps their combined stall.
 */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160];

/** Test-only: the worst-case per-call stall of the DEFAULT policy. */
export const RENAME_RETRY_TOTAL_MS_FOR_TEST = RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);

// Hard clamps on an injected policy. The seam exists for tests, but it is a
// public option — an unclamped delays array (or Infinity) combined with the
// blocking sync sleep would let a stray options object remove the retry bound
// entirely and park the daemon event loop.
const RENAME_RETRY_MAX_ATTEMPTS = 8;
const RENAME_RETRY_MAX_TOTAL_MS = 500;

function clampRetryDelays(delays: readonly number[]): readonly number[] {
  const out: number[] = [];
  let total = 0;
  for (const d of delays.slice(0, RENAME_RETRY_MAX_ATTEMPTS)) {
    const ms = Math.min(Math.max(0, Math.floor(d)), RENAME_RETRY_MAX_TOTAL_MS - total);
    if (ms <= 0) break;
    out.push(ms);
    total += ms;
  }
  return out;
}

// Process-wide sliding budget for the SYNC retry sleeps. The per-call cap
// bounds one rename (a write does two), but the daemon has many sync stores
// (peers, inbox, state writers) and Electron main has the sync text writers,
// and AV contention hits them together — without a shared budget a batch
// flush could stack per-call stalls into seconds of blocked event loop.
// When the budget is spent, writes fail immediately with the original error,
// exactly as before this retry existed.
const SYNC_RETRY_BUDGET_MS = 1_000;
const SYNC_RETRY_WINDOW_MS = 5_000;
let syncRetryWindowStart = 0;
let syncRetrySpentMs = 0;

function takeSyncRetryBudget(ms: number): boolean {
  const now = Date.now();
  if (now - syncRetryWindowStart > SYNC_RETRY_WINDOW_MS) {
    syncRetryWindowStart = now;
    syncRetrySpentMs = 0;
  }
  if (syncRetrySpentMs + ms > SYNC_RETRY_BUDGET_MS) return false;
  syncRetrySpentMs += ms;
  return true;
}

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT_RENAME_CODES.has(code);
}

/** Sleep without burning CPU or yielding the event loop. */
function sleepSyncDefault(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function warnRenameRetriesExhausted(
  targetPath: string,
  attempts: number,
  err: unknown,
  step: 'commit' | 'backup',
): void {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
  // Only claim AV when the final error is still in the transient family — a
  // failure that CHANGED code mid-retry (say EPERM → ENOSPC) is a different
  // problem and blaming the scanner would send the operator the wrong way.
  const hint = isTransientRenameError(err)
    ? ' (antivirus may be holding the file)'
    : '';
  // A backup failure does not lose the write: the caller warns and commits
  // anyway, so say so rather than read like the data never landed.
  const what = step === 'backup' ? 'Backup rename' : 'Commit rename';
  const outcome = step === 'backup' ? ' The write continues without a fresh backup.' : '';
  // eslint-disable-next-line no-console
  console.warn(
    `[atomicWrite] ${what} to "${targetPath}" still failing after ` +
      `${attempts} attempts, last code ${code}${hint}.${outcome}`,
  );
}

/**
 * Run the commit rename, retrying transient win32 handle contention.
 * On final failure the rename's own error is rethrown unchanged — callers
 * branch on `err.code`. A throwing injected sleeper cannot mask it.
 */
export function commitRenameSync(
  tmp: string,
  targetPath: string,
  policy: RenameRetryPolicy | undefined,
  step: 'commit' | 'backup' = 'commit',
): void {
  const delays = clampRetryDelays(policy?.delaysMs ?? RENAME_RETRY_DELAYS_MS);
  const sleep = policy?.sleepSync ?? sleepSyncDefault;

  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, targetPath);
      return;
    } catch (err) {
      const retryable =
        process.platform === 'win32' &&
        i < delays.length &&
        isTransientRenameError(err) &&
        takeSyncRetryBudget(delays[i]);
      if (!retryable) {
        if (i > 0) warnRenameRetriesExhausted(targetPath, i + 1, err, step);
        throw err;
      }
      try {
        sleep(delays[i]);
      } catch {
        throw err; // a broken sleeper must not swallow the rename failure
      }
    }
  }
}

export async function commitRename(
  tmp: string,
  targetPath: string,
  policy: RenameRetryPolicy | undefined,
  step: 'commit' | 'backup' = 'commit',
): Promise<void> {
  const delays = clampRetryDelays(policy?.delaysMs ?? RENAME_RETRY_DELAYS_MS);
  const sleep = policy?.sleep ?? sleepDefault;

  for (let i = 0; ; i++) {
    try {
      await fsp.rename(tmp, targetPath);
      return;
    } catch (err) {
      const retryable =
        process.platform === 'win32' &&
        i < delays.length &&
        isTransientRenameError(err);
      if (!retryable) {
        if (i > 0) warnRenameRetriesExhausted(targetPath, i + 1, err, step);
        throw err;
      }
      try {
        await sleep(delays[i]);
      } catch {
        throw err;
      }
    }
  }
}

/**
 * Best-effort restore of `.bak` → target after the commit rename gave up.
 * Without this, a retry-exhausted write leaves NO primary at all (the previous
 * one was already rotated to `.bak`), and the "a failed write leaves the
 * previous state" contract silently breaks — a crash in that window resurrects
 * whatever generation `.bak` holds (#658's symptom family). Guarded on the
 * primary still being absent: if a concurrent writer recreated it during the
 * retry window, their newer data must not be clobbered with our old backup.
 */
export function rollbackBakSync(bak: string, targetPath: string): void {
  try {
    if (fs.existsSync(targetPath) || !fs.existsSync(bak)) return;
    fs.renameSync(bak, targetPath);
  } catch (rbErr) {
    // eslint-disable-next-line no-console
    console.error(
      `[atomicWrite] could not restore "${bak}" after a failed commit — no primary file remains:`,
      rbErr,
    );
  }
}

export async function rollbackBak(bak: string, targetPath: string): Promise<void> {
  try {
    await fsp.access(targetPath);
    return; // primary exists again — leave it alone
  } catch {
    /* absent — attempt the restore below */
  }
  try {
    await fsp.rename(bak, targetPath);
  } catch (rbErr) {
    const code = (rbErr as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.error(
        `[atomicWrite] could not restore "${bak}" after a failed commit — no primary file remains:`,
        rbErr,
      );
    }
  }
}

// Per-target serialisation of ASYNC writes. The retry sleep opens the event
// loop for up to ~310ms with the primary already rotated away; two async
// writers interleaving in that window could commit out of order and lose the
// newer payload with no backup. Chaining writes to the same path removes that
// race within this process (cross-process writers were never coordinated, and
// the sync variant blocks the loop so it cannot interleave with itself).
const asyncWriteChains = new Map<string, Promise<void>>();

export function chainAsyncWrite(targetPath: string, run: () => Promise<void>): Promise<void> {
  const prev = asyncWriteChains.get(targetPath) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(run);
  asyncWriteChains.set(targetPath, next);
  void next.catch(() => undefined).then(() => {
    if (asyncWriteChains.get(targetPath) === next) asyncWriteChains.delete(targetPath);
  });
  return next;
}

// ── Could not read ───────────────────────────────────────────────────

/**
 * The read itself failed, so nothing is known about what the file holds: not
 * missing (a null read), not corrupt (the bytes were read and are bad). Thrown
 * by the atomic reads, and by a write to a file whose last read ended this way.
 */
export class CouldNotReadError extends Error {
  readonly code = 'ECOULDNOTREAD';
  /** The operating system's code for the failure, such as EBUSY. */
  readonly fileCode: string;

  constructor(readonly path: string, err: unknown) {
    const fileCode = (err as NodeJS.ErrnoException | undefined)?.code ?? String(err);
    super(`could not read "${path}" (${fileCode}); it is left as it is`);
    this.name = 'CouldNotReadError';
    this.fileCode = fileCode;
  }
}

function isAbsentError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// Adapted from yetone/magpie@c7ebb6f8d (internal/steady/steady.go), MIT
/**
 * The file's text, or null when it is not there, which is never waited on: most
 * reads of an absent file are of a store not written yet. A file another process
 * holds for a moment on win32 is retried with the rename policy above; any other
 * failure, or one that outlasts the retries, is a `CouldNotReadError`.
 */
export function readFileRetryingSync(filePath: string, policy?: RenameRetryPolicy): string | null {
  const delays = clampRetryDelays(policy?.delaysMs ?? RENAME_RETRY_DELAYS_MS);
  const sleep = policy?.sleepSync ?? sleepSyncDefault;

  for (let i = 0; ; i++) {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      if (isAbsentError(err)) return null;
      const retryable =
        process.platform === 'win32' &&
        i < delays.length &&
        isTransientRenameError(err) &&
        takeSyncRetryBudget(delays[i]);
      if (!retryable) throw new CouldNotReadError(filePath, err);
      try {
        sleep(delays[i]);
      } catch {
        throw new CouldNotReadError(filePath, err);
      }
    }
  }
}

export async function readFileRetrying(filePath: string, policy?: RenameRetryPolicy): Promise<string | null> {
  const delays = clampRetryDelays(policy?.delaysMs ?? RENAME_RETRY_DELAYS_MS);
  const sleep = policy?.sleep ?? sleepDefault;

  for (let i = 0; ; i++) {
    try {
      return await fsp.readFile(filePath, 'utf-8');
    } catch (err) {
      if (isAbsentError(err)) return null;
      const retryable =
        process.platform === 'win32' &&
        i < delays.length &&
        isTransientRenameError(err);
      if (!retryable) throw new CouldNotReadError(filePath, err);
      try {
        await sleep(delays[i]);
      } catch {
        throw new CouldNotReadError(filePath, err);
      }
    }
  }
}

/**
 * One line in the shape of both log sinks' `logLine`. Their tee carries stderr
 * into the main and daemon daily logs, and `wmux doctor` counts the level token.
 * Written directly because this module takes no logger dependency.
 */
function logStateEvent(level: 'warn' | 'error', message: string): void {
  try {
    process.stderr.write(`[${new Date().toISOString()}] [${level}] [atomicWrite] ${message}\n`);
  } catch {
    // Logging must never throw.
  }
}

// Files whose last read could not read them. Most callers catch every read
// error and carry on with an empty store, so the read's error alone would not
// stop their next save from replacing a good file with that emptiness. Their
// writes are refused here until a read of the file gets through, which is also
// what a store that reads before each write does next time.
const heldTargets = new Map<string, CouldNotReadError>();

export function holdWrites(targetPath: string, err: CouldNotReadError): void {
  const key = path.resolve(targetPath);
  if (heldTargets.has(key)) return;
  heldTargets.set(key, err);
  logStateEvent('error', `${err.message}; writes to it are refused until a read succeeds`);
}

export function releaseWrites(targetPath: string): void {
  heldTargets.delete(path.resolve(targetPath));
}

export function assertWritesNotHeld(targetPath: string): void {
  const held = heldTargets.get(path.resolve(targetPath));
  if (held) throw new CouldNotReadError(targetPath, { code: held.fileCode });
}

// Adapted from yetone/magpie@c7ebb6f8d (internal/lastgood/lastgood.go), MIT
// A store read hundreds of times over is reported once, until its file reads.
const reportedFallbacks = new Set<string>();

export type PrimaryProblem = 'missing' | 'corrupt';

/** A read that did not come from the file itself. */
export function noteFallback(targetPath: string, slot: string, problem: PrimaryProblem): void {
  const key = path.resolve(targetPath);
  if (reportedFallbacks.has(key)) return;
  reportedFallbacks.add(key);
  // A missing file is also what a crash between a write's two renames leaves,
  // and what a reader sees during them, so only corruption counts as an error.
  logStateEvent(
    problem === 'corrupt' ? 'error' : 'warn',
    `"${targetPath}" is ${problem}; using the older state in ${path.basename(slot)}`,
  );
}

export function notePrimaryRead(targetPath: string): void {
  reportedFallbacks.delete(path.resolve(targetPath));
}

// Adapted from yetone/magpie@c7ebb6f8d (internal/lastgood/lastgood.go), MIT
/**
 * What a write does with the primary it is about to replace. Only a `good` one
 * becomes `.bak`: a `bad` one is set aside and an `empty` one holds nothing to
 * keep, so in both cases the last good backup stays where it is.
 */
export type PrimaryVerdict = 'absent' | 'good' | 'empty' | 'bad';

function judgePrimaryJSON(raw: string | null, validate?: (data: unknown) => boolean): PrimaryVerdict {
  if (raw === null) return 'absent';
  if (raw.trim() === '') return 'empty';
  try {
    const parsed = parseJSONSafe(raw);
    return parsed !== null && (!validate || validate(parsed)) ? 'good' : 'bad';
  } catch {
    return 'bad';
  }
}

function ensureDirSync(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * durable 경로의 부모 디렉토리 fsync (§2.3-4). rename(디렉토리 엔트리)을 내구화한다.
 * win32는 디렉토리 핸들 fsync를 지원하지 않으므로 스킵(§2.3 win32 잔여). 실패는
 * best-effort로 흡수한다 — 파일 자체는 이미 tmp fsync로 내구화됐다.
 */
async function fsyncParentDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let dh: fsp.FileHandle | undefined;
  try {
    dh = await fsp.open(dir, 'r');
    await dh.sync();
  } catch {
    // best-effort
  } finally {
    if (dh) {
      try {
        await dh.close();
      } catch {
        /* noop */
      }
    }
  }
}

function fsyncParentDirSync(dir: string): void {
  if (process.platform === 'win32') return;
  let dirFd = -1;
  try {
    dirFd = fs.openSync(dir, 'r');
    fs.fsyncSync(dirFd);
  } catch {
    // best-effort
  } finally {
    if (dirFd >= 0) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* noop */
      }
    }
  }
}

function serialise(data: unknown): string {
  return JSON.stringify(data, null, JSON_INDENT);
}

function parseJSONSafe(raw: string): unknown {
  // JSON.parse throws on invalid JSON — callers handle that and fall
  // back to `.bak` or return `null`.
  return JSON.parse(raw, jsonReviver);
}

function detectVersion(data: unknown): number {
  if (typeof data === 'object' && data !== null) {
    const v = (data as Record<string, unknown>)['version'];
    if (typeof v === 'number') return v;
  }
  return 0;
}

/** Unlink, swallowing ENOENT. */
function unlinkIfExistsSync(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Don't crash cleanup — best effort.
    }
  }
}

async function unlinkIfExists(p: string): Promise<void> {
  try {
    await fsp.unlink(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // swallow; cleanup is best-effort
    }
  }
}

/**
 * T6: decide whether `candidatePath` is eligible for quarantine.
 *
 * We quarantine:
 *   - the primary file itself, and
 *   - any rotation-managed slot (`.bak`, `.bak.1` … `.bak.3`).
 *
 * We do NOT quarantine the T7 pre-migration sentinel
 * (`.v{n}.premigrate.bak`) — it is a one-shot diagnostic artifact and
 * operators expect it to stick around independent of validation
 * outcome. The `isManagedBackup` allowlist already rejects it, so we
 * just reuse that check.
 */
function isQuarantineEligible(
  targetPath: string,
  candidatePath: string,
): boolean {
  if (candidatePath === targetPath) return true;
  const targetBase = path.basename(targetPath);
  const candidateBase = path.basename(candidatePath);
  return isManagedBackup(targetBase, candidateBase);
}

// ── Async write ──────────────────────────────────────────────────────

export async function atomicWriteJSON(
  targetPath: string,
  data: unknown,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  if (opts.validate) {
    let ok = false;
    try {
      ok = opts.validate(data);
    } catch (err) {
      throw new Error(
        `atomicWriteJSON: validate() threw for "${targetPath}": ${String(err)}`,
      );
    }
    if (!ok) {
      throw new Error(
        `atomicWriteJSON: validate() rejected payload for "${targetPath}"`,
      );
    }
  }

  // Serialised per target: see chainAsyncWrite for why interleaving async
  // writers across the retry window loses data.
  return chainAsyncWrite(targetPath, async () => {
    assertWritesNotHeld(targetPath);

    const tmp = makeTmpPath(targetPath);
    const bak = bakPathFor(targetPath);

    await ensureDir(targetPath);

    const json = serialise(data);

    let movedToBak = false;
    try {
      // 1. Write to temp file. mode:0o600 is a no-op on Windows, but
      //    matches the StateWriter's POSIX intent.
      if (opts.durable) {
        // §2.3-1,2: rename 전에 tmp 내용을 fsync해 디스크에 내구화한다.
        const fh = await fsp.open(tmp, 'w', 0o600);
        try {
          await fh.writeFile(json, { encoding: 'utf-8' });
          await fh.sync();
        } finally {
          await fh.close();
        }
      } else {
        await fsp.writeFile(tmp, json, { encoding: 'utf-8', mode: 0o600 });
      }

      // 2. Judge the primary. A read that fails here stops the write: the
      //    file is neither replaced nor rotated while nothing is known of it.
      const verdict = judgePrimaryJSON(
        await readFileRetrying(targetPath, opts.renameRetry),
        opts.validate,
      );
      if (verdict === 'bad') {
        const moved = await quarantineFile(targetPath, 'failed validation before a write', { clock: opts.clock });
        if (!moved) {
          // eslint-disable-next-line no-console
          console.warn(`[atomicWrite] could not set aside the invalid "${targetPath}"; the write replaces it`);
        }
      }

      // 3. When rotation is enabled we shift the existing numbered
      //    slots BEFORE overwriting `.bak` so nothing is lost:
      //      .bak.2 → .bak.3, .bak.1 → .bak.2, .bak → .bak.1.
      //    With rotation off we keep the historical single-slot
      //    behaviour (current `.bak` is overwritten by step 4).
      if (opts.rotationEnabled && (verdict === 'good' || verdict === 'absent')) {
        await rotateBackups(targetPath);
      }

      // 4. Rotate current → .bak. The SAME AV contention that holds the
      //    commit rename can hold this one, and giving up here means the
      //    commit overwrites the primary while `.bak` still holds an older
      //    generation — the last good copy would survive nowhere. Retry it
      //    with the same policy; if it still fails we keep the historical
      //    warn-and-continue (availability over the backup guarantee).
      if (verdict === 'good') {
        try {
          await commitRename(targetPath, bak, opts.renameRetry, 'backup');
          movedToBak = true;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            // eslint-disable-next-line no-console
            console.warn('[atomicWrite] Failed to create backup:', err);
          }
        }
      }

      // 5. Atomic rename tmp → target (retried on win32 AV contention).
      try {
        await commitRename(tmp, targetPath, opts.renameRetry);
      } catch (err) {
        // The primary is gone (step 4 moved it) and the new data never
        // landed. Put the previous generation back so "a failed write
        // leaves the previous state" still holds.
        if (movedToBak) await rollbackBak(bak, targetPath);
        throw err;
      }

      // 6. §2.3-4: durable이면 부모 디렉토리 엔트리(rename)를 내구화(win32 스킵).
      if (opts.durable) {
        await fsyncParentDir(path.dirname(targetPath));
      }
    } catch (err) {
      // Best-effort tmp cleanup so we don't leak partial files.
      await unlinkIfExists(tmp);
      throw err;
    }
  });
}

// ── Async read ───────────────────────────────────────────────────────

export async function atomicReadJSON<T>(
  targetPath: string,
  opts: AtomicReadOptions<T> = {},
): Promise<T | null> {
  let primaryProblem: PrimaryProblem = 'missing';
  const attempt = async (p: string, label: 'primary' | 'backup'): Promise<T | null> => {
    // A failed read throws out of here: it is not a slot to step past.
    const raw = await readFileRetrying(p, opts.readRetry);
    if (raw === null) return null;
    if (label === 'primary') primaryProblem = 'corrupt';
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = parseJSONSafe(raw);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[atomicRead] ${label} parse failed for "${p}":`, err);
      return null;
    }
    if (parsed === null) return null;

    // T7: lazy migration. If a migrator hook is supplied we run it
    // against the detected schema version. A throwing hook is
    // treated as a parse-level failure — we warn and return null so
    // the fallback chain picks up a `.bak` (and, once T6 lands, a
    // quarantine handoff). The migrator's `version` is informational;
    // `atomicReadJSON` intentionally exposes only the payload to keep
    // the public surface narrow. Persisting the upgraded payload is
    // the caller's responsibility and normally happens on the next
    // write.
    if (opts.migrator) {
      const fromVersion = detectVersion(parsed);
      try {
        const result = opts.migrator(parsed, fromVersion);
        parsed = result.data;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[atomicRead] migrator failed for ${label} "${p}":`,
          err,
        );
        return null;
      }
    }

    if (opts.validate && !opts.validate(parsed)) {
      // T6: hand the offending file off to quarantine so the next
      // write does not silently overwrite it. We still return null
      // here — the fallback chain below (`.bak` → `.bak.1` → …) is
      // preserved so a healthy older slot can still rescue the read.
      //
      // Eligibility guard: only quarantine the primary file or a
      // rotation-managed `.bak` slot. The T7 `.premigrate.bak`
      // sentinel is deliberately left in place (see
      // `isQuarantineEligible`), though it cannot normally reach
      // this branch because the fallback iterates only
      // `BACKUP_SUFFIXES`.
      if (
        (opts.quarantineOnCorruption ?? true) &&
        isQuarantineEligible(targetPath, p)
      ) {
        try {
          await quarantineFile(p, 'validate rejected parsed payload', {
            clock: opts.clock,
          });
        } catch {
          // best-effort — never let quarantine failures mask the read.
        }
      }
      return null;
    }

    return parsed as T;
  };

  // Fallback chain: primary → .bak → .bak.1 → .bak.2 → .bak.3. This
  // is deliberately independent of `rotationEnabled`: a legacy
  // single-`.bak` file still participates, and rotated archives
  // added by T5 become usable without any call-site change.
  try {
    const primary = await attempt(targetPath, 'primary');
    if (primary !== null) {
      settleRead(targetPath, opts, true);
      return primary;
    }

    for (const suffix of BACKUP_SUFFIXES) {
      const candidate = `${targetPath}${suffix}`;
      const backup = await attempt(candidate, 'backup');
      if (backup !== null) {
        noteFallback(targetPath, candidate, primaryProblem);
        settleRead(targetPath, opts, false);
        return backup;
      }
    }
  } catch (err) {
    if (err instanceof CouldNotReadError && !opts.readOnly) holdWrites(targetPath, err);
    throw err;
  }

  settleRead(targetPath, opts, false);
  return null;
}

/** A read that got through: whatever it found, it is what the file holds. */
function settleRead<T>(targetPath: string, opts: AtomicReadOptions<T>, fromPrimary: boolean): void {
  if (fromPrimary) notePrimaryRead(targetPath);
  if (!opts.readOnly) releaseWrites(targetPath);
}

// ── Sync write (emergency save paths) ────────────────────────────────

export function atomicWriteJSONSync(
  targetPath: string,
  data: unknown,
  opts: AtomicWriteOptions = {},
): void {
  if (opts.validate) {
    let ok = false;
    try {
      ok = opts.validate(data);
    } catch (err) {
      throw new Error(
        `atomicWriteJSONSync: validate() threw for "${targetPath}": ${String(err)}`,
      );
    }
    if (!ok) {
      throw new Error(
        `atomicWriteJSONSync: validate() rejected payload for "${targetPath}"`,
      );
    }
  }

  assertWritesNotHeld(targetPath);

  const tmp = makeTmpPath(targetPath);
  const bak = bakPathFor(targetPath);

  ensureDirSync(targetPath);

  const json = serialise(data);

  try {
    if (opts.durable) {
      // §2.3-1,2: rename 전에 tmp 내용을 fsync해 디스크에 내구화한다.
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, json, { encoding: 'utf-8' });
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      fs.writeFileSync(tmp, json, { encoding: 'utf-8', mode: 0o600 });
    }

    // Judge the primary before anything moves — see the async variant.
    const verdict = judgePrimaryJSON(
      readFileRetryingSync(targetPath, opts.renameRetry),
      opts.validate,
    );
    if (verdict === 'bad') {
      const moved = quarantineFileSync(targetPath, 'failed validation before a write', { clock: opts.clock });
      if (!moved) {
        // eslint-disable-next-line no-console
        console.warn(`[atomicWrite] could not set aside the invalid "${targetPath}"; the write replaces it`);
      }
    }

    // Shift the numbered slots up when rotation is enabled so the
    // upcoming `.bak` overwrite does not drop a generation. See the
    // async variant for the slot-order rationale.
    if (opts.rotationEnabled && (verdict === 'good' || verdict === 'absent')) {
      rotateBackupsSync(targetPath);
    }

    // Rotate current → .bak with the same retry as the commit — see the async
    // variant for why giving up here silently forfeits the last good copy.
    let movedToBak = false;
    if (verdict === 'good') {
      try {
        commitRenameSync(targetPath, bak, opts.renameRetry, 'backup');
        movedToBak = true;
      } catch (bakErr) {
        // eslint-disable-next-line no-console
        console.warn('[atomicWrite] Failed to create backup:', bakErr);
      }
    }

    try {
      commitRenameSync(tmp, targetPath, opts.renameRetry);
    } catch (err) {
      // Restore the previous generation so a retry-exhausted write does not
      // leave the caller with no primary file at all (see rollbackBakSync).
      if (movedToBak) rollbackBakSync(bak, targetPath);
      throw err;
    }

    // §2.3-4: durable이면 부모 디렉토리 엔트리(rename)를 내구화(win32 스킵).
    if (opts.durable) {
      fsyncParentDirSync(path.dirname(targetPath));
    }
  } catch (err) {
    unlinkIfExistsSync(tmp);
    throw err;
  }
}

// ── Sync read ────────────────────────────────────────────────────────

export function atomicReadJSONSync<T>(
  targetPath: string,
  opts: AtomicReadOptions<T> = {},
): T | null {
  let primaryProblem: PrimaryProblem = 'missing';
  const attempt = (p: string, label: 'primary' | 'backup'): T | null => {
    // A failed read throws out of here: it is not a slot to step past.
    const raw = readFileRetryingSync(p, opts.readRetry);
    if (raw === null) return null;
    if (label === 'primary') primaryProblem = 'corrupt';
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = parseJSONSafe(raw);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[atomicRead] ${label} parse failed for "${p}":`, err);
      return null;
    }
    if (parsed === null) return null;

    // T7: sync counterpart of the async migrator path above. See
    // `atomicReadJSON` for the design rationale.
    if (opts.migrator) {
      const fromVersion = detectVersion(parsed);
      try {
        const result = opts.migrator(parsed, fromVersion);
        parsed = result.data;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[atomicRead] migrator failed for ${label} "${p}":`,
          err,
        );
        return null;
      }
    }

    if (opts.validate && !opts.validate(parsed)) {
      // T6 sync counterpart — see `atomicReadJSON` for the rationale.
      if (
        (opts.quarantineOnCorruption ?? true) &&
        isQuarantineEligible(targetPath, p)
      ) {
        try {
          quarantineFileSync(p, 'validate rejected parsed payload', {
            clock: opts.clock,
          });
        } catch {
          // best-effort
        }
      }
      return null;
    }

    return parsed as T;
  };

  // Same fallback walk as the async variant; see there for the
  // rationale on being rotation-agnostic.
  try {
    const primary = attempt(targetPath, 'primary');
    if (primary !== null) {
      settleRead(targetPath, opts, true);
      return primary;
    }

    for (const suffix of BACKUP_SUFFIXES) {
      const candidate = `${targetPath}${suffix}`;
      const backup = attempt(candidate, 'backup');
      if (backup !== null) {
        noteFallback(targetPath, candidate, primaryProblem);
        settleRead(targetPath, opts, false);
        return backup;
      }
    }
  } catch (err) {
    if (err instanceof CouldNotReadError && !opts.readOnly) holdWrites(targetPath, err);
    throw err;
  }

  settleRead(targetPath, opts, false);
  return null;
}
