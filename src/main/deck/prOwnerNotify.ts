// ─── PR event → the pane that owns the PR ───────────────────────────────────
//
// pr.ci / pr.review / pr.conflict reach a workspace's brain through the
// event-push coalescer (deck.handler). A workspace in mode 'off' — the
// default — has no brain, so a pane agent whose PR went red was never told.
// This is the accelerator beside that path: it hands the renderer a pointer
// (workspace, PR number and url, kind, head commit) and the renderer has one
// fixed line written into the pane whose checkout is that PR, if it can prove
// there is exactly one such agent pane and it is idle
// (renderer/hooks/fanoutCallerNudge.ts, the fan-out caller nudge's queue).
//
// The metadata poll publishes here (no new polling: PrCiRouter and
// PrReviewRouter ride the existing PrStatusCache / GhPrService cadence);
// deck.handler installs the sink because it knows which workspaces have a
// brain. Fail-closed, no ack, no retry: a workspace with a brain (the HQ
// included) is never addressed this way — its brain already got the event —
// and no window (headless) means nothing is sent.

import { isPrNumber, isPrOwnerKind, type PrOwnerKind } from '../../shared/prOwnerNudge';

export interface PrOwnerEvent {
  workspaceId: string;
  prNumber: number;
  /** Identifies the PR across repos; never written into a pane. */
  url: string;
  kind: PrOwnerKind;
  headSha?: string;
  /** Process-local order, the dedup fallback when there is no head commit. */
  seq: number;
}

export interface PrOwnerPorts {
  /** True when the workspace has a brain that hears the event itself. */
  hasBrain: (workspaceId: string) => boolean;
  /** Hand the pointer to the renderer; false when there is none. */
  send: (ev: PrOwnerEvent) => boolean;
}

type Sink = (ev: Omit<PrOwnerEvent, 'seq'>) => void;
let sink: Sink | null = null;
let seq = 0;

/** deck.handler installs the sink; null uninstalls it. */
export function setPrOwnerSink(fn: Sink | null): void {
  sink = fn;
}

/** The metadata poll's routers publish here. Never throws. */
export function publishPrOwnerEvent(ev: Omit<PrOwnerEvent, 'seq'>): void {
  try {
    sink?.(ev);
  } catch (err) {
    console.warn(`[deck] PR owner notify failed: ${String(err)}`);
  }
}

/** Returns true when a pointer was handed to the renderer. Never throws. */
export function notifyPrOwner(ev: Omit<PrOwnerEvent, 'seq'>, ports: PrOwnerPorts): boolean {
  try {
    if (!ev.workspaceId || !isPrNumber(ev.prNumber) || !isPrOwnerKind(ev.kind)) return false;
    if (typeof ev.url !== 'string' || !ev.url || ev.url.length > 512) return false;
    if (ports.hasBrain(ev.workspaceId)) return false;
    return ports.send({
      workspaceId: ev.workspaceId,
      prNumber: ev.prNumber,
      url: ev.url,
      kind: ev.kind,
      ...(typeof ev.headSha === 'string' && /^[0-9a-f]{7,64}$/i.test(ev.headSha) ? { headSha: ev.headSha } : {}),
      seq: ++seq,
    });
  } catch (err) {
    console.warn(`[deck] PR owner notify failed: ${String(err)}`);
    return false;
  }
}
