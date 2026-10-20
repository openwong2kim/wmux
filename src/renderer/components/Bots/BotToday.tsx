// The bot profile's Today block: one line on what keeps the bot from new
// work now (with Resume when it is parked), then each limit with what is
// used of it. botBudgetView.ts decides; this only words and colours it.
// When the park came from a known engine_unavailable cause, a Fix card
// replaces the raw English lastError with a localized line, a Fix action,
// and the raw detail behind a toggle.

import { useState } from 'react';
import Button from '../ui/Button';
import { useStore } from '../../stores';
import type { FactoryBotPort, FactoryBotRow } from '../Room/factoryPorts';
import { botActionsFor } from '../Room/BotChips';
import { formatNoticeTime } from '../Room/roomFormat';
import { botBudgetView, type BotBlocker, type BotTodayLine } from './botBudgetView';
import { bridgeEnginePort } from './botsEngine';
import { showWorkspaces } from '../../utils/showWorkspaces';
import { CLAUDE_CODE_INSTALL_URL } from '../../../shared/factoryEngine';
import { openFactorySettings } from './botsAddBot';

type T = (key: string, vars?: Record<string, string | number>) => string;

type EngineErrorCode = 'not_installed' | 'not_logged_in' | 'mcp_missing' | 'acp_test_only' | 'unusable' | 'api_key_missing' | 'subscription_refused' | 'other';

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

const ENGINE_ERROR_KEYS: Record<EngineErrorCode, string> = {
  not_installed: 'botsPage.engineError.notInstalled',
  not_logged_in: 'botsPage.engineError.notLoggedIn',
  mcp_missing: 'botsPage.engineError.mcpMissing',
  acp_test_only: 'botsPage.engineError.acpTestOnly',
  unusable: 'botsPage.engineError.unusable',
  api_key_missing: 'settings.factory.claudeAuth.engineError.apiKeyMissing',
  subscription_refused: 'settings.factory.claudeAuth.engineError.subscriptionRefused',
  other: 'botsPage.engineError.other',
};

function openClaudeInstallPage(): void {
  void window.electronAPI?.shell?.openExternal?.(CLAUDE_CODE_INSTALL_URL)?.catch?.(() => undefined);
}

/** Localized engine-error card with Fix + details. Pure over the row's lastError. */
function EngineErrorCard({
  botId,
  code,
  account,
  message,
  t,
  onResume,
  canResume,
  busy,
}: {
  botId: string;
  code: EngineErrorCode;
  /** `not_logged_in` on a registered account: its name. */
  account?: string;
  message: string;
  t: T;
  onResume: () => void;
  canResume: boolean;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [fixBusy, setFixBusy] = useState(false);
  const engine = bridgeEnginePort();

  const fix = async () => {
    setFixBusy(true);
    try {
      if (code === 'not_installed') {
        openClaudeInstallPage();
        return;
      }
      if (code === 'not_logged_in' && engine.login) {
        // The sign-in of the account this bot runs on, in a terminal tab the
        // page steps aside to (as the first screen's Log in does).
        await engine.login(botId);
        const st = useStore.getState();
        st.pushToast({ message: t('botsPage.onboarding.loginOpened'), level: 'info' });
        showWorkspaces(st);
        return;
      }
      // Bots' Claude sign-in is chosen in Settings › Bots.
      if (code === 'api_key_missing' || code === 'subscription_refused') {
        openFactorySettings();
        return;
      }
      // mcp_missing / unusable / other / acp: resume after the owner fixed it,
      // or just open details — Resume is the recovery once the cause is gone.
      if (canResume) onResume();
    } catch (err) {
      useStore.getState().pushToast({
        message: err instanceof Error ? err.message : String(err),
        level: 'error',
      });
    } finally {
      setFixBusy(false);
    }
  };

  const fixLabel =
    code === 'not_installed' ? t('botsPage.onboarding.install')
      : code === 'not_logged_in' ? t('botsPage.onboarding.login')
        : code === 'api_key_missing' || code === 'subscription_refused' ? t('botsPage.openSettings')
          : t('botsPage.engineError.fix');

  const showFix = code === 'not_installed' || (code === 'not_logged_in' && !!engine.login) || code === 'api_key_missing' || code === 'subscription_refused' || canResume;

  return (
    <div className="flex flex-col gap-1 pb-1" data-bots-engine-error={code} role="status">
      {/* The buttons wrap below the text in a narrow column (the profile
          popover): the text keeps a readable width, never squeezed to 0. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-bots-engine-error-row>
        <span className="min-w-[10rem] flex-1 text-[var(--text-sub)]">
          {code === 'not_logged_in' && account ? t('botsPage.engineError.notLoggedInAccount', { account }) : t(ENGINE_ERROR_KEYS[code])}
        </span>
        {showFix && (
          <Button size="sm" variant="primary" data-bots-engine-error-fix disabled={fixBusy || busy} onClick={() => void fix()}>
            {fixLabel}
          </Button>
        )}
        {canResume && (
          <Button size="sm" variant="secondary" data-testid="bots-resume-bot" disabled={busy} onClick={onResume}>{t('room.bot.resume')}</Button>
        )}
      </div>
      <button
        type="button"
        data-bots-engine-error-details
        className="self-start text-[11px] text-[var(--text-muted)] underline-offset-2 hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? t('botsPage.engineError.hideDetails') : t('botsPage.engineError.showDetails')}
      </button>
      {open && (
        <pre data-bots-engine-error-raw className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[var(--selection-subtle)] px-2 py-1 text-[11px] text-[var(--text-muted)]">
          {message}
        </pre>
      )}
    </div>
  );
}

/** `liveWorkers`: the bot's workers live now (the profile's "Workers now"),
 *  to name the slots held by tasks in review. */
export function BotToday({ row, act, liveWorkers, t }: { row: FactoryBotRow; act?: FactoryBotPort['act']; liveWorkers?: number; t: T }) {
  const [busy, setBusy] = useState(false);
  const view = botBudgetView(row.bot, row.status);
  if (!view.blocker && view.lines.length === 0) return null;
  const canResume = !!act && botActionsFor(row).resume;
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
  const err = row.status?.lastError;
  const engineCode = view.blocker?.kind === 'errors' && err?.code ? err.code : null;

  return (
    <div className="flex items-baseline gap-3 py-1 text-[12px]" data-bots-profile-today>
      <span className="w-[112px] shrink-0 text-[var(--text-muted)]">{t('botsPage.profile.today')}</span>
      <div className="min-w-0 flex-1">
        {view.blocker && engineCode && err && (
          <EngineErrorCard
            botId={row.bot.id}
            code={engineCode}
            {...(err.account ? { account: err.account } : {})}
            message={err.message}
            t={t}
            canResume={canResume}
            busy={busy}
            onResume={() => void resume()}
          />
        )}
        {view.blocker && !engineCode && (
          <div
            className="flex items-center gap-3 pb-1"
            data-bots-profile-blocker={view.blocker.kind}
            {...(row.bot.parked ? { 'data-bots-profile-parked': row.bot.parked.reason } : {})}
          >
            <span className="min-w-0 flex-1 text-[var(--text-sub)]">{blockerText(view.blocker, row.bot.name, t)}</span>
            {canResume && <Button size="sm" variant="secondary" data-testid="bots-resume-bot" disabled={busy} onClick={() => void resume()}>{t('room.bot.resume')}</Button>}
          </div>
        )}
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
