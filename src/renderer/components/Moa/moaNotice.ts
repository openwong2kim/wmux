// ─── Moa's titlebar notices: the bubble and the dot ──────────────────────────
//
// While the right panel is off screen, Moa reaches the operator through its
// titlebar icon. Two events pop a short bubble: a NEW pending decision (any
// workspace, from `deck.moa.decisions()`) and a delegation that just finished
// (a WorkLink turning `done`). After MOA_BUBBLE_MS the bubble collapses to a
// dot on the icon: attention orange while any decision is pending, grey for a report or
// reply the operator has not seen (a finished delegation, or a new assistant
// message on Moa's transcript). Opening the panel clears the grey dot.
//
// One bubble at a time, never stacked: the newest event replaces the bubble on
// screen (and restarts its clock), except that a finished delegation never
// displaces a decision that is showing, since the decision is the one waiting
// on the operator. Nothing is queued: what a replaced bubble said stays
// reachable through the dot and the panel.
//
// Startup is silent: the first decisions list and the first WorkLink list only
// seed what is already known, so a restart with pending work shows the dot,
// not a burst of bubbles.

import { useEffect, useReducer, useRef } from 'react';
import type { MoaPendingDecision } from '../../../shared/moa';
import type { WorkLink, WorkLinkState } from '../../../shared/workLink';
import type { TranscriptAppendData } from '../../../shared/transcript/turnEvents';

/** How long a bubble stays up before it collapses to the dot. */
export const MOA_BUBBLE_MS = 6000;

export type MoaBubbleKind = 'decision' | 'done';

export interface MoaBubble {
  /** Bumps on every new bubble, so the collapse timer restarts. */
  seq: number;
  kind: MoaBubbleKind;
  /** The decision key, or the WorkLink id. */
  key: string;
  line: string;
}

export interface MoaNoticeState {
  bubble: MoaBubble | null;
  /** Keys of every pending decision (`decisionKey`). */
  pending: string[];
  /** A report or reply has arrived that the operator has not seen. */
  unseen: boolean;
  seq: number;
}

/**
 * `quiet` is true while the right panel is on screen: it shows everything
 * itself, so nothing pops and nothing is marked unseen. `bubbles` is Moa's
 * Bubble notifications setting; off means dots only.
 */
export type MoaNoticeAction =
  | { type: 'decisions'; keys: string[]; fresh: { key: string; line: string } | null; quiet: boolean; bubbles: boolean }
  | { type: 'finished'; key: string; line: string; quiet: boolean; bubbles: boolean }
  | { type: 'reply'; quiet: boolean }
  | { type: 'collapse' }
  | { type: 'seen' };

export const MOA_NOTICE_INITIAL: MoaNoticeState = { bubble: null, pending: [], unseen: false, seq: 0 };

export function moaNoticeReducer(s: MoaNoticeState, a: MoaNoticeAction): MoaNoticeState {
  switch (a.type) {
    case 'decisions': {
      let bubble = s.bubble;
      // A decision answered elsewhere takes its bubble with it.
      if (bubble?.kind === 'decision' && !a.keys.includes(bubble.key)) bubble = null;
      let seq = s.seq;
      if (a.fresh && !a.quiet && a.bubbles) {
        seq += 1;
        bubble = { seq, kind: 'decision', key: a.fresh.key, line: a.fresh.line };
      }
      return { ...s, pending: a.keys, bubble, seq };
    }
    case 'finished': {
      if (a.quiet) return s;
      if (!a.bubbles || s.bubble?.kind === 'decision') return { ...s, unseen: true };
      const seq = s.seq + 1;
      return { ...s, unseen: true, seq, bubble: { seq, kind: 'done', key: a.key, line: a.line } };
    }
    case 'reply':
      return a.quiet || s.unseen ? s : { ...s, unseen: true };
    case 'collapse':
      return s.bubble ? { ...s, bubble: null } : s;
    case 'seen':
      return s.bubble || s.unseen ? { ...s, bubble: null, unseen: false } : s;
  }
}

/** The dot on the icon: attention orange while a decision waits, grey for an unseen report. */
export type MoaDot = 'waiting' | 'reply' | null;

export function moaDot(s: Pick<MoaNoticeState, 'pending' | 'unseen'>): MoaDot {
  if (s.pending.length > 0) return 'waiting';
  return s.unseen ? 'reply' : null;
}

export const decisionKey = (d: MoaPendingDecision): string => `${d.workspaceId}/${d.decision.id}`;

/** The newest decision in `list` that `known` has not seen, or null. A null
 *  `known` is the first read: it only seeds. */
export function freshDecision(
  known: ReadonlySet<string> | null,
  list: readonly MoaPendingDecision[],
): MoaPendingDecision | null {
  if (!known) return null;
  let best: MoaPendingDecision | null = null;
  for (const d of list) {
    if (known.has(decisionKey(d))) continue;
    if (!best || d.decision.raisedAt >= best.decision.raisedAt) best = d;
  }
  return best;
}

/** Links that are `done` now and were not `done` the last time we looked. */
export function newlyDone(prev: ReadonlyMap<string, WorkLinkState>, links: readonly WorkLink[]): WorkLink[] {
  return links.filter((l) => l.state === 'done' && prev.get(l.id) !== 'done');
}

export interface MoaNoticeText {
  decision: (d: MoaPendingDecision) => string;
  finished: (l: WorkLink) => string;
}

export interface UseMoaNoticesOptions {
  /** Moa is on. Off: nothing is listened to. */
  enabled: boolean;
  /** The right panel is on screen (the Workspaces page with the dock open). */
  onScreen: boolean;
  /** The HQ workspace: main drops the transcript subscription when it changes. */
  hqId: string | null;
  bubbles: boolean;
  text: MoaNoticeText;
}

/**
 * Listens to the deck bridge and keeps the notice state. Every bridge call is
 * optional: a missing method or a rejected call leaves the state as it was.
 */
export function useMoaNotices({ enabled, onScreen, hqId, bubbles, text }: UseMoaNoticesOptions) {
  const [state, dispatch] = useReducer(moaNoticeReducer, MOA_NOTICE_INITIAL);
  const live = useRef({ quiet: onScreen, bubbles, text });
  live.current = { quiet: onScreen, bubbles, text };

  // Decisions: re-read on every Moa change; the first answer only seeds.
  useEffect(() => {
    if (!enabled) return;
    const moa = window.electronAPI?.deck?.moa;
    if (!moa?.decisions) return;
    let known: Set<string> | null = null;
    let reqSeq = 0;
    let disposed = false;
    const read = async () => {
      const mine = ++reqSeq;
      let list: MoaPendingDecision[];
      try {
        const r = await moa.decisions();
        list = Array.isArray(r?.decisions) ? r.decisions : [];
      } catch {
        return;
      }
      if (disposed || mine !== reqSeq) return;
      const fresh = freshDecision(known, list);
      known = new Set(list.map(decisionKey));
      const { quiet, bubbles: on, text: tx } = live.current;
      dispatch({
        type: 'decisions',
        keys: [...known],
        fresh: fresh ? { key: decisionKey(fresh), line: tx.decision(fresh) } : null,
        quiet,
        bubbles: on,
      });
    };
    void read();
    const off = moa.onChanged?.(() => void read());
    return () => {
      disposed = true;
      off?.();
    };
  }, [enabled]);

  // Finished delegations: a WorkLink turning `done`.
  useEffect(() => {
    if (!enabled) return;
    const api = window.electronAPI?.workLinks;
    if (!api?.list) return;
    const states = new Map<string, WorkLinkState>();
    let seeded = false;
    let disposed = false;
    const report = (links: WorkLink[]) => {
      const done = newlyDone(states, links);
      for (const l of links) states.set(l.id, l.state);
      const { quiet, bubbles: on, text: tx } = live.current;
      for (const l of done) dispatch({ type: 'finished', key: l.id, line: tx.finished(l), quiet, bubbles: on });
    };
    const off = api.onChanged?.((ids) => {
      if (!seeded || !Array.isArray(ids) || ids.length === 0) return;
      const read = api.get
        ? Promise.all(ids.map((id) => api.get(id).catch(() => null))).then((r) => r.filter((l): l is WorkLink => !!l))
        : api.list();
      read.then((links) => { if (!disposed) report(links); }).catch(() => undefined);
    });
    api
      .list()
      .then((links) => {
        if (disposed) return;
        for (const l of links ?? []) states.set(l.id, l.state);
        seeded = true;
      })
      .catch(() => { seeded = true; });
    return () => {
      disposed = true;
      off?.();
    };
  }, [enabled]);

  // Replies: a new assistant message on Moa's transcript.
  useEffect(() => {
    if (!enabled) return;
    const tr = window.electronAPI?.deck?.moa?.transcript;
    if (!tr?.onAppend) return;
    return tr.onAppend((data: TranscriptAppendData) => {
      // A reset push is a re-snapshot of history (the first push after every
      // subscribe, or a new brain session), not a new message.
      if (data?.reset) return;
      // A reply, not Moa's mid-turn narration (main folds that into activity).
      if (data?.events?.some((e) => e.kind === 'assistant_text' && !e.folded)) {
        dispatch({ type: 'reply', quiet: live.current.quiet });
      }
    });
  }, [enabled]);

  // Appends only flow while someone subscribes. Main counts subscribers by
  // name, so the reply dot holds its own ('notice') the whole time Moa is on —
  // in the terminal view and on other pages too — and the panel's comes and
  // goes beside it. Main drops subscriptions when the HQ changes, so a new HQ
  // subscribes again.
  useEffect(() => {
    if (!enabled || !hqId) return;
    const tr = window.electronAPI?.deck?.moa?.transcript;
    if (!tr?.subscribe) return;
    tr.subscribe('notice').catch(() => undefined);
    return () => { tr.unsubscribe?.('notice').catch(() => undefined); };
  }, [enabled, hqId]);

  // The panel on screen has shown everything: clear the bubble and the grey dot.
  useEffect(() => {
    if (onScreen) dispatch({ type: 'seen' });
  }, [onScreen]);

  return { state, dispatch };
}
