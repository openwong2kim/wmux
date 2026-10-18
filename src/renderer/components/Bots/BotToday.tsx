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

function lineText(line: BotTodayLine, t: T, liveWorkers?: number, inReviewTasks = 0): { label: string; value: string } {
  switch (line.id) {
    case 'turnsHour': return { label: t('botsPage.profile.today.turnsHour'), value: t('botsPage.profile.turnsTodayValue', { used: line.used, left: line.left }) };
    case 'turnsDay': return { label: t('botsPage.profile.turnsToday'), value: t('botsPage.profile.turnsTodayValue', { used: line.used, left: line.left }) };
    case 'workerTime': return { label: t('botsPage.profile.today.workerTime'), value: t('botsPage.profile.today.ofMax', { count: workerTimeText(line.usedMin, t), max: workerTimeText(line.maxMin, t) }) };
    case 'workers': {
      // The cap counts agent slots held, and a task in review whose worker's
      // agent still runs holds one: say how many, so this line and "Workers
      // now" (live workers only) do not read as a contradiction. Never more
      // than the bot's tasks in review (a worker still starting holds one too).
      const parts = [t('botsPage.profile.today.ofMax', { count: line.running, max: line.max })];
      const inReview = liveWorkers === undefined ? 0 : Math.min(line.running - liveWorkers, inReviewTasks);
      if (inReview > 0) parts.push(t('botsPage.profile.today.slotsInReview', { count: inReview }));
      if (line.waiting > 0) parts.push(t('botsPage.profile.today.workersWaiting', { count: line.waiting }));
      return { label: t('botsPage.profile.today.workers'), value: parts.join(' · ') };
    }
    case 'queue': return { label: t('botsPage.profile.today.queue'), value: t('botsPage.profile.today.ofMax', { count: line.depth, max: line.cap }) };
    case 'account': return { label: t('botsPage.profile.today.account'), value: line.name ?? t('botsPage.profile.today.defaultAccount') };
    case 'quotaSession':
    case 'quotaWeekly': return {
      label: t(line.id === 'quotaSession' ? 'botsPage.profile.today.quotaSession' : 'botsPage.profile.today.quotaWeekly'),
      value: line.resetsAt !== undefined
        ? t('botsPage.profile.today.quotaResets', { pct: line.pct, time: formatNoticeTime(line.resetsAt) })
        : t('botsPage.profile.today.quotaUsed', { pct: line.pct }),
    };
    case 'cost': return { label: t('botsPage.profile.today.cost'), value: t('botsPage.profile.today.costValue', { day: usdText(line.dayUsd), total: usdText(line.totalUsd) }) };
  }
}

/** "$1.24". */
export function usdText(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** `liveWorkers`: the bot's workers live now (the profile's "Workers now"),
 *  to name the slots held by tasks in review. */
export function BotToday({ row, act, liveWorkers, t }: { row: FactoryBotRow; act?: FactoryBotPort['act']; liveWorkers?: number; t: T }) {
  const [busy, setBusy] = useState(false);
  const view = botBudgetView(row.bot, row.status);
  if (!view.blocker && view.lines.length === 0) return null;
  const canResume = !!act && botActionsFor(row).resume;
  // A task in review (reported, still open) may keep its worker's slot.
  const inReviewTasks = (row.tasks ?? []).filter((task) => task.stage === 'coded').length;
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
        {/* One label column for every row, so each value starts at the same x. */}
        <ul className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-0.5 tabular-nums">
          {view.lines.map((line) => {
            const { label, value } = lineText(line, t, liveWorkers, inReviewTasks);
            return (
              <li
                key={line.id}
                data-bots-today-line={line.id}
                data-reached={line.reached ? 'true' : undefined}
                {...(line.id === 'cost' ? { title: t('botsPage.profile.today.costHint') } : {})}
                className={`col-span-2 grid grid-cols-subgrid ${line.reached ? 'text-[var(--accent-yellow)]' : 'text-[var(--text-sub)]'}`}
              >
                <span className={`whitespace-nowrap ${line.reached ? '' : 'text-[var(--text-muted)]'}`}>{label}</span>
                <span {...(line.id === 'turnsDay' ? { 'data-bots-profile-turns': '' } : {})}>{value}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
