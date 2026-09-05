// ─── Command Deck — orchestrator schedules panel (P3d) ───────────────────────
//
// The deck-side surface for persisted schedules: a compact toggle chip (lives
// visually with the quick-action chips) that expands an inline panel above the
// composer — list existing schedules (next run, repeat, pause/resume, delete)
// and create new ones (prompt + first run time + repeat).
//
// Self-contained on purpose: all IPC goes through the injected `api` prop
// (defaulting to window.electronAPI.deck.schedules in the container), so the
// whole panel unit-tests under jsdom with a fake api and zero store wiring.

import { useCallback, useEffect, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { DeckSchedule } from '../../../main/deck/deckScheduleStore';

export interface DeckSchedulesApi {
  list: () => Promise<{ schedules: DeckSchedule[] }>;
  create: (args: {
    workspaceId: string;
    prompt: string;
    nextRunAt: number;
    intervalMinutes?: number;
  }) => Promise<{ ok: boolean; schedule?: DeckSchedule; code?: string }>;
  update: (args: {
    id: string;
    enabled?: boolean;
    /** Re-scope: assignable ONCE to a pre-M1.5 schedule that has no
     *  workspace; owned schedules never migrate. */
    workspaceId?: string;
  }) => Promise<{ ok: boolean; code?: string }>;
  remove: (id: string) => Promise<{ ok: boolean }>;
}

const REPEAT_OPTIONS: { minutes: number; labelKey: string; fallback: string }[] = [
  { minutes: 0, labelKey: 'deck.scheduleRepeatNone', fallback: 'Once' },
  { minutes: 30, labelKey: 'deck.scheduleRepeat30m', fallback: 'Every 30 min' },
  { minutes: 60, labelKey: 'deck.scheduleRepeat1h', fallback: 'Every hour' },
  { minutes: 360, labelKey: 'deck.scheduleRepeat6h', fallback: 'Every 6 hours' },
  { minutes: 1440, labelKey: 'deck.scheduleRepeat24h', fallback: 'Every day' },
];

/** datetime-local value for "now + 5 minutes", in LOCAL time. */
function defaultWhenValue(now = new Date()): string {
  const d = new Date(now.getTime() + 5 * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatNextRun(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DeckSchedulesPanel({
  api,
  workspaceId,
  workspaceName,
  t: tProp,
}: {
  api?: DeckSchedulesApi;
  /** M1.5: the workspace new schedules bind to (the deck's active one). */
  workspaceId?: string;
  /** Resolve a workspaceId to its display name for the row chips. */
  workspaceName?: (id: string) => string | undefined;
  t?: (key: string) => string;
}): React.ReactElement | null {
  const t = tProp ?? (() => '');
  // Optional-chain the whole path — window.electronAPI itself is absent under
  // jsdom and in dev shells without the preload.
  const resolvedApi =
    api ??
    (window.electronAPI as unknown as { deck?: { schedules?: DeckSchedulesApi } } | undefined)?.deck
      ?.schedules;
  const [open, setOpen] = useState(false);
  const [schedules, setSchedules] = useState<DeckSchedule[]>([]);
  const [prompt, setPrompt] = useState('');
  const [when, setWhen] = useState(defaultWhenValue);
  const [repeat, setRepeat] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!resolvedApi) return;
    try {
      const r = await resolvedApi.list();
      setSchedules(r.schedules);
    } catch {
      /* main gone — leave the stale list */
    }
  }, [resolvedApi]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!resolvedApi) return null;

  const handleCreate = async (): Promise<void> => {
    setError(null);
    if (!workspaceId) {
      setError(t('deck.scheduleNoWorkspace') || 'Open a workspace first — schedules belong to a workspace.');
      return;
    }
    const nextRunAt = new Date(when).getTime();
    if (!prompt.trim() || !Number.isFinite(nextRunAt)) {
      setError(t('deck.scheduleInvalid') || 'Enter a prompt and a valid time.');
      return;
    }
    const res = await resolvedApi.create({
      workspaceId,
      prompt,
      nextRunAt,
      ...(repeat > 0 ? { intervalMinutes: repeat } : {}),
    });
    if (!res.ok) {
      setError(
        res.code === 'limit'
          ? t('deck.scheduleLimit') || 'Schedule limit reached.'
          : t('deck.scheduleInvalid') || 'Enter a prompt and a valid time.',
      );
      return;
    }
    setPrompt('');
    setWhen(defaultWhenValue());
    setRepeat(0);
    void refresh();
  };

  return (
    <>
      <button
        type="button"
        data-deck-schedules-toggle
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`px-1.5 py-0.5 rounded-md text-[11px] transition-opacity hover:opacity-80 ${
          open ? 'text-[var(--accent-blue)]' : 'text-[var(--text-sub)]'
        } bg-[rgba(var(--bg-surface-rgb),0.6)] ${FOCUS_RING}`}
        {...(open ? tokenAttrs('accent', 'text') : tokenAttrs('textSub', 'text'))}
      >
        {t('deck.schedules') || 'Schedules'}
        {schedules.some((s) => s.enabled) ? ` (${schedules.filter((s) => s.enabled).length})` : ''}
      </button>

      {open && (
        <div
          data-deck-schedules-panel
          className="w-full mt-1.5 rounded-[7px] px-4 py-3 space-y-2 bg-[rgba(var(--bg-surface-rgb),0.55)]"
        >
          {/* Existing schedules */}
          {schedules.length === 0 ? (
            <div
              className="text-[12px] text-[var(--text-muted)] leading-relaxed"
              data-deck-schedules-empty
              {...tokenAttrs('textMuted', 'text')}
            >
              {t('deck.schedulesEmpty') || 'No schedules yet. Schedules survive reboots.'}
            </div>
          ) : (
            <div className="space-y-1.5">
              {schedules.map((s) => (
                <div
                  key={s.id}
                  data-deck-schedule-row
                  data-schedule-id={s.id}
                  className="flex items-center gap-2 text-[13px]"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: s.enabled ? 'var(--accent-green)' : 'var(--text-muted)' }}
                  />
                  <span
                    className={`flex-1 truncate ${s.enabled ? 'text-[var(--text-main)]' : 'text-[var(--text-muted)]'}`}
                    title={s.prompt}
                  >
                    {s.prompt}
                  </span>
                  {/* Workspace chip (M1.5): which orchestrator fires this
                      schedule. A pre-M1.5 row has none — it is force-disabled
                      until re-scoped below. */}
                  {s.workspaceId ? (
                    <span
                      data-deck-schedule-workspace
                      className="text-[11px] px-1.5 py-0.5 rounded shrink-0 text-[var(--text-sub)] bg-[rgba(var(--bg-surface-rgb),0.8)] max-w-[110px] truncate"
                      title={workspaceName?.(s.workspaceId) ?? s.workspaceId}
                      {...tokenAttrs('textSub', 'text')}
                    >
                      {workspaceName?.(s.workspaceId) ?? s.workspaceId}
                    </span>
                  ) : (
                    <span
                      data-deck-schedule-needs-workspace
                      className="text-[11px] px-1.5 py-0.5 rounded shrink-0 text-[var(--accent-yellow)]"
                      {...tokenAttrs('warning', 'text')}
                    >
                      {t('deck.scheduleNeedsWorkspace') || 'needs workspace'}
                    </span>
                  )}
                  <span className="text-[11px] font-mono text-[var(--text-sub)] shrink-0" {...tokenAttrs('textSub', 'text')}>
                    {formatNextRun(s.nextRunAt)}
                    {s.intervalMinutes ? ` · ${
                      REPEAT_OPTIONS.find((o) => o.minutes === s.intervalMinutes)
                        ? t(REPEAT_OPTIONS.find((o) => o.minutes === s.intervalMinutes)!.labelKey) ||
                          REPEAT_OPTIONS.find((o) => o.minutes === s.intervalMinutes)!.fallback
                        : `${s.intervalMinutes}m`
                    }` : ''}
                  </span>
                  <button
                    type="button"
                    data-deck-schedule-toggle-enabled
                    onClick={() => {
                      // Re-enabling a pre-M1.5 row adopts it into the ACTIVE
                      // workspace (the operator is looking at that deck) —
                      // main rejects enabling with no workspace otherwise.
                      const adopt = !s.enabled && !s.workspaceId && workspaceId ? { workspaceId } : {};
                      void resolvedApi
                        .update({ id: s.id, enabled: !s.enabled, ...adopt })
                        .then(() => refresh());
                    }}
                    className={`px-1.5 py-0.5 rounded-md text-[11px] text-[var(--text-sub)] hover:opacity-80 ${FOCUS_RING}`}
                    {...tokenAttrs('textSub', 'text')}
                  >
                    {s.enabled
                      ? t('deck.schedulePause') || 'Pause'
                      : !s.workspaceId
                        ? t('deck.scheduleAdoptHere') || 'Adopt here'
                        : t('deck.scheduleResume') || 'Resume'}
                  </button>
                  <button
                    type="button"
                    data-deck-schedule-delete
                    onClick={() => {
                      void resolvedApi.remove(s.id).then(() => refresh());
                    }}
                    className={`px-1.5 py-0.5 rounded-md text-[11px] border transition-colors bg-[color-mix(in_srgb,var(--accent-red)_15%,transparent)] border-[color-mix(in_srgb,var(--accent-red)_32%,transparent)] text-[color-mix(in_srgb,var(--accent-red)_70%,var(--text-main))] hover:bg-[color-mix(in_srgb,var(--accent-red)_22%,transparent)] ${FOCUS_RING}`}
                    {...tokenAttrs('danger', 'text')}
                  >
                    {t('deck.scheduleDelete') || 'Delete'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Create */}
          <div className="flex flex-col gap-1.5 pt-2 border-t" style={{ borderColor: 'var(--border-soft)' }}>
            <input
              type="text"
              data-deck-schedule-prompt
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('deck.schedulePromptPlaceholder') || 'What should the orchestrator do?'}
              className="w-full text-[13px] rounded-md px-2.5 py-1.5 bg-[var(--bg-base)] text-[var(--text-main)] border focus:outline-none"
              style={{ borderColor: 'var(--border-soft)' }}
            />
            {/* The native datetime-local control is wide and refuses to shrink
                below its intrinsic width — without min-w-0 + wrapping it pushed
                the Add button past the deck's right edge. */}
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                type="datetime-local"
                data-deck-schedule-when
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                className="flex-1 min-w-0 basis-[150px] text-[11px] font-mono rounded-md px-1.5 py-1 bg-[var(--bg-base)] text-[var(--text-main)] border focus:outline-none"
                style={{ borderColor: 'var(--border-soft)' }}
              />
              <select
                data-deck-schedule-repeat
                value={repeat}
                onChange={(e) => setRepeat(Number(e.target.value))}
                className="min-w-0 shrink text-[11px] font-mono rounded-md px-1.5 py-1 bg-[var(--bg-base)] text-[var(--text-main)] border focus:outline-none"
                style={{ borderColor: 'var(--border-soft)' }}
                aria-label={t('deck.scheduleRepeat') || 'Repeat'}
              >
                {REPEAT_OPTIONS.map((o) => (
                  <option key={o.minutes} value={o.minutes}>
                    {t(o.labelKey) || o.fallback}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-deck-schedule-create
                onClick={() => void handleCreate()}
                className={`ml-auto shrink-0 whitespace-nowrap px-2.5 py-1 rounded-md text-[12px] font-semibold bg-[var(--accent)] text-[var(--bg-base)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--surface-highlight)_22%,transparent),0_1px_2px_rgba(0,0,0,0.3)] hover:bg-[color-mix(in_srgb,var(--accent)_88%,var(--text-main))] transition-colors ${FOCUS_RING}`}
                {...tokenAttrs('accent', 'bg')}
              >
                {t('deck.scheduleAdd') || 'Add schedule'}
              </button>
            </div>
            {error && (
              <div role="alert" data-deck-schedule-error className="text-[11px] text-[var(--accent-red)]" {...tokenAttrs('danger', 'text')}>
                {error}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export default DeckSchedulesPanel;
