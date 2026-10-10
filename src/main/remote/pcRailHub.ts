// PC rail: the main-process feeds for every web-paired host, while the column
// is mounted.
//
//   start() ──▶ sync every 10 s: hosts added/removed ──▶ 'hosts' event
//                 │ per host (own timer, never waits on another host)
//                 ├─ poller: /api/workspaces (+ /api/approvals, + /api/config
//                 │          every PC_RAIL_CONFIG_PROBE_EVERY_TICKS) ──▶ 'feed' event
//                 │          failures back off: 20 s, 40 s, 60 s
//                 └─ PcRailAttentionStream ──▶ frames, stream states, toasts
//
// A host on plain http to another machine is never contacted: it gets one
// `insecure-transport` feed and no timer. A muted host still feeds its badge
// but never toasts. A host that also has an attached remote workspace already
// toasts through the attach path, so this hub leaves its toasts to that path.

import type { RemoteHost, RemoteHostPublic } from '../../shared/remoteHosts';
import { REMOTE_POLL_INTERVAL_MS } from '../../shared/remoteHosts';
import { isCredentialSafeOriginString } from '../../shared/remotePairInput';
import { PC_RAIL_CONFIG_PROBE_EVERY_TICKS, PC_RAIL_LIMITS, type PcRailAttentionFrameKind, type PcRailTokenKind } from '../../shared/pcRail';
import type { RemoteAttentionNotification } from './remoteAttention';
import { PcRailAttentionStream, type PcRailStreamState } from './pcRailAttention';
import { fetchPcRailApprovals, fetchPcRailWorkspaces, probePcRailAllowInput } from './pcRailFeed';
import type { PcRailFeedEvent, PcRailFeedFailure, PcRailHostInfo } from './pcRailWire';

/** Delay before the next tick after `n` failures in a row (n ≥ 1). */
const FAILURE_BACKOFF_MS = [20_000, 40_000, 60_000];
/** A refused credential or a missing route will not heal in seconds. */
const SLOW_RETRY_MS = 60_000;

export interface PcRailHubSources {
  /** `tokenKind`: how the credential was issued, when the store recorded it. */
  hosts: { list(): RemoteHostPublic[]; get(id: string): (RemoteHost & { tokenKind?: PcRailTokenKind }) | null };
  /** Hosts with an attached remote workspace (their toasts come from the attach path). */
  attachedHostIds(): ReadonlySet<string>;
}

export interface PcRailHubSinks {
  feed(event: PcRailFeedEvent): void;
  frame(hostId: string, kind: PcRailAttentionFrameKind, data: unknown): void;
  stream(hostId: string, state: PcRailStreamState): void;
  toast(hostId: string, hostLabel: string, n: RemoteAttentionNotification): void;
}

export interface PcRailHubDeps extends PcRailHubSources, PcRailHubSinks {
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimeoutImpl?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (t: ReturnType<typeof setTimeout>) => void;
  /** Test seam for the per-host SSE. */
  streamFactory?: (
    host: RemoteHost,
    handlers: {
      onFrame: (kind: PcRailAttentionFrameKind, data: unknown) => void;
      onState: (state: PcRailStreamState) => void;
      onNotification: (hostLabel: string, n: RemoteAttentionNotification) => void;
    },
  ) => Pick<PcRailAttentionStream, 'start' | 'stop'>;
}

interface Poller {
  host: RemoteHost;
  timer: ReturnType<typeof setTimeout> | null;
  ticks: number;
  failures: number;
  inFlight: boolean;
  allowInput?: boolean;
}

export function nextPcRailPollDelay(failures: number, reason?: PcRailFeedFailure): number {
  if (failures <= 0) return REMOTE_POLL_INTERVAL_MS;
  if (reason === 'auth-rejected' || reason === 'unavailable') return SLOW_RETRY_MS;
  return FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1];
}

export class PcRailHub {
  private readonly deps: PcRailHubDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly pollers = new Map<string, Poller>();
  private readonly streams = new Map<string, Pick<PcRailAttentionStream, 'start' | 'stop'>>();
  private readonly lastFeed = new Map<string, PcRailFeedEvent>();
  private hosts: PcRailHostInfo[] = [];
  private muted = new Set<string>();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(deps: PcRailHubDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.sync();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.syncTimer) this.clear(this.syncTimer);
    this.syncTimer = null;
    for (const id of [...this.pollers.keys()]) this.dropHost(id);
    for (const id of [...this.streams.keys()]) this.dropHost(id);
    this.lastFeed.clear();
    this.hosts = [];
  }

  setMuted(hostIds: Iterable<string>): void {
    this.muted = new Set(hostIds);
  }

  isMuted(hostId: string): boolean {
    return this.muted.has(hostId);
  }

  /** The roster and each host's last feed, for a renderer that subscribes late. */
  snapshot(): PcRailFeedEvent[] {
    return [{ type: 'hosts', hosts: this.hosts }, ...this.lastFeed.values()];
  }

  /** Reconcile pollers and streams against the paired hosts. Idempotent. */
  sync(): void {
    if (!this.running) return;
    if (this.syncTimer) this.clear(this.syncTimer);
    this.syncTimer = this.schedule(() => this.sync(), REMOTE_POLL_INTERVAL_MS);

    const listed = this.deps.hosts.list().slice(0, PC_RAIL_LIMITS.hosts);
    const wanted = new Set(listed.map((h) => h.id));
    for (const id of new Set([...this.pollers.keys(), ...this.streams.keys(), ...this.lastFeed.keys()])) {
      if (!wanted.has(id)) this.dropHost(id);
    }
    // The roster goes out before any feed for a host it adds: the renderer
    // ignores feeds for hosts its roster does not list.
    const roster: PcRailHostInfo[] = listed.map((h) => {
      const allowInput = this.pollers.get(h.id)?.allowInput ?? h.allowInput;
      const tokenKind = this.deps.hosts.get(h.id)?.tokenKind;
      return {
        id: h.id,
        label: h.label,
        ...(allowInput !== undefined ? { allowInput } : {}),
        ...(tokenKind === 'device' || tokenKind === 'operator' ? { tokenKind } : {}),
      };
    });
    if (JSON.stringify(roster) !== JSON.stringify(this.hosts)) {
      this.hosts = roster;
      this.deps.feed({ type: 'hosts', hosts: roster });
    }
    for (const pub of listed) {
      const host = this.deps.hosts.get(pub.id);
      if (!host) continue;
      const known = this.pollers.get(host.id);
      // A re-paired host keeps its id but carries a new credential or address.
      if (known && (known.host.token !== host.token || known.host.origin !== host.origin)) this.dropHost(host.id);
      if (!isCredentialSafeOriginString(host.origin)) {
        if (!this.lastFeed.has(host.id)) this.emitFeed({ type: 'feed', hostId: host.id, at: this.now(), ok: false, reason: 'insecure-transport' });
        continue;
      }
      if (!this.pollers.has(host.id)) this.addHost(host);
    }
  }

  private addHost(host: RemoteHost): void {
    const poller: Poller = { host, timer: null, ticks: 0, failures: 0, inFlight: false, ...(host.allowInput !== undefined ? { allowInput: host.allowInput } : {}) };
    this.pollers.set(host.id, poller);
    void this.tick(poller);

    const handlers = {
      onFrame: (kind: PcRailAttentionFrameKind, data: unknown) => this.deps.frame(host.id, kind, data),
      onState: (state: PcRailStreamState) => this.deps.stream(host.id, state),
      onNotification: (label: string, n: RemoteAttentionNotification) => {
        if (this.muted.has(host.id) || this.deps.attachedHostIds().has(host.id)) return;
        this.deps.toast(host.id, label, n);
      },
    };
    const stream = this.deps.streamFactory
      ? this.deps.streamFactory(host, handlers)
      : new PcRailAttentionStream({ host, fetchImpl: this.fetchImpl, ...handlers });
    this.streams.set(host.id, stream);
    stream.start();
  }

  private dropHost(hostId: string): void {
    const poller = this.pollers.get(hostId);
    if (poller?.timer) this.clear(poller.timer);
    this.pollers.delete(hostId);
    this.streams.get(hostId)?.stop();
    this.streams.delete(hostId);
    this.lastFeed.delete(hostId);
  }

  private async tick(poller: Poller): Promise<void> {
    if (poller.inFlight || this.pollers.get(poller.host.id) !== poller) return;
    poller.inFlight = true;
    poller.timer = null;
    const host = poller.host;
    const probe = poller.ticks % PC_RAIL_CONFIG_PROBE_EVERY_TICKS === 0;
    poller.ticks++;
    let reason: PcRailFeedFailure | undefined;
    const listRequestedAt = this.now();
    try {
      const [list, allowInput] = await Promise.all([
        fetchPcRailWorkspaces(host, this.fetchImpl),
        probe ? probePcRailAllowInput(host, this.fetchImpl) : Promise.resolve(undefined),
      ]);
      if (this.pollers.get(host.id) !== poller) return;
      if (allowInput !== undefined) poller.allowInput = allowInput;
      if (list.ok) {
        const approvalsRequestedAt = this.now();
        const approvals = await fetchPcRailApprovals(host, this.fetchImpl);
        if (this.pollers.get(host.id) !== poller) return;
        poller.failures = 0;
        this.emitFeed({
          type: 'feed',
          hostId: host.id,
          at: this.now(),
          ok: true,
          response: list.response,
          listRequestedAt,
          ...(approvals.ok
            ? { approvals: approvals.approvals, approvalsRequestedAt }
            : { approvalsError: approvals.reason }),
          ...(poller.allowInput !== undefined ? { allowInput: poller.allowInput } : {}),
        });
      } else {
        poller.failures++;
        reason = list.reason;
        this.emitFeed({ type: 'feed', hostId: host.id, at: this.now(), ok: false, reason: list.reason });
      }
    } finally {
      poller.inFlight = false;
      if (this.running && this.pollers.get(host.id) === poller) {
        poller.timer = this.schedule(() => void this.tick(poller), nextPcRailPollDelay(poller.failures, reason));
      }
    }
  }

  private emitFeed(event: PcRailFeedEvent): void {
    if (event.type === 'feed') this.lastFeed.set(event.hostId, event);
    this.deps.feed(event);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private schedule(cb: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = (this.deps.setTimeoutImpl ?? setTimeout)(cb, ms);
    timer.unref?.();
    return timer;
  }

  private clear(timer: ReturnType<typeof setTimeout>): void {
    (this.deps.clearTimeoutImpl ?? clearTimeout)(timer);
  }
}
