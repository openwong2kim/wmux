import type { A2aLinkRecordV1 } from '../../../shared/a2aRemote';
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

/** The other end, without the PC's name (the row already says it). */
function theirEnd(l: A2aLinkRecordV1): string {
  if (l.remote.kind === 'brain') return 'Moa';
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
            : t('remotePage.needs.linkSentence', { pc: p.pcName, theirs: theirEnd(l), mine })}
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
  t: T;
}

/** One live link, nested under its PC: `mine ↔ PC/theirs · direction or waiting`. */
export function A2aLinkRow(p: A2aLinkRowProps) {
  const { link: l, t } = p;
  const word = linkStateWord(l.state);
  return (
    <li className="wmux-remote-link" data-link-id={l.linkId} data-state={word} data-testid="a2a-link-row">
      <span className="wmux-remote-link-ln" aria-hidden="true"><IconElbow size={16} /></span>
      <span className="wmux-remote-link-what">
        {`${localEndName(l, p.names, t)} ↔ ${remoteAlias(p.pcName, l.remote)} · `}
        {word === 'pending' ? t('remotePage.linkWaiting', { pc: p.pcName }) : t(DIRECTION_KEY[linkDirection(l.allow)])}
      </span>
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
