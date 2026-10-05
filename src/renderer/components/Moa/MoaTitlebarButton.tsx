// ─── Moa's titlebar icon ─────────────────────────────────────────────────────
//
// While Moa is on, its mascot sits in the titlebar's right end. Clicking it
// opens or closes the right panel (where Moa's chat lives); with Moa off there
// is neither the button nor the panel (Layout/moaDockGate). With the panel off screen it carries Moa's notices (moaNotice):
// a short bubble for a new decision or a finished delegation, then a dot —
// yellow while a decision waits on the operator, grey for an unseen reply.
//
// "On screen" means the dock is open AND shown: on the Workspaces page, or
// beside any rail page but Settings. Bubbles, dots and "seen" follow it. The
// transcript subscription follows the dock's mount flag instead (AppLayout
// mounts it on selectDockOpen alone), so it can never be dropped while the
// panel holds its own.

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { showWorkspaces } from '../../utils/showWorkspaces';
import { dockShownOn } from '../Layout/pagesBesideDock';
import type { MoaMascotState, MoaPendingDecision } from '../../../shared/moa';
import type { WorkLink } from '../../../shared/workLink';
import { MoaMascot, useMoaReducedMotion } from './MoaMascot';
import MoaBubble from './MoaBubble';
import { MOA_BUBBLE_MS, moaDot, useMoaNotices, type MoaNoticeText } from './moaNotice';

export default function MoaTitlebarButton() {
  const enabled = useStore((s) => s.moa?.config.enabled === true);
  if (!enabled) return null;
  return <MoaTitlebarButtonOn />;
}

function MoaTitlebarButtonOn() {
  const t = useT();
  const onScreen = useStore((s) => s.channelDockVisible && dockShownOn(s.appRoute));
  const bubbles = useStore((s) => s.moa?.config.bubbles !== false);
  const hqId = useStore((s) => s.moa?.hq.workspaceId ?? null);
  const setChannelDockVisible = useStore((s) => s.setChannelDockVisible);
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
    // Beside a rail page the panel opens in place; from Settings, on Workspaces.
    if (!dockShownOn(st.appRoute)) showWorkspaces(st);
    // Land on the conversation.
    st.setActiveDeckTab('commander');
    st.setChannelDockVisible(true);
    dispatch({ type: 'seen' });
  }, [dispatch]);
  const later = useCallback(() => dispatch({ type: 'collapse' }), [dispatch]);

  const dot = onScreen ? null : moaDot(state);
  const mascot: MoaMascotState = bubble?.kind === 'done' ? 'done' : state.pending.length > 0 ? 'needs-you' : 'idle';

  // Named "Moa"; the open state is aria-expanded. It is the right panel's
  // only toggle (the panel exists only while Moa is on).
  const base = t('moa.mascot.name');
  const suffix =
    dot === 'waiting'
      ? state.pending.length === 1
        ? t('moa.mascot.waitingOne')
        : t('moa.mascot.waiting', { count: state.pending.length })
      : dot === 'reply'
        ? t('moa.mascot.newReply')
        : '';
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
              style={{ background: dot === 'waiting' ? 'var(--attention)' : 'var(--text-muted)' }}
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
