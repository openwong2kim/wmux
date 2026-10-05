// Delegated work as task cards (WorkLinks, docs/work-links.md). One line per
// card at rest: the title, its state, the workspace doing it. Expanding a card
// shows what hangs off it: the decisions it raised that still wait, the A2A
// task's state, and the PR. Colour carries state only: needs-you is yellow,
// blocked is red, everything else stays neutral.
// Work Moa handed off (origin moa / moa-auto) also shows the worker's last
// question (untrusted agent text, plain text only) and a way to its pane.
import { useState } from 'react';
import type { MoaPendingDecision } from '../../../../shared/moa';
import type { WorkLink } from '../../../../shared/workLink';
import { IconChevron } from '../../icons';
import { FOCUS_RING } from '../../focusRing';

type T = (key: string, vars?: Record<string, string | number>) => string;

const STATE_CLASS: Partial<Record<WorkLink['state'], string>> = {
  'needs-you': 'text-[var(--accent-yellow)]',
  blocked: 'text-[var(--accent-red)]',
};

/** Open a PR in the browser (the shell's external-link boundary). */
export function openPrExternally(url: string): void {
  void window.electronAPI?.shell?.openExternal?.(url);
}

export function MoaTaskCards({
  links,
  pendingDecisions,
  workspaceName,
  onOpenPr = openPrExternally,
  conversationTaskId,
  onOpenConversation,
  onOpenPane,
  t,
}: {
  links: readonly WorkLink[];
  pendingDecisions: readonly MoaPendingDecision[];
  workspaceName: (id: string) => string | undefined;
  onOpenPr?: (url: string) => void;
  /** The fan-out task (WorkTask id) a workspace runs, when it is one. */
  conversationTaskId?: (workspaceId: string) => string | undefined;
  /** Show that task's conversation in Fleet. */
  onOpenConversation?: (taskId: string) => void;
  /** Focus the pane doing the work. */
  onOpenPane?: (workspaceId: string, paneId?: string) => void;
  t: T;
}): React.ReactElement | null {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  if (links.length === 0) return null;
  const pendingById = new Map(pendingDecisions.map((d) => [d.decision.id, d]));
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <section data-moa-tasks aria-labelledby="moa-tasks-title" className="px-3 pt-2 pb-1">
      <h3 id="moa-tasks-title" className="m-0 mb-1 text-[13px] font-medium text-[var(--text-main)]">
        {t('moa.panel.tasksTitle')}
      </h3>
      <ul className="m-0 p-0 list-none flex flex-col">
        {links.map((link) => {
          const open = expanded.has(link.id);
          const regionId = `moa-task-${link.id}`;
          const decisions = link.decisionIds.map((id) => pendingById.get(id)).filter((d): d is MoaPendingDecision => !!d);
          const owner = workspaceName(link.owner.workspaceId) || t('moa.panel.unknownWorkspace');
          const taskId = onOpenConversation ? conversationTaskId?.(link.owner.workspaceId) : undefined;
          const fromMoa = link.origin === 'moa' || link.origin === 'moa-auto';
          const a2aId = fromMoa && !taskId ? link.a2aTaskId : undefined;
          return (
            <li key={link.id} data-moa-task={link.id} data-state={link.state}>
              {/* Disclosure: focus stays on this button when it opens; the
                  details follow it in reading order. */}
              <button
                type="button"
                aria-expanded={open}
                aria-controls={regionId}
                onClick={() => toggle(link.id)}
                data-moa-task-toggle
                className={`w-full flex items-start gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-[var(--hover-fill)] transition-colors ${FOCUS_RING}`}
              >
                <span aria-hidden="true" className={`mt-[3px] shrink-0 text-[var(--text-muted)] transition-transform ${open ? 'rotate-90' : ''}`}>
                  <IconChevron size={12} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="min-w-0 truncate text-[13px] text-[var(--text-main)]">
                      {link.title || t('moa.panel.untitledTask')}
                    </span>
                    {link.origin === 'moa-auto' && (
                      <span className="shrink-0 rounded px-1 text-[10px] leading-[14px] text-[var(--text-sub)] border border-[var(--line)]" data-moa-task-auto>
                        {t('moa.panel.autoTag')}
                      </span>
                    )}
                  </span>
                  <span className="block text-[11px] text-[var(--text-sub)] truncate">
                    <span className={STATE_CLASS[link.state]} data-moa-task-state>{t(`moa.panel.state.${link.state}`)}</span>
                    {' · '}
                    {owner}
                  </span>
                </span>
              </button>
              {open && (
                <div id={regionId} role="region" aria-label={link.title || t('moa.panel.untitledTask')} data-moa-task-details className="pl-6 pr-1.5 pb-2 flex flex-col gap-1 text-[12px] text-[var(--text-sub)]">
                  {decisions.length > 0 && (
                    <ul className="m-0 p-0 list-none flex flex-col gap-0.5" data-moa-task-decisions>
                      {decisions.map((d) => (
                        <li key={d.decision.id} className="text-[var(--text-main)] break-words">
                          <span className="text-[var(--accent-yellow)]">{t('moa.panel.decisionWaiting')}</span>{' '}
                          {d.decision.question}
                        </li>
                      ))}
                    </ul>
                  )}
                  {link.a2aState && (
                    <div data-moa-task-a2a>{t('moa.panel.a2aLine', { state: t(`moa.panel.a2a.${link.a2aState}`) })}</div>
                  )}
                  {fromMoa && link.lastQuestion && (
                    <div data-moa-task-last-question className="max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words">
                      {t('moa.panel.lastQuestion', { text: link.lastQuestion.text })}
                    </div>
                  )}
                  {link.pr && (
                    <div data-moa-task-pr className="flex items-center gap-1.5 min-w-0">
                      {link.pr.url ? (
                        <button
                          type="button"
                          onClick={() => onOpenPr(link.pr!.url!)}
                          className={`text-[var(--accent)] hover:underline underline-offset-2 ${FOCUS_RING}`}
                          data-moa-task-pr-link
                        >
                          {t('moa.panel.prLabel', { number: link.pr.number })}
                        </button>
                      ) : (
                        <span>{t('moa.panel.prLabel', { number: link.pr.number })}</span>
                      )}
                      {link.prStatus && (
                        <span className="truncate">
                          {t(`moa.panel.prState.${link.prStatus.state}`)}
                          {link.prStatus.checks ? ` · ${t(`moa.panel.checks.${link.prStatus.checks}`)}` : ''}
                        </span>
                      )}
                    </div>
                  )}
                  {taskId && (
                    <button
                      type="button"
                      onClick={() => onOpenConversation?.(taskId)}
                      className={`self-start text-[var(--accent)] hover:underline underline-offset-2 ${FOCUS_RING}`}
                      data-moa-task-conversation
                    >
                      {t('moa.panel.openConversation')}
                    </button>
                  )}
                  {a2aId && (
                    <div data-moa-task-a2a-id className="min-w-0 break-all">
                      {t('moa.panel.a2aTaskId')}{' '}
                      <span className="select-all font-mono text-[11px] text-[var(--text-main)]">{a2aId}</span>
                    </div>
                  )}
                  {fromMoa && onOpenPane && (
                    <button
                      type="button"
                      onClick={() => onOpenPane(link.owner.workspaceId, link.owner.paneId)}
                      className={`self-start text-[var(--accent)] hover:underline underline-offset-2 ${FOCUS_RING}`}
                      data-moa-task-open-pane
                    >
                      {t('moa.panel.openPane')}
                    </button>
                  )}
                  {decisions.length === 0 && !link.a2aState && !link.pr && !taskId && !a2aId && !(fromMoa && (onOpenPane || link.lastQuestion)) && (
                    <div>{t('moa.panel.taskNoDetails')}</div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
