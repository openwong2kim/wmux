import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSlug } from '../../../shared/agentIdentity';
import type { SessionPromptSchedule } from '../../../shared/sessionPromptSchedule';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import { IconX } from '../icons';

export interface SessionSchedulesApi {
  list: (ptyId: string) => Promise<{ schedules: SessionPromptSchedule[]; available?: boolean }>;
  listAll?: () => Promise<{ schedules: SessionPromptSchedule[]; available?: boolean }>;
  create: (args: {
    ptyId: string;
    agentSlug: AgentSlug;
    prompt: string;
    nextRunAt: number;
    intervalMinutes?: number;
  }) => Promise<{ ok: boolean; schedule?: SessionPromptSchedule; code?: string }>;
  update: (args: { ptyId: string; id: string; enabled: boolean }) => Promise<{ ok: boolean; code?: string }>;
  remove: (ptyId: string, id: string) => Promise<{ ok: boolean }>;
}

const REPEAT_OPTIONS = [
  { minutes: 0, key: 'sessionSchedule.repeatNone' },
  { minutes: 30, key: 'sessionSchedule.repeat30m' },
  { minutes: 60, key: 'sessionSchedule.repeat1h' },
  { minutes: 360, key: 'sessionSchedule.repeat6h' },
  { minutes: 1440, key: 'sessionSchedule.repeat24h' },
] as const;

function localDateTimeValue(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultWhen(now = new Date()): string {
  return localDateTimeValue(new Date(now.getTime() + 5 * 60_000));
}

function formatWhen(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

function statusKey(schedule: SessionPromptSchedule): string {
  if (schedule.enabled && schedule.lastResult === 'busy') return 'sessionSchedule.statusBusy';
  if (schedule.enabled && schedule.lastResult === 'unavailable') {
    return 'sessionSchedule.statusUnavailable';
  }
  if (schedule.lastResult === 'session_changed') return 'sessionSchedule.statusSessionChanged';
  if (schedule.lastResult === 'sent') return 'sessionSchedule.statusSent';
  if (schedule.lastResult === 'error') return 'sessionSchedule.statusError';
  return schedule.enabled ? 'sessionSchedule.statusWaiting' : 'sessionSchedule.statusPaused';
}

export default function SessionSchedulesPopover({
  ptyId,
  agentSlug,
  agentName,
  api,
}: {
  ptyId: string;
  agentSlug?: AgentSlug;
  agentName?: string;
  api?: SessionSchedulesApi;
}) {
  const t = useT();
  const setPopover = useStore((state) => state.setToolbarPopover);
  const resolvedApi = api ?? window.electronAPI?.pty?.schedules;
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const firstManageRef = useRef<HTMLButtonElement>(null);
  const refreshRevision = useRef(0);
  const [schedules, setSchedules] = useState<SessionPromptSchedule[]>([]);
  const [schedulingAvailable, setSchedulingAvailable] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [when, setWhen] = useState(defaultWhen);
  const [repeat, setRepeat] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!resolvedApi) return;
    const revision = ++refreshRevision.current;
    try {
      const response = resolvedApi.listAll
        ? await resolvedApi.listAll()
        : await resolvedApi.list(ptyId);
      if (revision !== refreshRevision.current) return;
      setSchedules(response.schedules);
      setSchedulingAvailable(response.available ?? true);
    } catch {
      if (revision === refreshRevision.current) {
        setError(t('sessionSchedule.error'));
      }
    }
  }, [ptyId, resolvedApi, t]);

  useEffect(() => {
    void refresh();
    return () => { refreshRevision.current += 1; };
  }, [refresh]);

  useEffect(() => {
    if (agentSlug && schedulingAvailable) promptRef.current?.focus();
    else firstManageRef.current?.focus();
  }, [agentSlug, schedules.length, schedulingAvailable]);

  const activeCount = useMemo(
    () => schedules.filter((schedule) => schedule.enabled).length,
    [schedules],
  );

  const setQuickTime = (minutes: number): void => {
    setWhen(localDateTimeValue(new Date(Date.now() + minutes * 60_000)));
  };

  const create = async (): Promise<void> => {
    if (!resolvedApi || saving) return;
    if (!schedulingAvailable) {
      setError(t('sessionSchedule.daemonRequired'));
      return;
    }
    if (!agentSlug) {
      setError(t('sessionSchedule.agentUnavailable'));
      return;
    }
    const nextRunAt = new Date(when).getTime();
    if (!prompt.trim() || !Number.isFinite(nextRunAt) || nextRunAt <= Date.now()) {
      setError(t('sessionSchedule.invalid'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await resolvedApi.create({
        ptyId,
        agentSlug,
        prompt,
        nextRunAt,
        ...(repeat > 0 ? { intervalMinutes: repeat } : {}),
      });
      if (!result.ok) {
        setError(
          result.code === 'limit'
            ? t('sessionSchedule.limit')
            : result.code === 'daemon_required'
              ? t('sessionSchedule.daemonRequired')
            : result.code === 'agent_unavailable'
              ? t('sessionSchedule.agentUnavailable')
              : t('sessionSchedule.invalid'),
        );
        return;
      }
      setPrompt('');
      setWhen(defaultWhen());
      setRepeat(0);
      await refresh();
    } catch {
      setError(t('sessionSchedule.error'));
    } finally {
      setSaving(false);
    }
  };

  const setEnabled = async (schedule: SessionPromptSchedule): Promise<void> => {
    setError(null);
    try {
      const result = await resolvedApi.update({
        ptyId: schedule.ptyId,
        id: schedule.id,
        enabled: !schedule.enabled,
      });
      if (!result.ok) setError(t('sessionSchedule.error'));
      await refresh();
    } catch {
      setError(t('sessionSchedule.error'));
    }
  };

  const remove = async (schedule: SessionPromptSchedule): Promise<void> => {
    setError(null);
    try {
      await resolvedApi.remove(schedule.ptyId, schedule.id);
      await refresh();
    } catch {
      setError(t('sessionSchedule.error'));
    }
  };

  if (!resolvedApi) return null;

  return (
    <div
      role="dialog"
      aria-labelledby="session-schedules-title"
      className="pointer-events-auto absolute bottom-full left-2 mb-1 w-[31rem] max-w-[calc(100vw-1rem)] max-h-[72vh] overflow-y-auto rounded-[7px] border border-[var(--border-soft)] bg-[var(--bg-mantle)] shadow-xl z-50 text-xs"
      data-testid="session-schedules-popover"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-3 py-2 border-b border-[var(--bg-surface)] bg-[var(--bg-mantle)] rounded-t-[7px]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[var(--text-main)] font-medium">
            <span id="session-schedules-title">{t('sessionSchedule.title')}</span>
            {activeCount > 0 && (
              <span className="rounded-full px-1.5 py-px text-[10px] text-[var(--accent)] border border-[color-mix(in_srgb,var(--accent)_35%,transparent)]">
                {activeCount}
              </span>
            )}
          </div>
          <div className="truncate text-[10px] text-[var(--text-muted)]" title={`${agentName ?? t('sessionSchedule.noAgent')} · ${ptyId}`}>
            {agentName ?? t('sessionSchedule.noAgent')} · {ptyId}
          </div>
        </div>
        <button
          type="button"
          className="px-1.5 py-1 text-[var(--text-muted)] hover:text-[var(--text-main)]"
          aria-label={t('toolbar.close')}
          title={t('toolbar.close')}
          onClick={() => setPopover(null)}
        >
          <IconX size={12} />
        </button>
      </div>

      <div className="p-3 space-y-3">
        <p className="text-[11px] leading-relaxed text-[var(--text-sub)]">
          {t('sessionSchedule.hint')}
        </p>
        {schedulingAvailable && !agentSlug && (
          <p data-session-schedule-needs-agent className="text-[11px] text-[var(--accent-yellow)]">
            {t('sessionSchedule.needsAgent')}
          </p>
        )}
        {!schedulingAvailable && (
          <p data-session-schedule-needs-daemon className="text-[11px] text-[var(--accent-yellow)]">
            {t('sessionSchedule.daemonRequired')}
          </p>
        )}

        {schedules.length === 0 ? (
          <div data-session-schedules-empty className="py-2 text-[11px] text-[var(--text-muted)]">
            {t('sessionSchedule.empty')}
          </div>
        ) : (
          <div className="space-y-1.5" data-session-schedules-list>
            {schedules.map((schedule, index) => (
              <div
                key={schedule.id}
                data-session-schedule-row
                data-schedule-id={schedule.id}
                className="rounded-[6px] border border-[var(--border-soft)] px-2.5 py-2"
              >
                <div className="flex items-start gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: schedule.lastResult === 'session_changed'
                        ? 'var(--accent-red)'
                        : schedule.enabled
                        ? schedule.lastResult === 'busy' || schedule.lastResult === 'unavailable'
                          ? 'var(--accent-yellow)'
                          : 'var(--accent-green)'
                        : 'var(--text-muted)',
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-[var(--text-main)]" title={schedule.prompt}>
                      {schedule.prompt}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-[var(--text-muted)]">
                      {schedule.ptyId !== ptyId && (
                        <span title={schedule.ptyId}>
                          {t('sessionSchedule.otherSession', { ptyId: schedule.ptyId })}
                        </span>
                      )}
                      <span className="font-mono">{formatWhen(schedule.nextRunAt)}</span>
                      {schedule.intervalMinutes && (() => {
                        const repeatOption = REPEAT_OPTIONS.find(
                          (option) => option.minutes === schedule.intervalMinutes,
                        );
                        return <span>{repeatOption ? t(repeatOption.key) : `${schedule.intervalMinutes}m`}</span>;
                      })()}
                      <span data-session-schedule-status>{t(statusKey(schedule))}</span>
                    </div>
                  </div>
                  {schedule.lastResult !== 'session_changed' && (
                    <button
                      ref={index === 0 ? firstManageRef : undefined}
                      type="button"
                      data-session-schedule-toggle
                      className="px-1 py-0.5 text-[11px] text-[var(--text-sub)] hover:text-[var(--text-main)]"
                      aria-label={`${schedule.enabled ? t('sessionSchedule.pause') : t('sessionSchedule.resume')} — ${formatWhen(schedule.nextRunAt)}`}
                      onClick={() => void setEnabled(schedule)}
                    >
                      {schedule.enabled ? t('sessionSchedule.pause') : t('sessionSchedule.resume')}
                    </button>
                  )}
                  <button
                    ref={index === 0 && schedule.lastResult === 'session_changed'
                      ? firstManageRef
                      : undefined}
                    type="button"
                    data-session-schedule-delete
                    className="px-1 py-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--accent-red)]"
                    aria-label={`${t('sessionSchedule.delete')} — ${formatWhen(schedule.nextRunAt)}`}
                    onClick={() => void remove(schedule)}
                  >
                    {t('sessionSchedule.delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="pt-3 border-t border-[var(--border-soft)] space-y-2">
          <textarea
            id="session-schedule-prompt"
            ref={promptRef}
            data-session-schedule-prompt
            className="ui-input h-28 min-h-[5rem] resize-y"
            value={prompt}
            maxLength={16_000}
            aria-label={t('sessionSchedule.promptLabel')}
            placeholder={t('sessionSchedule.promptPlaceholder')}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setPopover(null);
              }
            }}
          />

          <div className="flex flex-wrap items-center gap-1.5">
            <input
              id="session-schedule-when"
              type="datetime-local"
              data-session-schedule-when
              className="flex-1 min-w-[170px] ui-input py-1 font-mono text-[11px]"
              value={when}
              aria-label={t('sessionSchedule.whenLabel')}
              onChange={(event) => setWhen(event.target.value)}
            />
            <select
              data-session-schedule-repeat
              className="ui-input w-auto py-1 font-mono text-[11px]"
              value={repeat}
              aria-label={t('sessionSchedule.repeatLabel')}
              onChange={(event) => setRepeat(Number(event.target.value))}
            >
              {REPEAT_OPTIONS.map((option) => (
                <option key={option.minutes} value={option.minutes}>
                  {t(option.key)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-muted)]">{t('sessionSchedule.quick')}</span>
            <button type="button" data-session-schedule-quick="60" className="ui-ghost rounded px-1.5 py-0.5 text-[10px]" aria-label={t('sessionSchedule.quickHours', { hours: 1 })} onClick={() => setQuickTime(60)}>
              {t('sessionSchedule.quickHours', { hours: 1 })}
            </button>
            <button type="button" data-session-schedule-quick="300" className="ui-ghost rounded px-1.5 py-0.5 text-[10px]" aria-label={t('sessionSchedule.quickHours', { hours: 5 })} onClick={() => setQuickTime(300)}>
              {t('sessionSchedule.quickHours', { hours: 5 })}
            </button>
            <button type="button" data-session-schedule-quick="1440" className="ui-ghost rounded px-1.5 py-0.5 text-[10px]" aria-label={t('sessionSchedule.quickHours', { hours: 24 })} onClick={() => setQuickTime(1440)}>
              {t('sessionSchedule.quickHours', { hours: 24 })}
            </button>
            <Button
              variant="primary"
              className="ml-auto"
              data-session-schedule-create
              title={!schedulingAvailable
                ? t('sessionSchedule.daemonRequired')
                : !agentSlug ? t('sessionSchedule.needsAgent') : undefined}
              disabled={saving || !prompt.trim() || !agentSlug || !schedulingAvailable}
              onClick={() => void create()}
            >
              {saving ? t('sessionSchedule.saving') : t('sessionSchedule.add')}
            </Button>
          </div>
          {error && (
            <div role="alert" data-session-schedule-error className="text-[11px] text-[var(--accent-red)]">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
