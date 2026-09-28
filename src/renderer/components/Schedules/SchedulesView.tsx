import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { Automation, AutomationRun } from '../../../shared/automation';
import {
  isLiveRun,
  isPermissionReset,
  latestRunByAutomation,
  orderSchedules,
} from '../../stores/selectors/schedules';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import { IconPlus, IconX } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { accountLabel, describeTrigger, folderName, formatWhen, runStateLabel } from './format';
import ScheduleDetail from './ScheduleDetail';
import ScheduleEditor from './ScheduleEditor';
import { openAutomationRun } from './openRun';
import { useAccounts, type AccountOption } from './useAccounts';

type EditorState = { mode: 'new' } | { mode: 'edit' | 'review'; automation: Automation } | null;

/**
 * Schedules — the main-area view behind the sidebar's Schedules row. A list
 * of schedules (drafts from agents on top) beside the selected schedule's
 * detail. Covers the pane grid without unmounting it, so no terminal is
 * resized by opening it.
 */
export default function SchedulesView() {
  const t = useT();
  const { automations, runs, selectedId } = useStore(useShallow((s) => ({
    automations: s.automations,
    runs: s.automationRuns,
    selectedId: s.schedulesSelectedId,
  })));
  const [editor, setEditor] = useState<EditorState>(null);
  const accounts = useAccounts();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Focus moves in on open and goes back where it came from on close (the
  // sidebar row, normally), so keyboard users are never left in covered panes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();
    return () => {
      const back = opener?.isConnected
        ? opener
        : document.querySelector<HTMLElement>('[data-sidebar-nav="schedules"]');
      back?.focus();
    };
  }, []);
  const ordered = useMemo(() => orderSchedules(automations), [automations]);
  const latest = useMemo(() => latestRunByAutomation(runs), [runs]);
  const selected = ordered.find((a) => a.id === selectedId) ?? null;

  const discard = async (a: Automation) => {
    const r = await window.electronAPI?.automation?.remove(a.id);
    if (r && !r.ok) useStore.getState().pushToast({ level: 'error', message: t('schedules.error', { error: r.error }) });
    void useStore.getState().refreshSchedules();
  };

  return (
    <section
      className="absolute inset-0 z-[5] flex flex-col bg-[var(--bg-base)] text-[var(--text-main)]"
      aria-label={t('schedules.title')}
      data-schedules-view
      onKeyDown={(e) => {
        // Portalled dialogs bubble here through React; only keys from the
        // view's own DOM close it.
        if (e.key !== 'Escape' || e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
        useStore.getState().closeSchedulesView();
      }}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--surface-hairline)] px-4">
        <h2 ref={headingRef} tabIndex={-1} className="flex-1 text-[14px] font-semibold outline-none">{t('schedules.title')}</h2>
        <Button variant="primary" size="sm" onClick={() => setEditor({ mode: 'new' })} data-schedules-new>
          <IconPlus size={12} /> {t('schedules.new')}
        </Button>
        <button
          type="button"
          className={`ui-icon-btn ${FOCUS_RING}`}
          aria-label={t('schedules.close')}
          onClick={() => useStore.getState().closeSchedulesView()}
        >
          <IconX size={14} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-wrap overflow-auto">
        <div className="min-w-[320px] flex-1 basis-[360px] p-4">
          {ordered.length === 0 ? (
            <p className="ui-note" data-schedules-empty>{t('schedules.empty')}</p>
          ) : (
            <ul className="ui-group" aria-label={t('schedules.title')}>
              {ordered.map((a) => (
                <ScheduleRow
                  key={a.id}
                  automation={a}
                  latest={latest.get(a.id)}
                  runs={runs}
                  accounts={accounts}
                  selected={a.id === selectedId}
                  onSelect={() => useStore.getState().selectSchedule(a.id)}
                  onReview={() => setEditor({ mode: 'review', automation: a })}
                  onDiscard={() => void discard(a)}
                />
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-[320px] flex-[2] basis-[480px] border-l border-[var(--surface-hairline)] p-4">
          {selected ? (
            <ScheduleDetail
              key={selected.id}
              automation={selected}
              accounts={accounts}
              onEdit={() => setEditor({ mode: selected.proposed ? 'review' : 'edit', automation: selected })}
            />
          ) : (
            <p className="ui-note">{t('schedules.detailEmpty')}</p>
          )}
        </div>
      </div>
      {editor && (
        <ScheduleEditor
          original={editor.mode === 'new' ? null : editor.automation}
          review={editor.mode === 'review'}
          accounts={accounts}
          onClose={() => setEditor(null)}
          onSaved={(id) => {
            setEditor(null);
            useStore.getState().selectSchedule(id);
          }}
        />
      )}
    </section>
  );
}

function ScheduleRow({ automation: a, latest, runs, accounts, selected, onSelect, onReview, onDiscard }: {
  automation: Automation;
  latest: AutomationRun | undefined;
  runs: AutomationRun[];
  accounts: AccountOption[];
  selected: boolean;
  onSelect: () => void;
  onReview: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const live = runs.find((r) => r.automationId === a.id && isLiveRun(r));
  const status = live
    ? runStateLabel(live.state)
    : a.proposed ? t('schedules.badgeProposed')
    : a.enabled ? t('schedules.statusOn') : t('schedules.statusOff');
  const next = a.enabled && a.nextRunAt !== null ? t('schedules.nextRun', { time: formatWhen(a.nextRunAt) }) : describeTrigger(a);
  const agent = a.action.agent === 'codex' ? t('schedules.agentCodex') : t('schedules.agentClaude');
  const account = accountLabel(a, accounts);
  const last = latest
    ? t('schedules.lastResult', { status: runStateLabel(latest.state), time: formatWhen(latest.endedAt ?? latest.startedAt ?? latest.scheduledFor) })
    : t('schedules.lastResultNone');

  let action: { label: string; run: () => void } | null = null;
  if (a.proposed) action = { label: t('schedules.actionReview'), run: onReview };
  else if (live?.ptyId) action = { label: t('schedules.actionOpen'), run: () => void openAutomationRun(live.id) };
  else if (latest?.hasSnapshot) action = { label: t('schedules.actionResult'), run: onSelect };

  return (
    <li className="ui-row" data-schedule-row={a.id} aria-current={selected ? 'true' : undefined}
      style={selected ? { background: 'var(--surface-fill-hover)' } : undefined}>
      <button type="button" className={`ui-row-text text-left ${FOCUS_RING}`} onClick={onSelect}>
        <span className="ui-row-title flex min-w-0 items-center gap-2">
          <span className="truncate">{[a.name, status, next].join(' · ')}</span>
          {a.proposed && <Badge>{t('schedules.badgeProposed')}</Badge>}
          {a.permission.mode === 'bypass' && <Badge>{t('schedules.badgeBypass')}</Badge>}
          {isPermissionReset(a) && <Badge>{t('schedules.badgePermissionReset')}</Badge>}
        </span>
        <span className="ui-row-detail truncate">
          {[folderName(a.action.cwd), `${agent} · ${account}`, last].join(' · ')}
        </span>
      </button>
      {action && (
        <Button variant="secondary" size="sm" onClick={action.run} data-schedule-action>
          {action.label}
        </Button>
      )}
      {a.proposed && (
        <Button variant="ghost" size="sm" onClick={onDiscard} data-schedule-discard>
          {t('schedules.discard')}
        </Button>
      )}
    </li>
  );
}
