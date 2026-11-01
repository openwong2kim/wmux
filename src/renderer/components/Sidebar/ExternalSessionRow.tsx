// One session started outside wmux, drawn with the roster row's recipe
// (WorkspaceAgentRoster.tsx): status mark, title, a muted kind word, the live
// activity or where it runs, the time since its last signal. In a workspace's
// roster the kind slot says `outside`; in the "Outside wmux" group, where the
// group already says so, it names a non-Claude agent and the folder rides a
// second line. A click opens the detail card — there is no pane to jump to.
import { useCallback, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { StatusMarkView } from './AgentMarks';
import { AGENT_STATUS_ICON } from './agentStatusIcon';
import { rosterShowsAgentKind } from './WorkspaceAgentRoster';
import { externalAgentStatus, externalWhereShort } from './externalSessionPlacement';
import { ExternalSessionCard, EXTERNAL_SESSION_CARD_WIDTH, openPaneInSessionFolder } from './ExternalSessionPopover';
import { displayPath } from '../../utils/displayPath';
import { formatIdle, IDLE_SHOW_AFTER_MS } from '../../utils/idleTime';
import { agentSlugToDisplay } from '../../../shared/agentIdentity';
import type { ExternalSession } from '../../../shared/externalSessions';
import type { TranslationKey } from '../../i18n/locales/en';

type Anchor = { top: number; left: number; right: number; bottom: number };

export default function ExternalSessionRow({ session, workspaceId, now }: {
  session: ExternalSession;
  /** The workspace whose roster holds the row; undefined in the "Outside wmux" group. */
  workspaceId?: string;
  now: number;
}) {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const hideExternalSession = useStore((s) => s.hideExternalSession);
  const rowRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setAnchor(null);
    if (restoreFocus) rowRef.current?.focus();
  }, []);

  const inRoster = workspaceId !== undefined;
  const status = externalAgentStatus(session.state);
  const ended = session.state === 'ended';
  const agentName = agentSlugToDisplay(session.agent);
  const title = session.title?.trim() || agentName;
  const kindWord = inRoster
    ? t('externalSessions.outside')
    : rosterShowsAgentKind({ surfaceTitle: session.title?.trim() ?? '', slug: session.agent, agentName }) ? agentName : undefined;
  const where = externalWhereShort(session.where);
  const activity = session.state === 'running' ? session.lastActivity?.trim() || undefined : undefined;
  const trailer = ended ? t('externalSessions.ended') : activity ?? where;
  const sinceMs = now - (session.endedAt ?? session.lastSignalAt);
  // A running session is moving; how long since its last signal says
  // something only once it stopped.
  const elapsed = session.state !== 'running' && sinceMs >= IDLE_SHOW_AFTER_MS ? formatIdle(sinceMs) : undefined;
  const question = session.state === 'needs-you' ? session.pendingQuestion?.trim() || undefined : undefined;
  const folder = inRoster ? undefined : displayPath(session.cwd);
  const statusLabel = ended ? t('externalSessions.ended') : t(AGENT_STATUS_ICON[status].labelKey as TranslationKey);
  const rowLabel = [
    title,
    agentName !== title ? agentName : undefined,
    t('externalSessions.outsideWmux'),
    statusLabel,
    activity ?? where,
    elapsed,
    question,
    folder,
    t('externalSessions.showDetails'),
  ].filter(Boolean).join(', ');

  return (
    <div className="min-w-0" data-external-session={session.id}>
      <button
        ref={rowRef}
        type="button"
        draggable={false}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-[3px] text-left transition-colors ${FOCUS_RING} ${
          anchor
            // Pressed while its card is open (DESIGN.md: an open control is
            // the emphasis fill, never colour).
            ? 'bg-[var(--selection-emphasis)] [--text-muted:var(--text-sub)] text-[var(--text-main)]'
            : 'text-[var(--text-sub)] hover:bg-[var(--hover-fill)] hover:text-[var(--text-main)]'
        }`}
        title={rowLabel}
        aria-label={rowLabel}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        data-testid="sidebar-external-row"
        data-agent-slug={session.agent}
        data-external-state={session.state}
        onClick={(event) => {
          // The workspace row under it selects on click; this row only opens its card.
          event.stopPropagation();
          if (anchor) { setAnchor(null); return; }
          const r = event.currentTarget.getBoundingClientRect();
          // Beside the row, on the side facing the content, level with it.
          const left = sidebarPosition === 'right' ? r.left - 8 - EXTERNAL_SESSION_CARD_WIDTH : r.right + 8;
          setAnchor({ top: r.top, bottom: r.top - 4, left, right: left + EXTERNAL_SESSION_CARD_WIDTH });
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onDragStart={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <StatusMarkView status={status} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className={`min-w-0 flex-1 truncate text-[11px] ${ended ? 'font-medium text-[var(--text-muted)]' : 'font-semibold text-[var(--text-main)]'}`}>
            {title}
          </span>
          {kindWord && (
            <span className="max-w-[35%] flex-none truncate text-[11px] text-[var(--text-muted)]" data-external-kind>
              {kindWord}
            </span>
          )}
          {trailer && (
            <>
              <span className="flex-none text-[11px] text-[var(--text-muted)]">·</span>
              {/* Where it runs is machine evidence (mono, like the roster's
                  coordinate); live activity and the ended word are not. */}
              <span className={`min-w-0 max-w-[55%] flex-none truncate text-[11px] text-[var(--text-muted)] ${!activity && !ended ? 'font-mono' : ''}`} data-external-trailer>
                {trailer}
              </span>
            </>
          )}
        </span>
        {elapsed && (
          <span className="flex-none whitespace-nowrap text-[11px] font-mono tabular-nums text-[var(--text-muted)]" data-external-elapsed>
            {elapsed}
          </span>
        )}
      </button>
      {/* What it asks, in the attention colour, only while it waits. */}
      {question && (
        <div className={`truncate ${inRoster ? 'pl-[37px]' : 'pl-5'} pr-1 text-[11px] text-[var(--attention-text)]`} title={question}>
          ? {question}
        </div>
      )}
      {folder && (
        <div className="truncate pl-5 pr-1 font-mono text-[11px] text-[var(--text-muted)]" title={folder} data-external-folder>
          {folder}
        </div>
      )}
      {anchor && (
        <ExternalSessionCard
          session={session}
          inWorkspace={inRoster}
          anchor={anchor}
          triggerRef={rowRef}
          now={now}
          onClose={close}
          onOpenPane={() => {
            setAnchor(null);
            openPaneInSessionFolder(session, workspaceId);
          }}
          onHide={() => {
            setAnchor(null);
            void hideExternalSession(session.id);
          }}
        />
      )}
    </div>
  );
}
