// ─── Command Deck — per-workspace agent mode chip ───────────────────────────
//
// The single user-facing autonomy control (owner design 2026-07-13, revised
// 2026-07-17). Lives with the quick-action chips so the CURRENT mode is always
// visible — the answer to both "why is it quiet?" and "why is it talking?" is
// on screen. Click → a dropdown of the three modes.
//
//   off     no autonomy (default); also stops running loops + schedules
//   assist  wakes only when a pane needs input, or to drive a running loop
//   auto    DANGER: wakes on every agent event; drives panes and presses
//           approvals on its own judgment, running work to completion
//
// Self-contained (the DeckLoopPanel / DeckSchedulesPanel pattern): all IPC goes
// through the injected `api` prop, defaulting to window.electronAPI.deck.mode in
// the container. Renders nothing when the preload is absent, so pure jsdom tests
// of the parent view are unaffected.

import { useCallback, useEffect, useRef, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { AgentMode } from '../../../main/deck/deckAutonomyStore';
import { requestHooksInstallPrompt } from './HooksInstallPrompt';

export interface AgentModeApi {
  get: (workspaceId: string) => Promise<{ mode: AgentMode | null }>;
  set: (
    workspaceId: string,
    mode: AgentMode,
  ) => Promise<{ ok: boolean; mode?: AgentMode; code?: string }>;
}

/** Order shown in the dropdown, least → most autonomous. */
const MODE_ORDER: readonly AgentMode[] = ['off', 'assist', 'auto'];

// Per-mode chip skin so the CURRENT autonomy state reads at a glance (the chip
// is the one always-visible answer to "why is it quiet/talking?"). Colors map
// straight onto the DESIGN.md grammar, no new accents:
//   off     nothing alive → neutral graphite + gray idle dot
//   assist  alive, safe   → warm --accent (alive/attention) + subtle warm tint
//   auto    alive + destructive → red --accent-red outline (destructive = red
//           tint at rest, never a fill/wash) + red dot, bold for weight
// `border` is kept on every state (transparent when off) so switching modes
// never shifts the bar's layout by a pixel.
const MODE_SKIN: Record<AgentMode, { btn: string; dot: string }> = {
  off: {
    btn: 'border border-transparent text-[var(--text-sub)] bg-[rgba(var(--bg-surface-rgb),0.6)]',
    dot: 'bg-[var(--text-muted)]',
  },
  assist: {
    btn: 'border border-[rgba(var(--accent-rgb),0.45)] text-[var(--accent)] bg-[rgba(var(--accent-rgb),0.12)] font-medium',
    dot: 'bg-[var(--accent)]',
  },
  auto: {
    btn: 'border border-[var(--accent-red)] text-[var(--accent-red)] bg-[rgba(var(--bg-surface-rgb),0.6)] font-semibold',
    dot: 'bg-[var(--accent-red)]',
  },
};

function modeLabel(t: (k: string) => string, mode: AgentMode): string {
  return t(`deck.mode.${mode}`) || mode;
}
function modeDesc(t: (k: string) => string, mode: AgentMode): string {
  return t(`deck.mode.${mode}Desc`) || '';
}

export function AgentModeChip({
  api,
  workspaceId,
  t,
}: {
  /** Injected in tests; defaults to the preload bridge in the container. */
  api: AgentModeApi;
  workspaceId: string;
  t: (key: string) => string;
}): React.ReactElement | null {
  const [mode, setMode] = useState<AgentMode | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get(workspaceId)
      .then((r) => { if (!cancelled) setMode(r.mode ?? 'off'); })
      .catch(() => { if (!cancelled) setMode('off'); });
    return () => { cancelled = true; };
  }, [api, workspaceId]);

  // Close the dropdown on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = useCallback(
    (next: AgentMode) => {
      setOpen(false);
      const prev = mode;
      setMode(next); // optimistic
      api
        .set(workspaceId, next)
        .then((r) => { if (r.ok && r.mode) setMode(r.mode); else setMode(prev); })
        .catch(() => setMode(prev));
      // Raising autonomy means the orchestrator is about to rely on lifecycle
      // signals — if the hook bridge is missing, this is the moment to say so.
      // The prompt re-checks install status itself (no-op when installed).
      if (next !== 'off') requestHooksInstallPrompt();
    },
    [api, workspaceId, mode],
  );

  if (mode === null) return null; // pre-first-read; avoids a label flash

  return (
    <div ref={rootRef} className="relative" data-agent-mode-chip>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] hover:opacity-80 transition-opacity ${MODE_SKIN[mode].btn} ${FOCUS_RING}`}
        title={modeDesc(t, mode)}
      >
        <span
          aria-hidden="true"
          data-agent-mode-dot
          className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${MODE_SKIN[mode].dot}`}
        />
        {t('deck.mode.label') || 'Mode'}: {modeLabel(t, mode)}
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 mb-1 z-50 w-64 bg-[var(--bg-overlay)] border border-[var(--bg-surface)] rounded-md shadow-lg py-1 text-xs"
        >
          {MODE_ORDER.map((m) => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={m === mode}
              data-mode-option={m}
              onClick={() => pick(m)}
              className={`w-full text-left px-3 py-1.5 hover:bg-[var(--bg-surface)] transition-colors ${
                m === mode ? 'text-[var(--accent-blue)]' : 'text-[var(--text-main)]'
              }`}
            >
              <div className="font-semibold">{modeLabel(t, m)}</div>
              <div className="text-[var(--text-muted)] text-[10px]">{modeDesc(t, m)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Container: binds the preload bridge. Renders nothing if the API is absent
 *  (older preload / pure jsdom parent tests). */
export function AgentModeChipContainer({
  workspaceId,
  t,
}: {
  workspaceId?: string;
  t: (key: string) => string;
}): React.ReactElement | null {
  const api = (window as unknown as {
    electronAPI?: { deck?: { mode?: AgentModeApi } };
  }).electronAPI?.deck?.mode;
  if (!api || !workspaceId) return null;
  return <AgentModeChip api={api} workspaceId={workspaceId} t={t} />;
}
