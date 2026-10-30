import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import zlib from 'node:zlib';
import { A2A_ROUTES, A2A_SHA256_RE, isHostId, type HostId } from '../../shared/a2aRemote';
import { isContinueId, type A2aContinueManifestV1 } from '../../shared/a2aContinue';
import type { ContinuePolicyStore } from './continuePolicyStore';
import type { ContinueBytesIntake, ContinueStepResult } from './continueReceiver';
import type { ContinueRequestRecordV1, ContinueRequestStore } from './continueRequestStore';
import {
  ContinueStagingRefusal,
  continueParentsInside,
  continuePartsDir,
  continueStagedFile,
  continueStagedTranscript,
  continueStagingDir,
  continueStagingHostDir,
  continueStagingRoot,
  makeContinueStagingDir,
  removeContinueStagingDir,
} from './continueStaging';
import { PinnedClientError } from './pinnedClient';
import type { A2aRouteContext, A2aRouteTable } from './routes';
import { continueTransferBudgetMs, continueWireMax, extendBodyDeadline, sendJson } from './server';
import type { StreamedGet } from './session';
import { errMsg } from './storeFile';

/**
 * The bytes of a conversation another PC continues here (this PC is B; see
 * `shared/a2aContinue.ts`), from the moment its manifest is taken
 * (`receiving`) until every file is in staging, checked (`received`). The
 * joiner dials, so they come either way:
 *
 *   B is the server (A joined B): A uploads each file.
 *     PUT  /api/a2a/continue/:continueId/:sha256 — one file, its body raw or
 *          gzipped (Content-Encoding identity or gzip, else 415).
 *     HEAD /api/a2a/continue/:continueId/:sha256 — 200 while the request
 *          receives and that file is staged already (A skips it after a
 *          reconnect), else 404. Once the last file lands the request is
 *          `received` and every HEAD is 404: A hears that from its
 *          `continue-result`, not here.
 *     Both answer only the PC whose request it is (its authenticated id,
 *     never a field it sent), for a request that is `receiving`, about a
 *     hash of its manifest (for a PUT, one not staged yet). Anything else is
 *     404; a PUT's is answered before any byte of its body is read, and its
 *     connection is closed. While the continue policy is off neither route
 *     exists.
 *   B is the joiner (B joined A): B pulls each file with a GET from A
 *     (`Accept-Encoding: gzip`) through its joiner session.
 *
 * Each file streams through a count of its bytes on the wire, an optional
 * gunzip, and a count and hash of what it inflates to, into a part file made
 * with O_EXCL: never more than its manifest entry's size (nor, on the wire,
 * than continueWireMax of it), and once it ends it must be exactly that size
 * with that hash. Only then is it renamed to its staged path. Entries that
 * share a hash take one transfer and copies; empty files are made without
 * any. When every entry is staged, `received` is called once.
 *
 * One transfer per PC and TRANSFERS_MAX in all (else 429), each within its
 * size's budget (continueTransferBudgetMs); one past it is cut. A transfer
 * that breaks (a reset, a cut, this disk) loses its part file and is tried
 * again (A uploads again, or B pulls again) until the request expires. A
 * failed check (a size or hash that is not the entry's, a link in staging)
 * fails the request (`receiveFailed`) and its staging goes. Every decision
 * removes the request's staging dir; after a restart, dirs of requests that
 * no longer hold bytes go, and a receiving one keeps only the staged files
 * that still check out.
 */

/** Transfers at once, uploads and pulls together: at most one per PC. */
const TRANSFERS_MAX = 2;
/** How long a pull waits before it tries again: at first, and at most. */
const PULL_RETRY_MIN_MS = 1_000;
const PULL_RETRY_MAX_MS = 60_000;
/** How long a `received` the receiver could not store waits before it is told again: at first, and at most. */
const RECEIVED_RETRY_MIN_MS = 5_000;
const RECEIVED_RETRY_MAX_MS = 5 * 60_000;
/** The hash of no bytes: the only one an empty file has. */
const EMPTY_SHA256 = crypto.createHash('sha256').digest('hex');
/** The states whose staging dir holds their bytes. */
const HOLDS_BYTES: ReadonlySet<string> = new Set(['receiving', 'received', 'starting']);
const NOT_FOUND = { ok: false, error: 'bad-request', message: 'not found' };

type WireEncoding = 'identity' | 'gzip';

/** How one transfer ended. */
type Outcome =
  | { kind: 'staged' }
  /** A check failed: the request fails. */
  | { kind: 'fatal'; why: string }
  /** It broke on the way (a reset, a cut, this disk): tried again. */
  | { kind: 'again'; why: string };

interface Want {
  bytes: number;
  /** The staged paths these bytes fill: the transcript and every file with this hash. */
  targets: string[];
}

interface Intake {
  hostId: HostId;
  continueId: string;
  dir: string;
  /** Hashes still to stage. */
  missing: Map<string, Want>;
  /** Hashes staged: every path they fill holds them, checked. */
  staged: Set<string>;
  /** Aborted once the request is decided or its PC removed: its transfers and its pull end. */
  abort: AbortController;
  /** The staging dir is made and what a run before this one left is checked; false when that failed the request. */
  ready: Promise<boolean>;
  /** `received` or `receiveFailed` was called: nothing more is taken. */
  over: boolean;
  /** Transfers in flight: the staging dir goes only once they have ended. */
  work: Set<Promise<Outcome>>;
  /** The next try to tell the receiver every file is in, while the last one was not stored. */
  tellAgain?: ReturnType<typeof setTimeout>;
}

export interface ContinueBundleDeps {
  /** `<wmux dir>/a2a`: staging is its `continue-in/`. */
  a2aDir: string;
  requests: Pick<ContinueRequestStore, 'get' | 'inState'>;
  /** The routes exist only while this PC takes conversations. */
  policy: Pick<ContinuePolicyStore, 'get'>;
  /** The receiver's own calls (A2aContinueReceiver.received / receiveFailed). */
  received: (hostId: HostId, continueId: string) => ContinueStepResult;
  receiveFailed: (hostId: HostId, continueId: string) => ContinueStepResult;
  /** A streamed GET from `hostId`, when this PC joined it (it then pulls); null when that PC joined this one (it uploads). */
  fetchFrom: (hostId: HostId) => StreamedGet | null;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Test seams. */
  transferBudgetMs?: (bytes: number) => number;
  pullRetry?: { minMs: number; maxMs: number };
  receivedRetry?: { minMs: number; maxMs: number };
}

const key = (hostId: HostId, continueId: string): string => `${hostId}:${continueId}`;

export class ContinueBundle implements ContinueBytesIntake {
  private readonly deps: ContinueBundleDeps;
  private readonly budget: (bytes: number) => number;
  private readonly retry: { minMs: number; maxMs: number };
  private readonly receivedRetry: { minMs: number; maxMs: number };
  private readonly intakes = new Map<string, Intake>();
  private readonly slots = transferSlots(TRANSFERS_MAX);
  /** Work started here and not settled yet (idle). */
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(deps: ContinueBundleDeps) {
    this.deps = deps;
    this.budget = deps.transferBudgetMs ?? continueTransferBudgetMs;
    this.retry = deps.pullRetry ?? { minMs: PULL_RETRY_MIN_MS, maxMs: PULL_RETRY_MAX_MS };
    this.receivedRetry = deps.receivedRetry ?? { minMs: RECEIVED_RETRY_MIN_MS, maxMs: RECEIVED_RETRY_MAX_MS };
  }

  registerRoutes(table: A2aRouteTable): void {
    const pattern = `${A2A_ROUTES.continue}/:continueId/:sha256`;
    // Off, these are paths never registered: a PC learns nothing of a feature switched off.
    const on = (): boolean => this.deps.policy.get().in.enabled;
    table.add('HEAD', pattern, (ctx) => this.head(ctx), { when: on });
    table.add('PUT', pattern, (ctx) => this.put(ctx), { when: on });
  }

  /** The request's manifest was taken: make its staging, then pull its files from a PC this one joined, or wait for their upload. */
  receiving(rec: ContinueRequestRecordV1): void {
    const k = key(rec.hostId, rec.request.continueId);
    if (this.stopped || !rec.manifest || this.intakes.has(k)) return;
    const intake: Intake = {
      hostId: rec.hostId,
      continueId: rec.request.continueId,
      dir: continueStagingDir(this.deps.a2aDir, rec.hostId, rec.request.continueId),
      missing: new Map(),
      staged: new Set(),
      abort: new AbortController(),
      ready: Promise.resolve(false),
      over: false,
      work: new Set(),
    };
    this.intakes.set(k, intake);
    intake.ready = this.track(this.prepare(intake, rec.manifest, rec.request.sessionId));
    void this.track(intake.ready.then(async (ok) => {
      if (!ok || !this.live(intake)) return;
      if (intake.missing.size === 0) await this.complete(intake);
      else await this.pull(intake);
    }));
  }

  /** The request was decided: its transfers end and its staging dir goes (on `started`, the start emptied it already). */
  decided(hostId: HostId, continueId: string): void {
    const k = key(hostId, continueId);
    const intake = this.intakes.get(k);
    this.intakes.delete(k);
    if (intake) this.end(intake);
    void this.track(this.removeAfter(intake ? [intake] : [], () => removeContinueStagingDir(this.deps.a2aDir, hostId, continueId), `continue ${continueId} from ${hostId}`));
  }

  /** A paired PC was removed: its transfers end and all its staging goes. */
  forgetHost(hostId: HostId): void {
    if (!isHostId(hostId)) return;
    const gone = [...this.intakes.values()].filter((i) => i.hostId === hostId);
    for (const intake of gone) {
      this.end(intake);
      this.intakes.delete(key(intake.hostId, intake.continueId));
    }
    const dir = continueStagingHostDir(this.deps.a2aDir, hostId);
    void this.track(this.removeAfter(gone, () => fs.promises.rm(dir, { recursive: true, force: true }), `the continue staging of ${hostId}`));
  }

  /**
   * After a restart: a staging dir whose request is gone, or holds no bytes
   * any more (decided, or never past `ready`), goes; each receiving request
   * starts again from what it kept (receiving checks what is there).
   */
  recover(): void {
    void this.track(this.recoverNow());
  }

  /** Every transfer ends (the daemon stops). */
  stop(): void {
    this.stopped = true;
    for (const intake of this.intakes.values()) this.end(intake);
  }

  /** Settle every transfer, pull and removal in flight (tests). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      // eslint-disable-next-line no-await-in-loop -- work settling may start more
      await Promise.allSettled([...this.pending]);
    }
  }

  // --- routes ---------------------------------------------------------------

  /**
   * A HEAD has no body to leave unread: its connection stays for the next
   * file A asks about (its length of 0 lets a client tell the answer ended).
   */
  private async head({ res, params, peer }: A2aRouteContext): Promise<void> {
    const sha = params['sha256'] ?? '';
    const intake = await this.authorized(peer.hostId, params['continueId'] ?? '', sha);
    res.writeHead(intake?.staged.has(sha) ? 200 : 404, { 'Cache-Control': 'no-store', 'Content-Length': 0 });
    res.end();
  }

  private async put({ req, res, params, peer }: A2aRouteContext): Promise<void> {
    const sha = params['sha256'] ?? '';
    const intake = await this.authorized(peer.hostId, params['continueId'] ?? '', sha);
    const want = intake?.missing.get(sha);
    if (!intake || !want) return answerAndClose(req, res, 404, NOT_FOUND);
    const encoding = wireEncoding(req.headers['content-encoding']);
    if (!encoding) return answerAndClose(req, res, 415, { ok: false, error: 'bad-request', message: 'identity or gzip only' });
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > continueWireMax(want.bytes, encoding)) {
      await this.settle(intake, sha, { kind: 'fatal', why: 'its declared length is past its entry' });
      return answerAndClose(req, res, 413, { ok: false, error: 'too-large' });
    }
    const release = this.slots.take(peer.hostId);
    if (!release) return answerAndClose(req, res, 429, { ok: false, error: 'unavailable' });
    // Before any wait: a client gone mid-request still gives the slot back.
    res.once('close', release);
    try {
      // Its own budget, not the listener's 30 s: a file of megabytes takes longer.
      extendBodyDeadline(req, this.budget(want.bytes));
      const outcome = await this.transfer(intake, sha, want, req, encoding);
      await this.settle(intake, sha, outcome);
      if (outcome.kind === 'staged') return sendJson(res, 200, { ok: true });
      // The body may be read only in part: never drained.
      if (outcome.kind === 'fatal') return answerAndClose(req, res, 400, { ok: false, error: 'bad-request' });
      return answerAndClose(req, res, 503, { ok: false, error: 'unavailable' });
    } finally {
      release();
    }
  }

  /**
   * The intake a peer's request is about: that PC's own request (by its
   * authenticated id), receiving, its bytes not failed, and `sha` a hash of
   * its manifest. Null otherwise.
   */
  private async authorized(hostId: HostId, continueId: string, sha: string): Promise<Intake | null> {
    if (!isContinueId(continueId) || !A2A_SHA256_RE.test(sha)) return null;
    const rec = this.deps.requests.get(hostId, continueId);
    if (!rec || rec.state !== 'receiving' || !rec.manifest) return null;
    // Opened when its manifest was taken; this only opens one whose hook never came.
    this.receiving(rec);
    const intake = this.intakes.get(key(hostId, continueId));
    if (!intake || !(await intake.ready) || !this.live(intake)) return null;
    return intake.missing.has(sha) || intake.staged.has(sha) ? intake : null;
  }

  // --- pull -----------------------------------------------------------------

  /** Pull every missing file from the PC this one joined, one at a time and again after a failed try, until all are in or the request ends. */
  private async pull(intake: Intake): Promise<void> {
    let wait = this.retry.minMs;
    while (this.live(intake)) {
      const next = intake.missing.entries().next();
      if (next.done) return;
      const [sha, want] = next.value;
      const get = this.deps.fetchFrom(intake.hostId);
      // Not joined to that PC (any more): it uploads instead.
      if (!get) return;
      const release = this.slots.take(intake.hostId);
      // eslint-disable-next-line no-await-in-loop -- one file at a time from one PC
      const outcome = release ? await this.pullOne(intake, sha, want, get).finally(release) : null;
      if (outcome?.kind === 'staged') {
        wait = this.retry.minMs;
        continue;
      }
      if (!this.live(intake)) return;
      // eslint-disable-next-line no-await-in-loop -- waits out a busy slot or a failed try
      await sleep(wait, undefined, { signal: intake.abort.signal }).catch(() => undefined);
      wait = Math.min(wait * 2, this.retry.maxMs);
    }
  }

  private async pullOne(intake: Intake, sha: string, want: Want, get: StreamedGet): Promise<Outcome> {
    let outcome: Outcome;
    try {
      outcome = await get(
        `${A2A_ROUTES.continue}/${intake.continueId}/${sha}`,
        { timeoutMs: this.budget(want.bytes), signal: intake.abort.signal, acceptEncoding: 'gzip' },
        async ({ headers, body }): Promise<Outcome> => {
          const encoding = wireEncoding(headers['content-encoding']);
          const declared = headers['content-length'];
          if (!encoding || (declared !== undefined && Number(declared) > continueWireMax(want.bytes, encoding))) {
            body.destroy();
            return { kind: 'fatal', why: encoding ? 'its declared length is past its entry' : 'sent in an encoding other than identity or gzip' };
          }
          return this.transfer(intake, sha, want, body, encoding);
        },
      );
    } catch (err) {
      // Refused before any byte: for good when that PC no longer holds the file (404) or will not give it.
      const status = err instanceof PinnedClientError && err.code === 'http' ? err.status : undefined;
      outcome = status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429
        ? { kind: 'fatal', why: `the other PC answered HTTP ${status}` }
        : { kind: 'again', why: err instanceof PinnedClientError ? err.code : errMsg(err) };
    }
    await this.settle(intake, sha, outcome);
    return outcome;
  }

  // --- transfer -------------------------------------------------------------

  /** One file's bytes from `source` into every staged path its hash fills, within its size's budget. */
  private transfer(intake: Intake, sha: string, want: Want, source: Readable, encoding: WireEncoding): Promise<Outcome> {
    const run = (async (): Promise<Outcome> => {
      // Decided while its request was on its way here: nothing is written.
      if (!this.live(intake)) return { kind: 'again', why: 'the request ended' };
      const cut = new AbortController();
      const timer = setTimeout(() => cut.abort(), this.budget(want.bytes));
      const onEnd = (): void => cut.abort();
      intake.abort.signal.addEventListener('abort', onEnd, { once: true });
      const part = path.join(continuePartsDir(intake.dir), sha);
      try {
        const written = await writePart(source, encoding, sha, want.bytes, part, cut.signal);
        if (written.kind !== 'staged') return written;
        if (!this.live(intake)) {
          await fs.promises.rm(part, { force: true });
          return { kind: 'again', why: 'the request ended' };
        }
        const [first, ...rest] = want.targets;
        await placePart(intake.dir, part, first);
        for (const target of rest) {
          // eslint-disable-next-line no-await-in-loop -- one copy at a time
          await copyInto(intake.dir, part, first, target);
        }
        return { kind: 'staged' };
      } catch (err) {
        return err instanceof ContinueStagingRefusal ? { kind: 'fatal', why: err.message } : { kind: 'again', why: errMsg(err) };
      } finally {
        clearTimeout(timer);
        intake.abort.signal.removeEventListener('abort', onEnd);
      }
    })();
    intake.work.add(run);
    void run.finally(() => intake.work.delete(run));
    return run;
  }

  /** Take what one transfer came to: a staged hash (and, with the last, `received`), the request failed, or a try to make again. */
  private async settle(intake: Intake, sha: string, outcome: Outcome): Promise<void> {
    if (intake.over) return;
    const what = `continue ${intake.continueId} from ${intake.hostId}`;
    if (outcome.kind === 'fatal') return this.fail(intake, `${sha.slice(0, 12)}: ${outcome.why}`);
    if (outcome.kind === 'again') {
      this.deps.log('info', `[a2a-remote] ${what}: ${sha.slice(0, 12)} did not arrive, to be tried again: ${outcome.why}`);
      return;
    }
    intake.missing.delete(sha);
    intake.staged.add(sha);
    if (intake.missing.size === 0) await this.complete(intake);
  }

  /** Every file is staged and checked: only the layout is left in the dir, and the receiver hears it once. */
  private async complete(intake: Intake): Promise<void> {
    if (intake.over) return;
    intake.over = true;
    await fs.promises.rm(continuePartsDir(intake.dir), { recursive: true, force: true }).catch(() => undefined);
    this.tellReceived(intake, 0);
  }

  /**
   * Tell the receiver every file is in. A step it could not store (a failed
   * write) is told again with a backoff, until it is stored, the request
   * leaves `receiving` (expired, say), or the request ends here.
   */
  private tellReceived(intake: Intake, attempt: number): void {
    intake.tellAgain = undefined;
    const what = `continue ${intake.continueId} from ${intake.hostId}`;
    const receiving = (): boolean => this.deps.requests.get(intake.hostId, intake.continueId)?.state === 'receiving';
    if (intake.abort.signal.aborted || this.stopped || !receiving()) return;
    const res = this.deps.received(intake.hostId, intake.continueId);
    if (res.ok) return;
    if (!receiving()) {
      this.deps.log('warn', `[a2a-remote] ${what}: every file is staged, yet ${res.error}`);
      return;
    }
    const delay = Math.min(this.receivedRetry.minMs * 2 ** attempt, this.receivedRetry.maxMs);
    this.deps.log('warn', `[a2a-remote] ${what}: every file is staged, yet ${res.error}; told again in ${Math.round(delay / 1000)} s`);
    intake.tellAgain = setTimeout(() => this.tellReceived(intake, attempt + 1), delay);
    intake.tellAgain.unref?.();
  }

  /** The request ends here: its transfers and its pull stop, and nothing more is told. */
  private end(intake: Intake): void {
    intake.abort.abort();
    if (intake.tellAgain) clearTimeout(intake.tellAgain);
    intake.tellAgain = undefined;
  }

  /** A check failed: the request fails, and its staging goes. */
  private fail(intake: Intake, why: string): void {
    if (intake.over) return;
    intake.over = true;
    intake.abort.abort();
    const what = `continue ${intake.continueId} from ${intake.hostId}`;
    this.deps.log('warn', `[a2a-remote] ${what}: its bytes failed their checks (${why})`);
    const res = this.deps.receiveFailed(intake.hostId, intake.continueId);
    if (!res.ok) this.deps.log('warn', `[a2a-remote] ${what}: not failed: ${res.error}`);
    void this.track(this.removeAfter([intake], () => removeContinueStagingDir(this.deps.a2aDir, intake.hostId, intake.continueId), what));
  }

  // --- staging --------------------------------------------------------------

  /**
   * Make the request's staging dir and check what a run before this one left
   * there: part files go, and a staged file stays only while its bytes still
   * check out. Empty files are made here, without a transfer. A link in the
   * way, a manifest that cannot be what it says (an empty file of another
   * hash, one hash at two sizes), or a dir that cannot be made fails the
   * request.
   */
  private async prepare(intake: Intake, manifest: A2aContinueManifestV1, sessionId: string): Promise<boolean> {
    try {
      const wants = wantsOf(manifest, intake.dir, sessionId);
      await makeContinueStagingDir(this.deps.a2aDir, intake.hostId, intake.continueId);
      for (const [sha, want] of wants) {
        if (!this.live(intake)) return false;
        // eslint-disable-next-line no-await-in-loop -- one file at a time
        if (await keepOrFill(intake.dir, sha, want)) intake.staged.add(sha);
        else intake.missing.set(sha, want);
      }
      return this.live(intake);
    } catch (err) {
      if (!this.live(intake)) return false;
      this.fail(intake, err instanceof ContinueStagingRefusal ? err.message : `its staging could not be made: ${errMsg(err)}`);
      return false;
    }
  }

  private async recoverNow(): Promise<void> {
    const root = continueStagingRoot(this.deps.a2aDir);
    // A link (or a file) where `continue-in` goes is removed itself, never walked: staging only ever made a plain folder there.
    const top = await fs.promises.lstat(root).catch(() => null);
    const plainRoot = top !== null && top.isDirectory() && !top.isSymbolicLink();
    if (top && !plainRoot) {
      await fs.promises.unlink(root).catch((err: unknown) => this.deps.log('warn', `[a2a-remote] continue staging: ${root} is not a plain folder and was not removed: ${errMsg(err)}`));
    }
    for (const host of plainRoot ? await namesIn(root) : []) {
      const hostDir = path.join(root, host);
      // eslint-disable-next-line no-await-in-loop -- one PC's staging at a time
      const plain = isHostId(host) && (await isPlainDir(hostDir));
      // eslint-disable-next-line no-await-in-loop -- one PC's staging at a time
      for (const id of plain ? await namesIn(hostDir) : []) {
        const rec = isContinueId(id) ? this.deps.requests.get(host, id) : undefined;
        // eslint-disable-next-line no-await-in-loop -- one request's staging at a time
        if (!rec || !HOLDS_BYTES.has(rec.state)) await this.removeQuietly(path.join(hostDir, id));
      }
      // eslint-disable-next-line no-await-in-loop -- one PC's staging at a time
      if (!plain) await this.removeQuietly(hostDir);
    }
    for (const rec of this.deps.requests.inState('receiving')) this.receiving(rec);
  }

  /** Run `remove` once `intakes` have nothing in flight; a failure is logged. */
  private async removeAfter(intakes: Intake[], remove: () => Promise<void>, what: string): Promise<void> {
    await Promise.allSettled(intakes.flatMap((i) => [i.ready, ...i.work]));
    try {
      await remove();
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] ${what}: staging not removed: ${errMsg(err)}`);
    }
  }

  private async removeQuietly(p: string): Promise<void> {
    await this.removeAfter([], () => fs.promises.rm(p, { recursive: true, force: true }), `continue staging ${path.basename(p)}`);
  }

  private live(intake: Intake): boolean {
    return !intake.over && !intake.abort.signal.aborted && !this.stopped;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
    return work;
  }
}

/** One transfer per PC and `max` in all; `take` answers its release, or null when there is no room. */
function transferSlots(max: number): { take(hostId: HostId): (() => void) | null } {
  const perPeer = new Set<HostId>();
  return {
    take(hostId) {
      if (perPeer.has(hostId) || perPeer.size >= max) return null;
      perPeer.add(hostId);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        perPeer.delete(hostId);
      };
    },
  };
}

/** A body's Content-Encoding, when it is one taken here (identity or gzip). */
function wireEncoding(header: string | string[] | undefined): WireEncoding | null {
  if (header === undefined) return 'identity';
  if (typeof header !== 'string') return null;
  const value = header.trim().toLowerCase();
  if (value === '' || value === 'identity') return 'identity';
  return value === 'gzip' ? 'gzip' : null;
}

/**
 * What each hash of a manifest fills: its size and its staged paths. Refused
 * when the manifest cannot be what it says: one hash at two sizes, or a
 * file's size and hash that disagree on whether it is empty.
 */
function wantsOf(manifest: A2aContinueManifestV1, dir: string, sessionId: string): Map<string, Want> {
  const wants = new Map<string, Want>();
  const add = (sha: string, bytes: number, target: string): void => {
    if ((bytes === 0) !== (sha === EMPTY_SHA256)) throw new ContinueStagingRefusal('an entry whose size and hash disagree on whether it is empty');
    const want = wants.get(sha);
    if (want && want.bytes !== bytes) throw new ContinueStagingRefusal('one hash at two sizes');
    if (want) want.targets.push(target);
    else wants.set(sha, { bytes, targets: [target] });
  };
  add(manifest.transcript.sha256, manifest.transcript.bytes, continueStagedTranscript(dir, sessionId));
  for (const f of manifest.files) add(f.sha256, f.bytes, continueStagedFile(dir, sessionId, f.rel));
  return wants;
}

/**
 * Stream a body into a new part file: counted on the wire (at most
 * continueWireMax of `bytes`), gunzipped when gzip, counted and hashed as it
 * inflates (at most `bytes`), then exactly `bytes` with hash `sha`. The part
 * file goes on anything but `staged`.
 */
async function writePart(source: Readable, encoding: WireEncoding, sha: string, bytes: number, part: string, signal: AbortSignal): Promise<Outcome> {
  const wireMax = continueWireMax(bytes, encoding);
  const hash = crypto.createHash('sha256');
  let wire = 0;
  let size = 0;
  let refused: string | null = null;
  const onWire = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      wire += chunk.length;
      if (wire > wireMax) {
        refused = 'more bytes on the wire than its entry allows';
        return done(new Error(refused));
      }
      done(null, chunk);
    },
  });
  const inflated = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > bytes) {
        refused = 'larger than its entry';
        return done(new Error(refused));
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  const out = fs.createWriteStream(part, { flags: 'wx', mode: 0o600 });
  try {
    await pipeline(encoding === 'gzip' ? [source, onWire, zlib.createGunzip(), inflated, out] : [source, onWire, inflated, out], { signal });
  } catch (err) {
    await fs.promises.rm(part, { force: true }).catch(() => undefined);
    if (refused) return { kind: 'fatal', why: refused };
    if (signal.aborted) return { kind: 'again', why: 'cut: past its budget, or the request ended' };
    // A body that arrived whole yet does not inflate (the first error is the inflater's: a cut body fails first).
    if (isZlibError(err)) return { kind: 'fatal', why: 'its gzip does not inflate' };
    return { kind: 'again', why: errMsg(err) };
  }
  const digest = hash.digest('hex');
  if (size === bytes && digest === sha) return { kind: 'staged' };
  await fs.promises.rm(part, { force: true }).catch(() => undefined);
  return { kind: 'fatal', why: size !== bytes ? `${size} bytes, not its entry's ${bytes}` : 'a hash other than its entry names' };
}

function isZlibError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('Z_');
}

/** Rename a checked part file to its staged path, made through plain folders only; refused over anything but a plain file. */
async function placePart(dir: string, part: string, target: string): Promise<void> {
  try {
    await continueParentsInside(dir, target, true);
    const st = await fs.promises.lstat(target).catch(() => null);
    if (st && !st.isFile()) throw new ContinueStagingRefusal('something other than a plain file where a staged file goes');
    // On disk before it takes its name: a power cut after `received` never leaves a staged file cut short.
    await syncFile(part);
    await fs.promises.rename(part, target);
  } catch (err) {
    await fs.promises.rm(part, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Flush a written file's bytes to disk. */
async function syncFile(file: string): Promise<void> {
  const handle = await fs.promises.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Fill `target` with a copy of `from` (an empty file when null), through a part file. */
async function copyInto(dir: string, part: string, from: string | null, target: string): Promise<void> {
  if (from) await fs.promises.copyFile(from, part, fs.constants.COPYFILE_EXCL);
  else await fs.promises.writeFile(part, '', { flag: 'wx', mode: 0o600 });
  await placePart(dir, part, target);
}

/**
 * Whether `sha` is staged, from what a run before this one left: every path
 * it fills holds its bytes, copied from one that does when needed (an empty
 * file is always made). A staged file whose bytes no longer check out goes.
 */
async function keepOrFill(dir: string, sha: string, want: Want): Promise<boolean> {
  const good: string[] = [];
  for (const target of want.targets) {
    // eslint-disable-next-line no-await-in-loop -- one file at a time
    if (await stagedHolds(dir, target, sha, want.bytes)) good.push(target);
  }
  if (good.length === 0 && want.bytes > 0) return false;
  const part = path.join(continuePartsDir(dir), sha);
  for (const target of want.targets) {
    // eslint-disable-next-line no-await-in-loop -- one copy at a time
    if (!good.includes(target)) await copyInto(dir, part, good[0] ?? null, target);
  }
  return true;
}

/** `target` is a plain file reached through plain folders, holding exactly `bytes` with hash `sha`; one that does not goes. */
async function stagedHolds(dir: string, target: string, sha: string, bytes: number): Promise<boolean> {
  if (!(await continueParentsInside(dir, target, false))) return false;
  const st = await fs.promises.lstat(target).catch(() => null);
  if (!st) return false;
  if (!st.isFile()) throw new ContinueStagingRefusal('something other than a plain file where a staged file goes');
  if (st.size === bytes && (await hashOf(target)) === sha) return true;
  await fs.promises.rm(target, { force: true });
  return false;
}

async function hashOf(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function namesIn(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch {
    return [];
  }
}

async function isPlainDir(p: string): Promise<boolean> {
  const st = await fs.promises.lstat(p).catch(() => null);
  return st !== null && st.isDirectory() && !st.isSymbolicLink();
}

/** Answer without reading the rest of the body, then cut the connection. */
function answerAndClose(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
  res.setHeader('Connection', 'close');
  res.once('finish', () => req.socket?.destroy());
  sendJson(res, status, body);
}
