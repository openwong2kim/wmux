// The bot profile's Today block: one line on what keeps the bot from new
// work now (with Resume when it is parked), then each limit with what is
// used of it. botBudgetView.ts decides; this only words and colours it.

import { useState } from 'react';
import Button from '../ui/Button';
import { useStore } from '../../stores';
import type { FactoryBotPort, FactoryBotRow } from '../Room/factoryPorts';
import { botActionsFor } from '../Room/BotChips';
import { formatNoticeTime } from '../Room/roomFormat';
import { botBudgetView, type BotBlocker, type BotTodayLine } from './botBudgetView';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** "2h 10m", "6h", "45m", "0m". */
export function workerTimeText(min: number, t: T): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return t('botsPage.profile.today.m', { m });
  return m === 0 ? t('botsPage.profile.today.h', { h }) : t('botsPage.profile.today.hm', { h, m });
}

export function blockerText(b: BotBlocker, name: string, t: T): string {
  switch (b.kind) {
    case 'paused': return t('botsPage.profile.parked.human');
    case 'errors': return t('botsPage.profile.parked.error');
    case 'usageLimit': return t('botsPage.profile.parked.limit', { time: formatNoticeTime(b.until) });
    case 'turns': return b.until !== undefined
      ? t('botsPage.profile.blocked.turnsAt', { time: formatNoticeTime(b.until) })
      : t('botsPage.profile.parked.budget');
    case 'workerTime': return b.until !== undefined
      ? t('botsPage.profile.blocked.workerTimeAt', { time: formatNoticeTime(b.until) })
      : t('room.notice.budget.exhausted.worker_hours_day', { bot: name });
    case 'workerCap': return t('room.notice.budget.exhausted.concurrent_workers', { bot: name });
    case 'factoryWorkers': return t('room.notice.budget.exhausted.factory_workers', { bot: name });
    case 'slots': return t('botsPage.profile.blocked.slots', { inUse: b.inUse, cap: b.cap });
    case 'queue': return t('botsPage.profile.blocked.queue', { count: b.depth, cap: b.cap });
  }
}

function lineText(line: BotTodayLine, t: T): { label: string; value: string } {
  switch (line.id) {
    case 'turnsHour': return { label: t('botsPage.profile.today.turnsHour'), value: t('botsPage.profile.turnsTodayValue', { used: line.used, left: line.left }) };
    case 'turnsDay': return { label: t('botsPage.profile.turnsToday'), value: t('botsPage.profile.turnsTodayValue', { used: line.used, left: line.left }) };
    case 'workerTime': return { label: t('botsPage.profile.today.workerTime'), value: t('botsPage.profile.today.ofMax', { count: workerTimeText(line.usedMin, t), max: workerTimeText(line.maxMin, t) }) };
    case 'workers': {
      const value = t('botsPage.profile.today.ofMax', { count: line.running, max: line.max });
      return { label: t('botsPage.profile.today.workers'), value: line.waiting > 0 ? `${value} · ${t('botsPage.profile.today.workersWaiting', { count: line.waiting })}` : value };
    }
    case 'queue': return { label: t('botsPage.profile.today.queue'), value: t('botsPage.profile.today.ofMax', { count: line.depth, max: line.cap }) };
  }
}

export function BotToday({ row, act, t }: { row: FactoryBotRow; act?: FactoryBotPort['act']; t: T }) {
  const [busy, setBusy] = useState(false);
  const view = botBudgetView(row.bot, row.status);
  if (!view.blocker && view.lines.length === 0) return null;
  const canResume = !!act && botActionsFor(row).resume;
  const resume = async () => {
    if (!act) return;
    setBusy(true);
    try {
      const r = await act('resume', row.bot.id);
      if (!r.ok) useStore.getState().pushToast({ message: t('room.bot.actionFailed', { name: row.bot.name, reason: r.message ?? '' }), level: 'error' });
    } catch (err) {
      useStore.getState().pushToast({ message: t('room.bot.actionFailed', { name: row.bot.name, reason: err instanceof Error ? err.message : String(err) }), level: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-today>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.today')}</span>
      <div className="min-w-0 flex-1">
        {view.blocker && (
          <div
            className="flex items-center gap-3 pb-1"
            data-bots-profile-blocker={view.blocker.kind}
            {...(row.bot.parked ? { 'data-bots-profile-parked': row.bot.parked.reason } : {})}
          >
            <span className="min-w-0 flex-1 text-[var(--text-sub)]">{blockerText(view.blocker, row.bot.name, t)}</span>
            {canResume && <Button size="sm" variant="secondary" data-testid="bots-resume-bot" disabled={busy} onClick={() => void resume()}>{t('room.bot.resume')}</Button>}
          </div>
        )}
        <ul className="space-y-0.5 tabular-nums">
          {view.lines.map((line) => {
            const { label, value } = lineText(line, t);
            return (
              <li
                key={line.id}
                data-bots-today-line={line.id}
                data-reached={line.reached ? 'true' : undefined}
                className={`flex gap-2 ${line.reached ? 'text-[var(--accent-yellow)]' : 'text-[var(--text-sub)]'}`}
              >
                <span className={line.reached ? undefined : 'text-[var(--text-muted)]'}>{label}</span>
                <span {...(line.id === 'turnsDay' ? { 'data-bots-profile-turns': '' } : {})}>{value}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
