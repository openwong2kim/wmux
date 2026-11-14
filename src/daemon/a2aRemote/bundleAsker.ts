import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { A2A_REMOTE_PROTOCOL, A2A_SHA256_RE, isHostId, type A2aRemoteDeliverResponse, type A2aRemoteEnvelope, type HostId } from '../../shared/a2aRemote';
import {
  BUNDLE_TTL_DEFAULT_MS,
  bundleRefName,
  isBundleAskId,
  isBundleId,
  parseBundleAsk,
  parseBundleMade,
  type A2aBundleManifestV1,
  type A2aBundleRefusal,
} from '../../shared/a2aBundle';
import {
  A2A_BUNDLE_ASK_RPC,
  BUNDLE_ASK_LIMITS,
  isBundleBringBackRefusal,
  type BundleBringBackRefusal,
  type BundleBringBackState,
} from '../../shared/a2aBundleAsk';
import { isSpawnId } from '../../shared/a2aSpawn';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { bundleStagedFile, type BundleIntake, type BundlePull } from './bundleIntake';
import { headlessTreeId } from './headlessStarter';
import { errMsg, isPlainObject, loadStore, type StoreLog } from './storeFile';

/**
 * The asking PC's side of bringing back an agent's work (shared/a2aBundle.ts):
 * for one spawn this PC started on another PC (the box), it asks the box to
 * make a bundle (`make`), takes the bundle into staging (bundleIntake.ts: a
 * GET when this PC joined the box, else a wait and a `send`), and tells the
 * box it has it (`done`). Main then imports it (main/worktask/bundleImport.ts)
 * and releases it here.
 *
 * One ask per spawn at a time; a second call follows the first. Asks are
 * kept in `bundle-asks.json`, so a restart asks again (a make on an unchanged
 * head answers the same bundle) and a bundle staged in time is still there to
 * import. An answer is taken only from the PC the ask went to, for an ask id
 * this PC minted; nothing in it is read but its manifest or its reason.
 * The ref a bundle may hold is computed here, from this PC's id and the spawn
 * id, never taken from the box.
 */

const ASKS_FILE = 'bundle-asks.json';

type Phase = 'making' | 'made' | 'staged' | 'refused';
type Step = 'make' | 'pull' | 'send';

export interface BundleAskRecordV1 {
  v: 1;
  hostId: HostId;
  spawnId: string;
  /** The id of the latest ask sent: one per attempt (the box answers a repeated id with its earlier answer). */
  askId: string;
  /** The home repository's key (main/worktask/workerGit.ts originUrlRepoKey), from main. */
  origin: string;
  phase: Phase;
  step: Step;
  manifest?: A2aBundleManifestV1;
  reason?: BundleBringBackRefusal;
  /** Retries used, over every step of the ask: a bundle that keeps failing its checks is not asked for forever. */
  tries: number;
  createdAt: number;
  /** When the bundle was staged: a staged file keeps its full time to be imported. */
  stagedAt?: number;
  /** A refusal was told to a caller once: the next call asks anew. */
  shown?: true;
}

export interface BundleAskerDeps {
  a2aDir: string;
  intake: Pick<BundleIntake, 'pull' | 'receive' | 'cancel' | 'discard' | 'sweepStaged' | 'stop' | 'forgetHost'>;
  /** The bundle feature is on here. */
  enabled: () => boolean;
  /** That PC advertises `bundle.1`. */
  peerTakes: (hostId: HostId) => boolean;
  /** This PC's host id as other PCs know it; null when it has none yet. */
  selfHostId: () => string | null;
  /** The largest bundle this PC takes (shared/a2aBundle.ts bundleBytesMax). */
  maxBytes: () => number;
  enqueue: (hostId: HostId, envelope: A2aRemoteEnvelope) => void;
  log: StoreLog;
  /** Test seams. */
  now?: () => number;
  random?: () => number;
  /** Free bytes on the disk of `dir`, or null when it cannot be read. */
  freeBytes?: (dir: string) => number | null;
  write?: (filePath: string, data: unknown) => void;
  harden?: (filePath: string) => void;
}

const OK: A2aRemoteDeliverResponse = { ok: true, duplicate: false };
const BAD: A2aRemoteDeliverResponse = { ok: false, error: 'bad-request' };
/** Answers worth asking again for, after a wait. */
const RETRIED: ReadonlySet<A2aBundleRefusal> = new Set(['again', 'busy', 'rate-limited']);
const OPEN: ReadonlySet<Phase> = new Set(['making', 'made']);
const key = (hostId: string, spawnId: string): string => `${hostId}:${spawnId}`;
/** Free disk kept besides a bundle: the staged file and, at import, its pack in the home repository. */
const DISK_RESERVE_BYTES = 256 * 1024 * 1024;
/** Make asks that ended before their answer came, remembered so a late bundle is told to go. */
const ENDED_ASKS_MAX = 64;

function statfsFree(dir: string): number | null {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

export class BundleAsker {
  private readonly deps: BundleAskerDeps;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly filePath: string;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly harden: (filePath: string) => void;
  private readonly records = new Map<string, BundleAskRecordV1>();
  /** Bumped whenever an ask's step changes or ends: work started for an older step drops its outcome. */
  private readonly gen = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /** askId → the PC and spawn of a make ask that ended while it waited for its answer (oldest first). */
  private readonly endedAsks = new Map<string, { hostId: HostId; spawnId: string }>();
  private readonly boot = crypto.randomBytes(4).toString('hex');
  private sends = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: BundleAskerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.filePath = path.join(deps.a2aDir, ASKS_FILE);
    this.write = deps.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.harden = deps.harden ?? scheduleTokenFileReHarden;
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: ASKS_FILE,
      coerce: (raw) => (isPlainObject(raw) && raw['v'] === 1 && Array.isArray(raw['asks']) ? raw : null),
      now: this.now,
      log: deps.log,
      level: 'warn',
      emptyMeans: 'this PC has asked for no bundle',
    });
    for (const r of (loaded.value as { asks: unknown[] } | null)?.asks ?? []) {
      const rec = coerceRecord(r);
      if (rec) this.records.set(key(rec.hostId, rec.spawnId), rec);
    }
  }

  /** At daemon start: open asks go on (with the feature off, the sweep ends them), staging is swept, and the sweep repeats. */
  start(): void {
    for (const rec of this.deps.enabled() ? this.records.values() : []) {
      if (!OPEN.has(rec.phase)) continue;
      if (rec.phase === 'made') {
        void this.resumeMade(rec);
        continue;
      }
      // The box may have restarted: a make on an unchanged head answers the bundle it stands for.
      this.sendMake(rec);
    }
    this.save();
    void this.sweep();
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => void this.sweep(), BUNDLE_ASK_LIMITS.sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** A made ask at start: its file, when it landed before the stop, is staged; else the bundle is made again. */
  private async resumeMade(rec: BundleAskRecordV1): Promise<void> {
    const mine = this.genOf(rec);
    const there = await this.stillStaged(rec);
    if (this.records.get(key(rec.hostId, rec.spawnId)) !== rec || this.genOf(rec) !== mine) return;
    if (there && rec.manifest) return this.staged(rec, rec.manifest);
    Object.assign(rec, { phase: 'making', step: 'make' });
    delete rec.manifest;
    this.bump(rec);
    this.save();
    this.sendMake(rec);
  }

  /**
   * Ask for the work of `spawnId` on `hostId` to be brought back, or follow
   * the ask that runs. Waits up to `waitMs` (capped) for the ask to move on.
   */
  async bringBack(hostId: HostId, spawnId: string, origin: string, waitMs = 0): Promise<BundleBringBackState> {
    if (!this.deps.enabled()) return { state: 'refused', reason: 'feature-off' };
    const k = key(hostId, spawnId);
    let rec = this.records.get(k);
    if (rec?.phase === 'refused' && rec.shown) {
      this.drop(k);
      rec = undefined;
    }
    if (rec?.phase === 'staged' && !(await this.stillStaged(rec))) {
      this.drop(k);
      rec = undefined;
    }
    if (!rec) {
      if (!this.deps.peerTakes(hostId)) return { state: 'refused', reason: 'not-supported' };
      if (!this.room(hostId, 0)) return { state: 'refused', reason: 'staging-full' };
      rec = { v: 1, hostId, spawnId, askId: `ba-${crypto.randomUUID()}`, origin, phase: 'making', step: 'make', tries: 0, createdAt: this.now() };
      this.records.set(k, rec);
      this.save();
      this.sendMake(rec);
    }
    if (OPEN.has(rec.phase) && waitMs > 0) await this.settled(k, Math.min(waitMs, BUNDLE_ASK_LIMITS.waitMaxMs));
    return this.view(k);
  }

  /** Main is done with the ask (imported, refused at import, or cancelled): its staged file goes and it ends. */
  async release(hostId: HostId, spawnId: string): Promise<void> {
    const k = key(hostId, spawnId);
    const rec = this.records.get(k);
    if (!rec) return;
    this.end(rec);
    this.drop(k);
    if (rec.manifest) await this.deps.intake.discard(hostId, rec.manifest).catch((err: unknown) => {
      this.deps.log('warn', `[a2a-remote] bundle for ${spawnId}: its staged file was not removed: ${errMsg(err)}`);
    });
  }

  /** A `bundle-made` from `peer` (inbound.ts routes it here). */
  applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse {
    if (env.kind !== 'link' || env.link?.state !== 'bundle-made' || env.linkVersion !== 0) return BAD;
    const made = parseBundleMade(env.bundleMade);
    if (!made || made.askId !== env.linkId) return BAD;
    // Only an ask this PC made, of that PC, still open: anything else is taken and dropped.
    const rec = [...this.records.values()].find((r) => r.askId === made.askId && r.hostId === peer.hostId);
    if (!rec || !OPEN.has(rec.phase)) {
      this.lateMade(made.askId, peer.hostId, made.op === 'made' ? made.manifest.bundleId : null);
      return OK;
    }
    if (made.op === 'made') this.onMade(rec, made.manifest);
    else this.onRefused(rec, made.reason);
    return OK;
  }

  /** A paired PC was removed: its asks end without a word to it, and what was staged from it goes. */
  async forgetHost(hostId: HostId): Promise<void> {
    for (const [k, rec] of [...this.records]) {
      if (rec.hostId !== hostId) continue;
      this.bump(rec);
      clearTimeout(this.timers.get(k));
      this.timers.delete(k);
      this.drop(k);
      this.notify(rec);
    }
    for (const [askId, ended] of [...this.endedAsks]) if (ended.hostId === hostId) this.endedAsks.delete(askId);
    await this.deps.intake.forgetHost(hostId);
  }

  /** Asks past their time end; with the feature off every open ask ends; staging keeps only what a staged ask names. */
  async sweep(): Promise<void> {
    const off = !this.deps.enabled();
    if (off) this.deps.intake.stop();
    for (const [k, rec] of [...this.records]) {
      if (this.now() - (rec.stagedAt ?? rec.createdAt) > BUNDLE_ASK_LIMITS.stagedTtlMs) {
        this.end(rec);
        this.drop(k);
      } else if (off && OPEN.has(rec.phase)) {
        this.refuse(rec, 'feature-off');
      }
    }
    // Asked as each file is reached, not once before: a transfer that lands meanwhile is kept. A made ask owns its
    // file too (it may be placed while the sweep runs), as a staged one does.
    const owned = (file: string): boolean => [...this.records.values()].some((r) =>
      r.manifest !== undefined && (r.phase === 'made' || r.phase === 'staged') && bundleStagedFile(this.deps.a2aDir, r.hostId, r.manifest) === file);
    const removed = await this.deps.intake.sweepStaged((_hostId, file) => owned(file)).catch((err: unknown) => {
      this.deps.log('warn', `[a2a-remote] bundle staging not swept: ${errMsg(err)}`);
      return 0;
    });
    if (removed > 0) this.deps.log('info', `[a2a-remote] removed ${removed} staged bundle file(s) no ask holds`);
  }

  // --- the steps ------------------------------------------------------------

  private onMade(rec: BundleAskRecordV1, manifest: A2aBundleManifestV1): void {
    if (rec.step !== 'make') return;
    const tooLarge = manifest.bytes > this.deps.maxBytes();
    const free = tooLarge ? null : (this.deps.freeBytes ?? statfsFree)(this.deps.a2aDir);
    if (tooLarge || !this.room(rec.hostId, manifest.bytes, rec) || (free !== null && free < 2 * manifest.bytes + DISK_RESERVE_BYTES)) {
      // The box keeps it until it hears: it is told, so its offer ends now.
      this.ask(rec, { op: 'done', bundleId: manifest.bundleId });
      return this.refuse(rec, tooLarge ? 'too-large' : 'staging-full');
    }
    Object.assign(rec, { phase: 'made', step: 'pull', manifest });
    this.bump(rec);
    this.save();
    void this.transfer(rec);
  }

  private onRefused(rec: BundleAskRecordV1, reason: A2aBundleRefusal): void {
    // A `send` answered with a refusal: the wait for it ends.
    if (rec.step === 'send' && rec.manifest) {
      this.bump(rec);
      this.deps.intake.cancel(rec.hostId, rec.manifest);
    }
    if (RETRIED.has(reason)) return this.retry(rec, rec.step, reason);
    // The box no longer holds the bundle (it restarted, or its time ran out), or could not put it here (the pairing
    // turned around since it was made): it is made again, and taken the way the pairing is now.
    if ((reason === 'gone' && rec.step !== 'make') || (reason === 'unavailable' && rec.step === 'send')) return this.retry(rec, 'make', reason);
    this.refuse(rec, reason);
  }

  /** Into staging: a GET when this PC joined the box, else a wait registered before the `send` that asks for the PUT. */
  private async transfer(rec: BundleAskRecordV1): Promise<void> {
    const m = rec.manifest;
    if (!m) return;
    const mine = this.genOf(rec);
    // Still this ask, at this step: a release and a new ask for the same spawn make another record.
    const current = (): boolean => this.records.get(key(rec.hostId, rec.spawnId)) === rec && this.genOf(rec) === mine;
    let got: BundlePull = await this.deps.intake.pull(rec.hostId, m);
    if (!current()) return;
    if (got.kind === 'not-joined') {
      rec.step = 'send';
      this.save();
      const waiting = this.deps.intake.receive(rec.hostId, m, BUNDLE_TTL_DEFAULT_MS);
      this.ask(rec, { op: 'send', bundleId: m.bundleId });
      got = await waiting;
      if (!current()) return;
    }
    if (got.kind === 'staged') return this.staged(rec, m);
    if (got.kind === 'again' || got.kind === 'busy') return this.retry(rec, 'pull', got.kind === 'busy' ? 'busy' : 'again');
    // Refused before any byte, or not the bytes named: the offer may be gone (the box restarted); it is made again.
    if (got.kind === 'fatal') this.deps.log('info', `[a2a-remote] bundle ${m.bundleId} for ${rec.spawnId} not taken: ${got.why}`);
    this.retry(rec, 'make', 'unavailable');
  }

  private staged(rec: BundleAskRecordV1, m: A2aBundleManifestV1): void {
    Object.assign(rec, { phase: 'staged', stagedAt: this.now() });
    this.bump(rec);
    this.save();
    this.ask(rec, { op: 'done', bundleId: m.bundleId });
    this.deps.log('info', `[a2a-remote] bundle ${m.bundleId} for ${rec.spawnId} staged (${m.bytes} bytes)`);
    this.notify(rec);
  }

  /** An answer to a make ask that has ended: a bundle made for it is told to go, unless that spawn is asked for again. */
  private lateMade(askId: string, hostId: HostId, bundleId: string | null): void {
    const ended = this.endedAsks.get(askId);
    if (!ended || ended.hostId !== hostId) return;
    this.endedAsks.delete(askId);
    const again = this.records.get(key(hostId, ended.spawnId));
    if (bundleId === null || (again && again.phase !== 'refused')) return;
    this.enqueueAsk(hostId, { op: 'done', bundleId });
  }

  /** The step again after its wait, or the ask ends once its retries are used. */
  private retry(rec: BundleAskRecordV1, step: Step, reason: A2aBundleRefusal): void {
    if (rec.tries >= BUNDLE_ASK_LIMITS.retries) return this.refuse(rec, reason);
    const delay = BUNDLE_ASK_LIMITS.backoffMs[Math.min(rec.tries, BUNDLE_ASK_LIMITS.backoffMs.length - 1)] + Math.floor(this.random() * BUNDLE_ASK_LIMITS.jitterMs);
    rec.tries += 1;
    rec.step = step === 'send' ? 'pull' : step;
    if (rec.step === 'make') {
      rec.phase = 'making';
      delete rec.manifest;
    }
    const mine = this.bump(rec);
    this.save();
    const k = key(rec.hostId, rec.spawnId);
    clearTimeout(this.timers.get(k));
    const t = setTimeout(() => {
      this.timers.delete(k);
      if (this.records.get(k) !== rec || this.genOf(rec) !== mine) return;
      if (rec.step === 'make') this.sendMake(rec);
      else void this.transfer(rec);
    }, delay);
    t.unref?.();
    this.timers.set(k, t);
  }

  private refuse(rec: BundleAskRecordV1, reason: BundleBringBackRefusal): void {
    this.end(rec);
    Object.assign(rec, { phase: 'refused', reason });
    delete rec.manifest;
    this.save();
    this.deps.log('info', `[a2a-remote] bundle for ${rec.spawnId} from ${rec.hostId} not brought back: ${reason}`);
    this.notify(rec);
  }

  /** Whatever runs for the ask stops: its retry, its transfer, and the box's offer when one was made. */
  private end(rec: BundleAskRecordV1): void {
    this.bump(rec);
    const k = key(rec.hostId, rec.spawnId);
    clearTimeout(this.timers.get(k));
    this.timers.delete(k);
    if (rec.phase === 'making') {
      this.endedAsks.set(rec.askId, { hostId: rec.hostId, spawnId: rec.spawnId });
      while (this.endedAsks.size > ENDED_ASKS_MAX) this.endedAsks.delete(this.endedAsks.keys().next().value as string);
    }
    if (rec.manifest && rec.phase === 'made') {
      this.deps.intake.cancel(rec.hostId, rec.manifest);
      this.ask(rec, { op: 'done', bundleId: rec.manifest.bundleId });
    }
  }

  private sendMake(rec: BundleAskRecordV1): void {
    this.ask(rec, { op: 'make', spawnId: rec.spawnId, origin: rec.origin });
  }

  /**
   * One ask on the wire, under a new id (the box keeps one answer per id, so a retry under an old id would get the
   * old answer), checked as the box will check it. Only the latest id's answer is taken. A failure to queue it ends
   * the ask.
   */
  private ask(rec: BundleAskRecordV1, op: { op: 'make'; spawnId: string; origin: string } | { op: 'send' | 'done'; bundleId: string }): void {
    if (op.op !== 'done') {
      rec.askId = `ba-${crypto.randomUUID()}`;
      this.save();
    }
    const failed = this.enqueueAsk(rec.hostId, op, op.op === 'done' ? undefined : rec.askId);
    if (failed && op.op !== 'done' && rec.phase !== 'refused') this.refuse(rec, failed);
  }

  /** The envelope of one ask, queued to `hostId`; the refusal when it could not be. A `done` gets its own id. */
  private enqueueAsk(
    hostId: HostId,
    op: { op: 'make'; spawnId: string; origin: string } | { op: 'send' | 'done'; bundleId: string },
    askId = `ba-${crypto.randomUUID()}`,
  ): BundleBringBackRefusal | null {
    const bundleAsk = parseBundleAsk({ v: 1, askId, ...op });
    if (!bundleAsk) return 'bundle-unexpected';
    try {
      this.deps.enqueue(hostId, {
        protocol: A2A_REMOTE_PROTOCOL,
        linkId: askId,
        linkVersion: 0,
        messageId: `bq_${askId}_${this.boot}-${this.sends++}`,
        kind: 'link',
        link: { state: 'bundle-ask', version: 0 },
        bundleAsk,
        sentAt: new Date(this.now()).toISOString(),
      });
      return null;
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] bundle ask ${askId} (${op.op}) to ${hostId} not queued: ${errMsg(err)}`);
      return 'unavailable';
    }
  }

  // --- bookkeeping ----------------------------------------------------------

  private view(k: string): BundleBringBackState {
    const rec = this.records.get(k);
    if (!rec) return { state: 'refused', reason: 'gone' };
    if (rec.phase === 'refused') {
      if (!rec.shown) {
        rec.shown = true;
        this.save();
      }
      return { state: 'refused', reason: rec.reason ?? 'unavailable' };
    }
    if (rec.phase === 'staged' && rec.manifest) {
      const self = this.deps.selfHostId();
      if (!self) return { state: 'refused', reason: 'unavailable' };
      return {
        state: 'staged',
        file: bundleStagedFile(this.deps.a2aDir, rec.hostId, rec.manifest),
        manifest: { ...rec.manifest },
        ref: bundleRefName(headlessTreeId(self, rec.spawnId)),
      };
    }
    return { state: 'asking' };
  }

  /** Room for one more ask of `hostId` (or, with `rec`, for its bundle of `bytes`): per PC and in all. */
  private room(hostId: HostId, bytes: number, rec?: BundleAskRecordV1): boolean {
    const live = [...this.records.values()].filter((r) => r !== rec && r.phase !== 'refused');
    const own = live.filter((r) => r.hostId === hostId);
    const ownBytes = own.reduce((n, r) => n + (r.manifest?.bytes ?? 0), 0);
    const count = rec ? 0 : 1;
    return own.length + count <= BUNDLE_ASK_LIMITS.perHostFiles
      && live.length + count <= BUNDLE_ASK_LIMITS.totalFiles
      && ownBytes + bytes <= BUNDLE_ASK_LIMITS.perHostBytes;
  }

  /** The staged file is still there at its size (the import checks its contents). */
  private async stillStaged(rec: BundleAskRecordV1): Promise<boolean> {
    if (!rec.manifest) return false;
    const st = await fs.promises.lstat(bundleStagedFile(this.deps.a2aDir, rec.hostId, rec.manifest)).catch(() => null);
    return st?.isFile() === true && st.size === rec.manifest.bytes;
  }

  private genOf(rec: BundleAskRecordV1): number {
    return this.gen.get(key(rec.hostId, rec.spawnId)) ?? 0;
  }

  private bump(rec: BundleAskRecordV1): number {
    const k = key(rec.hostId, rec.spawnId);
    const next = (this.gen.get(k) ?? 0) + 1;
    this.gen.set(k, next);
    return next;
  }

  /** The record goes; its generation is kept counting, so work started for it never matches a later record's. */
  private drop(k: string): void {
    this.records.delete(k);
    this.save();
  }

  private settled(k: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const set = this.waiters.get(k) ?? new Set<() => void>();
      const done = (): void => {
        clearTimeout(t);
        set.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      t.unref?.();
      set.add(done);
      this.waiters.set(k, set);
    });
  }

  private notify(rec: BundleAskRecordV1): void {
    const k = key(rec.hostId, rec.spawnId);
    for (const done of [...(this.waiters.get(k) ?? [])]) done();
    this.waiters.delete(k);
  }

  private save(): void {
    try {
      this.write(this.filePath, { v: 1, asks: [...this.records.values()] });
      this.harden(this.filePath);
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] ${ASKS_FILE} not written: ${errMsg(err)}`);
    }
  }
}

const REPO_KEY_RE = /^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+){1,21}$/;

function coerceRecord(raw: unknown): BundleAskRecordV1 | null {
  if (!isPlainObject(raw) || raw['v'] !== 1) return null;
  const { hostId, spawnId, askId, origin, phase, step, manifest, reason, tries, createdAt, stagedAt } = raw;
  if (!isHostId(hostId) || !isSpawnId(spawnId) || !isBundleAskId(askId) || typeof origin !== 'string' || !REPO_KEY_RE.test(origin)) return null;
  if (!(['making', 'made', 'staged', 'refused'] as unknown[]).includes(phase) || !(['make', 'pull', 'send'] as unknown[]).includes(step)) return null;
  if (typeof tries !== 'number' || !Number.isInteger(tries) || tries < 0 || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  const m = isPlainObject(manifest) && isBundleId(manifest['bundleId']) && typeof manifest['sha256'] === 'string' && A2A_SHA256_RE.test(manifest['sha256'])
    && typeof manifest['bytes'] === 'number' && Number.isInteger(manifest['bytes']) && manifest['bytes'] > 0
    ? { bundleId: manifest['bundleId'], sha256: manifest['sha256'], bytes: manifest['bytes'] }
    : undefined;
  if ((phase === 'made' || phase === 'staged') && !m) return null;
  if (phase === 'refused' && !isBundleBringBackRefusal(reason)) return null;
  return {
    v: 1, hostId, spawnId, askId, origin, phase: phase as Phase, step: step as Step, tries, createdAt,
    ...(phase === 'staged' && typeof stagedAt === 'number' && Number.isFinite(stagedAt) ? { stagedAt } : {}),
    ...(m ? { manifest: m } : {}),
    ...(phase === 'refused' ? { reason: reason as BundleBringBackRefusal } : {}),
    ...(raw['shown'] === true ? { shown: true as const } : {}),
  };
}

/** The daemon RPCs main calls (shared/a2aBundleAsk.ts A2A_BUNDLE_ASK_RPC). */
export function registerBundleAskRpc(
  onRpc: (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => void,
  asker: BundleAsker,
): void {
  onRpc(A2A_BUNDLE_ASK_RPC.bringBack, async (p) => {
    const { hostId, spawnId, origin, waitMs } = p;
    if (!isHostId(hostId) || !isSpawnId(spawnId) || typeof origin !== 'string' || !REPO_KEY_RE.test(origin) || (waitMs !== undefined && typeof waitMs !== 'number')) {
      return { ok: false, error: 'bad-request', message: 'hostId, spawnId (sp-<uuid>) and origin (a repository key) are required' };
    }
    return { ok: true, ...(await asker.bringBack(hostId, spawnId, origin, typeof waitMs === 'number' && waitMs > 0 ? waitMs : 0)) };
  });
  onRpc(A2A_BUNDLE_ASK_RPC.release, async (p) => {
    const { hostId, spawnId } = p;
    if (!isHostId(hostId) || !isSpawnId(spawnId)) return { ok: false, error: 'bad-request', message: 'hostId and spawnId are required' };
    await asker.release(hostId, spawnId);
    return { ok: true };
  });
}
