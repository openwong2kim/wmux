import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { AUTOMATION_DEFAULTS, type Automation, type AutomationRun } from '../../../shared/automation';
import { isLiveRun, isPermissionReset, sortRunsNewestFirst } from '../../stores/selectors/schedules';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import Switch from '../ui/Switch';
import Dialog, { DialogFooter, DialogHeader } from '../ui/Dialog';
import {
  accountLabel, agentLabel, describeTrigger, formatDuration, formatWhen, resumeCommand, runStateLabel,
} from './format';
import { openAutomationRun } from './openRun';
import type { AccountOption } from './useAccounts';

function report(error: string | undefined, t: ReturnType<typeof useT>): void {
  if (error) useStore.getState().pushToast({ level: 'error', message: t('schedules.error', { error }) });
}

/** Selected schedule: what it runs, its policy, and its last runs. */
export default function ScheduleDetail({ automation: a, accounts, onEdit }: {
  automation: Automation;
  accounts: AccountOption[];
  onEdit: () => void;
}) {
  const t = useT();
  const allRuns = useStore((s) => s.automationRuns);
  const runs = useMemo(
    () => sortRunsNewestFirst(allRuns.filter((r) => r.automationId === a.id)).slice(0, AUTOMATION_DEFAULTS.runHistoryPerAutomation),
    [allRuns, a.id],
  );
  // Collapsed by default: a snapshot can carry the agent's status line, which
  // may show the signed-in account, and this view ends up in screen captures.
  const [outputRunId, setOutputRunId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const api = window.electronAPI?.automation;

  type Api = NonNullable<typeof api>;
  const act = async (fn: (api: Api) => Promise<{ ok: boolean; error?: string }>) => {
    if (!api) return;
    setBusy(true);
    try {
      const r = await fn(api);
      if (r && !r.ok) report(r.error, t);
    } finally {
      setBusy(false);
      void useStore.getState().refreshSchedules();
    }
  };

  const policy = t('schedules.policy', {
    hours: Math.round(a.trigger.graceMinutes / 60 * 10) / 10,
    max: Math.round((a.policy.maxRunMinutes ?? AUTOMATION_DEFAULTS.maxRunMinutes) / 60 * 10) / 10,
  });
  const modeLabel = t(`schedules.mode.${a.permission.mode}`);

  return (
    <div className="flex flex-col gap-4" data-schedule-detail={a.id}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{a.name}</h3>
        {a.proposed && <Badge>{t('schedules.badgeProposed')}</Badge>}
        {!a.proposed && (
          <label className="flex items-center gap-2 text-[13px] text-[var(--text-sub)]">
            {t('schedules.enabled')}
            <Switch
              checked={a.enabled}
              disabled={busy || !api}
              aria-label={t('schedules.enabled')}
              onCheckedChange={(enabled) => void act((x) => x.setEnabled(a.id, enabled))}
            />
          </label>
        )}
        <Button variant="secondary" size="sm" onClick={onEdit}>
          {a.proposed ? t('schedules.actionReview') : t('schedules.edit')}
        </Button>
        {/* An unreviewed draft never runs — not even as a test. */}
        {!a.proposed && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !api}
            title={t('schedules.testRunHint')}
            onClick={() => void act((x) => x.runNow(a.id, 'test'))}
            data-schedule-test-run
          >
            {t('schedules.testRun')}
          </Button>
        )}
        <Button variant="destructive" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
          {t('schedules.delete')}
        </Button>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-[var(--text-sub)]">{t('schedules.schedule')}</dt>
        <dd>{describeTrigger(a)}{a.enabled && a.nextRunAt !== null ? ` · ${t('schedules.nextRun', { time: formatWhen(a.nextRunAt) })}` : ''}</dd>
        <dt className="text-[var(--text-sub)]">{t('schedules.folder')}</dt>
        <dd className="min-w-0 truncate"><code className="ui-code">{a.action.cwd}</code></dd>
        <dt className="text-[var(--text-sub)]">{t('schedules.agent')}</dt>
        <dd>{`${agentLabel(a.action.agent)} · ${accountLabel(a, accounts)}${a.action.model ? ` · ${a.action.model}` : ''}`}</dd>
        <dt className="text-[var(--text-sub)]">{t('schedules.permission')}</dt>
        <dd className="flex items-center gap-2">
          {modeLabel}
          {a.permission.mode === 'scoped' && a.permission.allowedTools?.length
            ? <code className="ui-code">{a.permission.allowedTools.join(', ')}</code> : null}
        </dd>
      </dl>

      {isPermissionReset(a) && (
        <div className="ui-notice ui-row" data-schedule-permission-reset>
          <div className="ui-row-text">
            <p className="ui-row-title">{t('schedules.badgePermissionReset')}</p>
            <p className="ui-row-detail">{t('schedules.permissionResetNote', { mode: modeLabel })}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !api}
            onClick={() => void act((x) => x.grant(
              a.id,
              a.permission.mode,
              a.action.agent === 'claude' ? a.permission.allowedTools : undefined,
            ))}
          >
            {t('schedules.regrant')}
          </Button>
        </div>
      )}

      <p className="ui-note" data-schedule-policy>{policy}</p>

      <section className="flex flex-col gap-2">
        <h4 className="ui-group-label">{t('schedules.history')}</h4>
        {runs.length === 0 ? (
          <p className="ui-note">{t('schedules.historyEmpty')}</p>
        ) : (
          <ul className="ui-group">
            {runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                automation={a}
                showingOutput={outputRunId === run.id}
                onToggleOutput={() => setOutputRunId(outputRunId === run.id ? null : run.id)}
                onCancel={() => void act((x) => x.cancelRun(run.id))}
              />
            ))}
          </ul>
        )}
      </section>

      {confirmDelete && createPortal(
        <Dialog role="alertdialog" onClose={() => setConfirmDelete(false)} width={420}>
          <DialogHeader title={t('schedules.deleteTitle')} description={t('schedules.deleteBody', { name: a.name })} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t('schedules.cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmDelete(false);
                useStore.getState().selectSchedule(null);
                void act((x) => x.remove(a.id));
              }}
            >
              {t('schedules.delete')}
            </Button>
          </DialogFooter>
        </Dialog>,
        document.body,
      )}
    </div>
  );
}

function RunRow({ run, automation, showingOutput, onToggleOutput, onCancel }: {
  run: AutomationRun;
  automation: Automation;
  showingOutput: boolean;
  onToggleOutput: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const live = isLiveRun(run);
  const parts = [
    formatWhen(run.startedAt ?? run.scheduledFor),
    formatDuration(run),
    runStateLabel(run.state),
    run.reason ? t(`schedules.reason.${run.reason}`) : '',
    run.trigger === 'test' ? t('schedules.triggerTest') : run.trigger === 'manual' ? t('schedules.triggerManual') : '',
  ].filter(Boolean);
  return (
    <li className="flex flex-col" data-run-row={run.id} data-run-state={run.state}>
      <div className="ui-row">
        <p className="ui-row-text ui-row-title">{parts.join(' · ')}</p>
        {live && run.ptyId && (
          <Button variant="secondary" size="sm" onClick={() => void openAutomationRun(run.id)}>
            {t('schedules.actionOpen')}
          </Button>
        )}
        {live && (
          <Button variant="ghost" size="sm" onClick={onCancel}>{t('schedules.cancelRun')}</Button>
        )}
        {!live && run.hasSnapshot && (
          <Button variant="ghost" size="sm" aria-expanded={showingOutput} onClick={onToggleOutput} data-run-output-toggle>
            {showingOutput ? t('schedules.hideOutput') : t('schedules.showOutput')}
          </Button>
        )}
      </div>
      {run.reason === 'first_run_blocked' && (
        <p className="ui-note px-[14px] pb-3" data-run-first-run-hint>
          {t('schedules.firstRunBlockedHint', { agent: agentLabel(automation.action.agent) })}
        </p>
      )}
      {showingOutput && <RunOutput run={run} automation={automation} />}
    </li>
  );
}

function RunOutput({ run, automation }: { run: AutomationRun; automation: Automation }) {
  const t = useT();
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    window.electronAPI?.automation?.snapshot(run.id)
      .then((r) => { if (alive) setText(r.text); })
      .catch(() => { if (alive) setText(null); });
    return () => { alive = false; };
  }, [run.id]);
  const resume = resumeCommand(run, automation.action.agent);
  return (
    <div className="flex flex-col gap-2 px-[14px] pb-3" data-run-output={run.id}>
      {text === undefined ? (
        <p className="ui-note">{t('schedules.snapshotLoading')}</p>
      ) : text === null ? (
        <p className="ui-note">{t('schedules.snapshotEmpty')}</p>
      ) : (
        <pre
          className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] p-3 text-[11px] leading-4 text-[var(--text-sub)]"
          style={{ fontFamily: 'var(--font-mono)', background: 'var(--surface-fill)' }}
          aria-label={t('schedules.snapshotTitle')}
        >
          {text}
        </pre>
      )}
      {resume && (
        <p className="ui-note">
          {t('schedules.resume')} <code className="ui-code select-all">{resume}</code>
        </p>
      )}
    </div>
  );
}
