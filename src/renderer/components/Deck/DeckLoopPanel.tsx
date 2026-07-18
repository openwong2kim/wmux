// ─── Command Deck — the one-click loop panel (loop engineering v1) ───────────
//
// The deck-side surface for the workspace loop: a compact toggle chip (lives
// with the quick-action chips) that expands an inline panel above the composer.
// No loop → the ONE-CLICK form (objective + optional done-when checklist +
// autonomy tier + cadence) whose single [Start loop] writes loop-state,
// autonomy caps and the cadence schedule in one action (DECK_LOOP_START).
// Loop exists → the status card (objective · N/M passing · status) with the
// OFF contract buttons ([pause]/[resume]/[stop] — caps drop to DEFAULT,
// schedule cleaned up, all main-side).
//
// v1 posture (plans/loop-engineering-adoption-2026-07-12.md): the tier dropdown
// caps at `continue` — a per-loop "full-auto" tier is NOT offered here. Approval-
// press is not a loop knob at all; it composes from the workspace MODE ceiling
// (auto), so a `continue` loop presses only when the workspace is in auto —
// see deck.handler's applyTierCaps (min(modeCeiling, tier)). The checklist is
// HUMAN-authored, read-only context for the brain (no self-scoring); `done`
// never suppresses wakes — the human stops the loop with these buttons.
//
// Self-contained on purpose (the DeckSchedulesPanel pattern): all IPC goes
// through the injected `api` prop (defaulting to window.electronAPI.deck.loop
// in the container), so the whole panel unit-tests under jsdom with a fake api
// and zero store wiring. Renders nothing when the preload is absent.

import { useCallback, useEffect, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { DeckLoopModal } from './DeckLoopModal';
import type { WorkspaceLoopState, LoopTier } from '../../../main/deck/deckLoopStateStore';

export interface DeckLoopApi {
  get: (workspaceId: string) => Promise<{
    loop: WorkspaceLoopState | null;
    /** Live auto-wake budget (optional — older preloads may omit it). */
    wakeBudget?: { remaining: number; total: number } | null;
  }>;
  /** The human ticks a done-when item — the only writer of `passes`. */
  setTask: (args: {
    workspaceId: string;
    taskId: string;
    passes: boolean;
  }) => Promise<{ ok: boolean; loop?: WorkspaceLoopState }>;
  start: (args: {
    workspaceId: string;
    objective: string;
    /** 매 iteration 절차(선택) — 모달의 steps 편집기가 채운다. */
    steps?: string[];
    taskTexts?: string[];
    tier?: LoopTier;
    intervalMinutes?: number;
    iterations?: number;
  }) => Promise<{ ok: boolean; loop?: WorkspaceLoopState; code?: string }>;
  stop: (workspaceId: string) => Promise<{ ok: boolean }>;
  pause: (workspaceId: string) => Promise<{ ok: boolean }>;
  resume: (workspaceId: string) => Promise<{ ok: boolean }>;
  /** 스킬 픽커 카탈로그(선택 — 구 preload엔 없을 수 있다). */
  skills?: (cwd: string) => Promise<{ skills: import('../../../main/deck/skillCatalogScan').SkillCatalogEntry[] }>;
}

export function DeckLoopPanel({
  api,
  workspaceId,
  cwd,
  t: tProp,
}: {
  api?: DeckLoopApi;
  /** The workspace this deck view is bound to — the loop is per-workspace. */
  workspaceId?: string;
  /** 활성 pane cwd — 모달의 스킬 카탈로그 스캔 기준(선택). */
  cwd?: string;
  t?: (key: string) => string;
}): React.ReactElement | null {
  const t = tProp ?? (() => '');
  // Optional-chain the whole path — window.electronAPI itself is absent under
  // jsdom and in dev shells without the preload.
  const resolvedApi =
    api ??
    (window.electronAPI as unknown as { deck?: { loop?: DeckLoopApi } } | undefined)?.deck?.loop;
  const [open, setOpen] = useState(false);
  // 루프가 없을 때 칩은 설정 모달을 연다(인라인 폼은 도크 폭에서 넘쳐 Start가
  // 화면 밖으로 밀리는 결함이 있어 모달로 승격 — DeckLoopModal 헤더 주석).
  const [modalOpen, setModalOpen] = useState(false);
  const [loop, setLoop] = useState<WorkspaceLoopState | null>(null);
  const [wakeBudget, setWakeBudget] = useState<{ remaining: number; total: number } | null>(null);

  const refresh = useCallback(async () => {
    if (!resolvedApi || !workspaceId) return;
    try {
      const r = await resolvedApi.get(workspaceId);
      setLoop(r.loop);
      setWakeBudget(r.wakeBudget ?? null);
    } catch {
      /* main gone — leave the stale view */
    }
  }, [resolvedApi, workspaceId]);

  // The chip label shows live loop state, so hydrate on mount and whenever the
  // deck rebinds to another workspace — not only when the panel opens.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!resolvedApi) return null;

  const passing = loop ? loop.tasks.filter((task) => task.passes).length : 0;
  const running = loop?.status === 'running';

  return (
    <>
      <button
        type="button"
        data-deck-loop-toggle
        aria-expanded={loop ? open : modalOpen}
        onClick={() => {
          // 루프 있음 → 인라인 상태 카드 토글. 없음 → 설정 모달.
          if (loop) setOpen((v) => !v);
          else setModalOpen(true);
        }}
        className={`px-2.5 py-1 rounded-md text-[12px] transition-opacity hover:opacity-80 ${
          open ? 'text-[var(--accent-blue)]' : 'text-[var(--text-sub)]'
        } bg-[rgba(var(--bg-surface-rgb),0.6)] ${FOCUS_RING}`}
        {...(open ? tokenAttrs('accent', 'text') : tokenAttrs('textSub', 'text'))}
      >
        {/* Amber dot = the loop is alive (running). Same meaning-class as the
            fleet running dots — counts once against the amber budget. */}
        {running && (
          <span
            aria-hidden="true"
            data-deck-loop-live-dot
            className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
            style={{ backgroundColor: 'var(--accent)' }}
          />
        )}
        {loop
          ? `${t('deck.loop') || 'Loop'}${loop.tasks.length > 0 ? ` ${passing}/${loop.tasks.length}` : ''}${
              loop.status === 'paused' ? ` · ${t('deck.loopPaused') || 'paused'}` : ''
            }`
          : t('deck.loopStartChip') || 'Start a loop'}
      </button>

      {open && loop && (
        <div
          data-deck-loop-panel
          className="w-full mt-1.5 rounded-[7px] px-4 py-3 space-y-2 bg-[rgba(var(--bg-surface-rgb),0.55)]"
        >
          {(
            <>
              {/* Status card — objective is the headline; machine facts in mono. */}
              <div className="flex items-baseline gap-2">
                <span
                  data-deck-loop-objective
                  className="flex-1 text-[12.5px] font-semibold text-[var(--text-main)] leading-relaxed break-words"
                  {...tokenAttrs('textMain', 'text')}
                >
                  {loop.objective}
                </span>
                <span
                  data-deck-loop-status
                  className="text-[10.5px] font-mono shrink-0 text-[var(--text-sub)]"
                  {...tokenAttrs('textSub', 'text')}
                >
                  {loop.status}
                  {loop.tasks.length > 0 ? ` · ${passing}/${loop.tasks.length}` : ''}
                  {wakeBudget ? ` · wake ${wakeBudget.remaining}/${wakeBudget.total}` : ''}
                </span>
              </div>
              {/* Done-when checklist — the HUMAN ticks items (the only writer
                  of `passes`; the brain never self-scores). Ticking the last
                  one flips the loop to done; un-ticking re-opens it. */}
              {loop.tasks.length > 0 && (
                <div className="space-y-0.5" data-deck-loop-tasks>
                  {loop.tasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      data-deck-loop-task
                      data-task-id={task.id}
                      role="checkbox"
                      aria-checked={task.passes}
                      onClick={() => {
                        if (!workspaceId) return;
                        void resolvedApi
                          .setTask({ workspaceId, taskId: task.id, passes: !task.passes })
                          .then(() => refresh());
                      }}
                      className={`block w-full text-left text-[11.5px] font-mono leading-relaxed hover:opacity-80 transition-opacity ${
                        task.passes ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-sub)]'
                      } ${FOCUS_RING}`}
                      {...(task.passes ? tokenAttrs('textMuted', 'text') : tokenAttrs('textSub', 'text'))}
                    >
                      [{task.passes ? 'x' : ' '}] {task.text}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2 pt-1">
                {loop.status === 'paused' ? (
                  <button
                    type="button"
                    data-deck-loop-resume
                    onClick={() => {
                      if (workspaceId) void resolvedApi.resume(workspaceId).then(() => refresh());
                    }}
                    className={`px-2.5 py-1 rounded-[4px] text-[12px] font-semibold bg-[var(--accent)] text-[var(--bg-base)] shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(0,0,0,0.3)] hover:bg-[color-mix(in_srgb,var(--accent)_88%,var(--text-main))] transition-colors ${FOCUS_RING}`}
                    {...tokenAttrs('accent', 'bg')}
                  >
                    {t('deck.loopResume') || 'Resume'}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-deck-loop-pause
                    onClick={() => {
                      if (workspaceId) void resolvedApi.pause(workspaceId).then(() => refresh());
                    }}
                    className={`px-2.5 py-1 rounded-[4px] text-[12px] text-[var(--text-sub)] bg-[rgba(var(--bg-surface-rgb),0.8)] hover:opacity-80 transition-opacity ${FOCUS_RING}`}
                    {...tokenAttrs('textSub', 'text')}
                  >
                    {t('deck.loopPause') || 'Pause'}
                  </button>
                )}
                <button
                  type="button"
                  data-deck-loop-stop
                  onClick={() => {
                    if (workspaceId) void resolvedApi.stop(workspaceId).then(() => refresh());
                  }}
                  className={`px-2.5 py-1 rounded-[4px] text-[12px] border transition-colors bg-[color-mix(in_srgb,var(--accent-red)_15%,transparent)] border-[color-mix(in_srgb,var(--accent-red)_32%,transparent)] text-[color-mix(in_srgb,var(--accent-red)_70%,var(--text-main))] hover:bg-[color-mix(in_srgb,var(--accent-red)_22%,transparent)] ${FOCUS_RING}`}
                  {...tokenAttrs('danger', 'text')}
                >
                  {t('deck.loopStop') || 'Stop loop'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 설정 모달 — objective/steps(스킬 픽커)/done-when/고급. START 성공 시
          상태 카드가 바로 보이도록 open을 켜고 refresh한다. */}
      {modalOpen && (
        <DeckLoopModal
          api={resolvedApi}
          workspaceId={workspaceId}
          cwd={cwd}
          modeApi={
            (window.electronAPI as unknown as { deck?: { mode?: import('./AgentModeChip').AgentModeApi } } | undefined)
              ?.deck?.mode
          }
          t={t}
          onClose={() => setModalOpen(false)}
          onStarted={() => {
            setOpen(true);
            void refresh();
          }}
        />
      )}
    </>
  );
}

export default DeckLoopPanel;
