// The data behind Moa's delegate cards (moa_ask tickets the owner answers,
// merge effects, per-rule auto toggles). All of it is main's: the panel lists
// once and re-reads on main's decision / effect events and DECK_MOA_CHANGED.
// With the delegate off (no preload API, mode 'off' or 'shadow') every
// selector here yields nothing, so the panel draws exactly what it did before.
import { useCallback, useMemo } from 'react';
import { ticketView, type MergeEffect, type MoaDecision, type MoaDecisionEvent, type MoaDelegateListResult, type MoaEffectEvent, type MoaResolveRequest, type MoaResolveResult, type MoaAutoRuleSetRequest, type MoaAutoRuleSetResult, type MoaRuleView, type MoaUnreceiptedMerge, type MoaAuditEvent } from '../../../../shared/moaDecision';
import { useReread } from './useMoaPanelData';

export interface MoaDelegateApi {
  delegateList: () => Promise<MoaDelegateListResult>;
  delegateResolve: (req: MoaResolveRequest) => Promise<MoaResolveResult>;
  delegateAutoSet: (req: MoaAutoRuleSetRequest) => Promise<MoaAutoRuleSetResult>;
  /** Decision events, and the lane audit's (it rides the same channel). */
  onDelegateDecision?: (cb: (e: MoaDecisionEvent | MoaAuditEvent) => void) => () => void;
  onDelegateEffect?: (cb: (e: MoaEffectEvent) => void) => () => void;
  onChanged?: (cb: () => void) => () => void;
}

export function defaultDelegateApi(): MoaDelegateApi | undefined {
  const moa = window.electronAPI?.deck?.moa;
  if (!moa?.delegateList || !moa.delegateResolve || !moa.delegateAutoSet) return undefined;
  return {
    delegateList: moa.delegateList,
    delegateResolve: moa.delegateResolve,
    delegateAutoSet: moa.delegateAutoSet,
    onDelegateDecision: moa.onDelegateDecision,
    onDelegateEffect: moa.onDelegateEffect,
    onChanged: moa.onChanged,
  };
}

const OFF: MoaDelegateListResult = { mode: 'off', decisions: [], effects: [], rules: [] };

/** Whether the panel shows anything of the delegate: only while it suggests
 *  or answers. 'shadow' only records, so it draws nothing. */
export function delegateShown(state: MoaDelegateListResult): boolean {
  return state.mode === 'suggest' || state.mode === 'auto';
}

/** A ticket the owner may answer — main's ownerCanResolve, on the shared
 *  ticketView (a restart-uncertain row reads as escalated too). */
export function ownerCanAnswer(d: MoaDecision): boolean {
  return d.resolvedBy === null && ticketView(d).status === 'escalated';
}

/** The open tickets, oldest first. Off → none. */
export function selectOpenTickets(state: MoaDelegateListResult): MoaDecision[] {
  if (!delegateShown(state)) return [];
  return state.decisions.filter(ownerCanAnswer).sort((a, b) => a.createdAt - b.createdAt);
}

/** How long a settled merge stays in the activity list. */
export const EFFECT_SHOWN_MS = 24 * 60 * 60 * 1000;
export const EFFECT_ROWS_MAX = 5;

/** Merge effects to show as status rows: the recent ones, newest first. An
 *  `uncertain` one (main could not confirm the merge yet) is a status here. */
export function selectEffectRows(state: MoaDelegateListResult, now: number): MergeEffect[] {
  if (!delegateShown(state)) return [];
  return state.effects
    .filter((e) => e.status === 'uncertain' || now - e.updatedAt <= EFFECT_SHOWN_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, EFFECT_ROWS_MAX);
}

/** The lane audit's last answer: PRs merged lately, in repos the lane
 *  touched, with no lane receipt. Display only, listed quietly. */
export function selectUnreceipted(state: MoaDelegateListResult): MoaUnreceiptedMerge[] {
  if (!delegateShown(state)) return [];
  return state.unreceiptedMerges ?? [];
}

/** Rules the owner may let Moa settle alone: the book says auto and binds a
 *  known predicate. Every other rule has no toggle. */
export function selectAutoRules(state: MoaDelegateListResult): MoaRuleView[] {
  if (!delegateShown(state)) return [];
  return state.rules.filter((r) => r.autoInBook && r.predicate !== null);
}

/** The delegate's list, re-read on main's events. No API → off. */
export function useMoaDelegate(api: MoaDelegateApi | undefined) {
  const listFn = api?.delegateList;
  const onDecision = api?.onDelegateDecision;
  const onEffect = api?.onDelegateEffect;
  const onChanged = api?.onChanged;
  const read = useCallback(() => listFn!().then((r) => r ?? OFF), [listFn]);
  const subscribe = useCallback((cb: () => void) => {
    const offs = [onDecision?.(() => cb()), onEffect?.(() => cb()), onChanged?.(cb)];
    return () => { for (const off of offs) off?.(); };
  }, [onDecision, onEffect, onChanged]);
  const { value, refresh } = useReread<MoaDelegateListResult>(listFn ? read : null, listFn ? subscribe : null, OFF);
  return useMemo(() => ({ state: value, refresh }), [value, refresh]);
}
