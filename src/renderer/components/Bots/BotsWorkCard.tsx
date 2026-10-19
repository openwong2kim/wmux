// ─── Work a conversation handed off, as one card ─────────────────────────
//
// Owner decision 2026-10-16 (DESIGN.md › Bots › Threads): a thread the
// conversation started shows as one work card inside the delegating bot's
// run — a 14px-radius card whose only boundary is a `--line` hairline, no
// fill. Folded: who it was handed to and the state (colour on the state
// only), the request's words, the delegate's newest message (two lines at
// most), and the PR or issue chip, "N steps · last 15:12" and Show steps.
// Expanded in place: the folded cards as one-line steps, then Open thread
// (the side panel) and Hide steps — the one toggle while it is open, so the
// foot's row keeps only the chip and the count. Whether a card is expanded is kept for
// the session only, in memory; a card starts folded.
import { useEffect, useId, useRef, useState } from 'react';
import type { BotProfile } from '../../../shared/bot';
import type { RoomCard } from '../../../shared/room';
import { FOCUS_RING } from '../focusRing';
import { IconChevron } from '../icons';
import BotAvatar from '../Room/BotAvatar';
import { kindLabel } from '../Room/roomFormat';
import { clockTime, fullTime } from './botsTimeline';
import type { WorkState, WorkThread, WorkView } from './botsWork';

type T = (key: string, vars?: Record<string, string | number>) => string;
type Face = Pick<BotProfile, 'id' | 'name' | 'role' | 'avatar'>;

/** The work cards expanded this session (by workspace and thread). */
const expanded = new Set<string>();

function workKey(work: WorkThread): string {
  return `${work.workspaceId}\u0000${work.threadId}`;
}

/** The state in words. */
export function workStateText(state: WorkState, t: T): string {
  switch (state) {
    case 'working': return t('botsPage.work.working');
    case 'review': return t('botsPage.work.review');
    case 'needsYou': return t('botsPage.work.needsYou');
    case 'done': return t('botsPage.worker.done');
    case 'failed': return t('botsPage.worker.failed');
    case 'cancelled': return t('taskStatus.cancelled');
  }
}

/** The state's mark: a steady muted dot while it runs or waits for review,
 *  the needs-you dot, a success check, a danger cross; none when cancelled. */
function StateMark({ state }: { state: WorkState }) {
  if (state === 'cancelled') return null;
  if (state === 'done') {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent-green)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
        <path d="M2 5.2 4.1 7.3 8 3" />
      </svg>
    );
  }
  if (state === 'failed') {
    return (
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="var(--accent-red)" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className="shrink-0">
        <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" />
      </svg>
    );
  }
  return <span aria-hidden="true" className="wmux-bots-work-dot" style={{ background: state === 'needsYou' ? 'var(--attention)' : 'var(--text-muted)' }} />;
}

function stateClass(state: WorkState): string | undefined {
  if (state === 'needsYou') return 'text-[var(--attention-text)]';
  if (state === 'failed') return 'text-[var(--accent-red)]';
  return undefined;
}

/** One folded card as a step: its time, its bot's face (a system line's
 *  neutral dot), and its owner-facing title on one line; a refusal's or a
 *  budget's kind word and a gate failure keep their colour. */
function Step({ card, face, text, t }: { card: RoomCard; face: Face | null; text: string; t: T }) {
  const word = card.kind === 'refusal' || card.kind === 'budget' ? kindLabel(card.kind, t) : null;
  const gateFailed = card.notice?.code === 'gate.failed' || card.notice?.code === 'gate.killed';
  return (
    <li className="wmux-bots-work-step" data-bots-work-step={card.id} title={fullTime(card.at)}>
      <span className="shrink-0 tabular-nums text-[11px] text-[var(--text-muted)]">{clockTime(card.at)}</span>
      <span className="wmux-bots-work-step-face">
        {face ? <BotAvatar bot={face} size={16} /> : <span aria-hidden="true" className="wmux-bots-work-dot" style={{ background: 'var(--text-muted)' }} />}
      </span>
      <span className="min-w-0 truncate">
        {word && <span className={card.kind === 'refusal' ? 'text-[var(--accent-red)]' : 'text-[var(--accent-yellow)]'}>{`${word} `}</span>}
        <span className={gateFailed ? 'text-[var(--accent-red)]' : undefined}>{text}</span>
      </span>
    </li>
  );
}

export interface BotsWorkCardProps {
  work: WorkThread;
  view: WorkView;
  t: T;
  /** A bot's face (null: unknown or not a bot). */
  faceOf: (botId: string) => Face | null;
  /** A bot's name as the chat shows it. */
  nameOf: (botId: string) => string;
  /** A card's owner-facing title, one line. */
  textOf: (card: RoomCard) => string;
  /** The PR or issue chip, when the work is about one. */
  refChip?: React.ReactNode;
  onOpenThread: () => void;
}

export default function BotsWorkCard({ work, view, t, faceOf, nameOf, textOf, refChip, onOpenThread }: BotsWorkCardProps): React.ReactElement {
  const key = workKey(work);
  const [open, setOpen] = useState(() => expanded.has(key));
  const toggleRef = useRef<HTMLButtonElement>(null);
  const hideRef = useRef<HTMLButtonElement>(null);
  // A toggle the owner pressed hands focus to the one that replaces it.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    (open ? hideRef : toggleRef).current?.focus();
  }, [open]);
  const stepsId = useId();
  const set = (next: boolean) => {
    if (next) expanded.add(key);
    else expanded.delete(key);
    setOpen(next);
  };
  const delegate = view.delegateId ? faceOf(view.delegateId) : null;
  const name = view.delegateId ? nameOf(view.delegateId) : '';
  const state = workStateText(view.state, t);
  const steps = work.steps.length;
  const count = steps === 1
    ? t('botsPage.work.stepsOne', { time: clockTime(view.lastAt) })
    : t('botsPage.work.steps', { count: steps, time: clockTime(view.lastAt) });
  const latest = view.latest ? textOf(view.latest) : '';
  return (
    <div className="wmux-bots-work" data-bots-work={work.threadId} data-work-state={view.state}>
      <div className="wmux-bots-work-meta">
        {delegate && <BotAvatar bot={delegate} size={16} />}
        {name && <span className="min-w-0 truncate">{t('botsPage.work.handedTo', { name })}</span>}
        {name && <span aria-hidden="true">·</span>}
        <StateMark state={view.state} />
        <span data-bots-work-state className={`shrink-0 ${stateClass(view.state) ?? ''}`}>{state}</span>
      </div>
      <div className="wmux-bots-work-title" data-bots-work-title>{view.title ?? t('room.thread.handoff')}</div>
      {latest && <div className="wmux-bots-work-latest" data-bots-work-latest title={fullTime(view.latest!.at)}>{latest}</div>}
      <div className="wmux-bots-work-foot">
        {refChip}
        <span className="min-w-0 truncate tabular-nums" title={fullTime(view.lastAt)}>{count}</span>
        {!open && (
          <button
            ref={toggleRef}
            type="button"
            data-bots-work-toggle
            aria-expanded={false}
            onClick={() => { refocus.current = true; set(true); }}
            className={`wmux-bots-work-toggle ${FOCUS_RING}`}
          >
            {t('botsPage.work.show')}
            <span aria-hidden="true" className="wmux-bots-work-chevron"><IconChevron size={10} /></span>
          </button>
        )}
      </div>
      {open && (
        <div id={stepsId} className="wmux-bots-work-steps" data-bots-work-steps>
          <ol aria-label={t('botsPage.work.stepsLabel', { title: view.title ?? t('room.thread.handoff') })}>
            {work.steps.map((c) => (
              <Step key={c.id} card={c} face={c.actor.kind === 'bot' ? faceOf(c.actor.botId) : null} text={textOf(c)} t={t} />
            ))}
          </ol>
          <div className="wmux-bots-work-steps-foot">
            <button type="button" data-bots-work-open onClick={onOpenThread} className={`wmux-bots-work-link ${FOCUS_RING}`}>{t('botsPage.work.openThread')}</button>
            <button
              ref={hideRef}
              type="button"
              data-bots-work-hide
              aria-expanded
              aria-controls={stepsId}
              onClick={() => { refocus.current = true; set(false); }}
              className={`wmux-bots-work-toggle ${FOCUS_RING}`}
            >
              {t('botsPage.work.hide')}
              <span aria-hidden="true" className="wmux-bots-work-chevron is-open"><IconChevron size={10} /></span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
