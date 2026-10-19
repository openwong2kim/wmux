// ─── One room card ───────────────────────────────────────────────────────────
//
// One component for every card kind. A card is a row of the timeline: no box
// of its own (the timeline's hairlines split the rows), an 11px meta line
// (who · what · when; a bot author with its 16px avatar), the 13px title,
// the markdown body. Colour carries
// state only: an open question is the one bordered row (the needs-you
// hairline over the subtle fill) and holds the decision card that answers
// it; a failed verdict or a refusal colours its state word red, an exhausted
// budget yellow, a merge or a finished task its check green.
//
// An open proposal a bot posted takes Approve / Decline in place (both
// secondary: the HQ's plan holds the room's one primary), through
// room:resolve with the plan's answer words (the shared CardAnswers).
//
// An open question is answered in place through the DeckDecisionCard, whose
// reads and writes go to the room: the decision behind the card (its
// options) through room:decision, the answer through room:resolve — main
// resolves the decision, the handoff router delivers it and flips the card.
import { useMemo, useState } from 'react';
import type { RoomCard as RoomCardData } from '../../../shared/room';
import type { WorkspaceDecision } from '../../../main/deck/deckDecisionStore';
import { FOCUS_RING } from '../focusRing';
import { DeckDecisionCard, type DeckDecisionApi, type DeckDecisionStream } from '../Deck/DeckDecisionCard';
import { renderBrainMarkdown } from '../shared/BrainMarkdown';
import type { FactoryBotRow } from './factoryPorts';
import { actorLabel, cardTone, formatCardTime, kindLabel, ownerCardText, planTextWithNames, roleLabel, type IdLabels } from './roomFormat';
import { useApprovals } from './approvalsStore';
import BotAvatar from './BotAvatar';
import { roomsApi } from '../../hooks/useRoomSync';
import { focusPaneByPtyId } from '../../hooks/useNotificationListener';
import { useStore } from '../../stores';
import { ProposalAnswers, useWorkspaceNames } from './CardAnswers';
import { ApprovalAnswers } from './ApprovalAnswers';
import { OwnerRequestAnswers } from './OwnerRequestAnswers';
import type { RoomsApi } from '../../hooks/useRoomSync';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Bodies longer than this fold behind "Show more". */
const BODY_FOLD_CHARS = 360;

const NO_STREAM: DeckDecisionStream = () => () => undefined;

/** The decision card's api, bound to one question card: get = the decision
 *  behind it as main has it (a resolved or missing one shows no answer
 *  controls), resolve = room:resolve. */
export function questionDecisionApi(workspaceId: string, card: RoomCardData, api = roomsApi()): DeckDecisionApi | undefined {
  if (!api) return undefined;
  return {
    get: async () => {
      const r = await api.decision(workspaceId, card.id);
      const decision: WorkspaceDecision | null = 'decision' in r ? r.decision : null;
      return { decision };
    },
    resolve: async ({ resolution }) => {
      const r = await api.resolve({ workspaceId, cardId: card.id, resolution });
      return r.ok ? { ok: true } : { ok: false, code: r.code };
    },
  };
}

export { PROPOSAL_RESOLUTION } from './CardAnswers';

/** What the ids bots cite stand for: their tasks' titles, and the approval
 *  requests main holds. */
export function useIdLabels(bots: readonly FactoryBotRow[], t: T): IdLabels {
  const { byId } = useApprovals();
  const locale = useStore((s) => s.locale);
  return useMemo((): IdLabels => {
    const tasks = new Map<string, string>();
    for (const r of bots) for (const task of r.tasks ?? []) tasks.set(task.taskId, task.title);
    return {
      taskTitle: (id) => tasks.get(id) ?? null,
      approval: (id) => {
        const r = byId.get(id);
        if (!r) return null;
        return r.prNumber !== undefined ? t('botsPage.idLabel.approvalPr', { pr: r.prNumber }) : t('botsPage.idLabel.approval');
      },
    };
  }, [bots, byId, t, locale]);
}

export interface RoomCardProps {
  card: RoomCardData;
  workspaceId: string;
  t: T;
  bots: readonly FactoryBotRow[];
  /** The card this one answers, when it is loaded. */
  replyToCard?: RoomCardData | null;
  /** Tests: the decision card's api. */
  decisionApi?: DeckDecisionApi;
  /** Tests: the rooms bridge a proposal is answered through. */
  roomsBridge?: RoomsApi | null;
  /** A hairline under the row (the timeline leaves it out next to the
   *  bordered question row, which draws its own). */
  divider?: boolean;
  now?: number;
}

export function RoomCard({ card, workspaceId, t, bots, replyToCard, decisionApi, roomsBridge, divider = false, now }: RoomCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  // Whether the decision card has a pending decision to answer.
  const [answerable, setAnswerable] = useState(false);
  // Its first read finished (until then nothing is said about it).
  const [loaded, setLoaded] = useState(false);
  const openQuestion = card.kind === 'question' && card.state === 'open';
  const api = useMemo((): DeckDecisionApi | undefined => {
    const base = openQuestion ? decisionApi ?? questionDecisionApi(workspaceId, card) : undefined;
    if (!base) return undefined;
    return {
      ...base,
      get: async (ws) => {
        try {
          return await base.get(ws);
        } finally {
          setLoaded(true);
        }
      },
    };
  }, [openQuestion, decisionApi, workspaceId, card]);
  // The needs-you boundary: an open question still waiting on the owner
  // (until its decision is read, it is assumed to wait).
  const waitsOnOwner = (openQuestion && (answerable || !loaded)) || (card.kind === 'approval' && card.state === 'open');
  const actors = useStore((s) => s.roomActors);
  const tone = cardTone(card);
  // A plan names workspaces by name, never by id.
  const nameOf = useWorkspaceNames();
  const plan = card.kind === 'plan';
  const idLabels = useIdLabels(bots, t);
  const shown = ownerCardText(card, bots.map((b) => b.bot.name), idLabels, t);
  const title = plan ? planTextWithNames(shown.title, nameOf, t) : shown.title;
  const body = (plan ? planTextWithNames(shown.body, nameOf, t) : shown.body).trim();
  const foldable = body.length > BODY_FOLD_CHARS;
  // A fact is compact: its body only on demand. A long body is clamped
  // until it is opened.
  const showBody = !!body && (card.kind !== 'fact' || expanded);
  const time = formatCardTime(card.at, now);
  // A bot author's avatar: its profile when listed, else the role main
  // reported (initials of the role's label).
  const author = card.actor.kind === 'bot' ? card.actor : null;
  const authorRow = author ? bots.find((b) => b.bot.id === author.botId) : undefined;
  const authorRole = authorRow?.bot.role ?? (author ? actors[author.botId]?.role : undefined);

  return (
    <article
      data-testid="room-card"
      data-room-card-id={card.id}
      data-card-kind={card.kind}
      data-card-state={card.state ?? undefined}
      data-waits-on-owner={waitsOnOwner ? 'true' : undefined}
      data-seq={card.seq}
      aria-label={`${kindLabel(card.kind, t)}: ${title}`}
      className={waitsOnOwner
        ? 'my-1 px-3 py-2.5 rounded-[10px] border border-[var(--attention-hairline)] bg-[var(--selection-subtle)]'
        : `px-3 py-2${divider ? ' border-b border-[var(--stroke)]' : ''}`}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] min-w-0">
        {author && authorRole && (
          <BotAvatar
            bot={authorRow?.bot ?? {
              id: author.botId,
              name: actors[author.botId]?.name ?? roleLabel(authorRole, t),
              role: authorRole,
              ...(actors[author.botId]?.avatar ? { avatar: actors[author.botId]?.avatar } : {}),
            }}
            size={16}
            t={t}
          />
        )}
        <span className="truncate text-[var(--text-sub)]">{actorLabel(card.actor, t, bots, actors)}</span>
        <span aria-hidden="true">·</span>
        <span
          data-card-kind-word
          className={card.kind === 'refusal' ? 'text-[var(--accent-red)]'
            : card.kind === 'budget' ? 'text-[var(--accent-yellow)]'
              : waitsOnOwner ? 'text-[var(--attention-text)]' : undefined}
        >
          {kindLabel(card.kind, t)}
        </span>
        {tone && tone.word !== 'done' && (
          <span data-card-verdict={tone.word} className={tone.tone === 'danger' ? 'text-[var(--accent-red)]' : undefined}>
            {t(`room.verdict.${tone.word}`)}
          </span>
        )}
        {tone?.word === 'done' && (
          <svg
            data-card-done={tone.tone}
            aria-label={t('room.state.done')}
            width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"
            className={tone.tone === 'success' ? 'text-[var(--accent-green)]' : 'text-[var(--text-muted)]'}
          >
            <polyline points="2.5,6.5 5,9 9.5,3.5" />
          </svg>
        )}
        {card.state && card.kind !== 'question' && (
          <span data-card-state-word>{t(`room.state.${card.state}`)}</span>
        )}
        {card.kind === 'question' && card.state === 'resolved' && <span data-card-state-word>{t('room.state.answered')}</span>}
        <span className="ml-auto shrink-0 tabular-nums">{time}</span>
      </div>
      {card.replyTo && (
        <div data-card-reply-to={card.replyTo} className="mt-0.5 text-[11px] text-[var(--text-muted)] truncate">
          {replyToCard ? t('room.replyTo', { title: replyToCard.title }) : t('room.replyToEarlier')}
        </div>
      )}
      {openQuestion && api && (
        <div className={answerable ? 'mt-1.5' : 'hidden'}>
          <DeckDecisionCard api={api} onStream={NO_STREAM} workspaceId={workspaceId} onPendingChange={setAnswerable} bare t={t} />
        </div>
      )}
      {!(openQuestion && answerable) && (
        <>
          <div className={`mt-0.5 text-[13px] leading-snug break-words ${card.kind === 'fact' ? 'text-[var(--text-sub)]' : 'text-[var(--text-main)]'}`}>
            {title}
          </div>
          {showBody && (
            <div data-card-body className={`mt-1 text-[13px] leading-relaxed text-[var(--text-sub)] break-words ${foldable && !expanded ? 'line-clamp-6' : ''}`}>
              {renderBrainMarkdown(body, { links: true, richCode: true })}
            </div>
          )}
          {body && (card.kind === 'fact' || foldable) && (
            <button
              type="button"
              data-card-more
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
              className={`mt-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
            >
              {expanded ? t('room.showLess') : t('room.showMore')}
            </button>
          )}
          {card.refs?.ptyId && (
            <button
              type="button"
              data-card-jump={card.refs.ptyId}
              onClick={() => { focusPaneByPtyId(() => useStore.getState(), card.refs?.ptyId ?? ''); }}
              className={`mt-0.5 ml-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)] ${FOCUS_RING}`}
            >
              {t('room.jumpToPane')}
            </button>
          )}
          {card.kind === 'proposal' && card.state === 'open' && card.actor.kind === 'bot' && (
            <ProposalAnswers card={card} workspaceId={workspaceId} t={t} api={roomsBridge === undefined ? roomsApi() : roomsBridge} />
          )}
          {card.kind === 'approval' && <ApprovalAnswers card={card} t={t} />}
          <OwnerRequestAnswers card={card} t={t} />
          {openQuestion && loaded && (
            <p data-card-question-waiting className="mt-1 text-[11px] text-[var(--text-muted)]">{t('room.question.waiting')}</p>
          )}
        </>
      )}
    </article>
  );
}
