// Ports between the Moa delegate's halves, so they can be built in parallel.
//
//   main backend   implements MoaDelegateServicePort (moa_ask, the judge, the
//                  merge executor, startup reconcile) and registers it here.
//   IPC + panel    reads it from here for the owner channels
//                  (DECK_MOA_DELEGATE_*) and forwards MoaDelegateEvents.
//
// Nothing registers a service while the delegate is off, so every reader must
// treat `null` as "mode off": list → { mode: 'off', … empty }, resolve and
// auto-set → refused. Owner resolution and auto toggles are renderer IPC only;
// they are never exposed on the pipe.

import type { MoaAsker, MoaAskRequest, MoaAskResult, MoaAskStatusResult } from '../../shared/moaAsk';
import type {
  MoaAutoRuleSetRequest,
  MoaAutoRuleSetResult,
  MoaDecisionEvent,
  MoaDelegateListResult,
  MoaEffectEvent,
  MoaResolveRequest,
  MoaResolveResult,
} from '../../shared/moaDecision';

export interface MoaDelegateServicePort {
  /** moa.ask. `cwd` is the asker's verified pane cwd; a merge's repo is
   *  resolved from it, never from the request. */
  ask(asker: MoaAsker, cwd: string, req: MoaAskRequest): Promise<MoaAskResult>;
  /** moa.askStatus: only the asker that created a ticket may read it. */
  status(asker: MoaAsker, ticketId: string): Promise<MoaAskStatusResult>;
  /** DECK_MOA_DELEGATE_LIST. */
  list(): Promise<MoaDelegateListResult>;
  /** DECK_MOA_DELEGATE_RESOLVE. An approved merge enqueues a MergeEffect
   *  (approvedBy 'owner') and runs it; the result carries the effect. */
  resolveByOwner(req: MoaResolveRequest): Promise<MoaResolveResult>;
  /** DECK_MOA_DELEGATE_AUTO_SET. */
  setAutoRule(req: MoaAutoRuleSetRequest): Promise<MoaAutoRuleSetResult>;
  /** Subscribe to decision and effect changes; returns the unsubscribe. */
  subscribe(listener: MoaDelegateEvents): () => void;
}

export interface MoaDelegateEvents {
  decision(event: MoaDecisionEvent): void;
  effect(event: MoaEffectEvent): void;
}

let service: MoaDelegateServicePort | null = null;

/** Called once by main's startup wiring when the delegate is on. */
export function setMoaDelegateService(next: MoaDelegateServicePort | null): void {
  service = next;
}

/** Null while the delegate is off (or not yet started). */
export function getMoaDelegateService(): MoaDelegateServicePort | null {
  return service;
}
