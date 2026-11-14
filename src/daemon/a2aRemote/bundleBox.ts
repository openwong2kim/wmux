import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteDeliverResponse, type A2aRemoteEnvelope, type HostId } from '../../shared/a2aRemote';
import {
  BUNDLE_BYTES_DEFAULT,
  BUNDLE_TTL_DEFAULT_MS,
  bundleBytesMax,
  parseBundleAsk,
  type A2aBundleAskV1,
  type A2aBundleMadeV1,
  type A2aBundleManifestV1,
  type A2aBundleRefusal,
} from '../../shared/a2aBundle';
import type { BundleOutbox } from './bundleOutbox';
import { bundleGit, makeBundle, sweepBundleRefs, type BundleGitOptions, type BundleMakeOutcome } from './bundleMaker';
import { continueParentsInside } from './continueStaging';
import type { HeadlessStartRecordV1 } from './headlessStartStore';
import { errMsg } from './storeFile';

/**
 * The box's side of bringing back an agent's work: it takes another PC's asks
 * (`bundle-ask`), makes the bundle (bundleMaker.ts), offers it to that PC
 * (bundleOutbox.ts) and answers (`bundle-made`). See shared/a2aBundle.ts.
 *
 * Only a start the asking PC made here, headless, is made from: the record
 * keyed by its authenticated id and the spawn id, never a path or a ref from
 * the ask. Only a PC that advertises `bundle.1`, while the feature is on here,
 * is answered at all; anything else is taken and dropped.
 *
 * An ask is work another PC triggers, so it is bounded (BundleBoxLimits):
 * asks per minute from each PC, one make per PC and a few in all, a few
 * offers standing per PC, and the bytes they take under
 * `<a2a dir>/bundle-out/<hostId>/`. Each bundle is a file there named by its
 * id, made 0600 in 0700 folders. An offer ends when the asking PC says it took
 * it (`done`), or at its time; its file goes with it. Offers live in memory: at
 * start every file there goes, and any ref a make left behind.
 *
 * Nothing here touches a pane or types anything.
 */

const BUNDLE_OUT = 'bundle-out';
const MINUTE_MS = 60_000;

export interface BundleBoxLimits {
  /** Asks of any kind from one PC in a minute. */
  asksPerMinute: number;
  /** Makes running at once, all PCs together (one per PC in any case). */
  makesAtOnce: number;
  /** Offers standing for one PC. */
  offersPerHost: number;
  /** Bytes one PC's standing offers may take. */
  bytesPerHost: number;
  /** The largest bundle (a2aBundle.ts bundleBytesMax). */
  bundleBytes: number;
  /** How long an offer waits for its fetch. */
  ttlMs: number;
}

export const BUNDLE_BOX_DEFAULTS: Readonly<BundleBoxLimits> = Object.freeze({
  asksPerMinute: 12,
  makesAtOnce: 2,
  offersPerHost: 4,
  bytesPerHost: 256 * 1024 * 1024,
  bundleBytes: BUNDLE_BYTES_DEFAULT,
  ttlMs: BUNDLE_TTL_DEFAULT_MS,
});

export interface BundleBoxDeps {
  a2aDir: string;
  /** The feature is on here. */
  enabled: () => boolean;
  /** That PC advertises `bundle.1`. */
  peerTakes: (hostId: HostId) => boolean;
  /** The headless start `hostId` made here with that spawn id. */
  startOf: (hostId: HostId, spawnId: string) => HeadlessStartRecordV1 | undefined;
  /** Every headless start recorded here (their worktrees are swept at start). */
  starts: () => HeadlessStartRecordV1[];
  /** A start `hostId` made here otherwise (in the app): nothing to make from yet. */
  startedInApp?: (hostId: HostId, spawnId: string) => boolean;
  outbox: Pick<BundleOutbox, 'offer' | 'withdraw' | 'send'>;
  enqueue: (hostId: HostId, envelope: A2aRemoteEnvelope) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** The limits of the moment (settings), over BUNDLE_BOX_DEFAULTS. */
  limits?: () => Partial<BundleBoxLimits>;
  /** Test seams. */
  now?: () => number;
  make?: typeof makeBundle;
  git?: BundleGitOptions;
}

interface Standing {
  spawnId: string;
  head: string;
  file: string;
  manifest: A2aBundleManifestV1;
  expiresAt: number;
}

const OK: A2aRemoteDeliverResponse = { ok: true, duplicate: false };
const BAD: A2aRemoteDeliverResponse = { ok: false, error: 'bad-request' };

export class BundleBox {
  private readonly deps: BundleBoxDeps;
  private readonly now: () => number;
  private readonly asks = new Map<HostId, number[]>();
  private readonly making = new Set<HostId>();
  private readonly offers = new Map<HostId, Map<string, Standing>>();
  /** Bumped when a PC is removed: a make for it that was under way then keeps nothing. */
  private readonly forgotten = new Map<HostId, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly boot = crypto.randomBytes(4).toString('hex');
  private sends = 0;

  constructor(deps: BundleBoxDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  private limits(): BundleBoxLimits {
    const set = this.deps.limits?.() ?? {};
    const whole = (v: unknown, d: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : d);
    return {
      asksPerMinute: whole(set.asksPerMinute, BUNDLE_BOX_DEFAULTS.asksPerMinute),
      makesAtOnce: whole(set.makesAtOnce, BUNDLE_BOX_DEFAULTS.makesAtOnce),
      offersPerHost: whole(set.offersPerHost, BUNDLE_BOX_DEFAULTS.offersPerHost),
      bytesPerHost: whole(set.bytesPerHost, BUNDLE_BOX_DEFAULTS.bytesPerHost),
      bundleBytes: bundleBytesMax(set.bundleBytes),
      ttlMs: whole(set.ttlMs, BUNDLE_BOX_DEFAULTS.ttlMs),
    };
  }

  /** At start: no offer stands, so every file under bundle-out goes, and every ref a make left in a start's repository. */
  async start(): Promise<void> {
    await fs.promises.rm(path.join(this.deps.a2aDir, BUNDLE_OUT), { recursive: true, force: true }).catch((err: unknown) => {
      this.deps.log('warn', `[a2a-remote] bundle staging not cleared: ${errMsg(err)}`);
    });
    // The refs live in the repository its worktrees share: once per repository.
    const repos = new Map<string, string>();
    for (const rec of this.deps.starts()) {
      if (!rec.worktreePath || repos.has(rec.repoPath) || !fs.existsSync(rec.worktreePath)) continue;
      repos.set(rec.repoPath, rec.worktreePath);
    }
    for (const worktree of repos.values()) {
      // eslint-disable-next-line no-await-in-loop -- one repository at a time
      const removed = await sweepBundleRefs(worktree, this.deps.git).catch(() => 0);
      if (removed > 0) this.deps.log('info', `[a2a-remote] removed ${removed} bundle ref(s) a stopped make left`);
    }
    // Offers past their time end on their own, not only when the next ask comes.
    if (!this.timer) {
      this.timer = setInterval(() => this.expire(), MINUTE_MS);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A `bundle-ask` from `peer` (inbound.ts routes it here): answered later (the make runs on its own), taken now. */
  applyInbound(env: A2aRemoteEnvelope, peer: { hostId: HostId }): A2aRemoteDeliverResponse {
    if (env.kind !== 'link' || env.link?.state !== 'bundle-ask' || env.linkVersion !== 0) return BAD;
    // Off here, or a PC that does not take it: taken and dropped, never answered.
    if (!this.deps.enabled() || !this.deps.peerTakes(peer.hostId)) return OK;
    const ask = parseBundleAsk(env.bundleAsk);
    if (!ask || ask.askId !== env.linkId) return BAD;
    const hostId = peer.hostId;
    this.expire();
    if (!this.admit(hostId)) {
      this.answer(hostId, { v: 1, askId: ask.askId, op: 'refused', reason: 'rate-limited' });
      return OK;
    }
    if (ask.op === 'make') void this.make(hostId, ask);
    else if (ask.op === 'send') void this.send(hostId, ask);
    else this.done(hostId, ask.bundleId);
    return OK;
  }

  /** One more ask from `hostId` in the last minute, or false when it has had its share. */
  private admit(hostId: HostId): boolean {
    const now = this.now();
    const recent = (this.asks.get(hostId) ?? []).filter((t) => now - t < MINUTE_MS);
    if (recent.length >= this.limits().asksPerMinute) {
      this.asks.set(hostId, recent);
      return false;
    }
    recent.push(now);
    this.asks.set(hostId, recent);
    return true;
  }

  private async make(hostId: HostId, ask: Extract<A2aBundleAskV1, { op: 'make' }>): Promise<void> {
    const refuse = (reason: A2aBundleRefusal, detail?: string): void => {
      if (detail) this.deps.log('info', `[a2a-remote] bundle for ${hostId} (${ask.spawnId}) not made (${reason}): ${detail}`);
      this.answer(hostId, { v: 1, askId: ask.askId, op: 'refused', reason });
    };
    let mine = false;
    try {
      const rec = this.deps.startOf(hostId, ask.spawnId);
      if (!rec) return refuse(this.deps.startedInApp?.(hostId, ask.spawnId) ? 'not-supported' : 'unknown-spawn');
      // A start recorded before tree ids: its ref would not be the one the asking PC computes.
      if (!rec.treeId) return refuse('not-supported', 'a start recorded before tree ids');
      if (!rec.baseCommit || !rec.branch || !rec.worktreePath) return refuse('base-missing');
      // The worktree was taken back (its start left nothing past the base): nothing to bring.
      if (!fs.existsSync(rec.worktreePath)) return refuse('empty');
      const limits = this.limits();
      if (this.making.has(hostId) || this.making.size >= limits.makesAtOnce) return refuse('busy');
      this.making.add(hostId);
      mine = true;
      const generation = this.forgotten.get(hostId) ?? 0;
      const own = this.offers.get(hostId) ?? new Map<string, Standing>();
      // The same head as an offer that stands, which the outbox still serves: that offer again, for a fresh time.
      const standing = [...own.values()].find((o) => o.spawnId === ask.spawnId);
      if (standing) {
        const tip = await bundleGit(rec.worktreePath, this.deps.git)(['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${rec.branch}^{commit}`]);
        const same = tip.code === 0 && tip.stdout.trim() === standing.head;
        const { bundleId, sha256, bytes } = standing.manifest;
        if (same && this.deps.outbox.offer({ hostId, bundleId, file: standing.file, sha256, bytes }, limits.ttlMs)) {
          standing.expiresAt = this.now() + limits.ttlMs;
          this.answer(hostId, { v: 1, askId: ask.askId, op: 'made', manifest: standing.manifest });
          return;
        }
        this.drop(hostId, standing.manifest.bundleId);
      }
      if (own.size >= limits.offersPerHost) return refuse('busy');
      const taken = [...own.values()].reduce((n, o) => n + o.manifest.bytes, 0);
      const room = Math.min(limits.bundleBytes, limits.bytesPerHost - taken);
      if (room < 1) return refuse('busy');

      const bundleId = `bd-${crypto.randomUUID()}`;
      const file = path.join(this.deps.a2aDir, BUNDLE_OUT, hostId, `${bundleId}.bundle`);
      await continueParentsInside(this.deps.a2aDir, file, true);
      const made: BundleMakeOutcome = await (this.deps.make ?? makeBundle)({
        worktree: rec.worktreePath,
        branch: rec.branch,
        base: rec.baseCommit,
        treeId: rec.treeId ?? rec.spawnId,
        origin: ask.origin,
        file,
        maxBytes: room,
      }, this.deps.git);
      // That PC was removed while the bundle was made: nothing is kept for it, and it is not answered.
      if ((this.forgotten.get(hostId) ?? 0) !== generation) {
        await fs.promises.rm(file, { force: true });
        return;
      }
      if (made.kind === 'refused') return refuse(made.reason, made.detail);
      const manifest: A2aBundleManifestV1 = { bundleId, sha256: made.sha256, bytes: made.bytes };
      if (!this.deps.outbox.offer({ hostId, bundleId, file, sha256: made.sha256, bytes: made.bytes }, limits.ttlMs)) {
        await fs.promises.rm(file, { force: true });
        return refuse('unavailable', 'the offer was not taken');
      }
      own.set(bundleId, { spawnId: ask.spawnId, head: made.head, file, manifest, expiresAt: this.now() + limits.ttlMs });
      this.offers.set(hostId, own);
      this.answer(hostId, { v: 1, askId: ask.askId, op: 'made', manifest });
    } catch (err) {
      refuse('unavailable', errMsg(err));
    } finally {
      if (mine) this.making.delete(hostId);
    }
  }

  /** The asking PC waits for it now: put it there (when this PC joined it; else it fetches). */
  private async send(hostId: HostId, ask: { askId: string; bundleId: string }): Promise<void> {
    if (!this.offers.get(hostId)?.has(ask.bundleId)) {
      this.answer(hostId, { v: 1, askId: ask.askId, op: 'refused', reason: 'gone' });
      return;
    }
    const sent = await this.deps.outbox.send(hostId, ask.bundleId);
    if (sent.kind === 'sent') return;
    const reason: A2aBundleRefusal = sent.kind === 'again' ? 'again' : sent.kind === 'busy' ? 'busy' : 'unavailable';
    if (sent.kind !== 'busy' && sent.kind !== 'again') this.deps.log('info', `[a2a-remote] bundle ${ask.bundleId} for ${hostId} not sent: ${sent.kind}${'why' in sent ? ` (${sent.why})` : ''}`);
    this.answer(hostId, { v: 1, askId: ask.askId, op: 'refused', reason });
  }

  /** The asking PC took it: the offer ends and the file goes. */
  private done(hostId: HostId, bundleId: string): void {
    this.drop(hostId, bundleId);
  }

  private drop(hostId: HostId, bundleId: string): void {
    const own = this.offers.get(hostId);
    const o = own?.get(bundleId);
    this.deps.outbox.withdraw(hostId, bundleId);
    if (!own || !o) return;
    own.delete(bundleId);
    if (own.size === 0) this.offers.delete(hostId);
    void fs.promises.rm(o.file, { force: true }).catch(() => undefined);
  }

  /** Offers past their time end, and their files go. */
  private expire(): void {
    const now = this.now();
    for (const [hostId, own] of this.offers) {
      for (const [bundleId, o] of own) if (now >= o.expiresAt) this.drop(hostId, bundleId);
    }
  }

  /** A paired PC was removed: its offers end, and their files go. */
  forgetHost(hostId: HostId): void {
    for (const bundleId of [...(this.offers.get(hostId)?.keys() ?? [])]) this.drop(hostId, bundleId);
    this.asks.delete(hostId);
    this.forgotten.set(hostId, (this.forgotten.get(hostId) ?? 0) + 1);
  }

  /** Test/diagnostic view: offers standing for `hostId`. */
  standing(hostId: HostId): A2aBundleManifestV1[] {
    return [...(this.offers.get(hostId)?.values() ?? [])].map((o) => o.manifest);
  }

  private answer(hostId: HostId, made: A2aBundleMadeV1): void {
    try {
      this.deps.enqueue(hostId, {
        protocol: A2A_REMOTE_PROTOCOL,
        linkId: made.askId,
        linkVersion: 0,
        messageId: `bm_${made.askId}_${this.boot}-${this.sends++}`,
        kind: 'link',
        link: { state: 'bundle-made', version: 0 },
        bundleMade: made,
        sentAt: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] bundle answer ${made.askId} to ${hostId} not queued: ${errMsg(err)}`);
    }
  }
}
