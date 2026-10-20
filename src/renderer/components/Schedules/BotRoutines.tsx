// ─── Bot routines, read-only ───────────────────────────────────────────────
//
// The routines bots keep for themselves (main/factory/routines.ts) are not
// schedules the owner edits: a bot sets them in chat when the owner asks, and
// pauses them itself or when it is stopped. The Schedules page lists them
// under the schedules, and a bot's profile lists its own, read-only — the
// title, the bot, when it runs and whether it is paused (and why) or, for a
// one-time routine, done (fired or missed). Read
// through `electronAPI.factory.listRoutines` (routine.list as the operator),
// again on every bot event.
import { useEffect, useState } from 'react';
import type { BotRoutine, RoutineSchedule } from '../../../shared/botRoutine';
import { t } from '../../i18n';
import { useT } from '../../hooks/useT';
import { describeDays, formatWhen } from './format';
import { DAILY } from './scheduleModel';

interface RoutineBridge {
  listRoutines?: () => Promise<BotRoutine[]>;
  listBots?: (req?: { workspaceId?: string }) => Promise<{ bots: Array<{ bot: { id: string; name: string } }> }>;
  onBotEvent?: (cb: () => void) => () => void;
}

function bridge(): RoutineBridge | null {
  const f = (globalThis as { electronAPI?: { factory?: unknown } }).electronAPI?.factory;
  return f && typeof f === 'object' ? (f as RoutineBridge) : null;
}

/** "Every 15 min", "Every 2 h", "Daily 09:00", "Mon Wed 09:00",
 *  "Once Tomorrow 09:00". */
export function routineScheduleText(s: RoutineSchedule, now = Date.now()): string {
  if (s.kind === 'once') return t('schedules.routines.once', { when: formatWhen(s.at, now) });
  if (s.kind === 'interval') {
    const min = Math.round(s.everyMs / 60_000);
    return min >= 60 && min % 60 === 0 ? t('schedules.routines.everyHours', { count: min / 60 }) : t('schedules.routines.everyMinutes', { count: min });
  }
  const time = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  return `${describeDays(s.weekdays ?? DAILY)} ${time}`;
}

/** The state in words: when it runs next, why it is paused, or how a
 *  one-time routine ended (its time is in the schedule text already). */
export function routineStateText(r: BotRoutine, now = Date.now()): string {
  if (r.state === 'paused') return t(`schedules.routines.paused.${r.paused?.reason ?? 'owner'}`);
  if (r.state === 'done') return t(`schedules.routines.done.${r.done?.reason ?? 'missed'}`);
  return r.nextDueAt !== undefined && r.schedule.kind !== 'once' ? formatWhen(r.nextDueAt, now) : t('schedules.routines.active');
}

/** Every routine and the bots' names, or null while unread / without the
 *  factory bridge. Re-read on every bot event (a bot's routines changed is
 *  one of them), at most every 250 ms. */
export function useBotRoutines(): { routines: BotRoutine[]; names: Record<string, string> } | null {
  const [state, setState] = useState<{ routines: BotRoutine[]; names: Record<string, string> } | null>(null);
  useEffect(() => {
    const b = bridge();
    if (!b?.listRoutines) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const [routines, bots] = await Promise.all([b.listRoutines?.() ?? [], b.listBots?.({}) ?? { bots: [] }]);
        if (!alive) return;
        const names: Record<string, string> = {};
        for (const row of bots.bots ?? []) names[row.bot.id] = row.bot.name;
        setState({ routines, names });
      } catch {
        if (alive) setState((cur) => cur ?? { routines: [], names: {} });
      }
    };
    void load();
    const off = b.onBotEvent?.(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 250);
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      off?.();
    };
  }, []);
  return state;
}

/** The Schedules list's read-only section of bot routines (none: not drawn). */
export function BotRoutinesSection(): React.ReactElement | null {
  const tt = useT();
  const data = useBotRoutines();
  if (!data || data.routines.length === 0) return null;
  return (
    <section aria-label={tt('schedules.routines.title')} data-bot-routines className="mt-3 flex flex-col gap-0.5">
      <h3 className="px-2.5 pb-1 text-[11px] font-[var(--title-weight,500)] text-[var(--text-muted)]">{tt('schedules.routines.title')}</h3>
      <ul className="wmux-schedules-rows">
        {data.routines.map((r) => (
          <li key={r.id} data-bot-routine={r.id} data-state={r.state}>
            <div className="wmux-schedules-row wmux-schedules-row-static" data-off={r.state !== 'active' ? 'true' : undefined}>
              <span className="wmux-schedules-row-name"><span className="truncate">{r.title}</span></span>
              <span className="wmux-schedules-row-meta truncate">
                {`${data.names[r.botId] ?? tt('room.actor.bot')} · ${routineScheduleText(r.schedule)} · ${routineStateText(r)}`}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
