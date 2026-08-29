import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSlug } from '../../../shared/agentIdentity';
import type { SessionPromptSchedule } from '../../../shared/sessionPromptSchedule';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import Button from '../ui/Button';

export interface SessionSchedulesApi {
  list: (ptyId: string) => Promise<{ schedules: SessionPromptSchedule[] }>;
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
  { minutes: 0, key: 'deck.scheduleRepeatNone', fallback: 'Once' },
  { minutes: 30, key: 'deck.scheduleRepeat30m', fallback: 'Every 30 min' },
  { minutes: 60, key: 'deck.scheduleRepeat1h', fallback: 'Every hour' },
  { minutes: 360, key: 'deck.scheduleRepeat6h', fallback: 'Every 6 hours' },
  { minutes: 1440, key: 'deck.scheduleRepeat24h', fallback: 'Every day' },
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
  const [schedules, setSchedules] = useState<SessionPromptSchedule[]>([]);
  const [prompt, setPrompt] = useState('');
  const [when, setWhen] = useState(defaultWhen);
  const [repeat, setRepeat] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!resolvedApi) return;
    try {
      const response = await resolvedApi.list(ptyId);
      setSchedules(response.schedules);
    } catch {
      setError(t('sessionSchedule.error'));
    }
  }, [ptyId, resolvedApi, t]);

  useEffect(() => {
    promptRef.current?.focus();
    void refresh();
  }, [refresh]);

  const activeCount = useMemo(
    () => schedules.filter((schedule) => schedule.enabled).length,
    [schedules],
  );

  const setQuickTime = (minutes: number): void => {
    setWhen(localDateTimeValue(new Date(Date.now() + minutes * 60_000)));
  };

  const create = async (): Promise<void> => {
    if (!resolvedApi || saving) return;
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

  if (!resolvedApi) return null;

  return (
    <div
      className="pointer-events-auto absolute bottom-full left-2 mb-1 w-[31rem] max-w-[calc(100vw-1rem)] max-h-[72vh] overflow-y-auto rounded-[8px] border border-[var(--border-soft)] bg-[var(--bg-mantle)] shadow-xl z-50 text-xs"
      data-testid="session-schedules-popover"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-3 py-2 border-b border-[var(--bg-surface)] bg-[var(--bg-mantle)] rounded-t-[8px]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[var(--text-main)] font-medium">
            <span>{t('sessionSchedule.title')}</span>
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
          ✕
        </button>
      </div>

      <div className="p-3 space-y-3">
        <p className="text-[11px] leading-relaxed text-[var(--text-sub)]">
          {t('sessionSchedule.hint')}
        </p>
        {!agentSlug && (
          <p data-session-schedule-needs-agent className="text-[11px] text-[var(--accent-yellow)]">
            {t('sessionSchedule.needsAgent')}
          </p>
        )}

        {schedules.length === 0 ? (
          <div data-session-schedules-empty className="py-2 text-[11px] text-[var(--text-muted)]">
            {t('sessionSchedule.empty')}
          </div>
        ) : (
          <div className="space-y-1.5" data-session-schedules-list>
            {schedules.map((schedule) => (
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
                      backgroundColor: schedule.enabled
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
                  <button
                    type="button"
                    data-session-schedule-toggle
                    className="px-1 py-0.5 text-[10.5px] text-[var(--text-sub)] hover:text-[var(--text-main)]"
                    onClick={() => {
                      void resolvedApi
                        .update({ ptyId, id: schedule.id, enabled: !schedule.enabled })
                        .then(refresh);
                    }}
                  >
                    {schedule.enabled ? t('deck.schedulePause') : t('deck.scheduleResume')}
                  </button>
                  <button
                    type="button"
                    data-session-schedule-delete
                    className="px-1 py-0.5 text-[10.5px] text-[var(--text-muted)] hover:text-[var(--accent-red)]"
                    onClick={() => { void resolvedApi.remove(ptyId, schedule.id).then(refresh); }}
                  >
                    {t('deck.scheduleDelete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="pt-3 border-t border-[var(--border-soft)] space-y-2">
          <textarea
            ref={promptRef}
            data-session-schedule-prompt
            className="ui-input h-28 min-h-[5rem] resize-y"
            value={prompt}
            maxLength={16_000}
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
              type="datetime-local"
              data-session-schedule-when
              className="flex-1 min-w-[170px] ui-input py-1 font-mono text-[11px]"
              value={when}
              onChange={(event) => setWhen(event.target.value)}
            />
            <select
              data-session-schedule-repeat
              className="ui-input w-auto py-1 font-mono text-[11px]"
              value={repeat}
              aria-label={t('deck.scheduleRepeat')}
              onChange={(event) => setRepeat(Number(event.target.value))}
            >
              {REPEAT_OPTIONS.map((option) => (
                <option key={option.minutes} value={option.minutes}>
                  {t(option.key) || option.fallback}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-muted)]">{t('sessionSchedule.quick')}</span>
            <button type="button" data-session-schedule-quick="60" className="ui-ghost rounded px-1.5 py-0.5 text-[10px]" onClick={() => setQuickTime(60)}>
              +1h
            </button>
            <button type="button" data-session-schedule-quick="300" className="ui-ghost rounded px-1.5 py-0.5 text-[10px]" onClick={() => setQuickTime(300)}>
              +5h
            </button>
            <button type="button" data-session-schedule-quick="1440" className="ui-ghost rounded px-1.5 py-0.5 text-[10px]" onClick={() => setQuickTime(1440)}>
              +24h
            </button>
            <Button
              variant="primary"
              className="ml-auto"
              data-session-schedule-create
              title={!agentSlug ? t('sessionSchedule.needsAgent') : undefined}
              disabled={saving || !prompt.trim() || !agentSlug}
              onClick={() => void create()}
            >
              {saving ? t('sessionSchedule.saving') : t('deck.scheduleAdd')}
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
