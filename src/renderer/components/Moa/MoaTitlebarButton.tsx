// ─── Moa's titlebar icon ─────────────────────────────────────────────────────
//
// While Moa is on, its mascot sits in the titlebar's right end, before the
// tools-panel toggle. Clicking it opens or closes the right panel (where Moa's
// chat lives). With the panel off screen it carries Moa's notices (moaNotice):
// a short bubble for a new decision or a finished delegation, then a dot —
// yellow while a decision waits on the operator, grey for an unseen reply.
//
// It also carries the dot DeckToggle had for unread channels (DeckToggle steps
// aside while Moa is on), counted only while the Channels tab is opted in. A
// Moa dot outranks it in colour; the accessible name says both.
//
// "On screen" is DeckToggle's reading (the dock is open AND the Workspaces page
// is up): bubbles, dots and "seen" follow it. The transcript subscription
// follows the dock's mount flag instead (AppLayout mounts it on
// `channelDockVisible` alone), so it can never be dropped while the panel holds
// its own.

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { showWorkspaces } from '../../utils/showWorkspaces';
import type { MoaMascotState, MoaPendingDecision } from '../../../shared/moa';
import type { WorkLink } from '../../../shared/workLink';
import { MoaMascot, useMoaReducedMotion } from './MoaMascot';
import MoaBubble from './MoaBubble';
import { MOA_BUBBLE_MS, moaDot, useMoaNotices, type MoaNoticeText } from './moaNotice';
import { sumUnread } from '../Channels/ChannelsPanel';
import { deckHasSignal } from '../Deck/DeckToggle';

export default function MoaTitlebarButton() {
  const enabled = useStore((s) => s.moa?.config.enabled === true);
  if (!enabled) return null;
  return <MoaTitlebarButtonOn />;
}

function MoaTitlebarButtonOn() {
  const t = useT();
  const onScreen = useStore((s) => s.channelDockVisible && s.appRoute === 'workspaces');
  const bubbles = useStore((s) => s.moa?.config.bubbles !== false);
  const hqId = useStore((s) => s.moa?.hq.workspaceId ?? null);
  const setChannelDockVisible = useStore((s) => s.setChannelDockVisible);
  const channelsUnread = useStore((s) => (s.channelsTabVisible ? sumUnread(s.channelUnread) : 0));
  const reduceMotion = useMoaReducedMotion();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [hold, setHold] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const text: MoaNoticeText = {
    decision: (d: MoaPendingDecision) => {
      const name = d.workspaceName ?? useStore.getState().workspaces.find((w) => w.id === d.workspaceId)?.name;
      return name ? t('moa.bubble.decision', { workspace: name, question: d.decision.question }) : d.decision.question;
    },
    finished: (l: WorkLink) => {
      const title = l.title || useStore.getState().workspaces.find((w) => w.id === l.owner.workspaceId)?.name;
      return title ? t('moa.bubble.finished', { title }) : t('moa.bubble.finishedUntitled');
    },
  };
  const { state, dispatch } = useMoaNotices({ enabled: true, onScreen, hqId, bubbles, text });
  const bubble = onScreen ? null : state.bubble;

  // A new bubble is announced once, politely; the bubble itself never takes focus.
  useEffect(() => {
    if (!bubble) return;
    const head = bubble.kind === 'decision' ? t('moa.bubble.needsYou') : t('moa.bubble.done');
    setAnnouncement(`${head}. ${bubble.line}`);
  }, [bubble?.seq]);

  // Collapse to the dot after MOA_BUBBLE_MS, held while the operator is in it.
  useEffect(() => {
    if (!bubble || hold) return;
    const timer = setTimeout(() => dispatch({ type: 'collapse' }), MOA_BUBBLE_MS);
    return () => clearTimeout(timer);
  }, [bubble?.seq, hold, dispatch]);

  useEffect(() => {
    if (!bubble) setHold(false);
  }, [bubble]);

  const openPanel = useCallback(() => {
    const st = useStore.getState();
    showWorkspaces(st);
    // Land on the conversation, as the tools-panel toggle does.
    st.setActiveDeckTab('commander');
    st.setChannelDockVisible(true);
    dispatch({ type: 'seen' });
  }, [dispatch]);
  const later = useCallback(() => dispatch({ type: 'collapse' }), [dispatch]);

  const moaDotKind = onScreen ? null : moaDot(state);
  // Like DeckToggle: only while the panel is off screen.
  const channelSignal = !onScreen && deckHasSignal(channelsUnread);
  const dot = moaDotKind ?? (channelSignal ? 'channels' : null);
  const mascot: MoaMascotState = bubble?.kind === 'done' ? 'done' : state.pending.length > 0 ? 'needs-you' : 'idle';

  // Named "Moa" (open state is aria-expanded): the tools-panel toggle beside
  // it already reads "Show / Hide Moa" while Moa owns the panel.
  const base = t('moa.mascot.name');
  const moaSuffix =
    moaDotKind === 'waiting'
      ? state.pending.length === 1
        ? t('moa.mascot.waitingOne')
        : t('moa.mascot.waiting', { count: state.pending.length })
      : moaDotKind === 'reply'
        ? t('moa.mascot.newReply')
        : '';
  const channelSuffix = channelSignal ? t('moa.mascot.channelsUnread', { count: channelsUnread }) : '';
  const suffix = [moaSuffix, channelSuffix].filter(Boolean).join(', ');
  const name = suffix ? `${base} — ${suffix}` : base;

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        onClick={() => {
          if (onScreen) setChannelDockVisible(false);
          else openPanel();
        }}
        className={`wmux-panel-toggle ${FOCUS_RING}`}
        title={name}
        aria-label={name}
        aria-expanded={onScreen}
        data-moa-titlebar
        data-moa-dot={dot ?? 'none'}
      >
        <span aria-hidden="true" className="relative flex shrink-0">
          <MoaMascot state={mascot} size={20} />
          {dot && (
            <span
              className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
              style={{
                background:
                  dot === 'waiting' ? 'var(--accent-yellow)' : dot === 'reply' ? 'var(--text-muted)' : 'var(--accent)',
              }}
              data-moa-titlebar-dot={dot}
            />
          )}
        </span>
      </button>
      <span className="sr-only" role="status" aria-live="polite" data-moa-live>
        {announcement}
      </span>
      {bubble && (
        <MoaBubble
          bubble={bubble}
          anchor={anchor}
          reduceMotion={reduceMotion}
          onOpen={openPanel}
          onLater={later}
          onHold={setHold}
        />
      )}
    </>
  );
}
