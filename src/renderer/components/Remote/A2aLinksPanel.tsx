import type { ReactNode } from 'react';
import type { A2aLinkOfferRecordV1, A2aLinkRecordV1 } from '../../../shared/a2aRemote';
import type { A2aSpawnWorkerStatus } from '../../../shared/a2aSpawn';
import { formatResetClock } from '../../../shared/usageLimit';
import { getLocale } from '../../i18n';
import { StatusMarkView } from '../Sidebar/AgentMarks';
import type { Workspace } from '../../../shared/types';
import type { AgentSlug } from '../../../shared/events';
import UiButton from '../ui/Button';
import { IconElbow } from '../icons';
import { timeAgo } from '../../utils/timeAgo';
import { fingerprintPrefix } from '../Settings/A2aRemoteSection';
import { linkDirection, linkStateWord, localPaneName, remoteAlias, repoMismatch } from './a2aLinkModel';

// ─── Cross-PC pane links on the Remote page ──────────────────────────────────
//
// Two pure row views. A request another PC sent to one of this PC's panes
// sits in the page's Needs you block (accept / decline, with the evidence);
// a live link sits nested under its PC in the list (direction or waiting,
// Check, Unlink asking twice). Links that ended are not links any more and
// are not drawn.

type T = (key: string, vars?: Record<string, string | number>) => string;

const DIRECTION_KEY = { both: 'a2aLink.dirBoth', send: 'a2aLink.dirSend', receive: 'a2aLink.dirReceive', none: 'a2aLink.dirNone' } as const;

export interface LocalNames {
  workspaces: Workspace[];
  paneLabel?: Record<string, string>;
  surfaceAgent?: Record<string, { slug?: AgentSlug }>;
}

/** This PC's end of a link, named from the live store by the ids the link stores. */
export function localEndName(l: A2aLinkRecordV1, names: LocalNames, t: T): string {
  if (l.local.kind === 'brain') return t('a2aLink.thisMoa');
  const n = localPaneName(names.workspaces, l.local, names.paneLabel, names.surfaceAgent);
  return `${n.workspace} / ${n.pane}`;
}

/**
 * The other end, without the PC's name (the row already says it). A brain end
 * is named by the role that replaced Moa, the Coordinator.
 */
function theirEnd(l: A2aLinkRecordV1, t: T): string {
  if (l.remote.kind === 'brain') return t('room.role.moa');
  return `${l.remote.workspaceName ?? l.remote.workspaceId}/${l.remote.label ?? l.remote.paneId ?? ''}`;
}

export interface A2aLinkRequestRowProps {
  link: A2aLinkRecordV1;
  pcName: string;
  names: LocalNames;
  /** This PC's repo for the pane the request names, when known. */
  localRepo?: string;
  /** That PC's certificate fingerprint, when this PC joined it (the record keeps it). */
  fingerprint?: string | null;
  now: number;
  /** The page's one primary button is the first Accept. */
  primary: boolean;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  t: T;
}

export function A2aLinkRequestRow(p: A2aLinkRequestRowProps) {
  const { link: l, t } = p;
  const mine = localEndName(l, p.names, t);
  const theirs = l.remote.gitRemote;
  const moa = l.remote.kind === 'brain';
  const created = Date.parse(l.createdAt);
  return (
    <li className="wmux-remote-req" data-link-id={l.linkId} data-testid="a2a-link-request">
      <div className="wmux-remote-req-body">
        <span className="wmux-remote-req-title">
          <b>{p.pcName}</b>
          <span>{t(moa ? 'remotePage.needs.moaTitle' : 'remotePage.needs.linkTitle')}</span>
          {Number.isFinite(created) && <span className="wmux-remote-req-when">{timeAgo(created, p.now)}</span>}
        </span>
        <span className="wmux-remote-req-text">
          {moa
            ? t('remotePage.needs.moaSentence', { pc: p.pcName })
            : t('remotePage.needs.linkSentence', { pc: p.pcName, theirs: theirEnd(l, t), mine })}
        </span>
        <span className="wmux-remote-req-ev">
          <span data-testid="a2a-link-reported">{t('remotePage.needs.reported', { pc: p.pcName })}</span>
          {p.fingerprint && <span>{t('remotePage.needs.fingerprint')} <code className="ui-code">{fingerprintPrefix(p.fingerprint)}</code></span>}
          {theirs && p.localRepo && !repoMismatch(p.localRepo, theirs) && (
            <span data-testid="a2a-link-same-repo">{t('remotePage.needs.sameRepo', { repo: theirs })}</span>
          )}
          {theirs && !p.localRepo && <span className="ui-code">{theirs}</span>}
          <span>{t(DIRECTION_KEY[linkDirection(l.allow)])}</span>
        </span>
        {repoMismatch(p.localRepo, theirs) && (
          <p className="wmux-a2a-note" data-tone="warning" data-testid="a2a-link-request-mismatch">
            {t('a2aLink.repoMismatch', { mine: p.localRepo ?? '', theirs: theirs ?? '' })}
          </p>
        )}
      </div>
      <div className="wmux-remote-req-acts">
        <UiButton variant="ghost" size="md" disabled={p.busy} onClick={p.onReject}>{t('a2aLink.decline')}</UiButton>
        <UiButton variant={p.primary ? 'primary' : 'secondary'} size="md" disabled={p.busy} onClick={p.onAccept} data-testid="a2a-link-accept">
          {t('a2aLink.accept')}
        </UiButton>
      </div>
    </li>
  );
}

export interface A2aOfferRowProps {
  offer: A2aLinkOfferRecordV1;
  pcName: string;
  /** That PC's certificate fingerprint (this PC joined it, so it holds the pin). */
  fingerprint?: string | null;
  now: number;
  /** The page's one primary button is the first Accept. */
  primary: boolean;
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
  t: T;
}

/**
 * A pane another PC shared with this one (Needs you). Its names are that PC's
 * report. There is no pane picker on the row: Accept… opens the link dialog,
 * where this PC's pane is chosen.
 */
export function A2aOfferRow(p: A2aOfferRowProps) {
  const { offer: o, t } = p;
  const theirs = `${o.end.workspaceName}/${o.end.label ?? o.end.paneId ?? ''}`;
  const created = Date.parse(o.createdAt);
  const left = Math.max(0, Math.ceil((Date.parse(o.expiresAt) - p.now) / 60_000));
  return (
    <li className="wmux-remote-req" data-offer-id={o.offerId} data-testid="a2a-offer-request">
      <div className="wmux-remote-req-body">
        <span className="wmux-remote-req-title">
          <b>{p.pcName}</b>
          <span>{t('remotePage.needs.offerTitle')}</span>
          {Number.isFinite(created) && <span className="wmux-remote-req-when">{timeAgo(created, p.now)}</span>}
        </span>
        <span className="wmux-remote-req-text">{t('remotePage.needs.offerSentence', { pc: p.pcName, theirs })}</span>
        <span className="wmux-remote-req-ev">
          <span data-testid="a2a-offer-reported">{t('remotePage.needs.reported', { pc: p.pcName })}</span>
          {p.fingerprint && <span>{t('remotePage.needs.fingerprint')} <code className="ui-code">{fingerprintPrefix(p.fingerprint)}</code></span>}
          {o.end.agent && <span>{o.end.agent}</span>}
          {o.end.gitRemote && <span className="ui-code">{o.end.gitRemote}</span>}
          <span>{t(DIRECTION_KEY[linkDirection(o.allow)])}</span>
          <span data-testid="a2a-offer-expires">{t('remotePage.needs.offerExpires', { minutes: left })}</span>
        </span>
      </div>
      <div className="wmux-remote-req-acts">
        <UiButton variant="ghost" size="md" disabled={p.busy} onClick={p.onDecline}>{t('a2aLink.decline')}</UiButton>
        <UiButton variant={p.primary ? 'primary' : 'secondary'} size="md" disabled={p.busy} onClick={p.onAccept} data-testid="a2a-offer-accept">
          {t('a2aOffer.acceptOpen')}
        </UiButton>
      </div>
    </li>
  );
}

export interface A2aShareRowProps {
  offer: A2aLinkOfferRecordV1;
  pcName: string;
  busy: boolean;
  onWithdraw: () => void;
  /** Why the last Withdraw failed, under the row. */
  error?: ReactNode;
  t: T;
}

/**
 * One of this PC's panes shared with that PC, nested under it: it waits on
 * the other PC, not on this one, so it is neutral (no hairline, no count).
 */
export function A2aShareRow(p: A2aShareRowProps) {
  const { offer: o, t } = p;
  return (
    <li className="wmux-remote-link" data-offer-id={o.offerId} data-testid="a2a-share-row">
      <span className="wmux-remote-link-ln" aria-hidden="true"><IconElbow size={16} /></span>
      <span className="wmux-remote-link-what">
        {`${o.end.workspaceName} / ${o.end.label ?? o.end.paneId ?? ''} → ${p.pcName} · ${t('a2aShare.waiting', { pc: p.pcName })}`}
      </span>
      {/* A claimed share is being turned into a link; it can no longer be withdrawn. */}
      {o.state === 'open' && (
        <span className="wmux-remote-acts">
          <UiButton variant="ghost" size="sm" disabled={p.busy} onClick={p.onWithdraw} data-testid="a2a-share-row-withdraw">{t('a2aShare.withdraw')}</UiButton>
        </span>
      )}
      {p.error}
    </li>
  );
}

export interface A2aLinkRowProps {
  link: A2aLinkRecordV1;
  pcName: string;
  names: LocalNames;
  confirming: boolean;
  busy: boolean;
  onCheck: () => void;
  onAskUnlink: () => void;
  onCancelUnlink: () => void;
  onUnlink: () => void;
  /** A link to an agent this PC started there: what that agent is doing now (`status.1`). */
  worker?: A2aSpawnWorkerStatus;
  t: T;
}

/**
 * A started agent's status as one short phrase with the sidebar's mark: a
 * question is the needs-you ring in the attention colour; working a dot; an
 * answer waiting for more a check; a usage limit the muted clock; gone no mark.
 */
export function WorkerStatusCell({ status, now, t }: { status: A2aSpawnWorkerStatus; now: number; t: T }) {
  const resets = status.resetsAt ? Date.parse(status.resetsAt) : NaN;
  const word = status.kind === 'working'
    ? (status.background ? t('remotePage.worker.workingBackground', { count: status.background }) : t('remotePage.worker.working'))
    : status.kind === 'waiting-input' ? t('remotePage.worker.waitingInput')
      : status.kind === 'question' ? t(`remotePage.worker.question.${status.question ?? 'dialog'}`)
        : status.kind === 'usage-limit'
          ? (Number.isNaN(resets) ? t('remotePage.worker.usageLimit') : t('remotePage.worker.usageLimitResets', { clock: formatResetClock(resets, now, getLocale()) }))
          : t('remotePage.worker.gone');
  const mark = status.kind === 'question' ? 'awaiting_input' : status.kind === 'waiting-input' ? 'complete' : status.kind === 'gone' ? 'idle' : 'running';
  return (
    <span className="wmux-remote-worker" data-worker-status={status.kind} data-attention={status.kind === 'question' ? 'true' : undefined}>
      <StatusMarkView status={mark} usageWaiting={status.kind === 'usage-limit'} neutralRunning quiet />
      <span className="truncate">{word}</span>
    </span>
  );
}

/** One live link, nested under its PC: `mine ↔ PC/theirs · direction or waiting`. */
export function A2aLinkRow(p: A2aLinkRowProps) {
  const { link: l, t } = p;
  const word = linkStateWord(l.state);
  return (
    <li className="wmux-remote-link" data-link-id={l.linkId} data-state={word} data-testid="a2a-link-row" data-worker={p.worker ? 'true' : undefined}>
      <span className="wmux-remote-link-ln" aria-hidden="true"><IconElbow size={16} /></span>
      <span className="wmux-remote-link-what">
        {`${localEndName(l, p.names, t)} ↔ ${remoteAlias(p.pcName, l.remote, t('room.role.moa'))} · `}
        {word === 'pending' ? t('remotePage.linkWaiting', { pc: p.pcName }) : t(DIRECTION_KEY[linkDirection(l.allow)])}
      </span>
      {p.worker && <WorkerStatusCell status={p.worker} now={Date.now()} t={t} />}
      <span className="wmux-remote-acts">
        {p.confirming ? (
          <>
            <span className="wmux-remote-confirm">{t('remotePage.unlinkAsk')}</span>
            <UiButton variant="ghost" size="sm" onClick={p.onCancelUnlink} autoFocus>{t('a2aLink.keep')}</UiButton>
            <UiButton variant="danger" size="sm" disabled={p.busy} onClick={p.onUnlink}>{t('a2aLink.unlink')}</UiButton>
          </>
        ) : (
          <>
            {word === 'pending' && l.proposer === 'local' && (
              <UiButton variant="ghost" size="sm" disabled={p.busy} onClick={p.onCheck}>{t('a2aLink.check')}</UiButton>
            )}
            <UiButton variant="ghost" size="sm" disabled={p.busy} onClick={p.onAskUnlink}>{t('a2aLink.unlink')}</UiButton>
          </>
        )}
      </span>
    </li>
  );
}
