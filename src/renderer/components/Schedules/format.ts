import { getLocale, t } from '../../i18n';
import type { Automation, AutomationRun, AutomationRunState } from '../../../shared/automation';
import { DAILY, WEEKDAYS } from './scheduleModel';
import type { AccountOption } from './useAccounts';

// 2024-01-07 was a Sunday: day N of that week has getDay() === N.
const SUNDAY = new Date(2024, 0, 7);

export function weekdayName(day: number, width: 'short' | 'narrow' = 'short'): string {
  const d = new Date(SUNDAY);
  d.setDate(SUNDAY.getDate() + day);
  return new Intl.DateTimeFormat(getLocale(), { weekday: width }).format(d);
}

function sameDays(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function describeDays(weekdays: readonly number[]): string {
  const sorted = [...weekdays].sort((a, b) => a - b);
  if (sameDays(sorted, DAILY)) return t('schedules.daily');
  if (sameDays(sorted, WEEKDAYS)) return t('schedules.weekdays');
  return sorted.map((d) => weekdayName(d)).join(' ');
}

export function describeTrigger(a: Automation): string {
  return `${describeDays(a.trigger.weekdays)} ${a.trigger.time}`;
}

/** "Today 08:30", "Tomorrow 08:30", else a short weekday + time. */
export function formatWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit' }).format(d);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOf(d) - startOf(new Date(now))) / 86_400_000);
  if (dayDiff === 0) return t('schedules.today', { time });
  if (dayDiff === 1) return t('schedules.tomorrow', { time });
  const date = new Intl.DateTimeFormat(getLocale(), {
    weekday: 'short', month: 'short', day: 'numeric',
  }).format(d);
  return `${date} ${time}`;
}

/** Sidebar-width next run: the time today, else a short weekday and time. */
export function formatNextShort(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit' }).format(d);
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? time : `${weekdayName(d.getDay())} ${time}`;
}

export function formatDuration(run: AutomationRun): string {
  if (run.startedAt === undefined || run.endedAt === undefined) return '';
  const sec = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));
  if (sec < 60) return t('schedules.durationSec', { count: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t('schedules.durationMin', { count: min });
  return t('schedules.durationHour', { hours: Math.floor(min / 60), minutes: min % 60 });
}

export function runStateLabel(state: AutomationRunState): string {
  return t(`schedules.state.${state}`);
}

export function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

export function resumeCommand(run: AutomationRun, agent: Automation['action']['agent']): string | null {
  // Shown for copy-paste into a shell: only a plain id may ride in it.
  if (!run.agentSessionId || !/^[\w-]{1,128}$/.test(run.agentSessionId)) return null;
  return agent === 'codex' ? `codex resume ${run.agentSessionId}` : `claude --resume ${run.agentSessionId}`;
}

export function accountLabel(a: Automation, accounts: readonly AccountOption[]): string {
  if (!a.action.accountId) return t('schedules.defaultAccount');
  return accounts.find((x) => x.id === a.action.accountId)?.name ?? t('schedules.missingAccount');
}

export function agentLabel(agent: Automation['action']['agent']): string {
  return agent === 'codex' ? t('schedules.agentCodex') : t('schedules.agentClaude');
}

/** What main's grant handler answers when the native Auto/Bypass prompt is declined. */
export const GRANT_DECLINED = 'cancelled';
