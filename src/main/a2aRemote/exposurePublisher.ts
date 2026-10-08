import type { A2aLinkRecordV1 } from '../../shared/a2aRemote';
import type {
  A2aExposureCandidate,
  A2aRemoteLinksListResult,
  A2aRemoteExposureListResult,
  A2aRemotePaneGoneParams,
  A2aRemotePaneSnapshot,
} from '../../shared/rpc';

/**
 * Main's half of cross-host exposure. The renderer sends its whole pane tree
 * (`A2aRemotePaneSnapshot`) whenever it changes; this:
 *
 *   1. diffs it against the previous one and tells the daemon which panes or
 *      workspaces went away (a pane under another workspace = moved), so the
 *      daemon breaks the links bound to them and drops them from exposure —
 *      for EVERY pane, not only exposed ones: a joiner's linked pane is never
 *      exposed to anyone;
 *   2. publishes the panes of the workspaces exposed to any paired PC, with
 *      their git remote key, plus this PC's Moa when some PC may see it, as
 *      the daemon's exposure snapshot. Nothing is published while nothing is
 *      exposed. Moa turning off (or its HQ going) withdraws it and breaks its
 *      links (`endpoint: 'brain'`).
 *
 * Gone notices are queued and retried until the daemon takes them, and every
 * publish also checks the daemon's live links against the current tree, so a
 * notice lost while the daemon was away is recomputed (the link list is the
 * truth). The renderer sends nothing before its session is restored.
 */

export interface ExposurePublisherClient {
  a2aRemoteExposureList(): Promise<A2aRemoteExposureListResult>;
  a2aRemoteExposurePublish(panes: A2aExposureCandidate[]): Promise<unknown>;
  a2aRemotePaneGone(params: A2aRemotePaneGoneParams): Promise<unknown>;
  a2aRemoteLinksList(): Promise<A2aRemoteLinksListResult>;
}

/** How long Moa may be "not known right now" before it counts as gone. */
export const A2A_BRAIN_GRACE_MS = 30_000;
/** Retry delay for gone notices the daemon did not take. */
export const A2A_GONE_RETRY_MS = 15_000;

export interface ExposurePublisherDeps {
  /** The live daemon client, or null while disconnected. */
  client: () => ExposurePublisherClient | null;
  /** The cwd's origin as `host/owner/repo` (detectRemote's key), or null. */
  repoKey: (cwd: string) => Promise<string | null>;
  log: (msg: string) => void;
  /** Test seams. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
}

const goneKey = (g: A2aRemotePaneGoneParams): string => [g.endpoint ?? '', g.reason, g.workspaceId, g.paneId ?? ''].join('\0');

/** What went away between two snapshots. A workspace that is gone covers its panes. */
export function diffGonePanes(prev: A2aRemotePaneSnapshot, next: A2aRemotePaneSnapshot): A2aRemotePaneGoneParams[] {
  const nextWs = new Set(next.workspaces.map((w) => w.id));
  const nextPaneWs = new Map<string, string>();
  for (const w of next.workspaces) for (const p of w.panes) nextPaneWs.set(p.paneId, w.id);
  const gone: A2aRemotePaneGoneParams[] = [];
  for (const w of prev.workspaces) {
    if (!nextWs.has(w.id)) {
      gone.push({ workspaceId: w.id, reason: 'workspace-gone' });
      continue;
    }
    for (const p of w.panes) {
      const now = nextPaneWs.get(p.paneId);
      if (now === undefined) gone.push({ workspaceId: w.id, paneId: p.paneId, reason: 'pane-closed' });
      else if (now !== w.id) gone.push({ workspaceId: w.id, paneId: p.paneId, reason: 'pane-moved' });
    }
  }
  // This PC's Moa went away (turned off, or its HQ is gone or replaced).
  if (prev.brain && prev.brain.workspaceId !== next.brain?.workspaceId) {
    gone.push({ workspaceId: prev.brain.workspaceId, reason: 'workspace-gone', endpoint: 'brain' });
  }
  return gone;
}

/**
 * The gone notices the daemon's live links still need, judged against the
 * current tree: the link list is the truth, so a notice lost while the daemon
 * was away is found again here.
 */
export function goneForLinks(links: A2aLinkRecordV1[], tree: A2aRemotePaneSnapshot): A2aRemotePaneGoneParams[] {
  const ws = new Set(tree.workspaces.map((w) => w.id));
  const paneWs = new Map<string, string>();
  for (const w of tree.workspaces) for (const p of w.panes) paneWs.set(p.paneId, w.id);
  const out: A2aRemotePaneGoneParams[] = [];
  for (const l of links) {
    if (l.state === 'revoked' || l.state === 'broken') continue;
    if (l.local.kind === 'brain') {
      // Moa not known yet (a cold start reads its state after the first
      // snapshot) breaks nothing: only a Moa that is off or replaced does.
      if (tree.brainState === 'unknown' && !tree.brain) continue;
      if (tree.brain?.workspaceId !== l.local.workspaceId) {
        out.push({ workspaceId: l.local.workspaceId, reason: 'workspace-gone', endpoint: 'brain' });
      }
      continue;
    }
    const at = paneWs.get(l.local.paneId ?? '');
    if (at === l.local.workspaceId) continue;
    if (at !== undefined) out.push({ workspaceId: l.local.workspaceId, paneId: l.local.paneId, reason: 'pane-moved' });
    else if (!ws.has(l.local.workspaceId)) out.push({ workspaceId: l.local.workspaceId, reason: 'workspace-gone' });
    else out.push({ workspaceId: l.local.workspaceId, paneId: l.local.paneId, reason: 'pane-closed' });
  }
  return out;
}

export class A2aExposurePublisher {
  /** The tree as last accepted, with Moa as this module judges it (see `effectiveBrain`). */
  private last: A2aRemotePaneSnapshot | null = null;
  /** The renderer's last raw snapshot (re-judged when Moa's grace runs out). */
  private raw: A2aRemotePaneSnapshot | null = null;
  /** Since when Moa has been "not known right now"; null while known. */
  private brainUnknownSince: number | null = null;
  /** Gone notices not yet taken by the daemon, by key. */
  private readonly pending = new Map<string, A2aRemotePaneGoneParams>();
  private retryArmed = false;
  private graceArmed = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => void;

  constructor(private readonly deps: ExposurePublisherDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms): void => void setTimeout(fn, ms).unref?.());
  }

  /** A new snapshot from the renderer. Resolves once its effects ran. */
  accept(snapshot: A2aRemotePaneSnapshot): Promise<void> {
    return this.enqueue(async () => {
      // An empty tree is believed only from a renderer that says its session
      // is restored (the last workspace really closed); otherwise it is a
      // window (re)loading and breaks nothing.
      if (snapshot.workspaces.length === 0 && snapshot.sessionRestored !== true) return;
      this.raw = snapshot;
      const next = this.judge(snapshot);
      const prev = this.last;
      this.last = next;
      if (prev) for (const g of diffGonePanes(prev, next)) this.pending.set(goneKey(g), g);
      await this.publishNow();
    });
  }

  /** Re-publish the last snapshot (exposure settings changed, or the daemon reconnected). */
  republish(): Promise<void> {
    return this.enqueue(() => this.publishNow());
  }

  /**
   * The tree with Moa as it should count: present when present; gone when
   * the renderer says it is gone (turned off, HQ deleted); while merely
   * unknown (state not read yet, HQ briefly missing from the tree) the last
   * known Moa is kept for up to `A2A_BRAIN_GRACE_MS`, so a blip never breaks
   * a Moa link for good.
   */
  private judge(snapshot: A2aRemotePaneSnapshot): A2aRemotePaneSnapshot {
    const rest: A2aRemotePaneSnapshot = { workspaces: snapshot.workspaces };
    const state = snapshot.brainState ?? (snapshot.brain ? 'present' : 'off');
    if (state === 'present' && snapshot.brain) {
      this.brainUnknownSince = null;
      return { ...rest, brain: snapshot.brain };
    }
    if (state !== 'unknown') {
      this.brainUnknownSince = null;
      return rest;
    }
    const kept = this.last?.brain;
    // Nothing known to keep (a cold start): say so, so reconciliation waits.
    if (!kept) return { ...rest, brainState: 'unknown' };
    if (this.brainUnknownSince === null) this.brainUnknownSince = this.now();
    const waited = this.now() - this.brainUnknownSince;
    if (waited >= A2A_BRAIN_GRACE_MS) return rest;
    // Re-judge once the grace runs out, in case nothing else changes.
    if (!this.graceArmed) {
      this.graceArmed = true;
      this.setTimer(() => {
        this.graceArmed = false;
        if (this.raw) void this.accept(this.raw);
      }, A2A_BRAIN_GRACE_MS - waited);
    }
    return { ...rest, brain: kept };
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(job).catch((err: unknown) => this.deps.log(`publish failed: ${errMsg(err)}`));
    return this.chain;
  }

  /** Send every pending gone notice; keep the ones the daemon did not take and retry later. */
  private async flushGone(client: ExposurePublisherClient): Promise<void> {
    for (const [key, gone] of [...this.pending]) {
      try {
        await client.a2aRemotePaneGone(gone);
        this.pending.delete(key);
      } catch (err) {
        this.deps.log(`paneGone ${gone.reason} failed, will retry: ${errMsg(err)}`);
      }
    }
    if (this.pending.size > 0 && !this.retryArmed) {
      this.retryArmed = true;
      this.setTimer(() => {
        this.retryArmed = false;
        void this.republish();
      }, A2A_GONE_RETRY_MS);
    }
  }

  private async publishNow(): Promise<void> {
    const client = this.deps.client();
    if (!client || !this.last) return;
    // The daemon's live links against the current tree: catches any notice
    // lost while it was away (the diff alone only sees changes it was sent).
    try {
      const { links } = await client.a2aRemoteLinksList();
      for (const g of goneForLinks(links ?? [], this.last)) this.pending.set(goneKey(g), g);
    } catch (err) {
      this.deps.log(`links read failed: ${errMsg(err)}`);
    }
    await this.flushGone(client);
    const { exposures } = await client.a2aRemoteExposureList();
    const exposed = new Set((exposures ?? []).flatMap((e) => e.workspaceIds));
    const panes: A2aExposureCandidate[] = [];
    // Moa first, and only while some PC may see it.
    if (this.last.brain && (exposures ?? []).some((e) => e.brain === true)) {
      panes.push({ kind: 'brain', workspaceId: this.last.brain.workspaceId, workspaceName: this.last.brain.name });
    }
    for (const w of this.last.workspaces) {
      if (!exposed.has(w.id)) continue;
      for (const p of w.panes) {
        const gitRemote = p.cwd ? await this.deps.repoKey(p.cwd).catch(() => null) : null;
        panes.push({
          kind: 'pane',
          workspaceId: w.id,
          workspaceName: w.name,
          paneId: p.paneId,
          ...(p.label ? { label: p.label } : {}),
          ...(p.agent ? { agent: p.agent } : {}),
          ...(p.cwd ? { cwd: p.cwd } : {}),
          ...(gitRemote ? { gitRemote } : {}),
          ...(p.gitBranch ? { gitBranch: p.gitBranch } : {}),
        });
      }
    }
    await client.a2aRemoteExposurePublish(panes);
  }
}

/** Shape check of a renderer snapshot (IPC input). */
export function coercePaneSnapshot(raw: unknown): A2aRemotePaneSnapshot | null {
  if (!isRecord(raw) || !Array.isArray(raw['workspaces'])) return null;
  const workspaces: A2aRemotePaneSnapshot['workspaces'] = [];
  for (const w of raw['workspaces']) {
    if (!isRecord(w) || typeof w['id'] !== 'string' || !w['id'] || !Array.isArray(w['panes'])) return null;
    const panes: A2aRemotePaneSnapshot['workspaces'][number]['panes'] = [];
    for (const p of w['panes']) {
      if (!isRecord(p) || typeof p['paneId'] !== 'string' || !p['paneId']) return null;
      const pane: (typeof panes)[number] = { paneId: p['paneId'] };
      for (const key of ['label', 'agent', 'cwd', 'gitBranch'] as const) {
        if (typeof p[key] === 'string' && p[key]) pane[key] = p[key];
      }
      panes.push(pane);
    }
    workspaces.push({ id: w['id'], name: typeof w['name'] === 'string' ? w['name'] : '', panes });
  }
  const out: A2aRemotePaneSnapshot = { workspaces };
  if (raw['sessionRestored'] === true) out.sessionRestored = true;
  const bs = raw['brainState'];
  if (bs === 'present' || bs === 'off' || bs === 'unknown') out.brainState = bs;
  const b = raw['brain'];
  if (b === undefined || b === null) return out;
  if (!isRecord(b) || typeof b['workspaceId'] !== 'string' || !b['workspaceId']) return null;
  out.brain = { workspaceId: b['workspaceId'], name: typeof b['name'] === 'string' ? b['name'] : '' };
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
