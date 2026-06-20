/**
 * T7 — KeyboardCheatSheet (Plan 1.18, D5 + D11)
 *
 * Bottom-right fixed overlay shown after the first-run wizard completes
 * (or is dismissed).  Lists the most useful keyboard shortcuts, runs a
 * 30-second auto-dismiss countdown (paused on hover, focus, or window
 * blur), and offers a "Don't show again" checkbox that persists through
 * `uiSlice.cheatSheetDismissed` (T5).
 *
 * Design notes:
 * - Renders nothing if `cheatSheetDismissed === true` (D11: permanent
 *   opt-out, only revivable from Settings → First-run setup).
 * - Stays *below* the wizard modal in z-index — wizard is z-[70], we sit
 *   at z-[40] so we never trap clicks meant for the wizard or auto-update
 *   prompt (z-[60]).
 * - OS-aware modifier rendering (⌘ vs Ctrl+) mirrors `useKeyboard.ts`'s
 *   pattern (`window.electronAPI.platform === 'darwin'`).  tmux prefix
 *   (Ctrl+B) and bookmark (Ctrl+M) intentionally stay literal on every
 *   OS — wmux convention (Plan D1, mirroring useKeyboard.ts).
 *
 * The view is split into a dumb `<KeyboardCheatSheetView>` so the
 * presentation can be rendered (and snapshot-tested) without React's
 * effect machinery, while the default export wires up timers and store
 * subscriptions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { useT } from '../hooks/useT';
import { t as translate } from '../i18n';

// ─── Constants ──────────────────────────────────────────────────────────────
export const CHEAT_SHEET_DURATION_MS = 30_000;
const TICK_MS = 100;

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

export type CheatSheetEntry = {
  /** i18n key (or English literal when no key has been wired yet) */
  label: string;
  /** Pre-rendered shortcut combo, e.g. "⌘D" or "Ctrl+B" */
  combo: string;
  /** When true, `label` is treated as a literal string (skip translation). */
  literal?: boolean;
};

/**
 * Renders the OS-aware "command" modifier prefix.
 *  - darwin: "⌘"
 *  - everywhere else: "Ctrl+"
 *
 * Matches the cmdOrCtrl mapping in useKeyboard.ts so the cheat sheet is
 * always faithful to actual key handling.
 */
export function formatModifier(platform: string | undefined): string {
  return platform === 'darwin' ? '⌘' : 'Ctrl+';
}

/**
 * Build the shortcut list for the given platform.  Pure function so tests
 * can assert OS-specific output without rendering.
 */
export function buildShortcuts(platform: string | undefined): CheatSheetEntry[] {
  const mod = formatModifier(platform);
  return [
    { label: 'cheatSheet.splitHorizontal', combo: `${mod}D` },
    { label: 'cheatSheet.splitVertical', combo: `${mod}Shift+D` },
    { label: 'cheatSheet.newWorkspace', combo: `${mod}N` },
    { label: 'cheatSheet.openSettings', combo: `${mod},` },
    { label: 'cheatSheet.commandPalette', combo: `${mod}K` },
    { label: 'cheatSheet.toggleSidebar', combo: 'Ctrl+Shift+B' },
    // Ctrl+Tab is literal on every OS — useKeyboard binds it via literalCtrl
    // so the cheat sheet must show "Ctrl+" instead of ⌘ on macOS.
    { label: 'cheatSheet.cyclePane', combo: 'Ctrl+Tab', literal: false },
    // Ctrl+Arrow directional pane focus — literal Ctrl on every OS (bound via
    // literalCtrl in useKeyboard.ts). Mirrors prefix+Arrow.
    // TODO(T1): wire i18n key for cheat sheet "Move pane focus" entry.
    // Ctrl+Shift+Arrow moves focus: pane focus within a workspace, or between
    // tiles when the multiview grid is showing. literalCtrl+shift →
    // focusPaneDirection / focusMultiviewDirection in useKeyboard.ts. (Bare
    // Ctrl+Arrow is intentionally unbound; split stays on Ctrl+D.)
    { label: 'Move focus', combo: 'Ctrl+Shift+Arrows', literal: true },
    // Alt+Up/Down cycle workspaces (prev / next). Own modifier so it doesn't
    // collide with move (Ctrl) or split (Ctrl+Shift). Direct prev/next on top
    // of Ctrl+1-9 (jump to N) and the prefix path.
    // TODO(T1): wire i18n key for cheat sheet "Switch workspace" entry.
    { label: 'Switch workspace', combo: 'Alt+Up/Down', literal: true },
    // tmux prefix is always literal Ctrl+B (wmux convention, D1 / useKeyboard.ts).
    // TODO(T1): wire i18n key for cheat sheet "tmux prefix" entry.
    { label: 'tmux prefix', combo: 'Ctrl+B', literal: true },
    // Maximize / zoom the focused pane to fill the window (tmux prefix then z;
    // press again to restore). Surfaced here because there is no always-visible
    // button — the pane only reveals a maximize affordance on hover — so the
    // "no fullscreen button" gap is at least discoverable via the cheat sheet.
    // literal: the prefix is Ctrl+B on every OS, so the combo can't use ⌘.
    // TODO(T1): wire i18n key for cheat sheet "Maximize pane" entry.
    { label: 'Maximize pane', combo: 'Ctrl+B Z', literal: true },
    // Bookmark is always literal Ctrl+M (matches useKeyboard.ts:448).
    // TODO(T1): wire i18n key for cheat sheet "Bookmark line" entry.
    { label: 'Bookmark line', combo: 'Ctrl+M', literal: true },
  ];
}

// ─── Presentational view ────────────────────────────────────────────────────

export interface KeyboardCheatSheetViewProps {
  shortcuts: CheatSheetEntry[];
  /** Title text (already translated). */
  title: string;
  /** "Don't show again" label (already translated). */
  dontShowAgainLabel: string;
  /** Close button aria-label (already translated). */
  dismissLabel: string;
  /** Remaining countdown ratio in [0, 1]. */
  progress: number;
  /** Whether the "Don't show again" checkbox is checked. */
  dontShowAgain: boolean;
  onDontShowAgainChange: (checked: boolean) => void;
  onDismiss: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  /** Translator for shortcut labels (i18n keys → strings). */
  translateLabel: (key: string) => string;
}

export function KeyboardCheatSheetView({
  shortcuts,
  title,
  dontShowAgainLabel,
  dismissLabel,
  progress,
  dontShowAgain,
  onDontShowAgainChange,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  translateLabel,
}: KeyboardCheatSheetViewProps) {
  const clamped = Math.max(0, Math.min(1, progress));
  return (
    <div
      role="region"
      aria-label={title}
      data-testid="keyboard-cheat-sheet"
      className="fixed bottom-4 right-4 z-[40] w-[280px] rounded-lg shadow-lg overflow-hidden text-xs"
      style={{
        backgroundColor: 'var(--bg-mantle, rgba(24,24,37,0.95))',
        border: '1px solid var(--bg-surface0, rgba(255,255,255,0.08))',
        color: 'var(--text-main, #cdd6f4)',
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div className="flex items-center justify-between px-3 py-2 font-semibold">
        <span>{title}</span>
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="text-[color:var(--text-muted)] hover:text-[color:var(--text-main)] transition-colors"
          data-testid="keyboard-cheat-sheet-close"
        >
          {'✕'}
        </button>
      </div>
      <ul className="px-3 pb-2 space-y-1" data-testid="keyboard-cheat-sheet-list">
        {shortcuts.map((entry) => (
          <li key={`${entry.label}-${entry.combo}`} className="flex items-center justify-between gap-3">
            <span className="truncate">{entry.literal ? entry.label : translateLabel(entry.label)}</span>
            <kbd
              className="font-mono text-[10px] px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: 'var(--bg-surface0, rgba(255,255,255,0.08))',
                color: 'var(--text-main, #cdd6f4)',
              }}
              data-testid={`combo-${entry.label}`}
            >
              {entry.combo}
            </kbd>
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-2 px-3 pb-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={dontShowAgain}
          onChange={(e) => onDontShowAgainChange(e.target.checked)}
          aria-label={dontShowAgainLabel}
          data-testid="keyboard-cheat-sheet-dont-show-again"
        />
        <span className="text-[color:var(--text-muted)]">{dontShowAgainLabel}</span>
      </label>
      <div
        aria-hidden="true"
        className="h-[1px]"
        style={{
          width: `${clamped * 100}%`,
          backgroundColor: 'var(--accent-blue, #89b4fa)',
          transition: 'width 100ms linear',
        }}
        data-testid="keyboard-cheat-sheet-progress"
      />
    </div>
  );
}

// ─── Default export: timer + store wiring ──────────────────────────────────

export default function KeyboardCheatSheet() {
  const cheatSheetDismissed = useStore((s) => s.cheatSheetDismissed);
  const setCheatSheetDismissed = useStore((s) => s.setCheatSheetDismissed);
  // One-shot force-show triggered by the `?` prefix action — re-displays the
  // overlay even after the user has permanently dismissed it, and resets the
  // local hidden/countdown state for a fresh viewing.
  const cheatSheetForceShown = useStore((s) => s.cheatSheetForceShown);
  const setCheatSheetForceShown = useStore((s) => s.setCheatSheetForceShown);
  const t = useT();

  const [hidden, setHidden] = useState(false);
  const [remainingMs, setRemainingMs] = useState(CHEAT_SHEET_DURATION_MS);
  // Pause flags: hover, focus, document hidden.  Stored in refs so tick()
  // sees the latest value without re-creating the interval.
  const hoverRef = useRef(false);
  const focusRef = useRef(false);
  const docHiddenRef = useRef(false);

  // Reflect uiSlice "Don't show again" checkbox state for visual feedback.
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const platform = useMemo(() => {
    // electronAPI.platform was added by 1.14 OS-aware shortcut work — see
    // src/preload/preload.ts:22.  Defensive default for non-Electron runs
    // (tests).
    if (typeof window === 'undefined') return undefined;
    const api = (window as Window & { electronAPI?: { platform?: string } }).electronAPI;
    return api?.platform;
  }, []);

  const shortcuts = useMemo(() => buildShortcuts(platform), [platform]);

  // When the prefix `?` action fires, reset local state so a previously
  // expired/hidden overlay re-renders with a fresh 30s countdown.
  useEffect(() => {
    if (!cheatSheetForceShown) return;
    setHidden(false);
    setRemainingMs(CHEAT_SHEET_DURATION_MS);
  }, [cheatSheetForceShown]);

  // Countdown tick — paused when any of the three flags is true.
  useEffect(() => {
    if ((cheatSheetDismissed && !cheatSheetForceShown) || hidden) return;

    const interval = setInterval(() => {
      if (hoverRef.current || focusRef.current || docHiddenRef.current) return;
      setRemainingMs((prev) => {
        const next = prev - TICK_MS;
        if (next <= 0) {
          setHidden(true);
          // Clear the one-shot override so a subsequent `?` press can flip
          // the selector value and re-trigger the force-show effect. Without
          // this reset, force-shown stays `true` forever after the first
          // countdown expires and the next `?` becomes a no-op.
          if (cheatSheetForceShown) setCheatSheetForceShown(false);
          return 0;
        }
        return next;
      });
    }, TICK_MS);

    return () => clearInterval(interval);
  }, [cheatSheetDismissed, cheatSheetForceShown, hidden, setCheatSheetForceShown]);

  // visibilitychange listener — pause when window is hidden.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      docHiddenRef.current = document.visibilityState === 'hidden';
    };
    // Initialize from current state.
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const onDismiss = useCallback(() => {
    setHidden(true);
    // Clear the one-shot override so the next `?` press triggers a re-show.
    if (cheatSheetForceShown) setCheatSheetForceShown(false);
  }, [cheatSheetForceShown, setCheatSheetForceShown]);

  const onDontShowAgainChange = useCallback(
    (checked: boolean) => {
      setDontShowAgain(checked);
      if (checked) setCheatSheetDismissed(true);
    },
    [setCheatSheetDismissed],
  );

  const onMouseEnter = useCallback(() => {
    hoverRef.current = true;
  }, []);
  const onMouseLeave = useCallback(() => {
    hoverRef.current = false;
  }, []);
  const onFocus = useCallback(() => {
    focusRef.current = true;
  }, []);
  const onBlur = useCallback(() => {
    focusRef.current = false;
  }, []);

  // Force-show wins over the permanent dismissal so `?` always works.
  if (hidden) return null;
  if (cheatSheetDismissed && !cheatSheetForceShown) return null;

  const progress = remainingMs / CHEAT_SHEET_DURATION_MS;

  return (
    <KeyboardCheatSheetView
      shortcuts={shortcuts}
      title={t('cheatSheet.title')}
      dontShowAgainLabel={t('cheatSheet.dontShowAgain')}
      dismissLabel={t('cheatSheet.dismiss')}
      progress={progress}
      dontShowAgain={dontShowAgain}
      onDontShowAgainChange={onDontShowAgainChange}
      onDismiss={onDismiss}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      translateLabel={(key) => translate(key)}
    />
  );
}
