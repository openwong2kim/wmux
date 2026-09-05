// ─── Command Deck — per-workspace agent mode chip ───────────────────────────
//
// The single user-facing autonomy control (owner design 2026-07-13, revised
// 2026-07-17). Lives with the quick-action chips so the CURRENT mode is always
// visible — the answer to both "why is it quiet?" and "why is it talking?" is
// on screen. Click → a dropdown of the three modes.
//
// The mode says HOW the workspace's Claude is launched (owner decision
// 2026-08-01) — what WAKES it is a separate stored axis:
//
//   off     the brain does not run at all (default); the deck composer is
//           disabled, and running loops + schedules are torn down
//   assist  launch Claude in auto (accept-edits) mode
//   danger  launch Claude in bypass mode (--dangerously-skip-permissions)
//
// Self-contained (the DeckLoopPanel / DeckSchedulesPanel pattern): all IPC goes
// through the injected `api` prop, defaulting to window.electronAPI.deck.mode in
// the container. Renders nothing when the preload is absent, so pure jsdom tests
// of the parent view are unaffected.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { AgentMode } from '../../../main/deck/deckAutonomyStore';
import { requestHooksInstallPrompt } from './HooksInstallPrompt';
import { notifyAgentModeChanged } from './deckModeBus';

export interface AgentModeApi {
  get: (workspaceId: string) => Promise<{ mode: AgentMode | null }>;
  set: (
    workspaceId: string,
    mode: AgentMode,
  ) => Promise<{ ok: boolean; mode?: AgentMode; code?: string }>;
}

/** Order shown in the dropdown, least → most autonomous. */
const MODE_ORDER: readonly AgentMode[] = ['off', 'assist', 'danger'];

// Per-mode DOT so the CURRENT autonomy state reads at a glance (the chip is the
// one always-visible answer to "why is it quiet/talking?"). The chip body stays
// boxless and neutral: DESIGN.md's toolbar rule is text-first until hover, and
// its status-dot vocabulary already carries the meaning —
//   off     nothing alive        → gray idle dot
//   assist  alive, safe          → warm --accent (alive/attention) dot
//   danger  alive + destructive  → red --accent-red dot
// The previous skin painted a red-tinted bordered pill for `danger` and a warm
// tinted pill for `assist` at rest, which spent two amber/attention points on a
// control that is idle most of the time and boxed a toolbar button that the
// grammar says should be boxless.
const MODE_DOT: Record<AgentMode, string> = {
  off: 'bg-[var(--text-muted)]',
  assist: 'bg-[var(--accent)]',
  danger: 'bg-[var(--accent-red)]',
};

// `danger` is the one mode where losing the pill costs real signal: it launches
// Claude with --dangerously-skip-permissions, and a 6px dot is a thin thing to
// hang that on. It keeps a text-level cue — the LABEL in --accent-red, no fill
// and no border, which is still inside the "destructive = red tint at rest,
// never a wash" rule — while `assist` and `off` stay neutral text. The dot is
// 8px for every mode so the row does not reflow when the mode changes.
const MODE_TEXT: Record<AgentMode, string> = {
  off: '',
  assist: '',
  danger: 'text-[var(--accent-red)]',
};

/** The mode arrives over IPC, so it is not guaranteed to be one of ours: a main
 *  process from a different build (a downgrade, or a dev renderer hot-reloaded
 *  ahead of a stale main) can still answer with a retired name like `auto`.
 *  Indexing MODE_DOT directly then yields undefined, which used to take the
 *  whole deck rail down through its ErrorBoundary — a cosmetic lookup killing a
 *  surface the operator steers the fleet from. Fall back to the `off` dot: the
 *  most conservative badge, and never a crash. */
function modeDot(mode: AgentMode): string {
  return MODE_DOT[mode] ?? MODE_DOT.off;
}
function modeText(mode: AgentMode): string {
  return MODE_TEXT[mode] ?? MODE_TEXT.off;
}

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
  // Where the dropdown fits, measured on every open. The chip lives in a bar at
  // the BOTTOM of the deck, so the menu opens upward by default — but the deck
  // rail is also the shortest column on screen, and three items with
  // descriptions are taller than the space above a chip in a short window. The
  // menu then overflowed past the top of the window and the first option (`off`)
  // became unclickable: the operator could raise autonomy but never lower it.
  // Clamp to whichever side has more room and cap the height there, so every
  // option is always reachable (scrolling when it has to be).
  const [menuFit, setMenuFit] = useState<{ below: boolean; maxHeight: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get(workspaceId)
      .then((r) => { if (!cancelled) setMode(r.mode ?? 'off'); })
      .catch(() => { if (!cancelled) setMode('off'); });
    return () => { cancelled = true; };
  }, [api, workspaceId]);

  // Measure the room around the chip whenever the menu opens (and on resize,
  // since the deck rail grows/shrinks with the window).
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const GAP = 8; // breathing room against the window edge
      const above = rect.top - GAP;
      const below = window.innerHeight - rect.bottom - GAP;
      const dropDown = below > above;
      // No floor under the measured room: a minimum that outgrows the room is
      // the original bug again, just smaller. A window too short to show an
      // option is already unusable, and the menu scrolls either way.
      setMenuFit({ below: dropDown, maxHeight: Math.max(0, Math.floor(dropDown ? below : above)) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

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
        .then((r) => {
          if (r.ok && r.mode) setMode(r.mode);
          else setMode(prev);
          // Sibling surfaces re-read the mode from main: `off` disables the
          // composer, so a flip has to reach it without a remount.
          notifyAgentModeChanged();
        })
        .catch(() => {
          setMode(prev);
          notifyAgentModeChanged();
        });
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
        className={`ui-chip-boxless inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] ${modeText(mode)} ${FOCUS_RING}`}
        // The dot is decorative, so without this a screen reader hears only
        // "Mode: danger" with no statement of what danger means.
        aria-label={`${t('deck.mode.label') || 'Mode'}: ${modeLabel(t, mode)}${
          modeDesc(t, mode) ? ` — ${modeDesc(t, mode)}` : ''
        }`}
        title={modeDesc(t, mode)}
      >
        <span
          aria-hidden="true"
          data-agent-mode-dot
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${modeDot(mode)}`}
        />
        {t('deck.mode.label') || 'Mode'}: {modeLabel(t, mode)}
      </button>
      {open && (
        <div
          role="listbox"
          className={`absolute left-0 z-50 w-64 overflow-y-auto bg-[var(--bg-overlay)] border border-[var(--bg-surface)] rounded-md shadow-lg py-1 text-xs ${
            menuFit?.below ? 'top-full mt-1' : 'bottom-full mb-1'
          }`}
          style={menuFit ? { maxHeight: menuFit.maxHeight } : undefined}
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
