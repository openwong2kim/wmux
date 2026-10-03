import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { Automation, AutomationRun } from '../../../shared/automation';
import { isLiveRun, isPermissionReset, orderSchedules } from '../../stores/selectors/schedules';
import Badge from '../ui/Badge';
import { Icon, IconClock, IconPlus } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { describeTrigger, formatWhen, runStateLabel } from './format';
import ScheduleDetail from './ScheduleDetail';
import ScheduleEditor from './ScheduleEditor';
import { SCHEDULE_TEMPLATES, emptyForm, formFromTemplate, type ScheduleForm, type ScheduleTemplate } from './scheduleModel';
import { useAccounts } from './useAccounts';
import { workspaceProbeCwd } from '../../utils/projectConfigProbe';

type Pane =
  | { mode: 'new'; initial?: ScheduleForm; seq: number }
  | { mode: 'edit' | 'review'; automation: Automation }
  | null;

/**
 * Schedules — a rail page. The list of schedules on the left (drafts from
 * agents first); on the right the selected schedule, the composer, or —
 * with nothing selected — an empty state of templates to start from.
 */
export default function SchedulesView() {
  const t = useT();
  const { automations, runs, selectedId } = useStore(useShallow((s) => ({
    automations: s.automations,
    runs: s.automationRuns,
    selectedId: s.schedulesSelectedId,
  })));
  // A new schedule runs in the folder of the workspace you were in.
  const defaultCwd = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
    return (ws && workspaceProbeCwd(ws)) ?? '';
  });
  const [pane, setPane] = useState<Pane>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState('');
  const accounts = useAccounts();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Focus moves in on open and goes back where it came from on close (the
  // rail item, normally), so keyboard users are never left in covered panes.
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
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? ordered.filter((a) => a.name.toLowerCase().includes(q)) : ordered;
  }, [ordered, query]);
  const selected = ordered.find((a) => a.id === selectedId) ?? null;

  const discard = async (a: Automation) => {
    const r = await window.electronAPI?.automation?.remove(a.id);
    if (r && !r.ok) useStore.getState().pushToast({ level: 'error', message: t('schedules.error', { error: r.error }) });
    useStore.getState().selectSchedule(null);
    void useStore.getState().refreshSchedules();
  };
  // Each New / template click starts a fresh composer (its own key).
  const newSeq = useRef(0);
  const startNew = (initial?: ScheduleForm) => setPane({
    mode: 'new',
    seq: ++newSeq.current,
    initial: initial ?? { ...emptyForm(), cwd: defaultCwd },
  });
  const startTemplate = (tpl: ScheduleTemplate) => startNew(formFromTemplate(
    tpl, t(`schedules.tpl.${tpl.id}.title`), t(`schedules.tpl.${tpl.id}.prompt`), defaultCwd,
  ));

  return (
    <section
      className="ui-surface wmux-schedules absolute inset-0 z-[5] flex bg-[var(--bg-base)] text-[var(--text-main)]"
      aria-label={t('schedules.title')}
      data-schedules-view
      onKeyDown={(e) => {
        // Portalled dialogs bubble here through React; only keys from the
        // view's own DOM leave the page.
        if (e.key !== 'Escape' || e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
        useStore.getState().closeSchedulesView();
      }}
    >
      <aside className="wmux-schedules-list" aria-label={t('schedules.title')}>
        <div className="wmux-schedules-list-head">
          <h2 ref={headingRef} tabIndex={-1} className="wmux-schedules-list-title">{t('schedules.title')}</h2>
          <button
            type="button"
            className={`ui-icon-btn ${FOCUS_RING}`}
            aria-label={t('schedules.filter')}
            title={t('schedules.filter')}
            aria-pressed={filterOpen}
            onClick={() => { setFilterOpen((v) => !v); setQuery(''); }}
            data-schedules-filter
          >
            <Icon size={14}><path d="M2 3.5h10M4 7h6M6 10.5h2" /></Icon>
          </button>
        </div>
        {filterOpen && (
          <input
            className="wmux-schedules-filter"
            type="search"
            autoFocus
            value={query}
            placeholder={t('schedules.filter')}
            aria-label={t('schedules.filter')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }}
          />
        )}
        <button
          type="button"
          className={`wmux-schedules-row wmux-schedules-new ${FOCUS_RING}`}
          aria-pressed={pane?.mode === 'new'}
          onClick={() => startNew()}
          data-schedules-new
        >
          <IconPlus size={14} />
          <span>{t('schedules.new')}</span>
        </button>
        <ul className="wmux-schedules-rows">
          {shown.map((a) => (
            <ScheduleRow
              key={a.id}
              automation={a}
              runs={runs}
              selected={pane === null && a.id === selectedId}
              onSelect={() => { setPane(null); useStore.getState().selectSchedule(a.id); }}
            />
          ))}
        </ul>
        {query.trim() && shown.length === 0 && <p className="ui-note px-3">{t('schedules.noMatches')}</p>}
      </aside>

      <div className="wmux-schedules-main">
        {pane ? (
          <ScheduleEditor
            key={pane.mode === 'new' ? `new-${pane.seq}` : pane.automation.id}
            original={pane.mode === 'new' ? null : pane.automation}
            review={pane.mode === 'review'}
            initial={pane.mode === 'new' ? pane.initial : undefined}
            accounts={accounts}
            onClose={() => setPane(null)}
            onSaved={(id) => {
              setPane(null);
              useStore.getState().selectSchedule(id);
            }}
          />
        ) : selected ? (
          <ScheduleDetail
            key={selected.id}
            automation={selected}
            accounts={accounts}
            onEdit={() => setPane({ mode: selected.proposed ? 'review' : 'edit', automation: selected })}
            onDiscard={() => void discard(selected)}
          />
        ) : (
          <div className="wmux-schedules-empty" data-schedules-empty>
            <span className="wmux-schedules-empty-icon" aria-hidden="true"><IconClock size={22} /></span>
            <h2>{t('schedules.emptyTitle')}</h2>
            <p>{t('schedules.emptyBody')}</p>
            <ul className="wmux-schedules-templates" aria-label={t('schedules.templates')}>
              {SCHEDULE_TEMPLATES.map((tpl) => (
                <li key={tpl.id}>
                  <button type="button" className={`wmux-schedules-template ${FOCUS_RING}`}
                    onClick={() => startTemplate(tpl)} data-schedule-template={tpl.id}>
                    <span className="wmux-schedules-template-icon" aria-hidden="true"><IconClock size={14} /></span>
                    <span className="min-w-0">
                      <span className="wmux-schedules-template-title">{t(`schedules.tpl.${tpl.id}.title`)}</span>
                      <span className="wmux-schedules-template-desc">{t(`schedules.tpl.${tpl.id}.desc`)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

/** One list row: the name, then a muted line — next run and the schedule. */
function ScheduleRow({ automation: a, runs, selected, onSelect }: {
  automation: Automation;
  runs: AutomationRun[];
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const live = runs.find((r) => r.automationId === a.id && isLiveRun(r));
  const when = live
    ? runStateLabel(live.state)
    : a.enabled && a.nextRunAt !== null ? formatWhen(a.nextRunAt) : t('schedules.statusOff');
  return (
    <li data-schedule-row={a.id}>
      <button
        type="button"
        className={`wmux-schedules-row ${FOCUS_RING}`}
        aria-current={selected ? 'true' : undefined}
        data-off={!a.enabled ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className="wmux-schedules-row-name">
          <span className="truncate">{a.name}</span>
          {a.proposed && <Badge>{t('schedules.badgeProposed')}</Badge>}
          {isPermissionReset(a) && <Badge>{t('schedules.badgePermissionReset')}</Badge>}
        </span>
        <span className="wmux-schedules-row-meta truncate">{`${when} · ${describeTrigger(a)}`}</span>
      </button>
    </li>
  );
}
