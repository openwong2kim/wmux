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
  accountLabel, agentLabel, describeTrigger, folderName, formatDuration, formatWhen, resumeCommand, runStateLabel,
  BYPASS_DECLINED,
} from './format';
import { openAutomationRun } from './openRun';
import type { AccountOption } from './useAccounts';

function report(error: string | undefined, t: ReturnType<typeof useT>): void {
  if (!error) return;
  if (error === BYPASS_DECLINED) {
    useStore.getState().pushToast({ level: 'info', message: t('schedules.bypassDeclinedEdit') });
    return;
  }
  useStore.getState().pushToast({ level: 'error', message: t('schedules.error', { error }) });
}

/**
 * The selected schedule: a header that answers "is it on, and when next" with
 * Run now and Edit beside it, one muted line for what it runs, then its run
 * history (status dot, start, duration, result, open the run's workspace).
 */
export default function ScheduleDetail({ automation: a, accounts, onEdit, onDiscard }: {
  automation: Automation;
  accounts: AccountOption[];
  onEdit: () => void;
  /** A proposed draft is discarded rather than deleted. */
  onDiscard?: () => void;
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
  const next = a.enabled && a.nextRunAt !== null
    ? t('schedules.nextRunLabel', { time: formatWhen(a.nextRunAt) })
    : t('schedules.statusOff');

  return (
    <div className="wmux-schedule-detail" data-schedule-detail={a.id}>
      <header className="wmux-schedule-detail-head">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="wmux-schedule-pane-title truncate">{a.name}</h2>
            {a.proposed && <Badge>{t('schedules.badgeProposed')}</Badge>}
            {a.permission.mode === 'bypass' && <Badge>{t('schedules.badgeBypass')}</Badge>}
          </div>
          <p className="wmux-schedule-detail-next" data-schedule-next>{`${describeTrigger(a)} · ${next}`}</p>
        </div>
        {!a.proposed && (
          <Switch
            checked={a.enabled}
            disabled={busy || !api}
            aria-label={t('schedules.enabled')}
            onCheckedChange={(enabled) => void act((x) => x.setEnabled(a.id, enabled))}
          />
        )}
        {/* An unreviewed draft never runs — not even by hand. */}
        {!a.proposed && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !api}
            onClick={() => void act(async (x) => {
              const r = await x.runNow(a.id, 'manual');
              if (r.ok) useStore.getState().pushToast({ level: 'info', message: t('schedules.runNowStarted') });
              return r;
            })}
            data-schedule-test-run
          >
            {t('schedules.runNow')}
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onEdit} data-schedule-edit>
          {a.proposed ? t('schedules.actionReview') : t('schedules.edit')}
        </Button>
        {a.proposed && onDiscard ? (
          <Button variant="ghost" size="sm" onClick={onDiscard} data-schedule-discard>{t('schedules.discard')}</Button>
        ) : (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)} data-schedule-delete>
            {t('schedules.delete')}
          </Button>
        )}
      </header>

      <p className="ui-note" data-schedule-facts>
        <code className="ui-code">{folderName(a.action.cwd)}</code>
        {` · ${agentLabel(a.action.agent)} · ${accountLabel(a, accounts)}${a.action.model ? ` · ${a.action.model}` : ''} · ${modeLabel}`}
        {a.permission.mode === 'scoped' && a.permission.allowedTools?.length ? ` (${a.permission.allowedTools.join(', ')})` : ''}
      </p>

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

      <section className="wmux-schedule-history">
        <h3 className="wmux-schedule-section-title">{t('schedules.history')}</h3>
        {runs.length === 0 ? (
          <p className="ui-note">{t('schedules.historyEmpty')}</p>
        ) : (
          <ul className="wmux-schedule-runs">
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
        <p className="ui-note" data-schedule-policy>{policy}</p>
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
  const result = [
    runStateLabel(run.state),
    run.reason ? t(`schedules.reason.${run.reason}`) : '',
    run.trigger === 'test' ? t('schedules.triggerTest') : run.trigger === 'manual' ? t('schedules.triggerManual') : '',
  ].filter(Boolean).join(' · ');
  return (
    <li className="wmux-schedule-run" data-run-row={run.id} data-run-state={run.state}>
      <div className="wmux-schedule-run-line">
        <span className="wmux-schedule-run-dot" data-tone={runTone(run)} aria-hidden="true" />
        <span className="wmux-schedule-run-when">{formatWhen(run.startedAt ?? run.scheduledFor)}</span>
        <span className="wmux-schedule-run-took">{formatDuration(run)}</span>
        <span className="wmux-schedule-run-result">{result}</span>
        {live && run.ptyId && (
          <Button variant="secondary" size="sm" onClick={() => void openAutomationRun(run.id)} data-run-open>
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

/** Status dot tone: live runs use the accent, outcomes their state colour. */
function runTone(run: AutomationRun): 'live' | 'ok' | 'error' | 'muted' {
  if (isLiveRun(run)) return 'live';
  if (run.state === 'completed') return 'ok';
  if (run.state === 'failed') return 'error';
  return 'muted';
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
